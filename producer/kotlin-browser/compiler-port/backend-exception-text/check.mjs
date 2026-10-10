#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { assertNoSymlink, readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { prepareDiagnosticSourceDsl } from '../diagnostic-source-dsl/prepare.mjs';
import { frozenInputs } from '../k1-container-profile/check.mjs';
import { BACKEND, COMPONENT_PATH, rendererLambda } from './transform.mjs';
import { prepareBackendExceptionText, verifyBackendExceptionText } from './prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const execute = promisify(execFile);

export async function checkBackendText({ outputRoot, sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources') }) {
    outputRoot = path.resolve(outputRoot); assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep));
    await assertNoSymlink(outputRoot); await mkdir(outputRoot, { mode: 0o700 });
    const frozen = await frozenInputs();
    const preparedSourceDsl = await prepareDiagnosticSourceDsl({ sourceRoot, outputRoot: path.join(outputRoot, 'dsl'), retainedSources: frozen.retainedSources });
    const prepared = await prepareBackendExceptionText({ sourceRoot, outputRoot: path.join(outputRoot, 'layer'), preparedSourceDsl });
    await verifyBackendExceptionText({ sourceRoot, preparedSourceDsl, profileRoot: path.dirname(prepared.receiptPath) });
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    const evidenceBytes = await readRegular(path.join(HERE, lock.jvmSourceDslDependency.evidencePath));
    assert.equal(sha256(evidenceBytes), lock.jvmSourceDslDependency.evidenceSha256);
    const evidence = JSON.parse(evidenceBytes); assert.equal(evidence.sourceLockSha256, lock.jvmSourceDslDependency.sourceLockSha256);
    assert.deepEqual(evidence.source, lock.source); assert.equal(evidence.comparison.originalJvmEqualsCommonJvm, true);
    const dependencyJars = {};
    for (const pin of lock.jvmSourceDslDependency.artifacts) {
        assert.deepEqual(evidence.outputs.find(item => item.path === pin.path), pin);
        const filename = path.join(REPO, lock.jvmSourceDslDependency.artifactRoot, pin.path), bytes = await readRegular(filename);
        assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256); dependencyJars[path.basename(pin.path, '.jar')] = filename;
    }
    const renderer = verifyFile(await readRegular(path.join(sourceRoot, lock.probeRendererSource.path)), lock.probeRendererSource);
    const original = verifyFile(await readRegular(path.join(sourceRoot, BACKEND)), lock.original), common = await readRegular(prepared.commonSources[0]);
    const bootstrap = await verifyBootstrap(), commands = [], outputs = [], observers = [];
    for (const directory of ['original', 'common', 'jvm', 'klib', 'wasm']) await mkdir(path.join(outputRoot, directory));
    async function store(name, bytes) {
        const filename = path.join(outputRoot, name); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
        outputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); return filename;
    }
    const originalText = original.toString(), psi = 'import com.intellij.psi.PsiElement\n'; assert.equal(originalText.split(psi).length, 2);
    const originalBackend = await store('original/CommonBackendErrors.kt', Buffer.from(originalText.replace(psi, 'import org.jetbrains.kotlin.com.intellij.psi.PsiElement\n')));
    const commonBackend = await store('common/CommonBackendErrors.kt', common);
    const rendererFilename = await store('DiagnosticParameterRenderer.kt', renderer);
    const body = rendererLambda(common); assert.equal(sha256(body), lock.commonLambdaSha256);
    const projection = Buffer.from(originalText.split('package ')[0] + 'package org.jetbrains.kotlin.portable.backendtext.probe\n\n' +
        '// Exact selected renderer lambda projection; full diagnostic/context graph is not modeled here.\n' +
        'fun projectedBackendExplanation(it: String): String = run {\n' + body.toString() + '\n}\n');
    const projected = await store('BackendLambda.kt', projection);
    for (const name of ['Probe.kt', 'JvmEntry.kt', 'WasmEntry.kt']) {
        const bytes = await readRegular(path.join(HERE, name)); await store(name, bytes); observers.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
    }
    const projectionEntry = await store('ProjectionJvmEntry.kt', Buffer.from('package org.jetbrains.kotlin.portable.backendtext.probe\nfun main() { print(observeBackendText(::projectedBackendExplanation)) }\n'));
    async function run(phase, command, args) {
        console.log('phase: ' + phase);
        try { const result = await execute(command, args, { cwd: outputRoot, timeout: 240000, maxBuffer: 16 * 1024 * 1024 });
            if (result.stderr) process.stderr.write(result.stderr); commands.push({ phase, command: [command, ...args], exitCode: 0 }); return result.stdout;
        } catch (error) { await writeJson(path.join(outputRoot, 'failure.json'), { phase, exitCode: error.code, stderr: String(error.stderr ?? '').slice(-16384) });
            if (error.stderr) process.stderr.write(String(error.stderr).slice(-16384)); throw new Error(phase + ' failed'); }
    }
    const java = ['-Xmx768m', '-cp', bootstrap.classPath], stdlib = bootstrap.artifacts.find(pin => pin.id === 'stdlib-jvm').path;
    const jvm = [...java, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-language-version', '2.5', '-api-version', '2.5'];
    const probe = path.join(outputRoot, 'Probe.kt'), jvmEntry = path.join(outputRoot, 'JvmEntry.kt');
    const observed = {}, factories = {};
    for (const [variant, source] of [['original', originalBackend], ['common', commonBackend]]) {
        const classPath = [dependencyJars[variant], bootstrap.classPath].join(path.delimiter), jar = path.join(outputRoot, 'jvm/' + variant + '.jar');
        await run(variant + '-full-backend-and-actual-renderer-jvm-build', 'java', [...jvm, '-opt-in=org.jetbrains.kotlin.ir.symbols.UnsafeDuringIrConstructionAPI',
            '-opt-in=org.jetbrains.kotlin.ir.ObsoleteDescriptorBasedAPI', '-classpath', classPath, '-d', jar, source, rendererFilename, probe, jvmEntry]);
        const main = 'org.jetbrains.kotlin.portable.backendtext.probe.JvmEntryKt', runtimeClassPath = [jar, classPath].join(path.delimiter);
        observed[variant] = await run(variant + '-full-backend-jvm-observe', 'java', ['-cp', runtimeClassPath, main]);
        factories[variant] = await run(variant + '-full-factory-jvm-observe', 'java', ['-cp', runtimeClassPath, main, '--factories']);
        const oracle = await run(variant + '-historical-jvm-class-name-oracle', 'java', ['-cp', runtimeClassPath, main, '--names']);
        assert.equal(oracle, 'java.lang.StackOverflowError\njava.lang.NullPointerException\n'); await store(variant + '-names.txt', Buffer.from(oracle));
    }
    assert.equal(observed.common, observed.original, 'Original/common full JVM renderer observations differ');
    assert.equal(factories.common, factories.original, 'Original/common diagnostic registrations differ');
    await run('common-lambda-projection-jvm-build', 'java', [...jvm, '-classpath', stdlib, '-d', path.join(outputRoot, 'jvm/projection.jar'), projected, probe, projectionEntry]);
    observed.projection = await run('common-lambda-projection-jvm-observe', 'java', ['-cp', [path.join(outputRoot, 'jvm/projection.jar'), stdlib].join(path.delimiter), 'org.jetbrains.kotlin.portable.backendtext.probe.ProjectionJvmEntryKt']);
    assert.equal(observed.projection, observed.original, 'Exact JVM lambda projection differs from full original renderer');
    const wasm = [...java, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js', '-libraries', bootstrap.wasmJsStdlib, '-language-version', '2.5', '-api-version', '2.5'];
    const commonSources = [projected, probe];
    await run('exact-lambda-common-wasm-klib-build', 'java', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + commonSources.join(','), '-ir-output-dir', path.join(outputRoot, 'klib'), '-ir-output-name', 'backend-text', ...commonSources, path.join(outputRoot, 'WasmEntry.kt')]);
    await run('exact-lambda-common-wasm-module-build', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + path.join(outputRoot, 'klib/backend-text.klib'), '-ir-output-dir', path.join(outputRoot, 'wasm'), '-ir-output-name', 'backend-text', '-main', 'noCall']);
    observed.wasm = await run('exact-lambda-node-wasm-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e',
        'const m=await import(process.argv[1]);process.stdout.write(m.backendTextObservation());', pathToFileURL(path.join(outputRoot, 'wasm/backend-text.mjs')).href]);
    for (const [label, text] of Object.entries(observed)) await store(label + '-observations.txt', Buffer.from(text));
    for (const [label, text] of Object.entries(factories)) await store(label + '-factories.txt', Buffer.from(text));
    if (observed.wasm !== observed.original) {
        const expected = observed.original.trimEnd().split('\n'), actual = observed.wasm.trimEnd().split('\n');
        const mismatches = expected.flatMap((record, index) => record === actual[index] ? [] : [{ index, original: record, wasm: actual[index] }]);
        await writeJson(path.join(outputRoot, 'semantic-mismatches.json'), { total: mismatches.length, first: mismatches.slice(0, 20) });
        throw new Error('Original/Node Wasm exact renderer observations differ: ' + mismatches.length + ' cases; preserved in semantic-mismatches.json');
    }
    for (const name of ['jvm/original.jar', 'jvm/common.jar', 'jvm/projection.jar', 'klib/backend-text.klib', ...(await readdir(path.join(outputRoot, 'wasm'))).map(name => 'wasm/' + name)]) {
        const bytes = await readRegular(path.join(outputRoot, name)); outputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
    }
    const receipt = { schemaVersion: 1, kind: 'actual-backend-exception-protocol-full-jvm-and-lambda-wasm-differential', source: lock.source,
        sourceLockSha256: sha256(lockBytes), buildToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))), preparation: prepared.receipt,
        predecessor: preparedSourceDsl.receipt, rendererDependency: lock.probeRendererSource, jvmSourceDslDependency: lock.jvmSourceDslDependency,
        projection: { originalLambdaSha256: lock.originalLambdaSha256, commonLambdaSha256: sha256(body), fullRendererJvm: true,
            wasmScope: 'Exact selected lambda only; no fake Renderer/context/diagnostic factory types; full table and actual host Throwable-to-protocol generation not executed on Wasm' },
        observers, commands, outputs, bootstrap: { version: bootstrap.lock.version, compilerSourceCommit: null,
            artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
        comparison: { observations: observed.original.trimEnd().split('\n').length, originalJvmEqualsCommonJvm: true, originalJvmEqualsJvmProjection: true,
            originalJvmEqualsNodeWasmProjection: true, originalJvmRegistrationsEqualCommonJvm: true, normalizedText: false, encoding: 'Reversible UTF-16 code-unit hex, including unchanged inputs' },
        fullDiagnosticTableWasmExecution: false, browserExecuted: false, throwableProtocolGenerationChanged: false, fullCompilerBuilt: false, languageReadiness: false };
    await writeJson(path.join(outputRoot, 'receipt.json'), receipt); return { outputRoot, receipt, preparedSourceDsl, prepared };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { assert.equal(process.argv.length, 3, 'Usage: check.mjs NEW_OUTPUT_ROOT'); const result = await checkBackendText({ outputRoot: process.argv[2] });
        console.log(JSON.stringify({ outputRoot: result.outputRoot, comparison: result.receipt.comparison }));
    } catch (error) { console.error(error); process.exitCode = 1; }
}

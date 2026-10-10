#!/usr/bin/env node
/** Executes the pinned original OpenJDK class and real compiler utilities against common JVM/Wasm. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap, defaultCache } from '../../build/bootstrap.mjs';
import { readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { prepareBitSetReferences, prepareBitSetSources, verifyBitSetPreparation } from './prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)); const execute = promisify(execFile);

export async function buildBitSetProbe({ sourceRoot, referenceRoot, outputRoot, bootstrapCache = defaultCache }) {
  sourceRoot = path.resolve(sourceRoot); referenceRoot = path.resolve(referenceRoot); outputRoot = path.resolve(outputRoot);
  const bootstrap = await verifyBootstrap(bootstrapCache);
  await prepareBitSetReferences({ referenceRoot });
  const prepared = await prepareBitSetSources({ sourceRoot, referenceRoot, outputRoot });
  const checked = await verifyBitSetPreparation(outputRoot);
  const lock = JSON.parse(await readRegular(path.join(HERE, 'sources.lock.json')));
  const commands = []; const observerSources = [];
  const local = {};
  for (const name of ['Probe.kt', 'OriginalBridge.kt', 'PortableBridge.kt', 'JvmEntry.kt', 'WasmEntry.kt']) {
    const bytes = await readRegular(path.join(HERE, name)); const filename = path.join(outputRoot, name);
    await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); local[name] = filename;
    observerSources.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
  }
  for (const dir of ['jdk', 'jvm', 'klib', 'wasm']) await mkdir(path.join(outputRoot, dir), { mode: 0o700 });
  async function run(phase, command, args) {
    try {
      const result = await execute(command, args, { cwd: outputRoot, timeout: 300000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' });
      if (result.stderr) process.stderr.write(result.stderr);
      commands.push({ phase, command, args, exitCode: 0 }); return result.stdout.trim();
    } catch (error) {
      await writeJson(path.join(outputRoot, 'failure.json'), { phase, command, args, exitCode: error.code ?? null, signal: error.signal ?? null,
        stderr: String(error.stderr ?? '').slice(-8192), stdout: String(error.stdout ?? '').slice(-1024) });
      if (error.stderr) process.stderr.write(String(error.stderr).slice(-8192)); throw new Error(phase + ' failed; see failure.json');
    }
  }
  const originalClass = path.join(referenceRoot, lock.jdk.path);
  verifyFile(await readRegular(originalClass), lock.jdk);
  await run('pinned-original-openjdk-class-build', 'javac', ['--patch-module', 'java.base=' + referenceRoot, '-d', path.join(outputRoot, 'jdk'), originalClass]);
  const stdlib = bootstrap.artifacts.find(item => item.id === 'stdlib-jvm').path;
  const flagsBytes = await readRegular(path.join(HERE, '../build-flags.json')); const flags = JSON.parse(flagsBytes);
  assert.equal(flags.source.commit, lock.source.commit);
  const jvm = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17',
    '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags, '-classpath', stdlib];
  const wasm = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js',
    '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags, '-libraries', bootstrap.wasmJsStdlib];
  const originalUtility = path.join(sourceRoot, lock.consumers.find(pin => pin.path.endsWith('/BitSetUtil.kt')).path);
  const common = [...prepared.commonSources.filter(name => !name.endsWith('/LivenessAnalysis.kt')), local['Probe.kt'], local['PortableBridge.kt']];
  const originalJar = path.join(outputRoot, 'jvm/original.jar'), portableJar = path.join(outputRoot, 'jvm/portable.jar');
  await run('original-compiler-utility-jvm-build', 'java', [...jvm, '-d', originalJar, originalUtility, local['Probe.kt'], local['OriginalBridge.kt'], local['JvmEntry.kt']]);
  await run('common-port-jvm-build', 'java', [...jvm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','), '-d', portableJar, ...common, local['JvmEntry.kt']]);
  const main = 'org.jetbrains.kotlin.portable.bits.probe.JvmEntryKt';
  const original = await run('pinned-openjdk-original-observe', 'java', ['--patch-module', 'java.base=' + path.join(outputRoot, 'jdk'), '-ea', '-esa',
    '-Xmx256m', '-cp', [originalJar, stdlib].join(path.delimiter), main]);
  const portable = await run('common-jvm-observe', 'java', ['-ea', '-Xmx256m', '-cp', [portableJar, stdlib].join(path.delimiter), main]);
  await writeFile(path.join(outputRoot, 'original-jvm.json'), original + '\n', { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(outputRoot, 'portable-jvm.json'), portable + '\n', { flag: 'wx', mode: 0o600 });
  assert.equal(portable, original, 'Common JVM BitSet observations differ from pinned OpenJDK');
  await run('common-wasmjs-klib-build', 'java', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','), '-Xir-produce-klib-file',
    '-ir-output-dir', path.join(outputRoot, 'klib'), '-ir-output-name', 'bit-set-probe', ...common, local['WasmEntry.kt']]);
  await run('common-wasmjs-binary-build', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + path.join(outputRoot, 'klib/bit-set-probe.klib'),
    '-ir-output-dir', path.join(outputRoot, 'wasm'), '-ir-output-name', 'bit-set-probe', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
  const wasmObservation = await run('actual-node-wasmjs-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e',
    'const m=await import(process.argv[1]); console.log(m.bitSetProbe());', pathToFileURL(path.join(outputRoot, 'wasm/bit-set-probe.mjs')).href]);
  await writeFile(path.join(outputRoot, 'portable-wasmjs.json'), wasmObservation + '\n', { flag: 'wx', mode: 0o600 });
  assert.equal(wasmObservation, original, 'Actual Wasm BitSet observations differ from pinned OpenJDK');
  const observations = JSON.parse(original);
  assert.equal(observations.cases.length, observations.count); assert(observations.count >= 1000);
  assert.equal(new Set(observations.cases.map(([id]) => id)).size, observations.count);
  const outputs = [];
  const names = ['jdk/java/util/BitSet.class', 'jvm/original.jar', 'jvm/portable.jar', 'klib/bit-set-probe.klib', 'original-jvm.json', 'portable-jvm.json', 'portable-wasmjs.json'];
  for (const entry of await readdir(path.join(outputRoot, 'wasm'), { withFileTypes: true })) { assert(entry.isFile()); names.push('wasm/' + entry.name); }
  for (const name of names.sort()) { const bytes = await readRegular(path.join(outputRoot, name), 32 * 1024 * 1024); outputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); }
  await verifyBitSetPreparation(outputRoot);
  const java = await execute('java', ['-version'], { timeout: 10000, maxBuffer: 65536 });
  const receipt = { schemaVersion: 1, kind: 'official-wasm-liveness-bit-set-differential', source: lock.source,
    sourceLockSha256: prepared.receipt.sourceLockSha256, preparationReceiptSha256: checked.receiptSha256,
    buildToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))), buildFlagsSha256: sha256(flagsBytes),
    jdk: lock.jdk, consumers: prepared.receipt.consumers, selectedApi: lock.selectedApi, observerSources,
    bootstrap: { version: bootstrap.lock.version, sourceCommit: null, artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
    environment: { java: (java.stdout + java.stderr).trim(), node: process.version }, commands, outputs,
    comparison: { passed: observations.count, failed: 0, skipped: 0, originalJvmEqualsCommonJvm: true, originalJvmEqualsWasmJs: true,
      observationSha256: sha256(Buffer.from(original)), equalityUnit: 'exact JSON observation for every operation and utility traversal',
      exceptionBoundary: 'negative-size category/exact message preserved; common exception does not emulate JVM FQCN' },
    fullLivenessAnalysisExecution: 'not-run', browserExecution: 'not-run', wholeCompilerBuilt: false, languageReadiness: false };
  await writeJson(path.join(outputRoot, 'receipt.json'), receipt); return { outputRoot, comparison: receipt.comparison };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); const options = {};
  for (let i = 0; i < args.length; i += 2) {
    assert(['--source-root', '--reference-root', '--output'].includes(args[i]) && args[i + 1] && !options[args[i]], 'Invalid BitSet probe arguments');
    options[args[i]] = args[i + 1];
  }
  assert(options['--source-root'] && options['--reference-root'] && options['--output']);
  console.log(JSON.stringify(await buildBitSetProbe({ sourceRoot: options['--source-root'], referenceRoot: options['--reference-root'], outputRoot: options['--output'] })));
}

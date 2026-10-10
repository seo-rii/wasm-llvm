import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { prepareNullConstantValue } from '../null-constant-value-profile/prepare.mjs';
import { prepareJsAstSources } from '../js-ast/prepare.mjs';
import { observeAstInChromium } from '../js-ast/browser.mjs';
import { prepareCharConstantFormat, projectCharFormatting, verifyCharConstantFormat } from './prepare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..');
assert.equal(process.argv.length, 3); const output = path.resolve(process.argv[2]);
assert(output.startsWith(path.join(repository, 'out') + path.sep)); await mkdir(output, { mode: 0o700 });
const local = name => path.join(output, name), sourceRoot = path.join(repository, 'out/kotlin-compiler-port/sources');
const preparedNullConstant = await prepareNullConstantValue({ sourceRoot, outputRoot: local('null') });
const preparedJsAst = await prepareJsAstSources({ sourceRoot, outputRoot: local('ast') });
const options = { sourceRoot, outputRoot: local('binding'), preparedNullConstant, preparedJsAst };
const prepared = await prepareCharConstantFormat(options); await verifyCharConstantFormat(options);
const bootstrap = await verifyBootstrap(), flagsBytes = await readRegular(path.join(here, '../build-flags.json'));
const flags = JSON.parse(flagsBytes), commands = [], execute = promisify(execFile);
async function run(phase, binary, args) {
    console.log('phase: ' + phase); const started = performance.now();
    try {
        const result = await execute(binary, args, { cwd: output, timeout: 240000, maxBuffer: 32 * 1024 * 1024 });
        commands.push({ phase, command: [binary, ...args], exitCode: 0, elapsedMs: performance.now() - started });
        if (result.stderr) process.stderr.write(result.stderr); return result.stdout;
    } catch (error) {
        await writeJson(local('failure.json'), { phase, commands, exitCode: error.code, killed: error.killed,
            signal: error.signal, stderr: String(error.stderr ?? '').slice(-12000) });
        throw new Error(phase + ' failed; exit=' + error.code + '; killed=' + error.killed);
    }
}
for (const name of ['Probe.kt', 'JvmEntry.kt', 'WasmEntry.kt'])
    await writeFile(local(name), await readRegular(path.join(here, name)), { flag: 'wx', mode: 0o600 });
const commonSource = await readRegular(prepared.commonSources[0]);
await writeFile(local('Projection.kt'), projectCharFormatting(commonSource), { flag: 'wx', mode: 0o600 });
const character = prepared.sharedDependencies[0].filename;
const java = ['-Xmx768m', '-cp', bootstrap.classPath];
const jvm = [...java, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17',
    '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags, '-classpath', bootstrap.classPath];
let original;
for (const [variant, sources] of [
    ['original', [path.join(sourceRoot, prepared.receipt.consumer.path)]],
    ['common', [prepared.commonSources[0], character]],
    ['projection', [local('Projection.kt'), character]],
]) {
    await run(variant + '-jvm-build', 'java', [...jvm, '-d', local(variant + '.jar'), ...sources, local('Probe.kt'), local('JvmEntry.kt')]);
    const raw = await run(variant + '-jvm-observe', 'java', ['-ea', '-cp', local(variant + '.jar') + path.delimiter + bootstrap.classPath,
        'org.jetbrains.kotlin.portable.charconstant.probe.JvmEntryKt']);
    await writeFile(local(variant + '-jvm.json'), raw, { flag: 'wx', mode: 0o600 });
    if (!original) original = JSON.parse(raw);
    assert.deepEqual(JSON.parse(raw), original); assert.equal(original.records.length, 65536);
}
await mkdir(local('klib')); await mkdir(local('wasm'));
const common = [local('Projection.kt'), character, local('Probe.kt')];
const wasm = [...java, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js',
    '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags, '-libraries', bootstrap.wasmJsStdlib];
await run('format-projection-wasm-klib', 'java', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','),
    '-ir-output-dir', local('klib'), '-ir-output-name', 'char-format', ...common, local('WasmEntry.kt')]);
await run('format-projection-wasm-module', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + local('klib/char-format.klib'),
    '-ir-output-dir', local('wasm'), '-ir-output-name', 'js-ast', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
const node = await run('format-projection-node-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e',
    'const m=await import(process.argv[1]);process.stdout.write(m.astProbeJson());', pathToFileURL(local('wasm/js-ast.mjs')).href]);
await writeFile(local('common-wasm.json'), node, { flag: 'wx', mode: 0o600 }); assert.deepEqual(JSON.parse(node), original);
const browser = await observeAstInChromium(output, original.records);
await writeFile(local('common-chromium.json'), browser.raw, { flag: 'wx', mode: 0o600 }); assert.deepEqual(browser.observation, original);
await verifyCharConstantFormat(options);
const artifacts = [];
async function collect(directory) {
    for (const item of await readdir(local(directory), { withFileTypes: true })) {
        const name = directory ? directory + '/' + item.name : item.name;
        if (item.isDirectory()) await collect(name);
        else { const bytes = await readRegular(local(name)); artifacts.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); }
    }
}
await collect('');
const localFiles = [];
for (const name of ['prepare.mjs', 'sources.lock.json', 'Probe.kt', 'JvmEntry.kt', 'WasmEntry.kt', 'probe.mjs', 'integrity.test.mjs', 'README.md']) {
    const bytes = await readRegular(path.join(here, name)); localFiles.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
}
await writeJson(local('receipt.json'), { schemaVersion: 1, kind: 'genuine-char-constant-format-differential', source: prepared.receipt.source,
    artifactRoot: path.relative(repository, output), preparation: prepared.receipt, options, commands, artifacts, localFiles,
    flagsSha256: sha256(flagsBytes), bootstrap: { version: bootstrap.lock.version, sourceCommit: null,
        artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
    comparison: { observations: 65536, fullOriginalAndCommonJvm: true, projectionJvm: true, projectionNodeWasm: true,
        projectionOfflineChromium: true, skipped: 0, normalizedText: false, recordsSha256: sha256(Buffer.from(JSON.stringify(original.records))) },
    projection: { methods: ['toString', 'getPrintablePart', 'isPrintableUnicode'], bodyUnchangedFromCommonSource: true,
        source: 'Projection.kt', receiver: 'Explicit minimal Char value holder; no descriptor, type or visitor replacements' },
    browser: browser.receipt, fullConstantsWasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false });
console.log(JSON.stringify({ output, observations: 65536, fullConstantsWasmExecuted: false, fullCompilerBuilt: false }));

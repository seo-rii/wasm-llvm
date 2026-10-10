#!/usr/bin/env node
/** Actual selected SmartSet source and common-host differential. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap, defaultCache } from '../../build/bootstrap.mjs';
import { assertNoSymlink, readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { prepareSmartSetSources, verifySmartSetPreparation } from './prepare.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)); const execute = promisify(execFile);

export async function buildSmartSetProbe({ sourceRoot, outputRoot, bootstrapCache = defaultCache }) {
  const bootstrap = await verifyBootstrap(bootstrapCache); outputRoot = path.resolve(outputRoot); await assertNoSymlink(outputRoot);
  await mkdir(outputRoot, { recursive: false, mode: 0o700 });
  const prepared = await prepareSmartSetSources({ sourceRoot, outputRoot }); const preparation = await verifySmartSetPreparation(path.dirname(prepared.receiptPath));
  const flagBytes = await readRegular(path.resolve(HERE, '../build-flags.json')); const flags = JSON.parse(flagBytes);
  assert.equal(flags.source.commit, prepared.receipt.source.commit); assert.equal(flags.languageVersion, '2.5'); assert.equal(flags.apiVersion, '2.5'); assert(Array.isArray(flags.compilerFlags));
  const commands = []; const sources = [];
  for (const name of ['SmartSetProbe.kt', 'JvmEntry.kt', 'WasmEntry.kt', 'Reference.java']) {
    const bytes = await readRegular(path.join(HERE, name)); const filename = path.join(outputRoot, name); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
    sources.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
  }
  async function run(phase, command, args) {
    const result = await execute(command, args, { cwd: outputRoot, timeout: 240000, maxBuffer: 4 * 1024 * 1024 });
    if (result.stderr) process.stderr.write(result.stderr); commands.push({ phase, command, args, exitCode: 0 }); return result.stdout;
  }
  for (const name of ['jvm', 'klib', 'wasm']) await mkdir(path.join(outputRoot, name), { mode: 0o700 });
  const stdlibJvm = bootstrap.artifacts.find(item => item.id === 'stdlib-jvm').path;
  const compiler = ['-Xmx768m', '-cp', bootstrap.classPath];
  const jvm = [...compiler, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags];
  const wasm = [...compiler, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js', '-libraries', bootstrap.wasmJsStdlib, '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags];
  const probe = path.join(outputRoot, 'SmartSetProbe.kt'); const jvmEntry = path.join(outputRoot, 'JvmEntry.kt');
  const originalSource = path.join(preparation.root, 'original', prepared.receipt.original.path);
  const originalJar = path.join(outputRoot, 'jvm/original.jar'); const portableJar = path.join(outputRoot, 'jvm/portable.jar');
  await run('exact-original-kotlin-jvm-build', 'java', [...jvm, '-classpath', stdlibJvm, '-d', originalJar, originalSource, probe, jvmEntry]);
  const common = [...prepared.commonSources, probe];
  await run('portable-common-jvm-build', 'java', [...jvm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','), '-classpath', stdlibJvm, '-d', portableJar, ...common, jvmEntry]);
  const main = 'org.jetbrains.kotlin.portable.smartset.probe.JvmEntryKt';
  const originalText = (await run('exact-original-jvm-observe', 'java', ['-ea', '-Xmx512m', '-cp', [originalJar, stdlibJvm].join(path.delimiter), main])).trim();
  const portableText = (await run('portable-jvm-observe', 'java', ['-ea', '-Xmx512m', '-cp', [portableJar, stdlibJvm].join(path.delimiter), main])).trim();
  const original = JSON.parse(originalText); const portable = JSON.parse(portableText); assert.deepEqual(portable, original, 'Portable JVM SmartSet differs from original selected source');
  await run('reflection-observer-build', 'javac', ['-J-Xmx256m', '-proc:none', '-d', path.join(outputRoot, 'jvm'), path.join(outputRoot, 'Reference.java')]);
  const originalApi = await run('original-erased-api', 'java', ['-Xmx256m', '-cp', [path.join(outputRoot, 'jvm'), originalJar, stdlibJvm].join(path.delimiter), 'Reference']);
  const portableApi = await run('portable-erased-api', 'java', ['-Xmx256m', '-cp', [path.join(outputRoot, 'jvm'), portableJar, stdlibJvm].join(path.delimiter), 'Reference']);
  assert.equal(portableApi, originalApi, 'SmartSet source API or dispatch modifiers differ');
  await writeFile(path.join(outputRoot, 'original-api.txt'), originalApi, { flag: 'wx', mode: 0o600 }); await writeFile(path.join(outputRoot, 'portable-api.txt'), portableApi, { flag: 'wx', mode: 0o600 });
  const wasmEntry = path.join(outputRoot, 'WasmEntry.kt');
  await run('portable-wasmjs-klib-build', 'java', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','), '-Xir-produce-klib-file', '-ir-output-dir', path.join(outputRoot, 'klib'), '-ir-output-name', 'smart-set-probe', ...common, wasmEntry]);
  await run('portable-wasmjs-binary-build', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + path.join(outputRoot, 'klib/smart-set-probe.klib'), '-ir-output-dir', path.join(outputRoot, 'wasm'), '-ir-output-name', 'smart-set-probe', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
  const wasmText = (await run('portable-node-wasmjs-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e',
    'const m = await import(process.argv[1]); console.log(m.smartSetProbe());', pathToFileURL(path.join(outputRoot, 'wasm/smart-set-probe.mjs')).href])).trim();
  const observedWasm = JSON.parse(wasmText);
  assert.deepEqual(observedWasm.cases, original.cases, 'Wasm SmartSet supported operation observations differ');
  const outsideDifferences = [];
  for (let i = 0; i < original.outsideContract.length; ++i) {
    const before = original.outsideContract[i]; const after = observedWasm.outsideContract[i]; assert.equal(after?.id, before.id);
    if (before.value !== after.value) outsideDifferences.push({ id: before.id, original: before.value, portable: after.value });
  }
  assert.equal(observedWasm.outsideContract.length, original.outsideContract.length);
  // Unsupported removal operations are observed separately; differences are never included among passed supported cases.
  const outputs = [];
  for (const [name, text] of [['original-jvm.json', originalText], ['portable-jvm.json', portableText], ['portable-wasmjs.json', wasmText]]) await writeFile(path.join(outputRoot, name), text + '\n', { flag: 'wx', mode: 0o600 });
  const files = ['jvm/original.jar', 'jvm/portable.jar', 'jvm/Reference.class', 'original-api.txt', 'portable-api.txt', 'original-jvm.json', 'portable-jvm.json', 'portable-wasmjs.json', 'klib/smart-set-probe.klib'];
  for (const entry of await readdir(path.join(outputRoot, 'wasm'), { withFileTypes: true })) { if (!entry.isFile()) throw new Error('Unexpected generated Wasm directory'); files.push('wasm/' + entry.name); }
  for (const name of files.sort()) { const bytes = await readRegular(path.join(outputRoot, name)); outputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); }
  await verifySmartSetPreparation(preparation.root);
  const receipt = { schemaVersion: 1, kind: 'official-smart-set-host-differential', source: prepared.receipt.source,
    sourceLockSha256: prepared.receipt.sourceLockSha256, preparationReceiptSha256: preparation.receiptSha256,
    buildToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))), buildFlagsSha256: sha256(flagBytes), observerSources: sources,
    original: prepared.receipt.original, portable: prepared.receipt.portable, host: prepared.receipt.host, sourceBody: prepared.receipt.sourceBody,
    bootstrap: { version: bootstrap.lock.version, compilerSourceCommit: null, artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) }, commands, outputs,
    comparison: { required: original.cases.length, passed: original.cases.length, failed: 0, skipped: 0, notRun: 0,
      cases: original.cases.map(item => item.id), originalJvmEqualsPortableJvm: true, originalJvmEqualsPortableWasm: true,
      observationSha256: sha256(Buffer.from(JSON.stringify(original.cases))), erasedApiSha256: sha256(Buffer.from(originalApi)), mutationOperations: 2048, seedHex: '01234567' },
    outsideContract: { originalKdoc: 'SmartSet does not support remove/removeAll/retainAll/iterator.remove', observations: original.outsideContract.length,
      originalJvmEqualsPortableJvm: true, wasmDifferences: outsideDifferences, status: 'not counted as supported-operation acceptance' },
    wasmEngine: { kind: 'Node', version: process.version, flags: ['--experimental-wasm-exnref'] }, browserComparison: 'not-run',
    fullCompilerR0: 'not-run', fullCompilerR1: 'not-run', browserCompilerBuilt: false, languageReadiness: false };
  await writeJson(path.join(outputRoot, 'receipt.json'), receipt); return { outputRoot, receipt };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter(value => value !== '--'); const options = {};
  for (let i = 0; i < args.length; i += 2) { if (!['--source-root', '--output', '--bootstrap-cache'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('Invalid SmartSet probe argument'); options[args[i]] = args[i + 1]; }
  if (!options['--source-root'] || !options['--output']) throw new Error('Usage: build.mjs --source-root PINNED_SOURCES --output NEW_DIRECTORY [--bootstrap-cache VERIFIED_CACHE]');
  const result = await buildSmartSetProbe({ sourceRoot: options['--source-root'], outputRoot: options['--output'], bootstrapCache: options['--bootstrap-cache'] });
  console.log(JSON.stringify({ outputRoot: result.outputRoot, comparison: result.receipt.comparison, outsideContract: result.receipt.outsideContract, languageReadiness: false }));
}

#!/usr/bin/env node
/** Real UTF-8 writer/decoder boundary differential; not a complete compiler build. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap, defaultCache } from '../../build/bootstrap.mjs';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { prepareCompilerTextSources, verifyCompilerTextPreparation } from './prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)); const execute = promisify(execFile);
const MAX_OBSERVATION = 32 * 1024 * 1024;

function liftWriterMethods(originals, lock, portable) {
  const snippets = Object.fromEntries(lock.probeSlices.map(pin => {
    const source = originals.get(pin.path).toString('utf8');
    const start = source.indexOf(pin.start); const end = source.indexOf(pin.end, start + pin.start.length);
    assert(start >= 0 && end > start); const snippet = source.slice(start, end);
    assert.equal(sha256(Buffer.from(snippet)), pin.sha256, 'Writer probe source slice changed'); return [pin.id, snippet];
  }));
  return Buffer.from('/* Selected official Kotlin writer method bodies; see receipt. */\n' +
    'package org.jetbrains.kotlin.portable.text.probe\n\n' +
    'import org.jetbrains.kotlin.wasm.ir.ByteWriter\nimport org.jetbrains.kotlin.wasm.ir.ByteWriterWithOffsetWrite\n' +
    'import org.jetbrains.kotlin.wasm.ir.WasmBinaryData.Companion.toByteArray\n' +
    (portable ? lock.writerImport + '\n' : '') + '\n' + snippets.builder + '\n' + snippets.locationsAndWat + '\n' +
    snippets.binaryString.replace(/^    /gm, '') + '\n' +
    'fun officialBinaryString(value: String): ByteArray {\n    val writer = ByteWriterWithOffsetWrite()\n    writer.writeString(value)\n    return writer.getBinaryData().toByteArray()\n}\n\n' +
    'private class ProbeTextBuilder : SExpressionBuilder() {\n' + snippets.watString +
    '    fun render(value: String): String { appendWatString(value); return toString() }\n}\n\n' +
    'fun officialWatString(value: String): String = ProbeTextBuilder().render(value)\n');
}

export async function buildCompilerTextProbe({ sourceRoot, stdlibSourceRoot, outputRoot, bootstrapCache = defaultCache }) {
  sourceRoot = path.resolve(sourceRoot); stdlibSourceRoot = path.resolve(stdlibSourceRoot ?? sourceRoot);
  outputRoot = path.resolve(outputRoot); await assertNoSymlink(outputRoot); await assertNoSymlink(stdlibSourceRoot);
  const bootstrap = await verifyBootstrap(bootstrapCache);
  const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')); const lock = JSON.parse(lockBytes);
  const stdlibReferences = [];
  for (const pin of lock.stdlibReferences) {
    relativePath(pin.path); const bytes = verifyFile(await readRegular(path.join(stdlibSourceRoot, pin.path)), pin);
    stdlibReferences.push({ ...pin, rawBytesVerified: true });
  }
  const decoder = verifyFile(await readRegular(path.join(sourceRoot, lock.decoderReference.path)), lock.decoderReference);
  assert(decoder.toString().includes('Charsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(b.readBytes(it))).toString()'));
  await mkdir(outputRoot, { recursive: false, mode: 0o700 });
  const prepared = await prepareCompilerTextSources({ sourceRoot, outputRoot });
  const preparation = await verifyCompilerTextPreparation(path.dirname(prepared.receiptPath));
  const flagBytes = await readRegular(path.resolve(HERE, '../build-flags.json')); const flags = JSON.parse(flagBytes);
  assert.equal(flags.source.commit, lock.source.commit); assert.equal(flags.languageVersion, '2.5'); assert.equal(flags.apiVersion, '2.5'); assert(Array.isArray(flags.compilerFlags));
  const commands = []; const observerSources = [];
  const local = {};
  for (const name of ['TextProbe.kt', 'OriginalJvmBridge.kt', 'PortableBridge.kt', 'JvmEntry.kt', 'WasmEntry.kt']) {
    const bytes = await readRegular(path.join(HERE, name)); const filename = path.join(outputRoot, name);
    await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); local[name] = filename;
    observerSources.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
  }
  async function run(phase, command, args) {
    try {
      const result = await execute(command, args, { cwd: outputRoot, timeout: 300000, maxBuffer: MAX_OBSERVATION, encoding: 'utf8' });
      if (result.stderr) process.stderr.write(result.stderr); commands.push({ phase, command, args, exitCode: 0 }); return result.stdout;
    } catch (failure) {
      await writeJson(path.join(outputRoot, 'failure.json'), { phase, command, args, exitCode: failure.code ?? null,
        signal: failure.signal ?? null, stderr: String(failure.stderr ?? '').slice(-16384), stdout: String(failure.stdout ?? '').slice(-1024) });
      if (failure.stderr) process.stderr.write(String(failure.stderr).slice(-16384)); throw new Error(phase + ' failed; see failure.json');
    }
  }
  for (const name of ['original', 'portable', 'jvm', 'klib', 'wasm']) await mkdir(path.join(outputRoot, name), { mode: 0o700 });
  const writerHere = path.resolve(HERE, '../../writer-probe');
  const writerLock = await readRegular(path.join(writerHere, 'sources.lock.json')); assert.equal(sha256(writerLock), lock.writerProbeDependency.sourceLockSha256);
  const originalWriters = [], portableWriters = [], writerPins = [];
  for (const pin of lock.writerProbeDependency.sources) {
    const original = verifyFile(await readRegular(path.join(sourceRoot, relativePath(pin.path))), pin);
    for (const [variant, list] of [['original', originalWriters], ['portable', portableWriters]]) {
      const filename = path.join(outputRoot, variant, pin.path); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      await writeFile(filename, original, { flag: 'wx', mode: 0o600 }); list.push(filename);
    }
  }
  const patch = await readRegular(path.join(writerHere, 'writer-portable.patch')); assert.equal(sha256(patch), lock.writerProbeDependency.patch.sha256);
  for (const args of [['apply', '--check'], ['apply'], ['apply', '--reverse', '--check']]) {
    await execute('git', [...args, path.join(writerHere, 'writer-portable.patch')], { cwd: path.join(outputRoot, 'portable'), timeout: 10000, maxBuffer: 65536 });
    commands.push({ phase: 'verified-writer-dependency-patch', command: 'git', args: [...args, path.join(writerHere, 'writer-portable.patch')], exitCode: 0 });
  }
  for (const pin of lock.writerProbeDependency.sources) {
    const bytes = await readRegular(path.join(outputRoot, 'portable', pin.path)); assert.equal(bytes.length, pin.portableBytes); assert.equal(sha256(bytes), pin.portableSha256);
    writerPins.push(pin);
  }
  const sink = await readRegular(path.join(writerHere, 'BoundedByteSink.kt')); assert.equal(sha256(sink), lock.writerProbeDependency.sink.sha256);
  const sinkFile = path.join(outputRoot, 'portable/BoundedByteSink.kt'); await writeFile(sinkFile, sink, { flag: 'wx', mode: 0o600 });
  const originals = new Map();
  for (const pin of lock.writers) originals.set(pin.path, verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin));
  const liftedSources = [];
  for (const variant of ['original', 'portable']) {
    const lifted = liftWriterMethods(originals, lock, variant === 'portable'); const filename = path.join(outputRoot, variant, 'OfficialWriterText.kt');
    await writeFile(filename, lifted, { flag: 'wx', mode: 0o600 }); liftedSources.push({ path: variant + '/OfficialWriterText.kt', bytes: lifted.length, sha256: sha256(lifted) });
  }
  const stdlibJvm = bootstrap.artifacts.find(item => item.id === 'stdlib-jvm').path;
  const compiler = ['-Xmx768m', '-cp', bootstrap.classPath];
  const jvm = [...compiler, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags, '-classpath', stdlibJvm];
  const wasm = [...compiler, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js', '-libraries', bootstrap.wasmJsStdlib, '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags];
  const originalJar = path.join(outputRoot, 'jvm/original.jar'), portableJar = path.join(outputRoot, 'jvm/portable.jar');
  const portableHelpers = prepared.commonSources.filter(filename => !filename.endsWith('/WasmIrToBinary.kt') && !filename.endsWith('/WasmIrToText.kt'));
  const originalSources = [...originalWriters, path.join(outputRoot, 'original/OfficialWriterText.kt'), local['TextProbe.kt'], local['OriginalJvmBridge.kt'], local['JvmEntry.kt']];
  const common = [...portableWriters, sinkFile, ...portableHelpers, path.join(outputRoot, 'portable/OfficialWriterText.kt'), local['TextProbe.kt'], local['PortableBridge.kt']];
  await run('selected-original-writer-jvm-build', 'java', [...jvm, '-d', originalJar, ...originalSources]);
  await run('portable-text-jvm-build', 'java', [...jvm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','), '-d', portableJar, ...common, local['JvmEntry.kt']]);
  const main = 'org.jetbrains.kotlin.portable.text.probe.JvmEntryKt';
  const originalText = (await run('original-jvm-observe', 'java', ['-ea', '-Xmx512m', '-cp', [originalJar, stdlibJvm].join(path.delimiter), main])).trim();
  const portableText = (await run('portable-jvm-observe', 'java', ['-ea', '-Xmx512m', '-cp', [portableJar, stdlibJvm].join(path.delimiter), main])).trim();
  await writeFile(path.join(outputRoot, 'original-jvm.json'), originalText + '\n', { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(outputRoot, 'portable-jvm.json'), portableText + '\n', { flag: 'wx', mode: 0o600 });
  if (portableText !== originalText) {
    const original = JSON.parse(originalText), portable = JSON.parse(portableText);
    const differences = original.cases.filter((item, index) => JSON.stringify(item) !== JSON.stringify(portable.cases[index])).slice(0, 32);
    await writeJson(path.join(outputRoot, 'differences.json'), { count: original.cases.length, differences }); throw new Error('Portable JVM UTF-8 boundary differs; see differences.json');
  }
  await run('portable-text-wasmjs-klib-build', 'java', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + common.join(','), '-Xir-produce-klib-file', '-ir-output-dir', path.join(outputRoot, 'klib'), '-ir-output-name', 'text-probe', ...common, local['WasmEntry.kt']]);
  await run('portable-text-wasmjs-binary-build', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + path.join(outputRoot, 'klib/text-probe.klib'), '-ir-output-dir', path.join(outputRoot, 'wasm'), '-ir-output-name', 'text-probe', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
  const wasmText = (await run('portable-node-wasmjs-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e',
    'const m = await import(process.argv[1]); console.log(m.textProbe());', pathToFileURL(path.join(outputRoot, 'wasm/text-probe.mjs')).href])).trim();
  await writeFile(path.join(outputRoot, 'portable-wasmjs.json'), wasmText + '\n', { flag: 'wx', mode: 0o600 });
  assert.equal(wasmText, originalText, 'Actual Wasm UTF-8 observations differ from original JVM');
  const result = JSON.parse(originalText); assert.equal(result.cases.length, result.required); assert.equal(new Set(result.cases.map(([id]) => id)).size, result.required);
  const outputs = [];
  const names = ['jvm/original.jar', 'jvm/portable.jar', 'klib/text-probe.klib', 'original-jvm.json', 'portable-jvm.json', 'portable-wasmjs.json'];
  for (const entry of await readdir(path.join(outputRoot, 'wasm'), { withFileTypes: true })) { assert(entry.isFile()); names.push('wasm/' + entry.name); }
  for (const name of names.sort()) { const bytes = await readRegular(path.join(outputRoot, name), MAX_OBSERVATION); outputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); }
  await verifyCompilerTextPreparation(preparation.root);
  const javaVersion = await execute('java', ['-version'], { maxBuffer: 65536, timeout: 10000 });
  const receipt = { schemaVersion: 1, kind: 'official-wasm-writer-utf8-boundary-differential', source: lock.source,
    sourceLockSha256: sha256(lockBytes), preparationReceiptSha256: preparation.receiptSha256,
    buildToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))), buildFlagsSha256: sha256(flagBytes),
    stdlibReferences, decoderReference: lock.decoderReference, writerDependency: lock.writerProbeDependency, writerPins, probeSlices: lock.probeSlices, liftedSources, observerSources,
    bootstrap: { version: bootstrap.lock.version, compilerSourceCommit: null, stdlibSourceCommit: null, artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
    environment: { os: os.platform(), release: os.release(), arch: os.arch(), java: (javaVersion.stdout + javaVersion.stderr).trim() },
    commands, outputs, comparison: { required: result.required, passed: result.required, failed: 0, skipped: 0, notRun: 0, groups: result.groups,
      originalJvmEqualsPortableJvm: true, originalJvmEqualsPortableWasm: true, observationSha256: sha256(Buffer.from(originalText)),
      comparisonUnit: 'each exact JSON-encoded result, including malformed sequence length/offset; no wording normalization',
      exceptionBoundary: 'common CharacterCodingException subtype carries original malformed length and absolute byte offset; Java exception FQCN is not emulated' },
    writerAlgorithms: prepared.receipt.writerAlgorithms, wasmEngine: { kind: 'Node', version: process.version, flags: ['--experimental-wasm-exnref'] },
    browserComparison: 'not-run', fullCompilerR0: 'not-run', fullCompilerR1: 'not-run', browserCompilerBuilt: false, languageReadiness: false };
  await writeJson(path.join(outputRoot, 'receipt.json'), receipt); return { outputRoot, receipt };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter(value => value !== '--'); const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--source-root', '--stdlib-source-root', '--output', '--bootstrap-cache'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('Invalid text probe argument'); options[args[i]] = args[i + 1];
  }
  if (!options['--source-root'] || !options['--output']) throw new Error('Usage: build.mjs --source-root PINNED_SOURCES --output NEW_DIRECTORY [--stdlib-source-root PINNED_STDLIB] [--bootstrap-cache VERIFIED_CACHE]');
  const result = await buildCompilerTextProbe({ sourceRoot: options['--source-root'], stdlibSourceRoot: options['--stdlib-source-root'], outputRoot: options['--output'], bootstrapCache: options['--bootstrap-cache'] });
  console.log(JSON.stringify({ outputRoot: result.outputRoot, comparison: result.receipt.comparison, languageReadiness: false }));
}

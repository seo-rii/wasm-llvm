#!/usr/bin/env node
/** Builds an official writer unit on three hosts. This is not a Kotlin source compiler port. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap, defaultCache } from '../build/bootstrap.mjs';
import { assertNoSymlink, readRegular, relativePath } from '../scripts/source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../..');
const exec = promisify(execFile);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const options = {};
const argumentsList = process.argv.slice(2);
while (argumentsList.length) {
  const key = argumentsList.shift();
  assert(['--output', '--source-root', '--bootstrap-cache'].includes(key) && argumentsList[0] && !options[key], 'Invalid build option');
  options[key] = path.resolve(argumentsList.shift());
}
const output = options['--output'] ?? path.join(repository, 'out/kotlin-bytewriter-probe');
const allowedOutput = path.join(repository, 'out') + path.sep;
assert(output.startsWith(allowedOutput) && output !== allowedOutput.slice(0, -1), 'Generated sources must stay under repository out/');
await assertNoSymlink(output);
await mkdir(output, { recursive: false });

const lockBytes = await readRegular(path.join(here, 'sources.lock.json'));
const lock = JSON.parse(lockBytes);
assert.equal(lock.schemaVersion, 1);
assert.equal(lock.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
assert.equal(lock.sources.length, 3);
const patch = await readRegular(path.join(here, relativePath(lock.patch.path)));
assert.equal(patch.byteLength, lock.patch.bytes);
assert.equal(hash(patch), lock.patch.sha256);
const bootstrap = await verifyBootstrap(options['--bootstrap-cache'] ?? defaultCache);
assert.equal(bootstrap.lock.selectedSourceCommit, lock.source.commit);
const commands = [];
async function command(phase, argv, { cwd = repository, capture = false } = {}) {
  const start = performance.now();
  let stdout = '';
  let exitCode;
  if (capture) {
    const result = await exec(argv[0], argv.slice(1), { cwd, timeout: 180000, maxBuffer: 1024 * 1024 });
    stdout = result.stdout;
    if (result.stderr) process.stderr.write(result.stderr);
    exitCode = 0;
  } else {
    exitCode = await new Promise((resolve, reject) => {
      const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['ignore', 'inherit', 'inherit'] });
      const timeout = setTimeout(() => child.kill('SIGKILL'), 180000);
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('exit', (code, signal) => {
        clearTimeout(timeout);
        if (signal) reject(new Error(phase + ' terminated by ' + signal));
        else resolve(code);
      });
    });
  }
  commands.push({ phase, argv, exitCode, elapsedMs: performance.now() - start });
  assert.equal(exitCode, 0, phase + ' failed');
  return stdout;
}

for (const variant of ['original', 'portable']) await mkdir(path.join(output, variant));
const originalSources = [];
const portableSources = [];
for (const pin of lock.sources) {
  relativePath(pin.path);
  let bytes;
  if (options['--source-root']) bytes = await readRegular(path.join(options['--source-root'], pin.path));
  else {
    const response = await fetch(`https://raw.githubusercontent.com/JetBrains/kotlin/${lock.source.commit}/${pin.path}`, { signal: AbortSignal.timeout(45000) });
    assert(response.ok && response.body, 'Pinned source download failed: ' + pin.path);
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      assert(total <= pin.bytes, 'Source download exceeds pin: ' + pin.path);
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
  }
  assert.equal(bytes.byteLength, pin.bytes, 'Source size mismatch: ' + pin.path);
  assert.equal(hash(bytes), pin.sha256, 'Source hash mismatch: ' + pin.path);
  assert.equal(createHash('sha1').update(Buffer.from(`blob ${bytes.byteLength}\0`)).update(bytes).digest('hex'), pin.gitBlobSha1);
  for (const variant of ['original', 'portable']) {
    const destination = path.join(output, variant, pin.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
    if (pin.portableSha256) (variant === 'original' ? originalSources : portableSources).push(destination);
  }
}
await command('patch-check', ['git', 'apply', '--check', path.join(here, lock.patch.path)], { cwd: path.join(output, 'portable') });
await command('patch-apply', ['git', 'apply', path.join(here, lock.patch.path)], { cwd: path.join(output, 'portable') });
const sourceVerification = [];
for (const pin of lock.sources) {
  const original = await readRegular(path.join(output, 'original', pin.path));
  const portable = await readRegular(path.join(output, 'portable', pin.path));
  assert.equal(hash(original), pin.sha256, 'Original source was modified');
  assert.equal(hash(portable), pin.portableSha256 ?? pin.sha256, 'Transformed source differs from patch pin');
  assert.equal(portable.byteLength, pin.portableBytes ?? pin.bytes);
  if (pin.role === 'official-binary-writer') {
    const methods = (text) => text.slice(text.indexOf('\n    fun writeByte('), text.indexOf('\nclass WasmBinaryData'));
    assert.equal(methods(portable.toString()), methods(original.toString()), 'Writer encoding methods changed');
    const backpatch = (text) => text.slice(text.indexOf('\n    fun writeVarUInt32FixedSize(v: Int,'));
    assert.equal(backpatch(portable.toString()), backpatch(original.toString()), 'Writer backpatch methods changed');
  } else if (pin.role === 'official-leb128') {
    const methods = (text) => text.slice(text.indexOf('fun writeUnsignedLeb128Fixed('));
    assert.equal(methods(portable.toString()), methods(original.toString()), 'LEB128 algorithms changed');
  }
  sourceVerification.push({ ...pin, originalUnmodified: true, transformedVerified: true });
}
await command('patch-reverse-check', ['git', 'apply', '--reverse', '--check', path.join(here, lock.patch.path)], { cwd: path.join(output, 'portable') });

const localFiles = ['BoundedByteSink.kt', 'JvmByteSink.kt', 'Probe.kt', 'PortableChecks.kt', 'OriginalJvmEntry.kt', 'PortableJvmEntry.kt', 'WasmEntry.kt'];
const observerSources = [];
for (const filename of localFiles) observerSources.push({ path: filename, bytes: (await readRegular(path.join(here, filename))).byteLength, sha256: hash(await readRegular(path.join(here, filename))) });
const local = (filename) => path.join(here, filename);
const compiler = ['java', '-Xmx1024m', '-cp', bootstrap.classPath];
const jvmCompiler = [...compiler, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17',
  '-language-version', '2.5', '-api-version', '2.5', '-classpath', bootstrap.classPath];
const wasmCompiler = [...compiler, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js',
  '-language-version', '2.5', '-api-version', '2.5', '-libraries', bootstrap.wasmJsStdlib];
for (const directory of ['jvm', 'klib', 'wasm']) await mkdir(path.join(output, directory));
await command('original-jvm-build', [...jvmCompiler, '-d', path.join(output, 'jvm/original.jar'), ...originalSources, local('Probe.kt'), local('OriginalJvmEntry.kt')]);
await command('portable-jvm-build', [...jvmCompiler, '-d', path.join(output, 'jvm/portable.jar'), ...portableSources,
  ...['BoundedByteSink.kt', 'JvmByteSink.kt', 'Probe.kt', 'PortableChecks.kt', 'PortableJvmEntry.kt'].map(local)]);
const originalStdout = await command('original-jvm-observe', ['java', '-cp', path.join(output, 'jvm/original.jar') + path.delimiter + bootstrap.classPath,
  'org.jetbrains.kotlin.wasm.writerprobe.OriginalJvmEntryKt', path.join(output, 'original-file.bin')], { capture: true });
const portableStdout = await command('portable-jvm-observe', ['java', '-cp', path.join(output, 'jvm/portable.jar') + path.delimiter + bootstrap.classPath,
  'org.jetbrains.kotlin.wasm.writerprobe.PortableJvmEntryKt', path.join(output, 'portable-file.bin')], { capture: true });
const originalResult = JSON.parse(originalStdout.trim());
const portableLines = portableStdout.trim().split('\n');
assert.equal(portableLines.length, 2);
const portableResult = JSON.parse(portableLines[0]);
const portableChecks = JSON.parse(portableLines[1]);
assert.deepEqual(portableResult, originalResult, 'Portable JVM writer differs from original JVM writer');
assert.deepEqual(await readFile(path.join(output, 'original-file.bin')), await readFile(path.join(output, 'portable-file.bin')), 'JVM file adapter changed bytes');
assert.equal(portableChecks.failed, 0);
for (const [filename, result] of [['original-jvm.json', originalResult], ['portable-jvm.json', portableResult], ['portable-checks-jvm.json', portableChecks]]) {
  await writeFile(path.join(output, filename), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
await command('portable-wasmjs-klib-build', [...wasmCompiler, '-Xir-produce-klib-file', '-ir-output-dir', path.join(output, 'klib'), '-ir-output-name', 'writer-probe',
  ...portableSources, ...['BoundedByteSink.kt', 'Probe.kt', 'PortableChecks.kt', 'WasmEntry.kt'].map(local)]);
await command('portable-wasmjs-binary-build', [...wasmCompiler, '-Xir-produce-js', '-Xinclude=' + path.join(output, 'klib/writer-probe.klib'),
  '-ir-output-dir', path.join(output, 'wasm'), '-ir-output-name', 'writer-probe', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
const outputs = [];
for (const filename of ['jvm/original.jar', 'jvm/portable.jar', 'klib/writer-probe.klib', 'original-jvm.json', 'portable-jvm.json', 'portable-checks-jvm.json',
  'original-file.bin', 'portable-file.bin', ...(await readdir(path.join(output, 'wasm'))).sort().map((name) => 'wasm/' + name)]) {
  const bytes = await readRegular(path.join(output, filename));
  outputs.push({ path: filename, bytes: bytes.byteLength, sha256: hash(bytes) });
}
const java = await exec('java', ['-version'], { timeout: 10000, maxBuffer: 65536 });
const receipt = {
  schemaVersion: 1, kind: 'official-byte-writer-unit-build', gate: 'G2-writer-unit-only', status: 'passed', source: lock.source,
  sourceLockSha256: hash(lockBytes), patch: lock.patch, sourceVerification, observerSources,
  buildScriptSha256: hash(await readRegular(fileURLToPath(import.meta.url))),
  bootstrapLockSha256: hash(await readRegular(path.join(here, '../build/bootstrap.lock.json'))),
  bootstrapVersion: bootstrap.lock.version, bootstrapCompilerSourceCommit: bootstrap.lock.compilerSourceCommit,
  bootstrapArtifacts: bootstrap.artifacts.map(({ path: ignored, ...record }) => record),
  java: (java.stdout + java.stderr).trim(), environment: { os: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0]?.model },
  commands, jvmComparison: { required: originalResult.cases.length, passed: originalResult.cases.length, failed: 0, skipped: 0, notRun: 0,
    checks: originalResult.checks, portableGuards: portableChecks, fileAdapterByteEquality: true },
  outputs, browserComparison: 'not-run', languageReadiness: false,
  limitations: ['Official writer and LEB128 unit only; no FIR, IR construction, full KLIB reader, lowering or Kotlin source compilation.',
    'Host compiler is the official pinned bootstrap artifact; its source commit is not proven to equal the candidate commit.',
    'Finite sink policy is an explicit new host limit. Composite writer operations are not transactional after a sink error; failed writers must be discarded.',
    'The JVM file extension moves to JvmWasmBinaryData. Updating actual backend call sites is outside this isolated probe.',
    'Float/Double fixtures test integer raw-bit payload encoding, not floating-point arithmetic or toRawBits conversion.',
    'A successful build alone is not browser byte equality or completion of the whole G2 gate.'],
};
await writeFile(path.join(output, 'build-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ output, status: receipt.status, jvmCases: originalResult.cases.length, wasm: outputs.filter((item) => item.path.endsWith('.wasm')) }));

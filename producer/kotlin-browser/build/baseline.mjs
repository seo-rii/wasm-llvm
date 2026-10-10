#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, sha256, writeJson } from '../scripts/source.mjs';
import { defaultCache, verifyBootstrap } from './bootstrap.mjs';

const HERE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(HERE), '..');
const REPOSITORY = path.resolve(ROOT, '..', '..');
const execute = promisify(execFile);
const compiler = 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler';

export function inspectWasm(bytes) {
  const module = new WebAssembly.Module(bytes);
  let position = 8;
  let startSection = false;
  const u32 = () => {
    let result = 0;
    let shift = 0;
    for (let count = 0; count < 5; count++) {
      if (position >= bytes.length) throw new Error('Truncated Wasm section size');
      const byte = bytes[position++];
      if (count === 4 && byte > 15) throw new Error('Wasm section size overflow');
      result += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return result;
      shift += 7;
    }
    throw new Error('Invalid Wasm section size');
  };
  while (position < bytes.length) {
    const id = bytes[position++];
    const size = u32();
    if (size > bytes.length - position) throw new Error('Wasm section exceeds file');
    if (id === 8) startSection = true;
    position += size;
  }
  const imports = WebAssembly.Module.imports(module);
  const exports = WebAssembly.Module.exports(module);
  const memory = exports.filter((item) => item.kind === 'memory');
  if (memory.length !== 1 || !exports.some((item) => item.kind === 'function' && item.name === '_start')) {
    throw new Error('Expected a WASI command with one exported memory and _start');
  }
  if (imports.some((item) => item.module !== 'wasi_snapshot_preview1' || item.kind !== 'function')) {
    throw new Error('Unexpected host authority in Kotlin wasmWasi output');
  }
  return { imports, exports, memoryExport: memory[0].name, entry: { kind: 'command', exportName: '_start' }, startSection,
    nodeValidation: { status: 'pass', nodeVersion: process.versions.node,
      flags: process.execArgv.filter((argument) => argument.startsWith('--experimental-wasm-')) } };
}

export async function baseline({ output, cacheRoot = defaultCache, java = 'java', root = ROOT } = {}) {
  const prepared = await verifyBootstrap(cacheRoot, { root });
  if (output) {
    output = path.resolve(output);
    await assertNoSymlink(output);
    await mkdir(path.dirname(output), { recursive: true });
    await mkdir(output); // Existing evidence is never reused or replaced.
  } else {
    const parent = path.join(REPOSITORY, 'out', 'kotlin-browser-baseline');
    await assertNoSymlink(parent);
    await mkdir(parent, { recursive: true });
    output = await mkdtemp(path.join(parent, 'run-'));
  }
  const fixtures = [
    { id: 'hello-world', fixture: 'hello-world.kt', expected: { stdin: '', stdout: 'Hello World\n', stderr: '', exitCode: 0 } },
    { id: 'fibonacci', fixture: 'fibonacci.kt', expected: { stdin: '10\n', stdout: '55\n', stderr: '', exitCode: 0 },
      additionalInputs: [{ stdin: '20\n', stdout: '6765\n', stderr: '', exitCode: 0 }] }
  ];
  const cases = [];
  const common = ['-Xwasm-target=wasm-wasi', '-libraries', prepared.wasmWasiStdlib,
    '-main', 'call', '-language-version', '2.4', '-api-version', '2.4', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts',
    '-Xwasm-use-new-exception-proposal'];
  const run = async (args) => {
    const command = [java, '-Xmx2g', '-cp', prepared.classPath, compiler, ...args];
    const result = await execute(java, command.slice(1), { cwd: output, timeout: 180000, maxBuffer: 1024 * 1024 });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return { command, exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  };
  for (const fixture of fixtures) {
    const source = await readRegular(path.join(root, 'fixtures', fixture.fixture));
    const sourcePath = 'sources/' + fixture.fixture;
    const sourceFile = path.join(output, sourcePath);
    await mkdir(path.dirname(sourceFile), { recursive: true });
    await writeFile(sourceFile, source, { flag: 'wx', mode: 0o600 });
    const klibDirectory = path.join(output, fixture.id, 'klib');
    const programDirectory = path.join(output, fixture.id, 'program');
    await mkdir(klibDirectory, { recursive: true });
    await mkdir(programDirectory);
    const sourcePhase = await run([...common,
      '-ir-output-dir', klibDirectory, '-ir-output-name', fixture.id, sourceFile]);
    const klibPath = fixture.id + '/klib/' + fixture.id + '.klib';
    const klib = await readRegular(path.join(output, klibPath), 8 * 1024 * 1024);
    const binaryPhase = await run([...common, '-Xir-produce-js', '-Xinclude=' + path.join(output, klibPath),
      '-ir-output-dir', programDirectory, '-ir-output-name', fixture.id]);
    const wasmPath = fixture.id + '/program/' + fixture.id + '.wasm';
    const wasm = await readRegular(path.join(output, wasmPath), 32 * 1024 * 1024);
    const metadata = inspectWasm(wasm);
    const item = { id: fixture.id, sourcePath, sourceBytes: source.length, sourceSha256: sha256(source),
      klibPath, klibBytes: klib.length, klibSha256: sha256(klib), wasmPath, wasmBytes: wasm.length, wasmSha256: sha256(wasm),
      ...metadata, expected: fixture.expected, additionalInputs: fixture.additionalInputs ?? [],
      build: { status: 'pass', sourcePhase, binaryPhase }, execution: { native: 'not-run', browser: 'not-run' } };
    cases.push(item);
    await writeJson(path.join(output, fixture.id, 'build-receipt.json'), item);
    console.log(JSON.stringify({ id: fixture.id, wasmPath: path.join(output, wasmPath), wasmSha256: item.wasmSha256,
      imports: item.imports, exports: item.exports, memoryExport: item.memoryExport, entry: item.entry, startSection: item.startSection }));
  }
  const jdk = await execute(java, ['-version'], { timeout: 10000, maxBuffer: 65536 });
  const receipt = { schemaVersion: 1, kind: 'jvm-hosted-kotlin-wasi-baseline', compilerHost: 'jvm', programTarget: 'wasmWasi',
    programAbi: 'wasi-preview1', compiler: { version: prepared.lock.version, sourceCommit: null, role: 'bootstrap-reference',
      jarSha256: prepared.artifacts.find((item) => item.id === 'compiler').sha256 },
    selectedSourceCommit: prepared.lock.selectedSourceCommit,
    relationship: 'Official precompiled bootstrap compiler reference, not same-source-commit R0/R1 or browser compilation.',
    featureRequirements: { wasmGC: true, exceptionHandling: 'exnref', wasi: 'preview1' },
    stdlib: { version: prepared.lock.version, sourceCommit: null, patched: false,
      file: prepared.artifacts.find((item) => item.id === 'stdlib-wasi').file,
      bytes: prepared.artifacts.find((item) => item.id === 'stdlib-wasi').bytes,
      sha256: prepared.artifacts.find((item) => item.id === 'stdlib-wasi').sha256 },
    javaVersion: (jdk.stdout + jdk.stderr).trim(), cases,
    readiness: { ready: false, R0: 'not-run', R1: 'not-run', browserCompiler: 'not-built', browserExecution: 'not-run' } };
  await writeJson(path.join(output, 'receipt.json'), receipt);
  console.log(JSON.stringify({ receipt: path.join(output, 'receipt.json'), cases: cases.length, browserCompiler: 'not-built' }));
  return { output, receipt };
}

if (process.argv[1] && path.resolve(process.argv[1]) === HERE) {
  try {
    const args = process.argv.slice(2).filter((argument) => argument !== '--');
    if (args.includes('--help')) console.log('Usage: node producer/kotlin-browser/build/baseline.mjs [--output FRESH_DIR] [--cache-dir DIR]');
    else {
      const options = {};
      while (args.length) {
        const option = args.shift();
        if (!['--output', '--cache-dir'].includes(option) || !args[0] || args[0].startsWith('--')) throw new Error('Invalid baseline option');
        const key = option === '--output' ? 'output' : 'cacheRoot';
        if (options[key]) throw new Error('Duplicate baseline option');
        options[key] = path.resolve(args.shift());
      }
      await baseline(options);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

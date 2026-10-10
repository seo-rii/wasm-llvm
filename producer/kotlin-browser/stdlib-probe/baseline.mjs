#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readJson, readRegular, relativePath, sha256, writeJson } from '../scripts/source.mjs';
import { defaultCache, verifyBootstrap } from '../build/bootstrap.mjs';
import { inspectWasm } from '../build/baseline.mjs';
import { HERE, loadRecipe } from './prepare.mjs';

const execute = promisify(execFile);
const PRODUCER = path.resolve(HERE, '..');
const compiler = 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler';

export function validateTargetReceipt(receipt, recipe, recipeSha256) {
  if (receipt.kind !== 'selected-source-kotlin-wasi-stdlib-build' || receipt.status !== 'pass' ||
      receipt.source?.commit !== recipe.source.commit || receipt.recipeSha256 !== recipeSha256 ||
      receipt.compilerHost !== 'jvm' || receipt.programTarget !== 'wasmWasi' ||
      receipt.compiler?.version !== recipe.bootstrapVersion || receipt.compiler.sourceCommit !== null ||
      receipt.compiler.role !== 'official-bootstrap' || receipt.publicLanguageSupport !== false ||
      receipt.browserCompiler !== 'not-built' || receipt.sourceFiles !== 507 || receipt.compiledSourceFiles !== 501 ||
      receipt.versionGeneration?.unchangedOfficialLogicExecution !== 'pass' || receipt.builtinGeneration?.copied?.length !== 5 ||
      receipt.stdlib?.sourceCommit !== recipe.source.commit || receipt.stdlib.version !== recipe.kotlinVersion ||
      receipt.stdlib.patched !== true || receipt.stdlib.patchSha256 !== recipe.patch.sha256 ||
      receipt.patch?.sourceState !== 'patched' || receipt.patch.patch.sha256 !== recipe.patch.sha256 ||
      !Number.isSafeInteger(receipt.stdlib.bytes) || receipt.stdlib.bytes <= 0 || receipt.stdlib.bytes > 16 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(receipt.stdlib.sha256 ?? '')) throw new Error('Patched target stdlib build identity mismatch');
  relativePath(receipt.stdlib.path);
}

export async function baseline({ stdlibBuild, output, cacheRoot = defaultCache, java = 'java' } = {}) {
  if (!stdlibBuild) throw new Error('--stdlib-build is required');
  stdlibBuild = path.resolve(stdlibBuild);
  const recipe = await loadRecipe();
  const buildReceipt = await readJson(path.join(stdlibBuild, 'stdlib-receipt.json'));
  const recipeSha256 = sha256(await readRegular(path.join(HERE, 'recipe.json')));
  validateTargetReceipt(buildReceipt, recipe, recipeSha256);
  const prepared = await verifyBootstrap(cacheRoot);
  if (buildReceipt.compiler.jarSha256 !== prepared.artifacts.find((pin) => pin.id === 'compiler').sha256) {
    throw new Error('Patched target stdlib build identity mismatch');
  }
  const stdlib = await readRegular(path.join(stdlibBuild, buildReceipt.stdlib.path), 16 * 1024 * 1024);
  if (stdlib.length !== buildReceipt.stdlib.bytes || sha256(stdlib) !== buildReceipt.stdlib.sha256) throw new Error('Patched target KLIB hash mismatch');
  if (output) {
    output = path.resolve(output);
    await assertNoSymlink(output);
    await mkdir(path.dirname(output), { recursive: true });
    await mkdir(output);
  } else output = await mkdtemp(path.join(stdlibBuild, 'baseline-'));
  const stdlibPath = 'stdlib/kotlin-stdlib-wasm-wasi.klib';
  await mkdir(path.join(output, 'stdlib'));
  await writeFile(path.join(output, stdlibPath), stdlib, { flag: 'wx', mode: 0o600 });
  const cases = [];
  const common = ['-Xwasm-target=wasm-wasi', '-libraries', path.join(output, stdlibPath), '-main', 'call',
    '-language-version', recipe.languageVersion, '-api-version', recipe.apiVersion,
    '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts', '-Xwasm-use-new-exception-proposal'];
  const run = async (args) => {
    const command = [java, '-Xmx2g', '-cp', prepared.classPath, compiler, ...args];
    const started = performance.now();
    const result = await execute(java, command.slice(1), { cwd: output, timeout: 180000, maxBuffer: 1024 * 1024 });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return { command, exitCode: 0, elapsedMs: performance.now() - started, stdout: result.stdout, stderr: result.stderr };
  };
  for (const fixture of [
    { id: 'hello-world', expected: { stdin: '', stdout: 'Hello World\n', stderr: '', exitCode: 0 }, additionalInputs: [] },
    { id: 'fibonacci', expected: { stdin: '10\n', stdout: '55\n', stderr: '', exitCode: 0 },
      additionalInputs: [{ stdin: '20\n', stdout: '6765\n', stderr: '', exitCode: 0 }] }
  ]) {
    const source = await readRegular(path.join(PRODUCER, 'fixtures', fixture.id + '.kt'));
    const sourcePath = 'sources/' + fixture.id + '.kt';
    const sourceFile = path.join(output, sourcePath);
    await mkdir(path.dirname(sourceFile), { recursive: true });
    await writeFile(sourceFile, source, { flag: 'wx', mode: 0o600 });
    const klibDirectory = path.join(output, fixture.id, 'klib');
    const programDirectory = path.join(output, fixture.id, 'program');
    await mkdir(klibDirectory, { recursive: true });
    await mkdir(programDirectory);
    const sourcePhase = await run([...common, '-ir-output-dir', klibDirectory, '-ir-output-name', fixture.id, sourceFile]);
    const klibPath = fixture.id + '/klib/' + fixture.id + '.klib';
    const klib = await readRegular(path.join(output, klibPath), 8 * 1024 * 1024);
    const binaryPhase = await run([...common, '-Xir-produce-js', '-Xinclude=' + path.join(output, klibPath),
      '-ir-output-dir', programDirectory, '-ir-output-name', fixture.id]);
    const wasmPath = fixture.id + '/program/' + fixture.id + '.wasm';
    const wasm = await readRegular(path.join(output, wasmPath), 32 * 1024 * 1024);
    const item = { id: fixture.id, sourcePath, sourceBytes: source.length, sourceSha256: sha256(source),
      klibPath, klibBytes: klib.length, klibSha256: sha256(klib), wasmPath, wasmBytes: wasm.length, wasmSha256: sha256(wasm),
      ...inspectWasm(wasm), expected: fixture.expected, additionalInputs: fixture.additionalInputs,
      build: { status: 'pass', sourcePhase, binaryPhase }, execution: { native: 'not-run', browser: 'not-run' } };
    cases.push(item);
    await writeJson(path.join(output, fixture.id, 'build-receipt.json'), item);
    console.log(JSON.stringify({ id: item.id, wasmPath: path.join(output, item.wasmPath), imports: item.imports, wasmSha256: item.wasmSha256 }));
  }
  const receipt = { schemaVersion: 1, kind: 'jvm-hosted-kotlin-wasi-baseline', compilerHost: 'jvm', programTarget: 'wasmWasi',
    programAbi: 'wasi-preview1', compiler: { version: prepared.lock.version, sourceCommit: null, role: 'bootstrap-reference',
      jarSha256: prepared.artifacts.find((pin) => pin.id === 'compiler').sha256 }, selectedSourceCommit: recipe.source.commit,
    relationship: 'Official bootstrap compiler compiles programs against a complete selected-source patched target stdlib; this is not compiler R0/R1 or browser compilation.',
    featureRequirements: { wasmGC: true, exceptionHandling: 'exnref', wasi: 'preview1' },
    stdlib: { ...buildReceipt.stdlib, path: stdlibPath, file: path.basename(stdlibPath),
      recipeSha256, buildReceiptSha256: sha256(await readRegular(path.join(stdlibBuild, 'stdlib-receipt.json'))) },
    cases, readiness: { ready: false, R0: 'not-run', R1: 'not-run', browserCompiler: 'not-built', browserExecution: 'not-run' } };
  await writeJson(path.join(output, 'receipt.json'), receipt);
  console.log(JSON.stringify({ output, receipt: path.join(output, 'receipt.json'), cases: cases.length }));
  return { output, receipt };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2).filter((argument) => argument !== '--');
    const options = {};
    while (args.length) {
      const flag = args.shift();
      const key = { '--stdlib-build': 'stdlibBuild', '--output': 'output', '--cache-dir': 'cacheRoot' }[flag];
      if (!key || !args[0] || args[0].startsWith('--') || options[key]) throw new Error('Invalid patched stdlib baseline option');
      options[key] = path.resolve(args.shift());
    }
    await baseline(options);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

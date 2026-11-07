import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { reopenBuildSelection } from './verify.mjs';

const identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });

// The common-source list is an independent compiler input: replace it together
// with the positional vector, preserving every non-source compiler option.
export function projectControlArguments(args, current, predecessor, outputRoot) {
  const currentFiles = current.map(row => row.filename), priorFiles = predecessor.map(row => row.filename);
  assert.equal(new Set(currentFiles).size, currentFiles.length);
  assert.equal(new Set(priorFiles).size, priorFiles.length);
  assert.deepEqual(args.slice(-current.length), currentFiles, 'Current positional source vector changed');
  const flags = args.slice(0, -current.length);
  const common = flags.flatMap((value, index) => value.startsWith('-Xcommon-sources=') ? [index] : []);
  assert.equal(common.length, 1, 'Exactly one common source vector required');
  assert.equal(flags[common[0]], '-Xcommon-sources=' + currentFiles.join(','), 'Current common source vector changed');
  assert.equal(flags.filter(value => value === '-ir-output-dir').length, 1);
  const output = flags.indexOf('-ir-output-dir'); assert(output >= 0 && flags[output + 1]);
  flags[common[0]] = '-Xcommon-sources=' + priorFiles.join(',');
  flags[output + 1] = path.join(outputRoot, 'klib');
  return [...flags, ...priorFiles];
}

export async function verifySourceRows(rows) {
  for (const row of rows) assert.deepEqual(identity(await readRegular(row.filename)),
    { bytes: row.bytes, sha256: row.sha256 }, 'Compiler source changed: ' + row.path);
}

export async function compilerInputPins(command, args, bootstrap, hostLibraries) {
  assert.equal(command[0], 'java');
  assert.equal(command.at(-2), 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler');
  assert.equal(command.filter(value => value === '-cp').length, 1);
  const classPath = command[command.indexOf('-cp') + 1].split(path.delimiter);
  const libraries = args[args.indexOf('-libraries') + 1].split(path.delimiter), result = [];
  assert.deepEqual(libraries.map(filename => path.basename(filename)),
    hostLibraries.map(row => path.basename(row.file ?? row.path)), 'The complete host library vector changed');
  for (const filename of [...new Set([...classPath, ...libraries])]) {
    assert(path.isAbsolute(filename));
    const bytes = await readRegular(filename, 128 * 1024 * 1024), pin = { filename, ...identity(bytes) };
    const expected = bootstrap.artifacts.find(row => row.file === path.basename(filename));
    if (classPath.includes(filename)) assert(expected, 'Unexpected bootstrap classpath artifact');
    if (expected) assert.deepEqual(identity(bytes), { bytes: expected.bytes, sha256: expected.sha256 });
    if (libraries.includes(filename)) {
      const library = hostLibraries[libraries.indexOf(filename)];
      assert.equal(pin.sha256, library.sha256, 'Host library differs from the actual whole compiler input');
      if (library.bytes !== undefined) assert.equal(pin.bytes, library.bytes);
    }
    result.push(pin);
  }
  return result;
}

export async function runCurrentFoundationControl(configuration) {
  const opened = await reopenBuildSelection(configuration.build);
  assert.equal(opened.variant, undefined);
  assert.equal(opened.actual.length, 3571);
  assert.equal(opened.receipt.jvmDescriptorSignatureImplementationsReceipt.files.length, 18);
  const predecessor = opened.reopened.predecessorRetainedSources;
  assert.equal(predecessor.length, 3571);
  assert.deepEqual(predecessor.filter(row => row.path.startsWith('compiler-port-jvm-descriptor-signatures/')),
    opened.actual.filter(row => row.path.startsWith('compiler-port-jvm-descriptor-signatures/')),
    'All eighteen current JVM signature sources must survive the exception inverse unchanged');
  assert.equal(predecessor.filter(row => row.path.startsWith('compiler-port-jvm-descriptor-signatures/')).length, 18);
  const outputRoot = path.resolve(configuration.outputRoot);
  assert(outputRoot.startsWith(path.join(configuration.build.snapshotRoot, 'out') + path.sep));
  assert(outputRoot !== configuration.build.buildRoot && !outputRoot.startsWith(configuration.build.buildRoot + path.sep));
  const originalArgs = (await readRegular(path.join(configuration.build.buildRoot, 'compiler-klib.args'), 16 * 1024 * 1024))
    .toString().trimEnd().split('\n').map(JSON.parse);
  const args = projectControlArguments(originalArgs, opened.actual, predecessor, outputRoot);
  const inputPins = await compilerInputPins(opened.command.command, args, opened.receipt.bootstrap, opened.receipt.hostLibraries);
  await verifySourceRows([...opened.actual, ...predecessor]);
  await mkdir(outputRoot, { mode: 0o700 });
  await mkdir(path.join(outputRoot, 'klib'), { mode: 0o700 });
  const argumentFile = path.join(outputRoot, 'compiler-klib.args');
  const argumentBytes = Buffer.from(args.map(value => JSON.stringify(value)).join('\n') + '\n');
  await writeFile(argumentFile, argumentBytes, { flag: 'wx', mode: 0o600 });
  const command = [...opened.command.command.slice(0, -1), '@' + argumentFile];
  const selection = { kind: 'authenticated-exception-predecessor-control-selection',
    currentBuildReceiptSha256: sha256(opened.receiptBytes),
    exceptionFinalReceipt: opened.reopened.receipt,
    current: opened.actual, predecessor,
    exactCommonAndPositionalVectors: true, unchangedNonSourceOptions: true,
    changedOutputDirectoryOnly: path.join(outputRoot, 'klib'), compilerInputs: inputPins };
  await writeJson(path.join(outputRoot, 'control-selection.json'), selection);
  const started = performance.now();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { cwd: outputRoot, stdio: ['ignore', 'inherit', 'inherit'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), opened.command.timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (exitCode, signal) => { clearTimeout(timer); resolve({ exitCode, signal, pid: child.pid }); });
  });
  const invocation = { phase: 'official-compiler-source-to-wasmjs-klib', command,
    argumentFileSha256: sha256(argumentBytes), maximumHeap: opened.command.maximumHeap,
    timeoutMs: opened.command.timeoutMs, ...result, elapsedMs: performance.now() - started };
  await verifySourceRows([...opened.actual, ...predecessor]);
  assert.deepEqual(await compilerInputPins(command, args, opened.receipt.bootstrap, opened.receipt.hostLibraries), inputPins);
  await writeJson(path.join(outputRoot, 'compiler-build-receipt.json'), {
    schemaVersion: 1, kind: 'compiler-exception-authenticated-predecessor-control',
    source: opened.receipt.source, bootstrap: opened.receipt.bootstrap, hostLibraries: opened.receipt.hostLibraries,
    currentBuildReceiptSha256: sha256(opened.receiptBytes),
    selectionSha256: sha256(await readRegular(path.join(outputRoot, 'control-selection.json'), 16 * 1024 * 1024)),
    compileSources: predecessor.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
    commands: [invocation], inputsUnchanged: true,
    fullCompilerBuilt: false, browserCompilerExecuted: false,
  });
  assert.equal(result.signal, null, 'Control compiler did not exit normally');
  assert(Number.isSafeInteger(result.exitCode));
  return { result: 'completed', currentSources: opened.actual.length, predecessorSources: predecessor.length,
    compilerExitCode: result.exitCode, compilerElapsedMs: invocation.elapsedMs, outputRoot };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert(process.argv[2], 'Usage: current-foundation-control.mjs CONFIGURATION_JSON');
  console.log(JSON.stringify(await runCurrentFoundationControl(JSON.parse(await readRegular(path.resolve(process.argv[2]))))));
}

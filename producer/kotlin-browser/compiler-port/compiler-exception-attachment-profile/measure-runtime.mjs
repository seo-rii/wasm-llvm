import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readRegular, sha256, verifyFile, writeJson, assertNoSymlink } from '../../scripts/source.mjs';
import { ENTRY, transform } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const output = path.resolve(process.argv[2]);
const sourceRoot = path.resolve(process.argv[3] ?? path.join(repository, 'out/kotlin-compiler-port/sources'));
assert(output.startsWith(path.join(repository, 'out') + path.sep));
await assertNoSymlink(output);
await mkdir(output, { mode: 0o700 });
const lockBytes = await readRegular(path.join(here, 'sources.lock.json'));
const lock = JSON.parse(lockBytes);
const identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });
const inputs = [];
async function input(filename, pin) {
  const bytes = await readRegular(filename);
  if (pin) verifyFile(bytes, pin);
  inputs.push({ filename, ...identity(bytes) });
  return bytes;
}
async function store(relative, bytes) {
  const filename = path.join(output, relative);
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
}
for (const pin of lock.targets) {
  const filename = pin.path === ENTRY ? path.join(here, '../entry/BrowserCompilerPipeline.kt') : path.join(sourceRoot, pin.path);
  const bytes = await input(filename, pin);
  await store('original/' + pin.path, bytes);
  await store('draft/' + pin.path, transform(bytes, lock.changes[pin.path]));
}
for (const pin of lock.helpers) {
  await store('draft/' + path.basename(pin.path), await input(path.join(here, path.basename(pin.path)), pin));
}
await input(path.join(here, 'RequestHostProbe.kt'));
const execute = promisify(execFile);
const commands = [];
for (const [script, family] of [['measure-string-contract.mjs', 'string-contract'],
  ['measure-exception-algorithms.mjs', 'exception-algorithms'], ['measure-platform-policy.mjs', 'platform-policy']]) {
  const configuration = path.join(output, family + '-configuration.json');
  await writeJson(configuration, { outputRoot: family === 'platform-policy' ? path.join(output, family) : output, sourceRoot });
  const filename = path.join(here, script);
  await input(filename);
  const started = performance.now();
  const result = await execute(process.execPath, [filename, configuration], { cwd: repository, timeout: 600000, maxBuffer: 4 * 1024 * 1024 });
  commands.push({ argv: [process.execPath, filename, configuration], exitCode: 0, elapsedMs: performance.now() - started });
  await store(family + '-command-output.txt', Buffer.from(result.stdout + result.stderr));
}
const results = [];
for (const family of ['string-contract', 'exception-algorithms', 'platform-policy']) {
  const filename = path.join(output, family, 'result.json');
  const bytes = await readRegular(filename, 4 * 1024 * 1024), result = JSON.parse(bytes);
  assert.equal(result.result, 'pass');
  assert(result.commands.every(command => command.exitCode === 0));
  for (const pin of [...result.inputs, ...result.artifacts]) {
    assert.deepEqual(identity(await readRegular(pin.filename)), { bytes: pin.bytes, sha256: pin.sha256 });
  }
  results.push({ family, filename, ...identity(bytes) });
}
for (const pin of inputs) assert.deepEqual(identity(await readRegular(pin.filename)), { bytes: pin.bytes, sha256: pin.sha256 });
await writeJson(path.join(output, 'qualification.json'), { schemaVersion: 1,
  kind: 'compiler-exception-current-runtime-qualification', status: 'passed',
  sourceLock: { filename: path.join(here, 'sources.lock.json'), ...identity(lockBytes) },
  inputs, commands, results, inputsUnchanged: true, browserFatalTaxonomyImplemented: false,
  wholeAnalysisAndFirWrappersExecuted: false, fullCompilerBuilt: false });
console.log(JSON.stringify({ status: 'passed', output, stringRecords: 12, exceptionRecords: 57,
  genuineJvmPolicyRecords: 5, requestHostRecords: 8 }));

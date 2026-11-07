import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { reopenBuildSelection } from './verify.mjs';
import { ENTRY } from './transform.mjs';
import { lexicalReferenceView } from '../native-js-output-profile/references.mjs';

const [configurationFile] = process.argv.slice(2);
assert(configurationFile, 'Usage: qualify-source.mjs CONFIGURATION_JSON');
const configuration = JSON.parse(await readRegular(path.resolve(configurationFile)));
const output = path.resolve(configuration.output);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
assert(output.startsWith(path.join(repository, 'out') + path.sep));
await mkdir(output, { mode: 0o700 });
const opened = await reopenBuildSelection(configuration.build);
const cases = [], identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });
const pipelineReferences = [];
for (const row of opened.actual) {
  const text = lexicalReferenceView((await readRegular(row.filename)).toString());
  const mentions = [...text.matchAll(/\bBrowserCompilerPipeline\b/g)].length;
  if (mentions) pipelineReferences.push({ path: row.path, mentions,
    classDeclaration: /\bclass\s+BrowserCompilerPipeline\s*\(/.test(text) });
}
assert.deepEqual(pipelineReferences, [{ path: ENTRY, mentions: 1, classDeclaration: true }],
  'Review every actual pipeline caller when adding the required host argument');
async function reject(name, reason, action) {
  let failure;
  try { await action(); } catch (error) { failure = error; }
  assert(failure && failure.code === 'ERR_ASSERTION', name + ': expected the semantic guard');
  assert(!/ENOENT|EEXIST/.test(failure.message), name + ': filesystem failure is not rejection evidence');
  assert(reason.test(failure.message), name + ': ' + failure.message.slice(0, 300));
  cases.push({ name, rejected: true, reasonMatched: true, expected: String(reason),
    error: { name: failure.name, code: failure.code, message: failure.message.slice(0, 2000) } });
}
const final = options => opened.api.verifyCompilerExceptionAttachmentFinalSources({ ...opened.options, ...options });
await reject('receipt digest', /Exception preparation receipt digest changed/,
  () => final({ expectedReceiptSha256: '0'.repeat(64) }));
await reject('inactive compiler input', /Exception selection requires active compiler inputs/,
  () => final({ retainedSources: opened.actual.map((row, index) => index ? row : { ...row, compile: false }) }));
await reject('missing helper', /Exactly two portable exception helpers required/,
  () => final({ retainedSources: opened.actual.filter(row => row.path !== 'compiler-port-exceptions/CompilerExceptionHost.kt') }));
await reject('restored excluded PSI source', /Excluded optional PSI source reintroduced/,
  () => final({ retainedSources: [...opened.actual, opened.receipt.compilerExceptionAttachmentReceipt.excluded[0].before] }));
async function changedBody(name, logical, change, reason) {
  const row = opened.actual.find(row => row.path === logical), original = await readRegular(row.filename);
  const modified = Buffer.from(change(original.toString()));
  assert.notDeepEqual(modified, original);
  await writeFile(path.join(output, name + '.kt'), modified, { flag: 'wx', mode: 0o600 });
  try {
    await writeFile(row.filename, modified);
    await reject(name, reason, () => final({ retainedSources: opened.actual.map(input => input.path === logical
      ? { ...input, ...identity(modified) } : input) }));
  } finally { await writeFile(row.filename, original); }
}
await changedBody('entry-host-scope-removed', ENTRY,
  source => source.replace('withCompilerExceptionHost(compilerExceptionHost)', 'run'),
  /Complete exception algorithm\/import changed/);
await changedBody('helper-restoration-removed', 'compiler-port-exceptions/CompilerExceptionHost.kt',
  source => source.replace('installedCompilerExceptionHost = previous', 'installedCompilerExceptionHost = host'),
  /Portable exception helper algorithm changed/);
const selected = opened.actual.find(row => row.path === ENTRY);
const alias = path.join(configuration.build.buildRoot, 'negative-proof-wrong-owner.kt');
await copyFile(selected.filename, alias);
await reject('byte-identical wrong owner', /Exception canonical output owner\/metadata changed/,
  () => final({ retainedSources: opened.actual.map(row => row.path === ENTRY ? { ...row, filename: alias } : row) }));
const restored = await final({});
assert.deepEqual(restored.receipt, opened.reopened.receipt);
for (const row of opened.actual) assert.deepEqual(identity(await readRegular(row.filename)), { bytes: row.bytes, sha256: row.sha256 });
await writeJson(path.join(output, 'guards.json'), { kind: 'compiler-exception-current-source-guards', cases,
  actualSources: opened.actual.length, pipelineReferences, restoredSourceState: true, fullCompilerBuilt: false });
console.log(JSON.stringify({ status: 'passed', guards: cases.length, actualSources: opened.actual.length }));

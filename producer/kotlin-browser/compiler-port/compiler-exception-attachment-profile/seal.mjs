import assert from 'node:assert/strict';
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { compareDiagnostics } from './diagnostics.mjs';
import { reopenBuildSelection } from './verify.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
assert(process.argv[2], 'Usage: seal.mjs CONFIGURATION_JSON');
const configuration = JSON.parse(await readRegular(path.resolve(process.argv[2])));
async function pin(filename, maximum = 96 * 1024 * 1024) {
  const bytes = await readRegular(path.resolve(filename), maximum);
  return { filename: path.resolve(filename), bytes: bytes.length, sha256: sha256(bytes) };
}
const job = JSON.parse(await readRegular(configuration.buildJob));
const status = JSON.parse(await readRegular(job.status));
assert.equal(status.state, 'exited');
const buildRoot = job.argv[job.argv.indexOf('--output') + 1];
const snapshotRoot = status.sourceRoot;
const blockedJob = JSON.parse(await readRegular(configuration.currentFoundationJob));
const blockedState = JSON.parse(await readRegular(blockedJob.status));
const blockedRoot = blockedJob.argv[blockedJob.argv.indexOf('--output') + 1];
const build = { buildRoot, snapshotRoot, receipt: await pin(path.join(buildRoot, 'compiler-build-receipt.json')),
  log: await pin(job.log), status: await pin(job.status), baselineVariant: await pin(job.projection),
  currentFoundationFailure: { buildRoot: blockedRoot, snapshotRoot: blockedState.sourceRoot,
    receipt: await pin(path.join(blockedRoot, 'compiler-build-receipt.json')),
    log: await pin(blockedJob.log), status: await pin(blockedJob.status) } };
const reopenedBuild = await reopenBuildSelection(build);
const receipt = JSON.parse(await readRegular(path.join(buildRoot, 'compiler-build-receipt.json'), 96 * 1024 * 1024));
assert(receipt.commands.some(row => row.phase === 'official-compiler-source-to-wasmjs-klib'));
const guards = JSON.parse(await readRegular(configuration.guards));
assert(guards.cases.length >= 6 && guards.cases.every(row => row.rejected && row.reasonMatched));
assert.equal(guards.restoredSourceState, true);
const runtime = JSON.parse(await readRegular(configuration.runtime));
assert.equal(runtime.status, 'passed');
const browser = JSON.parse(await readRegular(configuration.browser));
assert.equal(browser.status, 'passed');
const baselineEvidence = JSON.parse(await readRegular(path.join(here, '../evidence/compiler-build-failure.json')));
const baselineBuild = path.resolve(configuration.baselineRepository,
  path.dirname(baselineEvidence.sourceBuildReceipt.path));
const baselineReceiptFile = path.join(baselineBuild, 'compiler-build-receipt.json');
const baselineReceiptBytes = await readRegular(baselineReceiptFile, 96 * 1024 * 1024);
assert.equal(sha256(baselineReceiptBytes),
  baselineEvidence.sourceBuildReceipt.sha256);
assert.deepEqual(reopenedBuild.reopened.predecessorRetainedSources.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
  JSON.parse(baselineReceiptBytes).compileSources,
  'Baseline projection must reconstruct the exact original 3553-source compiler inputs');
assert.equal(sha256(await readRegular(baselineEvidence.executionLog.path, 64 * 1024 * 1024)),
  baselineEvidence.executionLog.sha256);
const diagnostics = await compareDiagnostics(buildRoot, job.log, baselineBuild, baselineEvidence.executionLog.path);
assert.equal(diagnostics.baselineTotal, baselineEvidence.diagnostics.emittedErrorEntries,
  'The parser must recover every error from the authenticated historical invocation');
assert.equal(diagnostics.baselineProfileEntries.length, 74,
  'The baseline comparison must include the known exception diagnostics');
assert.equal(diagnostics.newProfileDiagnosticEntries.length, 0,
  'Resolve new exception/entry errors before sealing this profile');
assert.equal(diagnostics.newOtherDiagnosticEntries.length, 0,
  'New diagnostics outside this profile require investigation before sealing');
await writeJson(configuration.diagnosticsOutput, diagnostics);
const shippingInputs = [];
for (const name of (await readdir(here)).sort()) {
  if (/\.(?:mjs|kt|json|md)$/.test(name)) shippingInputs.push(await pin(path.join(here, name)));
}
const archivedSnapshots = [];
for (const filename of configuration.archives) {
  const descriptor = JSON.parse(await readRegular(filename));
  const archive = await pin(descriptor.filename, 512 * 1024 * 1024);
  assert.equal(archive.sha256, descriptor.sha256);
  assert.equal(archive.bytes, descriptor.bytes);
  assert.equal(descriptor.archiveIntegrityChecked, true);
  archivedSnapshots.push({ sourceRoot: descriptor.sourceRoot, descriptor: await pin(filename), archive });
}
assert.deepEqual(archivedSnapshots.map(row => row.sourceRoot).sort(), [snapshotRoot, blockedState.sourceRoot].sort());
await writeJson(path.resolve(configuration.evidenceOutput ?? path.join(here, 'evidence/selection.json')), {
  schemaVersion: 1, kind: 'compiler-exception-attachment-baseline-evidence-v3', result: 'pass',
  sourceLock: await pin(path.join(here, 'sources.lock.json')), shippingInputs,
  build, baselineSelection: await pin(baselineReceiptFile), currentFoundationQualified: false,
  archivedSnapshots,
  runtime: await pin(configuration.runtime), browser: await pin(configuration.browser),
  guards: await pin(configuration.guards), diagnostics: await pin(configuration.diagnosticsOutput),
  claims: { exactUpstreamBodyReplacements: 5, requestEntryHostBinding: 1, psiSourceExclusions: 2,
    typedHelpers: 2, sourceInputs: receipt.compileSources.length,
    realCompilerInvocationExitCode: receipt.commands.find(row => row.phase === 'official-compiler-source-to-wasmjs-klib').exitCode,
    requestScopedHostContractExecuted: true, concreteBrowserFatalTaxonomySupplied: false },
  fullCompilerBuilt: false, browserCompilerExecuted: false,
  limits: ['Actual 3553-source compiler invocation validates baseline 4b6f787 plus this exception delta only.',
    'Current foundation 31b83cf stops at a prior FIR storage closure guard before this profile or the compiler runs; this is a draft PR.',
    'The validation-only inverse removes eighteen signature sources; the shipping recipe retains them unchanged.',
    'Caller-supplied classification and external decoding remain required; no default policy is invented.',
    'Chromium runs the actual compiled component modules, not a complete compiler.',
    'Whole compiler failures outside this profile remain independent blockers.'],
});
console.log(JSON.stringify({ status: 'sealed', sourceInputs: receipt.compileSources.length,
  remainingProfileDiagnostics: diagnostics.currentProfileEntries.length, newProfileDiagnostics: 0,
  fullCompilerBuilt: false }));

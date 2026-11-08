import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256 } from '../../scripts/source.mjs';
import { verifyTowerPredecessor } from './prepare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });
const checked = (bytes, pin) => { assert.deepEqual(identity(bytes), { bytes: pin.bytes, sha256: pin.sha256 }); return bytes; };

// Only the actual qualified 1250-diagnostic invocation is the predecessor.
// This is a source-composition fixture, not a working browser compiler.
export async function readQualifiedTowerPredecessor(buildRoot) {
  const qualificationBytes = await readRegular(path.join(here, '../fir-tower-mode-map/evidence/current-foundation-v1.json'));
  const qualification = JSON.parse(qualificationBytes);
  assert.equal(qualification.kind, 'fir-tower-private-mode-map-current-foundation-v1');
  assert.equal(qualification.result, 'pass');
  buildRoot = path.resolve(buildRoot ?? process.env.OFFICIAL_MAIN_BASELINE_BUILD ?? qualification.build.buildRoot);
  assert.equal(buildRoot, qualification.build.buildRoot, 'Use the exact restored qualified tower build owner');
  const bytes = checked(await readRegular(path.join(buildRoot, 'compiler-build-receipt.json'), 128 * 1024 * 1024), qualification.build.receipt);
  const receipt = JSON.parse(bytes);
  const diagnosticBytes = checked(await readRegular(qualification.diagnostics.filename, 8 * 1024 * 1024), qualification.diagnostics);
  const diagnostics = JSON.parse(diagnosticBytes);
  assert.equal(diagnostics.kind, 'fir-tower-mode-map-exact-diagnostic-comparison');
  assert.equal(diagnostics.result, 'pass'); assert.equal(diagnostics.currentBuild, buildRoot);
  assert.equal(diagnostics.currentTotal, 1250); assert.deepEqual(diagnostics.currentProfileEntries, []);
  assert.deepEqual(diagnostics.diagnosticWaivers, []); assert.deepEqual(diagnostics.buildReceipts.current, identity(bytes));
  const argsBytes = await readRegular(path.join(buildRoot, 'compiler-klib.args'), 16 * 1024 * 1024);
  const command = receipt.commands.find(row => row.phase === 'official-compiler-source-to-wasmjs-klib');
  assert.equal(command.exitCode, 1); assert.equal(command.signal, null);
  assert.equal(command.argumentFileSha256, sha256(argsBytes));
  const component = receipt.firTowerModeMapReceipt;
  assert.deepEqual(component.addedSources, []); assert.deepEqual(component.sourceSetExclusions, []);
  const replacements = new Map(component.files.map(row => [row.before.path, row.after]));
  const retainedSources = component.selection.sources.map(row => structuredClone(replacements.get(row.path) ?? row));
  assert.equal(retainedSources.length, 3571);
  assert.deepEqual(retainedSources.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })), receipt.compileSources);
  const args = argsBytes.toString().trimEnd().split('\n').map(JSON.parse);
  assert.deepEqual(retainedSources.map(row => row.filename), args.slice(-3571));
  assert.equal(args.filter(arg => arg.startsWith('-Xcommon-sources=')).length, 1);
  assert.equal(args.find(arg => arg.startsWith('-Xcommon-sources=')), '-Xcommon-sources=' + retainedSources.map(row => row.filename).join(','));
  assert.equal(receipt.jvmDescriptorSignatureImplementationsReceipt.files.length, 18);
  assert.equal(retainedSources.filter(row => row.path.startsWith('compiler-port-jvm-descriptor-signatures/')).length, 18);
  const outputRoot = path.join(buildRoot, 'components/firTowerModeMapReceipt');
  const componentBytes = await readRegular(path.join(outputRoot, 'receipt.json'), 32 * 1024 * 1024);
  assert.deepEqual(JSON.parse(componentBytes), component);
  const preparedTowerModeMapProfile = { sourceRoot: component.sourceRoot, outputRoot, expectedReceiptSha256: sha256(componentBytes) };
  const verified = await verifyTowerPredecessor({ ...preparedTowerModeMapProfile, retainedSources,
    recordedPropertyImports: receipt.propertyImports.imports, towerSourceLockSha256: component.sourceLockSha256 });
  assert.deepEqual(verified.finalReceipt, receipt.firTowerModeMapFinalReceipt);
  return { buildRoot, receipt, retainedSources, sourceRoot: component.sourceRoot,
    recordedPropertyImports: receipt.propertyImports.imports, preparedTowerModeMapProfile,
    identities: { actualBuildReceipt: identity(bytes), actualArguments: identity(argsBytes),
      actualDiagnostics: identity(diagnosticBytes), qualifiedEvidence: identity(qualificationBytes) } };
}

export async function actualPredecessor(buildRoot) {
  const selected = JSON.parse(await readRegular(path.join(here, 'selection.lock.json')));
  const result = await readQualifiedTowerPredecessor(buildRoot);
  for (const key of ['actualBuildReceipt', 'actualArguments', 'actualDiagnostics', 'qualifiedEvidence']) {
    assert.deepEqual(result.identities[key], selected[key]);
  }
  assert.deepEqual(result.retainedSources.map(({ path: logical, filename, bytes, sha256, compile }) => ({
    path: logical, ownerRelative: path.relative(result.buildRoot, filename), bytes, sha256, compile,
  })), selected.rows);
  return result;
}

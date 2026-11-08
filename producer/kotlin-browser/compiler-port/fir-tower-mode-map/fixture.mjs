import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256 } from '../../scripts/source.mjs';
import { verifyPsiPredecessor } from './prepare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });

// Read the actual post-PSI compiler invocation, not the older pre-PSI fixture.
// This also serves recipe regeneration; it authenticates qualified evidence
// before reading source owners or invoking the previous unchanged verifier.
export async function readQualifiedPsiPredecessor(buildRoot) {
  const qualificationBytes = await readRegular(path.join(here, '../fir-lighttree-psi-views/evidence/current-foundation-v1.json'));
  const qualification = JSON.parse(qualificationBytes);
  assert.equal(qualification.result, 'pass');
  buildRoot = path.resolve(buildRoot ?? process.env.FIR_TOWER_BASELINE_BUILD ?? qualification.build.buildRoot);
  assert.equal(buildRoot, qualification.build.buildRoot, 'Use the exact restored qualified PSI build owner');
  const bytes = await readRegular(path.join(buildRoot, 'compiler-build-receipt.json'), 96 * 1024 * 1024), receipt = JSON.parse(bytes);
  assert.deepEqual(identity(bytes), { bytes: qualification.build.receipt.bytes, sha256: qualification.build.receipt.sha256 });
  const argsBytes = await readRegular(path.join(buildRoot, 'compiler-klib.args'), 16 * 1024 * 1024);
  const command = receipt.commands.find(row => row.phase === 'official-compiler-source-to-wasmjs-klib');
  assert.equal(command.exitCode, 1); assert.equal(command.signal, null);
  assert.equal(command.argumentFileSha256, sha256(argsBytes));
  const component = receipt.firLightTreePsiViewsReceipt;
  assert.deepEqual(component.addedSources, []); assert.deepEqual(component.sourceSetExclusions, []);
  const replacements = new Map(component.files.map(row => [row.before.path, row.after]));
  const retainedSources = component.selection.sources.map(row => structuredClone(replacements.get(row.path) ?? row));
  assert.equal(retainedSources.length, 3571);
  assert.deepEqual(retainedSources.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })), receipt.compileSources);
  assert.deepEqual(retainedSources.map(row => row.filename), argsBytes.toString().trimEnd().split('\n').map(JSON.parse).slice(-3571));
  assert.equal(receipt.jvmDescriptorSignatureImplementationsReceipt.files.length, 18);
  assert.equal(retainedSources.filter(row => row.path.startsWith('compiler-port-jvm-descriptor-signatures/')).length, 18);
  const outputRoot = path.join(buildRoot, 'components/firLightTreePsiViewsReceipt');
  const componentBytes = await readRegular(path.join(outputRoot, 'receipt.json'), 32 * 1024 * 1024);
  assert.deepEqual(JSON.parse(componentBytes), component);
  const preparedPsiViewsProfile = { sourceRoot: component.sourceRoot, outputRoot, expectedReceiptSha256: sha256(componentBytes) };
  const verified = await verifyPsiPredecessor({ ...preparedPsiViewsProfile, retainedSources,
    recordedPropertyImports: receipt.propertyImports.imports, psiSourceLockSha256: component.sourceLockSha256 });
  assert.deepEqual(verified.finalReceipt, receipt.firLightTreePsiViewsFinalReceipt);
  return { buildRoot, receipt, retainedSources, sourceRoot: component.sourceRoot,
    recordedPropertyImports: receipt.propertyImports.imports, preparedPsiViewsProfile,
    identities: { actualBuildReceipt: identity(bytes), actualArguments: identity(argsBytes), qualifiedEvidence: identity(qualificationBytes) } };
}

export async function actualPredecessor(buildRoot) {
  const selected = JSON.parse(await readRegular(path.join(here, 'selection.lock.json')));
  const result = await readQualifiedPsiPredecessor(buildRoot);
  for (const key of ['actualBuildReceipt', 'actualArguments', 'qualifiedEvidence']) assert.deepEqual(result.identities[key], selected[key]);
  assert.deepEqual(result.retainedSources.map(({ path: logical, filename, bytes, sha256, compile }) => ({
    path: logical, ownerRelative: path.relative(result.buildRoot, filename), bytes, sha256, compile,
  })), selected.rows);
  return result;
}

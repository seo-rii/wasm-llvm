import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256 } from '../../scripts/source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export async function actualPredecessor(buildRoot) {
  const selected = JSON.parse(await readRegular(path.join(here, 'selection.lock.json')));
  const qualification = JSON.parse(await readRegular(path.join(here, '../compiler-exception-attachment-profile/evidence/current-foundation-v4.json')));
  buildRoot = path.resolve(buildRoot ?? process.env.FIR_PSI_BASELINE_BUILD ?? qualification.build.buildRoot);
  const bytes = await readRegular(path.join(buildRoot, 'compiler-build-receipt.json'), 96 * 1024 * 1024), receipt = JSON.parse(bytes);
  assert.deepEqual({ bytes: bytes.length, sha256: sha256(bytes) }, selected.actualBuildReceipt);
  const argsBytes = await readRegular(path.join(buildRoot, 'compiler-klib.args'), 16 * 1024 * 1024);
  assert.deepEqual({ bytes: argsBytes.length, sha256: sha256(argsBytes) }, selected.actualArguments);
  const command = receipt.commands.find(row => row.phase === 'official-compiler-source-to-wasmjs-klib');
  assert.equal(command.exitCode, 1); assert.equal(command.signal, null);
  assert.equal(command.argumentFileSha256, sha256(argsBytes));
  const component = receipt.compilerExceptionAttachmentReceipt;
  const replacements = new Map(component.files.map(row => [row.before.path, row.after]));
  const retainedSources = component.selection.sources.filter(row => !component.sourceSetExclusions.includes(row.path))
    .map(row => structuredClone(replacements.get(row.path) ?? row)).concat(structuredClone(component.helpers));
  assert.equal(retainedSources.length, 3571);
  assert.deepEqual(retainedSources.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })), receipt.compileSources);
  assert.deepEqual(retainedSources.map(row => row.filename), argsBytes.toString().trimEnd().split('\n').map(JSON.parse).slice(-3571));
  const outputRoot = path.join(buildRoot, 'components/compilerExceptionAttachmentReceipt');
  const componentBytes = await readRegular(path.join(outputRoot, 'receipt.json'), 64 * 1024 * 1024);
  assert.deepEqual(JSON.parse(componentBytes), component);
  return { buildRoot, receipt, retainedSources, sourceRoot: component.sourceRoot,
    recordedPropertyImports: receipt.propertyImports.imports,
    preparedExceptionProfile: { outputRoot, expectedReceiptSha256: sha256(componentBytes) } };
}

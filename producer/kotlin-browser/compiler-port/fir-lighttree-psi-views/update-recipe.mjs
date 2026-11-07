import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256, gitBlob, verifyFile } from '../../scripts/source.mjs';
import { normalizeImports } from '../klib-signature-index/transform.mjs';
import { transform, exceptionChanges } from '../compiler-exception-attachment-profile/transform.mjs';
import { lexicalReferenceView } from '../native-js-output-profile/references.mjs';
import { TARGETS, UTILS, RECIPE, transformPsiViews } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..');
assert(process.argv[2], 'Pass the actual qualified 3571-source predecessor build root');
const buildRoot = path.resolve(process.argv[2]), sourceRoot = path.join(repository, 'out/kotlin-compiler-port/sources');
const identity = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });
const primaryBytes = await readRegular(path.join(here, '../closure.lock.json')), primary = JSON.parse(primaryBytes);
const receiptBytes = await readRegular(path.join(buildRoot, 'compiler-build-receipt.json'), 96 * 1024 * 1024), receipt = JSON.parse(receiptBytes);
const qualificationBytes = await readRegular(path.join(here, '../compiler-exception-attachment-profile/evidence/current-foundation-v4.json'));
const qualification = JSON.parse(qualificationBytes);
assert.equal(qualification.currentFoundationQualified, true); assert.equal(qualification.result, 'pass');
assert.deepEqual(identity(receiptBytes), { bytes: qualification.build.receipt.bytes, sha256: qualification.build.receipt.sha256 });
assert.deepEqual(receipt.source, primary.source);
const command = receipt.commands.find(row => row.phase === 'official-compiler-source-to-wasmjs-klib');
assert.equal(command.exitCode, 1); assert.equal(command.signal, null);
const argsBytes = await readRegular(path.join(buildRoot, 'compiler-klib.args'), 16 * 1024 * 1024);
assert.equal(sha256(argsBytes), command.argumentFileSha256);
const args = argsBytes.toString().trimEnd().split('\n').map(JSON.parse);
const component = receipt.compilerExceptionAttachmentReceipt;
const replacements = new Map(component.files.map(row => [row.before.path, row.after]));
const rows = component.selection.sources.filter(row => !component.sourceSetExclusions.includes(row.path))
  .map(row => replacements.get(row.path) ?? row).concat(component.helpers);
assert.equal(rows.length, 3571);
assert.deepEqual(rows.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })), receipt.compileSources);
assert.deepEqual(rows.map(row => row.filename), args.slice(-rows.length));
assert.equal(receipt.jvmDescriptorSignatureImplementationsReceipt.files.length, 18);
const imports = receipt.propertyImports.imports, viewReferences = { before: [], after: [] }, assembledOutputs = [];
const canonical = new Map();
for (const row of rows) {
  assert.deepEqual(Object.keys(row), ['path', 'filename', 'bytes', 'sha256', 'compile']);
  const bytes = await readRegular(row.filename); assert.deepEqual(identity(bytes), { bytes: row.bytes, sha256: row.sha256 });
  canonical.set(row.path, normalizeImports(bytes, imports));
  const after = TARGETS.includes(row.path) ? transformPsiViews(row.path, bytes) : bytes;
  if (TARGETS.includes(row.path)) assembledOutputs.push({ path: row.path, ...identity(after) });
  for (const [phase, value] of [['before', bytes], ['after', after]]) {
    const view = lexicalReferenceView(value.toString());
    const names = ['psi', 'realPsi', 'MetadataSource', 'isCompiledElement', 'sourceFileLinesMapping', 'KtPsiSourceFileLinesMapping']
      .filter(name => new RegExp('\\b' + name + '\\b').test(view));
    if (names.length) viewReferences[phase].push({ path: row.path, names });
  }
}
const selection = { schemaVersion: 1, kind: 'actual-current-foundation-fir-psi-selection', source: primary.source,
  compilerExitCode: command.exitCode, currentFoundationQualified: true,
  actualBuildReceipt: identity(receiptBytes), actualArguments: identity(argsBytes), qualifiedEvidence: identity(qualificationBytes),
  jvmSignatureSources: 18, rows: rows.map(({ filename, ...row }) => {
    const ownerRelative = path.relative(buildRoot, filename);
    assert(!ownerRelative.startsWith('..') && !path.isAbsolute(ownerRelative));
    return { path: row.path, ownerRelative, bytes: row.bytes, sha256: row.sha256, compile: row.compile };
  }) };
await writeFile(path.join(here, 'selection.lock.json'), JSON.stringify(selection, null, 2) + '\n');
const targets = TARGETS.map(logical => primary.files.find(row => row.path === logical)), incoming = [], outgoing = [];
for (const pin of targets) {
  const original = verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin);
  const before = pin.path === UTILS ? transform(original, exceptionChanges(pin.path, original)) : original;
  assert.deepEqual(before, canonical.get(pin.path), 'Authentic assembled predecessor differs from original plus exact previous exception delta');
  const after = transformPsiViews(pin.path, before);
  assert.deepEqual(transformPsiViews(pin.path, after, { reverse: true }), before);
  incoming.push({ path: pin.path, ...identity(before) }); outgoing.push({ path: pin.path, ...identity(after) });
}
const portableBindings = [
  { path: 'compiler-port-host/PortableLightTree.kt', receiptRelative: 'components/sourceHostReceipt/compiler-port-host/host-receipt.json',
    outputField: 'sources', sourceLockSha256: receipt.sourceHostReceipt.sourceLockSha256 },
  { path: 'compiler-port-positioning/TokenSet.kt', receiptRelative: 'components/firNavigationReceipt/fir-navigation-inputs.json',
    outputField: 'files', sourceLockSha256: receipt.firNavigationReceipt.sourceLockSha256 },
].map(row => ({ ...row, ...identity(canonical.get(row.path)) }));
async function pin(name) { const bytes = await readRegular(path.join(here, name)); return { path: name, ...identity(bytes), gitBlob: gitBlob(bytes) }; }
const dependencies = await Promise.all([
  'prepare.mjs', 'transform.mjs', 'update-recipe.mjs', 'selection.lock.json', '../../scripts/source.mjs', '../closure.lock.json',
  '../klib-signature-index/transform.mjs', '../compiler-exception-attachment-profile/transform.mjs',
  '../compiler-exception-attachment-profile/prepare.mjs', '../compiler-exception-attachment-profile/sources.lock.json',
  '../native-js-output-profile/references.mjs', '../host/prepare.mjs', '../host/sources.lock.json', '../host/PortableLightTree.kt',
  '../positioning/prepare.mjs', '../positioning/positioning.recipe.json', '../positioning/TokenSet.kt',
  '../fir-navigation/prepare.mjs', '../fir-navigation/transform.mjs', '../fir-navigation/sources.lock.json',
].map(pin));
const lock = { schemaVersion: 1, kind: 'sealed-lighttree-fir-psi-views', source: primary.source,
  primaryClosureSha256: sha256(primaryBytes), targets, recipes: RECIPE, incoming, outgoing, assembledOutputs,
  selection: await pin('selection.lock.json'), recordedPropertyImports: imports, viewReferences, portableBindings,
  exceptionSourceLockSha256: component.sourceLockSha256, dependencies,
  scope: 'Exact five source algorithms in the complete actual sealed LightTree-only source selection; method-boundary runtime agreement only',
  fullFirToIrWasmExecuted: false, fullCompilerBuilt: false, publicLanguageSupport: false };
await writeFile(path.join(here, 'sources.lock.json'), JSON.stringify(lock, null, 2) + '\n');
console.log(JSON.stringify({ sourceFiles: rows.length, targets: targets.length, portableBindings: portableBindings.length,
  referenceOwners: viewReferences.before.length, predecessorReceiptSha256: sha256(receiptBytes) }));

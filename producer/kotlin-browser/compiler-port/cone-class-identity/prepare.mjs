import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, json, readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { CONE_PATH, FINAL_CLASSES, transformConeClassIdentity } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..');
const filesPin = (relative, bytes) => ({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });

async function inputs(sourceRoot, preparedIdentity) {
    sourceRoot = path.resolve(sourceRoot); await assertNoSymlink(sourceRoot);
    const lockBytes = await readRegular(path.join(here, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'official-final-cone-class-identity-port');
    assert.equal(lock.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
    assert.deepEqual(lock.boundaries.map(pin => pin.className), FINAL_CLASSES);
    assert.equal(sha256(await readRegular(path.join(here, 'transform.mjs'))), lock.transformSha256);
    for (const [filename, hash] of Object.entries(lock.predecessor.tools))
        assert.equal(sha256(await readRegular(path.join(here, filename))), hash, 'Identity predecessor recipe changed: ' + filename);
    const originals = new Map();
    for (const pin of lock.sources) originals.set(pin.path, verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin));
    assert(preparedIdentity?.receiptPath && preparedIdentity.commonSources && preparedIdentity.receipt, 'Genuine prepared identity predecessor required');
    const receiptBytes = await readRegular(preparedIdentity.receiptPath), predecessorReceipt = JSON.parse(receiptBytes);
    assert.deepEqual(predecessorReceipt, preparedIdentity.receipt, 'Identity receipt object changed');
    assert.equal(predecessorReceipt.kind, 'official-reference-identity-common-source-preparation');
    assert.deepEqual(predecessorReceipt.source, lock.source);
    assert.equal(predecessorReceipt.sourceLockSha256, lock.predecessor.tools['../identity/sources.lock.json']);
    assert.equal(predecessorReceipt.preparationToolSha256, lock.predecessor.tools['../identity/prepare.mjs']);
    const declared = predecessorReceipt.files.filter(pin => pin.path === CONE_PATH);
    assert.equal(declared.length, 1); assert.deepEqual(declared[0], { path: CONE_PATH,
        bytes: lock.predecessor.bytes, sha256: lock.predecessor.sha256, originalSha256: lock.sources[0].sha256 });
    const matches = preparedIdentity.commonSources.filter(filename => path.resolve(filename).endsWith(path.sep + CONE_PATH));
    assert.equal(matches.length, 1); const filename = path.resolve(matches[0]);
    assert(filename.startsWith(path.join(repository, 'out') + path.sep), 'Prepared identity filename must stay under out/');
    const predecessor = await readRegular(filename);
    assert.equal(predecessor.length, lock.predecessor.bytes); assert.equal(sha256(predecessor), lock.predecessor.sha256);
    const binding = { component: 'identityReceipt', logicalPath: CONE_PATH, componentRelativePath: CONE_PATH, filename,
        bytes: predecessor.length, sha256: sha256(predecessor), receiptSha256: sha256(receiptBytes),
        sourceLockSha256: predecessorReceipt.sourceLockSha256, preparationToolSha256: predecessorReceipt.preparationToolSha256 };
    return { sourceRoot, lockBytes, lock, originals, predecessor, binding };
}

function receiptFor(input, transformed, sourceFiles) {
    return { schemaVersion: 1, kind: 'official-final-cone-class-identity-preparation', source: input.lock.source,
        sourceLockSha256: sha256(input.lockBytes), preparationToolSha256: input.prepareToolSha256,
        transformSha256: input.lock.transformSha256, sourceFiles: input.lock.sources, referenceFiles: sourceFiles,
        predecessorBindings: [input.binding], files: [{ path: CONE_PATH, ...input.lock.output,
            originalSha256: input.lock.sources[0].sha256, predecessorSha256: sha256(input.predecessor) }],
        replacedOriginalPaths: [CONE_PATH], changes: transformed.changes,
        finalClasses: FINAL_CLASSES, strictClassGuardPreserved: true, retainedPredecessorChanges: true,
        unchangedOutsideThreeGuards: true, runtimeReflectionIntroduced: false, originalSourceUnmodified: true,
        sourceProjectionInShipping: false, fullConeWasmRuntime: false, fullCompilerBuilt: false, publicLanguageSupport: false };
}

export async function prepareConeClassIdentitySources({ sourceRoot, outputRoot, preparedIdentity }) {
    outputRoot = path.resolve(outputRoot); sourceRoot = path.resolve(sourceRoot);
    assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep));
    const predecessorFile = preparedIdentity?.commonSources?.find(file => file.endsWith('/' + CONE_PATH));
    const predecessorRoot = predecessorFile && predecessorFile.slice(0, -CONE_PATH.length - 1);
    for (const root of [sourceRoot, predecessorRoot].filter(Boolean))
        assert(root !== outputRoot && !root.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(root + path.sep), 'Input/output overlap');
    const input = await inputs(sourceRoot, preparedIdentity);
    input.prepareToolSha256 = sha256(await readRegular(fileURLToPath(import.meta.url)));
    const transformed = transformConeClassIdentity(input.predecessor, input.lock);
    await assertNoSymlink(outputRoot); await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    const sourceFiles = [];
    async function publish(relative, bytes) {
        const filename = path.join(outputRoot, relative); await assertNoSymlink(filename);
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
        sourceFiles.push(filesPin(relative, bytes)); return filename;
    }
    for (const [relative, bytes] of input.originals) await publish('reference/' + relative, bytes);
    await publish('predecessor/' + CONE_PATH, input.predecessor);
    await publish('predecessor/identity-inputs.json', await readRegular(preparedIdentity.receiptPath));
    await publish('predecessor/binding.json', Buffer.from(json(input.binding)));
    const filename = await publish(CONE_PATH, transformed.bytes);
    const receipt = receiptFor(input, transformed, sourceFiles.filter(pin => pin.path !== CONE_PATH));
    const receiptPath = path.join(outputRoot, 'cone-class-identity-inputs.json'); await writeJson(receiptPath, receipt);
    return { outputRoot, commonSources: [filename], replacedOriginalPaths: [CONE_PATH], predecessorBindings: [input.binding], receipt, receiptPath };
}

export async function verifyConeClassIdentity(root) {
    root = path.resolve(root); assert(root.startsWith(path.join(repository, 'out') + path.sep)); await assertNoSymlink(root);
    const receiptBytes = await readRegular(path.join(root, 'cone-class-identity-inputs.json')), receipt = JSON.parse(receiptBytes);
    const input = await inputs(path.join(root, 'reference'), {
        receiptPath: path.join(root, 'predecessor/identity-inputs.json'),
        commonSources: [path.join(root, 'predecessor', CONE_PATH)],
        receipt: JSON.parse(await readRegular(path.join(root, 'predecessor/identity-inputs.json'))),
    });
    // Preserve provenance in a separately bound immutable input, rather than trusting the receipt's filename.
    const bindingBytes = await readRegular(path.join(root, 'predecessor/binding.json')), binding = JSON.parse(bindingBytes);
    assert.equal(typeof binding.filename, 'string'); assert(path.isAbsolute(binding.filename));
    assert(binding.filename.startsWith(path.join(repository, 'out') + path.sep) && binding.filename.endsWith('/' + CONE_PATH));
    input.binding.filename = binding.filename; assert.deepEqual(binding, input.binding);
    assert.deepEqual(bindingBytes, Buffer.from(json(binding)));
    input.prepareToolSha256 = sha256(await readRegular(fileURLToPath(import.meta.url)));
    const expectedReference = [...input.originals].map(([p, b]) => filesPin('reference/' + p, b));
    expectedReference.push(filesPin('predecessor/' + CONE_PATH, input.predecessor), filesPin('predecessor/identity-inputs.json', await readRegular(path.join(root, 'predecessor/identity-inputs.json'))));
    expectedReference.push(filesPin('predecessor/binding.json', bindingBytes));
    assert.deepEqual(receipt.referenceFiles, expectedReference);
    const transformed = transformConeClassIdentity(input.predecessor, input.lock);
    assert.deepEqual(await readRegular(path.join(root, CONE_PATH)), transformed.bytes);
    assert.deepEqual(receipt, receiptFor(input, transformed, expectedReference));
    return { receipt, receiptSha256: sha256(receiptBytes) };
}

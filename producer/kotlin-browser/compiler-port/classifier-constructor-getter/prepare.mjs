import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, json, readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { CONSTRUCTOR_PATH, CONTRACT_PATH, OWN_BINDINGS, transformClassifierConstructorGetter } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..');
const pin = (relative, bytes) => ({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });

async function inputs(sourceRoot, preparedIdentity) {
    sourceRoot = path.resolve(sourceRoot); await assertNoSymlink(sourceRoot);
    const lockBytes = await readRegular(path.join(here, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'official-classifier-constructor-covariant-getter-port');
    assert.equal(lock.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
    assert.deepEqual(lock.sources.map(item => item.path), [CONSTRUCTOR_PATH, CONTRACT_PATH]);
    assert.deepEqual(lock.changes.map(item => item.variable), OWN_BINDINGS);
    assert.equal(sha256(await readRegular(path.join(here, 'transform.mjs'))), lock.transformSha256);
    for (const [filename, hash] of Object.entries(lock.predecessor.tools))
        assert.equal(sha256(await readRegular(path.join(here, filename))), hash, 'Identity predecessor tool changed: ' + filename);
    const originals = new Map();
    for (const entry of lock.sources) originals.set(entry.path, verifyFile(await readRegular(path.join(sourceRoot, entry.path)), entry));
    assert(originals.get(CONTRACT_PATH).toString().includes('    @Nullable\n    ClassifierDescriptor getDeclarationDescriptor();'));
    assert(originals.get(CONSTRUCTOR_PATH).toString().includes('    abstract override fun getDeclarationDescriptor(): ClassifierDescriptor\n'));
    assert(preparedIdentity?.receiptPath && preparedIdentity.receipt && preparedIdentity.commonSources, 'Genuine identity predecessor required');
    const receiptBytes = await readRegular(preparedIdentity.receiptPath), receipt = JSON.parse(receiptBytes);
    assert.deepEqual(receipt, preparedIdentity.receipt); assert.equal(receipt.kind, 'official-reference-identity-common-source-preparation');
    assert.deepEqual(receipt.source, lock.source);
    assert.equal(receipt.sourceLockSha256, lock.predecessor.tools['../identity/sources.lock.json']);
    assert.equal(receipt.preparationToolSha256, lock.predecessor.tools['../identity/prepare.mjs']);
    const declared = receipt.files.filter(item => item.path === CONSTRUCTOR_PATH); assert.equal(declared.length, 1);
    assert.deepEqual(declared[0], { path: CONSTRUCTOR_PATH, bytes: lock.predecessor.bytes,
        sha256: lock.predecessor.sha256, originalSha256: lock.sources[0].sha256 });
    const matches = preparedIdentity.commonSources.filter(filename => path.resolve(filename).endsWith('/' + CONSTRUCTOR_PATH)); assert.equal(matches.length, 1);
    const filename = path.resolve(matches[0]); assert(filename.startsWith(path.join(repository, 'out') + path.sep));
    const predecessor = await readRegular(filename);
    assert.equal(predecessor.length, lock.predecessor.bytes); assert.equal(sha256(predecessor), lock.predecessor.sha256);
    const binding = { component: 'identityReceipt', logicalPath: CONSTRUCTOR_PATH, componentRelativePath: CONSTRUCTOR_PATH,
        filename, bytes: predecessor.length, sha256: sha256(predecessor), receiptSha256: sha256(receiptBytes),
        sourceLockSha256: receipt.sourceLockSha256, preparationToolSha256: receipt.preparationToolSha256 };
    return { lockBytes, lock, originals, predecessor, receiptBytes, binding };
}

function receiptFor(input, transformed, references) {
    return { schemaVersion: 1, kind: 'official-classifier-constructor-covariant-getter-preparation', source: input.lock.source,
        sourceLockSha256: sha256(input.lockBytes), preparationToolSha256: input.prepareSha256, transformSha256: input.lock.transformSha256,
        originalInputs: input.lock.sources, referencePins: references, predecessorBindings: [input.binding],
        files: [{ path: CONSTRUCTOR_PATH, ...input.lock.output }], replacedOriginalPaths: [CONSTRUCTOR_PATH], changes: transformed.changes,
        covariantOwnGetter: 'Original nonnull getDeclarationDescriptor() override', otherReceiverNullable: true,
        unchangedOutsideTwoOwnBindings: true, identityPredecessorChangesRetained: true, sourceProjectionInShipping: false,
        fullClassifierWasmRuntime: false, fullCompilerBuilt: false, publicLanguageSupport: false };
}

export async function prepareClassifierConstructorGetter({ sourceRoot, outputRoot, preparedIdentity }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep));
    const predecessorFile = preparedIdentity?.commonSources?.find(file => file.endsWith('/' + CONSTRUCTOR_PATH));
    const predecessorRoot = predecessorFile && predecessorFile.slice(0, -CONSTRUCTOR_PATH.length - 1);
    for (const root of [sourceRoot, predecessorRoot].filter(Boolean))
        assert(root !== outputRoot && !root.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(root + path.sep), 'Input/output overlap');
    const input = await inputs(sourceRoot, preparedIdentity);
    input.prepareSha256 = sha256(await readRegular(fileURLToPath(import.meta.url)));
    const transformed = transformClassifierConstructorGetter(input.predecessor, input.lock);
    await assertNoSymlink(outputRoot); await mkdir(outputRoot, { recursive: true, mode: 0o700 }); const referencePins = [];
    async function publish(relative, bytes) {
        const filename = path.join(outputRoot, relative); await assertNoSymlink(filename);
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
        referencePins.push(pin(relative, bytes)); return filename;
    }
    for (const [relative, bytes] of input.originals) await publish('reference/' + relative, bytes);
    await publish('predecessor/' + CONSTRUCTOR_PATH, input.predecessor);
    await publish('predecessor/identity-inputs.json', input.receiptBytes);
    await publish('predecessor/binding.json', Buffer.from(json(input.binding)));
    const references = referencePins.slice(), filename = await publish(CONSTRUCTOR_PATH, transformed.bytes);
    const receipt = receiptFor(input, transformed, references), receiptPath = path.join(outputRoot, 'classifier-constructor-getter-inputs.json');
    await writeJson(receiptPath, receipt);
    return { outputRoot, commonSources: [filename], replacedOriginalPaths: [CONSTRUCTOR_PATH], predecessorBindings: [input.binding], receipt, receiptPath };
}

export async function verifyClassifierConstructorGetter(root) {
    root = path.resolve(root); assert(root.startsWith(path.join(repository, 'out') + path.sep)); await assertNoSymlink(root);
    const receiptBytes = await readRegular(path.join(root, 'classifier-constructor-getter-inputs.json')), receipt = JSON.parse(receiptBytes);
    const input = await inputs(path.join(root, 'reference'), { receiptPath: path.join(root, 'predecessor/identity-inputs.json'),
        receipt: JSON.parse(await readRegular(path.join(root, 'predecessor/identity-inputs.json'))),
        commonSources: [path.join(root, 'predecessor', CONSTRUCTOR_PATH)] });
    const bindingBytes = await readRegular(path.join(root, 'predecessor/binding.json')), binding = JSON.parse(bindingBytes);
    assert(path.isAbsolute(binding.filename) && binding.filename.startsWith(path.join(repository, 'out') + path.sep)
        && binding.filename.endsWith('/' + CONSTRUCTOR_PATH));
    input.binding.filename = binding.filename; assert.deepEqual(binding, input.binding); assert.deepEqual(bindingBytes, Buffer.from(json(binding)));
    input.prepareSha256 = sha256(await readRegular(fileURLToPath(import.meta.url)));
    const references = [...input.originals].map(([relative, bytes]) => pin('reference/' + relative, bytes));
    references.push(pin('predecessor/' + CONSTRUCTOR_PATH, input.predecessor), pin('predecessor/identity-inputs.json', input.receiptBytes), pin('predecessor/binding.json', bindingBytes));
    assert.deepEqual(receipt.referencePins, references);
    const transformed = transformClassifierConstructorGetter(input.predecessor, input.lock);
    assert.deepEqual(await readRegular(path.join(root, CONSTRUCTOR_PATH)), transformed.bytes);
    assert.deepEqual(receipt, receiptFor(input, transformed, references));
    return { receipt, receiptSha256: sha256(receiptBytes) };
}

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, json, readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { CONTEXT, FRAGMENT, PATHS, REVERSE_ORIGINAL, transformWasmCollectionConsumer } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..');
const pin = (relative, bytes) => ({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
const matchesPin = (bytes, expected) => { assert.equal(bytes.length, expected.bytes); assert.equal(sha256(bytes), expected.sha256); return bytes; };

async function inputs(sourceRoot, preparedWasmCollections, preparedText) {
    sourceRoot = path.resolve(sourceRoot); await assertNoSymlink(sourceRoot);
    const lockBytes = await readRegular(path.join(here, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'official-selected-wasm-collection-consumer-bindings');
    assert.equal(lock.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
    assert.deepEqual(lock.sources.map(item => item.path), PATHS);
    assert.equal(sha256(await readRegular(path.join(here, 'transform.mjs'))), lock.transformSha256);
    for (const [filename, hash] of Object.entries(lock.dependencyTools))
        assert.equal(sha256(await readRegular(path.join(here, filename))), hash, 'Dependency tool changed: ' + filename);
    const originals = new Map();
    for (const entry of lock.sources) originals.set(entry.path, verifyFile(await readRegular(path.join(sourceRoot, entry.path)), entry));
    const upstream = new Map();
    for (const entry of [lock.reverse.implementation, lock.reverse.versionDeclaration])
        upstream.set(entry.localPath, verifyFile(await readRegular(path.join(here, entry.localPath)), entry));
    assert(upstream.get(lock.reverse.implementation.localPath).toString().includes(REVERSE_ORIGINAL + '\n'));
    assert(upstream.get(lock.reverse.versionDeclaration.localPath).toString().split('\n').includes('versions.intellijSdk=' + lock.reverse.version));
    assert.deepEqual(lock.reverse, { ...lock.reverse, version: '261.24374.151', commit: 'ec406b27dab3ba8b2b15ae5f3155a114573cbab3',
        originalDeclaration: REVERSE_ORIGINAL, selectedDestructuring: 'positional [k, v] under the pinned name-based-destructuring compiler flag' });
    const parentReceipts = new Map(), variants = new Map(), shared = new Map(), predecessorBindings = [], sharedDependencies = [];
    for (const [component, prepared, expected] of [['wasmCollectionsReceipt', preparedWasmCollections, lock.predecessor],
        ['textReceipt', preparedText, lock.text]]) {
        assert(prepared?.receiptPath && prepared.receipt && prepared.commonSources, 'Genuine prepared dependency required: ' + component);
        const receiptBytes = await readRegular(prepared.receiptPath), receipt = JSON.parse(receiptBytes);
        assert.deepEqual(receipt, prepared.receipt); assert.equal(receipt.kind, expected.receiptKind); assert.deepEqual(receipt.source, lock.source);
        assert.equal(receipt.sourceLockSha256, lock.dependencyTools[expected.sourceLockPath]);
        assert.equal(receipt.preparationToolSha256, lock.dependencyTools[expected.prepareToolPath]);
        parentReceipts.set(component, receiptBytes);
        for (const output of expected.outputs) {
            const declared = receipt.files.filter(item => item.path === output.path); assert.equal(declared.length, 1, 'One declared dependency pin required');
            assert.equal(declared[0].bytes, output.bytes); assert.equal(declared[0].sha256, output.sha256);
            const matches = prepared.commonSources.filter(filename => path.resolve(filename).endsWith('/' + output.path));
            assert.equal(matches.length, 1, 'One selected dependency source required');
            const filename = path.resolve(matches[0]); assert(filename.startsWith(path.join(repository, 'out') + path.sep));
            const bytes = matchesPin(await readRegular(filename), output);
            const binding = { component, logicalPath: output.path, componentRelativePath: expected.prefix + output.path,
                filename, bytes: bytes.length, sha256: sha256(bytes), receiptSha256: sha256(receiptBytes),
                sourceLockSha256: receipt.sourceLockSha256, preparationToolSha256: receipt.preparationToolSha256 };
            if (component === 'wasmCollectionsReceipt') {
                assert.equal(declared[0].originalSha256, lock.sources.find(item => item.path === output.path).sha256);
                variants.set(output.path, bytes); predecessorBindings.push(binding);
            } else { shared.set(output.path, bytes); sharedDependencies.push(binding); }
        }
    }
    return { lockBytes, lock, originals, upstream, parentReceipts, variants, shared, predecessorBindings, sharedDependencies };
}

function receiptFor(input, transformed, references) {
    return { schemaVersion: 1, kind: 'official-selected-wasm-collection-consumer-preparation', source: input.lock.source,
        sourceLockSha256: sha256(input.lockBytes), preparationToolSha256: input.prepareSha256, transformSha256: input.lock.transformSha256,
        originals: input.lock.sources, reverseImplementation: input.lock.reverse, referencePins: references,
        predecessorBindings: input.predecessorBindings, sharedDependencies: input.sharedDependencies,
        files: input.lock.outputs, replacedOriginalPaths: PATHS, changes: transformed.map(({ logicalPath, changes }) => ({ path: logicalPath, changes })),
        reverseScope: 'One selected structural function-type snapshot; entry-order last signature wins, rebinding retains winning value identity',
        encodingScope: 'Existing compiler UTF8 String encoder and decoder; the exact nine-byte low-63-bit ASCII loop is unchanged',
        unchangedOutsideSelectedImportsAndCalls: true, predecessorChangesRetained: true, genericReverseFacade: false,
        sharedUtf8SourcesEmittedAgain: false, originalSourceUnmodified: true, fullCompilerBuilt: false, publicLanguageSupport: false };
}

export async function prepareWasmCollectionConsumers({ sourceRoot, outputRoot, preparedWasmCollections, preparedText }) {
    outputRoot = path.resolve(outputRoot); assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep));
    const roots = [path.resolve(sourceRoot), ...[preparedWasmCollections, preparedText].filter(Boolean).map(item => path.dirname(path.resolve(item.receiptPath)))];
    for (const root of roots) assert(root !== outputRoot && !root.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(root + path.sep), 'Input/output overlap');
    const input = await inputs(sourceRoot, preparedWasmCollections, preparedText);
    input.prepareSha256 = sha256(await readRegular(fileURLToPath(import.meta.url)));
    const transformed = PATHS.map(logicalPath => ({ logicalPath, ...transformWasmCollectionConsumer(logicalPath, input.variants.get(logicalPath), input.lock) }));
    await assertNoSymlink(outputRoot); await mkdir(outputRoot, { recursive: true, mode: 0o700 }); const referencePins = [];
    async function publish(relative, bytes) {
        const filename = path.join(outputRoot, relative); await assertNoSymlink(filename); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); referencePins.push(pin(relative, bytes)); return filename;
    }
    for (const [relative, bytes] of input.originals) await publish('reference/' + relative, bytes);
    for (const [relative, bytes] of input.upstream) await publish('reference/' + relative, bytes);
    for (const [component, bytes] of input.parentReceipts) await publish('dependencies/' + component + '/receipt.json', bytes);
    for (const [relative, bytes] of input.variants) await publish('dependencies/wasmCollectionsReceipt/' + relative, bytes);
    for (const [relative, bytes] of input.shared) await publish('dependencies/textReceipt/' + relative, bytes);
    await publish('dependencies/bindings.json', Buffer.from(json({ predecessorBindings: input.predecessorBindings, sharedDependencies: input.sharedDependencies })));
    const references = referencePins.slice(), commonSources = [];
    for (const { logicalPath, bytes } of transformed) commonSources.push(await publish(logicalPath, bytes));
    const receipt = receiptFor(input, transformed, references), receiptPath = path.join(outputRoot, 'wasm-collection-consumers-inputs.json'); await writeJson(receiptPath, receipt);
    return { outputRoot, commonSources, replacedOriginalPaths: PATHS, predecessorBindings: input.predecessorBindings,
        sharedDependencies: input.sharedDependencies, receipt, receiptPath };
}

export async function verifyWasmCollectionConsumers(root) {
    root = path.resolve(root); assert(root.startsWith(path.join(repository, 'out') + path.sep)); await assertNoSymlink(root);
    const receiptBytes = await readRegular(path.join(root, 'wasm-collection-consumers-inputs.json')), receipt = JSON.parse(receiptBytes);
    const dependency = async component => { const receiptPath = path.join(root, 'dependencies', component, 'receipt.json');
        const parent = JSON.parse(await readRegular(receiptPath)), lock = JSON.parse(await readRegular(path.join(here, 'sources.lock.json')));
        const expected = component === 'textReceipt' ? lock.text : lock.predecessor;
        return { receiptPath, receipt: parent, commonSources: expected.outputs.map(item => path.join(root, 'dependencies', component, item.path)) }; };
    const input = await inputs(path.join(root, 'reference'), await dependency('wasmCollectionsReceipt'), await dependency('textReceipt'));
    const bindingBytes = await readRegular(path.join(root, 'dependencies/bindings.json')), bindings = JSON.parse(bindingBytes);
    for (const key of ['predecessorBindings', 'sharedDependencies']) {
        assert.equal(bindings[key].length, input[key].length);
        for (let index = 0; index < input[key].length; index++) {
            const filename = bindings[key][index].filename;
            assert(path.isAbsolute(filename) && filename.startsWith(path.join(repository, 'out') + path.sep) && filename.endsWith('/' + input[key][index].logicalPath));
            input[key][index].filename = filename;
        }
        assert.deepEqual(bindings[key], input[key]);
    }
    assert.deepEqual(bindingBytes, Buffer.from(json(bindings)));
    input.prepareSha256 = sha256(await readRegular(fileURLToPath(import.meta.url)));
    const references = [...input.originals].map(([relative, bytes]) => pin('reference/' + relative, bytes));
    for (const [relative, bytes] of input.upstream) {
        matchesPin(await readRegular(path.join(root, 'reference', relative)), pin(relative, bytes)); references.push(pin('reference/' + relative, bytes));
    }
    for (const [component, bytes] of input.parentReceipts) references.push(pin('dependencies/' + component + '/receipt.json', bytes));
    for (const [relative, bytes] of input.variants) references.push(pin('dependencies/wasmCollectionsReceipt/' + relative, bytes));
    for (const [relative, bytes] of input.shared) references.push(pin('dependencies/textReceipt/' + relative, bytes));
    references.push(pin('dependencies/bindings.json', bindingBytes));
    const transformed = PATHS.map(logicalPath => ({ logicalPath, ...transformWasmCollectionConsumer(logicalPath, input.variants.get(logicalPath), input.lock) }));
    for (const { logicalPath, bytes } of transformed) assert.deepEqual(await readRegular(path.join(root, logicalPath)), bytes, 'Prepared consumer changed');
    assert.deepEqual(receipt, receiptFor(input, transformed, references));
    return { receipt, receiptSha256: sha256(receiptBytes) };
}

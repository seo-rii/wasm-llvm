import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { prepareIdentitySources } from '../identity/prepare.mjs';
import { CONE_PATH, FINAL_CLASSES, projectConeMethods, transformConeClassIdentity } from './transform.mjs';
import { prepareConeClassIdentitySources, verifyConeClassIdentity } from './prepare.mjs';
import { sha256 } from '../../scripts/source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..');
const sourceRoot = path.join(repository, 'out/kotlin-compiler-port/sources');
const lock = JSON.parse(await readFile(path.join(here, 'sources.lock.json')));
async function fixture(run) {
    const root = await mkdtemp(path.join(repository, 'out/cone-class-identity-guards-'));
    try {
        const preparedIdentity = await prepareIdentitySources({ sourceRoot, outputRoot: path.join(root, 'identity') });
        await run({ root, sourceRoot, preparedIdentity, outputRoot: path.join(root, 'common') });
    } finally { await rm(root, { recursive: true, force: true }); }
}

test('full identity predecessor is preserved outside exactly three final type guards', async () => fixture(async options => {
    const prepared = await prepareConeClassIdentitySources(options), checked = await verifyConeClassIdentity(prepared.outputRoot);
    assert.equal(checked.receipt.changes.length, 3); assert.equal(prepared.commonSources.length, 1);
    assert.equal(prepared.predecessorBindings[0].componentRelativePath, CONE_PATH);
    const predecessor = await readFile(prepared.predecessorBindings[0].filename), output = await readFile(prepared.commonSources[0]);
    assert.deepEqual(transformConeClassIdentity(predecessor, lock).bytes, output);
    assert(output.toString().includes('private val identityHashToken = Any()'));
    assert(output.toString().includes('if (other !is ConeFlexibleType) return false'));
    assert(output.toString().includes('if (other !is ConeLookupTagBasedType) return false'));
    assert.equal(projectConeMethods(predecessor, lock, 'original').methods.length, 3);
    assert.equal(projectConeMethods(output, lock, 'common').methods.length, 3);
}));

test('a future open class cannot use this final-class equality proof', async () => fixture(async options => {
    const predecessor = await readFile(options.preparedIdentity.commonSources.find(file => file.endsWith('/' + CONE_PATH)));
    for (const pin of lock.boundaries) {
        const mutated = Buffer.from(predecessor.toString().replace(pin.declaration, 'open class ' + pin.className));
        const updated = { ...lock, predecessor: { ...lock.predecessor, bytes: mutated.length, sha256: sha256(mutated) } };
        assert.throws(() => transformConeClassIdentity(mutated, updated), /remain final/);
    }
}));

test('changed original, predecessor recipe, payload bodies and method projection fail closed', async () => fixture(async options => {
    const predecessor = await readFile(options.preparedIdentity.commonSources.find(file => file.endsWith('/' + CONE_PATH)));
    const changed = Buffer.from(predecessor.toString().replace('constructor != other.constructor', 'constructor == other.constructor'));
    assert.throws(() => transformConeClassIdentity(changed, lock), /predecessor content/);
    assert.throws(() => projectConeMethods(changed, lock, 'original'), /method projection changed/);
    const wrong = structuredClone(options.preparedIdentity); wrong.receipt.preparationToolSha256 = '0'.repeat(64);
    await assert.rejects(prepareConeClassIdentitySources({ ...options, preparedIdentity: wrong }), /receipt object changed/);
}));

test('output, original snapshot, exact claims and predecessor binding tampering cannot reuse a receipt', async () => fixture(async options => {
    const prepared = await prepareConeClassIdentitySources(options), receipt = JSON.parse(await readFile(prepared.receiptPath));
    for (const mutation of [{ finalClasses: FINAL_CLASSES.slice(1) }, { changes: [] }, { unchangedOutsideThreeGuards: false },
        { fullConeWasmRuntime: true }, { fullCompilerBuilt: true }, { publicLanguageSupport: true },
        { predecessorBindings: [{ ...receipt.predecessorBindings[0], filename: '/unrelated/ConeTypes.kt' }] },
        { predecessorBindings: [{ ...receipt.predecessorBindings[0], sha256: '0'.repeat(64) }] }]) {
        await writeFile(prepared.receiptPath, JSON.stringify({ ...receipt, ...mutation })); await assert.rejects(verifyConeClassIdentity(prepared.outputRoot));
    }
    await writeFile(prepared.receiptPath, JSON.stringify(receipt)); await verifyConeClassIdentity(prepared.outputRoot);
    await writeFile(prepared.commonSources[0], 'changed'); await assert.rejects(verifyConeClassIdentity(prepared.outputRoot));
}));

test('input/output overlap, symlinks and reused publication are rejected', async () => fixture(async options => {
    for (const outputRoot of [sourceRoot, path.join(sourceRoot, 'nested'), options.root, options.preparedIdentity.outputRoot])
        await assert.rejects(prepareConeClassIdentitySources({ ...options, outputRoot }), /overlap/);
    await prepareConeClassIdentitySources(options); await assert.rejects(prepareConeClassIdentitySources(options), /EEXIST/);
    const filename = options.preparedIdentity.commonSources.find(file => file.endsWith('/' + CONE_PATH)), real = path.join(options.root, 'real.kt');
    await writeFile(real, await readFile(filename)); await rm(filename); await symlink(real, filename);
    await assert.rejects(prepareConeClassIdentitySources({ ...options, outputRoot: path.join(options.root, 'other') }), /Symlink/);
}));

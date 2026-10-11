import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { receiverFactoryFixture } from './fixture.mjs';
import { OUTPUT_PREFIX, prepareDescriptorReceiverFactory, verifyDescriptorReceiverFactory, verifyFinalDescriptorReceiverFactory } from './prepare.mjs';
import { assembleImports } from '../type-substitutor-getter/prepare.mjs';
import { normalizeImports } from '../descriptor-base-implementations/prepare.mjs';
import { verifyFinalDescriptorFunctionImplementations } from '../descriptor-function-implementations/prepare.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const root = process.env.DESCRIPTOR_RECEIVER_GUARD_OUTPUT ?? path.join(REPO, 'out', 'kotlin-descriptor-receiver-guards-' + process.pid + '-' + Date.now());
assert(path.isAbsolute(root) && root.startsWith(path.join(REPO, 'out') + path.sep));
const pin = async (logical, filename) => { const bytes = await readRegular(filename); return { path: logical, filename, bytes: bytes.length, sha256: sha256(bytes) }; };
test('actual selected graph, exact import assembly, predecessor guard and adversarial mutations', async () => {
    await mkdir(root, { mode: 0o700 }); const fixture = await receiverFactoryFixture();
    const profile = await prepareDescriptorReceiverFactory({ ...fixture, outputRoot: path.join(root, 'profile') });
    profile.expectedReceiptSha256 = profile.receiptSha256;
    assert.deepEqual(await verifyDescriptorReceiverFactory(profile), profile.receipt);
    const own = [];
    for (const file of profile.receipt.files) own.push(await pin(file.path, path.join(profile.outputRoot, file.path)));
    const selected = fixture.retainedSources.concat(own);
    const lock = JSON.parse(await readRegular(path.join(HERE, 'sources.lock.json')));
    const relevant = new Set(lock.consumers.concat(lock.bindings.flatMap(binding => binding.files.map(pin => pin.path))));
    const focused = rows => rows.filter(row => relevant.has(row.path) || row.path.startsWith(OUTPUT_PREFIX) || lock.implementations.includes(row.path));
    const final = await verifyFinalDescriptorReceiverFactory({ ...profile, retainedSources: selected, recordedPropertyImports: fixture.recordedPropertyImports });
    assert.deepEqual(final.predecessorRetainedSources, fixture.retainedSources);
    const functionReceiptBytes = await readRegular(fixture.preparedDescriptorFunctions.outputRoot + '/receipt.json');
    const predecessor = await verifyFinalDescriptorFunctionImplementations({ outputRoot: fixture.preparedDescriptorFunctions.outputRoot, expectedReceiptSha256: sha256(functionReceiptBytes),
        retainedSources: final.predecessorRetainedSources, recordedPropertyImports: fixture.recordedPropertyImports });
    assert.equal(predecessor.predecessorRetainedSources.length, fixture.retainedSources.length - 3);
    let rejected = 0;
    async function reject(rows, options = {}) {
        await assert.rejects(verifyFinalDescriptorReceiverFactory({ ...profile, retainedSources: focused(rows), recordedPropertyImports: fixture.recordedPropertyImports, ...options })); rejected++;
    }
    await reject(selected.filter(row => row !== own[0]));
    await reject(selected.concat(own[0]));
    const owner = path.join(root, 'alternate-owner.kt'); await writeFile(owner, await readRegular(own[0].filename), { flag: 'wx', mode: 0o600 });
    await reject(selected.map(row => row === own[0] ? { ...row, filename: owner } : row));
    const filename = own[0].filename, original = await readRegular(filename);
    await writeFile(filename, Buffer.concat([original, Buffer.from('\n// body tamper\n')]));
    await reject(selected);
    // Rehashing the selected graph does not authorize changing a shipping algorithm.
    await reject(selected.map(row => row === own[0] ? { ...row, bytes: original.length + 16, sha256: sha256(Buffer.concat([original, Buffer.from('\n// body tamper\n')])) } : row));
    await writeFile(filename, original);
    const receiptOriginal = await readRegular(profile.receiptPath), receiptObject = JSON.parse(receiptOriginal); receiptObject.algorithms.push('forged');
    await writeFile(profile.receiptPath, JSON.stringify(receiptObject, null, 2) + '\n'); await reject(selected); await writeFile(profile.receiptPath, receiptOriginal);
    const originalLogical = profile.replacedOriginalPaths[0], originalOwner = path.join(fixture.sourceRoot, originalLogical);
    await reject(selected.concat(await pin(originalLogical, originalOwner)));
    const rogue = path.join(root, 'Rogue.kt'); await writeFile(rogue, 'package rogue\n', { flag: 'wx', mode: 0o600 });
    await reject(selected.concat(await pin(OUTPUT_PREFIX + 'Rogue.kt', rogue)));
    for (const row of own) await writeFile(row.filename, assembleImports(await readRegular(row.filename), fixture.recordedPropertyImports));
    const assembled = [];
    for (const row of selected) assembled.push(own.includes(row) ? await pin(row.path, row.filename) : row);
    const assembledFinal = await verifyFinalDescriptorReceiverFactory({ ...profile, retainedSources: focused(assembled), recordedPropertyImports: fixture.recordedPropertyImports });
    assert.deepEqual(assembledFinal.predecessorRetainedSources, fixture.retainedSources.filter(row => relevant.has(row.path)));
    await reject(assembled, { recordedPropertyImports: [] });
    const assembledBody = await readRegular(filename);
    await writeFile(filename, Buffer.from(assembledBody.toString().replace(/(^package[^\n]*\n)/m,
        '$1\n' + fixture.recordedPropertyImports.map(name => 'import ' + name).join('\n') + '\n')));
    const duplicated = [];
    for (const row of assembled) duplicated.push(row.filename === filename ? await pin(row.path, row.filename) : row);
    await reject(duplicated); await writeFile(filename, assembledBody);
    assert.equal((await verifyFinalDescriptorReceiverFactory({ ...profile, retainedSources: focused(assembled), recordedPropertyImports: fixture.recordedPropertyImports })).receipt.checked.length, 6);
    await assert.rejects(prepareDescriptorReceiverFactory({ ...fixture, outputRoot: profile.outputRoot })); rejected++;
    await assert.rejects(prepareDescriptorReceiverFactory({ ...fixture, outputRoot: fixture.sourceRoot })); rejected++;
    await writeJson(path.join(root, 'late-proof.json'), { kind: 'genuine-receiver-factory-late-selection-proof', result: 'pass', historical: fixture.historical,
        selectedSources: selected.length, predecessorSources: final.predecessorRetainedSources.length, exactFunctionPredecessorGuardPassed: true, negativeGuards: rejected,
        focusedAdversarialSources: focused(selected).length, fullActualSelectionPositivePassed: true, boundPredecessorFiles: lock.bindings.flatMap(binding => binding.files).length,
        fullCompilerBuilt: false, languageReadiness: false });
});
test('early preparation accepts pristine genuine dependency and consumer owners', async () => {
    const fixture = await receiverFactoryFixture(), lock = JSON.parse(await readRegular(path.join(HERE, 'sources.lock.json'))), args = { ...fixture, recordedPropertyImports: [] };
    const rows = fixture.retainedSources.map(row => ({ ...row }));
    for (const binding of lock.bindings) {
        const previous = fixture[binding.name], outputRoot = path.join(root, 'early-dependencies', binding.name);
        await mkdir(outputRoot, { recursive: true, mode: 0o700 });
        await writeFile(path.join(outputRoot, 'receipt.json'), await readRegular(previous.outputRoot + '/receipt.json'), { flag: 'wx', mode: 0o600 });
        for (const file of binding.files) {
            const source = rows.find(row => row.path === file.path), filename = path.join(outputRoot, file.outputPath);
            await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
            await writeFile(filename, normalizeImports(await readRegular(source.filename), fixture.recordedPropertyImports), { flag: 'wx', mode: 0o600 });
            rows[rows.indexOf(source)] = await pin(file.path, filename);
        }
        args[binding.name] = { outputRoot, receipt: previous.receipt };
    }
    for (const logical of lock.consumers) {
        const old = rows.find(row => row.path === logical), filename = path.join(root, 'early-consumers', logical);
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, await readRegular(path.join(fixture.sourceRoot, logical)), { flag: 'wx', mode: 0o600 });
        rows[rows.indexOf(old)] = await pin(logical, filename);
    }
    args.retainedSources = rows; args.outputRoot = path.join(root, 'early-profile');
    const prepared = await prepareDescriptorReceiverFactory(args);
    prepared.expectedReceiptSha256 = prepared.receiptSha256;
    assert.deepEqual(await verifyDescriptorReceiverFactory(prepared), prepared.receipt);
    const selected = rows.slice();
    for (const file of prepared.receipt.files) selected.push(await pin(file.path, path.join(prepared.outputRoot, file.path)));
    assert.deepEqual((await verifyFinalDescriptorReceiverFactory({ ...prepared, retainedSources: selected })).predecessorRetainedSources, rows);
    const relevant = new Set(lock.consumers.concat(lock.bindings.flatMap(binding => binding.files.map(pin => pin.path))));
    const focused = selected.filter(row => relevant.has(row.path) || row.path.startsWith(OUTPUT_PREFIX));
    // The private genuine dependency body is part of the receiver invariants.
    const dependency = rows.find(row => row.path === lock.bindings[0].files[0].path), original = await readRegular(dependency.filename);
    await writeFile(dependency.filename, Buffer.concat([original, Buffer.from('\n// dependency tamper\n')]));
    await assert.rejects(verifyFinalDescriptorReceiverFactory({ ...prepared, retainedSources: focused.map(row => row === dependency ? { ...row,
        bytes: original.length + 22, sha256: sha256(Buffer.concat([original, Buffer.from('\n// dependency tamper\n')])) } : row) }));
    await writeFile(dependency.filename, original);
    const alias = focused.find(row => row.path === 'compiler-port-type-contracts/generated/TypeProperties.kt'), aliasBody = await readRegular(alias.filename);
    const tamperedAlias = Buffer.concat([aliasBody, Buffer.from('\n// receiver alias tamper\n')]); await writeFile(alias.filename, tamperedAlias);
    await assert.rejects(verifyFinalDescriptorReceiverFactory({ ...prepared, retainedSources: focused.map(row => row === alias ? {
        ...row, bytes: tamperedAlias.length, sha256: sha256(tamperedAlias) } : row) }));
    await writeFile(alias.filename, aliasBody);
    assert.equal((await verifyFinalDescriptorReceiverFactory({ ...prepared, retainedSources: focused })).receipt.checked.length, 6);
    await writeJson(path.join(root, 'early-proof.json'), { kind: 'genuine-receiver-factory-early-preparation-proof', result: 'pass', selectedSources: selected.length,
        originalDependencyAndConsumerOwnersCopiedToPrivateProfiles: true, recordedPropertyImports: [], rehashedDependencyBodyGuardPassed: true,
        rehashedTypePropertiesBodyGuardPassed: true, boundPredecessorFiles: lock.bindings.flatMap(binding => binding.files).length, focusedAdversarialSources: focused.length,
        fullCompilerBuilt: false, languageReadiness: false });
});

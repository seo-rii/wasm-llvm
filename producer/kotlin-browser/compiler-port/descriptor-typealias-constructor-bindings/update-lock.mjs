import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGET, CLASS_CONSTRUCTOR, CHANGES, applyBindings } from './transform.mjs';
import { typeAliasConstructorFixture } from './fixture.mjs';
import { normalizeImports } from '../descriptor-base-implementations/prepare.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), hash = b => createHash('sha256').update(b).digest('hex'), blob = b => createHash('sha1').update(Buffer.from('blob ' + b.length + '\0')).update(b).digest('hex');
const read = name => readFile(path.join(HERE, name));
async function pin(name) { const b = await read(name); return { path: name, bytes: b.length, sha256: hash(b), gitBlob: blob(b) }; }
const closureBytes = await read('../closure.lock.json'), closure = JSON.parse(closureBytes), signatureBytes = await read('../descriptor-platform-signatures/sources.lock.json'), signature = JSON.parse(signatureBytes), fixture = await typeAliasConstructorFixture();
const originals = [TARGET, CLASS_CONSTRUCTOR].map(logical => { const p = closure.files.find(p => p.path === logical); assert(p); return p; });
const before = await read('contracts/SignatureTypeAliasConstructorDescriptor.kt'), after = await read('contracts/TypeAliasConstructorDescriptor.kt');
const signatureTarget = signature.outputs.find(row => row.path === TARGET); assert.equal(before.length, signatureTarget.bytes); assert.equal(hash(before), signatureTarget.sha256); assert(applyBindings(before).equals(after)); assert(applyBindings(after, true).equals(before));
const prior = JSON.parse(await read('../descriptor-overriding-implementations/sources.lock.json'));
const bindings = ['preparedFunctions', 'preparedReceivers', 'preparedPropertyConstructors'].map(name => { const b = prior.bindings.find(row => row.name === name); assert(b); return structuredClone(b); });
const signatureFiles = [];
for (const logical of [TARGET, CLASS_CONSTRUCTOR]) { const p = signature.outputs.find(row => row.path === logical); assert(p); const bytes = normalizeImports(await readFile(path.join(fixture.preparedDescriptorPlatformSignatures.outputRoot, logical)), fixture.recordedPropertyImports);
    assert.equal(bytes.length, p.bytes); assert.equal(hash(bytes), p.sha256); const localPath = logical === TARGET ? 'contracts/SignatureTypeAliasConstructorDescriptor.kt' : 'bindings/ClassConstructorDescriptor.kt';
    if (logical !== TARGET) await writeFile(path.join(HERE, localPath), bytes, { mode: 0o600 }); signatureFiles.push({ ...await pin(localPath), path: logical, localPath, receiptPath: logical, outputPath: logical }); }
bindings.push({ name: 'preparedDescriptorPlatformSignatures', kind: 'selected-descriptor-platform-signature-preparation', sourceLockSha256: hash(signatureBytes), files: signatureFiles });
const selectionDependencies = [{ ...await pin('../assertions/CompilerAssertions.kt'), path: 'compiler-port-assertions/CompilerAssertions.kt', localPath: '../assertions/CompilerAssertions.kt' },
    { ...await pin('../descriptor-overriding-implementations/bindings/DescriptorProperties.kt'), path: 'compiler-port-descriptors/generated/DescriptorProperties.kt', localPath: '../descriptor-overriding-implementations/bindings/DescriptorProperties.kt' }];
const dependencies = [];
for (const name of ['prepare.mjs', 'transform.mjs', 'fixture.mjs', 'integrity.mjs', 'probe.mjs', 'update-lock.mjs', '../../scripts/source.mjs', '../type-substitutor-getter/prepare.mjs', '../descriptor-base-implementations/prepare.mjs',
    ...['descriptor-function-implementations', 'descriptor-receiver-factory', 'descriptor-property-constructors', 'descriptor-platform-signatures', 'descriptor-overriding-implementations'].map(name => '../' + name + '/sources.lock.json'),
    '../descriptor-platform-signatures/transform.mjs', '../descriptor-platform-signatures/prepare.mjs', '../assertions/CompilerAssertions.kt']) dependencies.push(await pin(name));
const lock = { schemaVersion: 1, kind: 'genuine-typealias-constructor-bindings', source: closure.source, primaryClosureSha256: hash(closureBytes), target: TARGET, classConstructor: CLASS_CONSTRUCTOR, originals,
    common: await pin('TypeAliasConstructorBindings.kt'), contract: { path: TARGET, input: { ...await pin('contracts/SignatureTypeAliasConstructorDescriptor.kt'), path: TARGET, localPath: 'contracts/SignatureTypeAliasConstructorDescriptor.kt' }, output: { ...await pin('contracts/TypeAliasConstructorDescriptor.kt'), path: TARGET, localPath: 'contracts/TypeAliasConstructorDescriptor.kt' } },
    changes: CHANGES, bindings, selectionDependencies, dependencies, assemblyImports: fixture.recordedPropertyImports, sharedContractsChanged: false };
await writeFile(path.join(HERE, 'sources.lock.json'), JSON.stringify(lock, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ result: 'updated', outputs: 2, netAddedSources: 1, predecessorArtifacts: bindings.reduce((n, b) => n + b.files.length, 0) }));

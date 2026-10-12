import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JAVA, OVERLAYS, CONSUMERS, transformConsumer, reverseConsumer } from './transform.mjs';
import { overridingImplementationFixture } from './fixture.mjs';
import { normalizeImports } from '../descriptor-base-implementations/prepare.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const blob = bytes => createHash('sha1').update(Buffer.from('blob ' + bytes.length + '\0')).update(bytes).digest('hex');
const bytesFor = name => readFile(path.join(HERE, name));
async function pin(name) { const b = await bytesFor(name); return { path: name, bytes: b.length, sha256: hash(b), gitBlob: blob(b) }; }
const closureBytes = await bytesFor('../closure.lock.json'), closure = JSON.parse(closureBytes);
const originals = [JAVA, ...CONSUMERS].map(logical => { const row = closure.files.find(row => row.path === logical); assert(row); return row; });
const contracts = [];
for (const [logical, name] of OVERLAYS) { const canonical = 'contracts/Canonical' + name[0].toUpperCase() + name.slice(1), output = 'contracts/' + name;
    const a = await bytesFor(canonical), b = await bytesFor(output), original = originals.find(row => row.path === logical);
    assert.equal(a.length, original.bytes); assert.equal(hash(a), original.sha256); assert(transformConsumer(logical, a).equals(b)); assert(reverseConsumer(logical, b).equals(a));
    contracts.push({ path: logical, input: { ...await pin(canonical), path: logical, localPath: canonical }, output: { ...await pin(output), path: logical, localPath: output } }); }
const classesBytes = await bytesFor('../descriptor-class-implementations/sources.lock.json'), classes = JSON.parse(classesBytes);
const bindings = classes.bindings.map(spec => ({ ...spec, files: spec.files.map(row => ({ ...row, localPath: row.localPath.startsWith('../') ? row.localPath : '../descriptor-class-implementations/' + row.localPath })) }));
for (const [name, folder, kind] of [['preparedClassImplementations', 'descriptor-class-implementations', 'genuine-descriptor-class-preparation'], ['preparedLazyMutableImplementations', 'descriptor-lazy-mutable-implementations', 'genuine-descriptor-lazy-mutable-preparation']]) {
    const bytes = await bytesFor('../' + folder + '/sources.lock.json'), unit = JSON.parse(bytes), prefix = name === 'preparedClassImplementations' ? 'compiler-port-descriptor-classes/' : 'compiler-port-descriptor-lazy-mutable/';
    const contractsForUnit = unit.contracts ?? [unit.contract];
    bindings.push({ name, kind, sourceLockSha256: hash(bytes), files: [...unit.common.map(row => ({ ...row, path: prefix + row.path, receiptPath: prefix + row.path, outputPath: prefix + row.path, localPath: '../' + folder + '/' + row.path })),
        ...contractsForUnit.map(row => ({ ...row.output, path: row.path, receiptPath: row.path, outputPath: row.path, localPath: '../' + folder + '/' + row.output.localPath }))] }); }
const fixture = await overridingImplementationFixture();
for (const name of ['KotlinTypeChecker.kt', 'ExternalOverridabilityCondition.kt']) {
    const base = fixture.preparedTypeContracts.receipt.files.find(row => row.path === name), local = await pin('bindings/' + name); assert.equal(local.bytes, base.bytes); assert.equal(local.sha256, base.sha256);
    bindings.find(row => row.name === 'preparedTypeContracts').files.push({ ...local, path: 'compiler-port-type-contracts/generated/' + name, receiptPath: name, outputPath: 'generated/' + name, localPath: 'bindings/' + name }); }
const descriptorBase = fixture.preparedDescriptorContracts.receipt.files.find(row => row.path === 'DescriptorProperties.kt');
const canonicalAliases = normalizeImports(await readFile(path.join(fixture.preparedDescriptorContracts.outputRoot, 'generated/DescriptorProperties.kt')), fixture.recordedPropertyImports);
assert.equal(canonicalAliases.length, descriptorBase.bytes); assert.equal(hash(canonicalAliases), descriptorBase.sha256);
await writeFile(path.join(HERE, 'bindings/DescriptorProperties.kt'), canonicalAliases, { mode: 0o600 });
const aliasesPin = await pin('bindings/DescriptorProperties.kt');
bindings.find(row => row.name === 'preparedDescriptorContracts').files.push({ ...aliasesPin, path: 'compiler-port-descriptors/generated/DescriptorProperties.kt', receiptPath: 'DescriptorProperties.kt', outputPath: 'generated/DescriptorProperties.kt', localPath: 'bindings/DescriptorProperties.kt' });
const dependencies = [];
for (const name of ['prepare.mjs', 'transform.mjs', 'fixture.mjs', 'integrity.mjs', 'probe.mjs', 'update-lock.mjs', '../../scripts/source.mjs', '../type-substitutor-getter/prepare.mjs', '../descriptor-base-implementations/prepare.mjs',
    ...['descriptor-class-implementations', 'descriptor-lazy-mutable-implementations', 'descriptor-base-implementations', 'descriptor-function-implementations', 'descriptor-receiver-factory', 'descriptor-substitutor', 'descriptor-property-constructors', 'descriptors', 'type-contracts', 'type-utilities', 'descriptor-kind-filter-host'].map(name => '../' + name + '/sources.lock.json'),
    '../assertions/CompilerAssertions.kt']) dependencies.push(await pin(name));
const common = await Promise.all(['OverridingUtil.kt', 'OverridingHost.kt', 'OverridingUtilProperties.kt'].map(pin));
const selectionDependencies = [{ ...await pin('../assertions/CompilerAssertions.kt'), path: 'compiler-port-assertions/CompilerAssertions.kt', localPath: '../assertions/CompilerAssertions.kt' }];
const lock = { schemaVersion: 1, kind: 'genuine-descriptor-overriding-family', source: closure.source, primaryClosureSha256: hash(closureBytes), implementations: [JAVA], consumers: CONSUMERS, originals, common, contracts, bindings, selectionDependencies, assemblyImports: fixture.recordedPropertyImports, dependencies };
await writeFile(path.join(HERE, 'sources.lock.json'), JSON.stringify(lock, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ result: 'updated', sources: common.length + contracts.length, netAddedSources: 3, predecessorArtifacts: bindings.reduce((n, row) => n + row.files.length, 0) }));

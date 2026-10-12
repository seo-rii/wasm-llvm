import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeImports } from '../descriptor-base-implementations/prepare.mjs';
import { jvmDescriptorSignatureFixture } from './fixture.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), blob = bytes => createHash('sha1').update(Buffer.from('blob ' + bytes.length + '\0')).update(bytes).digest('hex');
async function pin(filename) { const bytes = await readFile(path.join(HERE, filename)); return { path: filename, bytes: bytes.length, sha256: hash(bytes), gitBlob: blob(bytes) }; }
const primaryBytes = await readFile(path.join(HERE, '../closure.lock.json')), primary = JSON.parse(primaryBytes);
const facts = JSON.parse(await readFile(path.join(HERE, 'source-facts.json'))), fixture = await jvmDescriptorSignatureFixture();
const previous = JSON.parse(await readFile(path.join(HERE, '../descriptor-overriding-implementations/sources.lock.json')));
const names = ['preparedClassImplementations', 'preparedFunctions', 'preparedReceivers', 'preparedPropertyConstructors', 'preparedTypeContracts', 'preparedTypeUtilities', 'preparedDescriptorBases'];
const bindings = names.map(name => {
    const spec = structuredClone(previous.bindings.find(row => row.name === name)); assert(spec);
    for (const p of spec.files) if (p.localPath.startsWith('bindings/')) p.localPath = '../descriptor-overriding-implementations/' + p.localPath;
    return spec;
});
const coreRecipeBytes = await readFile(path.join(HERE, '../core/name.recipe.json')), core = JSON.parse(coreRecipeBytes);
bindings.unshift({ name: 'preparedCore', kind: 'official-compiler-core-name-source-preparation', lockField: 'recipeSha256', sourceLockSha256: hash(coreRecipeBytes),
    receiptFilename: 'compiler-port-core/name-inputs.json', files: [{ ...await pin('../core/Name.kt'), path: core.portable.outputPath, localPath: '../core/Name.kt', receiptPath: 'Name.kt', outputPath: core.portable.outputPath }] });
const overFiles = [...previous.common.map(row => ({ ...row, localPath: '../descriptor-overriding-implementations/' + row.path,
    path: 'compiler-port-descriptor-overriding/' + row.path, receiptPath: 'compiler-port-descriptor-overriding/' + row.path, outputPath: 'compiler-port-descriptor-overriding/' + row.path })),
    ...previous.contracts.slice(0, 4).map(row => ({ ...row.output, path: row.path, localPath: '../descriptor-overriding-implementations/' + row.output.localPath, receiptPath: row.path, outputPath: row.path }))];
bindings.push({ name: 'preparedOverriding', kind: 'genuine-descriptor-overriding-preparation', sourceLockSha256: hash(await readFile(path.join(HERE, '../descriptor-overriding-implementations/sources.lock.json'))), files: overFiles });
const selectedPaths = [
    'compiler-port-assertions/CompilerAssertions.kt', 'compiler-port-descriptors/generated/DescriptorProperties.kt',
    'compiler-port-descriptors/generated/CallableDescriptor.kt', 'compiler-port-descriptors/generated/CallableMemberDescriptor.kt', 'compiler-port-descriptors/generated/FunctionDescriptor.kt',
    'core/names/src/org/jetbrains/kotlin/name/FqName.kt', 'core/names/src/org/jetbrains/kotlin/name/FqNameUnsafe.kt', 'core/names/src/org/jetbrains/kotlin/name/ClassId.kt',
    'core/compiler.common/src/org/jetbrains/kotlin/builtins/StandardNames.kt', 'core/compiler.common/src/org/jetbrains/kotlin/builtins/PrimitiveType.kt',
    'core/compiler.common/src/org/jetbrains/kotlin/builtins/CompanionObjectMapping.kt', 'core/compiler.common/src/org/jetbrains/kotlin/types/model/TypeSystemContext.kt',
    'core/descriptors/src/org/jetbrains/kotlin/types/checker/ClassicTypeSystemContext.kt', 'core/descriptors/src/org/jetbrains/kotlin/types/checker/NewKotlinTypeChecker.kt',
    'core/descriptors/src/org/jetbrains/kotlin/descriptors/descriptorUtil.kt',
];
const selectionDependencies = [];
for (const logical of selectedPaths) {
    const actual = fixture.retainedSources.find(row => row.path === logical); assert(actual, logical);
    const bytes = normalizeImports(await readFile(actual.filename), fixture.recordedPropertyImports), localPath = 'bindings/current-selected/' + logical;
    await mkdir(path.dirname(path.join(HERE, localPath)), { recursive: true }); await writeFile(path.join(HERE, localPath), bytes, { mode: 0o600 });
    selectionDependencies.push({ ...await pin(localPath), path: logical, localPath,
        primaryOriginal: primary.files.find(row => row.path === logical) ?? null });
}
const dependencyNames = ['prepare.mjs', 'transform.mjs', 'fixture.mjs', 'update-lock.mjs', 'integrity.mjs', 'probe.mjs', 'source-facts.json',
    '../../scripts/source.mjs', '../closure.lock.json', '../type-substitutor-getter/prepare.mjs', '../descriptor-base-implementations/prepare.mjs',
    '../core/name.recipe.json', '../descriptor-overriding-implementations/sources.lock.json',
    ...['descriptor-class-implementations', 'descriptor-function-implementations', 'descriptor-receiver-factory', 'descriptor-property-constructors', 'type-contracts', 'type-utilities', 'descriptor-base-implementations'].map(name => '../' + name + '/sources.lock.json'),
    ...['upstream-commit.json', 'upstream-root-tree.json', 'upstream-core-tree.json', 'foreign-class-metadata.json', 'metadata-source-coverage.json'].map(name => 'provenance/' + name)];
const dependencies = []; for (const filename of dependencyNames) dependencies.push(await pin(filename));
const lock = { schemaVersion: 1, kind: 'genuine-jvm-descriptor-signature-implementations', source: primary.source, sourceIdentity: facts.source,
    primaryClosureSha256: hash(primaryBytes), originals: facts.originals, common: facts.outputs, sourceFacts: await pin('source-facts.json'), bindings,
    selectionDependencies, assemblyImports: fixture.recordedPropertyImports, dependencies, addedSources: 18, replacedOriginalPaths: [], sourceSetExclusions: [] };
await writeFile(path.join(HERE, 'sources.lock.json'), JSON.stringify(lock, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ result: 'updated', outputs: 18, supplementalOriginals: 17, netAddedSources: 18, bindings: bindings.length,
    parentArtifacts: bindings.reduce((count, row) => count + row.files.length, 0), selectedDependencies: selectionDependencies.length }));

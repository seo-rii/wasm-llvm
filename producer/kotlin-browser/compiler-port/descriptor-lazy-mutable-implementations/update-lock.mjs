import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUSPEND_FUNCTIONS, DESERIALIZED_PARAMETER, LOCAL_IMPORTS, transformSuspendFunctions } from './transform.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const blob = bytes => createHash('sha1').update(Buffer.from('blob ' + bytes.length + '\0')).update(bytes).digest('hex');
const bytesFor = name => readFile(path.join(HERE, name));
async function pin(name) { const bytes = await bytesFor(name); return { path: name, bytes: bytes.length, sha256: hash(bytes), gitBlob: blob(bytes) }; }
const closureBytes = await bytesFor('../closure.lock.json'), closure = JSON.parse(closureBytes);
const implementations = ['AbstractLazyTypeParameterDescriptor', 'MutableClassDescriptor'].map(name => 'core/descriptors/src/org/jetbrains/kotlin/descriptors/impl/' + name + '.java');
const consumers = [SUSPEND_FUNCTIONS, DESERIALIZED_PARAMETER];
const originals = [...implementations, ...consumers].map(name => { const row = closure.files.find(row => row.path === name); if (!row) throw new Error('Missing genuine original: ' + name); return row; });
await mkdir(path.join(HERE, 'contracts'), { recursive: true });
const canonical = await bytesFor('../../../../out/kotlin-compiler-port/sources/' + SUSPEND_FUNCTIONS);
if (canonical.length !== originals[2].bytes || hash(canonical) !== originals[2].sha256) throw new Error('Canonical suspend-function source changed');
await writeFile(path.join(HERE, 'contracts/CanonicalSuspendFunctionTypes.kt'), canonical);
await writeFile(path.join(HERE, 'contracts/SuspendFunctionTypes.kt'), transformSuspendFunctions(canonical));
const contract = { path: SUSPEND_FUNCTIONS,
    input: { ...await pin('contracts/CanonicalSuspendFunctionTypes.kt'), path: SUSPEND_FUNCTIONS, localPath: 'contracts/CanonicalSuspendFunctionTypes.kt' },
    output: { ...await pin('contracts/SuspendFunctionTypes.kt'), path: SUSPEND_FUNCTIONS, localPath: 'contracts/SuspendFunctionTypes.kt' } };
const classBytes = await bytesFor('../descriptor-class-implementations/sources.lock.json'), classes = JSON.parse(classBytes);
const bindings = [{ name: 'preparedClassImplementations', kind: 'genuine-descriptor-class-preparation', sourceLockSha256: hash(classBytes),
    files: [...classes.common.map(row => ({ ...row, path: 'compiler-port-descriptor-classes/' + row.path,
        receiptPath: 'compiler-port-descriptor-classes/' + row.path, outputPath: 'compiler-port-descriptor-classes/' + row.path,
        localPath: '../descriptor-class-implementations/' + row.path })),
    ...classes.contracts.map(row => ({ ...row.output, path: row.path, receiptPath: row.path, outputPath: row.path,
        localPath: '../descriptor-class-implementations/' + row.output.localPath }))] }];
for (const name of ['preparedDescriptorSubstitutor', 'preparedPropertyConstructors', 'preparedTypeUtilities']) {
    const spec = classes.bindings.find(row => row.name === name); if (!spec) throw new Error('Missing genuine dependency binding');
    bindings.push(structuredClone(spec));
}
const dependencies = [];
for (const name of ['prepare.mjs', 'transform.mjs', 'fixture.mjs', 'integrity.mjs', 'update-lock.mjs', '../../scripts/source.mjs',
    '../type-substitutor-getter/prepare.mjs', '../descriptor-base-implementations/prepare.mjs',
    '../descriptor-class-implementations/sources.lock.json', '../descriptor-substitutor/sources.lock.json',
    '../descriptor-property-constructors/sources.lock.json', '../type-utilities/sources.lock.json', '../assertions/CompilerAssertions.kt']) dependencies.push(await pin(name));
const common = await Promise.all(['AbstractLazyTypeParameterDescriptor.kt', 'MutableClassDescriptor.kt', 'LazyMutableDescriptorProperties.kt'].map(pin));
const lock = { schemaVersion: 1, kind: 'genuine-descriptor-lazy-mutable-family', source: closure.source, primaryClosureSha256: hash(closureBytes),
    implementations, consumers, originals, common, contract, localConsumerImports: LOCAL_IMPORTS, bindings, dependencies };
await writeFile(path.join(HERE, 'sources.lock.json'), JSON.stringify(lock, null, 2) + '\n');
console.log(JSON.stringify({ result: 'updated', commonSources: common.length + 1, predecessorArtifacts: bindings.reduce((n, row) => n + row.files.length, 0) }));

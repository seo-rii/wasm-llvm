import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function pin(logical) { const bytes = await readFile(path.join(HERE, logical)); return { path: logical, bytes: bytes.length, sha256: sha(bytes), gitBlob: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') }; }
const primaryBytes = await readFile(path.join(HERE, '../closure.lock.json')), primary = JSON.parse(primaryBytes);
const implementations = ['FunctionDescriptorImpl', 'SimpleFunctionDescriptorImpl'].map(name => `core/descriptors/src/org/jetbrains/kotlin/descriptors/impl/${name}.java`);
const consumers = ['core/descriptors/src/org/jetbrains/kotlin/builtins/functions/FunctionInvokeDescriptor.kt', 'core/deserialization/src/org/jetbrains/kotlin/serialization/deserialization/MemberDeserializer.kt'];
const semantics = ['core/descriptors/src/org/jetbrains/kotlin/descriptors/impl/ValueParameterDescriptorImpl.kt', 'core/descriptors/src/org/jetbrains/kotlin/resolve/DescriptorFactory.java'];
const dependencies = ['prepare.mjs', '../../scripts/source.mjs', '../type-substitutor-getter/prepare.mjs', '../descriptor-base-implementations/prepare.mjs',
    '../descriptor-base-implementations/transform.mjs', '../descriptor-base-implementations/sources.lock.json', '../copy-builder-platform/sources.lock.json',
    '../copy-builder-platform/transform.mjs', '../descriptor-platform-signatures/sources.lock.json', '../descriptor-platform-signatures/transform.mjs', '../type-implementation/sources.lock.json'];
const bindings = [];
for (const [name, directory, kind] of [
    ['preparedDescriptorBases', 'descriptor-base-implementations', 'genuine-descriptor-base-implementations-preparation'],
    ['preparedCopyBuilderPlatform', 'copy-builder-platform', 'selected-copy-builder-platform-preparation'],
    ['preparedTypeImplementations', 'type-implementation', 'official-type-implementation-port'],
]) {
    const bytes = await readFile(path.join(HERE, '../' + directory + '/sources.lock.json')), lock = JSON.parse(bytes);
    let files;
    if (directory === 'descriptor-base-implementations') files = lock.common.map(pin => ({ path: pin.outputPath, bytes: pin.bytes, sha256: pin.sha256 })).concat(lock.consumer.output);
    else if (directory === 'copy-builder-platform') files = lock.outputs;
    else files = lock.portableFiles.map(pin => ({ ...pin, path: 'compiler-port-type-implementation/common/' + pin.path }));
    bindings.push({ name, kind, sourceLockSha256: sha(bytes), files: files.map(pin => ({ path: pin.path,
        receiptPath: directory === 'type-implementation' ? path.basename(pin.path) : pin.path,
        outputPath: directory === 'type-implementation' ? 'common/' + path.basename(pin.path) : pin.path, bytes: pin.bytes, sha256: pin.sha256 })) });
}
const originals = [...new Set([...implementations, ...consumers, ...semantics])].map(logical => { const pin = primary.files.find(pin => pin.path === logical); assert(pin, logical); return pin; });
const lock = { schemaVersion: 1, kind: 'genuine-descriptor-function-implementations', source: primary.source, primaryClosureSha256: sha(primaryBytes),
    implementations, consumers, originals, common: await Promise.all(['FunctionDescriptorImpl.kt', 'SimpleFunctionDescriptorImpl.kt', 'FunctionDescriptorProperties.kt'].map(pin)),
    dependencies: await Promise.all(dependencies.map(pin)), bindings };
await writeFile(path.join(HERE, 'sources.lock.json'), JSON.stringify(lock, null, 2) + '\n');
console.log(JSON.stringify({ result: 'sealed', originals: originals.length, outputs: lock.common.length, boundDependencies: bindings.reduce((n, item) => n + item.files.length, 0) }));

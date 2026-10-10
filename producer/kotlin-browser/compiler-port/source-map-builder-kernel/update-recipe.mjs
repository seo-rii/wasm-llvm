import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitBlob, readRegular, sha256, verifyFile } from '../../scripts/source.mjs';
import { builderSharedDependencies } from './prepare.mjs';
import { BUILDER, CONSUMER, PREFIX, bindSourceMapBuilder } from './transform.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..'), sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources');
async function pin(name) { const bytes = await readRegular(path.join(HERE, name)); return { path: name, bytes: bytes.length, sha256: sha256(bytes), gitBlob: gitBlob(bytes) }; }
const closureBytes = await readRegular(path.join(HERE, '../closure.lock.json')), closure = JSON.parse(closureBytes);
const sources = [BUILDER, CONSUMER].map(name => closure.files.find(pin => pin.path === name)), prepared = [];
for (const original of sources) {
    const bytes = bindSourceMapBuilder(original.path, verifyFile(await readRegular(path.join(sourceRoot, original.path)), original)).bytes;
    const outputPath = PREFIX + original.path.replace(/\.java$/, '.kt');
    prepared.push({ path: outputPath, bytes: bytes.length, sha256: sha256(bytes), gitBlob: gitBlob(bytes), originalPath: original.path });
}
const host = await pin('SourceMapBuilderHost.kt');
const ast = JSON.parse(await readRegular(path.join(HERE, '../js-ast/sources.lock.json')));
const lock = { schemaVersion: 1, kind: 'genuine-source-map-builder-kernel', source: closure.source, primaryClosureSha256: sha256(closureBytes), sources, prepared,
    host, hostOutput: { ...host, path: PREFIX + 'org/jetbrains/kotlin/js/portable/sourcemap/SourceMapBuilderHost.kt' },
    sharedDependencies: await builderSharedDependencies(sourceRoot), referenceDependencies: ast.referenceDependencies,
    tools: await Promise.all(['transform.mjs','prepare.mjs','update-recipe.mjs','extract-fastutil.py','check.mjs','integrity.test.mjs','verify.mjs'].map(pin)),
    observers: await Promise.all(['Probe.kt','OriginalSupport.kt','CommonSupport.kt','JvmEntry.kt','WasmEntry.kt'].map(pin)),
    dependencies: await Promise.all(['../closure.lock.json','../build-flags.json','../js-ast/sources.lock.json','../js-ast/prepare.mjs','../js-ast/adapt.mjs','../js-ast/verify.mjs','../js-ast/browser.mjs',
        '../source-map-json/sources.lock.json','../source-map-json/prepare.mjs','../source-map-text-io/sources.lock.json','../source-map-text-io/prepare.mjs',
        '../text/sources.lock.json','../text/prepare.mjs','../text/generate.mjs','../js-ast-consumer-bindings/output-stream/sources.lock.json','../js-ast-consumer-bindings/output-stream/JsAstStreamOutput.kt'].map(pin)),
    oracleFastutil: { bootstrapVersion: closure.bootstrapVersion, class: 'org.jetbrains.kotlin.it.unimi.dsi.fastutil.objects.Object2IntOpenHashMap',
        importRelocationOnly: true, compilerAstClassesExtracted: false },
    identityContract: 'Stable equals/hashCode; no arbitrary effectful hash evaluation-count parity.',
    callerIntegrated: false, fullCompilerBuilt: false, languageReadiness: false };
await writeFile(path.join(HERE, 'sources.lock.json'), JSON.stringify(lock, null, 2) + '\n');
console.log(JSON.stringify({ originals: sources.length, prepared: prepared.length + 1, sharedDependencies: lock.sharedDependencies.length }));

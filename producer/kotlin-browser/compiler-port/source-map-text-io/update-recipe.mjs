import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitBlob, readRegular, sha256 } from '../../scripts/source.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
async function pin(name) { const bytes = await readRegular(path.join(HERE, name)); return { path: name, bytes: bytes.length, sha256: sha256(bytes), gitBlob: gitBlob(bytes) }; }
const closureBytes = await readRegular(path.join(HERE, '../closure.lock.json')), closure = JSON.parse(closureBytes);
const json = JSON.parse(await readRegular(path.join(HERE, '../source-map-json/sources.lock.json')));
const inventory = JSON.parse(await readRegular(path.join(REPO, 'out/kotlin-js-source-map-audit/inventory.json')));
const sources = ['SourceMap.kt', 'SourceMapParser.kt', 'SourceMapLocationRemapper.kt'].map(name => inventory.files.find(pin => pin.path.endsWith('/' + name)));
const ast = JSON.parse(await readRegular(path.join(HERE, '../js-ast/sources.lock.json'))), reader = ast.portable.find(pin => pin.path.endsWith('/AstSourceReader.kt'));
const stream = JSON.parse(await readRegular(path.join(HERE, '../js-ast-consumer-bindings/output-stream/sources.lock.json')));
const text = JSON.parse(await readRegular(path.join(HERE, '../text/sources.lock.json')));
const jdkInput = JSON.parse(await readRegular(path.join(REPO, 'out/kotlin-source-map-text-io/jdk-reference/inventory.json')));
const jdkReference = { repository: jdkInput.repository, tag: jdkInput.tag, commit: jdkInput.commit, tagObject: jdkInput.tagObject,
    files: jdkInput.files.map(({ filename, ...pin }) => pin) };
const sharedDependencies = [
    { component: 'jsAstReceipt', path: reader.outputPath, bytes: reader.bytes, sha256: reader.sha256, gitBlob: reader.gitBlob },
    { component: 'jsAstOutputStreamReceipt', path: 'compiler-port-js-ast-output-stream/org/jetbrains/kotlin/js/portable/JsAstStreamOutput.kt',
        bytes: stream.implementation.bytes, sha256: stream.implementation.sha256, gitBlob: stream.implementation.gitBlob },
    ...[text.generatedAlgorithm, text.api].map(pin => ({ component: 'textReceipt', path: 'compiler-port-text/' + pin.path, bytes: pin.bytes, sha256: pin.sha256 })) ];
const implementations = await Promise.all(['SourceMapTextIo.kt', 'SourceMapTextStore.kt'].map(async name => ({ ...await pin(name), outputPath: 'compiler-port-source-map-text-io/org/jetbrains/kotlin/js/portable/sourcemap/' + name })));
const lock = { schemaVersion: 1, kind: 'request-source-map-text-io-protocol', source: closure.source, primaryClosureSha256: sha256(closureBytes),
    jsTree: json.jsTree, treeProof: json.treeProof, sources, tests: [], implementations, sharedDependencies, jdkReference,
    tools: await Promise.all(['prepare.mjs', 'check.mjs', 'integrity.test.mjs', 'update-recipe.mjs'].map(pin)),
    observers: await Promise.all(['Probe.kt', 'CommonSupport.kt', 'OriginalSupport.kt', 'JvmEntry.kt', 'WasmEntry.kt'].map(pin)),
    dependencies: await Promise.all(['../source-map-json/sources.lock.json', '../source-map-json/verify-tree.mjs',
        '../js-ast/sources.lock.json', '../js-ast/portable/org/jetbrains/kotlin/js/util/AstSourceReader.kt',
        '../js-ast-consumer-bindings/output-stream/sources.lock.json', '../js-ast-consumer-bindings/output-stream/JsAstStreamOutput.kt',
        '../text/sources.lock.json', '../text/prepare.mjs', '../text/generate.mjs', '../text/upstream/utf8Encoding.kt', '../text/CompilerUtf8Api.kt'].map(pin)),
    fullParserRuntimeBuilt: false, requestStdoutInstalled: false, fullCompilerBuilt: false, languageReadiness: false };
await writeFile(path.join(HERE, 'sources.lock.json'), JSON.stringify(lock, null, 2) + '\n');

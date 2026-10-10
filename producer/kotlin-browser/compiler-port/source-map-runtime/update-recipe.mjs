import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitBlob, readRegular, sha256 } from '../../scripts/source.mjs';
import { prepareJsAstSources } from '../js-ast/prepare.mjs';
import { prepareConfigurationSources } from '../config/prepare.mjs';
import { sourceContentBinding } from '../js-ast-consumer-bindings/source-content/transform.mjs';
import { ROOT, RUNTIME_PATHS, UTILS, bindRuntime, bindConsumer } from './transform.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..'), sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources');
async function pin(name) { const bytes = await readRegular(path.join(HERE, name)); return { path: name, bytes: bytes.length, sha256: sha256(bytes), gitBlob: gitBlob(bytes) }; }
function generated(name, bytes) { return { path: name, bytes: bytes.length, sha256: sha256(bytes), gitBlob: gitBlob(bytes) }; }
const closureBytes = await readRegular(path.join(HERE, '../closure.lock.json')), closure = JSON.parse(closureBytes);
const json = JSON.parse(await readRegular(path.join(HERE, '../source-map-json/sources.lock.json'))), io = JSON.parse(await readRegular(path.join(HERE, '../source-map-text-io/sources.lock.json')));
const inventory = JSON.parse(await readRegular(path.join(REPO, 'out/kotlin-js-source-map-audit/inventory.json')));
const sources = RUNTIME_PATHS.map(name => inventory.files.find(pin => pin.path === name));
const callerPaths = ['compiler/ir/backend.js/src/org/jetbrains/kotlin/ir/backend/js/transformers/irToJs/FunctionWithJsFuncAnnotationInliner.kt', UTILS,
    'compiler/ir/backend.js/src/org/jetbrains/kotlin/ir/backend/js/utils/JsGenerationContext.kt'];
const closurePaths = [...callerPaths, 'compiler/ir/backend.js/src/org/jetbrains/kotlin/ir/backend/js/utils/JsStaticContext.kt',
    'compiler/ir/backend.js/src/org/jetbrains/kotlin/ir/backend/js/JsIrBackendContext.kt',
    'compiler/ir/backend.js/src/org/jetbrains/kotlin/ir/backend/js/JsCommonBackendContext.kt',
    'compiler/ir/backend.common/src/org/jetbrains/kotlin/backend/common/CommonBackendContext.kt',
    'compiler/ir/backend.common/src/org/jetbrains/kotlin/backend/common/LoweringContext.kt',
    'compiler/ir/backend.common/src/org/jetbrains/kotlin/backend/common/ErrorReportingContext.kt'];
const parent = path.join(REPO, 'out/kotlin-source-map-runtime'); await mkdir(parent, { recursive: true, mode: 0o700 }); const seed = await mkdtemp(path.join(parent, 'seed-'));
const ast = await prepareJsAstSources({ sourceRoot, outputRoot: path.join(seed, 'ast') }); const config = await prepareConfigurationSources({ sourceRoot, outputRoot: path.join(seed, 'config') });
const sharedDependencies = [
    ...ast.receipt.files.map(({ path, bytes, sha256, gitBlob }) => ({ component: 'jsAstReceipt', path, bytes, sha256, gitBlob })),
    ...json.prepared.map(({ path, bytes, sha256, gitBlob }) => ({ component: 'sourceMapJsonReceipt', path, bytes, sha256, gitBlob })),
    ...io.implementations.map(({ outputPath: path, bytes, sha256, gitBlob }) => ({ component: 'sourceMapTextIoReceipt', path, bytes, sha256, gitBlob }))];
// Configuration output pins bind genuine transformed sources and the actual key/view host.
for (const item of config.receipt.sources) sharedDependencies.push({ component: 'configurationReceipt', ...generated(item.path, await readRegular(path.join(seed, 'config', item.path))) });
const assertion = await pin('../assertions/CompilerAssertions.kt'); sharedDependencies.push({ component: 'assertionReceipt', ...assertion, path: 'compiler-port-assertions/CompilerAssertions.kt' });
const predecessorBytes = sourceContentBinding(await readRegular(path.join(sourceRoot, UTILS))).bytes;
const predecessor = { component: 'jsSourceContentReceipt', componentRelativePath: 'compiler-port-js-ast-source-content/' + UTILS,
    pin: generated('compiler-port-js-ast-source-content/' + UTILS, predecessorBytes) };
const prepared = [];
for (const pin of sources) prepared.push({ ...generated('compiler-port-source-map-runtime/' + pin.path,
    bindRuntime(pin.path, await readRegular(path.join(REPO, 'out/kotlin-js-source-map-audit/sources', pin.path))).bytes), originalPath: pin.path });
prepared.push({ ...generated('compiler-port-source-map-runtime/' + UTILS, bindConsumer(predecessorBytes).bytes), predecessor: predecessor.componentRelativePath });
const runtime = await pin('SourceMapRuntime.kt'), runtimeOutput = { ...runtime, path: 'compiler-port-source-map-runtime/org/jetbrains/kotlin/js/portable/sourcemap/SourceMapRuntime.kt' };
const lock = { schemaVersion: 1, kind: 'genuine-request-source-map-runtime', source: closure.source, primaryClosureSha256: sha256(closureBytes),
    jsTree: json.jsTree, treeProof: json.treeProof, sources, tests: [],
    referenceDependencies: JSON.parse(await readRegular(path.join(HERE, '../js-ast/sources.lock.json'))).referenceDependencies, callerClosure: closurePaths.map(name => closure.files.find(pin => pin.path === name)), selectedCallers: callerPaths,
    predecessor, prepared, runtime, runtimeOutput, sharedDependencies,
    tools: await Promise.all(['transform.mjs', 'prepare.mjs', 'update-recipe.mjs', 'check.mjs', 'integrity.test.mjs', 'final.mjs', 'verify.mjs'].map(pin)),
    observers: await Promise.all(['Probe.kt', 'OriginalSupport.kt', 'CommonSupport.kt', 'JvmEntry.kt', 'WasmEntry.kt'].map(pin)),
    dependencies: await Promise.all(['../source-map-json/sources.lock.json', '../source-map-json/verify-tree.mjs', '../source-map-json/prepare.mjs',
        '../source-map-text-io/sources.lock.json', '../source-map-text-io/prepare.mjs', '../source-map-text-io/evidence/receipt.json', '../js-ast/sources.lock.json', '../js-ast/prepare.mjs', '../js-ast/adapt.mjs', '../js-ast/verify.mjs',
        '../js-ast-consumer-bindings/source-content/sources.lock.json', '../js-ast-consumer-bindings/source-content/prepare.mjs', '../js-ast-consumer-bindings/source-content/transform.mjs',
        '../config/sources.lock.json', '../config/prepare.mjs', '../config/ConfigurationHost.kt', '../assertions/CompilerAssertions.kt'].map(pin)),
    entryRuntimeInstalled: false, originalGlobalStdoutParity: false, fullCompilerBuilt: false, languageReadiness: false };
await writeFile(path.join(HERE, 'sources.lock.json'), JSON.stringify(lock, null, 2) + '\n'); console.log(JSON.stringify({ seed, sharedDependencies: sharedDependencies.length }));

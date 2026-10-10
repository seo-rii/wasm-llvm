#!/usr/bin/env node
/** Official tree/range algorithm comparison. This does not build compiler C or claim complete diagnostic dispatch. */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap, defaultCache } from '../../build/bootstrap.mjs';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile } from '../../scripts/source.mjs';
import { prepareHostSources } from '../host/prepare.mjs';
import { prepareAssertionSources } from '../assertions/prepare.mjs';
import { preparePositioningSources } from './prepare.mjs';
import { preparePositioningSourceCache } from './fetch.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const execute = promisify(execFile);
const local = (name) => path.join(here, relativePath(name));
const options = {}; const args = process.argv.slice(2);
while (args.length) {
    const key = args.shift(); assert(['--output', '--source-root', '--bootstrap-cache', '--parser-output'].includes(key) && args[0] && !options[key]);
    options[key] = path.resolve(args.shift());
}
const output = options['--output'] ?? path.join(repository, 'out/kotlin-compiler-positioning-probe');
const sourceRoot = options['--source-root'] ?? path.join(repository, 'out/kotlin-compiler-port/sources');
const parserRoot = options['--parser-output'] ?? path.join(repository, 'out/kotlin-parser-probe');
assert(output.startsWith(path.join(repository, 'out') + path.sep));
await assertNoSymlink(output); await assertNoSymlink(parserRoot);
const bootstrap = await verifyBootstrap(options['--bootstrap-cache'] ?? defaultCache);
const cache = await preparePositioningSourceCache();
const parserReceiptBytes = await readRegular(path.join(parserRoot, 'build-receipt.json'));
const parserReceipt = JSON.parse(parserReceiptBytes);
assert.equal(parserReceipt.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
assert.equal(parserReceipt.bootstrapVersion, bootstrap.lock.version);
const parserRecipe = JSON.parse(await readRegular(path.join(here, '../../parser-probe/recipe.json')));
assert.equal(sha256(await readRegular(path.join(here, '../../parser-probe/recipe.json'))), parserReceipt.recipeSha256);
const parserInputs = [];
for (const pin of parserReceipt.outputs.filter((pin) => pin.path === 'jvm/parser-probe.jar' || pin.path === 'klib/parser-probe.klib')) {
    const bytes = await readRegular(path.join(parserRoot, pin.path), pin.bytes); assert.equal(bytes.byteLength, pin.bytes); assert.equal(sha256(bytes), pin.sha256);
    parserInputs.push(pin);
}
assert.equal(parserInputs.length, 2);
for (const pin of parserRecipe.artifacts.filter((pin) => pin.name.endsWith('.jar') || pin.name.endsWith('.klib'))) {
    const bytes = await readRegular(path.join(parserRoot, 'artifacts', relativePath(pin.name)), pin.bytes);
    assert.equal(bytes.byteLength, pin.bytes); assert.equal(sha256(bytes), pin.sha256); parserInputs.push({ path: 'artifacts/' + pin.name, bytes: pin.bytes, sha256: pin.sha256 });
}
await mkdir(output, { recursive: false });
const prepared = await preparePositioningSources({ sourceRoot, outputRoot: output, positioningSourceRoot: cache.positioningSourceRoot });
const host = await prepareHostSources({ sourceRoot, outputRoot: path.join(output, 'host') });
const assertions = await prepareAssertionSources({ outputRoot: output });
const recipe = JSON.parse(await readRegular(local('positioning.recipe.json')));
const flagsBytes = await readRegular(path.join(here, '../build-flags.json'));
const flags = JSON.parse(flagsBytes); assert.equal(flags.source.commit, recipe.source.commit);
const commands = [];
async function command(phase, argv, capture = false) {
    const started = performance.now(); let stdout = ''; let exitCode;
    if (capture) {
        const result = await execute(argv[0], argv.slice(1), { timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
        stdout = result.stdout; if (result.stderr) process.stderr.write(result.stderr); exitCode = 0;
    } else {
        exitCode = await new Promise((resolve, reject) => {
            const child = spawn(argv[0], argv.slice(1), { cwd: repository, stdio: ['ignore', 'inherit', 'inherit'] });
            const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
            child.once('error', (error) => { clearTimeout(timer); reject(error); });
            child.once('exit', (code, signal) => { clearTimeout(timer); signal ? reject(new Error(phase + ' terminated by ' + signal)) : resolve(code); });
        });
    }
    commands.push({ phase, argv, exitCode, elapsedMs: performance.now() - started }); assert.equal(exitCode, 0, phase + ' failed'); return stdout;
}
async function put(root, name, bytes) {
    const destination = path.join(root, relativePath(name)); await assertNoSymlink(destination); await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 }); return destination;
}
const originalRoot = path.join(output, 'original'); const portableRoot = path.join(output, 'portable-probe');
const relocated = (source) => source.replaceAll(/\bcom\.intellij\.(?!platform\.syntax\b)/g, 'org.jetbrains.kotlin.com.intellij.');
const originalFiles = new Map();
for (const pin of recipe.originals) {
    const root = pin.sourceRoot === 'compiler-closure' ? sourceRoot : cache.positioningSourceRoot;
    originalFiles.set(pin.path, await put(originalRoot, pin.path, Buffer.from(relocated(verifyFile(await readRegular(path.join(root, pin.path), pin.bytes), pin).toString('utf8')))));
}
const diagnosticPrefix = 'compiler/frontend.common-psi/src/org/jetbrains/kotlin/diagnostics/';
const commonPrefix = 'compiler/frontend.common/src/org/jetbrains/kotlin/';
const javaOriginals = [...originalFiles.values()].filter((file) => file.endsWith('.java') && !file.endsWith('/KtStubElementTypes.java'));
const javaStubs = originalFiles.get('compiler/psi/psi-impl/src/org/jetbrains/kotlin/psi/stubs/elements/KtStubElementTypes.java');
const stdlibJvm = bootstrap.artifacts.find((item) => item.id === 'stdlib-jvm').path;
const referenceClasses = path.join(output, 'jvm/classes'); await mkdir(referenceClasses, { recursive: true });
const compiler = ['java', '-Xmx768m', '-cp', bootstrap.classPath];
const jvm = [...compiler, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-language-version', '2.5', '-api-version', '2.5', ...flags.compilerFlags];
const parserJvm = parserInputs.filter((pin) => pin.path.endsWith('.jar')).map((pin) => path.join(parserRoot, pin.path));
// G1 owns the exact selected new parser; B contains other relocated parser classes.
const referenceClassPath = [referenceClasses, ...parserJvm, bootstrap.classPath].join(path.delimiter);
await command('official-legacy-declarations-javac', ['javac', '-classpath', referenceClassPath, '-d', referenceClasses, ...javaOriginals, javaStubs]);

const production = new Map(); for (const file of prepared.commonSources) production.set(path.basename(file), await readRegular(file));
const strategyText = production.get('LightTreePositioningStrategies.kt').toString('utf8');
const names = [...strategyText.matchAll(/^    val ([A-Z0-9_]+)\b/gm)].map((match) => match[1]).filter((name) => name !== 'UNREACHABLE_CODE');
assert(names.length >= 90);
const kindLines = [];
for (const [name, owner, prefix] of [['KtTokens.kt', 'KtTokens', 't'], ['KtNodeTypes.kt', 'KtNodeTypes', 'n'], ['KDocTokens.kt', 'KDocTokens', 'd']]) {
    const source = production.get(name).toString('utf8');
    for (const match of source.matchAll(/@JvmField val (\w+): (KtToken|KtKeywordToken|KtModifierKeywordToken|KtSingleValueToken|KDocToken|IElementType) =/g)) {
        kindLines.push('    ' + JSON.stringify(prefix + ':' + match[1]) + ' to ' + owner + '.' + match[1] + ',');
    }
}
const operationsTemplate = (await readRegular(local('ProbeOperations.kt.in'))).toString('utf8');
const operations = (portable) => {
    const substitutions = {
        HOST: portable ? 'org.jetbrains.kotlin.portable.source' : 'org.jetbrains.kotlin.com.intellij.lang',
        REF: portable ? 'org.jetbrains.kotlin.portable.source.Ref' : 'org.jetbrains.kotlin.com.intellij.openapi.util.Ref',
        TYPE: portable ? 'org.jetbrains.kotlin.portable.source.IElementType' : 'org.jetbrains.kotlin.com.intellij.psi.tree.IElementType',
        TREE: portable ? 'org.jetbrains.kotlin.portable.source.FlyweightCapableTreeStructure' : 'org.jetbrains.kotlin.com.intellij.util.diff.FlyweightCapableTreeStructure',
        RANGE: portable ? 'com.intellij.openapi.util.TextRange' : 'org.jetbrains.kotlin.com.intellij.openapi.util.TextRange',
        TOKEN_TYPE: portable ? 'org.jetbrains.kotlin.portable.source.TokenType' : 'org.jetbrains.kotlin.com.intellij.psi.TokenType',
        KINDS: kindLines.join('\n'), STRATEGIES: names.map((name) => '    ' + JSON.stringify(name) + ' to LightTreePositioningStrategies.' + name + ',').join('\n'),
        NODE_MEMBERS: portable ? '    override val tokenType: IElementType get() = kinds.getValue(input.type)\n    override val startOffset: Int get() = input.start\n    override val endOffset: Int get() = input.end' :
            '    override fun getTokenType(): IElementType = kinds.getValue(input.type)\n    override fun getStartOffset(): Int = input.start\n    override fun getEndOffset(): Int = input.end',
        NULLABLE: '', SUFFIX: portable ? '' : '?', LEFT_BOUND: portable ? '(type as? KtNodeType)?.isLeftBound()' : '(type as? KtNodeType)?.isLeftBound',
    };
    let text = operationsTemplate; for (const [key, value] of Object.entries(substitutions)) text = text.replaceAll('@' + key + '@', value);
    assert(!/@(?:HOST|REF|TYPE|TREE|RANGE|KINDS|STRATEGIES|NODE_MEMBERS|NULLABLE|SUFFIX|LEFT_BOUND)@/.test(text)); return text;
};
const originalOperations = await put(originalRoot, 'ProbeOperations.kt', Buffer.from(operations(false)));
const portableOperations = await put(portableRoot, 'ProbeOperations.kt', Buffer.from(operations(true)));
const originalRange = await put(originalRoot, 'RangeProbe.kt', Buffer.from(relocated((await readRegular(local('RangeProbe.kt'))).toString('utf8'))));
const excluded = [];
const probeSources = [];
for (const [name, bytes] of production) {
    if (['SourceElementPositioningStrategy.kt', 'SourceElementPositioningStrategies.kt', 'KtDiagnostic.kt', 'DiagnosticMarker.kt', 'AbstractSourceElementPositioningStrategy.kt', 'OffsetsOnlyPositioningStrategy.kt'].includes(name)) {
        excluded.push({ path: name, reason: 'Actual complete diagnostic-model/factory integration is outside this tree/range microprobe; full production source remains prepared.' }); continue;
    }
    let text = bytes.toString('utf8');
    if (name === 'LightTreePositioningStrategy.kt') {
        const begin = text.indexOf('    open fun markKtDiagnostic('); const end = text.indexOf('    open fun mark(', begin);
        assert(begin > 0 && end > begin); text = text.slice(0, begin) + text.slice(end);
        const property = text.indexOf('val KtLightSourceElement.startOffsetSkippingComments:'); assert(property > 0); text = text.slice(0, property);
        text = text.replace('import org.jetbrains.kotlin.KtLightSourceElement\n', '').replace('import org.jetbrains.kotlin.KtSourceElement\n', '');
        excluded.push({ path: name, declarations: ['markKtDiagnostic', 'KtLightSourceElement.startOffsetSkippingComments'], reason: 'Source-element/diagnostic wrappers excluded only from comparison artifact; mark/isValid/helpers unchanged.' });
    }
    if (name === 'LightTreePositioningStrategies.kt') {
        const begin = text.indexOf('    val UNREACHABLE_CODE:'); const end = text.indexOf('    val NOT_SUPPORTED_IN_INLINE_MOST_RELEVANT:', begin);
        assert(begin > 0 && end > begin); text = text.slice(0, begin) + text.slice(end);
        const extBegin = text.indexOf('fun KtSourceElement.hasValOrVar():'); const extEnd = text.indexOf('private fun FlyweightCapableTreeStructure<LighterASTNode>.companionKeyword(', extBegin);
        assert(extBegin > 0 && extEnd > extBegin); text = text.slice(0, extBegin) + text.slice(extEnd); text = text.replace('import org.jetbrains.kotlin.KtSourceElement\n', '');
        excluded.push({ path: name, declarations: ['UNREACHABLE_CODE.markKtDiagnostic', 'KtSourceElement.hasValOrVar/hasVar/hasPrimaryConstructor'], reason: 'Typed diagnostic/source wrappers excluded only from microprobe; unreachable helper methods are compared directly.' });
    }
    if (name === 'sourceElementUtils.kt') {
        const begin = text.indexOf('fun LighterASTNode.getAssignmentLhsIfUnwrappable('); const end = text.indexOf('fun KtSourceElement?.hasUnwrappableAsExplicitReceiver()', begin);
        assert(begin > 0 && end > begin); text = text.slice(0, text.indexOf('/**')) + text.slice(begin, end);
        text = text.replace('import org.jetbrains.kotlin.KtLightSourceElement\n', '').replace('import org.jetbrains.kotlin.KtSourceElement\n', '');
        excluded.push({ path: name, declarations: ['KtSourceElement.hasUnwrappableAsAssignmentLhs/hasUnwrappableAsExplicitReceiver'], reason: 'Retain exact LighterASTNode assignment/receiver algorithms without source wrapper.' });
    }
    if (name === 'ElementTypeUtils.kt') {
        assert.equal(text.split('package org.jetbrains.kotlin\n').length, 2);
        text = text.replace('package org.jetbrains.kotlin\n', 'package org.jetbrains.kotlin\n\nimport ' + assertions.assertionImport + '\n');
    }
    probeSources.push(await put(portableRoot, name, Buffer.from(text)));
}
probeSources.push(...assertions.commonSources);
const helperPin = recipe.probeHelperOriginal;
const helperBytes = verifyFile(await readRegular(path.join(sourceRoot, helperPin.path), helperPin.bytes), helperPin);
const helperText = helperBytes.toString('utf8'); const helperBegin = helperText.indexOf('inline fun <R> runUnless('); const helperEnd = helperText.indexOf('\ninline fun ', helperBegin + 1);
assert(helperBegin > 0 && helperEnd > helperBegin);
const helper = '@file:OptIn(kotlin.contracts.ExperimentalContracts::class, kotlin.contracts.ExperimentalExtendedContracts::class)\npackage org.jetbrains.kotlin.utils.addToStdlib\nimport kotlin.contracts.*\n' + helperText.slice(helperBegin, helperEnd) + '\n';
probeSources.push(await put(portableRoot, 'runUnless.kt', Buffer.from(helper)));
const bridgePath = 'compiler/fir/raw-fir/mp-parsing2fir/src/org/jetbrains/kotlin/fir/builder/KotlinLightTreeStructure.kt';
probeSources.push(host.commonSources.find((file) => file.endsWith(bridgePath)), host.commonSources.find((file) => file.endsWith('/PortableLightTree.kt')));
const observer = local('PositioningProbe.kt'); const entry = local('PositioningJvmEntry.kt');
const originalKotlin = ['LightTreePositioningStrategies.kt', 'LightTreePositioningStrategy.kt', 'UnreachableCodeLightTreeHelper.kt', 'PositioningStrategy.kt'].map((name) => originalFiles.get(diagnosticPrefix + name));
const originalSourceUtilsText = await readRegular(originalFiles.get('compiler/psi/psi-frontend-utils/src/org/jetbrains/kotlin/resolve/source/sourceElementUtils.kt'));
const originalSourceUtils = originalSourceUtilsText.toString('utf8');
const lhsBegin = originalSourceUtils.indexOf('fun LighterASTNode.getAssignmentLhsIfUnwrappable(');
const lhsEnd = originalSourceUtils.indexOf('fun KtSourceElement?.hasUnwrappableAsExplicitReceiver()', lhsBegin);
assert(lhsBegin > 0 && lhsEnd > lhsBegin);
const pureSourceUtils = originalSourceUtils.slice(0, originalSourceUtils.indexOf('/**')) + originalSourceUtils.slice(lhsBegin, lhsEnd);
const originalNodeUtils = await put(originalRoot, 'sourceElementUtils-probe.kt', Buffer.from(pureSourceUtils.replace('import org.jetbrains.kotlin.com.intellij.psi.util.elementType\n', '')));
originalKotlin.push(originalFiles.get(commonPrefix + 'util/LightTreeUtils.kt'), originalFiles.get(bridgePath),
    originalFiles.get('compiler/psi/psi-impl/src/org/jetbrains/kotlin/ElementTypeUtils.kt'), originalNodeUtils);
const originalJar = path.join(output, 'jvm/original.jar');
await command('official-positioning-jvm-build', [...jvm, '-classpath', referenceClassPath, '-d', originalJar, ...originalKotlin, originalOperations, originalRange, observer, entry]);
const commonSources = [...probeSources, portableOperations, local('RangeProbe.kt'), observer];
const portableJar = path.join(output, 'jvm/portable.jar');
await command('portable-positioning-jvm-build', [...jvm, '-Xmulti-platform', '-Xcommon-sources=' + commonSources.join(','), '-classpath', [stdlibJvm, ...parserJvm].join(path.delimiter), '-d', portableJar, ...commonSources, entry]);
const main = 'org.jetbrains.kotlin.portable.positioningprobe.PositioningJvmEntryKt';
const original = JSON.parse((await command('official-positioning-jvm-observe', ['java', '-ea', '-cp', [originalJar, referenceClassPath].join(path.delimiter), main], true)).trim());
const portable = JSON.parse((await command('portable-positioning-jvm-observe', ['java', '-ea', '-cp', [portableJar, stdlibJvm, ...parserJvm].join(path.delimiter), main], true)).trim());
assert.deepEqual(portable, original, 'Portable tree/range algorithms differ from pinned original JVM sources');
const libraries = [bootstrap.wasmJsStdlib, ...parserInputs.filter((pin) => pin.path.endsWith('.klib')).map((pin) => path.join(parserRoot, pin.path))].join(path.delimiter);
const wasm = [...compiler, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js', '-language-version', '2.5', '-api-version', '2.5', ...flags.compilerFlags, '-libraries', libraries];
await mkdir(path.join(output, 'klib')); await mkdir(path.join(output, 'wasm'));
await command('portable-positioning-wasmjs-klib-build', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + commonSources.join(','), '-Xir-produce-klib-file', '-ir-output-dir', path.join(output, 'klib'), '-ir-output-name', 'positioning-probe', ...commonSources, local('PositioningWasmEntry.kt')]);
await command('portable-positioning-wasmjs-binary-build', [...wasm, '-Xir-produce-js', '-Xinclude=' + path.join(output, 'klib/positioning-probe.klib'), '-ir-output-dir', path.join(output, 'wasm'), '-ir-output-name', 'positioning-probe', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
const observedWasm = JSON.parse((await command('portable-positioning-wasmjs-observe', [process.execPath, '--experimental-wasm-exnref', '--input-type=module', '-e',
    'const module = await import(process.argv[1]); console.log(module.officialPositioningProbeJson());', pathToFileURL(path.join(output, 'wasm/positioning-probe.mjs')).href], true)).trim());
assert.deepEqual(observedWasm, original, 'Portable actual Wasm tree/range algorithms differ from pinned original JVM sources');
const outputPins = [];
for (const [name, value] of [['original-jvm.json', original], ['portable-jvm.json', portable], ['portable-wasmjs.json', observedWasm]]) await put(output, name, Buffer.from(JSON.stringify(value, null, 2) + '\n'));
for (const name of ['jvm/original.jar', 'jvm/portable.jar', 'klib/positioning-probe.klib', 'original-jvm.json', 'portable-jvm.json', 'portable-wasmjs.json', ...(await readdir(path.join(output, 'wasm'))).sort().map((name) => 'wasm/' + name)]) {
    const bytes = await readRegular(path.join(output, name)); outputPins.push({ path: name, bytes: bytes.byteLength, sha256: sha256(bytes) });
}
const observerSources = [];
for (const name of ['PositioningProbe.kt', 'PositioningJvmEntry.kt', 'PositioningWasmEntry.kt', 'RangeProbe.kt', 'ProbeOperations.kt.in']) {
    const bytes = await readRegular(local(name)); observerSources.push({ path: name, bytes: bytes.byteLength, sha256: sha256(bytes) });
}
for (const pin of recipe.originals) verifyFile(await readRegular(path.join(pin.sourceRoot === 'compiler-closure' ? sourceRoot : cache.positioningSourceRoot, pin.path), pin.bytes), pin);
const receipt = { schemaVersion: 1, kind: 'official-compiler-light-tree-range-slice-differential', status: 'passed', source: recipe.source,
    recipeSha256: prepared.receipt.recipeSha256, originalSourcePins: recipe.originals, externalTextRangeReference: recipe.externalReference,
    preparedProduction: prepared.receipt, sourceCacheReceiptSha256: sha256(await readRegular(cache.receiptPath)),
    hostReceiptSha256: sha256(await readRegular(host.receiptPath)), assertionPreparation: assertions.receipt, helperPin, parserReceiptSha256: sha256(parserReceiptBytes), parserInputs,
    sourceBuildFlagsSha256: sha256(flagsBytes), observerSources, buildScriptSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
    prepareScriptSha256: sha256(await readRegular(local('prepare.mjs'))), fetchScriptSha256: sha256(await readRegular(local('fetch.mjs'))),
    bootstrapVersion: bootstrap.lock.version, bootstrapCompilerSourceCommit: bootstrap.lock.compilerSourceCommit,
    bootstrapArtifacts: bootstrap.artifacts.map(({ path: ignored, ...pin }) => pin), commands, outputs: outputPins,
    comparison: { required: original.cases.length, passed: original.cases.length, failed: 0, skipped: 0, notRun: 0,
        originalJvmEqualsPortableJvm: true, originalJvmEqualsPortableWasm: true, strategyMethods: names.length, diagnosticTypedDispatch: 'not-run' },
    comparisonOnlyExclusions: excluded, wasmEngine: { kind: 'Node', version: process.version, flags: ['--experimental-wasm-exnref'] }, browserComparison: 'not-run',
    placeholderBridge: 'retained-unchanged', kmpSyntaxToLegacyTokenMapping: 'absent', r0DiagnosticPrecision: 'unverified-upstream-placeholder-boundary',
    browserCompiler: 'not-built', languageReadiness: false };
await put(output, 'positioning-evidence.json', Buffer.from(JSON.stringify(receipt, null, 2) + '\n'));
console.log(JSON.stringify({ output, status: receipt.status, comparison: receipt.comparison }));

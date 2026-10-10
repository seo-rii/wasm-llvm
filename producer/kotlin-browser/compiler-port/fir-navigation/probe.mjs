import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { prepareHostSources } from '../host/prepare.mjs';
import { preparePositioningSources } from '../positioning/prepare.mjs';
import { prepareFirNavigationSources, verifyFirNavigation } from './prepare.mjs';
import { balancedSpan, NAVIGATION_PATHS, transformNavigation } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..'), execute = promisify(execFile);
const relocated = text => text.replaceAll(/\bcom\.intellij\.(?!platform\.syntax\b)/g, 'org.jetbrains.kotlin.com.intellij.');
const stripImports = text => text.replace(/^import [^\r\n]+\r?\n/gm, '').replace(/^package[^\r\n]+\r?\n/gm, '');

// The body is retained; only declared fixture field/receiver types are substituted
// outside the compiler package. These payloads are never shipping FIR types.
export function projectNavigation(originals, tokenSet, portable) {
    const profile = transformNavigation(originals, tokenSet), boundaries = [];
    const bindings = { KtSourceElement: 'SourcePayload', KtLightSourceElement: 'SourcePayload',
        KtFakeSourceElementKind: 'SourceKindPayload', FirElement: 'ElementPayload', FirTypeRef: 'TypeRefPayload',
        FirDeclaration: 'DeclarationPayload', FirEnumEntry: 'EnumEntryPayload', FirValueParameterSymbol: 'ValueParameterPayload',
        FirBasedSymbol: 'SymbolPayload', FirImport: 'ImportPayload', FirModifierList: 'ModifierListBoundary', FirModifier: 'ModifierBoundary' };
    const bind = text => {
        for (const [before, after] of Object.entries(bindings)) text = text.replaceAll(new RegExp('\\b' + before + '\\b', 'g'), after);
        text = text.replace('SymbolPayload<*>', 'SymbolPayload').replace('@OptIn(SymbolInternals::class)\n', '');
        return text;
    };
    const sources = [];
    for (let index = 0; index < 3; index++) {
        let text = profile.outputs[index].bytes.toString();
        if (!portable && index === 1) text = text.replace('types.snapshotForSourceTraversal()', 'types.types.toSet()');
        if (!portable && index === 0) text = text.replace('ref.asChildrenRef()', 'ref').replace('ref.get()!!.firstOrNull()', 'ref.get().firstOrNull()');
        boundaries.push({ originalPath: NAVIGATION_PATHS[index], originalSha256: sha256(originals.get(NAVIGATION_PATHS[index])),
            preparedSha256: sha256(profile.outputs[index].bytes), fixtureReceiverBindings: bindings,
            sourceProfile: 'LightTree branch only; exact selected source-kind/offset/tree fields', shipping: false });
        sources.push(bind(stripImports(text)));
    }
    const checker = profile.outputs[3].bytes.toString();
    const annotations = balancedSpan(checker, '            is FirModifierList.FirLightModifierList -> {');
    const annotationBody = annotations.text.slice(annotations.text.indexOf('{') + 1, -1).trim();
    const keyword = 'source.treeStructure.valOrVarKeyword(source.lighterASTNode)?.toKtLightSourceElement(source.treeStructure)';
    assert.equal(checker.split(keyword).length, 2);
    boundaries.push({ originalPath: NAVIGATION_PATHS[3], annotationBranchSha256: sha256(Buffer.from(annotations.text)),
        keywordExpressionSha256: sha256(Buffer.from(keyword)), reportOnExecution: 'not-run', shipping: false });
    sources.push('fun ModifierListBoundary.FirLightModifierList.annotationSources(): List<SourcePayload> {\n' +
        '    val commonModifiersList = this\n    return run {\n' + bind(annotationBody) + '\n    }\n}\n' +
        'fun keywordSource(source: SourcePayload): SourcePayload? = ' + bind(keyword));
    const host = portable ? 'org.jetbrains.kotlin.portable.source' : 'org.jetbrains.kotlin.com.intellij';
    const imports = portable ? ['import org.jetbrains.kotlin.portable.source.*'] : [
        'import ' + host + '.lang.LighterASTNode', 'import ' + host + '.openapi.util.Ref', 'import ' + host + '.psi.tree.IElementType',
        'import ' + host + '.psi.tree.TokenSet', 'import ' + host + '.util.diff.FlyweightCapableTreeStructure'];
    imports.push('import org.jetbrains.kotlin.KtNodeTypes', 'import org.jetbrains.kotlin.KtNodeTypes.ANNOTATION_ENTRY',
        'import org.jetbrains.kotlin.lexer.KtTokens', 'import org.jetbrains.kotlin.lexer.KtKeywordToken',
        'import org.jetbrains.kotlin.lexer.KtModifierKeywordToken', 'import org.jetbrains.kotlin.util.getChildren',
        'import org.jetbrains.kotlin.utils.addToStdlib.butIf', 'import org.jetbrains.kotlin.utils.addToStdlib.popLast');
    const bytes = Buffer.from('/* Exact pinned method bodies; explicit payload receiver boundary, not full FIR. */\n' +
        'package org.jetbrains.kotlin.portable.firnavigation.probe\n' + imports.join('\n') + '\n' + sources.join('\n'));
    return { bytes, boundaries };
}

export async function loadRetainedBuild(buildRoot) {
    const receiptBytes = await readRegular(path.join(buildRoot, 'compiler-build-receipt.json')), receipt = JSON.parse(receiptBytes);
    assert.equal(receipt.status, 'failed'); assert.equal(receipt.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
    const argsBytes = await readRegular(path.join(buildRoot, 'compiler-klib.args'));
    const command = receipt.commands.find(item => item.phase === 'official-compiler-source-to-wasmjs-klib');
    assert.equal(sha256(argsBytes), command.argumentFileSha256);
    const args = argsBytes.toString().trimEnd().split('\n').map(line => JSON.parse(line));
    const filenames = args.slice(-receipt.compileSources.length), retainedSources = [];
    for (let index = 0; index < filenames.length; index++) {
        const filename = filenames[index], pin = receipt.compileSources[index], bytes = await readRegular(filename);
        assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256); retainedSources.push({ ...pin, filename });
    }
    return { retainedSources, evidence: { filename: path.join(buildRoot, 'compiler-build-receipt.json'), bytes: receiptBytes.length, sha256: sha256(receiptBytes),
        argumentFileSha256: sha256(argsBytes), selectedSources: retainedSources.length, recordedStatus: receipt.status, compilerExitCode: command.exitCode } };
}

export async function runFirNavigationProbe({ outputRoot, sourceRoot = path.join(repository, 'out/kotlin-compiler-port/sources'),
    buildRoot = path.join(repository, 'out/kotlin-compiler-port/builds/ast-dsl-whole-1791633110599192554') }) {
    outputRoot = path.resolve(outputRoot); assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep)); await mkdir(outputRoot, { mode: 0o700 });
    const selected = await loadRetainedBuild(buildRoot);
    const preparedHost = await prepareHostSources({ sourceRoot, outputRoot: path.join(outputRoot, 'host') });
    const preparedPositioning = await preparePositioningSources({ sourceRoot, outputRoot: path.join(outputRoot, 'positioning') });
    const prepared = await prepareFirNavigationSources({ sourceRoot, outputRoot: path.join(outputRoot, 'prepared'),
        retainedSources: selected.retainedSources, preparedHost, preparedPositioning });
    const verified = await verifyFirNavigation(prepared.outputRoot);
    const bootstrap = await verifyBootstrap(), flagsBytes = await readRegular(path.join(here, '../build-flags.json')), flags = JSON.parse(flagsBytes);
    const stdlib = bootstrap.artifacts.find(pin => pin.id === 'stdlib-jvm').path;
    const commands = [], artifacts = [], projections = [], originals = new Map();
    const lockBytes = await readRegular(path.join(here, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    for (const pin of lock.sources) originals.set(pin.path, verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin));
    async function run(phase, command, args) {
        const start = performance.now();
        try { const result = await execute(command, args, { cwd: outputRoot, timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
            commands.push({ phase, command: [command, ...args], exitCode: 0, elapsedMs: performance.now() - start });
            if (result.stderr) process.stderr.write(result.stderr); return result.stdout;
        } catch (error) { await writeJson(path.join(outputRoot, 'failure.json'), { phase, exitCode: error.code, commands,
            stderr: String(error.stderr ?? '').slice(-16384) }); if (error.stderr) process.stderr.write(String(error.stderr).slice(-16384)); throw new Error(phase + ' failed'); }
    }
    async function put(relative, bytes) { const filename = path.join(outputRoot, relative); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); return filename; }
    const jvm = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect',
        '-jvm-target', '17', '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags];
    const originalFull = [];
    for (const relative of NAVIGATION_PATHS) originalFull.push(await put('actual-original/' + relative, Buffer.from(relocated(originals.get(relative).toString()))));
    await run('four-complete-original-selected-source-jvm-typecheck', 'java', [...jvm, '-classpath', bootstrap.classPath,
        '-d', path.join(outputRoot, 'actual-original.jar'), ...originalFull]);
    const recipe = JSON.parse(await readRegular(path.join(here, '../positioning/positioning.recipe.json')));
    const declarations = [], originalPositioning = new Map();
    for (const pin of recipe.originals) {
        const source = path.join(pin.sourceRoot === 'compiler-closure' ? sourceRoot : path.join(repository, 'out/kotlin-positioning-sources'), pin.path);
        const bytes = verifyFile(await readRegular(source), pin); originalPositioning.set(pin.path, bytes);
        if (pin.path.endsWith('.java')) declarations.push(await put('original-declarations/' + pin.path, Buffer.from(relocated(bytes.toString()))));
    }
    const classes = path.join(outputRoot, 'original-classes'); await mkdir(classes, { mode: 0o700 });
    await run('genuine-original-token-declarations-javac', 'javac', ['-classpath', bootstrap.classPath, '-d', classes, ...declarations]);
    const originalClassPath = classes + path.delimiter + bootstrap.classPath;
    const observed = {};
    for (const variant of ['original', 'common']) {
        const portable = variant === 'common', tokenSet = await readRegular(path.join(here, '../positioning/TokenSet.kt'));
        const projection = projectNavigation(originals, tokenSet, portable), projectionFile = await put(variant + '/NavigationBoundaries.kt', projection.bytes);
        projections.push({ variant, path: variant + '/NavigationBoundaries.kt', bytes: projection.bytes.length, sha256: sha256(projection.bytes), boundaries: projection.boundaries });
        const sources = [projectionFile];
        const helperPath = 'compiler/frontend.common/src/org/jetbrains/kotlin/util/LightTreeUtils.kt';
        const helper = portable ? await readRegular(preparedPositioning.commonSources.find(file => file.endsWith('/LightTreeUtils.kt'))) : Buffer.from(relocated(originalPositioning.get(helperPath).toString()));
        sources.push(await put(variant + '/LightTreeUtils.kt', helper));
        const treeHelpers = originalPositioning.get('compiler/frontend.common-psi/src/org/jetbrains/kotlin/diagnostics/LightTreePositioningStrategies.kt').toString();
        const helperBodies = [balancedSpan(treeHelpers, 'fun FlyweightCapableTreeStructure<LighterASTNode>.findChildByType(node: LighterASTNode, type: IElementType)').text,
            balancedSpan(treeHelpers, 'fun FlyweightCapableTreeStructure<LighterASTNode>.findChildByType(node: LighterASTNode, type: TokenSet)').text,
            'fun FlyweightCapableTreeStructure<LighterASTNode>.nameIdentifier(node: LighterASTNode): LighterASTNode? =\n    findChildByType(node, IDENTIFIER)',
            'fun FlyweightCapableTreeStructure<LighterASTNode>.valOrVarKeyword(node: LighterASTNode): LighterASTNode? =\n    findChildByType(node, VAL_VAR)',
            'fun FlyweightCapableTreeStructure<LighterASTNode>.getAncestors(node: LighterASTNode): Sequence<LighterASTNode> =\n    generateSequence(getParent(node)) { getParent(it) }'];
        for (const text of helperBodies.slice(2)) assert.equal(treeHelpers.split(text).length, 2, 'Original helper expression changed');
        let helpers = helperBodies.join('\n');
        if (portable) helpers = helpers.replaceAll('getChildren(node, childrenRef)', 'getChildren(node, childrenRef.asChildrenRef())');
        const imports = projection.bytes.toString().slice(projection.bytes.toString().indexOf('import '), projection.bytes.toString().indexOf('/**'));
        sources.push(await put(variant + '/TreeHelpers.kt', Buffer.from('package org.jetbrains.kotlin.portable.firnavigation.probe\n' +
            imports + '\nimport org.jetbrains.kotlin.lexer.KtTokens.IDENTIFIER\nimport org.jetbrains.kotlin.lexer.KtTokens.VAL_VAR\n' + helpers)));
        const template = (await readRegular(path.join(here, 'NavigationProbe.kt.in'))).toString();
        const carrierImports = portable ? 'import org.jetbrains.kotlin.portable.source.*' : [
            'import org.jetbrains.kotlin.com.intellij.lang.LighterASTNode', 'import org.jetbrains.kotlin.com.intellij.openapi.util.Ref',
            'import org.jetbrains.kotlin.com.intellij.psi.tree.IElementType', 'import org.jetbrains.kotlin.com.intellij.psi.tree.TokenSet',
            'import org.jetbrains.kotlin.com.intellij.util.diff.FlyweightCapableTreeStructure'].join('\n');
        const nodeMembers = portable ? '    override val tokenType: IElementType get() = type\n    override val startOffset: Int get() = start\n    override val endOffset: Int get() = end' :
            '    override fun getTokenType(): IElementType = type\n    override fun getStartOffset(): Int = start\n    override fun getEndOffset(): Int = end';
        const substitutions = { IMPORTS: carrierImports, NODE_MEMBERS: nodeMembers, SUFFIX: portable ? '' : '?',
            SNAPSHOT: portable ? 'snapshotForSourceTraversal()' : 'types.toSet()' };
        let observer = template; for (const [name, value] of Object.entries(substitutions)) observer = observer.replaceAll('@' + name + '@', value);
        assert(!/@(?:IMPORTS|NODE_MEMBERS|SUFFIX|SNAPSHOT)@/.test(observer));
        sources.push(await put(variant + '/NavigationProbe.kt', Buffer.from(observer)));
        const helperPin = lock.sources.find(pin => pin.path === 'core/util.runtime/src/org/jetbrains/kotlin/utils/addToStdlib.kt'); assert(helperPin);
        const addToStdlib = verifyFile(await readRegular(path.join(sourceRoot, helperPin.path)), helperPin);
        const addition = addToStdlib.toString(), butIf = balancedSpan(addition, 'inline fun <A : B, B> A.butIf(').text;
        const popLast = 'fun <E> MutableList<E>.popLast(): E = removeAt(lastIndex)'; assert.equal(addition.split(popLast).length, 2);
        sources.push(await put(variant + '/CollectionHelpers.kt', Buffer.from('@file:OptIn(kotlin.contracts.ExperimentalContracts::class, kotlin.contracts.ExperimentalExtendedContracts::class)\n' +
            'package org.jetbrains.kotlin.utils.addToStdlib\nimport kotlin.contracts.*\n' + butIf + '\n' + popLast)));
        if (portable) for (const name of ['KtTokens.kt', 'KtNodeTypes.kt', 'KtStubBasedElementTypes.kt', 'LegacyTokens.kt', 'LegacyNodeType.kt', 'KDocTokens.kt'])
            sources.push(preparedPositioning.commonSources.find(file => file.endsWith('/' + name)));
        if (portable) sources.push(preparedHost.commonSources.find(file => file.endsWith('/PortableLightTree.kt')), prepared.commonSources.find(file => file.endsWith('/TokenSet.kt')));
        const jar = path.join(outputRoot, variant + '/boundary.jar');
        await run(variant + '-exact-light-tree-boundary-jvm-build', 'java', [...jvm, '-classpath', portable ? stdlib : originalClassPath,
            ...(portable ? ['-Xmulti-platform', '-Xcommon-sources=' + sources.join(',')] : []), '-d', jar, ...sources, path.join(here, 'JvmEntry.kt')]);
        observed[variant] = await run(variant + '-exact-light-tree-boundary-jvm-observe', 'java', ['-ea', '-cp', jar + path.delimiter + (portable ? stdlib : originalClassPath),
            'org.jetbrains.kotlin.portable.firnavigation.probe.JvmEntryKt']);
        await put(variant + '-observations.txt', Buffer.from(observed[variant]));
        if (!portable) {
            const agreementJar = path.join(outputRoot, 'actual-source-agreement.jar');
            await run('actual-original-source-wrapper-agreement-jvm-build', 'java', [...jvm, '-classpath', originalClassPath, '-d', agreementJar,
                ...originalFull, ...sources, path.join(here, 'ActualJvmProbe.kt')]);
            observed.actualJvmAgreement = await run('actual-original-source-wrapper-agreement-jvm-observe', 'java', ['-ea', '-cp', agreementJar + path.delimiter + originalClassPath,
                'org.jetbrains.kotlin.portable.firnavigation.probe.ActualJvmProbeKt']);
            await put('actual-source-agreement-observations.txt', Buffer.from(observed.actualJvmAgreement));
        }
        if (portable) {
            assert.equal(observed.common, observed.original, 'Original/common JVM LightTree boundaries differ');
            for (const name of ['klib', 'wasm']) await mkdir(path.join(outputRoot, name), { mode: 0o700 });
            const wasm = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js',
                '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, '-libraries', bootstrap.wasmJsStdlib, ...flags.compilerFlags];
            await run('common-exact-light-tree-boundary-wasmjs-klib-build', 'java', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + sources.join(','), '-Xir-produce-klib-file', '-ir-output-dir', path.join(outputRoot, 'klib'),
                '-ir-output-name', 'fir-navigation', ...sources, path.join(here, 'WasmEntry.kt')]);
            await run('common-exact-light-tree-boundary-wasmjs-binary-build', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + path.join(outputRoot, 'klib/fir-navigation.klib'),
                '-ir-output-dir', path.join(outputRoot, 'wasm'), '-ir-output-name', 'fir-navigation', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
            observed.wasm = await run('common-exact-light-tree-boundary-node-wasmjs-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e',
                'const m = await import(process.argv[1]); process.stdout.write(m.firNavigationSnapshot());', pathToFileURL(path.join(outputRoot, 'wasm/fir-navigation.mjs')).href]);
            await put('wasm-observations.txt', Buffer.from(observed.wasm));
        }
    }
    assert.equal(observed.common, observed.original, 'Original/common JVM LightTree boundaries differ');
    assert.equal(observed.wasm, observed.original, 'Original JVM/actual Node Wasm LightTree boundaries differ');
    for (const relative of ['actual-original.jar', 'actual-source-agreement.jar', 'actual-source-agreement-observations.txt', 'original/boundary.jar', 'common/boundary.jar', 'klib/fir-navigation.klib',
        'original-observations.txt', 'common-observations.txt', 'wasm-observations.txt', ...(await readdir(path.join(outputRoot, 'wasm'))).sort().map(name => 'wasm/' + name)]) {
        const bytes = await readRegular(path.join(outputRoot, relative)); artifacts.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
    }
    const observers = []; for (const name of ['NavigationProbe.kt.in', 'ActualJvmProbe.kt', 'JvmEntry.kt', 'WasmEntry.kt']) { const bytes = await readRegular(path.join(here, name)); observers.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); }
    const receipt = { schemaVersion: 1, kind: 'official-fir-navigation-bounded-light-tree-differential', result: 'pass', source: lock.source,
        sourceLockSha256: sha256(lockBytes), preparationReceiptSha256: verified.receiptSha256, preparation: verified.receipt, selectedBuild: selected.evidence,
        probeToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))), compilerFlagsSha256: sha256(flagsBytes), observers, projections, commands, artifacts,
        bootstrap: { version: bootstrap.lock.version, compilerSourceCommit: null, artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
        comparison: { observations: observed.original.trimEnd().split('\n').length, originalJvmSha256: sha256(Buffer.from(observed.original)),
            commonJvmSha256: sha256(Buffer.from(observed.common)), commonWasmSha256: sha256(Buffer.from(observed.wasm)), rawOutputNormalization: false },
        actualOriginalJvmAgreement: { observations: observed.actualJvmAgreement.trimEnd().split('\n').length, sha256: sha256(Buffer.from(observed.actualJvmAgreement)),
            classes: 'Genuine KtLightSourceElement and FirImport objects; full pinned functions, verified bootstrap receiver/builder helpers' },
        fullOriginalFourFilesJvm: 'typechecked; source traversal/import/modifier/raw-identifier paths independently executed', sourceAndFirReceiverPayloads: 'explicit method-boundary fixtures outside compiler package',
        fullFirCheckerExecution: 'not-run', fullFirWasmRuntime: 'not-run', generalTokenSetGetTypesParity: false,
        kmpSyntaxToLegacyTokenMapping: 'absent', fullCompilerBuilt: false, publicLanguageSupport: false };
    await writeJson(path.join(outputRoot, 'differential.json'), receipt); return { outputRoot, receipt };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    assert.equal(process.argv.length, 3); const result = await runFirNavigationProbe({ outputRoot: process.argv[2] });
    console.log(JSON.stringify({ outputRoot: result.outputRoot, result: result.receipt.result, comparison: result.receipt.comparison, fullFirCheckerExecution: 'not-run' }));
}

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { prepareDescriptorContracts } from '../descriptors/prepare.mjs';
import { frozenInputs } from '../k1-container-profile/check.mjs';
import { prepareDescriptorVisitorContracts, verifyDescriptorVisitorContracts } from './prepare.mjs';
import { MODULE, OUTPUT, inspectVisitorConsumers } from './transform.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..'), execute = promisify(execFile);
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources');
const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
const outputRoot = path.resolve(process.argv[2]); assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep));
await mkdir(outputRoot, { mode: 0o700 });
const bootstrap = await verifyBootstrap(), commands = [], outputs = [];
async function store(name, bytes) {
    const filename = path.join(outputRoot, name); await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
    outputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); return filename;
}
async function run(phase, command, args, expectedCode = 0) {
    console.log('phase: ' + phase);
    try {
        const result = await execute(command, args, { cwd: outputRoot, timeout: 240000, maxBuffer: 16 * 1024 * 1024 });
        commands.push({ phase, command: [command, ...args], exitCode: 0 }); assert.equal(expectedCode, 0);
        if (result.stderr) process.stderr.write(result.stderr); return result.stdout;
    } catch (error) {
        commands.push({ phase, command: [command, ...args], exitCode: error.code });
        const stderr = String(error.stderr ?? ''); await store(phase + '-stderr.txt', Buffer.from(stderr));
        if (error.code !== expectedCode) process.stderr.write(stderr.slice(-16000));
        assert.equal(error.code, expectedCode, phase + ' unexpected exit'); return stderr;
    }
}
const preparedDescriptors = await prepareDescriptorContracts(sourceRoot, path.join(outputRoot, 'descriptor-predecessor'));
const frozen = await frozenInputs(path.join(REPO, 'out/kotlin-compiler-port/builds/ast-dsl-whole-1791633110599192554'));
const historical = [];
for (const pin of frozen.retainedSources) {
    const source = await readRegular(pin.filename); assert.equal(source.length, pin.bytes); assert.equal(sha256(source), pin.sha256);
    historical.push({ path: pin.path, source });
}
const historicalGuard = inspectVisitorConsumers(historical, lock.contracts);
const retainedSources = frozen.retainedSources.map(pin => {
    const original = lock.originals.find(item => item.path === pin.path);
    return original ? { path: pin.path, filename: path.join(sourceRoot, pin.path), bytes: original.bytes, sha256: original.sha256 } : pin;
});
const previous = preparedDescriptors.receipt.files.find(pin => pin.path === 'DeclarationDescriptor.kt');
const canonicalVisitor = preparedDescriptors.receipt.files.find(pin => pin.path === 'DeclarationDescriptorVisitor.kt');
const visitorIndex = retainedSources.findIndex(pin => pin.path === 'compiler-port-descriptors/generated/DeclarationDescriptorVisitor.kt');
assert(visitorIndex >= 0);
retainedSources[visitorIndex] = { path: retainedSources[visitorIndex].path, filename: canonicalVisitor.absolutePath,
    bytes: canonicalVisitor.bytes, sha256: canonicalVisitor.sha256 };
const baseIndex = retainedSources.findIndex(pin => pin.path === OUTPUT); assert(baseIndex >= 0);
retainedSources[baseIndex] = { path: OUTPUT, filename: previous.absolutePath, bytes: previous.bytes, sha256: previous.sha256 };
const prepared = await prepareDescriptorVisitorContracts({ sourceRoot, outputRoot: path.join(outputRoot, 'profile'), preparedDescriptors, retainedSources });
await verifyDescriptorVisitorContracts({ sourceRoot, profileRoot: path.join(outputRoot, 'profile'), preparedDescriptors, retainedSources });
const probe = await store('Probe.kt', await readRegular(path.join(HERE, 'Probe.kt')));
const originals = new Map(), common = new Map(), javaSources = [];
for (const pin of [...lock.originals, ...lock.probeOriginals]) {
    const bytes = verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin);
    originals.set(pin.path, await store('original/' + pin.path, bytes));
    const preparedSource = prepared.commonSources.find(name => name.endsWith('/' + pin.path));
    common.set(pin.path, preparedSource ?? originals.get(pin.path));
}
for (const pin of lock.javaOriginals) javaSources.push(await store('java/' + path.basename(pin.path),
    verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin)));
const compiler = bootstrap.artifacts.find(pin => pin.id === 'compiler').path;
const java = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect',
    '-Xfriend-paths=' + compiler, '-jvm-target', '17', '-language-version', '2.5', '-api-version', '2.5',
    '-opt-in=org.jetbrains.kotlin.K1Deprecation', '-opt-in=org.jetbrains.kotlin.ir.ObsoleteDescriptorBasedAPI',
    '-opt-in=org.jetbrains.kotlin.ir.symbols.UnsafeDuringIrConstructionAPI'];
const classes = path.join(outputRoot, 'java-classes'); await mkdir(classes);
await run('actual-full-java-descriptor-visitor-contracts', 'javac', ['-cp', bootstrap.classPath, '-d', classes, ...javaSources]);
const classPath = [classes, bootstrap.classPath].join(path.delimiter), variants = {}, jars = {};
for (const [variant, sources] of [['original', [...originals.values()]], ['common', [...common.values()]]]) {
    const jar = path.join(outputRoot, variant + '.jar'); jars[variant] = jar;
    await run(variant + '-full-real-descriptor-sources-jvm-build', 'java', [...java, '-classpath', classPath, '-d', jar, ...sources, probe]);
    variants[variant] = await run(variant + '-all-twelve-real-receiver-observe', 'java',
        ['-cp', [jar, classPath].join(path.delimiter), 'org.jetbrains.kotlin.portable.descriptorvisitor.probe.ProbeKt']);
    await store(variant + '-observations.txt', Buffer.from(variants[variant]));
    const bytes = await readRegular(jar); outputs.push({ path: variant + '.jar', bytes: bytes.length, sha256: sha256(bytes) });
}
assert.equal(variants.common, variants.original, 'Full original/common descriptor raw dispatch differs');
const generatedVisitorNegative = await run('unclosed-full-real-sources-generated-Visitor-Void-negative-jvm-build', 'java',
    [...java, '-classpath', classPath, '-d', path.join(outputRoot, 'visitor-Void-unclosed.jar'),
        ...common.values(), canonicalVisitor.absolutePath, probe], 1);
const visitorVoidDiagnostics = generatedVisitorNegative.split('\n').filter(line => line.includes('error:'));
assert(visitorVoidDiagnostics.length > 0);
for (const line of visitorVoidDiagnostics) assert(line.includes("null cannot be a value of a non-null type 'Void'"),
    'Unexpected generated Visitor failure beyond the recorded unclosed Void boundary');
// No compiler classes are invented: each selected generic body is an extension
// on its genuine source receiver type, using both complete generated interfaces.
const genericProjection = await store('GenericEntries.kt', Buffer.from('package org.jetbrains.kotlin.portable.descriptorvisitor.generic\n\n' +
    'import org.jetbrains.kotlin.descriptors.DeclarationDescriptorVisitor\n\n' +
    lock.recipes.map((recipe, index) => {
        const signature = recipe.prepared.replace(/^override fun /, 'fun ').replace(' accept(', ' ' + recipe.owner + '.entry' + index + '(');
        assert(signature.includes(recipe.owner + '.entry' + index + '('));
        return signature;
    }).join('\n\n') + '\n\nval genericOwners = listOf(' + lock.recipes.map(recipe => JSON.stringify(recipe.owner)).join(',') + ')\n'));
const genericBase = path.join(outputRoot, 'nullable-base.jar');
const moduleImpl = lock.probeOriginals.find(pin => pin.path.endsWith('/ModuleDescriptorImpl.kt')).path;
// Full actual Module interface compiles against both genuine generated contracts.
// Actual ModuleImpl source remains an explicit failed Void typecheck below.
await run('actual-module-nullable-generated-base-jvm-build', 'java', [...java, '-classpath',
    [jars.common, classPath].join(path.delimiter), '-d', genericBase,
    common.get(MODULE), previous.absolutePath, canonicalVisitor.absolutePath, genericProjection, probe]);
variants.nullableBase = await run('actual-module-nullable-generated-base-observe', 'java',
    ['-cp', [genericBase, jars.common, classPath].join(path.delimiter), 'org.jetbrains.kotlin.portable.descriptorvisitor.probe.ProbeKt', '--generic-projection']);
assert.equal(variants.nullableBase, variants.original, 'Nullable base changed raw actual JVM source dispatch');
await store('nullable-base-observations.txt', Buffer.from(variants.nullableBase));
const baseBytes = await readRegular(genericBase); outputs.push({ path: 'nullable-base.jar', bytes: baseBytes.length, sha256: sha256(baseBytes) });
const voidNegative = await run('unclosed-module-impl-Void-mapping-negative-jvm-build', 'java', [...java,
    '-classpath', [jars.common, classPath].join(path.delimiter), '-d', path.join(outputRoot, 'void-unclosed.jar'),
    common.get(MODULE), common.get(moduleImpl), previous.absolutePath, canonicalVisitor.absolutePath], 1);
assert(voidNegative.includes('acceptVoid') && voidNegative.includes('Nothing?'), 'Real unclosed Void typecheck must remain');

const originalOverrideFailure = await run('previous-nonnull-module-against-nullable-base-negative-jvm-build', 'java',
    [...java, '-classpath', classPath, '-d', path.join(outputRoot, 'prior-failure.jar'), originals.get(MODULE), previous.absolutePath], 1);
assert(originalOverrideFailure.includes("'accept' overrides nothing"), 'Prior actual override failure must be reproduced');
const fixedCaller = await store('NullableCaller.kt', Buffer.from('import org.jetbrains.kotlin.descriptors.*\n' +
    'fun literal(m: ModuleDescriptor) = m.accept<String?, String?>(null, null)\n' +
    'fun typed(m: ModuleDescriptor, v: DeclarationDescriptorVisitor<String?, String?>?) = m.accept(v, null)\n' +
    'fun inferred(m: ModuleDescriptor, v: DeclarationDescriptorVisitor<String?, String?>, b: Boolean) = m.accept(if (b) v else null, null)\n'));
await run('nullable-platform-callers-positive-jvm-typecheck', 'java', [...java, '-classpath',
    [genericBase, jars.common, classPath].join(path.delimiter), '-d', path.join(outputRoot, 'nullable-callers.jar'), fixedCaller]);
const callerBytes = await readRegular(path.join(outputRoot, 'nullable-callers.jar')); outputs.push({ path: 'nullable-callers.jar', bytes: callerBytes.length, sha256: sha256(callerBytes) });
const ownerRecords = lock.recipes.map(recipe => {
    const messageHex = Buffer.from(recipe.nullMessage, 'utf16le').swap16().toString('hex');
    const matching = variants.original.trimEnd().split('\n').filter(line => line.includes(':null:') && line.endsWith(messageHex));
    assert.equal(matching.length, 13, 'Every actual source owner null entry must execute');
    for (const record of matching) {
        assert(record.includes('\tjava.lang.NullPointerException\t'), 'Original nonnull visitor null entry must throw NPE');
        assert(record.endsWith(messageHex), 'Original method NPE message differs');
    }
    return { owner: recipe.owner, observedOriginalNullEntries: matching.length, exactMessage: recipe.nullMessage };
});
// The legacy bootstrap receiver has a real older DefaultImpls bridge. Preserve
// that raw negative rather than fabricating stack/caller-context behavior.
const legacySource = await store('LegacyProbe.kt', Buffer.from([
    'package org.jetbrains.kotlin.portable.descriptorvisitor.legacy',
    'import java.lang.reflect.InvocationTargetException',
    'import org.jetbrains.kotlin.builtins.DefaultBuiltIns',
    'import org.jetbrains.kotlin.descriptors.*',
    'import org.jetbrains.kotlin.descriptors.impl.ModuleDescriptorImpl',
    'import org.jetbrains.kotlin.name.Name',
    'import org.jetbrains.kotlin.storage.LockBasedStorageManager',
    'fun main() {',
    ' val module = ModuleDescriptorImpl(Name.special("<legacy>"), LockBasedStorageManager.NO_LOCKS, DefaultBuiltIns.Instance)',
    ' try { ModuleDescriptor::class.java.getMethod("accept", DeclarationDescriptorVisitor::class.java, Any::class.java).invoke(module, null, null); error("Expected null entry rejection") }',
    ' catch (caught: InvocationTargetException) { val e = caught.targetException; println((e::class.simpleName ?: "null") + "\\t" + (e.message?.map { it.code.toString(16).padStart(4, \'0\') }?.joinToString("") ?: "null")) }',
    '}',
].join('\n') + '\n'));
const legacyJar = path.join(outputRoot, 'legacy.jar');
await run('original-interface-with-real-legacy-bootstrap-receiver-build', 'java', [...java,
    '-classpath', classPath, '-d', legacyJar, originals.get(MODULE), legacySource]);
const legacyText = await run('real-legacy-bootstrap-DefaultImpls-message-observe', 'java',
    ['-cp', [legacyJar, classPath].join(path.delimiter), 'org.jetbrains.kotlin.portable.descriptorvisitor.legacy.LegacyProbeKt']);
const modernMessage = lock.recipes.find(recipe => recipe.path === MODULE).nullMessage;
const legacyMessage = modernMessage.replace('ModuleDescriptor.accept', 'ModuleDescriptor$DefaultImpls.accept');
assert.equal(legacyText, 'NullPointerException\t' + Buffer.from(legacyMessage, 'utf16le').swap16().toString('hex') + '\n');
assert.notEqual(legacyMessage, modernMessage);
await store('legacy-bridge-observations.txt', Buffer.from(legacyText));
const legacyBytes = await readRegular(legacyJar); outputs.push({ path: 'legacy.jar', bytes: legacyBytes.length, sha256: sha256(legacyBytes) });
const observedEntryOwners = variants.original.split('\n').filter(line => line.startsWith('entry-check:')).map(line => line.split('\t')[0].slice('entry-check:'.length));
assert.equal(observedEntryOwners.length, 12);
assert.deepEqual([...observedEntryOwners].sort(), lock.recipes.map(recipe => recipe.owner).sort());
const entryOrder = observedEntryOwners.map(owner => lock.recipes.findIndex(recipe => recipe.owner === owner));
const projected = await store('CheckedEntries.kt', Buffer.from('package org.jetbrains.kotlin.portable.descriptorvisitor.guard\n\n' +
    lock.recipes.map((recipe, index) => {
        const statement = 'if (visitor == null) throw NullPointerException(' + JSON.stringify(recipe.nullMessage) + ')';
        assert(recipe.prepared.includes(statement));
        return 'fun entry' + index + '(visitor: Any?) {\n    ' + statement + '\n}\n';
    }).join('\n') + '\nval entryFunctions: List<(Any?) -> Unit> = listOf(' + entryOrder.map(index => '::entry' + index).join(',') + ')\n' +
    'val entryOwners = listOf(' + observedEntryOwners.map(owner => JSON.stringify(owner)).join(',') + ')\n'));
const guardProbe = await store('GuardProbe.kt', await readRegular(path.join(HERE, 'GuardProbe.kt')));
const guardJvm = await store('GuardJvmEntry.kt', Buffer.from('package org.jetbrains.kotlin.portable.descriptorvisitor.guard\nfun main() { print(observeCheckedEntries()) }\n'));
const guardWasm = await store('GuardWasmEntry.kt', Buffer.from('@file:OptIn(kotlin.js.ExperimentalWasmJsInterop::class)\npackage org.jetbrains.kotlin.portable.descriptorvisitor.guard\n@kotlin.js.JsExport fun descriptorVisitorGuardObservation(): String = observeCheckedEntries()\n'));
const stdlib = bootstrap.artifacts.find(pin => pin.id === 'stdlib-jvm').path;
const guardJar = path.join(outputRoot, 'guard.jar');
await run('exact-null-entry-projection-common-jvm-build', 'java', [...java, '-classpath', stdlib, '-d', guardJar, projected, guardProbe, guardJvm]);
const guardJvmText = await run('exact-null-entry-projection-common-jvm-observe', 'java',
    ['-cp', [guardJar, stdlib].join(path.delimiter), 'org.jetbrains.kotlin.portable.descriptorvisitor.guard.GuardJvmEntryKt']);
const wasm = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js',
    '-libraries', bootstrap.wasmJsStdlib, '-language-version', '2.5', '-api-version', '2.5'];
const projectedSources = [projected, guardProbe];
await run('exact-null-entry-projection-common-wasm-klib-build', 'java', [...wasm, '-Xmulti-platform',
    '-Xcommon-sources=' + projectedSources.join(','), '-ir-output-dir', path.join(outputRoot, 'klib'),
    '-ir-output-name', 'visitor-entry', ...projectedSources, guardWasm]);
await run('exact-null-entry-projection-common-wasm-module-build', 'java', [...wasm, '-Xir-produce-js',
    '-Xinclude=' + path.join(outputRoot, 'klib/visitor-entry.klib'), '-ir-output-dir', path.join(outputRoot, 'wasm'),
    '-ir-output-name', 'visitor-entry', '-main', 'noCall']);
const guardWasmText = await run('exact-null-entry-projection-node-wasm-observe', process.execPath,
    ['--experimental-wasm-exnref', '--input-type=module', '-e',
        'const m=await import(process.argv[1]);process.stdout.write(m.descriptorVisitorGuardObservation());',
        pathToFileURL(path.join(outputRoot, 'wasm/visitor-entry.mjs')).href]);
assert.equal(guardWasmText, guardJvmText, 'Exact statement JVM/Wasm raw null-check outcomes differ');
const originalEntry = variants.original.split('\n').filter(line => line.startsWith('entry-check:')).join('\n') + '\n';
const projectedEntry = guardJvmText.split('\n').filter(line => line.startsWith('entry-check:')).join('\n') + '\n';
assert.equal(projectedEntry, originalEntry, 'Projected null-check outcomes differ from full original source actual receivers');
assert.equal(originalEntry.trimEnd().split('\n').length, 12);
await store('entry-common-jvm-observations.txt', Buffer.from(guardJvmText)); await store('entry-common-wasm-observations.txt', Buffer.from(guardWasmText));
for (const name of ['guard.jar', 'klib/visitor-entry.klib', ...(await readdir(path.join(outputRoot, 'wasm'))).map(name => 'wasm/' + name)]) {
    const bytes = await readRegular(path.join(outputRoot, name)); outputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
}
const receipt = { schemaVersion: 1, kind: 'actual-descriptor-visitor-full-source-jvm-null-dispatch-differential', sourceLockSha256: sha256(lockBytes),
    buildToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))), preparation: prepared.receipt, predecessor: preparedDescriptors.receipt,
    historicalSelectedSourceAudit: { ...frozen.binding, ...historicalGuard },
    preparationInputProjection: 'Exactly 13 visitor-bearing originals and both canonical generated contracts rebound to verified pre-global-import sources; all remaining historical selection bytes preserved',
    observers: await Promise.all(['Probe.kt', 'GuardProbe.kt'].map(async name => {
        const bytes = await readRegular(path.join(HERE, name)); return { path: name, bytes: bytes.length, sha256: sha256(bytes) };
    })),
    commands, outputs, ownerRecords, observations: variants.original.trimEnd().split('\n').length, rawOutputNormalized: false,
    originalJvmEqualsCommonJvm: true, actualNullableBaseModuleJvmEqualsOriginalJvm: true, priorCommonOverrideFailureReproduced: true,
    nullablePlatformCallersAccepted: 3, originalNonnullGenericReceiversExecuted: 12, nullableFirReceiversExecuted: 2,
    allTwentyNineNullableBodiesPreservedByExactSpans: true, originalVoidBodiesUnchanged: true, actualModuleImplPortableTypecheck: 'expected-failure-unclosed-Void',
    generatedVisitorReturnContract: { bytes: canonicalVisitor.bytes, sha256: canonicalVisitor.sha256, unchangedReturns: 'R',
        exactTwelveGenericBodiesActualReceiverJvmProjection: true, fullActualSourceTypecheck: 'expected-failure-unclosed-Void',
        preservedVoidDiagnostics: visitorVoidDiagnostics },
    nullEntryProjection: { statements: 12, observations: 24, originalActualReceiversNullMatchesCommonJvmAndNodeWasm: true,
        commonJvmEqualsNodeWasm: true, nonnullMarkers: 'Genuine stdlib Any values for null-check-only projection; no compiler descriptor/visitor models',
        scope: 'Exact shipping null-entry statements only; full descriptor body/visitor graph is not executed on Wasm', normalizedText: false }, portableVoidTypeMappingClosed: false,
    bootstrap: { version: bootstrap.lock.version, sourceCommit: null, artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
    genuineDependencies: 'Full actual selected descriptor sources, actual source ModuleDescriptorImpl/default interface; verified bootstrap real descriptor/IR/metadata classes and visitor implementation. Compiler.jar friend path preserves actual internal source access; bootstrap source commit unpublished.',
    scope: 'All 12 full original/common nonnull generic source implementations execute on actual receivers on JVM. Actual Module interface typechecks against both unchanged generated contracts and executes with the separately source-compiled modern ModuleImpl on JVM; the ModuleImpl source typecheck with nullable base still fails at Void. Other source contracts use original real Java platform interfaces for JVM proof; full portable descriptor graph and Void mapping remain unclosed.',
    legacyDefaultImplsMessageParity: false, wasmRuntime: 'exact-null-entry-statements-only', browserRuntime: 'not-run', fullCompilerBuilt: false, languageReadiness: false };
await writeJson(path.join(outputRoot, 'receipt.json'), receipt);
console.log(JSON.stringify({ outputRoot, observations: receipt.observations, actualJvmDispatch: 'pass', sourceOwners: ownerRecords.length, historicalInputs: historical.length }));

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { prepareDescriptorContracts } from '../descriptors/prepare.mjs';
import { prepareDescriptorVisitorContracts } from '../descriptor-visitor-contract/prepare.mjs';
import { frozenInputs } from '../k1-container-profile/check.mjs';
import { prepareVisitorVoidProfile, verifyVisitorVoidProfile } from './prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..'), execute = promisify(execFile);
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources');
const outputRoot = path.resolve(process.argv[2]); assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep)); await mkdir(outputRoot, { mode: 0o700 });
const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
const priorLock = JSON.parse(await readRegular(path.join(HERE, '../descriptor-visitor-contract/sources.lock.json')));
const bootstrap = await verifyBootstrap(), commands = [], artifacts = [];
async function store(name, bytes) { const filename = path.join(outputRoot, name); await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); artifacts.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); return filename; }
async function run(phase, command, args) { console.log('phase: ' + phase);
    try { const result = await execute(command, args, { cwd: outputRoot, timeout: 240000, maxBuffer: 16 * 1024 * 1024 });
        commands.push({ phase, command: [command, ...args], exitCode: 0 }); if (result.stderr) process.stderr.write(result.stderr); return result.stdout;
    } catch (error) { commands.push({ phase, command: [command, ...args], exitCode: error.code });
        process.stderr.write(String(error.stderr ?? '').slice(-22000)); throw error; } }
const preparedDescriptors = await prepareDescriptorContracts(sourceRoot, path.join(outputRoot, 'descriptor-predecessor'));
const frozen = await frozenInputs(path.join(REPO, 'out/kotlin-compiler-port/builds/consumer-bindings-whole-1791638978998014789'));
const canonical = frozen.retainedSources.map(pin => {
    const original = priorLock.originals.find(item => item.path === pin.path);
    if (original) return { path: pin.path, filename: path.join(sourceRoot, pin.path), bytes: original.bytes, sha256: original.sha256 };
    const name = pin.path === 'compiler-port-descriptors/generated/DeclarationDescriptor.kt' ? 'DeclarationDescriptor.kt' :
        pin.path === 'compiler-port-descriptors/generated/DeclarationDescriptorVisitor.kt' ? 'DeclarationDescriptorVisitor.kt' : null;
    if (!name) return pin;
    const generated = preparedDescriptors.receipt.files.find(item => item.path === name);
    return { path: pin.path, filename: generated.absolutePath, bytes: generated.bytes, sha256: generated.sha256 };
});
const descriptorVisitorComponent = await prepareDescriptorVisitorContracts({ sourceRoot, outputRoot: path.join(outputRoot, 'visitor-predecessor'), preparedDescriptors, retainedSources: canonical });
const retainedSources = canonical.map(pin => {
    const previous = priorLock.preparedOutputs.find(item => item.path === pin.path);
    return previous ? { path: pin.path, filename: path.join(outputRoot, 'visitor-predecessor', pin.path), bytes: previous.bytes, sha256: previous.sha256 } : pin;
});
const options = { sourceRoot, outputRoot: path.join(outputRoot, 'profile'), preparedDescriptors, descriptorVisitorComponent, retainedSources };
const prepared = await prepareVisitorVoidProfile(options); await verifyVisitorVoidProfile(options);
const probe = await store('Probe.kt', await readRegular(path.join(HERE, 'Probe.kt'))), originals = [];
for (const pin of lock.originals) originals.push(await store('original/' + pin.path, verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin)));
const javaSources = [];
for (const pin of priorLock.javaOriginals) javaSources.push(await store('java/' + path.basename(pin.path), verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin)));
const compiler = bootstrap.artifacts.find(pin => pin.id === 'compiler').path;
const java = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect',
    '-Xfriend-paths=' + compiler, '-jvm-target', '17', '-language-version', '2.5', '-api-version', '2.5', '-jvm-default=enable',
    '-opt-in=org.jetbrains.kotlin.K1Deprecation', '-opt-in=org.jetbrains.kotlin.ir.ObsoleteDescriptorBasedAPI',
    '-opt-in=org.jetbrains.kotlin.ir.symbols.UnsafeDuringIrConstructionAPI'];
const classes = path.join(outputRoot, 'java-classes'); await mkdir(classes);
await run('full-original-java-declaration-visitor-build', 'javac', ['-cp', bootstrap.classPath, '-d', classes, ...javaSources]);
const classPath = [classes, bootstrap.classPath].join(path.delimiter), variants = {};
const generatedContracts = ['DeclarationDescriptor.kt', 'DeclarationDescriptorVisitor.kt'].map(name => preparedDescriptors.receipt.files.find(pin => pin.path === name).absolutePath);
const propertyAliases = preparedDescriptors.receipt.files.find(pin => pin.path === 'DescriptorProperties.kt'); assert(propertyAliases);
const propertyAliasImport = preparedDescriptors.propertyAliasImport; assert.equal(propertyAliasImport, 'org.jetbrains.kotlin.portable.descriptors.*');
const propertySource = await store('common-dependencies/DescriptorProperties.kt', await readRegular(propertyAliases.absolutePath));
const moduleSource = await store('common-dependencies/ModuleDescriptor.kt', await readRegular(descriptorVisitorComponent.commonSources.find(name => name.endsWith('/core/descriptors/src/org/jetbrains/kotlin/descriptors/ModuleDescriptor.kt'))));
const commonCompilationImports = [], commonCompilationSources = [];
for (const filename of prepared.commonSources) {
    const logical = path.relative(options.outputRoot, filename), original = await readRegular(filename);
    const source = original.toString(), declaration = /^package[^\r\n]+/m.exec(source); assert(declaration);
    const end = declaration.index + declaration[0].length;
    const code = source.slice(0, end) + '\nimport ' + propertyAliasImport + '\n' + source.slice(end);
    commonCompilationSources.push(await store('common-jvm/' + logical, Buffer.from(code)));
    commonCompilationImports.push({ path: logical, sourceSha256: sha256(original), preparedJvmSha256: sha256(Buffer.from(code)), import: propertyAliasImport });
}
for (const [variant, sources] of [['original', originals], ['common', [...commonCompilationSources, ...generatedContracts, propertySource, moduleSource]]]) {
    const jar = path.join(outputRoot, variant + '.jar');
    await run(variant + '-full-six-real-sources-jvm-build', 'java', [...java, '-classpath', classPath, '-d', jar, ...sources, probe]);
    variants[variant] = await run(variant + '-all-seventeen-real-receivers-observe', 'java', ['-cp', [jar, classPath].join(path.delimiter), 'org.jetbrains.kotlin.portable.visitorvoid.probe.ProbeKt']);
    await store(variant + '-observations.txt', Buffer.from(variants[variant])); const bytes = await readRegular(jar); artifacts.push({ path: variant + '.jar', bytes: bytes.length, sha256: sha256(bytes) });
}
assert.equal(variants.common, variants.original, 'Full genuine six-source raw Void dispatch differs');
assert.equal(variants.original.trimEnd().split('\n').length, 459);
for (const recipe of lock.recipes.filter(recipe => !recipe.originalNullable)) {
    const line = variants.original.split('\n').find(line => line.startsWith(recipe.owner + ':null\t'));
    assert.equal(line, recipe.owner + ':null\tNullPointerException\t' + Buffer.from(recipe.nullMessage, 'utf16le').swap16().toString('hex'));
}
// Preserve the exact safe/bang/direct call operator and null data/result body.
// Only actual visitor call spelling becomes standard function invoke; no compiler
// descriptor/visitor model types or unsupported helper replacements are created.
const statementRecipes = lock.recipes.filter(recipe => !/shouldNotBeCalled|unsupportedInIrBasedDescriptor/.test(recipe.originalBody));
assert.equal(statementRecipes.length, 14);
const statementMappings = [];
const statements = await store('VoidStatements.kt', Buffer.from('package org.jetbrains.kotlin.portable.visitorvoid.statements\n\n' +
    'typealias VoidCallback = (Any, Nothing?) -> Nothing?\ntypealias VoidStatement = Any.(VoidCallback?) -> Unit\n\n' +
    statementRecipes.map((recipe, index) => {
        const body = recipe.prepared.slice(recipe.prepared.indexOf('{'));
        const calls = [...body.matchAll(/\.((?:visit)\w+)\(this, null\)/g)]; assert(calls.length === (recipe.owner.endsWith('.ErrorModuleDescriptor') ? 0 : 1));
        const mapped = body.replace(/\.(?:visit)\w+\(this, null\)/g, '.invoke(this, null)');
        statementMappings.push({ owner: recipe.owner, preparedDeclarationSha256: sha256(Buffer.from(recipe.prepared)),
            originalBodySha256: sha256(Buffer.from(recipe.originalBody)), observerBodySha256: sha256(Buffer.from(mapped)),
            actualMethod: calls[0]?.[1] ?? null, mapping: calls.length ? 'actual visitor call to stdlib function invoke; same receiver/null data/null return and original operator' : 'unchanged empty body and checked entry' });
        return 'fun Any.statement' + index + '(visitor: VoidCallback?) ' + mapped;
    }).join('\n\n') + '\n\nval statementBodies: List<Pair<String, VoidStatement>> = listOf(' +
    statementRecipes.map((recipe, index) => JSON.stringify(recipe.owner) + ' to Any::statement' + index).join(',') + ')\n'));
const statementProbe = await store('StatementProbe.kt', await readRegular(path.join(HERE, 'StatementProbe.kt')));
const jvmEntry = await store('JvmEntry.kt', Buffer.from('package org.jetbrains.kotlin.portable.visitorvoid.statements\nfun main() { print(observeVoidStatements()) }\n'));
const wasmEntry = await store('WasmEntry.kt', Buffer.from('@file:OptIn(kotlin.js.ExperimentalWasmJsInterop::class, kotlin.js.ExperimentalJsExport::class)\npackage org.jetbrains.kotlin.portable.visitorvoid.statements\n@kotlin.js.JsExport fun visitorVoidStatementObservation(): String = observeVoidStatements()\n'));
const stdlib = bootstrap.artifacts.find(pin => pin.id === 'stdlib-jvm').path;
await run('standard-function-exact-statement-common-jvm-build', 'java', [...java, '-classpath', stdlib, '-d', path.join(outputRoot, 'statements.jar'), statements, statementProbe, jvmEntry]);
const jvmStatements = await run('standard-function-exact-statement-common-jvm-observe', 'java', ['-cp', [path.join(outputRoot, 'statements.jar'), stdlib].join(path.delimiter), 'org.jetbrains.kotlin.portable.visitorvoid.statements.JvmEntryKt']);
const wasm = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js', '-libraries', bootstrap.wasmJsStdlib, '-language-version', '2.5', '-api-version', '2.5'];
const commonSources = [statements, statementProbe];
await run('standard-function-exact-statement-common-wasm-klib-build', 'java', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + commonSources.join(','), '-ir-output-dir', path.join(outputRoot, 'klib'), '-ir-output-name', 'visitor-void', ...commonSources, wasmEntry]);
await run('standard-function-exact-statement-common-wasm-module-build', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + path.join(outputRoot, 'klib/visitor-void.klib'), '-ir-output-dir', path.join(outputRoot, 'wasm'), '-ir-output-name', 'visitor-void', '-main', 'noCall']);
const wasmStatements = await run('standard-function-exact-statement-node-wasm-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e', 'const m=await import(process.argv[1]);process.stdout.write(m.visitorVoidStatementObservation());', pathToFileURL(path.join(outputRoot, 'wasm/visitor-void.mjs')).href]);
assert.equal(wasmStatements, jvmStatements);
const statementOwners = statementRecipes.map(recipe => recipe.owner);
const originalStatements = variants.original.split('\n').filter(line => statementOwners.some(owner => line.startsWith(owner + ':'))).join('\n') + '\n';
assert.equal(jvmStatements, originalStatements); assert.equal(jvmStatements.trimEnd().split('\n').length, 378);
await store('statement-common-jvm-observations.txt', Buffer.from(jvmStatements)); await store('statement-common-wasm-observations.txt', Buffer.from(wasmStatements));
for (const name of ['statements.jar', 'klib/visitor-void.klib', ...(await readdir(path.join(outputRoot, 'wasm'))).map(name => 'wasm/' + name)]) {
    const bytes = await readRegular(path.join(outputRoot, name)); artifacts.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
}
const receipt = { schemaVersion: 1, kind: 'actual-six-source-visitor-Void-null-only-jvm-differential',
    sourceLockSha256: sha256(lockBytes), buildToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
    preparation: prepared.receipt, commands, artifacts, historicalSelection: frozen.binding, commonCompilationImports,
    fullActualSixSourcesJvmCompiled: true, unchangedGeneratedBaseAndCompleteVisitorCompiled: true, actualReceivers: 17,
    observations: 459, rawOutputNormalized: false, originalJvmEqualsCommonJvm: true, allFourteenNullableBodiesPreserved: true,
    threeSourceOwnerNullMessagesObserved: true, javaDescriptorImplementationFamilyClosed: false,
    statementProjection: { statements: 14, observations: 378, statementMappings,
        commonJvmEqualsNodeWasmAndOriginalSelectedRecords: true, unsupportedHelperBodiesNotProjected: lock.recipes.filter(recipe => !statementOwners.includes(recipe.owner)).map(recipe => recipe.owner),
        receiver: 'Genuine stdlib Any marker', visitor: 'Standard function callback, not a compiler model', dataAndReturn: 'Genuine Nothing?; only null value',
        fullDescriptorVisitorGraphWasmExecuted: false, normalizedText: false },
    wasmRuntime: 'bounded-standard-function-statements-only', browserRuntime: 'not-run', fullCompilerBuilt: false, languageReadiness: false };
await writeJson(path.join(outputRoot, 'receipt.json'), receipt); console.log(JSON.stringify({ outputRoot, observations: 459, actualReceivers: 17 }));

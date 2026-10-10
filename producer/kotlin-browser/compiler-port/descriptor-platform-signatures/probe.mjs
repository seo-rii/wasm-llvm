import assert from 'node:assert/strict';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { prepareDescriptorContracts } from '../descriptors/prepare.mjs';
import { DEFAULT_REFERENCE_ANNOTATIONS } from '../descriptors/verify.mjs';
import { prepareDescriptorVisitorContracts } from '../descriptor-visitor-contract/prepare.mjs';
import { prepareVisitorVoidProfile } from '../visitor-void-profile/prepare.mjs';
import { frozenInputs } from '../k1-container-profile/check.mjs';
import { GENERATED, signatureDeclarations, applySignatureRecipes } from './transform.mjs';
import { prepareDescriptorPlatformSignatures, verifyDescriptorPlatformSignatures, verifyFinalDescriptorPlatformSignatures } from './prepare.mjs';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { IR, BUILTIN, CONSTRUCTOR, ALIAS, ERROR } from './transform.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
export const HISTORICAL = 'out/kotlin-compiler-port/builds/void-sourcemap-output-whole-1791642332542257252';
export async function prepareFixture(outputRoot) {
    outputRoot = path.resolve(outputRoot); assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep)); await mkdir(outputRoot, { mode: 0o700 });
    const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources');
    const frozen = await frozenInputs(path.join(REPO, HISTORICAL));
    const visitorLock = JSON.parse(await readRegular(path.join(HERE, '../descriptor-visitor-contract/sources.lock.json')));
    const closure = JSON.parse(await readRegular(path.join(HERE, '../closure.lock.json')));
    const direct = ['core/descriptors/src/org/jetbrains/kotlin/descriptors/ClassConstructorDescriptor.kt',
        'core/descriptors/src/org/jetbrains/kotlin/descriptors/impl/TypeAliasConstructorDescriptor.kt',
        'core/descriptors/src/org/jetbrains/kotlin/types/error/ErrorFunctionDescriptor.kt'];
    const preparedDescriptors = await prepareDescriptorContracts(sourceRoot, path.join(outputRoot, 'descriptors'));
    const canonical = frozen.retainedSources.map(item => {
        if (direct.includes(item.path)) {
            const original = closure.files.find(source => source.path === item.path); assert(original);
            return { path: item.path, filename: path.join(sourceRoot, item.path), bytes: original.bytes, sha256: original.sha256 };
        }
        const original = visitorLock.originals.find(source => source.path === item.path);
        if (original) return { path: item.path, filename: path.join(sourceRoot, item.path), bytes: original.bytes, sha256: original.sha256 };
        const generated = item.path.startsWith(GENERATED) ? preparedDescriptors.receipt.files.find(source => GENERATED + source.path === item.path) : null;
        return generated ? { path: item.path, filename: generated.absolutePath, bytes: generated.bytes, sha256: generated.sha256 } : item;
    });
    const descriptorVisitorComponent = await prepareDescriptorVisitorContracts({ sourceRoot, outputRoot: path.join(outputRoot, 'visitor'), preparedDescriptors, retainedSources: canonical });
    const visitorSources = canonical.map(item => {
        const output = descriptorVisitorComponent.receipt.files.find(source => source.path === item.path);
        return output ? { path: item.path, filename: path.join(outputRoot, 'visitor', item.path), bytes: output.bytes, sha256: output.sha256 } : item;
    });
    const visitorVoidComponent = await prepareVisitorVoidProfile({ sourceRoot, outputRoot: path.join(outputRoot, 'void'), preparedDescriptors, descriptorVisitorComponent, retainedSources: visitorSources });
    const retainedSources = visitorSources.map(item => {
        const output = visitorVoidComponent.receipt.files.find(source => source.path === item.path);
        return output ? { path: item.path, filename: path.join(outputRoot, 'void', item.path), bytes: output.bytes, sha256: output.sha256 } : item;
    });
    // The three untouched Kotlin signature providers precede global imports too.
    for (const logical of direct) {
        const source = closure.files.find(item => item.path === logical), index = retainedSources.findIndex(item => item.path === logical); assert(index >= 0 && source);
        retainedSources[index] = { path: logical, filename: path.join(sourceRoot, logical), bytes: source.bytes, sha256: source.sha256 };
    }
    return { sourceRoot, preparedDescriptors, descriptorVisitorComponent, visitorVoidComponent, retainedSources, frozen };
}

async function seed(outputRoot) {
    const fixture = await prepareFixture(outputRoot), inventory = [];
    for (const item of fixture.retainedSources) {
        const bytes = await readRegular(item.filename); assert.equal(bytes.length, item.bytes); assert.equal(sha256(bytes), item.sha256);
        const rows = signatureDeclarations(bytes);
        if (rows.length) inventory.push({ path: item.path, filename: item.filename, headers: rows.map(row => row.header) });
    }
    await writeJson(path.join(outputRoot, 'fixture.json'), { sourceRoot: fixture.sourceRoot, retainedSources: fixture.retainedSources,
        historicalSelection: fixture.frozen.binding, inventory,
        components: { descriptors: fixture.preparedDescriptors, visitor: fixture.descriptorVisitorComponent, void: fixture.visitorVoidComponent } });
    console.log(JSON.stringify({ outputRoot, selectedSources: fixture.retainedSources.length, declarationFiles: inventory.length }));
}
async function prepareOnly(outputRoot, fixtureFilename) {
    const fixture = JSON.parse(await readRegular(fixtureFilename)), options = { sourceRoot: fixture.sourceRoot, outputRoot,
        preparedDescriptors: fixture.components.descriptors, descriptorVisitorComponent: fixture.components.visitor,
        visitorVoidComponent: fixture.components.void, retainedSources: fixture.retainedSources };
    // The root assembler creates an empty component directory before preparation.
    await mkdir(outputRoot, { mode: 0o700 });
    const prepared = await prepareDescriptorPlatformSignatures(options);
    await verifyDescriptorPlatformSignatures(outputRoot);
    const finalSources = options.retainedSources.map(item => {
        const replacement = prepared.receipt.files.find(file => file.path === item.path);
        return replacement ? { path: item.path, filename: path.join(outputRoot, item.path), bytes: replacement.bytes, sha256: replacement.sha256 } : item;
    });
    const finalGuard = await verifyFinalDescriptorPlatformSignatures({ profileRoot: outputRoot, retainedSources: finalSources });
    await writeJson(path.join(outputRoot, 'proof-preparation.json'), { options, prepared, finalSources, finalGuard, historicalSelection: fixture.historicalSelection });
    console.log(JSON.stringify({ outputRoot, outputs: prepared.commonSources.length, bindings: prepared.predecessorBindings.length, sources: finalSources.length }));
}
async function runtime(outputRoot, preparationRoot) {
    outputRoot = path.resolve(outputRoot); assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep)); await mkdir(outputRoot, { mode: 0o700 });
    const preparation = JSON.parse(await readRegular(path.join(preparationRoot, 'proof-preparation.json'))), fixture = preparation.options;
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    const bootstrap = await verifyBootstrap(), commands = [], artifacts = [], execute = promisify(execFile);
    async function store(logical, bytes) {
        const filename = path.join(outputRoot, logical); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); artifacts.push({ path: logical, bytes: bytes.length, sha256: sha256(bytes) }); return filename;
    }
    async function run(phase, command, args, expected = 0) {
        console.log('phase: ' + phase); let stdout = '', stderr = '', code = 0;
        try { const result = await execute(command, args, { cwd: outputRoot, timeout: 240000, maxBuffer: 16 * 1024 * 1024 }); stdout = result.stdout; stderr = result.stderr; }
        catch (error) { stdout = error.stdout ?? ''; stderr = error.stderr ?? ''; code = error.code; }
        commands.push({ phase, command: [command, ...args], exitCode: code, expectedExitCode: expected });
        await store('commands/' + phase + '.stdout', Buffer.from(stdout)); await store('commands/' + phase + '.stderr', Buffer.from(stderr));
        if (code !== expected) { process.stderr.write(stderr.slice(-15000)); throw new Error(phase + ': unexpected exit ' + code); }
        return { stdout, stderr, code };
    }
    const referenceLockBytes = await readRegular(path.join(HERE, '../descriptors/reference.lock.json'));
    const referenceLock = JSON.parse(referenceLockBytes), referenceAnnotations = DEFAULT_REFERENCE_ANNOTATIONS;
    const annotationBytes = await readRegular(referenceAnnotations, 1024 * 1024);
    assert.equal(referenceLock.kind, 'official-reference-only-artifact');
    assert.equal(referenceLock.artifact.version, bootstrap.lock.version);
    assert.equal(annotationBytes.length, referenceLock.artifact.bytes); assert.equal(sha256(annotationBytes), referenceLock.artifact.sha256);
    const compiler = bootstrap.artifacts.find(item => item.id === 'compiler').path;
    const java = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect',
        '-Xfriend-paths=' + compiler, '-jvm-target', '17', '-language-version', '2.5', '-api-version', '2.5', '-jvm-default=enable',
        '-opt-in=org.jetbrains.kotlin.K1Deprecation', '-opt-in=org.jetbrains.kotlin.ir.ObsoleteDescriptorBasedAPI',
        '-opt-in=org.jetbrains.kotlin.ir.symbols.UnsafeDuringIrConstructionAPI'];
    const descriptorLock = JSON.parse(await readRegular(path.join(HERE, '../descriptors/sources.lock.json'))), javaSources = [];
    for (const logical of descriptorLock.javaInterfaces) javaSources.push(await store('java/' + path.basename(logical), verifyFile(await readRegular(path.join(fixture.sourceRoot, logical)), lock.sources.find(item => item.path === logical))));
    const classes = path.join(outputRoot, 'java-classes'); await mkdir(classes);
    await run('original-complete-twenty-seven-java-interfaces', 'javac', ['-proc:none', '-source', '17', '-target', '17', '-cp', [bootstrap.classPath, referenceAnnotations].join(path.delimiter), '-d', classes, ...javaSources]);
    const classPath = [classes, bootstrap.classPath, referenceAnnotations].join(path.delimiter), sourceVariants = {};
    for (const variant of ['original', 'common']) {
        sourceVariants[variant] = [];
        for (const logical of [IR, BUILTIN, CONSTRUCTOR, ALIAS, ERROR]) {
            const root = variant === 'original' ? fixture.sourceRoot : preparationRoot;
            let bytes = await readRegular(path.join(root, logical));
            const expected = (variant === 'original' ? lock.sources : lock.outputs).find(item => item.path === logical);
            assert(expected); assert.equal(bytes.length, expected.bytes); assert.equal(sha256(bytes), expected.sha256);
            if (variant === 'original') verifyFile(bytes, expected);
            if (variant === 'common' && [IR, BUILTIN].includes(logical)) {
                const text = bytes.toString(), m = /^package[^\r\n]+/m.exec(text); assert(m);
                const end = m.index + m[0].length; bytes = Buffer.from(text.slice(0, end) + '\nimport org.jetbrains.kotlin.portable.descriptors.*\n' + text.slice(end));
            }
            sourceVariants[variant].push(await store(variant + '/' + logical, bytes));
        }
    }
    const observers = [];
    for (const name of ['Probe.kt', 'JvmEntry.kt']) observers.push(await store(name, await readRegular(path.join(HERE, name))));
    const originalJar = path.join(outputRoot, 'original.jar');
    await run('full-original-five-kotlin-files-jvm-build', 'java', [...java, '-classpath', classPath, '-d', originalJar, ...sourceVariants.original]);
    const descriptorSources = fixture.preparedDescriptors.receipt.files;
    const genuineBoundaries = ['DeclarationDescriptor.kt', 'DeclarationDescriptorVisitor.kt', 'DescriptorProperties.kt'].map(name => descriptorSources.find(item => item.path === name).absolutePath);
    const module = fixture.descriptorVisitorComponent.commonSources.find(filename => filename.endsWith('/core/descriptors/src/org/jetbrains/kotlin/descriptors/ModuleDescriptor.kt')); assert(module);
    const commonIrJar = path.join(outputRoot, 'common-ir.jar'), commonCallableJar = path.join(outputRoot, 'common-callable.jar');
    await run('full-shipping-ir-constructor-java-callable-boundary-build', 'java', [...java, '-classpath', classPath, '-d', commonIrJar,
        sourceVariants.common[0], sourceVariants.common[2], ...genuineBoundaries, module]);
    await run('full-shipping-typealias-error-java-callable-boundary-build', 'java', [...java, '-classpath', classPath, '-d', commonCallableJar, ...sourceVariants.common.slice(3)]);
    // Its unported Java superclass cannot implement the common Nothing? Void
    // visitor contract. Execute only this unit's exact signature span over the
    // complete pinned original builtin source against the genuine Java family.
    const builtinOriginal = await readRegular(sourceVariants.original[1]), builtinRecipe = lock.recipes.filter(item => item.path === BUILTIN);
    assert.equal(builtinRecipe.length, 1);
    const builtinRebased = builtinRecipe.map(item => {
        const text = builtinOriginal.toString(), start = text.indexOf(item.original);
        assert(start >= 0 && text.indexOf(item.original, start + 1) < 0);
        return { ...item, startUtf16: start, endUtf16: start + item.original.length };
    });
    const builtinProjectionBytes = applySignatureRecipes(builtinOriginal, builtinRebased);
    const shippingBuiltin = (await readRegular(path.join(preparationRoot, BUILTIN))).toString();
    for (const recipe of builtinRecipe) assert(shippingBuiltin.includes(recipe.prepared));
    const builtinProjection = await store('builtin-signature-only/' + BUILTIN, builtinProjectionBytes);
    const commonBuiltinJar = path.join(outputRoot, 'common-builtin-signature-only.jar');
    await run('full-original-builtin-with-exact-signature-span-java-boundary-build', 'java', [...java, '-classpath', classPath, '-d', commonBuiltinJar, builtinProjection]);
    const observations = {};
    for (const [variant, jars] of [['original', [originalJar]], ['common', [commonCallableJar, commonIrJar, commonBuiltinJar]]]) {
        const observerJar = path.join(outputRoot, variant + '-observer.jar'), cp = [...jars, classPath].join(path.delimiter);
        await run(variant + '-genuine-receiver-observer-build', 'java', [...java, '-classpath', cp, '-d', observerJar, ...observers]);
        observations[variant] = (await run(variant + '-genuine-receiver-observe', 'java', ['-cp', [observerJar, cp].join(path.delimiter), 'org.jetbrains.kotlin.portable.descriptorsignatures.probe.JvmEntryKt'])).stdout;
        await store(variant + '-observations.txt', Buffer.from(observations[variant]));
    }
    assert.equal(observations.common, observations.original, 'Genuine full-source class behavior differs');
    const typechecks = {};
    for (const variant of ['before', 'after']) {
        const contracts = [];
        for (const source of descriptorSources) {
            const logical = GENERATED + source.path, replacement = lock.outputs.find(item => item.path === logical);
            contracts.push(variant === 'after' && replacement ? path.join(preparationRoot, logical) : source.absolutePath);
        }
        const aliases = descriptorSources.find(source => source.path === 'DescriptorProperties.kt').absolutePath;
        assert(contracts.includes(aliases));
        const files = [];
        for (const logical of [IR, BUILTIN, CONSTRUCTOR, ALIAS, ERROR]) {
            const source = variant === 'after' ? path.join(preparationRoot, logical) : fixture.retainedSources.find(item => item.path === logical).filename;
            const text = (await readRegular(source)).toString(), m = /^package[^\r\n]+/m.exec(text); assert(m); const end = m.index + m[0].length;
            files.push(await store('api-' + variant + '/' + logical, Buffer.from(text.slice(0, end) + '\nimport org.jetbrains.kotlin.portable.descriptors.*\n' + text.slice(end))));
        }
        const ancestors = descriptorLock.commonAncestorSources.filter(logical => !logical.endsWith('/Substitutable.kt')).map(logical => path.join(fixture.sourceRoot, logical));
        for (const filename of ancestors) verifyFile(await readRegular(filename), lock.sources.find(item => path.join(fixture.sourceRoot, item.path) === filename));
        const api = await run('full-generated-family-' + variant + '-negative-typecheck', 'java', [...java, '-classpath', classPath,
            '-d', path.join(outputRoot, 'api-' + variant + '.jar'), ...contracts, ...files, ...ancestors, module], 1);
        const errorHeaders = [...api.stderr.matchAll(/^([^\n]+?):(\d+):(\d+): error: (.*)$/gm)].map(m => ({ filename: m[1], line: Number(m[2]), message: m[4] }));
        const direct = errorHeaders.filter(item => /'(?:getUserData|setOverriddenDescriptors|copy|getMemberScope)' overrides nothing|copy.*clashes/.test(item.message));
        typechecks[variant] = { errors: errorHeaders, directSignatureErrors: direct };
    }
    assert(typechecks.before.directSignatureErrors.length > typechecks.after.directSignatureErrors.length, 'Actual common family does not reduce signature failures');
    const entrySource = await store('EntryProjection.kt', await readRegular(path.join(HERE, 'EntryProjection.kt')));
    for (const recipe of lock.recipes.filter(item => item.checks.length)) for (const check of recipe.checks) {
        const statement = 'if (' + check.parameter + ' == null) throw NullPointerException(' + JSON.stringify(check.message) + ')';
        assert((await readRegular(entrySource)).toString().includes(statement), 'Projection check differs from shipping span');
    }
    const entryJvm = await store('EntryJvm.kt', Buffer.from('package org.jetbrains.kotlin.portable.descriptorsignatures.entries\nfun main() { print(observeDescriptorEntries()) }\n'));
    const entryWasm = await store('WasmEntry.kt', await readRegular(path.join(HERE, 'WasmEntry.kt')));
    const stdlib = bootstrap.artifacts.find(item => item.id === 'stdlib-jvm').path, entryJar = path.join(outputRoot, 'entries.jar');
    await run('exact-thirteen-entry-checks-common-jvm-build', 'java', [...java, '-classpath', stdlib, '-d', entryJar, entrySource, entryJvm]);
    const entryJvmText = (await run('exact-thirteen-entry-checks-common-jvm-observe', 'java', ['-cp', [entryJar, stdlib].join(path.delimiter),
        'org.jetbrains.kotlin.portable.descriptorsignatures.entries.EntryJvmKt'])).stdout;
    const wasm = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js', '-libraries', bootstrap.wasmJsStdlib,
        '-language-version', '2.5', '-api-version', '2.5'];
    await run('exact-thirteen-entry-checks-common-wasm-klib', 'java', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + entrySource,
        '-ir-output-dir', path.join(outputRoot, 'klib'), '-ir-output-name', 'descriptor-entries', entrySource, entryWasm]);
    await run('exact-thirteen-entry-checks-common-wasm-module', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + path.join(outputRoot, 'klib/descriptor-entries.klib'),
        '-ir-output-dir', path.join(outputRoot, 'wasm'), '-ir-output-name', 'descriptor-entries', '-main', 'noCall']);
    const entryWasmText = (await run('exact-thirteen-entry-checks-node-wasm-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e',
        'const m=await import(process.argv[1]);process.stdout.write(m.descriptorEntryObservation());', pathToFileURL(path.join(outputRoot, 'wasm/descriptor-entries.mjs')).href])).stdout;
    assert.equal(entryWasmText, entryJvmText);
    const actualEntries = new Map(observations.original.trimEnd().split('\n').map(line => [line.split('\t')[0], line]));
    let comparedNullRecords = 0;
    for (const line of entryJvmText.trimEnd().split('\n')) {
        if (!line.includes('\tNullPointerException\t')) continue;
        assert.equal(actualEntries.get(line.split('\t')[0]), line, 'Projected null outcome differs from genuine source receiver'); comparedNullRecords++;
    }
    assert.equal(comparedNullRecords, 91);
    await store('entry-common-jvm-observations.txt', Buffer.from(entryJvmText)); await store('entry-node-wasm-observations.txt', Buffer.from(entryWasmText));
    for (const logical of ['original.jar', 'common-ir.jar', 'common-callable.jar', 'common-builtin-signature-only.jar', 'original-observer.jar', 'common-observer.jar', 'entries.jar',
        'klib/descriptor-entries.klib', ...(await readdir(path.join(outputRoot, 'wasm'))).map(name => 'wasm/' + name)]) {
        const bytes = await readRegular(path.join(outputRoot, logical)); artifacts.push({ path: logical, bytes: bytes.length, sha256: sha256(bytes) });
    }
    async function classFiles(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const filename = path.join(directory, entry.name);
            if (entry.isDirectory()) await classFiles(filename);
            else { assert(entry.isFile()); const bytes = await readRegular(filename); artifacts.push({ path: path.relative(outputRoot, filename), bytes: bytes.length, sha256: sha256(bytes) }); }
        }
    }
    await classFiles(classes);
    const externalInputs = [];
    for (const filename of [...descriptorSources.map(item => item.absolutePath), module,
        ...descriptorLock.commonAncestorSources.filter(logical => !logical.endsWith('/Substitutable.kt')).map(logical => path.join(fixture.sourceRoot, logical)),
        ...bootstrap.artifacts.map(item => item.path), referenceAnnotations]) {
        const bootstrapPin = bootstrap.artifacts.find(item => item.path === filename);
        const bytes = await readRegular(filename, bootstrapPin?.bytes ?? 8 * 1024 * 1024);
        if (bootstrapPin) { assert.equal(bytes.length, bootstrapPin.bytes); assert.equal(sha256(bytes), bootstrapPin.sha256); }
        externalInputs.push({ filename, bytes: bytes.length, sha256: sha256(bytes) });
    }
    const receipt = { schemaVersion: 1, kind: 'descriptor-platform-full-source-java-boundary-jvm-differential', source: lock.source, externalInputs,
        referenceAnnotations: { filename: referenceAnnotations, ...referenceLock.artifact, lockSha256: sha256(referenceLockBytes) },
        sourceLockSha256: sha256(lockBytes), probeSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
        preparationReceiptSha256: sha256(await readRegular(path.join(preparationRoot, 'receipt.json'))), commands, artifacts,
        originalJvmEqualsCommonJvm: true, observations: observations.original.trimEnd().split('\n').length, rawOutputNormalized: false,
        fullFourShippingKotlinSourceFilesExecutedOnJvm: true, fullFiveShippingKotlinSourceBodiesExecutedOnJvm: false,
        builtinSignatureProjection: { completeOriginalSourceFile: true, appliedExactCurrentUnitSpans: builtinRecipe.length, priorVisitorAndVoidProtocolsExcluded: true,
            allOtherOriginalBytesPreserved: true, shippingTargetSpanEqual: true, fullShippingBuiltinExecuted: false },
        remainingCallableInterfaces: 'Twenty-seven complete pinned original Java interfaces; modern verified bootstrap implementations, unpublished source commit',
        allGeneratedCommonCallableContractsRuntimeExecuted: false, typechecks,
        entryProjection: { checks: 13, observations: entryJvmText.trimEnd().split('\n').length, genuineNullOutcomeRecords: comparedNullRecords,
            commonJvmEqualsNodeWasm: true, genuineNullMessagesEqual: true, payload: 'Standard Any? markers; no compiler descriptor or visitor types',
            compilerBodiesAfterEntryNotProjected: true, fullDescriptorWasmExecuted: false },
        fullCompilerBuilt: false, publicLanguageSupport: false };
    await writeJson(path.join(outputRoot, 'receipt.json'), receipt); console.log(JSON.stringify({ outputRoot, observations: receipt.observations }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv[2] === '--seed') await seed(path.resolve(process.argv[3]));
    else if (process.argv[2] === '--prepare-only') await prepareOnly(path.resolve(process.argv[3]), path.resolve(process.argv[4]));
    else { assert.equal(process.argv[2], '--runtime'); await runtime(path.resolve(process.argv[3]), path.resolve(process.argv[4])); }
}

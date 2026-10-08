#!/usr/bin/env node
/** Real original/compiler identity boundary comparisons; never user-language acceptance. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap, defaultCache } from '../../build/bootstrap.mjs';
import { assertNoSymlink, readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { prepareIdentitySources } from './prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const execute = promisify(execFile);

export async function verifyIdentity({ sourceRoot, outputRoot, bootstrapCache = defaultCache, reuseIndexRoot = null, reuseIndexReceiptSha256 = null }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep)); await assertNoSymlink(outputRoot);
    await mkdir(outputRoot, { recursive: false, mode: 0o700 });
    const prepared = await prepareIdentitySources({ sourceRoot, outputRoot: path.join(outputRoot, 'common') });
    const bootstrap = await verifyBootstrap(bootstrapCache);
    const stdlibJvm = bootstrap.artifacts.find(item => item.id === 'stdlib-jvm').path;
    const compilerJar = bootstrap.artifacts.find(item => item.id === 'compiler').path;
    const annotations = bootstrap.artifacts.find(item => item.id === 'annotations').path;
    const helperClassPath = [compilerJar, stdlibJvm, annotations].join(path.delimiter);
    const flagsBytes = await readRegular(path.join(HERE, '../build-flags.json')); const flags = JSON.parse(flagsBytes);
    assert.equal(flags.source.commit, prepared.receipt.source.commit);
    const commands = [];
    async function run(phase, command, args) {
        const started = performance.now();
        try {
            const result = await execute(command, args, { cwd: outputRoot, timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
            commands.push({ phase, command, args, exitCode: 0, elapsedMs: performance.now() - started });
            return result.stdout;
        } catch (error) {
            const excerpt = String(error.stderr ?? error.stdout ?? error.message).slice(-12000);
            commands.push({ phase, command, args, exitCode: error.code ?? null, signal: error.signal ?? null, elapsedMs: performance.now() - started, errorExcerpt: excerpt });
            throw new Error(`${phase} failed (${error.code ?? error.signal}): ${excerpt}`);
        }
    }
    const jvm = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
        '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-language-version', flags.languageVersion,
        '-api-version', flags.apiVersion, ...flags.compilerFlags];
    const wasm = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler',
        '-Xwasm-target=wasm-js', '-language-version', flags.languageVersion, '-api-version', flags.apiVersion,
        '-libraries', bootstrap.wasmJsStdlib, ...flags.compilerFlags];
    const local = name => path.join(HERE, name);
    const smartPath = prepared.receipt.sourceFiles.find(pin => pin.path.endsWith('/SmartIdentityTable.kt')).path;
    const portableIndex = path.join(prepared.outputRoot, prepared.receipt.adapter.outputPath);
    const originalSource = path.join(sourceRoot, smartPath); const portableSource = path.join(prepared.outputRoot, smartPath);
    const observer = local('IdentityProbe.kt'); const entry = local('IdentityJvmEntry.kt');
    const originalJar = path.join(outputRoot, 'original-index.jar'); const portableJar = path.join(outputRoot, 'portable-index.jar');
    let original, portable, observedWasm, indexReuse = null;
    if (reuseIndexRoot !== null) {
        reuseIndexRoot = path.resolve(reuseIndexRoot);
        assert(reuseIndexRoot.startsWith(path.join(REPO, 'out') + path.sep)); await assertNoSymlink(reuseIndexRoot);
        assert(/^[a-f0-9]{64}$/.test(reuseIndexReceiptSha256));
        const previousBytes = await readRegular(path.join(reuseIndexRoot, 'differential-receipt.json'));
        assert.equal(sha256(previousBytes), reuseIndexReceiptSha256);
        const previous = JSON.parse(previousBytes);
        assert.equal(previous.result, 'index-pass'); assert.equal(previous.comparison.failed, 0);
        assert.deepEqual(previous.preparation.sourceFiles, prepared.receipt.sourceFiles);
        assert.deepEqual(previous.preparation.adapter, prepared.receipt.adapter);
        assert.deepEqual(previous.preparation.patch, prepared.receipt.patch);
        assert.equal(previous.sourceBuildFlagsSha256, sha256(flagsBytes));
        assert.deepEqual(previous.bootstrap.artifacts, bootstrap.artifacts.map(({ path: ignored, ...item }) => item));
        for (const pin of previous.observerSources.filter(pin => pin.path !== 'HashProbe.kt')) {
            const bytes = await readRegular(local(pin.path)); assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256);
        }
        const copiedOutputs = previous.outputs.filter(pin => !pin.path.includes('hash-attributes'));
        for (const pin of copiedOutputs) {
            const bytes = await readRegular(path.join(reuseIndexRoot, pin.path), 16 * 1024 * 1024);
            assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256);
            const destination = path.join(outputRoot, pin.path);
            await assertNoSymlink(destination); await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
            await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
        }
        original = (await readRegular(path.join(outputRoot, 'original-index-observations.txt'))).toString();
        portable = (await readRegular(path.join(outputRoot, 'portable-index-observations.txt'))).toString();
        observedWasm = (await readRegular(path.join(outputRoot, 'portable-wasmjs-observations.txt'))).toString();
        assert.equal(portable, original); assert.equal(observedWasm, original);
        indexReuse = { receiptSha256: sha256(previousBytes), originalVerificationToolSha256: previous.verificationToolSha256,
            originalCommands: previous.commands.filter(item => !item.phase.includes('hash-attribute') && !item.phase.includes('type-and-attribute')),
            copiedOutputs, unchangedProductionIndexSourcesVerified: true, unchangedIndexObserversVerified: true,
            unchangedBootstrapAndSourceFlagsVerified: true, indexBuildAndExecutionRepeated: false };
    } else {
    assert.equal(reuseIndexReceiptSha256, null);
    await run('original-smart-table-and-jdk-observer-build', 'java', [...jvm, '-classpath', stdlibJvm, '-d', originalJar,
        originalSource, observer, local('OriginalIndexAlias.kt'), entry]);
    await run('portable-smart-table-and-identity-index-jvm-build', 'java', [...jvm, '-classpath', stdlibJvm, '-d', portableJar,
        portableSource, portableIndex, observer, local('PortableIndexAlias.kt'), entry]);
    const main = 'org.jetbrains.kotlin.portable.identityprobe.IdentityJvmEntryKt';
    original = await run('original-jvm-observe', 'java', ['-ea', '-Xmx768m', '-cp', [originalJar, stdlibJvm].join(path.delimiter), main]);
    portable = await run('portable-jvm-observe', 'java', ['-ea', '-Xmx768m', '-cp', [portableJar, stdlibJvm].join(path.delimiter), main]);
    await writeFile(path.join(outputRoot, 'original-index-observations.txt'), original, { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(outputRoot, 'portable-index-observations.txt'), portable, { flag: 'wx', mode: 0o600 });
    assert.equal(portable, original, 'Common identity index or official SmartIdentityTable differs from its actual JVM reference');
    assert(original.includes('index-reference-key-count\ttrue\n'));
    assert(original.includes('smart-null-factory-calls-2\t3\n'));
    assert(original.includes('iterator-structural-modification\tConcurrentModificationException\n'));

    for (const name of ['klib', 'wasm']) await mkdir(path.join(outputRoot, name), { mode: 0o700 });
    const common = [portableSource, portableIndex, observer, local('PortableIndexAlias.kt')];
    await run('portable-index-wasmjs-klib-build', 'java', [...wasm, '-Xir-produce-klib-file', '-ir-output-dir', path.join(outputRoot, 'klib'),
        '-ir-output-name', 'identity-probe', ...common, local('IdentityWasmEntry.kt')]);
    await run('portable-index-wasmjs-binary-build', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + path.join(outputRoot, 'klib/identity-probe.klib'),
        '-ir-output-dir', path.join(outputRoot, 'wasm'), '-ir-output-name', 'identity-probe', '-main', 'noCall',
        '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
    observedWasm = await run('portable-index-wasmjs-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e',
        'const module = await import(process.argv[1]); process.stdout.write(module.identityProbeSnapshot());',
        pathToFileURL(path.join(outputRoot, 'wasm/identity-probe.mjs')).href]);
    await writeFile(path.join(outputRoot, 'portable-wasmjs-observations.txt'), observedWasm, { flag: 'wx', mode: 0o600 });
    assert.equal(observedWasm, original, 'Wasm identity index or official SmartIdentityTable differs from its actual JVM reference');
    }
    const ids = original.trimEnd().split('\n').map(line => line.split('\t')[0]);
    assert.equal(new Set(ids).size, ids.length); assert(ids.length > 6000);

    // Full genuine source files and helpers, rather than stand-ins for the type/IR graph.
    const hashPaths = prepared.receipt.sourceFiles.filter(pin =>
        /\/(ConeTypes|IrTypeBase|ClassifierBasedTypeConstructor|IrElementBase)\.kt$/.test(pin.path)).map(pin => pin.path);
    const hashOriginalJar = path.join(outputRoot, 'original-hash-attributes.jar');
    const hashPortableJar = path.join(outputRoot, 'portable-hash-attributes.jar');
    const hashReferenceBytes = await readRegular(local('hash-references.lock.json'));
    const hashReferences = JSON.parse(hashReferenceBytes);
    assert.equal(hashReferences.source.commit, prepared.receipt.source.commit);
    assert.equal(hashReferences.productionSourceReplacements, false);
    assert.equal(hashReferences.sources.length, 1);
    assert.equal(hashReferences.sources[0].path, 'compiler/fir/cones/src/org/jetbrains/kotlin/fir/types/ConeLookupTags.kt');
    for (const pin of hashReferences.sources) verifyFile(await readRegular(path.join(sourceRoot, pin.path), pin.bytes), pin);
    const sealedProjectionSources = [...prepared.receipt.referenceDependencies, ...hashReferences.sources].map(pin => path.join(sourceRoot, pin.path));
    let hashComparison;
    try {
        await run('selected-original-type-and-attribute-source-build', 'java', [...jvm, '-classpath', helperClassPath, '-d', hashOriginalJar,
            ...hashPaths.map(relative => path.join(sourceRoot, relative)), ...sealedProjectionSources, local('HashProbe.kt')]);
        await run('selected-portable-type-and-attribute-source-build', 'java', [...jvm, '-classpath', helperClassPath, '-d', hashPortableJar,
            ...hashPaths.map(relative => path.join(prepared.outputRoot, relative)), ...sealedProjectionSources, portableIndex, local('HashProbe.kt')]);
        const hashMain = 'org.jetbrains.kotlin.portable.identityprobe.HashProbeKt';
        const reference = await run('selected-original-hash-attributes-observe', 'java', ['-ea', '-Xmx768m', '-cp', [hashOriginalJar, helperClassPath].join(path.delimiter), hashMain]);
        const result = await run('selected-portable-hash-attributes-observe', 'java', ['-ea', '-Xmx768m', '-cp', [hashPortableJar, helperClassPath].join(path.delimiter), hashMain]);
        await writeFile(path.join(outputRoot, 'original-hash-attributes-observations.txt'), reference, { flag: 'wx', mode: 0o600 });
        await writeFile(path.join(outputRoot, 'portable-hash-attributes-observations.txt'), result, { flag: 'wx', mode: 0o600 });
        assert.equal(result, reference, 'Actual selected-source type hash contracts or IR attribute algorithms differ');
        assert(!reference.split('\n').some(line => /-(hash-stable|equal-hash)-/.test(line) && line.endsWith('\tfalse')));
        const cases = reference.trimEnd().split('\n').map(line => line.split('\t')[0]);
        assert.equal(new Set(cases).size, cases.length);
        hashComparison = { result: 'pass', required: cases.length, passed: cases.length, failed: 0, notRun: 0, skipped: 0,
            originalSha256: sha256(Buffer.from(reference)), portableSha256: sha256(Buffer.from(result)), cases, files: hashPaths };
    } catch (error) {
        if (!['selected-original-type-and-attribute-source-build', 'selected-original-hash-attributes-observe'].includes(commands.at(-1)?.phase)
            || commands.at(-1)?.exitCode === 0) throw error; // Port failures and semantic differences are never converted to not-run.
        hashComparison = { result: 'not-run', requiredSourceGroups: 4, passed: 0, notRun: 4, files: hashPaths,
            reason: 'Actual selected source/helper closure did not compile or execute; no substitute classes were used.', errorExcerpt: error.message.slice(-12000) };
    }
    const names = ['original-index.jar', 'portable-index.jar', 'original-index-observations.txt', 'portable-index-observations.txt',
        'portable-wasmjs-observations.txt', 'klib/identity-probe.klib', ...(await readdir(path.join(outputRoot, 'wasm'))).sort().map(name => 'wasm/' + name)];
    if (hashComparison.result === 'pass') names.push('original-hash-attributes.jar', 'portable-hash-attributes.jar',
        'original-hash-attributes-observations.txt', 'portable-hash-attributes-observations.txt');
    const outputs = await Promise.all(names.map(async name => { const bytes = await readRegular(path.join(outputRoot, name), 16 * 1024 * 1024);
        return { path: name, bytes: bytes.length, sha256: sha256(bytes) }; }));
    const observerSources = await Promise.all(['IdentityProbe.kt', 'OriginalIndexAlias.kt', 'PortableIndexAlias.kt', 'IdentityJvmEntry.kt', 'IdentityWasmEntry.kt', 'HashProbe.kt']
        .map(async name => { const bytes = await readRegular(local(name)); return { path: name, bytes: bytes.length, sha256: sha256(bytes) }; }));
    const receipt = { schemaVersion: 1, kind: 'official-compiler-reference-identity-differential', result: 'index-pass', source: prepared.receipt.source,
        preparation: prepared.receipt, sourceLockSha256: sha256(await readRegular(local('sources.lock.json'))),
        verificationToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))), sourceBuildFlagsSha256: sha256(flagsBytes), observerSources,
        comparison: { required: ids.length, passed: ids.length, failed: 0, notRun: 0, skipped: 0, mutationOperations: 2048, mutationSeedHex: '01234567',
            originalSha256: sha256(Buffer.from(original)), portableJvmSha256: sha256(Buffer.from(portable)), portableWasmSha256: sha256(Buffer.from(observedWasm)), cases: ids },
        hashAndAttributes: hashComparison, hashReferences, hashReferenceLockSha256: sha256(hashReferenceBytes),
        bootstrap: { version: bootstrap.lock.version, compilerSourceCommit: bootstrap.lock.compilerSourceCommit,
            artifacts: bootstrap.artifacts.map(({ path: ignored, ...item }) => item) },
        helpers: 'Actual JVM bootstrap descriptor/type/metadata/IR factory objects; equality to the selected source revision is not proved.',
        wasmEngine: { kind: 'Node', version: process.version, flags: ['--experimental-wasm-exnref'] }, browserComparison: 'not-run',
        commands, outputs, indexReuse, limitations: [...prepared.receipt.integrationGates,
            'Numeric identity hashes are not compared across hosts; actual source hash stability, equality and hash contract are compared.',
            'Only unspecified identity-map/attribute iteration order is canonicalized by identity key labels.',
            'The Wasm probe executes the real index and selected SmartIdentityTable; the full FIR/IR type dependencies are not built for Wasm by this unit.'],
        browserCompilerBuilt: false, readiness: false };
    await writeJson(path.join(outputRoot, 'differential-receipt.json'), receipt);
    return { outputRoot, receipt };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const options = {}; const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i += 2) {
        assert(['--source-root', '--output-root', '--bootstrap-cache', '--reuse-index', '--reuse-index-receipt-sha256'].includes(args[i]) && args[i + 1] && !options[args[i]], 'Invalid identity probe option');
        options[args[i]] = args[i] === '--reuse-index-receipt-sha256' ? args[i + 1] : path.resolve(args[i + 1]);
    }
    const result = await verifyIdentity({ sourceRoot: options['--source-root'] ?? path.join(REPO, 'out/kotlin-compiler-port/sources'),
        outputRoot: options['--output-root'] ?? path.join(REPO, 'out/kotlin-identity-probe'), bootstrapCache: options['--bootstrap-cache'],
        reuseIndexRoot: options['--reuse-index'] ?? null, reuseIndexReceiptSha256: options['--reuse-index-receipt-sha256'] ?? null });
    console.log(JSON.stringify({ outputRoot: result.outputRoot, result: result.receipt.result,
        comparison: { ...result.receipt.comparison, cases: result.receipt.comparison.cases.length },
        hashAndAttributes: { ...result.receipt.hashAndAttributes, cases: result.receipt.hashAndAttributes.cases?.length }, readiness: false }));
}

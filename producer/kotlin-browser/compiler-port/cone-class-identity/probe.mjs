import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { assertNoSymlink, readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { prepareIdentitySources } from '../identity/prepare.mjs';
import { prepareConeClassIdentitySources, verifyConeClassIdentity } from './prepare.mjs';
import { CONE_PATH, projectConeMethods } from './transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..');
const execute = promisify(execFile);

export async function runConeClassIdentityProbe({ outputRoot, sourceRoot = path.join(repository, 'out/kotlin-compiler-port/sources') }) {
    outputRoot = path.resolve(outputRoot); sourceRoot = path.resolve(sourceRoot);
    assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep)); await assertNoSymlink(outputRoot);
    await mkdir(outputRoot, { mode: 0o700 });
    const preparedIdentity = await prepareIdentitySources({ sourceRoot, outputRoot: path.join(outputRoot, 'identity') });
    const prepared = await prepareConeClassIdentitySources({ sourceRoot, outputRoot: path.join(outputRoot, 'prepared'), preparedIdentity });
    const verified = await verifyConeClassIdentity(prepared.outputRoot);
    const lockBytes = await readRegular(path.join(here, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    const bootstrap = await verifyBootstrap(), flagsBytes = await readRegular(path.join(here, '../build-flags.json')), flags = JSON.parse(flagsBytes);
    const stdlib = bootstrap.artifacts.find(pin => pin.id === 'stdlib-jvm').path;
    const commands = [], outputs = [], projections = [], observers = [];
    async function run(phase, command, args) {
        const begin = performance.now();
        try {
            const result = await execute(command, args, { cwd: outputRoot, timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
            commands.push({ phase, command: [command, ...args], exitCode: 0, elapsedMs: performance.now() - begin });
            if (result.stderr) process.stderr.write(result.stderr); return result.stdout;
        } catch (error) {
            await writeJson(path.join(outputRoot, 'failure.json'), { phase, exitCode: error.code,
                stderr: String(error.stderr ?? '').slice(-16384), commands });
            if (error.stderr) process.stderr.write(String(error.stderr).slice(-16384)); throw new Error(phase + ' failed');
        }
    }
    async function output(relative, bytes, write = false) {
        if (write) await writeFile(path.join(outputRoot, relative), bytes, { flag: 'wx', mode: 0o600 });
        outputs.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
    }
    for (const name of ['ConeJvmProbe.kt', 'BoundaryProbe.kt', 'BoundaryJvmEntry.kt', 'WasmEntry.kt']) {
        const bytes = await readRegular(path.join(here, name)); observers.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
    }
    const jvm = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
        '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags];
    const observed = {};
    for (const variant of ['original', 'common']) {
        const directory = path.join(outputRoot, variant); await mkdir(directory, { mode: 0o700 });
        const fullSources = lock.sources.map(pin => variant === 'common' && pin.path === CONE_PATH ? prepared.commonSources[0] : path.join(sourceRoot, pin.path));
        const jar = path.join(directory, 'actual-cone.jar');
        await run(variant + '-actual-selected-cone-source-jvm-build', 'java', [...jvm, '-classpath', bootstrap.classPath,
            '-d', jar, ...fullSources, path.join(here, 'ConeJvmProbe.kt')]);
        observed[variant + 'Full'] = await run(variant + '-actual-selected-cone-source-jvm-observe', 'java', ['-ea', '-Xmx768m', '-cp', jar + path.delimiter + bootstrap.classPath,
            'org.jetbrains.kotlin.portable.coneclassidentity.probe.ConeJvmProbeKt']);
        await output(variant + '/actual-cone.jar', await readRegular(jar));
        await output(variant + '-actual-observations.txt', Buffer.from(observed[variant + 'Full']), true);
        const source = variant === 'original' ? await readRegular(path.join(sourceRoot, CONE_PATH)) : await readRegular(prepared.commonSources[0]);
        const projection = projectConeMethods(source, lock, variant), filename = path.join(directory, 'ConeMethodBoundaries.kt');
        await writeFile(filename, projection.bytes, { flag: 'wx', mode: 0o600 });
        projections.push({ variant, path: variant + '/ConeMethodBoundaries.kt', bytes: projection.bytes.length, sha256: sha256(projection.bytes),
            methods: projection.methods, fullCompilerClasses: false, payloads: 'Explicit IdentityPayload/ValuePayload fixture fields outside compiler package',
            genuineMethodBodies: true, shippingSource: false });
        const boundaryJar = path.join(directory, 'boundary.jar');
        const boundarySources = [filename, path.join(here, 'BoundaryProbe.kt')];
        await run(variant + '-projected-boundary-jvm-build', 'java', [...jvm, '-classpath', stdlib,
            ...(variant === 'common' ? ['-Xmulti-platform', '-Xcommon-sources=' + boundarySources.join(',')] : []), '-d', boundaryJar, ...boundarySources, path.join(here, 'BoundaryJvmEntry.kt')]);
        observed[variant + 'Boundary'] = await run(variant + '-projected-boundary-jvm-observe', 'java', ['-ea', '-cp', boundaryJar + path.delimiter + stdlib,
            'org.jetbrains.kotlin.portable.coneclassidentity.boundary.BoundaryJvmEntryKt']);
        await output(variant + '/boundary.jar', await readRegular(boundaryJar));
        await output(variant + '-boundary-observations.txt', Buffer.from(observed[variant + 'Boundary']), true);
    }
    assert.equal(observed.commonFull, observed.originalFull, 'Full selected genuine Cone classes differ on JVM');
    assert.equal(observed.commonBoundary, observed.originalBoundary, 'The exact projected equality/hash boundaries differ on JVM');
    for (const name of ['klib', 'wasm']) await mkdir(path.join(outputRoot, name), { mode: 0o700 });
    const wasm = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler',
        '-Xwasm-target=wasm-js', '-language-version', flags.languageVersion, '-api-version', flags.apiVersion,
        '-libraries', bootstrap.wasmJsStdlib, ...flags.compilerFlags];
    await run('common-projected-boundary-wasmjs-klib-build', 'java', [...wasm, '-Xir-produce-klib-file', '-ir-output-dir', path.join(outputRoot, 'klib'),
        '-ir-output-name', 'cone-class-identity', path.join(outputRoot, 'common/ConeMethodBoundaries.kt'), path.join(here, 'BoundaryProbe.kt'), path.join(here, 'WasmEntry.kt')]);
    await run('common-projected-boundary-wasmjs-binary-build', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + path.join(outputRoot, 'klib/cone-class-identity.klib'),
        '-ir-output-dir', path.join(outputRoot, 'wasm'), '-ir-output-name', 'cone-class-identity', '-main', 'noCall',
        '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
    observed.wasmBoundary = await run('common-projected-boundary-node-wasmjs-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e',
        'const m = await import(process.argv[1]); process.stdout.write(m.coneClassIdentitySnapshot());', pathToFileURL(path.join(outputRoot, 'wasm/cone-class-identity.mjs')).href]);
    await output('wasm-boundary-observations.txt', Buffer.from(observed.wasmBoundary), true);
    assert.equal(observed.wasmBoundary, observed.originalBoundary, 'The exact projected equality/hash boundaries differ on genuine Wasm');
    await output('klib/cone-class-identity.klib', await readRegular(path.join(outputRoot, 'klib/cone-class-identity.klib')));
    for (const name of (await readdir(path.join(outputRoot, 'wasm'))).sort()) await output('wasm/' + name, await readRegular(path.join(outputRoot, 'wasm', name)));
    for (const [name, value] of Object.entries(observed)) {
        const lines = value.trimEnd().split('\n'); assert.equal(new Set(lines.map(line => line.split('\t')[0])).size, lines.length, 'Duplicate observer ids');
        assert(!lines.some(line => /^(?:hash-stable-|equal-hash-)/.test(line) && line.endsWith('\tfalse')), name + ' equality/hash contract failed');
    }
    const receipt = { schemaVersion: 1, kind: 'official-final-cone-class-identity-bounded-differential', result: 'pass', source: lock.source,
        sourceLockSha256: sha256(lockBytes), preparationReceiptSha256: verified.receiptSha256, preparation: verified.receipt,
        probeToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))), compilerFlagsSha256: sha256(flagsBytes), observers, projections,
        bootstrap: { version: bootstrap.lock.version, compilerSourceCommit: null, artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
        comparisons: {
            genuineSelectedConeJvm: { result: 'pass', observations: observed.originalFull.trimEnd().split('\n').length, selectedConcreteKinds: 14,
                sourceFiles: lock.sources, originalSha256: sha256(Buffer.from(observed.originalFull)), commonSha256: sha256(Buffer.from(observed.commonFull)) },
            exactMethodProjection: { result: 'pass', observations: observed.originalBoundary.trimEnd().split('\n').length, originalJvmSha256: sha256(Buffer.from(observed.originalBoundary)),
                commonJvmSha256: sha256(Buffer.from(observed.commonBoundary)), commonWasmSha256: sha256(Buffer.from(observed.wasmBoundary)), payloadFixtures: true },
        }, commands, outputs, wasmEngine: { kind: 'Node', version: process.version, flags: ['--experimental-wasm-exnref'] },
        rawOutputNormalization: false, runtimeReflectionIntroduced: false, fullConeWasmRuntime: 'not-run', fullCompilerBuilt: false, publicLanguageSupport: false,
        limitations: ['Only seven genuine hierarchy/projection/lookup source files are built for JVM; remaining helpers are verified bootstrap classes whose source commit is unpublished.',
            'Wasm executes only exact source-projected equals/hash bodies with explicit fixture payload fields, not genuine full Cone classes or FIR compilation.',
            'No browser or whole compiler acceptance is established by this unit.'] };
    await writeJson(path.join(outputRoot, 'differential.json'), receipt);
    return { outputRoot, receipt };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    assert(process.argv.length === 3, 'Expected one new output directory');
    const result = await runConeClassIdentityProbe({ outputRoot: process.argv[2] });
    console.log(JSON.stringify({ outputRoot: result.outputRoot, result: result.receipt.result, comparisons: result.receipt.comparisons,
        fullConeWasmRuntime: 'not-run', fullCompilerBuilt: false }));
}

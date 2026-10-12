import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { prepareConfigurationSources } from '../config/prepare.mjs';
import { prepareKlibSources } from '../klib/prepare.mjs';
import { TARGET } from './transform.mjs';
import { prepareMetadataVersionHost, verifyMetadataVersionHost, verifyFinalMetadataVersionHost } from './prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..'), execute = promisify(execFile);
assert.equal(process.argv.length, 3, 'Usage: check.mjs NEW_OUTPUT_ROOT');
const output = path.resolve(process.argv[2]); assert(output.startsWith(path.join(REPO, 'out') + path.sep)); await mkdir(output, { mode: 0o700 });
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources'), local = name => path.join(output, name);
const prepared = await prepareMetadataVersionHost({ sourceRoot, outputRoot: local('prepared') });
const options = { sourceRoot, outputRoot: prepared.outputRoot, expectedReceiptSha256: prepared.receiptSha256 };
await verifyMetadataVersionHost(options);
const bytes = await readRegular(prepared.commonSources[0]);
const finalReceipt = await verifyFinalMetadataVersionHost({ ...options, retainedSources: [{ path: TARGET, filename: prepared.commonSources[0], bytes: bytes.length, sha256: sha256(bytes) }] });
const bootstrap = await verifyBootstrap(), commands = [], inputs = [], dependencyOriginals = [];
async function store(name, bytes) { const filename = local(name); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); return filename; }
for (const name of ['Probe.kt', 'JvmEntry.kt', 'WasmEntry.kt', 'Boundary.kt', 'check.mjs', 'prepare.mjs', 'transform.mjs', 'sources.lock.json']) {
    const bytes = await readRegular(path.join(HERE, name)); inputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
    if (name.endsWith('.kt')) await store(name, bytes);
}
const closure = JSON.parse(await readRegular(path.join(HERE, '../closure.lock.json')));
async function original(name) {
    const pin = closure.files.find(pin => pin.path === name); assert(pin, 'Dependency missing from genuine closure: ' + name);
    const bytes = verifyFile(await readRegular(path.join(sourceRoot, name)), pin); dependencyOriginals.push(pin); return bytes;
}
const languagePath = 'core/language.version-settings/src/org/jetbrains/kotlin/config/LanguageVersionSettings.kt';
const binaryPath = 'core/metadata/src/org/jetbrains/kotlin/metadata/deserialization/BinaryVersion.kt';
const metadataPath = 'core/metadata/src/org/jetbrains/kotlin/metadata/deserialization/MetadataVersion.kt';
const keysPath = 'compiler/config/gen/org/jetbrains/kotlin/config/CommonConfigurationKeys.kt';
const language = await original(languagePath), binary = await original(binaryPath), metadata = await original(metadataPath), keys = await original(keysPath);
const originalHelper = await store('original/metadataHelpers.kt', await readRegular(path.join(sourceRoot, TARGET)));
const langJvm = await store('original/LanguageVersionSettings.kt', language), binaryJvm = await store('original/BinaryVersion.kt', binary);
const metadataJvm = await store('original/MetadataVersion.kt', metadata), keysJvm = await store('original/CommonConfigurationKeys.kt', keys);
const config = await prepareConfigurationSources({ sourceRoot, outputRoot: local('config') });
const configLock = JSON.parse(await readRegular(path.join(HERE, '../config/sources.lock.json'))), originalConfig = [];
for (const pin of configLock.sources) {
    const bytes = await original(pin.path);
    originalConfig.push(await store('original/' + path.basename(pin.path), Buffer.from(bytes.toString().replace('import com.intellij.openapi.util.Key', 'import org.jetbrains.kotlin.com.intellij.openapi.util.Key'))));
}
const klib = await prepareKlibSources({ sourceRoot, outputRoot: local('metadata') });
const portableBinary = local('metadata/' + binaryPath), portableMetadata = local('metadata/' + metadataPath);
const flagsBytes = await readRegular(path.join(HERE, '../build-flags.json')), flags = JSON.parse(flagsBytes);
const compiler = bootstrap.artifacts.find(pin => pin.id === 'compiler').path;
const jvm = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17',
    '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags,
    '-Xfriend-paths=' + compiler, '-classpath', bootstrap.classPath];
async function run(phase, binary, args) {
    console.log('phase: ' + phase);
    try { const result = await execute(binary, args, { cwd: output, timeout: 240000, maxBuffer: 16 * 1024 * 1024 });
        commands.push({ phase, command: [binary, ...args], exitCode: 0 }); if (result.stderr) process.stderr.write(result.stderr); return result.stdout;
    } catch (error) {
        await writeJson(local('failure.json'), { phase, exitCode: error.code, stderr: String(error.stderr ?? '').slice(-18000), commands });
        if (error.stderr) process.stderr.write(String(error.stderr).slice(-18000)); throw new Error(phase + ' failed');
    }
}
const observed = {};
await mkdir(local('jvm'));
for (const [label, sources] of [['original', [originalHelper, langJvm, binaryJvm, metadataJvm, keysJvm, ...originalConfig]],
    ['common', [...prepared.commonSources, langJvm, portableBinary, portableMetadata, keysJvm, ...config.commonSources]]]) {
    await run(label + '-full-helper-and-genuine-dependencies-jvm-build', 'java', [...jvm, '-d', local('jvm/' + label + '.jar'), ...sources, local('Probe.kt'), local('JvmEntry.kt')]);
    observed[label] = await run(label + '-full-helper-jvm-observe', 'java', ['-ea', '-cp', [local('jvm/' + label + '.jar'), bootstrap.classPath].join(path.delimiter), 'org.jetbrains.kotlin.portable.metadata.probe.JvmEntryKt']);
    await store(label + '-observations.txt', Buffer.from(observed[label]));
}
assert.equal(observed.common, observed.original, 'Full original/common JVM metadata-helper observations differ');
assert(observed.original.startsWith('entries|18\n'));

// Additional scoped Wasm proof: complete helper and genuine metadata/config bodies,
// exact LanguageVersion enum/interface and two exact configuration accessor bodies.
// Settings input types are explicitly probe-only, outside compiler packages.
const referencePrefix = 'org.jetbrains.kotlin.portable.metadata.reference';
function isolate(bytes) {
    return bytes.toString().replaceAll('org.jetbrains.kotlin.config', referencePrefix + '.config')
        .replaceAll('org.jetbrains.kotlin.metadata.deserialization', referencePrefix + '.metadata')
        .replaceAll('org.jetbrains.kotlin.util', referencePrefix + '.util');
}
function commonImports(text) { const match = /^package[^\r\n]+/m.exec(text); assert(match); const end = match.index + match[0].length;
    return Buffer.from(text.slice(0, end) + '\nimport kotlin.jvm.*\n' + text.slice(end)); }
const languageText = language.toString(), enumStart = languageText.indexOf('enum class LanguageVersion('), enumEnd = languageText.indexOf('\nfun LanguageVersion.toKotlinVersion()', enumStart);
assert(enumStart > 0 && enumEnd > enumStart);
const enumBytes = Buffer.from('package ' + referencePrefix + '.config\nimport org.jetbrains.kotlin.utils.DescriptionAware\n' + languageText.slice(enumStart, enumEnd));
const descriptionPath = 'core/language.model/src/org/jetbrains/kotlin/utils/DescriptionAware.kt';
const isolated = [await store('isolated/LanguageVersion.kt', commonImports(enumBytes.toString())),
    await store('isolated/DescriptionAware.kt', await original(descriptionPath)),
    await store('isolated/BinaryVersion.kt', commonImports(isolate(await readRegular(portableBinary)))),
    await store('isolated/MetadataVersion.kt', commonImports(isolate(await readRegular(portableMetadata)))),
    await store('isolated/metadataHelpers.kt', commonImports(isolate(bytes)))];
for (const filename of config.commonSources) isolated.push(await store('isolated/' + path.basename(filename), commonImports(isolate(await readRegular(filename)))));
const keyText = keys.toString(), declarations = [];
for (const name of ['LANGUAGE_VERSION_SETTINGS', 'METADATA_VERSION']) {
    const match = new RegExp('    @JvmField\\n    val ' + name + ' = [^\\n]+\\n').exec(keyText); assert(match); declarations.push(match[0]);
}
const accessors = [];
for (const name of ['languageVersionSettings', 'metadataVersion']) {
    const match = new RegExp('var CompilerConfiguration\\.' + name + ':[\\s\\S]*?(?=\\n\\n)').exec(keyText); assert(match); accessors.push(match[0]);
}
const bindings = `package ${referencePrefix}.config\nimport kotlin.jvm.JvmField\nimport ${referencePrefix}.metadata.BinaryVersion\n` +
    `typealias ApiVersion = org.jetbrains.kotlin.portable.metadata.boundary.ApiVersion\n` +
    `typealias LanguageVersionSettings = org.jetbrains.kotlin.portable.metadata.boundary.LanguageVersionSettingsImpl\n` +
    `typealias LanguageVersionSettingsImpl = org.jetbrains.kotlin.portable.metadata.boundary.LanguageVersionSettingsImpl\n` +
    'object CommonConfigurationKeys {\n' + declarations.join('') + '}\n\n' + accessors.join('\n\n') + '\n';
isolated.push(await store('isolated/CommonConfigurationAccessors.kt', Buffer.from(isolate(Buffer.from(bindings)))));
isolated.push(local('Boundary.kt'));
const isolatedProbe = await store('isolated/Probe.kt', Buffer.from(isolate(await readRegular(local('Probe.kt')))));
await run('isolated-genuine-dependency-boundaries-jvm-build', 'java', [...jvm, '-Xmulti-platform', '-Xcommon-sources=' + isolated.join(','), '-d', local('jvm/isolated.jar'), ...isolated, isolatedProbe, local('JvmEntry.kt')]);
observed.isolated = await run('isolated-genuine-dependency-boundaries-jvm-observe', 'java', ['-ea', '-cp', [local('jvm/isolated.jar'), bootstrap.classPath].join(path.delimiter), 'org.jetbrains.kotlin.portable.metadata.probe.JvmEntryKt']);
assert.equal(observed.isolated, observed.original, 'Typed settings boundaries diverge from genuine JVM settings paths');
await store('isolated-observations.txt', Buffer.from(observed.isolated));
await mkdir(local('klib')); await mkdir(local('wasm'));
const wasm = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js',
    '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags, '-libraries', bootstrap.wasmJsStdlib];
await run('full-common-helper-isolated-dependencies-wasm-klib-build', 'java', [...wasm, '-Xmulti-platform', '-Xcommon-sources=' + isolated.join(','),
    '-Xir-produce-klib-file', '-ir-output-dir', local('klib'), '-ir-output-name', 'metadata-helper', ...isolated, isolatedProbe, local('WasmEntry.kt')]);
await run('full-common-helper-wasm-binary-build', 'java', [...wasm, '-Xir-produce-js', '-Xinclude=' + local('klib/metadata-helper.klib'),
    '-ir-output-dir', local('wasm'), '-ir-output-name', 'metadata-helper', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
observed.wasm = await run('full-common-helper-node-wasm-observe', process.execPath, ['--experimental-wasm-exnref', '--input-type=module', '-e',
    'const module = await import(process.argv[1]); process.stdout.write(module.metadataProbe());', pathToFileURL(local('wasm/metadata-helper.mjs')).href]);
assert.equal(observed.wasm, observed.original, 'Full helper Node/Wasm observations differ');
await store('wasm-observations.txt', Buffer.from(observed.wasm));
await verifyMetadataVersionHost(options);
for (const pin of inputs) { const bytes = await readRegular(path.join(HERE, pin.path)); assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256, 'Metadata proof input changed'); }
const artifacts = [];
async function collect(directory) {
    for (const entry of await readdir(local(directory), { withFileTypes: true })) {
        const name = directory ? directory + '/' + entry.name : entry.name;
        if (entry.isDirectory()) await collect(name);
        else { const bytes = await readRegular(local(name), 32 * 1024 * 1024); artifacts.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); }
    }
}
await collect(''); const records = observed.original.trimEnd().split('\n'); assert(records.length > 1000);
assert.equal(new Set(records.map(line => line.split('|')[0])).size, records.length);
await writeJson(local('receipt.json'), { schemaVersion: 1, kind: 'full-genuine-metadata-version-jvm-wasm-differential', result: 'pass', artifactRoot: path.relative(REPO, output),
    source: prepared.receipt.source, sourceLockSha256: prepared.receipt.sourceLockSha256, preparation: prepared.receipt, finalReceipt,
    inputs, dependencyOriginals, configurationPreparation: config.receipt, metadataPreparation: klib.receipt, artifacts, commands, buildFlagsSha256: sha256(flagsBytes),
    bootstrap: { version: bootstrap.lock.version, sourceCommit: null, artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
    comparison: { records: records.length, originalJvmEqualsCommonJvm: true, originalJvmEqualsIsolatedJvm: true, originalJvmEqualsCommonWasm: true,
        fullHelperSourceCompiled: true, helperMethodProjection: false, normalizedText: false, rawSha256: sha256(Buffer.from(observed.original)) },
    scope: 'All18 language mappings;324 shared-identity pairs; exact INSTANCE and old-version identities; implicit/default/explicit language settings, five typed MetadataVersion overrides, strict flags, configuration copies, non-MetadataVersion fallback and null setter rejection.',
    limitations: ['JVM variants compile full original/common helper with genuine full LanguageVersionSettings, BinaryVersion, MetadataVersion, CommonConfigurationKeys and configuration implementations; other language/config dependencies come from verified bootstrap with unknown source commit.',
        'Additional Wasm proof relocates complete helper/dependency namespaces outside compiler packages and uses exact declaration projections of LanguageVersion enum/interface and two configuration keys/accessors.',
        'Wasm language/API settings are explicitly typed probe-only boundaries; full LanguageVersionSettings feature resolution and compiler runtime are not executed.',
        'Prepared BinaryVersion/MetadataVersion and configuration bodies are genuine existing components; common namespace/annotation imports only are added to the isolated proof.'],
    fullCommonHelperWasmExecuted: true, fullLanguageSettingsWasmExecuted: false, browserExecuted: false, fullCompilerBuilt: false, languageReadiness: false });
console.log(JSON.stringify({ output, records: records.length, rawSha256: sha256(Buffer.from(observed.original)), commands: commands.length }));

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { prepareTypeImplementations, verifyTypeImplementationPreparation } from '../type-implementation/prepare.mjs';
import { buildTypeImplementations } from '../type-implementation/build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..'), execute = promisify(execFile);
const outputRoot = path.resolve(process.argv[2]); assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep));
await mkdir(outputRoot, { recursive: false, mode: 0o700 });
const prepared = await prepareTypeImplementations(path.join(REPO, 'out/kotlin-compiler-port/sources'), path.join(outputRoot, 'types'));
const built = await buildTypeImplementations(prepared.outputRoot, path.join(outputRoot, 'build'));
const bootstrap = await verifyBootstrap(), flags = JSON.parse(await readRegular(path.join(HERE, '../build-flags.json'))), commands = [];
async function run(label, command, args, expected = 0) {
    let stdout = '', stderr = '', exitCode;
    try { const result = await execute(command, args, { cwd: outputRoot, timeout: 180000, maxBuffer: 4 * 1024 * 1024 }); stdout = result.stdout; stderr = result.stderr; exitCode = 0; }
    catch (error) { stdout = error.stdout ?? ''; stderr = error.stderr ?? ''; exitCode = error.code; }
    await writeFile(path.join(outputRoot, label + '.stdout'), stdout, { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(outputRoot, label + '.stderr'), stderr, { flag: 'wx', mode: 0o600 });
    commands.push({ label, command, args, exitCode, expectedExitCode: expected });
    await writeFile(path.join(outputRoot, 'commands.json'), JSON.stringify(commands, null, 2) + '\n', { mode: 0o600 });
    assert.equal(exitCode, expected, label + ': ' + stderr.slice(-4000)); return { stdout, stderr };
}
const compiler = bootstrap.artifacts.find(item => item.id === 'compiler').path, stdlib = bootstrap.artifacts.find(item => item.id === 'stdlib-jvm').path;
const annotations = bootstrap.artifacts.find(item => item.id === 'annotations').path;
const jvm = ['-Xmx1g', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect',
    '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags];
const originals = path.join(outputRoot, 'originals'), support = path.join(outputRoot, 'original-support.jar'), commonJar = path.join(built.outputRoot, 'type-implementation.jar');
await mkdir(originals, { mode: 0o700 });
await run('original-support', 'java', [...jvm, '-classpath', stdlib, '-d', support,
    path.join(prepared.outputRoot, 'sources/core/util.runtime/src/org/jetbrains/kotlin/utils/exceptionUtils.kt'),
    path.join(prepared.outputRoot, 'host/storage/ProcessCanceledException.kt')]);
await run('original-java', 'javac', ['-J-Xmx512m', '-proc:none', '-source', '17', '-target', '17', '-classpath', [support, compiler, stdlib, annotations].join(path.delimiter),
    '-d', originals, ...prepared.receipt.algorithms.map(logical => path.join(prepared.outputRoot, 'sources', logical))]);
for (const name of ['GetterProbe.kt', 'TypeSubstitutorProperties.kt']) await writeFile(path.join(outputRoot, name), await readRegular(path.join(HERE, name)), { flag: 'wx', mode: 0o600 });
const probe = path.join(outputRoot, 'GetterProbe.kt'), helper = path.join(outputRoot, 'TypeSubstitutorProperties.kt'), oldAlias = path.join(prepared.outputRoot, 'common/TypeImplementationProperties.kt');
const originalJar = path.join(outputRoot, 'original-probe.jar'), commonProbeJar = path.join(outputRoot, 'common-probe.jar');
await run('original-caller-compile', 'java', [...jvm, '-classpath', [originals, support, compiler, stdlib].join(path.delimiter), '-d', originalJar, probe, oldAlias]);
const negative = await run('common-without-bridge-compile', 'java', [...jvm, '-classpath', [commonJar, compiler, stdlib].join(path.delimiter), '-d', path.join(outputRoot, 'negative.jar'), probe], 1);
assert.match(negative.stderr, /isEmpty/); assert.match(negative.stderr, /error:/);
assert.equal((negative.stderr.match(/error:/g) ?? []).length, 1, 'Negative caller must fail only at the actual getter boundary');
await run('common-with-bridge-compile', 'java', [...jvm, '-classpath', [commonJar, compiler, stdlib].join(path.delimiter),
    '-Xmulti-platform', '-Xcommon-sources=' + helper, '-d', commonProbeJar, probe, helper]);
const main = 'org.jetbrains.kotlin.portable.typegetter.probe.GetterProbeKt';
const original = (await run('original-observations', 'java', ['-ea', '-Xmx768m', '-cp', [originalJar, originals, support, compiler, stdlib].join(path.delimiter), main])).stdout;
const common = (await run('common-observations', 'java', ['-ea', '-Xmx768m', '-cp', [commonProbeJar, commonJar, compiler, stdlib].join(path.delimiter), main])).stdout;
assert.equal(common, original); assert.equal(original.trim().split('\n').length, 6);
await verifyTypeImplementationPreparation(prepared.outputRoot);
const artifacts = [];
async function record(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const filename = path.join(directory, entry.name); if (entry.isDirectory()) await record(filename);
        else { const bytes = await readRegular(filename, 64 * 1024 * 1024); artifacts.push({ path: path.relative(outputRoot, filename), bytes: bytes.length, sha256: sha256(bytes) }); }
    }
}
await record(outputRoot);
const receipt = { schemaVersion: 1, kind: 'actual-type-substitutor-getter-jvm-proof', result: 'pass', outputRoot, observations: 6,
    comparison: original.trim().split('\n'), originalObservationSha256: sha256(Buffer.from(original)), commonObservationSha256: sha256(Buffer.from(common)),
    actualOriginalJavaClasses: prepared.receipt.algorithms, actualCommonClasses: built.receipt.algorithms,
    helperSha256: sha256(await readRegular(helper)), probeSha256: sha256(await readRegular(probe)), bootstrap,
    preparedReceiptSha256: sha256(await readRegular(path.join(prepared.outputRoot, 'receipt.json'))), builtReceiptSha256: sha256(await readRegular(path.join(built.outputRoot, 'receipt.json'))),
    commands, artifacts, negativeCommonMetadataCompile: 'Exactly one compiler error at substitutor.isEmpty without the bridge; same caller succeeds with the shipping bridge.',
    dependencies: 'Genuine verified bootstrap JVM type-system/builtins dependencies; full original and common TypeSubstitutor and projections are freshly compiled.',
    fullConsumerClassesCompiled: false, fullCommonClassesWasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false };
await writeJson(path.join(outputRoot, 'receipt.json'), receipt); console.log(JSON.stringify({ result: 'pass', observations: 6, expectedNegativeCompileExit: 1, fullCommonClassesWasmExecuted: false }));

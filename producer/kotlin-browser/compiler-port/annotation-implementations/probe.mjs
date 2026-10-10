import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { prepareAnnotationImplementations, verifyAnnotationImplementations } from './prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..'), execute = promisify(execFile);
assert.equal(process.argv.length, 3); const root = path.resolve(process.argv[2]);
assert(root.startsWith(path.join(REPO, 'out') + path.sep)); await mkdir(root, { mode: 0o700 });
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources');
const prepared = await prepareAnnotationImplementations({ sourceRoot, outputRoot: path.join(root, 'prepared') });
assert.deepEqual(await verifyAnnotationImplementations(prepared.outputRoot), prepared.receipt);
const bootstrap = await verifyBootstrap(), commands = [], artifacts = [], flags = JSON.parse(await readRegular(path.join(HERE, '../build-flags.json')));
async function run(phase, executable, args) {
    const start = performance.now(); console.log('phase: ' + phase);
    try {
        const result = await execute(executable, args, { cwd: root, timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
        commands.push({ phase, executable, args, exitCode: 0, elapsedMs: performance.now() - start });
        await writeFile(path.join(root, phase + '.stdout'), result.stdout, { flag: 'wx', mode: 0o600 });
        await writeFile(path.join(root, phase + '.stderr'), result.stderr, { flag: 'wx', mode: 0o600 });
        return result.stdout;
    } catch (error) {
        await writeJson(path.join(root, 'failure.json'), { phase, code: error.code, commands, stderr: String(error.stderr ?? '') });
        process.stderr.write(String(error.stderr ?? '').slice(-12000)); throw error;
    }
}
const compiler = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect',
    '-jvm-target', '17', '-jvm-default=disable', '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags];
const interfaces = prepared.receipt.originals.filter(pin => pin.language === 'kotlin').map(pin => path.join(prepared.outputRoot, 'reference', pin.path));
const interfaceJar = path.join(root, 'interfaces.jar');
await run('interfaces', 'java', [...compiler, '-classpath', bootstrap.classPath, '-d', interfaceJar, ...interfaces]);
const original = path.join(root, 'original'), common = path.join(root, 'common.jar'), oracle = path.join(root, 'oracle');
await mkdir(original); await mkdir(oracle);
await run('original', 'javac', ['-cp', interfaceJar + path.delimiter + bootstrap.classPath, '-d', original,
    ...prepared.receipt.originals.filter(pin => pin.language === 'java').map(pin => path.join(prepared.outputRoot, 'reference', pin.path))]);
await run('common', 'java', [...compiler, '-classpath', interfaceJar + path.delimiter + bootstrap.classPath, '-d', common, ...prepared.commonSources]);
const observer = path.join(root, 'AnnotationOracle.java'); await writeFile(observer, await readRegular(path.join(HERE, 'AnnotationOracle.java')), { flag: 'wx', mode: 0o600 });
await run('oracle', 'javac', ['-cp', [original, interfaceJar, bootstrap.classPath].join(path.delimiter), '-d', oracle, observer]);
const raw = {};
for (const [variant, classes] of [['original', original], ['common', common]]) {
    raw[variant] = await run(variant + '-observe', 'java', ['-ea', '-Xmx768m', '-cp', [oracle, classes, interfaceJar, bootstrap.classPath].join(path.delimiter), 'annotationproof.AnnotationOracle']);
}
const records = variant => raw[variant].split('\n').filter(line => line.startsWith('record:'));
assert.deepEqual(records('original'), records('common')); assert.equal(records('original').length, 1052);
const invalid = variant => raw[variant].split('\n').filter(line => line.startsWith('invalid:'));
assert.equal(invalid('original').length, 4); assert.equal(invalid('common').length, 4); assert.notDeepEqual(invalid('original'), invalid('common'));
const { readdir } = await import('node:fs/promises');
async function inventory(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
        const filename = path.join(directory, item.name);
        if (item.isDirectory()) await inventory(filename);
        else { const bytes = await readRegular(filename, 32 * 1024 * 1024); artifacts.push({ path: path.relative(root, filename), bytes: bytes.length, sha256: sha256(bytes) }); }
    }
}
await inventory(root);
const receipt = { schemaVersion: 1, kind: 'genuine-annotation-carriers-full-jvm-proof', result: 'pass', preparation: prepared.receipt,
    sourceLockSha256: prepared.receipt.sourceLockSha256, outputRoot: root, commands, artifacts, observations: records('original').length,
    recordsSha256: sha256(Buffer.from(records('original').join('\n'))), normalization: false,
    originalInvalidJavaNullConstruction: invalid('original'), commonInvalidJavaNullConstruction: invalid('common'),
    contract: 'Declared nonnull constructor inputs only; four out-of-contract Java null constructions retained as raw negative evidence.',
    sourceInterfacesRebuilt: interfaces, bootstrap: { version: bootstrap.lock.version, sourceCommit: null, artifacts: bootstrap.artifacts },
    fullCommonClassesWasmExecuted: false, fullCompilerBuilt: false, languageReadiness: false };
await writeJson(path.join(root, 'receipt.json'), receipt);
console.log(JSON.stringify({ result: 'pass', observations: receipt.observations, commands: commands.length, outputRoot: root }));

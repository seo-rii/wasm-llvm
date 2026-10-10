import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(here, '../../../..');
const execute = promisify(execFile);
const output = path.resolve(process.argv[2]);
assert(output.startsWith(path.join(repo, 'out') + path.sep));
await mkdir(output, { mode: 0o700 });
const closureBytes = await readRegular(path.join(here, '../closure.lock.json'));
const closure = JSON.parse(closureBytes);
const originalPath = 'core/descriptors/src/org/jetbrains/kotlin/resolve/MemberComparator.java';
const originalPin = closure.files.find(pin => pin.path === originalPath); assert(originalPin);
const source = path.join(repo, 'out/kotlin-compiler-port/sources', originalPath);
verifyFile(await readRegular(source), originalPin);
const bootstrap = await verifyBootstrap(), flagsBytes = await readRegular(path.join(here, '../build-flags.json'));
const flags = JSON.parse(flagsBytes), commands = [], observations = {}, outputs = [];
async function run(phase, command, args) {
    try {
        const result = await execute(command, args, { cwd: output, timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
        commands.push({ phase, command: [command, ...args], exitCode: 0 });
        if (result.stderr) process.stderr.write(result.stderr); return result.stdout;
    } catch (error) {
        if (error.stderr) process.stderr.write(String(error.stderr).slice(-12000));
        throw new Error(phase + ' failed');
    }
}
const compiler = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
    '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags];
for (const variant of ['original', 'common']) {
    const root = path.join(output, variant); await mkdir(root, { mode: 0o700 });
    const classes = path.join(root, 'classes'); await mkdir(classes, { mode: 0o700 });
    if (variant === 'original') await run('pinned-java-comparator-build', 'javac', ['-cp', bootstrap.classPath, '-d', classes, source]);
    const sourceFiles = [path.join(here, 'Probe.kt')];
    if (variant === 'common') sourceFiles.push(path.join(here, 'MemberComparator.kt'));
    const jar = path.join(root, 'probe.jar');
    await run(variant + '-actual-descriptor-jvm-build', 'java', [...compiler, '-classpath', classes + path.delimiter + bootstrap.classPath,
        '-d', jar, ...sourceFiles]);
    observations[variant] = await run(variant + '-actual-descriptor-jvm-observe', 'java', ['-ea', '-Xmx768m', '-cp', jar + path.delimiter + classes + path.delimiter + bootstrap.classPath,
        'org.jetbrains.kotlin.portable.membercomparator.probe.ProbeKt']);
    const bytes = Buffer.from(observations[variant]); await writeFile(path.join(root, 'observations.txt'), bytes, { flag: 'wx', mode: 0o600 });
    outputs.push({ path: variant + '/observations.txt', bytes: bytes.length, sha256: sha256(bytes) });
}
assert.equal(observations.common, observations.original, 'Genuine descriptor comparison outcomes changed');
const receipt = { schemaVersion: 1, kind: 'pinned-member-comparator-actual-descriptor-jvm-differential', result: 'pass', source: closure.source,
    primaryClosureSha256: sha256(closureBytes), original: originalPin, flagsSha256: sha256(flagsBytes),
    sources: await Promise.all(['MemberComparator.kt', 'Probe.kt', 'probe.mjs'].map(async name => {
        const bytes = await readRegular(path.join(here, name)); return { path: name, bytes: bytes.length, sha256: sha256(bytes) };
    })), observations: observations.original.trimEnd().split('\n').length, rawOutputNormalized: false,
    bootstrap: { version: bootstrap.lock.version, sourceCommit: null, artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
    commands, outputs, fullCommonDescriptorGraph: false, wasmRuntime: 'not-run', browserRuntime: 'not-run', fullCompilerBuilt: false, languageReadiness: false,
    limitations: ['Actual descriptor implementations and builtins are the verified JVM bootstrap dependencies, whose source commit is unpublished.',
        'This runs the full original and common comparator on JVM; it does not establish common/Wasm descriptor or renderer closure.',
        'Host class names in unsupported-pair diagnostics are not Java class identity on Wasm.'] };
await writeJson(path.join(output, 'differential.json'), receipt);
console.log(JSON.stringify({ output, result: receipt.result, observations: receipt.observations, wasmRuntime: 'not-run' }));

/** Bounded sequential JVM compilation of the real builtins port with genuine compiler dependencies. */
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareBuiltInsSources } from './prepare.mjs';
import { verifyBootstrap, defaultCache } from '../../build/bootstrap.mjs';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
export async function buildBuiltInsProbe({ sourceRoot, outputRoot, bootstrapCache = defaultCache }) {
    outputRoot = path.resolve(outputRoot);
    await mkdir(outputRoot, { recursive: false, mode: 0o700 });
    const prepared = await prepareBuiltInsSources({ sourceRoot, outputRoot: path.join(outputRoot, 'prepared') });
    const bootstrap = await verifyBootstrap(bootstrapCache);
    const flagBytes = await readRegular(path.resolve(HERE, '../build-flags.json')); const flags = JSON.parse(flagBytes);
    if (flags.source.commit !== prepared.receipt.source.commit) throw new Error('Compiler flags pin mismatch');
    const assertionSource = path.resolve(HERE, '../assertions/CompilerAssertions.kt');
    const jar = path.join(outputRoot, 'builtins.jar'); const commands = [];
    const classPath = bootstrap.artifacts.filter(item => ['compiler', 'stdlib-jvm'].includes(item.id)).map(item => item.path).join(path.delimiter);
    const args = ['-ea', '-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
        '-no-stdlib', '-no-reflect', '-language-version', flags.languageVersion, '-api-version', flags.apiVersion,
        ...flags.compilerFlags, '-classpath', classPath, '-jvm-target', '17', '-d', jar, ...prepared.commonSources, assertionSource];
    await new Promise((resolve, reject) => {
        const child = spawn('java', args, { cwd: outputRoot, stdio: 'inherit' });
        child.once('error', reject); child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error('Builtins compiler exited ' + (code ?? signal))));
    });
    commands.push({ command: 'java', args, exitCode: 0 });
    const bytes = await readRegular(jar);
    const receipt = { schemaVersion: 1, kind: 'official-kotlin-builtins-jvm-build', source: prepared.receipt.source,
        prepared: prepared.receipt, preparationSha256: sha256(await readRegular(prepared.receiptPath)), buildFlagsSha256: sha256(flagBytes),
        buildToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))), assertionSourceSha256: sha256(await readRegular(assertionSource)),
        bootstrap: { version: bootstrap.lock.version, sourceCommit: null, artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
        commands, outputs: [{ path: 'builtins.jar', bytes: bytes.length, sha256: sha256(bytes) }],
        helperDependencies: 'genuine verified bootstrap JVM descriptor, type-system, storage and loader classes; not proved to equal selected source revision',
        wasmBuild: 'not-run: concrete descriptor/type closure required', browserCompilerBuilt: false, readiness: false };
    await writeJson(path.join(outputRoot, 'build-receipt.json'), receipt);
    return { outputRoot, prepared, receipt };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2); const options = {};
    for (let i = 0; i < args.length; i += 2) {
        if (!['--source-root', '--output-root'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('Invalid builtins build option');
        options[args[i]] = args[i + 1];
    }
    const result = await buildBuiltInsProbe({ sourceRoot: options['--source-root'], outputRoot: options['--output-root'] });
    console.log(JSON.stringify({ outputRoot: result.outputRoot, outputs: result.receipt.outputs, readiness: false }));
}

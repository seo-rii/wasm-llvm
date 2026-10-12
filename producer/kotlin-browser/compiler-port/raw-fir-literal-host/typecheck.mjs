import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { TARGET, transformRawFirLiteral } from './transform.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..'), execute = promisify(execFile);
assert.equal(process.argv.length, 3); const output = path.resolve(process.argv[2]); assert(output.startsWith(path.join(REPO, 'out') + path.sep)); await mkdir(output, { mode: 0o700 });
const bootstrap = await verifyBootstrap(), sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources'), lock = JSON.parse(await readRegular(path.join(HERE, 'sources.lock.json')));
const original = verifyFile(await readRegular(path.join(sourceRoot, TARGET)), lock.original), common = verifyFile(transformRawFirLiteral(original), lock.output);
const sources = [];
for (const [name, bytes] of [['original.kt', Buffer.from(original.toString().replaceAll('import com.intellij.', 'import org.jetbrains.kotlin.com.intellij.'))],
    ['common.kt', common], ['RawFirLiteralHelpers.kt', await readRegular(path.join(HERE, 'RawFirLiteralHelpers.kt'))],
    ['ParserProfile.kt', await readRegular(path.join(HERE, '../parser-profile/ParserProfile.kt'))], ['numbers.kt', verifyFile(await readRegular(path.join(sourceRoot, lock.numbers.path)), lock.numbers)]]) {
    const filename = path.join(output, name); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); sources.push(filename);
}
const flags = JSON.parse(await readRegular(path.join(HERE, '../build-flags.json'))), compiler = bootstrap.artifacts.find(pin => pin.id === 'compiler').path;
const argumentsPrefix = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17',
    '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags, '-classpath', bootstrap.classPath, '-Xfriend-paths=' + compiler];
const commands = [];
for (const [label, inputs] of [['original', [sources[0]]], ['common', sources.slice(1)]]) {
    const args = [...argumentsPrefix, '-d', path.join(output, label + '.jar'), ...inputs];
    console.log('phase: ' + label + '-complete-raw-builder-jvm-typecheck');
    await writeJson(path.join(output, label + '-arguments.json'), ['java', ...args]);
    try {
        const result = await execute('java', args, { cwd: output, timeout: 240000, maxBuffer: 16 * 1024 * 1024 });
        if (result.stderr) process.stderr.write(result.stderr); commands.push({ phase: label, command: ['java', ...args], exitCode: 0 });
    } catch (error) {
        await writeJson(path.join(output, 'failure.json'), { phase: label, exitCode: error.code, stderr: String(error.stderr ?? '').slice(-16000), commands });
        process.stderr.write(String(error.stderr ?? '').slice(-16000)); throw new Error(label + ' full raw builder failed');
    }
}
await writeJson(path.join(output, 'receipt.json'), { schemaVersion: 1, kind: 'genuine-complete-raw-fir-builder-jvm-typecheck', source: lock.source, sourceLockSha256: sha256(await readRegular(path.join(HERE, 'sources.lock.json'))), commands,
    originalAndCommonCompleteSourcesCompiled: true, bootstrapSourceCommit: null, fullCompilerBuilt: false });

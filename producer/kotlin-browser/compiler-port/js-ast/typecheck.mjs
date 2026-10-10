#!/usr/bin/env node
/** JVM-only source/API check; separate differential evidence is required. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap, defaultCache } from '../../build/bootstrap.mjs';
import { readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { adaptKotlin } from './adapt.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)); const REPO = path.resolve(HERE, '../../../..');
const execute = promisify(execFile);
const parent = path.join(REPO, 'out/kotlin-js-ast'); await mkdir(parent, { recursive: true, mode: 0o700 });
const output = await mkdtemp(path.join(parent, 'jvm-api-'));
const closure = JSON.parse(await readRegular(path.join(HERE, '../closure.lock.json')));
const sources = closure.files.filter(pin => pin.path.startsWith('js/js.ast/src/'));
assert.equal(sources.length, 107);
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources');
const files = []; const snapshots = [];
async function snapshot(name, bytes, originalPath = null) {
    const filename = path.join(output, name); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); files.push(filename);
    snapshots.push({ path: name, bytes: bytes.length, sha256: sha256(bytes), originalPath });
}
for (const pin of sources) {
    const bytes = verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin);
    if (pin.language === 'kotlin') await snapshot(pin.path, adaptKotlin(pin.path, bytes).bytes, pin.path);
}
async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) await walk(path.join(directory, entry.name));
        else if (entry.name.endsWith('.kt')) {
            const filename = path.join(directory, entry.name);
            await snapshot('portable/' + path.relative(path.join(HERE, 'portable'), filename), await readRegular(filename));
        }
    }
}
await walk(path.join(HERE, 'portable'));
for (const name of ['collections/SmartList.kt', 'assertions/CompilerAssertions.kt']) {
    await snapshot('dependencies/' + name, await readRegular(path.join(HERE, '..', name)));
}
const utility = closure.files.find(pin => pin.path.endsWith('/utils/addToStdlib.kt'));
const utilityBytes = verifyFile(await readRegular(path.join(sourceRoot, utility.path)), utility);
const text = utilityBytes.toString(); const start = text.indexOf('fun <T, A : Appendable> Iterable<T>.joinToWithBuffer(');
const end = text.indexOf('\nfun String.countOccurrencesOf(', start); assert(start >= 0 && end > start);
await snapshot('probe-support/JoinToWithBuffer.kt', Buffer.from(text.slice(0, text.indexOf('@file:')) + 'package org.jetbrains.kotlin.utils.addToStdlib\n\n' + text.slice(start, end)), utility.path);
const bootstrap = await verifyBootstrap(defaultCache); const flags = JSON.parse(await readRegular(path.join(HERE, '../build-flags.json')));
const stdlib = bootstrap.artifacts.find(item => item.id === 'stdlib-jvm').path;
const args = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect',
    '-jvm-target', '17', '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags,
    '-classpath', stdlib, '-d', path.join(output, 'portable-jvm-api.jar'), ...files];
let code = 0;
try {
    const result = await execute('java', args, { timeout: 300000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' });
    process.stderr.write(result.stderr);
} catch (error) { code = error.code ?? 1; process.stderr.write(String(error.stderr ?? '').slice(-100000)); }
await writeJson(path.join(output, 'jvm-api-receipt.json'), { kind: 'jvm-only-ast-api-typecheck', output, exitCode: code, snapshots,
    compiledUnit: false, wholeCompilerBuilt: false, wasmValidated: false, languageReadiness: false,
    numberBoundary: 'Actual common AstDoubleFormat candidate included; independent numerical differential required' });
console.log(JSON.stringify({ output, exitCode: code, wasmValidated: false })); process.exitCode = code;

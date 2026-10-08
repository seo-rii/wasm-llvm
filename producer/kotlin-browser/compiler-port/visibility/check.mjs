#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { prepareVisibilitySources } from './prepare.mjs';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..');
const execute = promisify(execFile), sourceRoot = path.join(repository, 'out/kotlin-compiler-port/sources');
const parent = path.join(repository, 'out/kotlin-compiler-visibility/checks'); await mkdir(parent, { recursive: true });
const output = await mkdtemp(path.join(parent, 'run-'));
const prepared = await prepareVisibilitySources({ sourceRoot, outputRoot: output });
const bootstrap = await verifyBootstrap();
const flagsBytes = await readRegular(path.join(here, '../build-flags.json')); const flags = JSON.parse(flagsBytes);
const originals = path.join(output, 'original-classes'); await mkdir(originals);
const commands = [];
async function command(phase, binary, args) {
    const start = performance.now(); const result = await execute(binary, args, { timeout: 180000, maxBuffer: 1024 * 1024 });
    if (result.stderr) process.stderr.write(result.stderr);
    commands.push({ phase, command: [binary, ...args], exitCode: 0, elapsedMs: performance.now() - start }); return result.stdout;
}
const originalPin = prepared.receipt.originals.find((pin) => pin.path.endsWith('/DescriptorVisibilities.java'));
await command('original-selected-java', 'javac', ['-J-Xmx512m', '-cp', bootstrap.classPath, '-d', originals, path.join(sourceRoot, originalPin.path)]);
const observer = path.join(here, 'VisibilityProbe.kt'), main = path.join(output, 'JvmMain.kt');
await writeFile(main, 'package org.jetbrains.kotlin.portable.visibilitycheck\nfun main() = print(observeVisibilities())\n', { flag: 'wx', mode: 0o600 });
const compiler = ['-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect',
    '-language-version', '2.5', '-api-version', '2.5', ...flags.compilerFlags];
const originalJvm = path.join(output, 'original.jar');
await command('original-jvm-observer', 'java', [...compiler, '-classpath', [originals, bootstrap.classPath].join(path.delimiter), '-d', originalJvm, observer, main]);
const original = await command('original-jvm-run', 'java', ['-ea', '-cp', [originalJvm, originals, bootstrap.classPath].join(path.delimiter),
    'org.jetbrains.kotlin.portable.visibilitycheck.JvmMainKt']);
const portableJvm = path.join(output, 'portable.jar');
await command('portable-jvm-source', 'java', [...compiler, '-classpath', bootstrap.classPath, '-d', portableJvm,
    ...prepared.commonSources, path.join(here, '../config/ConfigurationHost.kt'), observer, main]);
const portable = await command('portable-jvm-run', 'java', ['-ea', '-cp', [portableJvm, bootstrap.classPath].join(path.delimiter),
    'org.jetbrains.kotlin.portable.visibilitycheck.JvmMainKt']);
assert.equal(portable, original, 'Descriptor visibility algorithms differ from the actual selected Java implementation');
const receipt = { schemaVersion: 1, kind: 'official-descriptor-visibility-jvm-differential', source: prepared.receipt.source,
    preparation: prepared.receipt, referenceDependencies: { version: bootstrap.lock.version, sourceCommit: null,
        artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
    flags: { sha256: sha256(flagsBytes), compilerFlags: flags.compilerFlags }, observerSha256: sha256(await readRegular(observer)),
    commands, comparisons: { observations: original.split('\n').length, originalJvm: sha256(Buffer.from(original)),
        portableJvm: sha256(Buffer.from(portable)), mismatches: 0 }, observedOutput: original,
    fullCommonTypeClosure: 'not-built', wasmExecution: 'not-run', browserCompiler: 'not-built', publicLanguageSupport: false };
await writeJson(path.join(output, 'visibility-evidence.json'), receipt);
console.log(JSON.stringify({ output, comparisons: receipt.comparisons, fullBrowserCompiler: false }));

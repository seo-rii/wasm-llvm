#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBootstrap, defaultCache } from '../../build/bootstrap.mjs';
import { assertNoSymlink, readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { verifyTypeImplementationPreparation } from './prepare.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));

export async function buildTypeImplementations(preparedDirectory, outputRoot, bootstrapCache = defaultCache) {
  const prepared = await verifyTypeImplementationPreparation(preparedDirectory); const bootstrap = await verifyBootstrap(bootstrapCache);
  outputRoot = path.resolve(outputRoot); await assertNoSymlink(outputRoot, { allowMissing: true }); await mkdir(outputRoot, { recursive: false, mode: 0o700 });
  const jar = path.join(outputRoot, 'type-implementation.jar'); const common = [...prepared.sourceFiles, ...prepared.hostDependencyFiles];
  const classPath = bootstrap.artifacts.filter(item => ['compiler', 'stdlib-jvm'].includes(item.id)).map(item => item.path).join(path.delimiter);
  const flagBytes = await readRegular(path.resolve(HERE, '../build-flags.json')); const flags = JSON.parse(flagBytes);
  if (flags.source.commit !== prepared.receipt.source.commit || flags.languageVersion !== '2.5' || flags.apiVersion !== '2.5' ||
      !Array.isArray(flags.compilerFlags) || !flags.compilerFlags.every(item => typeof item === 'string' && item.startsWith('-'))) throw new Error('Compiler source flags mismatch');
  const args = ['-Xmx1g', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-classpath', classPath,
    '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags,
    '-Xmulti-platform', '-Xcommon-sources=' + common.join(','), '-d', jar, ...common];
  await new Promise((resolve, reject) => { const child = spawn('java', args, { cwd: outputRoot, stdio: 'inherit' }); child.once('error', reject); child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error('Type implementation compiler exited ' + (code ?? signal)))); });
  await verifyTypeImplementationPreparation(preparedDirectory); const bytes = await readRegular(jar);
  const receipt = { schemaVersion: 1, kind: 'official-type-implementation-jvm-build', source: prepared.receipt.source,
    preparationSha256: prepared.receiptSha256, toolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
    buildFlagsSha256: sha256(flagBytes),
    compiler: { version: bootstrap.lock.version, sourceCommit: null, artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
    externalTypes: 'genuine verified bootstrap compiler type-system and builtins classes', commands: [{ command: 'java', args, exitCode: 0 }],
    outputs: [{ path: 'type-implementation.jar', bytes: bytes.length, sha256: sha256(bytes) }], algorithms: prepared.receipt.algorithms,
    wasmBuild: 'not-run: concrete type-system and builtins closure required', browserCompilerBuilt: false, readiness: false };
  await writeJson(path.join(outputRoot, 'receipt.json'), receipt); return { outputRoot, receipt };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter(value => value !== '--');
  if (args.length !== 4 || args[0] !== '--prepared-dir' || args[2] !== '--output') throw new Error('Usage: build.mjs --prepared-dir PREPARED --output NEW_DIRECTORY');
  const result = await buildTypeImplementations(args[1], args[3]); console.log(JSON.stringify({ outputRoot: result.outputRoot, outputs: result.receipt.outputs }));
}

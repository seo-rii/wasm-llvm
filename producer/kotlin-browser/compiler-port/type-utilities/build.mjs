#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBootstrap, defaultCache } from '../../build/bootstrap.mjs';
import { assertNoSymlink, readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { verifyTypeImplementationPreparation } from '../type-implementation/prepare.mjs';
import { verifyTypeUtilitiesPreparation } from './prepare.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));

export async function typeImplementationDependency(preparedDirectory, buildDirectory) {
  if (!preparedDirectory || !buildDirectory) throw new Error('Actual prepared and built type implementation dependency required');
  const prepared = await verifyTypeImplementationPreparation(preparedDirectory); buildDirectory = path.resolve(buildDirectory);
  const buildBytes = await readRegular(path.join(buildDirectory, 'receipt.json')); const build = JSON.parse(buildBytes);
  if (build.kind !== 'official-type-implementation-jvm-build' || build.preparationSha256 !== prepared.receiptSha256 || build.readiness !== false || build.outputs.length !== 1 ||
      build.toolSha256 !== sha256(await readRegular(path.resolve(HERE, '../type-implementation/build.mjs'))) ||
      build.buildFlagsSha256 !== sha256(await readRegular(path.resolve(HERE, '../build-flags.json')))) throw new Error('Stale type implementation dependency');
  const jar = path.join(buildDirectory, 'type-implementation.jar'); const bytes = await readRegular(jar);
  if (build.outputs[0].path !== 'type-implementation.jar' || build.outputs[0].bytes !== bytes.length || build.outputs[0].sha256 !== sha256(bytes)) throw new Error('Changed type implementation dependency');
  return { prepared, build, buildReceiptSha256: sha256(buildBytes), jar, jarPin: build.outputs[0] };
}

export async function buildTypeUtilities(preparedDirectory, outputRoot, { typeImplementationPrepared, typeImplementationBuild, bootstrapCache = defaultCache } = {}) {
  const prepared = await verifyTypeUtilitiesPreparation(preparedDirectory); const dependency = await typeImplementationDependency(typeImplementationPrepared, typeImplementationBuild); const bootstrap = await verifyBootstrap(bootstrapCache);
  outputRoot = path.resolve(outputRoot); await assertNoSymlink(outputRoot); await mkdir(outputRoot, { recursive: false, mode: 0o700 });
  const jar = path.join(outputRoot, 'type-utilities.jar');
  const flagBytes = await readRegular(path.resolve(HERE, '../build-flags.json')); const flags = JSON.parse(flagBytes);
  if (flags.source.commit !== prepared.receipt.source.commit || flags.languageVersion !== '2.5' || flags.apiVersion !== '2.5' || !Array.isArray(flags.compilerFlags)) throw new Error('Compiler build flag identity mismatch');
  const classPath = [dependency.jar, ...bootstrap.artifacts.filter(item => ['compiler', 'stdlib-jvm'].includes(item.id)).map(item => item.path)].join(path.delimiter);
  // The dependency jar supplies the already ported assertion/cancellation sources; never redefine their declarations in this module.
  const args = ['-Xmx1g', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-classpath', classPath,
    '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags,
    '-Xmulti-platform', '-Xcommon-sources=' + prepared.sourceFiles.join(','), '-d', jar, ...prepared.sourceFiles];
  await new Promise((resolve, reject) => { const child = spawn('java', args, { cwd: outputRoot, stdio: 'inherit' }); child.once('error', reject); child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error('Type utilities compiler exited ' + (code ?? signal)))); });
  await verifyTypeUtilitiesPreparation(preparedDirectory); const bytes = await readRegular(jar);
  const receipt = { schemaVersion: 1, kind: 'official-type-utilities-jvm-build', source: prepared.receipt.source, preparationSha256: prepared.receiptSha256,
    toolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))), buildFlagsSha256: sha256(flagBytes),
    typeImplementationDependency: { preparationSha256: dependency.prepared.receiptSha256, buildReceiptSha256: dependency.buildReceiptSha256, jar: dependency.jarPin },
    compiler: { version: bootstrap.lock.version, sourceCommit: null, artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
    commands: [{ command: 'java', args, exitCode: 0 }], outputs: [{ path: 'type-utilities.jar', bytes: bytes.length, sha256: sha256(bytes) }],
    wasmBuild: 'not-run: concrete builtins and descriptor helper closure required', browserCompilerBuilt: false, readiness: false };
  await writeJson(path.join(outputRoot, 'receipt.json'), receipt); return { outputRoot, receipt };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter(value => value !== '--'); const opts = {};
  for (let i = 0; i < args.length; i += 2) { if (!['--prepared-dir', '--output', '--type-implementation-prepared-dir', '--type-implementation-build-dir'].includes(args[i]) || !args[i + 1] || opts[args[i]]) throw new Error('Invalid type utilities build arguments'); opts[args[i]] = args[i + 1]; }
  if (Object.keys(opts).length !== 4) throw new Error('Usage: build.mjs --prepared-dir PREPARED --output NEW_DIRECTORY --type-implementation-prepared-dir TYPE_PREPARED --type-implementation-build-dir TYPE_JVM');
  const result = await buildTypeUtilities(opts['--prepared-dir'], opts['--output'], { typeImplementationPrepared: opts['--type-implementation-prepared-dir'], typeImplementationBuild: opts['--type-implementation-build-dir'] });
  console.log(JSON.stringify({ outputRoot: result.outputRoot, outputs: result.receipt.outputs }));
}

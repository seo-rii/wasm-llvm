#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap, defaultCache } from '../../build/bootstrap.mjs';
import { assertNoSymlink, readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { verifyTypePreparation, DEFAULT_REFERENCE_ANNOTATIONS } from './prepare.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)); const execute = promisify(execFile);

export async function verifyTypeContracts(preparedDirectory, buildDirectory, outputRoot, bootstrapCache = defaultCache) {
  const prepared = await verifyTypePreparation(preparedDirectory); const bootstrap = await verifyBootstrap(bootstrapCache);
  buildDirectory = path.resolve(buildDirectory); const buildBytes = await readRegular(path.join(buildDirectory, 'receipt.json')); const build = JSON.parse(buildBytes);
  if (build.kind !== 'official-type-jvm-contract-build' || build.preparationSha256 !== prepared.receiptSha256 || build.readiness !== false ||
      build.toolSha256 !== sha256(await readRegular(path.join(HERE, 'build.mjs'))) || build.outputs.length !== 1) throw new Error('Stale type contract build');
  const jar = path.join(buildDirectory, 'type-contracts.jar'); const jarBytes = await readRegular(jar);
  if (build.outputs[0].path !== 'type-contracts.jar' || build.outputs[0].bytes !== jarBytes.length || build.outputs[0].sha256 !== sha256(jarBytes)) throw new Error('Type contract artifact changed');
  outputRoot = path.resolve(outputRoot); await assertNoSymlink(outputRoot, { allowMissing: true }); await mkdir(outputRoot, { recursive: false, mode: 0o700 });
  const commands = [];
  async function run(command, args) {
    const result = await execute(command, args, { cwd: outputRoot, timeout: 180000, maxBuffer: 4 * 1024 * 1024 }); commands.push({ command, args, exitCode: 0 }); return result.stdout;
  }
  const compiler = bootstrap.artifacts.find(record => record.id === 'compiler').path; const stdlib = bootstrap.artifacts.find(record => record.id === 'stdlib-jvm').path;
  const annotations = bootstrap.artifacts.find(record => record.id === 'annotations').path;
  const referenceLock = JSON.parse(await readRegular(path.resolve(HERE, '../descriptors/reference.lock.json')));
  const referenceBytes = await readRegular(DEFAULT_REFERENCE_ANNOTATIONS, 1024 * 1024);
  if (referenceLock.artifact.bytes !== referenceBytes.length || referenceLock.artifact.sha256 !== sha256(referenceBytes)) throw new Error('Original reference annotation artifact changed');
  const sourceLock = JSON.parse(await readRegular(path.join(HERE, 'sources.lock.json'))); const originals = path.join(outputRoot, 'originals'); await mkdir(originals, { mode: 0o700 });
  await run('javac', ['-J-Xmx512m', '-proc:none', '-source', '17', '-target', '17', '-classpath', [compiler, stdlib, annotations, DEFAULT_REFERENCE_ANNOTATIONS].join(path.delimiter), '-d', originals,
    ...sourceLock.javaInterfaces.map(name => path.join(prepared.directory, 'sources', name))]);
  const observerBytes = await readRegular(path.join(HERE, 'Reference.java')); const observer = path.join(outputRoot, 'Reference.java'); await writeFile(observer, observerBytes, { flag: 'wx', mode: 0o600 });
  await run('javac', ['-J-Xmx256m', '-d', outputRoot, observer]);
  const ast = JSON.parse(await readRegular(path.join(prepared.directory, 'ast.json'))); const classes = []; const enums = [];
  function collect(declaration, parent) {
    const name = parent + declaration.name; classes.push(name); if (declaration.kind === 'ENUM') enums.push(name);
    for (const member of declaration.members) if (['INTERFACE', 'ENUM', 'CLASS'].includes(member.kind)) collect(member, name + '$');
  }
  for (const unit of ast) for (const declaration of unit.declarations) collect(declaration, unit.package + '.'); classes.sort();
  const originalApi = await run('java', ['-Xmx768m', '-cp', outputRoot, 'Reference', [originals, compiler, stdlib].join(path.delimiter), ...classes]);
  const portableApi = await run('java', ['-Xmx768m', '-cp', outputRoot, 'Reference', [jar, compiler, stdlib].join(path.delimiter), ...classes]);
  await writeFile(path.join(outputRoot, 'original-api.txt'), originalApi, { flag: 'wx', mode: 0o600 }); await writeFile(path.join(outputRoot, 'portable-api.txt'), portableApi, { flag: 'wx', mode: 0o600 });
  const entryMethod = 'getEntries():kotlin.enums.EnumEntries;'; const normalized = portableApi.split('\n').map(line => enums.some(name => line.startsWith(name + '\tenum\t')) ? line.replace(entryMethod, '') : line).join('\n');
  if (normalized !== originalApi || portableApi.split(entryMethod).length !== enums.length + 1 || originalApi.includes(entryMethod)) throw new Error('Original type APIs or genuine defaults differ; inspect original-api.txt and portable-api.txt');
  const probeBytes = await readRegular(path.join(HERE, 'ContractProbe.kt')); const probe = path.join(outputRoot, 'ContractProbe.kt'); await writeFile(probe, probeBytes, { flag: 'wx', mode: 0o600 }); const probeJar = path.join(outputRoot, 'probe.jar');
  await run('java', ['-Xmx1g', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-classpath', [jar, compiler, stdlib].join(path.delimiter), '-d', probeJar, probe]);
  const probeOutput = await run('java', ['-Xmx768m', '-cp', [probeJar, jar, compiler, stdlib].join(path.delimiter), 'org.jetbrains.kotlin.portable.typecontracts.probe.ContractProbeKt']);
  assert.equal(probeOutput, 'seven typed aliases; genuine mapper default; original checker delegation and four relations: pass\n');
  await verifyTypePreparation(preparedDirectory);
  const receipt = { schemaVersion: 1, kind: 'official-type-contract-differential', source: prepared.receipt.source, result: 'pass',
    preparationSha256: prepared.receiptSha256, buildReceiptSha256: sha256(buildBytes), verificationToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
    referenceToolSha256: sha256(observerBytes), probeSourceSha256: sha256(probeBytes), originalJavaUnits: sourceLock.javaInterfaces.length,
    interfaces: prepared.receipt.interfaces, enums: prepared.receipt.enums, sourceMethods: prepared.receipt.methods, comparedClasses: classes.length, classes,
    erasedApiSha256: sha256(Buffer.from(originalApi)), portableApiSha256: sha256(Buffer.from(portableApi)),
    knownCompilerGeneratedAdditions: enums.map(className => ({ className, method: 'getEntries():kotlin.enums.EnumEntries' })),
    preservedBodies: prepared.receipt.preservedBodies, preservedFields: prepared.receipt.preservedFields, preservedAnnotations: prepared.receipt.preservedAnnotations,
    comparisons: ['all source-declared erased method contracts', 'generic parameter counts and enum ordering', 'genuine immutable empty mapper behavior', 'original default checker factory identity and four real type relations', 'runtime DefaultImplementation annotation identity', 'seven typed getter aliases'],
    compiler: { version: bootstrap.lock.version, sourceCommit: null }, algorithmExecution: 'genuine bootstrap compiler JVM implementation through selected contract APIs; selected-source algorithms not built',
    commands, typeCheckingAlgorithmsPorted: false, wasmBuild: 'not-run: real descriptor/type-system closure required', browserCompilerBuilt: false, readiness: false };
  await writeJson(path.join(outputRoot, 'receipt.json'), receipt); return { outputRoot, receipt };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter(value => value !== '--'); const opts = {};
  for (let i = 0; i < args.length; i += 2) { if (!['--prepared-dir', '--build-dir', '--output'].includes(args[i]) || !args[i + 1] || opts[args[i]]) throw new Error('Invalid type verification arguments'); opts[args[i]] = args[i + 1]; }
  if (!opts['--prepared-dir'] || !opts['--build-dir'] || !opts['--output']) throw new Error('Usage: verify.mjs --prepared-dir PREPARED --build-dir BUILD --output NEW_DIRECTORY');
  const result = await verifyTypeContracts(opts['--prepared-dir'], opts['--build-dir'], opts['--output']); console.log(JSON.stringify({ outputRoot: result.outputRoot, result: result.receipt.result, comparedClasses: result.receipt.comparedClasses }));
}

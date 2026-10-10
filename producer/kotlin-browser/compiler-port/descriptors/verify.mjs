#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap, defaultCache } from '../../build/bootstrap.mjs';
import { assertNoSymlink, readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { verifyDescriptorPreparation } from './prepare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)); const execute = promisify(execFile);
export const DEFAULT_REFERENCE_ANNOTATIONS = path.resolve(HERE, '../../../../out/kotlin-compiler-descriptors/reference-artifacts/kotlin-annotations-jvm-2.5.0-dev-10106.jar');
export async function verifyDescriptorContracts(preparedDirectory, buildDirectory, outputRoot, bootstrapCache = defaultCache, referenceAnnotations = DEFAULT_REFERENCE_ANNOTATIONS) {
  const prepared = await verifyDescriptorPreparation(preparedDirectory); const bootstrap = await verifyBootstrap(bootstrapCache);
  buildDirectory = path.resolve(buildDirectory); const buildBytes = await readRegular(path.join(buildDirectory, 'receipt.json')); const build = JSON.parse(buildBytes);
  if (build.kind !== 'official-descriptor-jvm-contract-build' || build.preparationSha256 !== prepared.receiptSha256 || build.readiness !== false ||
      build.toolSha256 !== sha256(await readRegular(path.join(HERE, 'build.mjs'))) || build.outputs.length !== 1) throw new Error('Stale descriptor contract build');
  const contractJar = path.join(buildDirectory, 'descriptor-contracts.jar'); const contractBytes = await readRegular(contractJar);
  if (build.outputs[0].path !== 'descriptor-contracts.jar' || build.outputs[0].bytes !== contractBytes.length || build.outputs[0].sha256 !== sha256(contractBytes)) throw new Error('Descriptor contract artifact changed');
  outputRoot = path.resolve(outputRoot); await assertNoSymlink(outputRoot, { allowMissing: true }); await mkdir(outputRoot, { recursive: false, mode: 0o700 });
  const commands = [];
  async function run(command, args) {
    const result = await execute(command, args, { cwd: outputRoot, timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
    commands.push({ command, args, exitCode: 0 }); return result.stdout;
  }
  const compiler = bootstrap.artifacts.find(record => record.id === 'compiler').path;
  const stdlib = bootstrap.artifacts.find(record => record.id === 'stdlib-jvm').path;
  const annotations = bootstrap.artifacts.find(record => record.id === 'annotations').path;
  referenceAnnotations = path.resolve(referenceAnnotations);
  const referenceLockBytes = await readRegular(path.join(HERE, 'reference.lock.json'));
  const referenceLock = JSON.parse(referenceLockBytes); const annotationBytes = await readRegular(referenceAnnotations, 1024 * 1024);
  if (referenceLock.schemaVersion !== 1 || referenceLock.kind !== 'official-reference-only-artifact' ||
      referenceLock.artifact.version !== bootstrap.lock.version || referenceLock.artifact.bytes !== annotationBytes.length ||
      referenceLock.artifact.sha256 !== sha256(annotationBytes)) throw new Error('Reference ReadOnly annotation artifact mismatch');
  const frozenSourceRoot = path.join(prepared.directory, 'sources');
  const lock = JSON.parse(await readRegular(path.join(HERE, 'sources.lock.json')));
  const originals = path.join(outputRoot, 'originals'); await mkdir(originals, { mode: 0o700 });
  await run('javac', ['-J-Xmx512m', '-proc:none', '-source', '17', '-target', '17', '-classpath', [compiler, stdlib, annotations, referenceAnnotations].join(path.delimiter),
    '-d', originals, ...lock.javaInterfaces.map(name => path.join(frozenSourceRoot, name))]);
  const observer = await readRegular(path.join(HERE, 'Reference.java'));
  const frozenObserver = path.join(outputRoot, 'Reference.java'); await writeFile(frozenObserver, observer, { flag: 'wx', mode: 0o600 });
  await run('javac', ['-J-Xmx256m', '-d', outputRoot, frozenObserver]);
  const ast = JSON.parse(await readRegular(path.join(prepared.directory, 'ast.json'))); const classes = [];
  function collect(declaration, parent) {
    const name = parent + declaration.name; classes.push(name);
    for (const member of declaration.members) if (['INTERFACE', 'ENUM'].includes(member.kind)) collect(member, name + '$');
  }
  for (const unit of ast) for (const declaration of unit.declarations) collect(declaration, unit.package + '.');
  classes.sort();
  const originalOutput = await run('java', ['-Xmx512m', '-cp', outputRoot, 'Reference', [originals, compiler, stdlib].join(path.delimiter), ...classes]);
  const portableOutput = await run('java', ['-Xmx512m', '-cp', outputRoot, 'Reference', [contractJar, compiler, stdlib].join(path.delimiter), ...classes]);
  await writeFile(path.join(outputRoot, 'original-api.txt'), originalOutput, { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(outputRoot, 'portable-api.txt'), portableOutput, { flag: 'wx', mode: 0o600 });
  const enumEntries = 'getEntries():kotlin.enums.EnumEntries;';
  const enumClass = 'org.jetbrains.kotlin.descriptors.CallableMemberDescriptor$Kind';
  const normalizedPortable = portableOutput.split('\n').map(line => {
    if (line.startsWith(enumClass + '\tenum\t') && line.includes(enumEntries)) return line.replace(enumEntries, '');
    return line;
  }).join('\n');
  if (normalizedPortable !== originalOutput) throw new Error('Selected original Java and common Kotlin erased method contracts differ; inspect original-api.txt and portable-api.txt');
  if (portableOutput.split(enumEntries).length !== 2 || originalOutput.includes(enumEntries)) throw new Error('Unexpected generated Kotlin enum API');
  const probeBytes = await readRegular(path.join(HERE, 'ContractProbe.kt'));
  const probe = path.join(outputRoot, 'ContractProbe.kt'); await writeFile(probe, probeBytes, { flag: 'wx', mode: 0o600 });
  const probeJar = path.join(outputRoot, 'probe.jar');
  await run('java', ['-Xmx1g', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect',
    '-classpath', [contractJar, compiler, stdlib].join(path.delimiter), '-d', probeJar, probe]);
  const probeOutput = await run('java', ['-Xmx512m', '-cp', [probeJar, contractJar, compiler, stdlib].join(path.delimiter), 'org.jetbrains.kotlin.portable.descriptors.probe.ContractProbeKt']);
  assert.equal(probeOutput, 'typed getter alias; original default validation; four original enum branches: pass\n');
  await verifyDescriptorPreparation(prepared.directory);
  const receipt = { schemaVersion: 1, kind: 'official-descriptor-contract-differential', source: prepared.receipt.source,
    preparationSha256: prepared.receiptSha256, buildReceiptSha256: sha256(buildBytes), verificationToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
    referenceToolSha256: sha256(observer), referenceArtifactLockSha256: sha256(referenceLockBytes), referenceArtifact: referenceLock.artifact,
    probeSourceSha256: sha256(probeBytes), result: 'pass',
    originalJavaUnits: lock.javaInterfaces.length, interfaces: prepared.receipt.interfaces, enums: prepared.receipt.enums,
    sourceMethods: prepared.receipt.methods, comparedClasses: classes.length, classes, erasedApiSha256: sha256(Buffer.from(originalOutput)),
    portableApiSha256: sha256(Buffer.from(portableOutput)), knownCompilerGeneratedAdditions: [{ className: enumClass, method: 'getEntries():kotlin.enums.EnumEntries' }],
    comparisons: ['all selected source-declared method names, erased parameters and erased returns', 'generic type-parameter counts', 'original enum value order and four isReal branches', 'genuine original default validation body', 'typed getter property aliases'],
    commands, compiler: { version: bootstrap.lock.version, sourceCommit: null }, externalTypes: 'verified bootstrap compiler JVM classes',
    auditRequired: prepared.receipt.auditRequired, commonContractBoundaries: prepared.receipt.commonContractBoundaries,
    concreteImplementationsPorted: false, wasmBuild: 'not-run: actual portable descriptor type closure required', fullCompilerBuilt: false, readiness: false };
  await writeJson(path.join(outputRoot, 'receipt.json'), receipt); return { outputRoot, receipt };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter(value => value !== '--'); const opts = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--prepared-dir', '--build-dir', '--output', '--bootstrap-cache', '--reference-annotations'].includes(args[i]) || !args[i + 1] || opts[args[i]]) throw new Error('Invalid descriptor verification arguments');
    opts[args[i]] = args[i + 1];
  }
  if (!opts['--prepared-dir'] || !opts['--build-dir'] || !opts['--output']) throw new Error('Usage: verify.mjs --prepared-dir PREPARED --build-dir BUILD --output NEW_DIRECTORY');
  const result = await verifyDescriptorContracts(opts['--prepared-dir'], opts['--build-dir'], opts['--output'], opts['--bootstrap-cache'] ?? defaultCache, opts['--reference-annotations'] ?? DEFAULT_REFERENCE_ANNOTATIONS);
  console.log(JSON.stringify({ outputRoot: result.outputRoot, result: result.receipt.result, comparedClasses: result.receipt.comparedClasses }));
}

#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap, defaultCache } from '../../build/bootstrap.mjs';
import { assertNoSymlink, readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { verifyTypeImplementationPreparation } from './prepare.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)); const execute = promisify(execFile);
const CLASSES = ['org.jetbrains.kotlin.types.TypeProjectionBase', 'org.jetbrains.kotlin.types.TypeProjectionImpl', 'org.jetbrains.kotlin.types.TypeSubstitutor'];

export async function verifyTypeImplementations(preparedDirectory, buildDirectory, outputRoot, bootstrapCache = defaultCache) {
  const prepared = await verifyTypeImplementationPreparation(preparedDirectory); const bootstrap = await verifyBootstrap(bootstrapCache);
  buildDirectory = path.resolve(buildDirectory); const buildBytes = await readRegular(path.join(buildDirectory, 'receipt.json')); const build = JSON.parse(buildBytes);
  const flagBytes = await readRegular(path.resolve(HERE, '../build-flags.json')); const flags = JSON.parse(flagBytes);
  if (build.kind !== 'official-type-implementation-jvm-build' || build.preparationSha256 !== prepared.receiptSha256 || build.readiness !== false ||
      build.toolSha256 !== sha256(await readRegular(path.join(HERE, 'build.mjs'))) || build.buildFlagsSha256 !== sha256(flagBytes) || build.outputs.length !== 1) throw new Error('Stale type implementation build');
  const jar = path.join(buildDirectory, 'type-implementation.jar'); const jarBytes = await readRegular(jar);
  if (build.outputs[0].path !== 'type-implementation.jar' || build.outputs[0].bytes !== jarBytes.length || build.outputs[0].sha256 !== sha256(jarBytes)) throw new Error('Type implementation artifact changed');
  outputRoot = path.resolve(outputRoot); await assertNoSymlink(outputRoot, { allowMissing: true }); await mkdir(outputRoot, { recursive: false, mode: 0o700 });
  const commands = [];
  async function run(command, args) {
    const result = await execute(command, args, { cwd: outputRoot, timeout: 180000, maxBuffer: 4 * 1024 * 1024 }); commands.push({ command, args, exitCode: 0 }); return result.stdout;
  }
  const compiler = bootstrap.artifacts.find(item => item.id === 'compiler').path; const stdlib = bootstrap.artifacts.find(item => item.id === 'stdlib-jvm').path;
  const annotations = bootstrap.artifacts.find(item => item.id === 'annotations').path; const originals = path.join(outputRoot, 'originals'); await mkdir(originals, { mode: 0o700 });
  const originalSupport = path.join(outputRoot, 'original-support.jar');
  const jvm = ['-Xmx1g', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags];
  await run('java', [...jvm, '-classpath', stdlib, '-d', originalSupport,
    path.join(prepared.directory, 'sources/core/util.runtime/src/org/jetbrains/kotlin/utils/exceptionUtils.kt'),
    path.join(prepared.directory, 'host/storage/ProcessCanceledException.kt')]);
  await run('javac', ['-J-Xmx512m', '-proc:none', '-source', '17', '-target', '17', '-classpath', [originalSupport, compiler, stdlib, annotations].join(path.delimiter), '-d', originals,
    ...prepared.receipt.algorithms.map(name => path.join(prepared.directory, 'sources', name))]);
  const observerBytes = await readRegular(path.join(HERE, 'Reference.java')); const observer = path.join(outputRoot, 'Reference.java'); await writeFile(observer, observerBytes, { flag: 'wx', mode: 0o600 });
  await run('javac', ['-J-Xmx256m', '-d', outputRoot, observer]);
  // A fresh JVM for each host ensures genuine helper classes resolve against that host's algorithm classes.
  const originalApi = await run('java', ['-ea', '-Xmx768m', '-cp', [outputRoot, originals, originalSupport, compiler, stdlib].join(path.delimiter), 'Reference', ...CLASSES]);
  const portableApi = await run('java', ['-ea', '-Xmx768m', '-cp', [outputRoot, jar, compiler, stdlib].join(path.delimiter), 'Reference', ...CLASSES]);
  await writeFile(path.join(outputRoot, 'original-api.txt'), originalApi, { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(outputRoot, 'portable-api.txt'), portableApi, { flag: 'wx', mode: 0o600 });
  const companion = 'org.jetbrains.kotlin.types.TypeSubstitutor\tfield:public static final:Companion:org.jetbrains.kotlin.types.TypeSubstitutor$Companion\n';
  assert.equal(portableApi.split(companion).length, 2, 'Exactly one documented Kotlin companion addition expected');
  const staticBridges = originalApi.split('\n').filter(line => line.startsWith('org.jetbrains.kotlin.types.TypeSubstitutor\tmethod:public static:'));
  assert.equal(staticBridges.length, 6, 'Exactly six original static factory/combine methods expected');
  let normalizedApi = portableApi.replace(companion, '');
  for (const original of staticBridges) {
    const generated = original.replace('\tmethod:public static:', '\tmethod:public static final:');
    assert.equal(normalizedApi.split(generated + '\n').length, 2, 'Missing original static factory/combine bridge');
    normalizedApi = normalizedApi.replace(generated + '\n', original + '\n');
  }
  assert.equal(normalizedApi, originalApi, 'Actual erased APIs, instance virtual dispatch or visibility differ');
  const probeBytes = await readRegular(path.join(HERE, 'AlgorithmProbe.kt')); const probe = path.join(outputRoot, 'AlgorithmProbe.kt'); await writeFile(probe, probeBytes, { flag: 'wx', mode: 0o600 });
  const probeJar = path.join(outputRoot, 'probe.jar');
  await run('java', [...jvm, '-classpath', [originalSupport, compiler, stdlib].join(path.delimiter), '-d', probeJar, probe]);
  const original = await run('java', ['-ea', '-Xmx768m', '-cp', [probeJar, originals, originalSupport, compiler, stdlib].join(path.delimiter), 'org.jetbrains.kotlin.portable.typeimplementation.probe.AlgorithmProbeKt']);
  await writeFile(path.join(outputRoot, 'original-observations.txt'), original, { flag: 'wx', mode: 0o600 });
  const portable = await run('java', ['-ea', '-Xmx768m', '-cp', [probeJar, jar, compiler, stdlib].join(path.delimiter), 'org.jetbrains.kotlin.portable.typeimplementation.probe.AlgorithmProbeKt']);
  await writeFile(path.join(outputRoot, 'portable-observations.txt'), portable, { flag: 'wx', mode: 0o600 });
  assert.equal(portable, original, 'Selected original Java and portable Kotlin algorithm observations differ');
  const lines = original.trim().split('\n'); const ids = lines.map(line => line.split('\t')[0]);
  assert(ids.length >= 50 && new Set(ids).size === ids.length && ids.includes('recursion-render-cancellation'), 'Incomplete actual type algorithm corpus');
  const getterBytes = await readRegular(path.join(HERE, 'TypedGetterProbe.kt')); const getter = path.join(outputRoot, 'TypedGetterProbe.kt'); await writeFile(getter, getterBytes, { flag: 'wx', mode: 0o600 });
  const getterJar = path.join(outputRoot, 'getter-probe.jar');
  await run('java', [...jvm, '-classpath', [jar, compiler, stdlib].join(path.delimiter), '-d', getterJar, getter]);
  assert.equal(await run('java', ['-ea', '-Xmx768m', '-cp', [getterJar, jar, compiler, stdlib].join(path.delimiter), 'org.jetbrains.kotlin.portable.typeimplementation.probe.TypedGetterProbeKt']), 'typed portable substitution getter: pass\n');
  const outputNames = ['original-support.jar', 'probe.jar', 'getter-probe.jar', 'original-api.txt', 'portable-api.txt', 'original-observations.txt', 'portable-observations.txt'];
  async function collectClasses(directory) {
    for (const entry of await readdir(path.join(outputRoot, directory), { withFileTypes: true })) {
      const filename = directory + '/' + entry.name;
      if (entry.isDirectory()) await collectClasses(filename);
      else if (entry.isFile() && entry.name.endsWith('.class')) outputNames.push(filename);
      else throw new Error('Unexpected Java reference artifact');
    }
  }
  await collectClasses('originals'); const outputs = [];
  for (const name of outputNames.sort()) { const bytes = await readRegular(path.join(outputRoot, name)); outputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); }
  await verifyTypeImplementationPreparation(preparedDirectory);
  const receipt = { schemaVersion: 1, kind: 'official-type-implementation-differential', source: prepared.receipt.source, result: 'pass',
    preparationSha256: prepared.receiptSha256, buildReceiptSha256: sha256(buildBytes), verificationToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
    referenceToolSha256: sha256(observerBytes), probeSourceSha256: sha256(probeBytes), typedGetterProbeSha256: sha256(getterBytes), buildFlagsSha256: sha256(flagBytes), outputs,
    originalJavaUnits: 3, comparedClasses: CLASSES, originalApiSha256: sha256(Buffer.from(originalApi)), portableApiSha256: sha256(Buffer.from(portableApi)),
    knownCompilerGeneratedAdditions: ['public static final TypeSubstitutor.Companion'],
    knownCompilerGeneratedModifierDifferences: staticBridges.map(method => ({ original: method, portable: method.replace('public static:', 'public static final:'),
      limitation: 'Kotlin @JvmStatic bridge is final on the JVM; Java subclass static method hiding is not supported by this common compiler API' })),
    comparison: { required: ids.length, passed: ids.length, failed: 0, skipped: 0, notRun: 0, observationSha256: sha256(Buffer.from(original)), cases: ids },
    compiler: { version: bootstrap.lock.version, sourceCommit: null },
    algorithmExecution: 'selected original Java bodies versus selected portable Kotlin bodies, both with genuine verified bootstrap JVM type-system/builtins helper dependencies',
    assertionPolicy: 'original JVM -ea; portable compiler invariant checks enabled',
    commands, requiredConcreteDependencies: prepared.receipt.requiredConcreteDependencies,
    wasmBuild: 'not-run: concrete type-system and builtins closure required', browserCompilerBuilt: false, readiness: false };
  await writeJson(path.join(outputRoot, 'receipt.json'), receipt); return { outputRoot, receipt };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter(value => value !== '--'); const opts = {};
  for (let i = 0; i < args.length; i += 2) { if (!['--prepared-dir', '--build-dir', '--output'].includes(args[i]) || !args[i + 1] || opts[args[i]]) throw new Error('Invalid type implementation verification arguments'); opts[args[i]] = args[i + 1]; }
  if (!opts['--prepared-dir'] || !opts['--build-dir'] || !opts['--output']) throw new Error('Usage: verify.mjs --prepared-dir PREPARED --build-dir BUILD --output NEW_DIRECTORY');
  const result = await verifyTypeImplementations(opts['--prepared-dir'], opts['--build-dir'], opts['--output']); console.log(JSON.stringify({ outputRoot: result.outputRoot, result: result.receipt.result, cases: result.receipt.comparison.required }));
}

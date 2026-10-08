#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap, defaultCache } from '../../build/bootstrap.mjs';
import { assertNoSymlink, readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { typeImplementationDependency } from './build.mjs';
import { verifyTypeUtilitiesPreparation } from './prepare.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)); const execute = promisify(execFile);
const CLASSES = ['org.jetbrains.kotlin.types.TypeUtils', 'org.jetbrains.kotlin.types.TypeUtils$SpecialType',
  'org.jetbrains.kotlin.types.checker.TypeCheckingProcedure', 'org.jetbrains.kotlin.types.checker.TypeCheckerProcedureCallbacksImpl'];

export async function verifyTypeUtilities(preparedDirectory, buildDirectory, outputRoot, { typeImplementationPrepared, typeImplementationBuild, bootstrapCache = defaultCache } = {}) {
  const prepared = await verifyTypeUtilitiesPreparation(preparedDirectory); const dependency = await typeImplementationDependency(typeImplementationPrepared, typeImplementationBuild); const bootstrap = await verifyBootstrap(bootstrapCache);
  buildDirectory = path.resolve(buildDirectory); const buildBytes = await readRegular(path.join(buildDirectory, 'receipt.json')); const build = JSON.parse(buildBytes);
  const flagBytes = await readRegular(path.resolve(HERE, '../build-flags.json')); const flags = JSON.parse(flagBytes);
  if (build.kind !== 'official-type-utilities-jvm-build' || build.preparationSha256 !== prepared.receiptSha256 || build.readiness !== false ||
      build.toolSha256 !== sha256(await readRegular(path.join(HERE, 'build.mjs'))) || build.buildFlagsSha256 !== sha256(flagBytes) || build.outputs.length !== 1 ||
      build.typeImplementationDependency.buildReceiptSha256 !== dependency.buildReceiptSha256 || build.typeImplementationDependency.preparationSha256 !== dependency.prepared.receiptSha256) throw new Error('Stale type utilities build');
  const jar = path.join(buildDirectory, 'type-utilities.jar'); const jarBytes = await readRegular(jar);
  if (build.outputs[0].path !== 'type-utilities.jar' || build.outputs[0].bytes !== jarBytes.length || build.outputs[0].sha256 !== sha256(jarBytes)) throw new Error('Changed type utilities artifact');
  outputRoot = path.resolve(outputRoot); await assertNoSymlink(outputRoot); await mkdir(outputRoot, { recursive: false, mode: 0o700 }); const commands = [];
  async function run(command, args) {
    const result = await execute(command, args, { cwd: outputRoot, timeout: 180000, maxBuffer: 4 * 1024 * 1024 }); commands.push({ command, args, exitCode: 0 }); return result.stdout;
  }
  const compiler = bootstrap.artifacts.find(item => item.id === 'compiler').path; const stdlib = bootstrap.artifacts.find(item => item.id === 'stdlib-jvm').path;
  const annotations = bootstrap.artifacts.find(item => item.id === 'annotations').path; const jvm = ['-Xmx1g', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags];
  const originalSupport = path.join(outputRoot, 'original-support.jar');
  await run('java', [...jvm, '-classpath', stdlib, '-d', originalSupport,
    path.join(dependency.prepared.directory, 'sources/core/util.runtime/src/org/jetbrains/kotlin/utils/exceptionUtils.kt'),
    path.join(dependency.prepared.directory, 'host/storage/ProcessCanceledException.kt')]);
  const originals = path.join(outputRoot, 'originals'); await mkdir(originals, { mode: 0o700 });
  const originalFiles = [...dependency.prepared.receipt.algorithms.map(name => path.join(dependency.prepared.directory, 'sources', name)),
    ...prepared.replacedOriginalPaths.map(name => path.join(prepared.directory, 'sources', name))];
  await run('javac', ['-J-Xmx512m', '-proc:none', '-source', '17', '-target', '17', '-classpath', [originalSupport, compiler, stdlib, annotations].join(path.delimiter), '-d', originals, ...originalFiles]);
  const observerBytes = await readRegular(path.join(HERE, 'Reference.java')); const observer = path.join(outputRoot, 'Reference.java'); await writeFile(observer, observerBytes, { flag: 'wx', mode: 0o600 });
  await run('javac', ['-J-Xmx256m', '-d', outputRoot, observer]);
  const originalApi = await run('java', ['-ea', '-Xmx768m', '-cp', [outputRoot, originals, originalSupport, compiler, stdlib].join(path.delimiter), 'Reference', ...CLASSES]);
  const portableApi = await run('java', ['-ea', '-Xmx768m', '-cp', [outputRoot, jar, dependency.jar, compiler, stdlib].join(path.delimiter), 'Reference', ...CLASSES]);
  await writeFile(path.join(outputRoot, 'original-api.txt'), originalApi, { flag: 'wx', mode: 0o600 }); await writeFile(path.join(outputRoot, 'portable-api.txt'), portableApi, { flag: 'wx', mode: 0o600 });
  let normalized = portableApi; const knownGeneratedDifferences = [];
  for (const name of ['org.jetbrains.kotlin.types.TypeUtils', 'org.jetbrains.kotlin.types.checker.TypeCheckingProcedure']) {
    const companion = name + '\tfield:public static final:Companion:' + name + '$Companion\n'; assert.equal(normalized.split(companion).length, 2); normalized = normalized.replace(companion, ''); knownGeneratedDifferences.push({ kind: 'companion-field', portable: companion.trim() });
  }
  for (const original of originalApi.split('\n').filter(line => line.includes('\tmethod:public static:'))) {
    const generated = original.replace('\tmethod:public static:', '\tmethod:public static final:'); assert.equal(normalized.split(generated + '\n').length, 2);
    normalized = normalized.replace(generated + '\n', original + '\n'); knownGeneratedDifferences.push({ kind: 'static-bridge-final', original, portable: generated });
  }
  const callbacks = CLASSES[3]; const packageClass = callbacks + '\tclass::java.lang.Object\n'; const publicClass = callbacks + '\tclass:public:java.lang.Object\n'; const publicConstructor = callbacks + '\tconstructor:public:()\n';
  assert.equal(originalApi.split(packageClass).length, 2); assert.equal(normalized.split(publicClass).length, 2); assert.equal(normalized.split(publicConstructor).length, 2);
  normalized = normalized.replace(publicClass, packageClass).replace(publicConstructor, '');
  knownGeneratedDifferences.push({ kind: 'internal-kotlin-class-jvm-visibility', original: packageClass.trim(), portable: publicClass.trim(), constructor: publicConstructor.trim() });
  assert.equal(normalized, originalApi, 'Type utility erased API, field, visibility or instance virtual dispatch changed');
  const probeBytes = await readRegular(path.join(HERE, 'UtilitiesProbe.kt')); const probe = path.join(outputRoot, 'UtilitiesProbe.kt'); await writeFile(probe, probeBytes, { flag: 'wx', mode: 0o600 }); const probeJar = path.join(outputRoot, 'probe.jar');
  await run('java', [...jvm, '-classpath', [originals, originalSupport, compiler, stdlib].join(path.delimiter), '-d', probeJar, probe]);
  const original = await run('java', ['-ea', '-Xmx768m', '-cp', [probeJar, originals, originalSupport, compiler, stdlib].join(path.delimiter), 'org.jetbrains.kotlin.portable.typeutilities.probe.UtilitiesProbeKt']);
  await writeFile(path.join(outputRoot, 'original-observations.txt'), original, { flag: 'wx', mode: 0o600 });
  const portable = await run('java', ['-ea', '-Xmx768m', '-cp', [probeJar, jar, dependency.jar, compiler, stdlib].join(path.delimiter), 'org.jetbrains.kotlin.portable.typeutilities.probe.UtilitiesProbeKt']);
  await writeFile(path.join(outputRoot, 'portable-observations.txt'), portable, { flag: 'wx', mode: 0o600 }); assert.equal(portable, original, 'Original selected Java and portable type utility observations differ');
  const lines = original.trim().split('\n'); const notRun = lines.filter(line => line.startsWith('not-run\t')).map(line => line.split('\t')[1]);
  const cases = lines.filter(line => !line.startsWith('not-run\t')).map(line => line.split('\t')[0]); assert(cases.length >= 180 && new Set(cases).size === cases.length && cases.includes('callback-capture-true'));
  assert(notRun.length === 0 || (notRun.length === 2 && notRun.includes('number-default-unsigned-int') && notRun.includes('number-default-unsigned-long')));
  const names = ['original-support.jar', 'probe.jar', 'original-api.txt', 'portable-api.txt', 'original-observations.txt', 'portable-observations.txt'];
  async function classes(directory) { for (const entry of await readdir(path.join(outputRoot, directory), { withFileTypes: true })) { const name = directory + '/' + entry.name; if (entry.isDirectory()) await classes(name); else if (entry.isFile() && entry.name.endsWith('.class')) names.push(name); else throw new Error('Unexpected reference artifact'); } }
  await classes('originals'); const outputs = [];
  for (const name of names.sort()) { const bytes = await readRegular(path.join(outputRoot, name)); outputs.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); }
  await verifyTypeUtilitiesPreparation(preparedDirectory);
  const receipt = { schemaVersion: 1, kind: 'official-type-utilities-differential', source: prepared.receipt.source, result: 'pass-with-explicit-unrun-cases',
    preparationSha256: prepared.receiptSha256, buildReceiptSha256: sha256(buildBytes), verificationToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
    referenceToolSha256: sha256(observerBytes), probeSourceSha256: sha256(probeBytes), buildFlagsSha256: sha256(flagBytes), outputs,
    typeImplementationDependency: build.typeImplementationDependency, originalJavaUnits: 6, utilityJavaUnits: 3, comparedClasses: CLASSES,
    originalApiSha256: sha256(Buffer.from(originalApi)), portableApiSha256: sha256(Buffer.from(portableApi)), knownGeneratedDifferences, sourceApiAdjustments: prepared.receipt.sourceApiAdjustments,
    comparison: { required: cases.length + notRun.length, passed: cases.length, failed: 0, skipped: 0, notRun: notRun.length, cases, notRunCases: notRun, observationSha256: sha256(Buffer.from(original)) },
    unrunReason: notRun.length ? 'Genuine bootstrap DefaultBuiltIns .kotlin_builtins resources lack UInt and ULong descriptors. Positive unsigned number selection requires the real KLIB descriptor/type provider; no descriptors were invented.' : null,
    compiler: { version: bootstrap.lock.version, sourceCommit: null },
    algorithmExecution: 'selected original Java type/substitution/checker algorithms versus common Kotlin ports, with genuine verified bootstrap remaining type-system/builtins/descriptor helpers',
    assertionPolicy: 'original JVM -ea; portable compiler invariant checks enabled', commands,
    requiredConcreteDependencies: prepared.receipt.requiredConcreteDependencies, wasmBuild: 'not-run: concrete builtins/descriptor/type closure required', browserCompilerBuilt: false, readiness: false };
  await writeJson(path.join(outputRoot, 'receipt.json'), receipt); return { outputRoot, receipt };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter(value => value !== '--'); const opts = {};
  for (let i = 0; i < args.length; i += 2) { if (!['--prepared-dir', '--build-dir', '--output', '--type-implementation-prepared-dir', '--type-implementation-build-dir'].includes(args[i]) || !args[i + 1] || opts[args[i]]) throw new Error('Invalid type utilities verification arguments'); opts[args[i]] = args[i + 1]; }
  if (Object.keys(opts).length !== 5) throw new Error('Usage: verify.mjs --prepared-dir PREPARED --build-dir BUILD --output NEW_DIRECTORY --type-implementation-prepared-dir TYPE_PREPARED --type-implementation-build-dir TYPE_JVM');
  const result = await verifyTypeUtilities(opts['--prepared-dir'], opts['--build-dir'], opts['--output'], { typeImplementationPrepared: opts['--type-implementation-prepared-dir'], typeImplementationBuild: opts['--type-implementation-build-dir'] }); console.log(JSON.stringify({ outputRoot: result.outputRoot, comparison: result.receipt.comparison, readiness: false }));
}

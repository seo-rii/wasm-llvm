#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, gitBlob, readJson, readRegular, sha256, verifyFile, writeJson } from '../scripts/source.mjs';
import { verifyBootstrap, defaultCache } from '../build/bootstrap.mjs';
import { inspectWasm } from '../build/baseline.mjs';
import { verifyWasiStdlibPatch } from '../patches/wasi-stdlib-patch.mjs';
import { HERE, defaultInput, loadRecipe } from './prepare.mjs';

const execute = promisify(execFile);
const PRODUCER = path.resolve(HERE, '..');
const compiler = 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler';

/** Execute the pinned generator's unchanged text replacement logic with explicit Gradle boundary inputs. */
export function versionGenerator(source) {
  const start = source.indexOf('    fun Task.replaceVersion(');
  const split = source.indexOf('\n    doLast {\n        replaceVersion', start);
  const end = source.indexOf('\n    }\n}\n\nval writePluginVersion', split);
  if (start < 0 || split < 0 || end < 0) throw new Error('Pinned version generator extraction boundary changed');
  const functionText = source.slice(start, split);
  const executionText = source.slice(split + '\n    doLast {\n'.length, end);
  return { functionText, executionText, harness: `import java.io.File
class GeneratorLogger {
    fun lifecycle(message: String) { println(message) }
    fun info(message: String) { println(message) }
}
class Task { val logger = GeneratorLogger() }
class VersionInput(private val value: String) { fun get(): String = value }
${functionText}
fun main(args: Array<String>) {
    val versionFile = File(args[0])
    val kotlinVersionLocal = VersionInput(args[1])
    with(Task()) {
${executionText}
    }
}
` };
}

export function fragmentArguments(recipe, sources) {
  const args = ['-Xfragments=' + recipe.fragments.map((fragment) => fragment.name).join(',')];
  for (const fragment of recipe.fragments) for (const parent of fragment.refines) {
    args.push('-Xfragment-refines=' + fragment.name + ':' + parent);
  }
  for (const source of sources) args.push('-Xfragment-sources=' + source.sourceSet + ':' + source.filename);
  return args;
}

function argumentFile(args) {
  return args.map((argument) => JSON.stringify(argument)).join('\n') + '\n';
}

export async function build({ input = defaultInput, output, cacheRoot = defaultCache, java = 'java' } = {}) {
  const recipe = await loadRecipe();
  const prepared = await verifyBootstrap(cacheRoot);
  input = path.resolve(input);
  const recipeSha256 = sha256(await readRegular(path.join(HERE, 'recipe.json')));
  if ((await readJson(path.join(input, 'inputs.json'))).recipeSha256 !== recipeSha256) throw new Error('Prepared stdlib input recipe changed');
  if (output) {
    output = path.resolve(output);
    await assertNoSymlink(output);
    await mkdir(path.dirname(output), { recursive: true });
    await mkdir(output);
  } else {
    const parent = path.join(input, 'builds');
    await assertNoSymlink(parent);
    await mkdir(parent, { recursive: true });
    output = await mkdtemp(path.join(parent, 'run-'));
  }
  const commands = [];
  const receipt = { schemaVersion: 1, kind: 'selected-source-kotlin-wasi-stdlib-build', source: recipe.source,
    recipeSha256, compiler: { version: prepared.lock.version, sourceCommit: null, role: 'official-bootstrap',
      jarSha256: prepared.artifacts.find((pin) => pin.id === 'compiler').sha256 },
    kotlinVersion: recipe.kotlinVersion, compilerHost: 'jvm', programTarget: 'wasmWasi',
    gradleTaskExecution: 'not-run', sourceFiles: recipe.files.length, compiledSourceFiles: 501,
    commands, status: 'building', browserCompiler: 'not-built', publicLanguageSupport: false };
  const run = async (phase, main, args, maximumHeap = '2g') => {
    const argsPath = path.join(output, phase + '.args');
    const argsBytes = Buffer.from(argumentFile(args));
    await writeFile(argsPath, argsBytes, { flag: 'wx', mode: 0o600 });
    const command = [java, '-Xmx' + maximumHeap, '-cp', prepared.classPath, main, '@' + argsPath];
    const started = performance.now();
    try {
      const result = await execute(java, command.slice(1), { cwd: output, timeout: 240000, maxBuffer: 2 * 1024 * 1024 });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      commands.push({ phase, command, argumentFile: path.basename(argsPath), argumentFileSha256: sha256(argsBytes),
        exitCode: 0, elapsedMs: performance.now() - started });
      return result;
    } catch (error) {
      const stdout = error.stdout ?? '';
      const stderr = error.stderr ?? error.message;
      await writeFile(path.join(output, phase + '.stdout.txt'), stdout, { flag: 'wx', mode: 0o600 });
      await writeFile(path.join(output, phase + '.stderr.txt'), stderr, { flag: 'wx', mode: 0o600 });
      process.stderr.write(stderr.slice(-12000));
      commands.push({ phase, command, argumentFile: path.basename(argsPath), argumentFileSha256: sha256(argsBytes),
        exitCode: Number.isInteger(error.code) ? error.code : null, failureCode: typeof error.code === 'string' ? error.code : null,
        elapsedMs: performance.now() - started, stderrPath: phase + '.stderr.txt', stderrSha256: sha256(Buffer.from(stderr)) });
      throw new Error('Official compiler phase failed: ' + phase);
    }
  };
  try {
    const sourceRoot = path.join(output, 'sources');
    for (const pin of recipe.files) {
      const bytes = verifyFile(await readRegular(path.join(input, 'sources', pin.path), pin.bytes), pin);
      const filename = path.join(sourceRoot, pin.path);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
    }
    const properties = (await readRegular(path.join(sourceRoot, 'gradle.properties'))).toString('utf8');
    for (const [name, expected] of [['defaultSnapshotVersion', recipe.kotlinVersion],
      ['kotlinLanguageVersion', recipe.languageVersion], ['bootstrap.kotlin.default.version', prepared.lock.version]]) {
      const property = properties.split('\n').find((line) => line.startsWith(name + '='))?.slice(name.length + 1).trim();
      if (property !== expected) throw new Error('Stdlib generator/compiler input differs from pinned property: ' + name);
    }
    const dogfood = (await readRegular(path.join(sourceRoot, 'repo/kotlin-build-helpers/src/dogfoodedExperimentalFeatures.kt'))).toString('utf8');
    for (const match of dogfood.matchAll(/"(-X[^"\n]+)"/g)) {
      if (!recipe.flags.includes(match[1])) throw new Error('Stdlib recipe omits an upstream feature or warning policy');
    }
    // Keep git apply inside this verified subset when output is nested under the producer worktree.
    await execute('git', ['init', '--quiet', sourceRoot], { timeout: 10000, maxBuffer: 65536 });
    receipt.sourceWorkspace = { kind: 'isolated subset repository', checkedOutCommit: null,
      identity: 'Every source byte is verified against recipe pins; this is not a full upstream checkout.' };
    receipt.patch = await verifyWasiStdlibPatch({ sourceDir: sourceRoot, abiHeader: path.join(input, 'abi', 'wasip1.h'), action: 'apply' });
    const generatorPin = recipe.files.find((pin) => pin.path === recipe.generator.sourcePath);
    const generatorSource = verifyFile(await readRegular(path.join(sourceRoot, generatorPin.path)), generatorPin).toString('utf8');
    const generator = versionGenerator(generatorSource);
    const harness = path.join(output, 'GenerateVersion.kt');
    await writeFile(harness, generator.harness, { flag: 'wx', mode: 0o600 });
    const generatorJar = path.join(output, 'version-generator.jar');
    const jvmStdlib = prepared.artifacts.find((pin) => pin.id === 'stdlib-jvm').path;
    await run('version-generator-compile', 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
      ['-no-stdlib', '-no-reflect', '-classpath', jvmStdlib, '-d', generatorJar, harness], '1g');
    const versionFilename = path.join(sourceRoot, 'libraries/stdlib/src/kotlin/util/KotlinVersion.kt');
    const originalVersion = await readRegular(versionFilename);
    const generatorRun = await execute(java, ['-Xmx256m', '-cp', generatorJar + path.delimiter + jvmStdlib,
      'GenerateVersionKt', versionFilename, recipe.kotlinVersion], { cwd: output, timeout: 30000, maxBuffer: 65536 });
    process.stdout.write(generatorRun.stdout);
    const generatedVersion = await readRegular(versionFilename);
    receipt.versionGeneration = { inputProperty: recipe.generator.inputProperty, inputValue: recipe.kotlinVersion,
      upstreamTask: ':prepare:build.version:writeStdlibVersion', upstreamGradleTaskExecution: 'not-run',
      unchangedOfficialLogicExecution: 'pass', generatorSource: generatorPin,
      functionSha256: sha256(Buffer.from(generator.functionText)), executionBodySha256: sha256(Buffer.from(generator.executionText)),
      harnessSha256: sha256(Buffer.from(generator.harness)), generatorJarSha256: sha256(await readRegular(generatorJar)),
      command: [java, '-Xmx256m', '-cp', generatorJar + path.delimiter + jvmStdlib, 'GenerateVersionKt', versionFilename, recipe.kotlinVersion],
      exitCode: 0, originalSha256: sha256(originalVersion), generatedSha256: sha256(generatedVersion), generatedGitBlob: gitBlob(generatedVersion) };
    const sources = [];
    const generatedBuiltins = [];
    for (const pin of recipe.files) {
      if (pin.kind === 'compile') sources.push({ sourceSet: pin.sourceSet, filename: path.join(sourceRoot, pin.path) });
      else if (pin.kind === 'builtin-copy') {
        const bytes = verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin);
        const filename = path.join(sourceRoot, pin.generatedPath);
        await mkdir(path.dirname(filename), { recursive: true });
        await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
        sources.push({ sourceSet: pin.sourceSet, filename });
        generatedBuiltins.push({ sourcePath: pin.path, generatedPath: pin.generatedPath, sha256: pin.sha256 });
      }
    }
    receipt.builtinGeneration = { kind: 'upstream Sync copy adapter', upstreamTask: ':kotlin-stdlib:prepareWasmBuiltinSources',
      upstreamGradleTaskExecution: 'not-run', copied: generatedBuiltins, sourceBytesPreserved: true };
    const stdlibDirectory = path.join(output, 'stdlib');
    await mkdir(stdlibDirectory);
    await run('stdlib-klib', compiler, ['-Xwasm-target=wasm-wasi', ...recipe.flags,
      '-language-version', recipe.languageVersion, '-api-version', recipe.apiVersion,
      ...fragmentArguments(recipe, sources), '-ir-output-dir', stdlibDirectory, '-ir-output-name', 'kotlin-stdlib-wasm-wasi',
      ...sources.map((source) => source.filename)]);
    const stdlibPath = 'stdlib/kotlin-stdlib-wasm-wasi.klib';
    const stdlib = await readRegular(path.join(output, stdlibPath), 16 * 1024 * 1024);
    receipt.stdlib = { path: stdlibPath, bytes: stdlib.length, sha256: sha256(stdlib), version: recipe.kotlinVersion,
      sourceCommit: recipe.source.commit, patched: true, patchSha256: recipe.patch.sha256 };
    receipt.status = 'pass';
    await writeJson(path.join(output, 'stdlib-receipt.json'), receipt);
    console.log(JSON.stringify({ output, stdlib: receipt.stdlib, status: receipt.status }));
    return { output, receipt };
  } catch (error) {
    receipt.status = 'fail';
    receipt.failure = error.message;
    await writeJson(path.join(output, 'stdlib-receipt.json'), receipt);
    throw new Error(error.message + '; output=' + output);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2).filter((argument) => argument !== '--');
    const options = {};
    while (args.length) {
      const flag = args.shift();
      const key = { '--input': 'input', '--output': 'output', '--cache-dir': 'cacheRoot' }[flag];
      if (!key || !args[0] || args[0].startsWith('--') || options[key]) throw new Error('Invalid stdlib build option');
      options[key] = path.resolve(args.shift());
    }
    await build(options);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { units, cases, requiredCounts } from './weakref-fixtures.mjs';
import { inspectWeakrefObject } from './weakref-inspect.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index].replace(/^--/, '');
  assert(['work', 'compiler', 'source', 'sdk', 'sysroot', 'gcc-cxx-sysroot', 'output'].includes(key)
    && process.argv[index + 1] && !options[key], `Invalid option ${process.argv[index]}`);
  options[key] = path.resolve(process.argv[index + 1]);
}
for (const key of ['work', 'compiler', 'source', 'sdk', 'sysroot', 'gcc-cxx-sysroot', 'output'])
  assert(options[key], `Required --${key}`);
const { work, compiler, source, sdk, sysroot, output } = options;
const gnuSysroot = options['gcc-cxx-sysroot'], gnuRoot = path.dirname(gnuSysroot);
await fs.mkdir(output, { recursive: false });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fixtureHash = value => digest(JSON.stringify(value));
// Keep fixture identifiers in receipts and avoid tool-special characters such
// as percent signs in the collision-free filesystem names.
function directoryName(id) {
  assert(/^[a-zA-Z0-9:-]+$/.test(id), `Unsafe fixture identifier: ${id}`);
  return id.replaceAll(':', '--');
}
for (const entries of [units, cases])
  assert.equal(new Set(entries.map(entry => directoryName(entry.id))).size, entries.length, 'Fixture directory collision');
async function identify(file) {
  const bytes = await fs.readFile(file);
  return { path: path.resolve(file), bytes: bytes.length, sha256: digest(bytes) };
}
const inputMap = new Map();
async function freeze(file) {
  const value = await identify(file);
  if (inputMap.has(value.path)) assert.deepEqual(value, inputMap.get(value.path), `Changed frozen input: ${value.path}`);
  else inputMap.set(value.path, value);
  return value;
}
async function tree(directory) {
  const result = [];
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await tree(file));
    else if (entry.isFile()) result.push(await freeze(file));
    else assert.fail(`Unexpected header entry: ${file}`);
  }
  return result;
}
function run(command, argv, stdin = null, timeout = 120000) {
  const result = spawnSync(command, argv, { cwd: output, input: stdin ?? undefined,
    encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
  return { command, argv, status: result.status, signal: result.signal, stdin,
    stdout: result.stdout || '', stderr: result.stderr || '', ...(result.error ? { error: result.error.message } : {}) };
}
function success(result) {
  assert.equal(result.status, 0, result.stderr || result.error || 'Command failed');
  assert.equal(result.signal, null); assert(!result.error); return result;
}
async function readFrozenJson(file) { await freeze(file); return JSON.parse(await fs.readFile(file)); }
async function checkSource(component, directory) {
  const result = success(run('python3', [path.join(here, 'prepare-source.py'), '--component', component, '--source', directory], null, 600000));
  report.sourceChecks.push(result); return JSON.parse(result.stdout);
}
const toolPaths = { gcc: path.join(compiler, 'cc1'), gccCpp: path.join(compiler, 'cc1plus'), xgcc: path.join(compiler, 'xgcc'),
  clang: path.join(sdk, 'bin/clang'), clangCpp: path.join(sdk, 'bin/clang++'),
  assembler: path.join(work, 'wabt-native/wat2wasm'), objdump: path.join(work, 'wabt-native/wasm-objdump'),
  validator: path.join(work, 'wabt-native/wasm-validate'), linker: path.join(sdk, 'bin/wasm-ld'), node: process.execPath };
const report = { schemaVersion: 1, kind: 'gcc-wasi-native-weakref-qualification', status: 'running',
  executionHost: 'native', sourceChecks: [], units: [], cases: [] };
async function saveProgress(stage) {
  const value = { status: report.status, stage, units: report.units.length, cases: report.cases.length,
    passedUnits: report.units.filter(unit => unit.status === 'passed').length,
    passedCases: report.cases.filter(fixture => fixture.status === 'passed').length };
  await fs.writeFile(path.join(output, 'progress.json'), JSON.stringify(value, null, 2) + '\n');
}
let gnuIncludes, runner;
function compileCommand(unit, input, assembly, object) {
  const { optimization, language, compiler: family, suite } = unit;
  const cpp = language === 'cpp', standard = cpp ? 'gnu++17' : 'gnu11';
  const executable = toolPaths[family === 'gcc' ? (cpp ? 'gccCpp' : 'gcc') : (cpp ? 'clangCpp' : 'clang')];
  const cHeaders = ['-isystem', path.join(sysroot, 'include/wasm32-wasi')];
  const gccHeaders = ['-nostdinc', '-isystem', path.join(compiler, 'include'), ...cHeaders];
  let argv;
  if (suite === 'core') {
    const common = [`-O${optimization}`, `-std=${standard}`, '-fdiagnostics-color=never'];
    argv = family === 'gcc' ? ['-quiet', ...common, '-Werror=attributes', '-D__GCC_WASI_SINGLE_THREAD__=1', ...gccHeaders,
      ...(cpp ? ['-fno-exceptions', '-fno-rtti'] : ['-Werror=implicit-function-declaration']), input, '-o', assembly]
      : ['--target=wasm32-wasi', '--sysroot=' + sysroot, ...common, '-Werror=ignored-attributes', ...cHeaders,
        ...(cpp ? ['-fno-exceptions', '-fno-rtti', '-nostdinc++'] : []), '-c', input, '-o', object];
  } else if (suite === 'gnu') {
    const common = [`-O${optimization}`, '-std=gnu++17', '-fno-exceptions', '-fno-rtti', '-fuse-cxa-atexit',
      '-fno-threadsafe-statics', '-fdiagnostics-color=never', '-Werror=attributes'];
    argv = family === 'gcc' ? ['-quiet', ...common, '-nostdinc', '-D__GCC_WASI_SINGLE_THREAD__=1',
      ...gnuIncludes.flatMap(directory => ['-isystem', directory]), input, '-o', assembly]
      : ['--target=wasm32-wasi', '--sysroot=' + sysroot, ...common, ...cHeaders, '-c', input, '-o', object];
  } else {
    const common = [`-O${optimization}`, `-std=${standard}`, '-mno-simd128', '-fdiagnostics-color=never',
      '-Werror=attributes', '-D__GCC_WASI_SINGLE_THREAD__=1',
      ...(cpp ? ['-fno-exceptions', '-fno-rtti', '-fuse-cxa-atexit', '-fno-threadsafe-statics'] : [])];
    argv = family === 'gcc' ? ['-quiet', ...common, ...gccHeaders, input, '-o', assembly]
      : ['--target=wasm32-wasi', '--sysroot=' + sysroot, ...common, ...cHeaders, '-c', input, '-o', object];
  }
  return run(executable, argv);
}
try {
  report.tools = Object.fromEntries(await Promise.all(Object.entries(toolPaths).map(async ([name, file]) => [name, await freeze(file)])));
  report.recipes = Object.fromEntries(await Promise.all(['test-weakrefs.mjs', 'weakref-fixtures.mjs', 'weakref-inspect.mjs',
    'symbol-alias-inspect.mjs', 'inspect-vector-abi.mjs', 'prepare-source.py', 'build-native.sh', 'build-wabt.sh', 'build-libstdcxx.sh',
    'test-libstdcxx.mjs', 'runtime.lock.json'].map(async name => [name, await freeze(path.join(here, name))])));
  report.fixtures = report.recipes['weakref-fixtures.mjs'];
  report.sourceLock = await freeze(path.join(here, 'sources.lock.json'));
  const lock = await readFrozenJson(report.sourceLock.path);
  for (const component of ['gcc', 'wabt']) for (const patch of lock[component].patches)
    assert.equal((await freeze(path.join(here, patch.path))).sha256, patch.sha256);
  report.nativeBuild = await freeze(path.join(work, 'native-build.json'));
  const native = await readFrozenJson(report.nativeBuild.path);
  assert.equal(native.sourceLockSha256, report.sourceLock.sha256);
  assert.equal(native.recipeSha256, report.recipes['build-native.sh'].sha256);
  for (const [tool, name] of [['cc1', 'gcc'], ['cc1plus', 'gccCpp'], ['xgcc', 'xgcc']])
    assert.equal(native.tools[tool].sha256, report.tools[name].sha256, `Native ${tool} identity`);
  report.gccSource = await checkSource('gcc', source);
  assert.deepEqual(report.gccSource, native.gccSource);
  report.assemblerProvenance = await freeze(path.join(work, 'wabt-native/provenance.json'));
  const assembler = await readFrozenJson(report.assemblerProvenance.path);
  report.assemblerSource = await checkSource('wabt', path.join(work, 'wabt-source'));
  assert(assembler.inputsUnchanged); assert.equal(assembler.host, 'native');
  assert.deepEqual(assembler.source, report.assemblerSource);
  for (const [name, tool] of [['wat2wasm', 'assembler'], ['wasm-objdump', 'objdump'], ['wasm-validate', 'validator']])
    assert.deepEqual(assembler.files[name], { bytes: report.tools[tool].bytes, sha256: report.tools[tool].sha256 });
  for (const [name, expected] of Object.entries(assembler.recipes)) {
    const current = await freeze(path.join(here, name));
    assert.deepEqual({ bytes: current.bytes, sha256: current.sha256 }, expected, `Assembler recipe: ${name}`);
  }
  const library = path.join(sysroot, 'lib/wasm32-wasi'), gnuLibrary = path.join(gnuSysroot, 'lib/wasm32-wasi');
  const archivePaths = { crt: path.join(library, 'crt1-command.o'), libc: path.join(library, 'libc.a'), libm: path.join(library, 'libm.a'),
    libstdcxx: path.join(gnuLibrary, 'libstdc++.a'), libsupcxx: path.join(gnuLibrary, 'libsupc++.a'),
    builtins: path.join(sdk, 'lib/clang/22/lib/wasm32-unknown-wasi/libclang_rt.builtins.a') };
  const headerRoots = { gcc: path.join(compiler, 'include'), target: path.join(sysroot, 'include'),
    gnu: path.join(gnuSysroot, 'include'), clang: path.join(sdk, 'lib/clang/22/include') };
  report.runtime = { sysroot, gnuSysroot, headerRoots, headers: {}, archives: {},
    gnuBuild: await freeze(path.join(gnuRoot, 'build.json')),
    gnuQualification: await freeze(path.join(gnuRoot, 'qualification/qualification.json')),
    gnuReceipt: await freeze(path.join(gnuRoot, 'libstdcxx-build.json')) };
  for (const [name, directory] of Object.entries(headerRoots)) report.runtime.headers[name] = await tree(directory);
  for (const [name, file] of Object.entries(archivePaths)) report.runtime.archives[name] = await freeze(file);
  const gnuBuild = await readFrozenJson(report.runtime.gnuBuild.path);
  const gnuQualification = await readFrozenJson(report.runtime.gnuQualification.path);
  const gnuReceipt = await readFrozenJson(report.runtime.gnuReceipt.path);
  assert.deepEqual(gnuBuild.gccSource, report.gccSource, 'GNU runtime must be rebuilt from the current source');
  for (const [name, tool] of [['cc1', 'gcc'], ['cc1plus', 'gccCpp'], ['xgcc', 'xgcc']])
    assert.equal(gnuBuild.nativeCompiler[name], report.tools[tool].sha256, `GNU compiler: ${name}`);
  assert.equal(gnuQualification.status, 'passed'); assert.equal(gnuReceipt.status, 'passed');
  assert.deepEqual(gnuQualification.buildReceipt, { bytes: report.runtime.gnuBuild.bytes, sha256: report.runtime.gnuBuild.sha256 });
  for (const [name, current] of [['buildReceipt', report.runtime.gnuBuild], ['qualification', report.runtime.gnuQualification]])
    assert.deepEqual({ bytes: gnuReceipt[name].bytes, sha256: gnuReceipt[name].sha256 }, { bytes: current.bytes, sha256: current.sha256 });
  for (const [name, tool] of [['libstdc++.a', 'libstdcxx'], ['libsupc++.a', 'libsupcxx']]) {
    const actual = report.runtime.archives[tool]; assert.deepEqual(gnuBuild.libraries[name], { bytes: actual.bytes, sha256: actual.sha256 });
  }
  for (const item of gnuReceipt.files) {
    const actual = await freeze(path.join(gnuSysroot, item.path));
    assert.deepEqual({ bytes: actual.bytes, sha256: actual.sha256 }, { bytes: item.bytes, sha256: item.sha256 });
  }
  const versions = (await fs.readdir(path.join(gnuSysroot, 'include/c++'))).filter(name => /^\d/.test(name));
  assert.equal(versions.length, 1);
  const gnuVersion = path.join(gnuSysroot, 'include/c++', versions[0]);
  gnuIncludes = [gnuVersion, path.join(gnuVersion, 'wasm32-wasi'), path.join(gnuVersion, 'backward'),
    path.join(compiler, 'include'), path.join(sysroot, 'include/wasm32-wasi')];
  report.runtime.gnuIncludePaths = gnuIncludes;
  runner = path.join(output, 'run-wasi.mjs');
  await fs.writeFile(runner, "import{WASI}from'node:wasi';import{readFile}from'node:fs/promises';const w=new WASI({version:'preview1',args:['program'],env:{},returnOnExit:true});process.exitCode=w.start(await WebAssembly.instantiate(await WebAssembly.compile(await readFile(process.argv[2])),{wasi_snapshot_preview1:w.wasiImport}));\n");
  report.runner = await freeze(runner);
  const compiled = new Map();
  for (const unit of units) {
    const directory = path.join(output, 'units', directoryName(unit.id)); await fs.mkdir(directory, { recursive: true });
    const input = path.join(directory, unit.language === 'cpp' ? 'source.cc' : 'source.c');
    const assembly = path.join(directory, 'source.wat'), object = path.join(directory, 'source.o');
    await fs.writeFile(input, unit.code);
    const entry = { id: unit.id, fixtureSha256: fixtureHash(unit), status: 'running', source: await freeze(input), commands: {} };
    report.units.push(entry); compiled.set(unit.id, entry);
    try {
      entry.commands.compile = compileCommand(unit, input, assembly, object); success(entry.commands.compile);
      if (unit.compiler === 'gcc') {
        entry.assembly = await freeze(assembly);
        entry.commands.assemble = run(toolPaths.assembler, ['-r', '--enable-annotations', assembly, '-o', object]); success(entry.commands.assemble);
      }
      entry.object = await freeze(object);
      entry.commands.validate = run(toolPaths.validator, [object]); success(entry.commands.validate);
      entry.inspection = inspectWeakrefObject(await fs.readFile(object), unit);
      entry.status = 'passed';
    } catch (error) { entry.status = 'failed'; entry.error = error.message; }
    await saveProgress('compile');
  }
  for (const fixture of cases) {
    const entry = { id: fixture.id, fixtureSha256: fixtureHash(fixture), units: fixture.units, runtime: fixture.runtime,
      stdin: fixture.stdin, expectedStdout: fixture.stdout, expectedLinkRejection: fixture.expectedLinkRejection,
      requiredLinkDiagnostics: fixture.requiredLinkDiagnostics, status: 'running', commands: {} };
    report.cases.push(entry);
    try {
      const objects = fixture.units.map(id => { const unit = compiled.get(id); assert.equal(unit.status, 'passed', `Unit failed: ${id}`); return unit.object.path; });
      const directory = path.join(output, 'cases', directoryName(fixture.id)); await fs.mkdir(directory, { recursive: true });
      const program = path.join(directory, 'program.wasm');
      const argv = ['--fatal-warnings', '-m', 'wasm32', '-e', '_start', '-o', program, archivePaths.crt, '-L' + library,
        ...objects, ...(fixture.runtime === 'gnu' ? [archivePaths.libstdcxx, archivePaths.libsupcxx] : []), '-lm', '-lc', archivePaths.builtins];
      entry.commands.link = run(toolPaths.linker, argv);
      if (fixture.expectedLinkRejection) {
        assert.equal(entry.commands.link.status, 1, 'Strict-link control must fail in the linker');
        assert.equal(entry.commands.link.signal, null); assert(!entry.commands.link.error);
        for (const diagnostic of fixture.requiredLinkDiagnostics) assert(entry.commands.link.stderr.includes(diagnostic), `Missing linker diagnostic: ${diagnostic}`);
        await assert.rejects(fs.stat(program), { code: 'ENOENT' }, 'Rejected link left an executable');
        entry.outcome = 'link-rejection';
      } else {
        success(entry.commands.link); entry.program = await freeze(program);
        const module = new WebAssembly.Module(await fs.readFile(program));
        entry.imports = WebAssembly.Module.imports(module); entry.exports = WebAssembly.Module.exports(module);
        assert(entry.imports.every(value => value.module === 'wasi_snapshot_preview1' && value.kind === 'function'));
        assert(entry.exports.some(value => value.name === '_start' && value.kind === 'function'));
        assert(entry.exports.some(value => value.name === 'memory' && value.kind === 'memory'));
        entry.commands.run = run(toolPaths.node, ['--no-warnings', runner, program], fixture.stdin); success(entry.commands.run);
        entry.stdout = entry.commands.run.stdout; entry.stderr = entry.commands.run.stderr;
        assert.equal(entry.stdout, fixture.stdout); assert.equal(entry.stderr, ''); entry.outcome = 'runtime-pass';
      }
      entry.status = 'passed';
    } catch (error) { entry.status = 'failed'; entry.error = error.message; }
    await saveProgress('link-and-run');
  }
  for (const expected of inputMap.values()) assert.deepEqual(await identify(expected.path), expected, `Changed input/artifact: ${expected.path}`);
  assert.deepEqual(await checkSource('gcc', source), report.gccSource);
  assert.deepEqual(await checkSource('wabt', path.join(work, 'wabt-source')), report.assemblerSource);
  report.inputsUnchanged = true;
  report.counts = { units: report.units.filter(unit => unit.status === 'passed').length,
    cases: report.cases.filter(fixture => fixture.status === 'passed').length,
    runtimePasses: report.cases.filter(fixture => fixture.status === 'passed' && fixture.outcome === 'runtime-pass').length,
    linkRejections: report.cases.filter(fixture => fixture.status === 'passed' && fixture.outcome === 'link-rejection').length };
  assert.deepEqual(report.counts, requiredCounts, 'Incomplete weak-reference qualification');
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack || error.message; }
report.inputs = [...inputMap.values()];
await fs.writeFile(path.join(output, 'qualification.json'), JSON.stringify(report, null, 2) + '\n');
await saveProgress('complete');
console.log(JSON.stringify({ status: report.status, counts: report.counts, error: report.error?.slice(0, 800), report: path.join(output, 'qualification.json') }));
if (report.status !== 'passed') process.exitCode = 1;

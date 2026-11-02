#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { units, cases, metadataControls, diagnostics, requiredCounts, wasiRunnerSource } from './coverage-fixtures.mjs';
import { inspectCoverageObject, verifyGcovJson } from './coverage-inspect.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index].replace(/^--/, '');
  assert(['work', 'compiler', 'source', 'sdk', 'sysroot', 'gcc-cxx-sysroot', 'libgcov', 'native-gcov', 'output'].includes(key)
    && process.argv[index + 1] && !options[key], `Invalid option ${process.argv[index]}`);
  options[key] = path.resolve(process.argv[index + 1]);
}
for (const key of ['work', 'sdk', 'sysroot', 'gcc-cxx-sysroot', 'libgcov', 'native-gcov', 'output'])
  assert(options[key], `Required --${key}`);
const { work, sdk, sysroot, output } = options;
const compiler = options.compiler ?? path.join(work, 'gcc-native/gcc');
const source = options.source ?? path.join(work, 'gcc');
const gnuSysroot = options['gcc-cxx-sysroot'], gnuRoot = path.dirname(gnuSysroot), coverageRoot = options.libgcov;
await fs.mkdir(output, { recursive: false }); // Never merge a previous qualification.
const digest = value => createHash('sha256').update(value).digest('hex');
const fixtureHash = value => digest(JSON.stringify(value));
const inputMap = new Map();
async function identify(file) {
  const bytes = await fs.readFile(file);
  return { path: path.resolve(file), bytes: bytes.length, sha256: digest(bytes) };
}
const compactIdentity = ({ bytes, sha256 }) => ({ bytes, sha256 });
async function freeze(file) {
  const current = await identify(file);
  if (inputMap.has(current.path)) assert.deepEqual(current, inputMap.get(current.path), `Changed input: ${current.path}`);
  else inputMap.set(current.path, current);
  return current;
}
async function tree(directory) {
  const result = [];
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await tree(file));
    else { assert(entry.isFile(), `Unexpected non-file input: ${file}`); result.push(await freeze(file)); }
  }
  return result;
}
async function json(file) { await freeze(file); return JSON.parse(await fs.readFile(file)); }
function run(command, argv, cwd = output, stdin = null, timeout = 120000) {
  const result = spawnSync(command, argv, { cwd, input: stdin ?? undefined, encoding: 'utf8', timeout,
    maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
  return { command, argv, cwd, stdin, status: result.status, signal: result.signal,
    stdout: result.stdout || '', stderr: result.stderr || '', ...(result.error ? { error: result.error.message } : {}) };
}
function success(result) {
  assert.equal(result.status, 0, result.stderr || result.error || 'Command failed');
  assert.equal(result.signal, null); assert(!result.error); return result;
}
const tools = { gcc: path.join(compiler, 'cc1'), gccCpp: path.join(compiler, 'cc1plus'), xgcc: path.join(compiler, 'xgcc'),
  assembler: path.join(work, 'wabt-native/wat2wasm'), objdump: path.join(work, 'wabt-native/wasm-objdump'),
  validator: path.join(work, 'wabt-native/wasm-validate'), linker: path.join(sdk, 'bin/wasm-ld'),
  ar: path.join(sdk, 'bin/llvm-ar'), nm: path.join(sdk, 'bin/llvm-nm'),
  gcov: options['native-gcov'], gcovDump: path.join(path.dirname(options['native-gcov']), 'gcov-dump'), node: process.execPath };
const report = { schemaVersion: 1, kind: 'gcc-wasi-native-coverage-qualification', status: 'running',
  executionHost: 'native', target: 'wasm32-wasi', sourceChecks: [], units: [], cases: [], metadataControls: [], diagnostics: [] };
const profile = { format: 'gcc-gcov', update: 'single', normalExit: true, manualGcovApi: false, pgo: false,
  threads: false, processPidSemantics: false, directoryCreation: false };
async function save(stage) {
  await fs.writeFile(path.join(output, 'progress.json'), JSON.stringify({ status: report.status, stage,
    units: report.units.length, passedUnits: report.units.filter(value => value.status === 'passed').length,
    cases: report.cases.length, passedCases: report.cases.filter(value => value.status === 'passed').length,
    metadataControls: report.metadataControls.length, diagnostics: report.diagnostics.length }, null, 2) + '\n');
  await fs.writeFile(path.join(output, 'qualification.json'), JSON.stringify(report, null, 2) + '\n');
}
async function checkSource(component, directory) {
  const command = success(run('python3', [path.join(here, 'prepare-source.py'), '--component', component, '--source', directory], output, null, 600000));
  report.sourceChecks.push(command); return JSON.parse(command.stdout);
}
let gnuIncludes, archives, runner;
function compile(unit, input, assembly, directory, extraFlags = []) {
  const cpp = unit.language === 'cpp', extension = cpp ? '.cpp' : '.c';
  const flags = [`-O${unit.optimization}`, `-std=${unit.standard}`, '-mno-simd128', '-fdiagnostics-color=never',
    '-nostdinc', '-D__GCC_WASI_SINGLE_THREAD__=1',
    ...(cpp ? ['-fno-exceptions', '-frtti', '-fuse-cxa-atexit', '-fno-threadsafe-statics'] : ['-Werror=implicit-function-declaration']),
    ...(cpp ? gnuIncludes : [path.join(compiler, 'include'), path.join(sysroot, 'include/wasm32-wasi')]).flatMap(value => ['-isystem', value]),
    '-dumpbase', unit.gcovStem + extension, '-dumpbase-ext', extension,
    '-fprofile-dir=/profile', '-fprofile-prefix-path=' + directory];
  const coverageFlags = unit.mode === 'coverage' ? ['-fprofile-arcs', '-ftest-coverage', '-fprofile-update=single']
    : unit.mode === 'notes' ? ['-ftest-coverage'] : unit.mode === 'arcs' ? ['-fprofile-arcs', '-fprofile-update=single'] : [];
  if (unit.driver) return run(tools.xgcc, ['-B' + compiler + '/', '-specs=' + path.join(work, 'native-driver.specs'),
    // An absolute driver -o injects an absolute -dumpdir, overriding the flat
    // auxiliary namespace. Keep the output relative to this isolated cwd.
    '-S', ...flags, '--coverage', ...extraFlags, input, '-o', path.basename(assembly)], directory);
  return run(cpp ? tools.gccCpp : tools.gcc, ['-quiet', ...flags, ...coverageFlags, ...extraFlags, input, '-o', assembly], directory);
}
async function compileUnit(unit, category) {
  const directory = path.join(output, category, unit.id); await fs.mkdir(directory, { recursive: true });
  const input = path.join(directory, 'source' + (unit.language === 'cpp' ? '.cpp' : '.c'));
  const assembly = path.join(directory, 'program.wat'), object = path.join(directory, 'program.o');
  await fs.writeFile(input, unit.code);
  const entry = { id: unit.id, fixtureSha256: fixtureHash(unit), status: 'running', source: await freeze(input), commands: {}, notes: [] };
  try {
    entry.commands.compile = compile(unit, input, assembly, directory); success(entry.commands.compile);
    entry.assembly = await freeze(assembly);
    const notes = (await fs.readdir(directory)).filter(name => name.endsWith('.gcno'));
    assert.deepEqual(notes, unit.mode === 'coverage' || unit.mode === 'notes' ? [unit.gcovStem + '.gcno'] : [], 'Exact auxiliary notes filename');
    for (const name of notes) {
      const note = await freeze(path.join(directory, name)), dump = run(tools.gcovDump, ['-l', note.path], directory); success(dump);
      assert(dump.stdout.includes("version `B70 '"), 'Unexpected pinned gcov version word');
      assert.equal(dump.stderr, ''); entry.notes.push({ ...note, dump });
    }
    entry.commands.assemble = run(tools.assembler, ['-r', '--enable-annotations', assembly, '-o', object], directory); success(entry.commands.assemble);
    entry.object = await freeze(object);
    entry.commands.validate = run(tools.validator, [object], directory); success(entry.commands.validate);
    entry.commands.disassemble = run(tools.objdump, ['-d', object], directory); success(entry.commands.disassemble);
    entry.inspection = inspectCoverageObject(await fs.readFile(object), unit, entry.commands.disassemble.stdout);
    entry.status = 'passed';
  } catch (error) { entry.status = 'failed'; entry.error = error.message; }
  return entry;
}

try {
  report.tools = Object.fromEntries(await Promise.all(Object.entries(tools).map(async ([name, file]) => [name, await freeze(file)])));
  report.recipes = Object.fromEntries(await Promise.all(['test-coverage.mjs', 'coverage-fixtures.mjs', 'coverage-inspect.mjs',
    'symbol-alias-inspect.mjs', 'inspect-vector-abi.mjs', 'prepare-source.py', 'build-native.sh', 'build-wabt.sh',
    'build-libgcov.sh', 'build-libgcov.py', 'runtime.lock.json'].map(async name => [name, await freeze(path.join(here, name))])));
  report.fixtures = report.recipes['coverage-fixtures.mjs']; report.profile = profile;
  report.sourceLock = await freeze(path.join(here, 'sources.lock.json'));
  const lock = await json(report.sourceLock.path);
  for (const component of ['gcc', 'wabt']) for (const patch of lock[component].patches)
    assert.equal((await freeze(path.join(here, patch.path))).sha256, patch.sha256);
  report.nativeBuild = await freeze(path.join(work, 'native-build.json'));
  const native = await json(report.nativeBuild.path);
  assert.equal(native.sourceLockSha256, report.sourceLock.sha256);
  assert.equal(native.recipeSha256, report.recipes['build-native.sh'].sha256);
  for (const [name, tool] of [['cc1', 'gcc'], ['cc1plus', 'gccCpp'], ['xgcc', 'xgcc']])
    assert.equal(native.tools[name].sha256, report.tools[tool].sha256, `Native tool: ${name}`);
  report.gccSource = await checkSource('gcc', source); assert.deepEqual(report.gccSource, native.gccSource);
  assert.equal(report.gccSource.sourceDiffSha256, lock.gcc.sourceDiffSha256);
  report.assemblerSource = await checkSource('wabt', path.join(work, 'wabt-source'));
  report.assemblerProvenance = await freeze(path.join(work, 'wabt-native/provenance.json'));
  const assembler = await json(report.assemblerProvenance.path);
  assert(assembler.inputsUnchanged); assert.equal(assembler.host, 'native'); assert.deepEqual(assembler.source, report.assemblerSource);
  for (const [name, tool] of [['wat2wasm', 'assembler'], ['wasm-objdump', 'objdump'], ['wasm-validate', 'validator']])
    assert.deepEqual(assembler.files[name], compactIdentity(report.tools[tool]));
  for (const [name, expected] of Object.entries(assembler.recipes))
    assert.deepEqual(compactIdentity(await freeze(path.join(here, name))), expected, `WABT recipe: ${name}`);
  report.analysisTools = { gccSource: report.gccSource, nativeBuild: report.nativeBuild,
    sources: Object.fromEntries(await Promise.all(['gcov.cc', 'gcov-dump.cc', 'gcov-io.cc', 'gcov-io.h', 'gcov-counter.def'].map(async name => [name, await freeze(path.join(source, 'gcc', name))]))),
    buildMakefile: await freeze(path.join(compiler, 'Makefile')),
    gcovVersion: success(run(tools.gcov, ['--version'])), gcovDumpVersion: success(run(tools.gcovDump, ['--version'])),
    versionWord: 'B70 ', jsonFormatVersion: '2' };
  for (const key of ['gcovVersion', 'gcovDumpVersion']) assert(report.analysisTools[key].stdout.includes('17.0.0'));
  const library = path.join(sysroot, 'lib/wasm32-wasi'), gnuLibrary = path.join(gnuSysroot, 'lib/wasm32-wasi');
  const coverageLibrary = path.join(coverageRoot, 'sysroot/lib/wasm32-wasi');
  archives = { crt: path.join(library, 'crt1-command.o'), libc: path.join(library, 'libc.a'), libm: path.join(library, 'libm.a'),
    libstdcxx: path.join(gnuLibrary, 'libstdc++.a'), libsupcxx: path.join(gnuLibrary, 'libsupc++.a'),
    builtins: path.join(library, 'libclang_rt.builtins-wasm32.a'),
    libgcov: path.join(coverageLibrary, 'libgcov.a'), getpid: path.join(coverageLibrary, 'libwasi-emulated-getpid.a') };
  const headerRoots = { gcc: path.join(compiler, 'include'), target: path.join(sysroot, 'include'), gnu: path.join(gnuSysroot, 'include') };
  report.runtime = { sysroot, gnuSysroot, coverageRoot, headerRoots, headers: {}, archives: {},
    importReceipt: await freeze(path.join(path.dirname(sysroot), 'runtime-build.json')),
    gnuBuild: await freeze(path.join(gnuRoot, 'build.json')), gnuQualification: await freeze(path.join(gnuRoot, 'qualification/qualification.json')),
    gnuReceipt: await freeze(path.join(gnuRoot, 'libstdcxx-build.json')), coverageBuild: await freeze(path.join(coverageRoot, 'build.json')) };
  for (const [name, directory] of Object.entries(headerRoots)) report.runtime.headers[name] = await tree(directory);
  for (const [name, file] of Object.entries(archives)) report.runtime.archives[name] = await freeze(file);
  const imported = await json(report.runtime.importReceipt.path);
  assert.deepEqual(imported.runtimeLock, compactIdentity(report.recipes['runtime.lock.json']));
  for (const item of imported.files) assert.deepEqual(compactIdentity(await freeze(path.join(sysroot, item.path))), compactIdentity(item));
  const gnuBuild = await json(report.runtime.gnuBuild.path), gnuQualification = await json(report.runtime.gnuQualification.path), gnuReceipt = await json(report.runtime.gnuReceipt.path);
  assert.deepEqual(gnuBuild.gccSource, report.gccSource);
  assert.equal(gnuQualification.status, 'passed'); assert.equal(gnuReceipt.status, 'passed');
  for (const receipt of [gnuBuild, gnuQualification, gnuReceipt]) { assert.equal(receipt.rtti, true); assert.equal(receipt.exceptions, false); }
  for (const [name, tool] of [['cc1', 'gcc'], ['cc1plus', 'gccCpp'], ['xgcc', 'xgcc']]) assert.equal(gnuBuild.nativeCompiler[name], report.tools[tool].sha256);
  assert.deepEqual(gnuQualification.buildReceipt, compactIdentity(report.runtime.gnuBuild));
  for (const [name, key] of [['buildReceipt', 'gnuBuild'], ['qualification', 'gnuQualification']])
    assert.deepEqual(compactIdentity(gnuReceipt[name]), compactIdentity(report.runtime[key]));
  for (const [name, tool] of [['libstdc++.a', 'libstdcxx'], ['libsupc++.a', 'libsupcxx']])
    assert.deepEqual(gnuBuild.libraries[name], compactIdentity(report.runtime.archives[tool]));
  for (const item of gnuReceipt.files) assert.deepEqual(compactIdentity(await freeze(path.join(gnuSysroot, item.path))), compactIdentity(item));
  const coverageBuild = await json(report.runtime.coverageBuild.path);
  assert.equal(coverageBuild.status, 'built-unverified'); assert.equal(coverageBuild.inputsUnchanged, true);
  assert.deepEqual(coverageBuild.profile, profile); assert.deepEqual(coverageBuild.gccSource, report.gccSource);
  assert.deepEqual(coverageBuild.sourceLock, report.sourceLock); assert.deepEqual(coverageBuild.nativeBuild, report.nativeBuild);
  assert.deepEqual(coverageBuild.runtimeImport, report.runtime.importReceipt);
  assert.deepEqual(coverageBuild.objects.map(value => value.selection), ['-DL_gcov', '-DL_gcov_merge_add']);
  for (const item of coverageBuild.inputs) assert.deepEqual(await freeze(item.path), item);
  for (const [name, tool] of [['libgcov.a', 'libgcov'], ['libwasi-emulated-getpid.a', 'getpid']])
    assert.deepEqual(coverageBuild.libraries[name], report.runtime.archives[tool]);
  report.runtime.coverageMembers = success(run(tools.ar, ['t', archives.libgcov]));
  assert.deepEqual(report.runtime.coverageMembers.stdout.trim().split('\n'), ['_gcov.o', '_gcov_merge_add.o']);
  report.runtime.coverageSymbols = success(run(tools.nm, ['--defined-only', archives.libgcov]));
  for (const name of ['__gcov_init', '__gcov_exit', '__gcov_merge_add'])
    assert(new RegExp('\\bT ' + name + '(?:\\n|$)').test(report.runtime.coverageSymbols.stdout), `Missing real runtime definition: ${name}`);
  const version = path.join(gnuSysroot, 'include/c++/17.0.0');
  gnuIncludes = [version, path.join(version, 'wasm32-wasi'), path.join(version, 'backward'),
    path.join(compiler, 'include'), path.join(sysroot, 'include/wasm32-wasi')];
  report.runtime.gnuIncludePaths = gnuIncludes;
  runner = path.join(output, 'run-wasi.mjs'); await fs.writeFile(runner, wasiRunnerSource); report.runner = await freeze(runner);
  const compiled = new Map();
  for (const unit of units) {
    const entry = await compileUnit(unit, 'units'); report.units.push(entry); compiled.set(unit.id, entry); await save('compile');
  }
  for (const unit of metadataControls) { report.metadataControls.push(await compileUnit(unit, 'metadata')); await save('metadata'); }
  for (const fixture of cases) {
    const entry = { id: fixture.id, fixtureSha256: fixtureHash(fixture), mode: fixture.mode, units: fixture.units,
      stdin: fixture.stdin, expectedStdout: fixture.stdout, status: 'running', commands: {}, runs: [] };
    report.cases.push(entry);
    try {
      const objects = fixture.units.map(id => { const value = compiled.get(id); assert.equal(value.status, 'passed', `Failed unit: ${id}`); return value.object.path; });
      const directory = path.join(output, 'cases', fixture.id); await fs.mkdir(directory, { recursive: true });
      const profileDirectory = path.join(directory, 'profile'); await fs.mkdir(profileDirectory); assert.deepEqual(await fs.readdir(profileDirectory), []);
      const program = path.join(directory, 'program.wasm');
      entry.commands.link = run(tools.linker, ['--fatal-warnings', '-m', 'wasm32', '-e', '_start', '-o', program,
        archives.crt, '-L' + library, ...objects,
        ...(fixture.language === 'cpp' ? [archives.libstdcxx, archives.libsupcxx] : []),
        ...(fixture.mode === 'coverage' ? [archives.libgcov, archives.getpid] : []), '-lm', '-lc', archives.builtins], directory);
      success(entry.commands.link); entry.program = await freeze(program);
      const module = new WebAssembly.Module(await fs.readFile(program));
      entry.imports = WebAssembly.Module.imports(module); entry.exports = WebAssembly.Module.exports(module);
      assert(entry.imports.every(value => value.module === 'wasi_snapshot_preview1' && value.kind === 'function'));
      assert(entry.exports.some(value => value.name === '_start' && value.kind === 'function'));
      assert(entry.exports.some(value => value.name === 'memory' && value.kind === 'memory'));
      for (let index = 1; index <= fixture.runs; index++) {
        const runDirectory = path.join(directory, 'run-' + index); await fs.mkdir(runDirectory);
        const execution = { index, profileMultiplier: index, stdin: fixture.stdin, expectedStdout: fixture.stdout,
          preexistingProfiles: [],
          commands: {}, profiles: [], analysis: [] };
        entry.runs.push(execution);
        const preexistingNames = (await fs.readdir(profileDirectory)).sort();
        if (preexistingNames.length) {
          const beforeDirectory = path.join(runDirectory, 'preexisting'); await fs.mkdir(beforeDirectory);
          for (const name of preexistingNames) {
            const snapshot = path.join(beforeDirectory, name); await fs.copyFile(path.join(profileDirectory, name), snapshot);
            execution.preexistingProfiles.push({ ...await freeze(snapshot), guestPath: '/profile/' + name });
          }
        }
        execution.commands.execute = run(tools.node, ['--no-warnings', runner, program, profileDirectory], directory, fixture.stdin);
        success(execution.commands.execute); assert.equal(execution.commands.execute.stdout, fixture.stdout); assert.equal(execution.commands.execute.stderr, '');
        const names = (await fs.readdir(profileDirectory)).sort();
        const expectedNames = fixture.mode === 'coverage' ? fixture.units.map(id => units.find(value => value.id === id).gcovStem + '.gcda').sort() : [];
        assert.deepEqual(names, expectedNames, 'Exact flat profile output names');
        if (index === 1) assert.deepEqual(execution.preexistingProfiles, []);
        else assert.deepEqual(execution.preexistingProfiles.map(compactIdentity), entry.runs[index - 2].profiles.map(compactIdentity));
        for (const name of names) {
          const snapshot = path.join(runDirectory, name); await fs.copyFile(path.join(profileDirectory, name), snapshot);
          execution.profiles.push(await freeze(snapshot));
        }
        for (const expected of fixture.mode === 'coverage' ? fixture.expected : []) {
          const unit = units.find(value => value.id === expected.unit), built = compiled.get(expected.unit);
          const analysisDirectory = path.join(runDirectory, 'analysis', unit.id); await fs.mkdir(analysisDirectory, { recursive: true });
          const notePath = path.join(analysisDirectory, unit.gcovStem + '.gcno'), profilePath = path.join(analysisDirectory, unit.gcovStem + '.gcda');
          await fs.copyFile(built.notes[0].path, notePath);
          await fs.copyFile(execution.profiles.find(value => path.basename(value.path) === unit.gcovStem + '.gcda').path, profilePath);
          const analysis = { unit: unit.id, source: built.source, note: await freeze(notePath), profile: await freeze(profilePath), commands: {} };
          execution.analysis.push(analysis);
          assert.deepEqual(compactIdentity(analysis.note), compactIdentity(built.notes[0]));
          analysis.commands.profileDump = run(tools.gcovDump, ['-l', profilePath], analysisDirectory); success(analysis.commands.profileDump);
          assert(analysis.commands.profileDump.stdout.includes("version `B70 '")); assert.equal(analysis.commands.profileDump.stderr, '');
          analysis.commands.gcov = run(tools.gcov, ['--json-format', '--branch-probabilities', '--branch-counts', notePath], analysisDirectory); success(analysis.commands.gcov);
          assert.equal(analysis.commands.gcov.stderr, '');
          const compressed = (await fs.readdir(analysisDirectory)).filter(name => name.endsWith('.gcov.json.gz')); assert.equal(compressed.length, 1);
          analysis.compressedJson = await freeze(path.join(analysisDirectory, compressed[0]));
          const decoded = gunzipSync(await fs.readFile(analysis.compressedJson.path)), jsonPath = path.join(analysisDirectory, 'gcov.json');
          await fs.writeFile(jsonPath, decoded); analysis.json = await freeze(jsonPath);
          const data = JSON.parse(decoded); assert.equal(data.data_file, notePath);
          analysis.counts = verifyGcovJson(data, unit, expected, index, built.source.path);
        }
      }
      entry.status = 'passed';
    } catch (error) { entry.status = 'failed'; entry.error = error.message; }
    await save('execute');
  }
  for (const fixture of diagnostics) {
    const directory = path.join(output, 'diagnostics', fixture.id); await fs.mkdir(directory, { recursive: true });
    const input = path.join(directory, 'source' + (fixture.language === 'cpp' ? '.cpp' : '.c')), assembly = path.join(directory, 'program.wat');
    await fs.writeFile(input, fixture.code);
    const entry = { id: fixture.id, fixtureSha256: fixtureHash(fixture), status: 'running', source: await freeze(input) }; report.diagnostics.push(entry);
    try {
      const flags = ['-O' + fixture.optimization, '-fdiagnostics-color=never', ...fixture.flags, input, '-o', assembly];
      entry.command = fixture.driver ? run(tools.xgcc, ['-B' + compiler + '/', '-specs=' + path.join(work, 'native-driver.specs'), '-S', ...flags], directory)
        : run(fixture.language === 'cpp' ? tools.gccCpp : tools.gcc, ['-quiet', ...flags], directory);
      assert.equal(entry.command.status, 1); assert.equal(entry.command.signal, null); assert(!entry.command.error);
      assert(entry.command.stderr.includes(fixture.diagnostic)); assert(!/internal compiler error/i.test(entry.command.stderr));
      await assert.rejects(fs.stat(assembly), { code: 'ENOENT' });
      assert(!(await fs.readdir(directory)).some(name => /\.(?:gcno|gcda)$/.test(name)), 'Rejected option left profile outputs');
      entry.status = 'passed';
    } catch (error) { entry.status = 'failed'; entry.error = error.message; }
  }
  report.counts = { units: report.units.length, cases: report.cases.length,
    coverage: report.cases.filter(value => value.mode === 'coverage').length,
    controls: report.cases.filter(value => value.mode === 'normal').length,
    nativeExecutions: report.cases.reduce((count, value) => count + value.runs.length, 0),
    profileExecutions: report.cases.filter(value => value.mode === 'coverage').reduce((count, value) => count + value.runs.length, 0),
    metadataControls: report.metadataControls.length, diagnostics: report.diagnostics.length };
  assert.deepEqual(report.counts, requiredCounts);
  const failed = [...report.units, ...report.cases, ...report.metadataControls, ...report.diagnostics].filter(value => value.status !== 'passed');
  assert.equal(failed.length, 0, failed.map(value => value.id + ': ' + value.error).join('\n'));
  assert.deepEqual(await checkSource('gcc', source), report.gccSource);
  assert.deepEqual(await checkSource('wabt', path.join(work, 'wabt-source')), report.assemblerSource);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.message; }
finally {
  report.inputs = [...inputMap.values()].sort((a, b) => a.path.localeCompare(b.path));
  report.inputsUnchanged = true;
  for (const before of report.inputs) if (JSON.stringify(await identify(before.path)) !== JSON.stringify(before)) report.inputsUnchanged = false;
  if (!report.inputsUnchanged) { report.status = 'failed'; report.error = [report.error, 'Frozen coverage inputs changed'].filter(Boolean).join('\n'); }
  await save('complete');
  console.log(JSON.stringify({ status: report.status, counts: report.counts, inputsUnchanged: report.inputsUnchanged,
    ...(report.error ? { error: report.error } : {}) }, null, 2));
  if (report.status !== 'passed') process.exitCode = 1;
}

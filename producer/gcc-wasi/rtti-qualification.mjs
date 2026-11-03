import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { units, cases, diagnostics, exceptionBoundaries, requiredCounts, wasiRunnerSource } from './rtti-fixtures.mjs';
import { inspectRttiObject } from './rtti-inspect.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = bytes => ({ bytes: bytes.length, sha256: digest(bytes) });
const content = receipt => ({ bytes: receipt?.bytes, sha256: receipt?.sha256 });
const contents = receipts => Object.fromEntries(Object.entries(receipts).map(([key, value]) => [key, content(value)]));
const same = (actual, expected, message) => assert.deepEqual(content(actual), content(expected), message);

export function verifyRttiQualificationOptions(patches, options) {
  const required = patches.some(patch => patch.path === 'patches/0019-rtti-one-only.patch');
  if (!required && !options.rttiQualification) return;
  for (const name of ['rttiQualification', 'nativeLinker', 'libstdcxx'])
    assert(options[name], 'C++ RTTI requires ' + name);
}

// Runtime capability and native program evidence must agree before a package
// advertises RTTI. The separate program gate reopens the qualification itself.
export function verifyRttiRuntimeProfile(build, qualifiedRuntime, qualifiedRtti, qualification) {
  assert.equal(typeof qualifiedRtti, 'boolean');
  for (const receipt of [build, qualifiedRuntime]) {
    assert.equal(receipt.rtti, qualifiedRtti, 'GNU RTTI runtime and program qualification differ');
    for (const feature of ['exceptions', 'threads', 'timezoneDatabase', 'debugger', 'stdModules'])
      assert.equal(receipt[feature], false, 'Unsupported GNU runtime feature: ' + feature);
  }
  if (!qualifiedRtti) return;
  const flags = build.compilerFlags;
  assert.deepEqual(Object.keys(flags).sort(), ['CXXFLAGS', 'EXTRA_CXX_FLAGS']);
  assert(Object.values(flags).every(value => typeof value === 'string'));
  assert(flags.CXXFLAGS.split(/\s+/).includes('-frtti'), 'GNU CXXFLAGS omitted RTTI');
  const effective = Object.values(flags).flatMap(value => value.split(/\s+/));
  assert(!effective.includes('-fno-rtti'), 'GNU configure flags disabled RTTI');
  assert(effective.includes('-fno-exceptions') && !effective.includes('-fexceptions'), 'GNU exception profile changed');
  assert.equal(qualification?.status, 'passed');
  assert.equal(qualification.rtti, true);
  assert.equal(qualification.exceptions, false);
  assert.deepEqual(qualification.profiles, { disabled: 2, default: 1, enabled: 2 });
  const profiles = [
    ['stl-static-multiple', 'disabled'], ['iostream', 'disabled'],
    ['rtti-gnu-default', 'default'], ['rtti-gnu-enabled', 'enabled'], ['rtti-streambuf-print', 'enabled']
  ];
  assert.deepEqual(qualification.cases.map(entry => [entry.id, entry.rtti]), profiles, 'Incomplete GNU RTTI/default/off qualification');
  for (const entry of qualification.cases) {
    assert.equal(entry.status, 'passed');
    assert.equal(entry.exitCode, 0);
    assert.deepEqual(entry.command.filter(flag => /^-f(?:no-)?rtti$/.test(flag)),
      entry.rtti === 'default' ? [] : [entry.rtti === 'enabled' ? '-frtti' : '-fno-rtti'],
      'GNU qualification used another RTTI profile');
    assert(entry.command.includes('-fno-exceptions'));
    assert(!entry.command.includes('-fexceptions'));
  }
}

function compileArguments(unit, entry, runtime) {
  const cpp = unit.language === 'cpp', gcc = unit.compiler === 'gcc';
  const common = ['-O' + unit.optimization, '-std=' + unit.standard, '-mno-simd128', '-fdiagnostics-color=never',
    '-Werror=attributes', '-D__GCC_WASI_SINGLE_THREAD__=1', ...unit.flags,
    ...(cpp ? ['-fno-exceptions', '-fuse-cxa-atexit', '-fno-threadsafe-statics',
      ...(unit.rtti === 'enabled' ? ['-frtti'] : unit.rtti === 'disabled' ? ['-fno-rtti'] : [])]
      : ['-Werror=implicit-function-declaration'])];
  const includes = cpp ? runtime.gnuIncludePaths.filter(root => gcc || root !== runtime.headerRoots.gcc)
    : [...(gcc ? [runtime.headerRoots.gcc] : []), path.join(runtime.sysroot, 'include/wasm32-wasi')];
  const output = path.join(path.dirname(entry.source.path), gcc ? 'source.wat' : 'source.o');
  return gcc ? ['-quiet', '-nostdinc', ...common, ...includes.flatMap(root => ['-isystem', root]), entry.source.path, '-o', output]
    : ['--target=wasm32-wasi', '--sysroot=' + runtime.sysroot, ...(cpp ? ['-nostdinc++'] : []), ...common,
      ...includes.flatMap(root => ['-isystem', root]), '-c', entry.source.path, '-o', output];
}

function command(result, tool, exitCode = 0) {
  assert.equal(result.command, tool, 'Unexpected RTTI tool');
  assert.equal(result.signal, null, 'RTTI command was interrupted');
  assert(!result.error, 'RTTI command could not start');
  assert.equal(result.status, exitCode, result.stderr || 'Unexpected RTTI command exit');
}

function compileProfile(unit, entry, report, exitCode = 0) {
  assert.equal(entry.status, 'passed');
  assert.equal(entry.fixtureSha256, digest(JSON.stringify(unit)), 'Changed RTTI unit contract');
  same(entry.source, identity(Buffer.from(unit.code)), 'Changed RTTI source');
  assert.deepEqual(Object.keys(entry.headers).sort(), Object.keys(unit.headers).sort(), 'Changed RTTI fixture headers');
  for (const [name, source] of Object.entries(unit.headers)) {
    const receipt = entry.headers[name];
    assert.equal(receipt.path, path.join(path.dirname(entry.source.path), name));
    same(receipt, identity(Buffer.from(source)), 'Changed RTTI fixture header');
  }
  const tool = unit.compiler + (unit.language === 'cpp' ? 'Cpp' : '');
  const compile = entry.commands.compile;
  command(compile, report.tools[tool].path, exitCode);
  assert.equal(compile.stdin, null);
  assert.deepEqual(compile.argv, compileArguments(unit, entry, report.runtime), 'Changed RTTI compile profile or include order');
  if (exitCode) {
    assert.deepEqual(entry.requiredDiagnostics, unit.requiredDiagnostics);
    for (const diagnostic of unit.requiredDiagnostics)
      assert(compile.stderr.includes(diagnostic), 'Missing RTTI frontend diagnostic: ' + diagnostic);
    assert.equal(entry.object, undefined, 'Rejected RTTI source has an object receipt');
    assert.deepEqual(Object.keys(entry.commands), ['compile']);
    return;
  }
  const output = compile.argv.at(-1);
  if (unit.compiler === 'gcc') {
    assert.equal(entry.assembly.path, output);
    command(entry.commands.assemble, report.tools.assembler.path);
    assert.deepEqual(entry.commands.assemble.argv, ['-r', '--enable-annotations', entry.assembly.path, '-o', entry.object.path]);
    assert.equal(entry.commands.assemble.stdin, null);
    assert.equal(entry.object.path, path.join(path.dirname(entry.source.path), 'source.o'));
  } else {
    assert.equal(entry.object.path, output);
    assert.equal(entry.assembly, undefined);
    assert.equal(entry.commands.assemble, undefined);
  }
  command(entry.commands.validate, report.tools.validator.path);
  assert.deepEqual(entry.commands.validate.argv, [entry.object.path]);
  assert.equal(entry.commands.validate.stdin, null);
  assert.deepEqual(Object.keys(entry.commands).sort(), unit.compiler === 'gcc'
    ? ['assemble', 'compile', 'validate'] : ['compile', 'validate']);
}

function linkProfile(fixture, entry, report, byId) {
  const link = entry.commands.link;
  command(link, report.tools.linker.path, fixture.expectedLinkRejection ? 1 : 0);
  assert.equal(link.stdin, null);
  assert.deepEqual(link.argv.slice(0, 6), ['--fatal-warnings', '-m', 'wasm32', '-e', '_start', '-o']);
  assert(path.isAbsolute(link.argv[6]), 'Missing absolute RTTI program output');
  assert.deepEqual(link.argv.slice(7), [report.runtime.archives.crt.path,
    '-L' + path.dirname(report.runtime.archives.libc.path), ...fixture.units.map(id => byId.get(id).object.path),
    ...(fixture.runtime === 'gnu' ? [report.runtime.archives.libstdcxx.path, report.runtime.archives.libsupcxx.path] : []),
    '-lm', '-lc', report.runtime.archives.builtins.path], 'Changed RTTI link order or runtime');
  if (entry.program) assert.equal(entry.program.path, link.argv[6]);
}

export function verifyRttiQualification(report, expected) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, 'gcc-wasi-native-rtti-qualification');
  assert.equal(report.status, 'passed');
  assert.equal(report.inputsUnchanged, true);
  assert.deepEqual(report.counts, requiredCounts);
  same(report.runner, identity(Buffer.from(wasiRunnerSource)), 'Changed RTTI WASI runner');
  for (const key of ['sourceLock', 'nativeBuild', 'fixtures', 'assemblerProvenance'])
    same(report[key], expected[key], 'Stale RTTI ' + key);
  for (const key of ['gccSource', 'assemblerSource'])
    assert.deepEqual(report[key], expected[key], 'Stale RTTI ' + key);
  for (const key of ['tools', 'recipes'])
    assert.deepEqual(contents(report[key]), contents(expected[key]), 'Stale RTTI ' + key);
  assert.deepEqual(contents(report.runtime.archives), contents(expected.runtime.archives), 'RTTI runtime differs from packaged archives');
  for (const key of ['gnuBuild', 'gnuQualification', 'gnuReceipt'])
    same(report.runtime[key], expected.runtime[key], 'Stale RTTI GNU ' + key);
  for (const [key, fixtures] of Object.entries({ units, cases, diagnostics, exceptionBoundaries }))
    assert.deepEqual(report[key].map(entry => entry.id), fixtures.map(fixture => fixture.id), 'Incomplete RTTI ' + key + ' matrix');
  for (const [index, unit] of units.entries()) compileProfile(unit, report.units[index], report);
  const byId = new Map(report.units.map(unit => [unit.id, unit]));
  for (const [index, fixture] of cases.entries()) {
    const entry = report.cases[index];
    assert.equal(entry.status, 'passed');
    assert.equal(entry.fixtureSha256, digest(JSON.stringify(fixture)), 'Changed RTTI case contract');
    for (const key of ['units', 'runtime', 'stdin', 'expectedLinkRejection', 'requiredLinkDiagnostics'])
      assert.deepEqual(entry[key], fixture[key], 'Changed RTTI case ' + key);
    assert.equal(entry.expectedStdout, fixture.stdout);
    linkProfile(fixture, entry, report, byId);
    if (fixture.expectedLinkRejection) {
      assert.equal(entry.outcome, 'link-rejection');
      for (const diagnostic of fixture.requiredLinkDiagnostics)
        assert(entry.commands.link.stderr.includes(diagnostic), 'Missing RTTI strict-link diagnostic: ' + diagnostic);
      assert.equal(entry.program, undefined);
      assert.deepEqual(Object.keys(entry.commands), ['link']);
    } else {
      assert.equal(entry.outcome, 'runtime-pass');
      assert(entry.program);
      const run = entry.commands.run;
      command(run, report.tools.node.path);
      assert.deepEqual(run.argv, ['--no-warnings', report.runner.path, entry.program.path]);
      assert.equal(run.stdin, fixture.stdin);
      assert.equal(run.stdout, fixture.stdout);
      assert.equal(run.stderr, '');
      assert.equal(entry.stdout, fixture.stdout);
      assert.equal(entry.stderr, '');
      assert.deepEqual(Object.keys(entry.commands).sort(), ['link', 'run']);
    }
  }
  for (const [index, fixture] of exceptionBoundaries.entries()) {
    const entry = report.exceptionBoundaries[index];
    assert.equal(entry.status, 'passed');
    assert.equal(entry.fixtureSha256, digest(JSON.stringify(fixture)), 'Changed exception boundary contract');
    for (const key of ['units', 'requiredRuntimeSymbol', 'execution']) assert.deepEqual(entry[key], fixture[key]);
    linkProfile(fixture, entry, report, byId);
    assert(entry.program);
    assert.deepEqual(Object.keys(entry.commands), ['link'], 'Exception-dependent failure must not be counted as an execution');
  }
  for (const [index, fixture] of diagnostics.entries()) compileProfile(fixture, report.diagnostics[index], report, 1);
}

export async function reopenRttiQualification(report, expected) {
  verifyRttiQualification(report, expected);
  const reopened = new Map();
  async function read(receipt) {
    assert(path.isAbsolute(receipt.path), 'RTTI artifact requires an absolute path');
    const bytes = await fs.readFile(receipt.path);
    same(identity(bytes), receipt, 'Changed RTTI artifact: ' + receipt.path);
    reopened.set(receipt.path, content(receipt));
    return bytes;
  }
  assert(Array.isArray(report.inputs) && report.inputs.length, 'Missing frozen RTTI inputs');
  assert.equal(new Set(report.inputs.map(receipt => receipt.path)).size, report.inputs.length, 'Duplicate frozen RTTI input');
  for (const receipt of report.inputs) await read(receipt);
  for (const receipt of [report.sourceLock, report.nativeBuild, report.fixtures, report.assemblerProvenance,
    ...Object.values(report.tools), ...Object.values(report.recipes), ...Object.values(report.runtime.archives), report.runner]) await read(receipt);
  const build = JSON.parse(await read(report.runtime.gnuBuild));
  const qualifiedRuntime = JSON.parse(await read(report.runtime.gnuReceipt));
  const qualification = JSON.parse(await read(report.runtime.gnuQualification));
  verifyRttiRuntimeProfile(build, qualifiedRuntime, true, qualification);
  same(qualification.testRecipe, expected.recipes['test-libstdcxx.mjs'], 'GNU RTTI qualification used another test recipe');
  assert.deepEqual(build.gccSource, expected.gccSource, 'GNU RTTI runtime used another compiler source');
  assert.deepEqual(qualification.buildReceipt, content(report.runtime.gnuBuild));
  same(qualifiedRuntime.buildReceipt, report.runtime.gnuBuild, 'GNU RTTI build receipt changed');
  same(qualifiedRuntime.qualification, report.runtime.gnuQualification, 'GNU RTTI qualification changed');
  for (const [name, tool] of [['cc1', 'gcc'], ['cc1plus', 'gccCpp'], ['xgcc', 'xgcc']])
    assert.equal(build.nativeCompiler[name], expected.tools[tool].sha256, 'GNU RTTI runtime used another native compiler');
  for (const [name, key] of [['libstdc++.a', 'libstdcxx'], ['libsupc++.a', 'libsupcxx']])
    same(build.libraries[name], expected.runtime.archives[key], 'GNU RTTI archive differs from the build');
  assert.equal(report.runtime.headerRoots.target, path.join(report.runtime.sysroot, 'include'));
  assert.equal(report.runtime.headerRoots.gnu, path.join(report.runtime.gnuSysroot, 'include'));
  assert.equal(report.runtime.headerRoots.gcc, path.join(path.dirname(report.tools.gcc.path), 'include'));
  const actualIncludes = await Promise.all(report.runtime.gnuIncludePaths.map(root => fs.realpath(root)));
  const expectedIncludes = await Promise.all(expected.runtime.gnuIncludePaths.map(root => fs.realpath(root)));
  assert.deepEqual(actualIncludes, expectedIncludes, 'Changed RTTI GNU include search order');
  assert.deepEqual(Object.keys(report.runtime.headers).sort(), Object.keys(expected.runtime.headers).sort());
  for (const [group, receipts] of Object.entries(report.runtime.headers)) {
    const actual = {}, wanted = {};
    for (const receipt of receipts) {
      await read(receipt);
      const relative = path.relative(report.runtime.headerRoots[group], receipt.path);
      assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'RTTI header outside its search root');
      const name = await fs.realpath(receipt.path);
      assert(!Object.hasOwn(actual, name), 'Duplicate RTTI header');
      actual[name] = content(receipt);
    }
    for (const receipt of expected.runtime.headers[group]) wanted[await fs.realpath(receipt.path)] = content(receipt);
    assert.deepEqual(actual, wanted, 'RTTI ' + group + ' headers differ from package inputs');
  }
  for (const [index, entry] of report.units.entries()) {
    await read(entry.source);
    for (const header of Object.values(entry.headers)) await read(header);
    if (entry.assembly) await read(entry.assembly);
    assert.deepEqual(inspectRttiObject(await read(entry.object), units[index]), entry.inspection, 'Changed RTTI linking metadata');
  }
  for (const entry of [...report.cases, ...report.exceptionBoundaries]) {
    if (entry.program) {
      const bytes = await read(entry.program);
      assert(WebAssembly.validate(bytes), 'Invalid RTTI program');
      const module = new WebAssembly.Module(bytes), imports = WebAssembly.Module.imports(module), exports = WebAssembly.Module.exports(module);
      assert.deepEqual(imports, entry.imports); assert.deepEqual(exports, entry.exports);
      assert(imports.every(value => value.module === 'wasi_snapshot_preview1' && value.kind === 'function'));
      assert(exports.some(value => value.name === '_start' && value.kind === 'function'));
      assert(exports.some(value => value.name === 'memory' && value.kind === 'memory'));
    } else await assert.rejects(fs.stat(entry.commands.link.argv[6]), { code: 'ENOENT' }, 'Rejected RTTI link left an executable');
  }
  for (const entry of report.diagnostics) {
    await read(entry.source);
    for (const header of Object.values(entry.headers)) await read(header);
    if (entry.assembly) await read(entry.assembly);
    await assert.rejects(fs.stat(path.join(path.dirname(entry.source.path), 'source.o')), { code: 'ENOENT' }, 'Rejected RTTI source left an object');
  }
  return { ...requiredCounts, reopenedFiles: reopened.size };
}

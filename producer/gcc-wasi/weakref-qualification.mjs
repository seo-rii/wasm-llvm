import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { units, cases, requiredCounts } from './weakref-fixtures.mjs';
import { inspectWeakrefObject } from './weakref-inspect.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = bytes => ({ bytes: bytes.length, sha256: digest(bytes) });
const content = receipt => ({ bytes: receipt?.bytes, sha256: receipt?.sha256 });
const contents = receipts => Object.fromEntries(Object.entries(receipts).map(([key, value]) => [key, content(value)]));
const same = (actual, expected, message) => assert.deepEqual(content(actual), content(expected), message);
export const weakrefWasiRunner = "import{WASI}from'node:wasi';import{readFile}from'node:fs/promises';const w=new WASI({version:'preview1',args:['program'],env:{},returnOnExit:true});process.exitCode=w.start(await WebAssembly.instantiate(await WebAssembly.compile(await readFile(process.argv[2])),{wasi_snapshot_preview1:w.wasiImport}));\n";

function compileArguments(unit, entry, runtime) {
  const cpp = unit.language === 'cpp', gcc = unit.compiler === 'gcc';
  const standard = cpp ? 'gnu++17' : 'gnu11';
  const cHeaders = ['-isystem', path.join(runtime.sysroot, 'include/wasm32-wasi')];
  const gccHeaders = ['-nostdinc', '-isystem', runtime.headerRoots.gcc, ...cHeaders];
  const target = ['--target=wasm32-wasi', '--sysroot=' + runtime.sysroot];
  const output = [entry.source.path, '-o', entry.assembly?.path || entry.object.path];
  if (unit.suite === 'core') {
    const common = ['-O' + unit.optimization, '-std=' + standard, '-fdiagnostics-color=never'];
    return gcc ? ['-quiet', ...common, '-Werror=attributes', '-D__GCC_WASI_SINGLE_THREAD__=1', ...gccHeaders,
      ...(cpp ? ['-fno-exceptions', '-fno-rtti'] : ['-Werror=implicit-function-declaration']), ...output]
      : [...target, ...common, '-Werror=ignored-attributes', ...cHeaders,
        ...(cpp ? ['-fno-exceptions', '-fno-rtti', '-nostdinc++'] : []), '-c', ...output];
  }
  if (unit.suite === 'gnu') {
    const common = ['-O' + unit.optimization, '-std=gnu++17', '-fno-exceptions', '-fno-rtti', '-fuse-cxa-atexit',
      '-fno-threadsafe-statics', '-fdiagnostics-color=never', '-Werror=attributes'];
    return gcc ? ['-quiet', ...common, '-nostdinc', '-D__GCC_WASI_SINGLE_THREAD__=1',
      ...runtime.gnuIncludePaths.flatMap(root => ['-isystem', root]), ...output]
      : [...target, ...common, ...cHeaders, '-c', ...output];
  }
  const common = ['-O' + unit.optimization, '-std=' + standard, '-mno-simd128', '-fdiagnostics-color=never',
    '-Werror=attributes', '-D__GCC_WASI_SINGLE_THREAD__=1',
    ...(cpp ? ['-fno-exceptions', '-fno-rtti', '-fuse-cxa-atexit', '-fno-threadsafe-statics'] : [])];
  return gcc ? ['-quiet', ...common, ...gccHeaders, ...output] : [...target, ...common, ...cHeaders, '-c', ...output];
}

export function verifyWeakrefQualificationOptions(patches, options) {
  if (!patches.some(patch => patch.path === 'patches/0018-weak-references.patch')) return;
  for (const name of ['weakrefQualification', 'nativeLinker', 'libstdcxx'])
    assert(options[name], 'Weak references require ' + name);
}

function command(result, tool, success = true) {
  assert.equal(result.command, tool, 'Unexpected weakref tool');
  assert.equal(result.signal, null, 'Weakref command was interrupted');
  assert(!result.error, 'Weakref command could not start');
  assert(Number.isSafeInteger(result.status));
  if (success) assert.equal(result.status, 0, result.stderr);
  else assert.notEqual(result.status, 0, 'Missing expected link rejection');
}

export function verifyWeakrefQualification(report, expected) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, 'gcc-wasi-native-weakref-qualification');
  assert.equal(report.status, 'passed');
  assert.equal(report.inputsUnchanged, true);
  assert.deepEqual(report.counts, requiredCounts);
  same(report.runner, identity(Buffer.from(weakrefWasiRunner)), 'Changed WASI runner contract');
  for (const key of ['sourceLock', 'nativeBuild', 'fixtures', 'assemblerProvenance'])
    same(report[key], expected[key], 'Stale weakref ' + key);
  assert.deepEqual(report.gccSource, expected.gccSource, 'Stale weakref GCC source');
  assert.deepEqual(report.assemblerSource, expected.assemblerSource, 'Stale weakref assembler source');
  for (const key of ['tools', 'recipes'])
    assert.deepEqual(contents(report[key]), contents(expected[key]), 'Stale weakref ' + key);
  assert.deepEqual(contents(report.runtime.archives), contents(expected.runtime.archives), 'Weakref runtime differs from packaged archives');
  for (const key of ['gnuBuild', 'gnuQualification', 'gnuReceipt'])
    same(report.runtime[key], expected.runtime[key], 'Stale weakref GNU ' + key);
  assert.deepEqual(report.units.map(unit => unit.id), units.map(unit => unit.id), 'Incomplete weakref object matrix');
  assert.deepEqual(report.cases.map(fixture => fixture.id), cases.map(fixture => fixture.id), 'Incomplete weakref execution matrix');
  const byId = new Map(report.units.map(unit => [unit.id, unit]));
  for (const [index, unit] of units.entries()) {
    const entry = report.units[index], compile = entry.commands.compile;
    assert.equal(entry.status, 'passed');
    assert.equal(entry.fixtureSha256, digest(JSON.stringify(unit)), 'Changed weakref unit contract');
    same(entry.source, identity(Buffer.from(unit.code)), 'Changed weakref source');
    const family = unit.compiler === 'gcc' ? (unit.language === 'cpp' ? 'gccCpp' : 'gcc')
      : (unit.language === 'cpp' ? 'clangCpp' : 'clang');
    command(compile, report.tools[family].path);
    assert.deepEqual(compile.argv, compileArguments(unit, entry, report.runtime), 'Changed weakref compile profile or include search');
    assert.deepEqual(compile.argv.filter(arg => /^-O/.test(arg)), ['-O' + unit.optimization]);
    assert.deepEqual(compile.argv.filter(arg => arg.startsWith('-std=')), [unit.language === 'cpp' ? '-std=gnu++17' : '-std=gnu11']);
    assert.deepEqual(compile.argv.filter(arg => /^-m(?:no-)?simd128$/.test(arg)),
      ['boundaries', 'named-sites'].includes(unit.suite) ? ['-mno-simd128'] : []);
    assert(!compile.argv.includes('-fsyntax-only'));
    assert(compile.argv.includes(entry.source.path), 'Compiler did not read the recorded source');
    const outputIndex = compile.argv.indexOf('-o');
    assert(outputIndex >= 0 && outputIndex === compile.argv.lastIndexOf('-o'));
    assert.equal(compile.argv[outputIndex + 1], entry.assembly?.path || entry.object.path);
    if (unit.language === 'cpp') {
      assert(compile.argv.includes('-fno-exceptions'));
      assert(compile.argv.includes('-fno-rtti'));
    }
    if (unit.compiler === 'gcc') {
      assert(entry.assembly);
      command(entry.commands.assemble, report.tools.assembler.path);
      assert.deepEqual(entry.commands.assemble.argv, ['-r', '--enable-annotations', entry.assembly.path, '-o', entry.object.path]);
    } else {
      assert.equal(entry.assembly, undefined);
      assert.equal(entry.commands.assemble, undefined);
      assert(compile.argv.includes('-c'));
    }
    command(entry.commands.validate, report.tools.validator.path);
    assert(entry.commands.validate.argv.includes(entry.object.path));
  }
  for (const [index, fixture] of cases.entries()) {
    const entry = report.cases[index], link = entry.commands.link;
    assert.equal(entry.status, 'passed');
    assert.equal(entry.fixtureSha256, digest(JSON.stringify(fixture)), 'Changed weakref case contract');
    for (const key of ['units', 'runtime', 'stdin', 'expectedLinkRejection', 'requiredLinkDiagnostics'])
      assert.deepEqual(entry[key], fixture[key], 'Changed weakref ' + key);
    assert.equal(entry.expectedStdout, fixture.stdout);
    const objects = fixture.units.map(id => byId.get(id).object.path);
    const library = path.dirname(report.runtime.archives.libc.path);
    assert.equal(link.argv[0], '--fatal-warnings');
    assert.deepEqual(link.argv.slice(1, 5), ['-m', 'wasm32', '-e', '_start']);
    assert.equal(link.argv[5], '-o');
    assert.deepEqual(link.argv.slice(7), [report.runtime.archives.crt.path, '-L' + library, ...objects,
      ...(fixture.runtime === 'gnu' ? [report.runtime.archives.libstdcxx.path, report.runtime.archives.libsupcxx.path] : []),
      '-lm', '-lc', report.runtime.archives.builtins.path]);
    command(link, report.tools.linker.path, !fixture.expectedLinkRejection);
    if (fixture.expectedLinkRejection) {
      assert.equal(entry.outcome, 'link-rejection');
      for (const diagnostic of fixture.requiredLinkDiagnostics)
        assert(link.stderr.includes(diagnostic), 'Missing weakref link diagnostic: ' + diagnostic);
      assert.equal(entry.program, undefined);
      assert.equal(entry.commands.run, undefined);
    } else {
      assert.equal(entry.outcome, 'runtime-pass');
      assert.equal(link.argv[6], entry.program.path);
      const run = entry.commands.run;
      command(run, report.tools.node.path);
      assert.equal(run.argv[0], '--no-warnings');
      assert.equal(run.argv.length, 3);
      assert.equal(run.argv[1], report.runner.path);
      assert.equal(run.argv[2], entry.program.path);
      assert.equal(run.stdin, fixture.stdin);
      assert.equal(run.stdout, fixture.stdout);
      assert.equal(run.stderr, '');
      assert.equal(entry.stdout, fixture.stdout);
    }
  }
}

export async function reopenWeakrefQualification(report, expected) {
  verifyWeakrefQualification(report, expected);
  const reopened = new Map();
  async function read(receipt) {
    assert(path.isAbsolute(receipt.path), 'Weakref artifact requires an absolute path');
    const bytes = await fs.readFile(receipt.path);
    same(identity(bytes), receipt, 'Changed weakref artifact: ' + receipt.path);
    reopened.set(receipt.path, content(receipt));
    return bytes;
  }
  assert(Array.isArray(report.inputs) && report.inputs.length, 'Missing frozen weakref inputs');
  assert.equal(new Set(report.inputs.map(receipt => receipt.path)).size, report.inputs.length);
  for (const receipt of report.inputs) await read(receipt);
  for (const receipt of [report.sourceLock, report.nativeBuild, report.fixtures, report.assemblerProvenance,
    ...Object.values(report.tools), ...Object.values(report.recipes), ...Object.values(report.runtime.archives),
    report.runtime.gnuBuild, report.runtime.gnuQualification, report.runtime.gnuReceipt, report.runner]) await read(receipt);
  assert.equal(report.runtime.headerRoots.target, path.join(report.runtime.sysroot, 'include'));
  assert.equal(report.runtime.headerRoots.gnu, path.join(report.runtime.gnuSysroot, 'include'));
  assert.equal(report.runtime.headerRoots.gcc, path.join(path.dirname(report.tools.gcc.path), 'include'));
  const actualIncludes = await Promise.all(report.runtime.gnuIncludePaths.map(root => fs.realpath(root)));
  const expectedIncludes = await Promise.all(expected.runtime.gnuIncludePaths.map(root => fs.realpath(root)));
  assert.deepEqual(actualIncludes, expectedIncludes, 'Changed GNU include search order');
  for (const [group, receipts] of Object.entries(report.runtime.headers)) {
    assert.equal(await fs.realpath(report.runtime.headerRoots[group]), await fs.realpath(expected.runtime.headerRoots[group]));
    const actual = {};
    for (const receipt of receipts) {
      await read(receipt);
      const relative = path.relative(report.runtime.headerRoots[group], receipt.path);
      assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Header outside the recorded search root');
      const name = await fs.realpath(receipt.path);
      assert(!Object.hasOwn(actual, name), 'Duplicate weakref header');
      actual[name] = content(receipt);
    }
    const wanted = {};
    for (const receipt of expected.runtime.headers[group]) wanted[await fs.realpath(receipt.path)] = content(receipt);
    assert.deepEqual(actual, wanted, 'Weakref ' + group + ' headers differ from package inputs');
  }
  assert.deepEqual(Object.keys(report.runtime.headers).sort(), Object.keys(expected.runtime.headers).sort());
  for (const [index, entry] of report.units.entries()) {
    await read(entry.source);
    if (entry.assembly) await read(entry.assembly);
    assert.deepEqual(inspectWeakrefObject(await read(entry.object), units[index]), entry.inspection);
  }
  for (const entry of report.cases) {
    if (entry.program) {
      const bytes = await read(entry.program);
      assert(WebAssembly.validate(bytes), 'Invalid weakref program');
      const module = new WebAssembly.Module(bytes);
      const imports = WebAssembly.Module.imports(module), exports = WebAssembly.Module.exports(module);
      assert.deepEqual(imports, entry.imports); assert.deepEqual(exports, entry.exports);
      assert(imports.every(value => value.module === 'wasi_snapshot_preview1' && value.kind === 'function'));
      assert(exports.some(value => value.name === '_start' && value.kind === 'function'));
      assert(exports.some(value => value.name === 'memory' && value.kind === 'memory'));
    } else {
      await assert.rejects(fs.stat(entry.commands.link.argv[6]), error => error.code === 'ENOENT', 'Rejected link left an executable');
    }
  }
  return { ...requiredCounts, reopenedFiles: reopened.size };
}

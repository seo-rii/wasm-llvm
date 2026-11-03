import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { units, cases, metadataControls, diagnostics, requiredCounts, wasiRunnerSource } from './coverage-fixtures.mjs';
import { inspectCoverageObject, verifyGcovJson } from './coverage-inspect.mjs';

const identity = bytes => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
const content = receipt => ({ bytes: receipt?.bytes, sha256: receipt?.sha256 });
const contents = receipts => Object.fromEntries(Object.entries(receipts).map(([name, receipt]) => [name, content(receipt)]));
const same = (actual, expected, label) => assert.deepEqual(content(actual), content(expected), label);

export function verifyCoverageQualificationOptions(patches, options) {
  if (!patches.some(patch => patch.path === 'patches/0020-coverage-profile.patch') && !options.coverageQualification) return;
  for (const name of ['coverageQualification', 'libgcov', 'nativeGcov', 'nativeLinker', 'libstdcxx'])
    assert(options[name], 'GCC coverage requires ' + name);
}

const coverageProfile = { format: 'gcc-gcov', update: 'single', normalExit: true,
  manualGcovApi: false, pgo: false, threads: false, processPidSemantics: false, directoryCreation: false };

function successful(command, tool) {
  assert.equal(command.command, tool, 'Unexpected official libgcov tool');
  assert.equal(command.status, 0, command.stderr || 'Official libgcov command failed');
  assert.equal(command.stdin, null);
  assert(command.signal === undefined || command.signal === null, 'Official libgcov command was interrupted');
  assert(!command.error, 'Official libgcov command did not execute');
}

export function verifyLibgcovBuild(report, expected) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, 'gcc-wasi-libgcov-build');
  assert.equal(report.status, 'built-unverified');
  assert.equal(report.target, 'wasm32-wasi');
  assert.equal(report.inputsUnchanged, true);
  assert.deepEqual(report.profile, coverageProfile);
  for (const name of ['sourceLock', 'runtimeLock', 'nativeBuild', 'runtimeImport', 'getpid'])
    same(report[name], expected[name], 'Stale official libgcov ' + name);
  assert.deepEqual(report.gccSource, expected.gccSource, 'Official libgcov used another GCC source');
  for (const name of ['nativeCompiler', 'recipes', 'tools', 'libc'])
    assert.deepEqual(contents(report[name]), contents(expected[name]), 'Stale official libgcov ' + name);
  assert.deepEqual(Object.keys(report.configuration).sort(), ['Makefile', 'auto-target.h', 'libgcc_tm.h']);
  assert.deepEqual(report.objects.map(entry => entry.selection), ['-DL_gcov', '-DL_gcov_merge_add'], 'Incomplete official libgcov runtime');
  for (const [index, entry] of report.objects.entries()) {
    const filename = index === 0 ? 'libgcov-driver.c' : 'libgcov-merge.c';
    same(entry.source, expected.sources[filename], 'Official libgcov source changed');
    assert.equal(path.basename(entry.source.path), filename);
    assert(Array.isArray(entry.headers) && entry.headers.length, 'Missing official libgcov header inputs');
    assert.equal(new Set(entry.headers.map(receipt => receipt.path)).size, entry.headers.length, 'Duplicate official libgcov header');
    successful(entry.commands.compile, report.nativeCompiler.cc1.path);
    const argv = entry.commands.compile.argv;
    const sourceRoot = path.dirname(path.dirname(expected.sources['libgcov-driver.c'].path));
    const compilerRoot = path.dirname(expected.nativeCompiler.cc1.path);
    const configurationRoot = path.dirname(report.configuration.Makefile.path);
    const headersRoot = path.dirname(expected.libc['libc.a'].path);
    const sysroot = path.resolve(headersRoot, '../..');
    assert.deepEqual(argv, ['-quiet', '-O0', '-g0', '-std=gnu11', '-fdiagnostics-color=never', '-nostdinc',
      '-D__GCC_WASI_SINGLE_THREAD__=1', '-D_WASI_EMULATED_GETPID=1', '-DIN_LIBGCC2', '-DIN_GCC',
      '-DCROSS_DIRECTORY_STRUCTURE', '-fbuilding-libgcc', '-fno-stack-protector',
      ...[configurationRoot, compilerRoot, path.join(sourceRoot, 'libgcc'), path.join(sourceRoot, 'gcc'),
        path.join(sourceRoot, 'include')].map(root => '-I' + root),
      '-isystem', path.join(compilerRoot, 'include'), '-isystem', path.join(sysroot, 'include/wasm32-wasi'),
      entry.selection, expected.sources[filename].path, '-o', entry.assembly.path], 'Changed official libgcov compile profile or include order');
    assert.deepEqual(argv.filter(flag => /^-O/.test(flag)), ['-O0']);
    assert(argv.includes('-std=gnu11') && argv.includes('-fbuilding-libgcc'));
    assert(argv.includes('-DIN_LIBGCC2') && argv.includes('-DIN_GCC') && argv.includes('-DCROSS_DIRECTORY_STRUCTURE'));
    assert(argv.includes('-D__GCC_WASI_SINGLE_THREAD__=1') && argv.includes('-D_WASI_EMULATED_GETPID=1'));
    assert(!argv.some(flag => /^-D(?:inhibit_libc|TARGET_POSIX_IO)(?:=|$)/.test(flag)), 'Dummy or POSIX libgcov profile is unsupported');
    assert.deepEqual(argv.filter(flag => /^-DL_gcov/.test(flag)), [entry.selection]);
    assert.deepEqual(argv.slice(-3), [expected.sources[filename].path, '-o', entry.assembly.path]);
    successful(entry.commands.assemble, report.tools.assembler.path);
    assert.deepEqual(entry.commands.assemble.argv, ['-r', '--enable-annotations', entry.assembly.path, '-o', entry.object.path]);
    successful(entry.commands.validate, report.tools.validator.path);
    assert.deepEqual(entry.commands.validate.argv, [entry.object.path]);
    successful(entry.commands.symbols, report.tools.nm.path);
    assert.deepEqual(entry.commands.symbols.argv, ['--undefined-only', entry.object.path]);
  }
  assert.deepEqual(Object.keys(report.libraries).sort(), ['libgcov.a', 'libwasi-emulated-getpid.a']);
  for (const [name, receipt] of Object.entries(report.libraries))
    same(receipt, expected.libraries[name], 'Packaged coverage runtime archive changed');
  same(report.libraries['libwasi-emulated-getpid.a'], expected.getpid, 'Coverage getpid archive differs from the pinned SDK');
  const expectedFiles = Object.entries(expected.libraries).map(([name, receipt]) => ({ path: 'lib/wasm32-wasi/' + name, ...content(receipt) }));
  assert.deepEqual(report.files, expectedFiles, 'Coverage runtime install inventory changed');
  const archived = report.commands.filter(command => command.command === report.tools.ar.path);
  assert.equal(archived.length, 1, 'Missing official coverage archive command');
  successful(archived[0], report.tools.ar.path);
  assert.deepEqual(archived[0].argv, ['rcs', report.libraries['libgcov.a'].path, ...report.objects.map(entry => entry.object.path)]);
}

export async function reopenLibgcovBuild(report, expected) {
  verifyLibgcovBuild(report, expected);
  const reopened = new Map();
  async function read(receipt) {
    assert(path.isAbsolute(receipt.path), 'Official libgcov artifact needs an absolute path');
    const bytes = await fs.readFile(receipt.path);
    same(identity(bytes), receipt, 'Changed official libgcov artifact: ' + receipt.path);
    reopened.set(receipt.path, content(receipt));
    return bytes;
  }
  assert(Array.isArray(report.inputs) && report.inputs.length, 'Missing frozen official libgcov inputs');
  assert.equal(new Set(report.inputs.map(receipt => receipt.path)).size, report.inputs.length);
  for (const receipt of report.inputs) await read(receipt);
  for (const receipt of [report.sourceLock, report.runtimeLock, report.nativeBuild, report.runtimeImport, report.getpid,
    ...Object.values(report.recipes), ...Object.values(report.nativeCompiler), ...Object.values(report.tools),
    ...Object.values(report.libc), ...Object.values(report.configuration), ...report.driver]) await read(receipt);
  for (const entry of report.objects) {
    await read(entry.source);
    for (const header of entry.headers) await read(header);
    await read(entry.assembly);
    const bytes = await read(entry.object);
    assert(bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])), 'Official libgcov object is not Wasm');
    assert(WebAssembly.validate(bytes), 'Official libgcov object is invalid');
    const module = new WebAssembly.Module(bytes);
    assert.equal(WebAssembly.Module.customSections(module, 'linking').length, 1, 'Official libgcov object lacks linking metadata');
  }
  for (const receipt of Object.values(report.libraries))
    assert.equal((await read(receipt)).subarray(0, 8).toString(), '!<arch>\n', 'Coverage runtime is not a static GNU archive');
  const archive = report.libraries['libgcov.a'].path;
  const listing = spawnSync(report.tools.ar.path, ['t', archive], { encoding: 'utf8', timeout: 30000 });
  assert.ifError(listing.error); assert.equal(listing.signal, null); assert.equal(listing.status, 0, listing.stderr);
  assert.deepEqual(listing.stdout.trim().split('\n'), report.objects.map(entry => path.basename(entry.object.path)), 'Coverage runtime archive members differ');
  for (const entry of report.objects) {
    const extracted = spawnSync(report.tools.ar.path, ['p', archive, path.basename(entry.object.path)], { timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
    assert.ifError(extracted.error); assert.equal(extracted.signal, null); assert.equal(extracted.status, 0, extracted.stderr.toString());
    same(identity(extracted.stdout), entry.object, 'Coverage runtime archive member differs from the qualified object');
  }
  const autoTarget = await fs.readFile(report.configuration['auto-target.h'].path, 'utf8');
  assert(!/^\s*#\s*define\s+(?:inhibit_libc|HAVE_CC_TLS|HAVE_SYS_MMAN_H|TARGET_POSIX_IO)(?:\s|$)/m.test(autoTarget), 'Unsupported official libgcov runtime configuration');
  return { objects: report.objects.length, archives: 2, reopenedFiles: reopened.size };
}

function checkedCommand(result, tool, argv, cwd, exitCode = 0) {
  assert.equal(result.command, tool, 'Unexpected coverage tool');
  assert.deepEqual(result.argv, argv, 'Changed coverage command arguments');
  assert.equal(result.cwd, cwd, 'Changed coverage command working directory');
  assert.equal(result.status, exitCode, result.stderr || 'Unexpected coverage exit status');
  assert.equal(result.signal, null, 'Coverage command was interrupted');
  assert(!result.error, 'Coverage command did not execute');
}

async function verifyRuntimePaths(actual, expected) {
  const samePath = async (observed, wanted, label) => {
    assert(typeof observed === 'string' && path.isAbsolute(observed), 'Missing coverage ' + label);
    assert.equal(await fs.realpath(observed), await fs.realpath(wanted), 'Changed coverage ' + label);
  };
  assert.deepEqual(Object.keys(actual.headerRoots).sort(), Object.keys(expected.headerRoots).sort(), 'Changed coverage header roots');
  for (const [name, wanted] of Object.entries(expected.headerRoots))
    await samePath(actual.headerRoots[name], wanted, name + ' header root');
  const sysroot = expected.sysroot ?? path.dirname(expected.headerRoots.target);
  const gnuSysroot = expected.gnuSysroot ?? path.dirname(expected.headerRoots.gnu);
  const coverageRoot = expected.coverageRoot ?? path.dirname(expected.coverageBuild.path);
  for (const [name, wanted] of Object.entries({ sysroot, gnuSysroot, coverageRoot }))
    await samePath(actual[name], wanted, name);
  assert.deepEqual(Object.keys(actual.archives).sort(), Object.keys(expected.archives).sort(), 'Changed coverage archive inventory');
  for (const [name, wanted] of Object.entries(expected.archives))
    await samePath(actual.archives[name].path, wanted.path, name + ' archive path');
  const library = path.join(sysroot, 'lib/wasm32-wasi');
  for (const name of ['crt', 'libc', 'libm', 'builtins'])
    await samePath(path.dirname(actual.archives[name].path), library, name + ' linker search root');
}

async function reanalyzeCoveragePair(report, analysis, unit, wanted, multiplier, note, profile, recorded, temporaryRoot) {
  // The recorded JSON is not evidence that gcov actually consumed this raw
  // pair. Re-run the exact pinned analyzer on isolated copies, keeping the
  // original notes, profiles and JSON immutable even when validation fails.
  const temporary = await fs.mkdtemp(path.join(temporaryRoot, 'gcc-wasi-gcov-verify-'));
  try {
    await fs.chmod(temporary, 0o700);
    const noteFile = path.join(temporary, unit.gcovStem + '.gcno');
    await fs.writeFile(noteFile, note, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(path.join(temporary, unit.gcovStem + '.gcda'), profile, { flag: 'wx', mode: 0o600 });
    const result = spawnSync(report.tools.gcov.path,
      ['--json-format', '--branch-probabilities', '--branch-counts', noteFile],
      { cwd: temporary, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, LC_ALL: 'C' } });
    assert.ifError(result.error); assert.equal(result.signal, null, 'Pinned gcov was interrupted');
    assert.equal(result.status, 0, 'Pinned gcov rejected the actual notes/profile pair: ' + result.stderr);
    assert.equal(result.stderr, '', 'Pinned gcov reported an invalid notes/profile pair');
    const outputs = (await fs.readdir(temporary)).filter(name => name.endsWith('.gcov.json.gz'));
    assert.equal(outputs.length, 1, 'Pinned gcov did not produce exactly one JSON result');
    const parsed = JSON.parse(gunzipSync(await fs.readFile(path.join(temporary, outputs[0]))));
    assert.equal(parsed.data_file, noteFile, 'Pinned gcov analyzed another notes file');
    const counts = verifyGcovJson(parsed, unit, wanted, multiplier, analysis.source.path);
    assert.deepEqual(counts, analysis.counts, 'Actual raw notes/profile function and branch counts differ');
    // The analyzer's only intentional metadata change is the isolated notes
    // pathname. All source, line, function and branch information must agree.
    assert.deepEqual({ ...parsed, data_file: analysis.note.path }, recorded, 'Retained gcov JSON differs from the actual raw notes/profile pair');
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

function compileArguments(unit, entry, report) {
  const directory = path.dirname(entry.source.path), cpp = unit.language === 'cpp', extension = cpp ? '.cpp' : '.c';
  const compiler = path.dirname(report.tools.gcc.path), work = path.dirname(path.dirname(compiler));
  const flags = ['-O' + unit.optimization, '-std=' + unit.standard, '-mno-simd128', '-fdiagnostics-color=never',
    '-nostdinc', '-D__GCC_WASI_SINGLE_THREAD__=1',
    ...(cpp ? ['-fno-exceptions', '-frtti', '-fuse-cxa-atexit', '-fno-threadsafe-statics'] : ['-Werror=implicit-function-declaration']),
    ...(cpp ? report.runtime.gnuIncludePaths : [report.runtime.headerRoots.gcc, path.join(report.runtime.sysroot, 'include/wasm32-wasi')])
      .flatMap(root => ['-isystem', root]),
    '-dumpbase', unit.gcovStem + extension, '-dumpbase-ext', extension,
    '-fprofile-dir=/profile', '-fprofile-prefix-path=' + directory];
  const instrument = unit.mode === 'coverage' ? ['-fprofile-arcs', '-ftest-coverage', '-fprofile-update=single']
    : unit.mode === 'notes' ? ['-ftest-coverage'] : unit.mode === 'arcs' ? ['-fprofile-arcs', '-fprofile-update=single'] : [];
  return unit.driver ? ['-B' + compiler + '/', '-specs=' + path.join(work, 'native-driver.specs'), '-S',
    ...flags, '--coverage', entry.source.path, '-o', path.basename(entry.assembly.path)]
    : ['-quiet', ...flags, ...instrument, entry.source.path, '-o', entry.assembly.path];
}

function verifyUnit(unit, entry, report) {
  assert.equal(entry.status, 'passed');
  assert.equal(entry.fixtureSha256, identity(Buffer.from(JSON.stringify(unit))).sha256, 'Changed coverage unit contract');
  same(entry.source, identity(Buffer.from(unit.code)), 'Changed original coverage source');
  const directory = path.dirname(entry.source.path);
  const tool = unit.driver ? report.tools.xgcc : unit.language === 'cpp' ? report.tools.gccCpp : report.tools.gcc;
  checkedCommand(entry.commands.compile, tool.path, compileArguments(unit, entry, report), directory);
  assert.equal(entry.commands.compile.stdin, null);
  checkedCommand(entry.commands.assemble, report.tools.assembler.path,
    ['-r', '--enable-annotations', entry.assembly.path, '-o', entry.object.path], directory);
  checkedCommand(entry.commands.validate, report.tools.validator.path, [entry.object.path], directory);
  checkedCommand(entry.commands.disassemble, report.tools.objdump.path, ['-d', entry.object.path], directory);
  const notes = ['coverage', 'notes'].includes(unit.mode);
  assert.equal(entry.notes.length, notes ? 1 : 0, 'Changed coverage notes count');
  for (const note of entry.notes) {
    assert.equal(note.path, path.join(directory, unit.gcovStem + '.gcno'), 'Changed coverage notes filename');
    checkedCommand(note.dump, report.tools.gcovDump.path, ['-l', note.path], directory);
    assert.equal(note.dump.stdin, null); assert.equal(note.dump.stderr, '');
    assert(note.dump.stdout.includes("version `B70 '"), 'Coverage notes use another gcov version word');
  }
}

export function verifyCoverageQualification(report, expected) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, 'gcc-wasi-native-coverage-qualification');
  assert.equal(report.status, 'passed');
  assert.equal(report.target, 'wasm32-wasi');
  assert.equal(report.inputsUnchanged, true);
  assert.deepEqual(report.profile, coverageProfile);
  assert.deepEqual(report.counts, requiredCounts);
  for (const name of ['sourceLock', 'nativeBuild', 'fixtures', 'assemblerProvenance', 'runner'])
    same(report[name], expected[name], 'Stale coverage ' + name);
  same(report.runner, identity(Buffer.from(wasiRunnerSource)), 'Changed coverage WASI runner');
  for (const name of ['gccSource', 'assemblerSource']) assert.deepEqual(report[name], expected[name], 'Changed coverage ' + name);
  for (const name of ['tools', 'recipes']) assert.deepEqual(contents(report[name]), contents(expected[name]), 'Stale coverage ' + name);
  for (const name of ['importReceipt', 'gnuBuild', 'gnuQualification', 'gnuReceipt', 'coverageBuild'])
    same(report.runtime[name], expected.runtime[name], 'Stale coverage runtime ' + name);
  assert.deepEqual(contents(report.runtime.archives), contents(expected.runtime.archives), 'Coverage archives differ from packaged runtime');
  for (const [name, fixtures] of Object.entries({ units, cases, metadataControls, diagnostics }))
    assert.deepEqual(report[name].map(entry => entry.id), fixtures.map(fixture => fixture.id), 'Incomplete coverage ' + name + ' matrix');
  for (const [index, unit] of units.entries()) verifyUnit(unit, report.units[index], report);
  for (const [index, unit] of metadataControls.entries()) verifyUnit(unit, report.metadataControls[index], report);
  const byId = new Map(report.units.map(entry => [entry.id, entry]));
  for (const [index, fixture] of cases.entries()) {
    const entry = report.cases[index];
    assert.equal(entry.status, 'passed');
    assert.equal(entry.fixtureSha256, identity(Buffer.from(JSON.stringify(fixture))).sha256, 'Changed coverage case contract');
    for (const name of ['mode', 'units', 'stdin']) assert.deepEqual(entry[name], fixture[name]);
    assert.equal(entry.expectedStdout, fixture.stdout);
    const directory = path.dirname(entry.program.path), library = path.dirname(report.runtime.archives.libc.path);
    const archive = report.runtime.archives;
    checkedCommand(entry.commands.link, report.tools.linker.path, ['--fatal-warnings', '-m', 'wasm32', '-e', '_start', '-o',
      entry.program.path, archive.crt.path, '-L' + library, ...fixture.units.map(id => byId.get(id).object.path),
      ...(fixture.language === 'cpp' ? [archive.libstdcxx.path, archive.libsupcxx.path] : []),
      ...(fixture.mode === 'coverage' ? [archive.libgcov.path, archive.getpid.path] : []), '-lm', '-lc', archive.builtins.path], directory);
    assert.equal(entry.commands.link.stdin, null);
    assert.equal(entry.runs.length, fixture.runs, 'Incomplete coverage execution/merge runs');
    for (const [runIndex, run] of entry.runs.entries()) {
      assert.equal(run.index, runIndex + 1); assert.equal(run.profileMultiplier, runIndex + 1);
      assert.equal(run.stdin, fixture.stdin); assert.equal(run.expectedStdout, fixture.stdout);
      checkedCommand(run.commands.execute, report.tools.node.path,
        ['--no-warnings', report.runner.path, entry.program.path, path.join(directory, 'profile')], directory);
      assert.equal(run.commands.execute.stdin, fixture.stdin);
      assert.equal(run.commands.execute.stdout, fixture.stdout); assert.equal(run.commands.execute.stderr, '');
      assert.deepEqual(run.profiles.map(value => path.basename(value.path)), fixture.mode === 'coverage'
        ? fixture.units.map(id => units.find(unit => unit.id === id).gcovStem + '.gcda').sort() : []);
      if (!runIndex) assert.deepEqual(run.preexistingProfiles, []);
      else assert.deepEqual(run.preexistingProfiles.map(content), entry.runs[runIndex - 1].profiles.map(content), 'Merge run did not consume the preceding real profile');
      assert.deepEqual(run.analysis.map(value => value.unit), fixture.mode === 'coverage' ? fixture.expected.map(value => value.unit) : []);
      for (const analysis of run.analysis) {
        const unit = units.find(value => value.id === analysis.unit), built = byId.get(analysis.unit);
        assert.deepEqual(analysis.source, built.source);
        same(analysis.note, built.notes[0], 'Coverage analysis did not use the emitted original notes');
        const profile = run.profiles.find(value => path.basename(value.path) === unit.gcovStem + '.gcda');
        same(analysis.profile, profile, 'Coverage analysis did not use the actual execution data');
        const cwd = path.dirname(analysis.note.path);
        checkedCommand(analysis.commands.profileDump, report.tools.gcovDump.path, ['-l', analysis.profile.path], cwd);
        assert.equal(analysis.commands.profileDump.stderr, '');
        assert(analysis.commands.profileDump.stdout.includes("version `B70 '"));
        checkedCommand(analysis.commands.gcov, report.tools.gcov.path,
          ['--json-format', '--branch-probabilities', '--branch-counts', analysis.note.path], cwd);
        assert.equal(analysis.commands.gcov.stderr, '');
      }
    }
  }
  for (const [index, fixture] of diagnostics.entries()) {
    const entry = report.diagnostics[index], directory = path.dirname(entry.source.path), compiler = path.dirname(report.tools.gcc.path);
    const work = path.dirname(path.dirname(compiler));
    assert.equal(entry.status, 'passed');
    assert.equal(entry.fixtureSha256, identity(Buffer.from(JSON.stringify(fixture))).sha256);
    same(entry.source, identity(Buffer.from(fixture.code)), 'Changed unsupported coverage source');
    const flags = ['-O' + fixture.optimization, '-fdiagnostics-color=never', ...fixture.flags, entry.source.path, '-o', path.join(directory, 'program.wat')];
    checkedCommand(entry.command, fixture.driver ? report.tools.xgcc.path : report.tools[fixture.language === 'cpp' ? 'gccCpp' : 'gcc'].path,
      fixture.driver ? ['-B' + compiler + '/', '-specs=' + path.join(work, 'native-driver.specs'), '-S', ...flags] : ['-quiet', ...flags], directory, 1);
    assert(entry.command.stderr.includes(fixture.diagnostic), 'Missing target profiling diagnostic');
    assert(!/internal compiler error/i.test(entry.command.stderr), 'Unsupported profiling option triggered an ICE');
  }
  const analysis = report.analysisTools;
  assert.deepEqual(analysis.gccSource, expected.gccSource);
  same(analysis.nativeBuild, expected.nativeBuild, 'Coverage analysis tool covers another source build');
  assert.equal(analysis.versionWord, 'B70 '); assert.equal(analysis.jsonFormatVersion, '2');
  assert.deepEqual(contents(analysis.sources), contents(expected.analysisTools.sources));
  same(analysis.buildMakefile, expected.analysisTools.buildMakefile, 'Coverage analysis build configuration changed');
  for (const [field, tool] of [['gcovVersion', 'gcov'], ['gcovDumpVersion', 'gcovDump']]) {
    const result = analysis[field];
    checkedCommand(result, report.tools[tool].path, ['--version'], path.dirname(report.runner.path));
    assert(/17\.0\.0\b/.test(result.stdout), 'Coverage analyzer is not the pinned GCC version');
  }
}

export async function reopenCoverageQualification(report, expected) {
  await verifyRuntimePaths(report.runtime, expected.runtime);
  verifyCoverageQualification(report, expected);
  const temporaryRoot = process.env.TMPDIR || path.dirname(expected.nativeBuild.path);
  const reopened = new Map();
  async function read(receipt) {
    assert(path.isAbsolute(receipt.path), 'Coverage qualification needs absolute artifact paths');
    const bytes = await fs.readFile(receipt.path);
    same(identity(bytes), receipt, 'Changed coverage input/artifact: ' + receipt.path);
    reopened.set(receipt.path, content(receipt));
    return bytes;
  }
  assert(Array.isArray(report.inputs) && report.inputs.length);
  assert.equal(new Set(report.inputs.map(value => value.path)).size, report.inputs.length, 'Duplicate coverage input');
  for (const receipt of report.inputs) await read(receipt);
  for (const receipt of [report.sourceLock, report.nativeBuild, report.fixtures, report.assemblerProvenance, report.runner,
    ...Object.values(report.tools), ...Object.values(report.recipes), ...Object.values(report.analysisTools.sources),
    report.analysisTools.buildMakefile, ...Object.values(report.runtime.archives), report.runtime.importReceipt,
    report.runtime.gnuBuild, report.runtime.gnuQualification, report.runtime.gnuReceipt, report.runtime.coverageBuild]) await read(receipt);
  const included = await Promise.all(report.runtime.gnuIncludePaths.map(root => fs.realpath(root)));
  const wanted = await Promise.all(expected.runtime.gnuIncludePaths.map(root => fs.realpath(root)));
  assert.deepEqual(included, wanted, 'Coverage GNU include order changed');
  assert.deepEqual(Object.keys(report.runtime.headers).sort(), Object.keys(expected.runtime.headers).sort());
  for (const [name, headers] of Object.entries(report.runtime.headers)) {
    const actual = {}, wanted = {};
    for (const receipt of headers) {
      await read(receipt);
      const relative = path.relative(report.runtime.headerRoots[name], receipt.path);
      assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
      const filename = await fs.realpath(receipt.path); assert(!Object.hasOwn(actual, filename)); actual[filename] = content(receipt);
    }
    for (const receipt of expected.runtime.headers[name]) wanted[await fs.realpath(receipt.path)] = content(receipt);
    assert.deepEqual(actual, wanted, 'Coverage header tree differs from package inputs: ' + name);
  }
  for (const [fixtures, entries] of [[units, report.units], [metadataControls, report.metadataControls]])
    for (const [index, entry] of entries.entries()) {
      await read(entry.source); await read(entry.assembly);
      const object = await read(entry.object);
      const decoded = spawnSync(report.tools.objdump.path, ['-d', entry.object.path], { encoding: 'utf8', timeout: 30000 });
      assert.ifError(decoded.error); assert.equal(decoded.status, 0, decoded.stderr); assert.equal(decoded.signal, null);
      assert.equal(decoded.stdout, entry.commands.disassemble.stdout, 'Coverage object disassembly changed');
      assert.deepEqual(inspectCoverageObject(object, fixtures[index], decoded.stdout), entry.inspection, 'Coverage instrumentation metadata changed');
      for (const note of entry.notes) await read(note);
    }
  for (const [index, entry] of report.cases.entries()) {
    const fixture = cases[index], byId = new Map(units.map(unit => [unit.id, unit]));
    const program = await read(entry.program); assert(WebAssembly.validate(program), 'Invalid coverage executable');
    const module = new WebAssembly.Module(program), imports = WebAssembly.Module.imports(module), exports = WebAssembly.Module.exports(module);
    assert.deepEqual(imports, entry.imports); assert.deepEqual(exports, entry.exports);
    assert(imports.every(value => value.module === 'wasi_snapshot_preview1' && value.kind === 'function'));
    assert(exports.some(value => value.name === '_start' && value.kind === 'function'));
    assert(exports.some(value => value.name === 'memory' && value.kind === 'memory'));
    for (const run of entry.runs) {
      for (const receipt of [...run.preexistingProfiles, ...run.profiles]) await read(receipt);
      for (const analysis of run.analysis) {
        await read(analysis.source);
        const note = await read(analysis.note), profile = await read(analysis.profile);
        const decoded = gunzipSync(await read(analysis.compressedJson));
        assert(decoded.equals(await read(analysis.json)), 'Official gcov JSON differs from its compressed output');
        const parsed = JSON.parse(decoded); assert.equal(parsed.data_file, analysis.note.path);
        const unit = byId.get(analysis.unit), wanted = fixture.expected.find(value => value.unit === unit.id);
        assert.deepEqual(verifyGcovJson(parsed, unit, wanted, run.profileMultiplier, analysis.source.path), analysis.counts,
          'Actual official gcov function/branch counts changed');
        await reanalyzeCoveragePair(report, analysis, unit, wanted, run.profileMultiplier, note, profile, parsed, temporaryRoot);
      }
    }
  }
  for (const entry of report.diagnostics) {
    await read(entry.source);
    const files = await fs.readdir(path.dirname(entry.source.path));
    assert(!files.some(name => /\.(?:wat|gcno|gcda)$/.test(name)), 'Rejected profiling option left a compiler/profile output');
  }
  return { ...requiredCounts, reopenedFiles: reopened.size };
}

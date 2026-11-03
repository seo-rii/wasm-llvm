import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import {
  cases,
  controls,
  diagnostics,
  combinations,
  debugProfile,
  requiredCounts
} from './dwarf-fixtures.mjs';
import {
  dwarfIdentity,
  llvmCodeSection,
  dwarfPc,
  llvmDwarfDies,
  dwarfDieName,
  dwarfFunction,
  dwarfFunctionRange,
  inspectFunctionLocations,
  assertRecordType,
  assertUserCompilationUnit,
  assertWideTypes,
  inspectDwarfCustomSections,
  consumeDwarfPc,
  sourceFramesFromNodeTrap,
  verifyLiveDwarfValues
} from './dwarf-inspect.mjs';
import { inspectCoverageObject, verifyGcovJson } from './coverage-inspect.mjs';

const content = (receipt) => ({
  bytes: receipt?.bytes,
  sha256: receipt?.sha256
});
const same = (actual, expected, label) =>
  assert.deepEqual(content(actual), content(expected), label);
const jsonValue = (value) => JSON.parse(JSON.stringify(value));
const ordered = (values) => [...values].sort((a, b) => a.path.localeCompare(b.path));

export function verifyDwarfQualificationOptions(patches, options) {
  if (
    !patches.some((patch) => patch.path === 'patches/0021-dwarf-debug.patch') &&
    !options.dwarfQualification
  )
    return;
  for (const name of ['dwarfQualification', 'nativeLinker', 'libstdcxx', 'libgcov', 'nativeGcov'])
    assert(options[name], 'GCC embedded DWARF requires ' + name);
}

function command(result, tool, argv, cwd, status = 0, stdin = null, environment = {}) {
  assert.equal(result?.command, tool, 'DWARF qualification used an unbound tool');
  assert.deepEqual(result.argv, argv, 'Changed DWARF command arguments');
  assert.equal(result.cwd, cwd, 'Changed DWARF working directory');
  assert.equal(result.status, status, result.stderr || 'DWARF command failed');
  assert.equal(result.signal, null, 'DWARF command was interrupted');
  assert(!result.error, 'DWARF command did not execute');
  assert.equal(result.stdin, stdin, 'Changed DWARF command input');
  assert.deepEqual(result.environment ?? {}, environment, 'Changed DWARF command environment');
}

function compilationArguments(fixture, program, unit, report, index) {
  const profile = program.profile,
    directory = path.dirname(program.program.path);
  const cpp = fixture.language === 'cpp';
  return [
    '-quiet',
    '-O' + profile.optimization,
    '-std=' + fixture.standard,
    profile.simd ? '-msimd128' : '-mno-simd128',
    '-fdiagnostics-color=never',
    '-nostdinc',
    '-D__GCC_WASI_SINGLE_THREAD__=1',
    ...(cpp
      ? ['-fno-exceptions', '-frtti', '-fuse-cxa-atexit', '-fno-threadsafe-statics']
      : ['-Werror=implicit-function-declaration']),
    ...(profile.debug === 'dwarf4'
      ? debugProfile.compilerFlags
      : profile.debug === 'g0'
        ? ['-g0']
        : []),
    ...(profile.coverage
      ? [
          '-fprofile-arcs',
          '-ftest-coverage',
          '-fprofile-update=single',
          '-fprofile-dir=/profile',
          '-fprofile-prefix-path=' + directory,
          '-dumpbase',
          `program${index ? '.' + index : ''}.c`,
          '-dumpbase-ext',
          '.c'
        ]
      : []),
    '-I' + directory,
    ...(cpp ? report.runtime.includeRoots.cpp : report.runtime.includeRoots.c).flatMap((root) => [
      '-isystem',
      root
    ]),
    unit.source.path,
    '-o',
    unit.assembly.path
  ];
}

function verifyProgram(fixture, program, report, profile) {
  assert.equal(program?.fixtureId, fixture.id);
  assert.deepEqual(program.profile, profile, 'Changed DWARF compilation profile');
  const directory = path.dirname(program.program.path);
  assert.deepEqual(
    program.files.map((file) => path.relative(directory, file.path)),
    fixture.files.map((file) => file.path),
    'Changed original DWARF fixture file inventory'
  );
  for (const [index, file] of fixture.files.entries())
    same(
      program.files[index],
      dwarfIdentity(Buffer.from(file.contents)),
      'Changed original DWARF source/header'
    );
  assert.deepEqual(
    program.units.map((unit) => unit.sourceName),
    fixture.sources,
    'Incomplete DWARF translation units'
  );
  for (const [index, unit] of program.units.entries()) {
    assert.equal(unit.source.path, path.join(directory, fixture.sources[index]));
    assert.deepEqual(
      unit.source,
      program.files.find((file) => file.path === unit.source.path)
    );
    assert.equal(unit.assembly.path, path.join(directory, `unit${index}.wat`));
    assert.equal(unit.object.path, path.join(directory, `unit${index}.o`));
    command(
      unit.commands.compilation,
      report.tools[fixture.language === 'cpp' ? 'gccCpp' : 'gcc'].path,
      compilationArguments(fixture, program, unit, report, index),
      directory
    );
    command(
      unit.commands.assembling,
      report.tools.assembler.path,
      ['-r', '--enable-annotations', unit.assembly.path, '-o', unit.object.path],
      directory
    );
    command(unit.commands.validation, report.tools.validator.path, [unit.object.path], directory);
    command(
      unit.commands.verify,
      report.tools.llvmDwarf.path,
      ['--verify', unit.object.path],
      directory
    );
  }
  const archive = report.runtime.archives;
  command(
    program.commands.linking,
    report.tools.linker.path,
    [
      '--fatal-warnings',
      '--gc-sections',
      '-m',
      'wasm32',
      '-e',
      '_start',
      '-o',
      program.program.path,
      archive.crt.path,
      '-L' + path.dirname(archive.libc.path),
      '-L' + path.dirname(archive.libstdcxx.path),
      ...program.units.map((unit) => unit.object.path),
      ...(fixture.language === 'cpp' ? ['-lstdc++'] : []),
      ...(profile.coverage ? [archive.libgcov.path, archive.getpid.path] : []),
      '-lm',
      '-lc',
      archive.builtins.path
    ],
    directory
  );
  command(
    program.commands.verify,
    report.tools.llvmDwarf.path,
    ['--verify', program.program.path],
    directory
  );
  command(
    program.commands.headers,
    report.tools.llvmObjdump.path,
    ['--section-headers', program.program.path],
    directory
  );
  if (profile.debug === 'dwarf4') {
    assert.equal(program.consumer?.path, path.join(directory, 'consumer.wasm'));
    command(
      program.commands.consumerCopy,
      report.tools.objcopy.path,
      [
        '--remove-section=name',
        '--remove-section=EXPORT',
        program.program.path,
        program.consumer.path
      ],
      directory
    );
    command(
      program.commands.consumerVerify,
      report.tools.llvmDwarf.path,
      ['--verify', program.consumer.path],
      directory
    );
    assert.equal(program.consumerBytesPreserved, true);
  }
}

// This structural pass is also used before opening any external report paths.
// It never treats a summary flag or a recorded command as raw artifact proof.
export function verifyDwarfQualification(report, expected) {
  assert.equal(report?.schemaVersion, 1);
  assert.equal(report.kind, 'gcc-wasi-native-dwarf-qualification');
  assert.equal(report.status, 'passed', 'Full native DWARF qualification did not pass');
  assert.equal(report.inputsUnchanged, true);
  assert.equal(report.artifactsUnchanged, true);
  assert(!report.error && !report.browserCleanupError && !report.serverCleanupError);
  assert.deepEqual(report.profile, debugProfile, 'Changed qualified DWARF profile');
  assert.deepEqual(report.scope, {
    fullMatrix: true,
    selectedCases: cases.map((fixture) => fixture.id),
    compilerHost: 'native',
    target: 'wasm32-wasi',
    browserRunsCompiler: false
  });
  for (const name of ['sourceLock', 'nativeBuild', 'assemblerBuild'])
    same(report[name], expected[name], 'Stale DWARF ' + name);
  for (const name of ['gccSource', 'wabtSource'])
    assert.deepEqual(report[name], expected[name], 'Changed DWARF ' + name);
  for (const name of ['tools', 'recipes'])
    assert.deepEqual(report[name], expected[name], 'Stale DWARF ' + name);
  assert.deepEqual(
    report.analysisToolDependencies,
    expected.analysisToolDependencies,
    'Changed official LLVM dynamic dependencies'
  );
  for (const name of ['sysroot', 'gnuSysroot', 'includeRoots', 'archives'])
    assert.deepEqual(report.runtime[name], expected.runtime[name], 'Changed DWARF runtime ' + name);
  assert.deepEqual(
    Object.keys(report.runtime.headers).sort(),
    Object.keys(expected.runtime.headers).sort()
  );
  for (const [name, headers] of Object.entries(expected.runtime.headers))
    assert.deepEqual(
      ordered(report.runtime.headers[name]),
      ordered(headers),
      'Changed DWARF runtime headers: ' + name
    );
  for (const name of ['importReceipt', 'gnuBuild', 'gnuQualification', 'coverageBuild'])
    same(report.runtime[name], expected.runtime[name], 'Stale DWARF runtime ' + name);
  assert.equal(report.runtime.coverageRoot, expected.runtime.coverageRoot);
  for (const name of ['sources', 'buildMakefile', 'versionWord', 'jsonFormatVersion'])
    assert.deepEqual(
      report.runtime.coverageAnalysis[name],
      expected.runtime.coverageAnalysis[name],
      'Changed DWARF coverage analysis ' + name
    );
  assert.equal(
    report.runtime.currentCompilerBound,
    true,
    'DWARF GNU runtime used an older compiler'
  );
  assert.deepEqual(report.runtime.gnuCompilerSource, expected.gccSource);
  assert.deepEqual(
    report.cases.map((entry) => entry.id),
    cases.map((fixture) => fixture.id),
    'Incomplete native DWARF matrix'
  );
  const output = report.sourceChecks?.[0]?.cwd;
  assert(path.isAbsolute(output), 'DWARF qualification needs its actual output directory');
  for (const [index, fixture] of cases.entries()) {
    const entry = report.cases[index];
    assert.equal(entry.status, 'passed');
    assert.equal(entry.fixtureSha256, dwarfIdentity(Buffer.from(JSON.stringify(fixture))).sha256);
    verifyProgram(fixture, entry.program, report, {
      debug: 'dwarf4',
      optimization: '0'
    });
    assert.deepEqual(
      entry.executions.map((run) => run.id),
      fixture.runs.map((run) => run.id)
    );
    for (const [runIndex, spec] of fixture.runs.entries()) {
      const execution = entry.executions[runIndex];
      assert.equal(execution.status, 'passed');
      verifyExecution(execution, spec, entry.program, report, output);
      if (spec.trap) {
        assert.deepEqual(
          execution.frames.map((frame) => frame.name),
          fixture.expected.frames
        );
        assert.deepEqual(
          execution.live.map((frame) => frame.name),
          fixture.expected.frames
        );
      }
    }
  }
  const frameFixtures = cases.filter((fixture) => fixture.family === 'frames');
  assert.deepEqual(
    report.controls.map((entry) => entry.id),
    frameFixtures.flatMap((fixture) => controls.map((control) => fixture.id + '-' + control.id)),
    'Incomplete default/g0/optimized/strip controls'
  );
  for (const fixture of frameFixtures) {
    for (const control of controls) {
      const entry = report.controls.find((entry) => entry.id === fixture.id + '-' + control.id);
      assert.equal(entry.status, 'passed');
      assert.deepEqual(entry.control, control);
      if (control.kind !== 'strip') {
        verifyProgram(fixture, entry.program, report, control);
      } else {
        const original = report.cases.find((entry) => entry.id === fixture.id).program;
        command(
          entry.copying,
          report.tools.objcopy.path,
          [control.option, original.program.path, entry.artifact.path],
          output
        );
        assert.equal(entry.codeBytesPreserved, true);
        assert.equal(entry.debugSectionsRemoved, true);
      }
      const program = control.kind === 'strip' ? { program: entry.artifact } : entry.program;
      verifyExecution(
        entry.execution,
        fixture.runs.find((spec) => !spec.trap),
        program,
        report,
        output
      );
    }
  }
  assert.deepEqual(
    report.diagnostics.map((entry) => entry.id),
    diagnostics.map((fixture) => fixture.id),
    'Incomplete unsupported-format diagnostics'
  );
  for (const [index, fixture] of diagnostics.entries()) {
    const entry = report.diagnostics[index],
      directory = path.dirname(entry.source.path);
    assert.equal(entry.status, 'passed');
    assert.deepEqual(entry.flags, fixture.flags);
    same(
      entry.source,
      dwarfIdentity(Buffer.from(fixture.code)),
      'Changed unsupported-format source'
    );
    const argv = [
      '-quiet',
      '-O0',
      '-fdiagnostics-color=never',
      ...fixture.flags,
      entry.source.path,
      '-o',
      path.join(directory, 'program.wat')
    ];
    assert(Number.isSafeInteger(entry.command.status) && entry.command.status > 0);
    command(
      entry.command,
      report.tools[fixture.language === 'c' ? 'gcc' : 'gccCpp'].path,
      argv,
      directory,
      entry.command.status
    );
    assert.match(
      entry.command.stderr,
      /supports embedded DWARF32\/DWARF4 only|unsupported|not supported|unrecognized/i
    );
  }
  assert.deepEqual(
    report.combinations?.map((entry) => entry.id),
    combinations.map((fixture) => fixture.id),
    'Incomplete DWARF feature combinations'
  );
  for (const [index, fixture] of combinations.entries()) {
    const entry = report.combinations[index];
    assert.equal(entry.status, 'passed');
    assert.equal(entry.feature, fixture.feature);
    assert.equal(entry.fixtureSha256, dwarfIdentity(Buffer.from(JSON.stringify(fixture))).sha256);
    verifyProgram(fixture, entry.program, report, {
      debug: 'dwarf4',
      optimization: '0',
      [fixture.feature]: true
    });
  }
  assert.equal(report.counts.cases, requiredCounts.cases);
  assert.equal(report.counts.sourceUnits, requiredCounts.translationUnits);
  assert.equal(report.counts.normalExecutionsPerHost, requiredCounts.normalExecutionsPerHost);
  assert.equal(report.counts.trappedExecutionsPerHost, requiredCounts.trappedExecutionsPerHost);
  assert.equal(
    report.counts.controls,
    requiredCounts.frameCases * requiredCounts.controlsPerFrameCase
  );
  assert.equal(report.counts.diagnostics, diagnostics.length);
  assert.deepEqual(
    report.counts.actualLocalIndexBoundaries,
    requiredCounts.requiredLiveLocalIndices
  );
  return { output };
}

function verifyExecution(execution, spec, program, report, output) {
  const node = execution.node,
    chromium = execution.chromium;
  const argv = [
    '--no-warnings',
    path.join(output, 'run-node.mjs'),
    program.program.path,
    ...(spec.args ?? [])
  ];
  if (spec.trap) {
    assert(Number.isSafeInteger(node.status) && node.status > 0);
    command(node, report.tools.node.path, argv, output, node.status, spec.stdin);
    assert.match(node.stderr, /unreachable/);
    assert.match(chromium.error?.message, /unreachable/);
  } else {
    command(node, report.tools.node.path, argv, output, spec.exitCode, spec.stdin);
    assert.equal(node.stderr, '');
    assert.equal(chromium.exitCode, spec.exitCode);
    assert(!chromium.error);
  }
  assert.equal(node.stdout, spec.stdout);
  assert.equal(chromium.stdout, spec.stdout);
  assert.equal(chromium.stderr, '');
  assert.equal(
    chromium.moduleBytes,
    program.program.bytes,
    'Browser executed another module payload size'
  );
}

function run(tool, argv, stdin = null, cwd, timeout = 120000) {
  const result = spawnSync(tool, argv, {
    cwd,
    input: stdin ?? undefined,
    encoding: 'utf8',
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C' }
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, 'Official DWARF consumer was interrupted');
  assert.equal(
    result.status,
    0,
    result.stderr || 'Official DWARF consumer rejected the actual artifact'
  );
  return result;
}

function replay(recorded, tool, argv, cwd, stdin = null) {
  command(recorded, tool, argv, cwd, 0, stdin);
  const actual = run(tool, argv, stdin, cwd);
  assert.equal(
    actual.stdout,
    recorded.stdout,
    'Actual official DWARF output differs from its receipt'
  );
  assert.equal(
    actual.stderr,
    recorded.stderr,
    'Actual official DWARF diagnostics differ from their receipt'
  );
  return actual;
}

export async function reopenDwarfQualification(report, expected) {
  const { output } = verifyDwarfQualification(report, expected);
  const frozen = new Map(),
    reopened = new Map();
  for (const [name, receipts] of Object.entries({
    inputs: report.inputs,
    artifacts: report.artifacts
  })) {
    assert(Array.isArray(receipts) && receipts.length, 'Missing frozen DWARF ' + name);
    assert.equal(
      new Set(receipts.map((receipt) => receipt.path)).size,
      receipts.length,
      'Duplicate frozen DWARF ' + name
    );
    for (const receipt of receipts) {
      assert(path.isAbsolute(receipt.path), 'DWARF evidence needs an absolute pathname');
      assert(
        Number.isSafeInteger(receipt.bytes) &&
          receipt.bytes >= 0 &&
          /^[a-f0-9]{64}$/.test(receipt.sha256)
      );
      if (frozen.has(receipt.path)) assert.deepEqual(frozen.get(receipt.path), receipt);
      frozen.set(receipt.path, receipt);
    }
  }
  async function read(receipt) {
    assert.deepEqual(frozen.get(receipt?.path), receipt, 'Unfrozen DWARF input/artifact reference');
    const bytes = await fs.readFile(receipt.path);
    same(dwarfIdentity(bytes), receipt, 'Changed raw DWARF input/artifact: ' + receipt.path);
    reopened.set(receipt.path, content(receipt));
    return bytes;
  }
  for (const receipt of frozen.values()) await read(receipt);
  // Every nested identity must be present in the frozen inventories, including
  // newly added optional evidence; summary-only references cannot bypass I/O.
  async function references(value) {
    if (!value || typeof value !== 'object') return;
    if (
      Object.hasOwn(value, 'path') &&
      Object.hasOwn(value, 'bytes') &&
      Object.hasOwn(value, 'sha256')
    ) {
      await read(value);
      return;
    }
    for (const child of Object.values(value)) await references(child);
  }
  for (const [name, value] of Object.entries(report))
    if (!['inputs', 'artifacts'].includes(name)) await references(value);
  const sourceLock = JSON.parse(await read(report.sourceLock));
  assert.equal(
    report.sourceLock.path,
    path.join(path.dirname(report.recipes['prepare-source.py'].path), 'sources.lock.json')
  );
  assert.deepEqual(report.gccSource, {
    gccCommit: sourceLock.gcc.commit,
    patches: sourceLock.gcc.patches,
    sourceDiffSha256: sourceLock.gcc.sourceDiffSha256
  });
  assert.deepEqual(report.wabtSource, {
    wabtCommit: sourceLock.wabt.commit,
    patches: sourceLock.wabt.patches,
    sourceDiffSha256: sourceLock.wabt.sourceDiffSha256,
    submodules: sourceLock.wabt.submodules
  });
  const native = JSON.parse(await read(report.nativeBuild)),
    assembler = JSON.parse(await read(report.assemblerBuild));
  assert.equal(native.sourceLockSha256, report.sourceLock.sha256);
  assert.deepEqual(native.gccSource, report.gccSource);
  // Bootstrap compiler entries contain only SHA256. The current tools above
  // independently bind and reopen byte counts and hashes at expected paths.
  for (const [binary, key] of [
    ['cc1', 'gcc'],
    ['cc1plus', 'gccCpp']
  ])
    assert.equal(
      native.tools[binary].sha256,
      report.tools[key].sha256,
      'Current native GCC differs'
    );
  assert.equal(assembler.host, 'native');
  assert.equal(assembler.inputsUnchanged, true);
  assert.deepEqual(assembler.source, report.wabtSource);
  for (const [binary, key] of [
    ['wat2wasm', 'assembler'],
    ['wasm-objdump', 'objdump'],
    ['wasm-validate', 'validator']
  ])
    same(assembler.files[binary], report.tools[key], 'Current native WABT differs');
  same(
    assembler.recipes['sources.lock.json'],
    report.sourceLock,
    'Native WABT receipt covers another whole source lock'
  );
  const gnu = JSON.parse(await read(report.runtime.gnuBuild)),
    gnuQualified = JSON.parse(await read(report.runtime.gnuQualification));
  assert.deepEqual(gnu.gccSource, report.gccSource);
  for (const [binary, key] of [
    ['cc1', 'gcc'],
    ['cc1plus', 'gccCpp']
  ])
    assert.equal(gnu.nativeCompiler[binary], report.tools[key].sha256);
  assert.equal(gnu.rtti, true);
  assert.equal(gnu.exceptions, false);
  assert.equal(gnuQualified.status, 'passed');
  assert.equal(gnuQualified.rtti, true);
  same(
    gnuQualified.buildReceipt,
    report.runtime.gnuBuild,
    'GNU qualification covers another build'
  );
  const coverage = JSON.parse(await read(report.runtime.coverageBuild));
  assert.equal(coverage.kind, 'gcc-wasi-libgcov-build');
  assert.equal(coverage.status, 'built-unverified');
  assert.equal(coverage.inputsUnchanged, true);
  assert.deepEqual(coverage.gccSource, report.gccSource);
  same(
    coverage.sourceLock,
    report.sourceLock,
    'Combined coverage runtime covers another source lock'
  );
  same(
    coverage.nativeBuild,
    report.nativeBuild,
    'Combined coverage runtime covers another native compiler'
  );
  for (const [binary, key] of [
    ['cc1', 'gcc'],
    ['cc1plus', 'gccCpp']
  ])
    same(
      coverage.nativeCompiler[binary],
      report.tools[key],
      'Combined coverage runtime compiler differs'
    );
  for (const [filename, key] of [
    ['libgcov.a', 'libgcov'],
    ['libwasi-emulated-getpid.a', 'getpid']
  ])
    same(
      coverage.libraries[filename],
      report.runtime.archives[key],
      'Combined coverage runtime archive differs'
    );
  assert.equal(report.sourceChecks.length, 2, 'Incomplete current source profile checks');
  for (const [index, component] of ['gcc', 'wabt'].entries()) {
    const check = report.sourceChecks[index];
    assert.equal(check.command, 'python3');
    assert.deepEqual(check.argv.slice(0, 4), [
      report.recipes['prepare-source.py'].path,
      '--component',
      component,
      '--source'
    ]);
    assert.equal(check.argv.length, 5);
    assert(path.isAbsolute(check.argv[4]));
    assert.equal(check.cwd, output);
    assert.equal(check.status, 0);
    assert.equal(check.signal, null);
    assert(!check.error);
    assert.deepEqual(JSON.parse(check.stdout), report[component + 'Source']);
  }
  for (const key of ['llvmDwarf', 'symbolizer']) {
    const version = replay(report.llvmVersions[key], report.tools[key].path, ['--version'], output);
    assert(version.stdout.includes('22.1.0-wasi-sdk'));
  }
  for (const [field, key] of [
    ['gcovVersion', 'gcov'],
    ['gcovDumpVersion', 'gcovDump']
  ]) {
    const version = replay(
      report.runtime.coverageAnalysis[field],
      report.tools[key].path,
      ['--version'],
      output
    );
    assert(version.stdout.includes('17.0.0'));
  }
  let programs = 0,
    sourceUnits = 0,
    liveFrames = 0;
  async function reopenProgram(fixture, program, sourceFeatures = false) {
    const directory = path.dirname(program.program.path),
      debug = program.profile.debug === 'dwarf4';
    for (const [index, unit] of program.units.entries()) {
      replay(
        unit.commands.verify,
        report.tools.llvmDwarf.path,
        ['--verify', unit.object.path],
        directory
      );
      const dump = run(
        report.tools.llvmDwarf.path,
        ['--debug-info', '--debug-line', '--debug-loc', unit.object.path],
        null,
        directory
      );
      const saved = frozen.get(path.join(directory, `unit${index}.dwarf.txt`));
      assert(saved, 'Missing raw object DWARF dump');
      assert.equal((await read(saved)).toString(), dump.stdout);
      assert.deepEqual(
        await inspectDwarfCustomSections(await read(unit.object), debug),
        unit.objectSections
      );
      if (debug)
        assert.deepEqual(unit.sourceUnit, assertUserCompilationUnit(dump.stdout, unit.source.path));
      else assert.equal(unit.sourceUnit, null);
      sourceUnits++;
    }
    replay(
      program.commands.verify,
      report.tools.llvmDwarf.path,
      ['--verify', program.program.path],
      directory
    );
    const headers = replay(
      program.commands.headers,
      report.tools.llvmObjdump.path,
      ['--section-headers', program.program.path],
      directory
    );
    const code = llvmCodeSection(headers.stdout),
      bytes = await read(program.program);
    assert.deepEqual(program.code, code);
    same(
      dwarfIdentity(bytes.subarray(code.offset, code.offset + code.size)),
      program.codeIdentity,
      'Changed linked CODE payload'
    );
    assert.deepEqual(
      await inspectDwarfCustomSections(bytes, debug ? true : null),
      program.debugSections
    );
    const dump = run(
      report.tools.llvmDwarf.path,
      ['--debug-info', '--debug-line', '--debug-loc', program.program.path],
      null,
      directory
    );
    assert.equal(
      (await read(program.dwarfDump)).toString(),
      dump.stdout,
      'Linked DWARF dump is stale'
    );
    const dies = llvmDwarfDies(dump.stdout);
    if (!debug) {
      for (const unit of program.units)
        assert(
          !dump.stdout.includes('"' + unit.source.path + '"'),
          'Release user source CU leaked into runtime debug data'
        );
    } else {
      replay(
        program.commands.consumerVerify,
        report.tools.llvmDwarf.path,
        ['--verify', program.consumer.path],
        directory
      );
      const consumer = await read(program.consumer),
        consumerCode = llvmCodeSection(
          run(
            report.tools.llvmObjdump.path,
            ['--section-headers', program.consumer.path],
            null,
            directory
          ).stdout
        );
      assert.deepEqual(program.consumerCode, consumerCode);
      same(
        dwarfIdentity(
          consumer.subarray(consumerCode.offset, consumerCode.offset + consumerCode.size)
        ),
        program.codeIdentity,
        'Analysis-only symbolizer copy changed executable CODE'
      );
      assert.deepEqual(
        await inspectDwarfCustomSections(consumer),
        program.debugSections,
        'Analysis-only copy changed raw DWARF'
      );
      if (sourceFeatures && fixture.family === 'frames')
        assert.deepEqual(program.recordType, assertRecordType(dies, fixture.expected.recordType));
      if (sourceFeatures && fixture.family === 'wide')
        assert.deepEqual(program.wideTypes, assertWideTypes(dies));
      if (sourceFeatures && fixture.family === 'main-abi') {
        const names = dwarfFunction(dies, 'main')
          .children.filter((die) => die.tag === 'DW_TAG_formal_parameter')
          .map((die) => dwarfDieName(die));
        assert.deepEqual(names, fixture.abi === 'void' ? [] : ['argc', 'argv']);
        assert.deepEqual(program.mainAbi, {
          kind: fixture.abi,
          formalParameterNames: names
        });
      }
    }
    programs++;
    return dies;
  }
  for (const [index, fixture] of cases.entries()) {
    const entry = report.cases[index],
      program = entry.program,
      dies = await reopenProgram(fixture, program, true);
    if (fixture.expected.deadFunction) {
      const disassembly = replay(
        entry.deadCode.command,
        report.tools.llvmObjdump.path,
        ['--disassemble', program.program.path],
        output
      );
      assert.equal(entry.deadCode.name, fixture.expected.deadFunction);
      assert.equal(entry.deadCode.linkerGarbageCollection, true);
      assert(!new RegExp('<[^>\\n]*' + fixture.expected.deadFunction).test(disassembly.stdout));
    }
    for (const execution of entry.executions.filter((value) => value.id === 'trap')) {
      const snapshot = JSON.parse(await read(execution.pause));
      assert(Array.isArray(snapshot.memory) && snapshot.memory.length <= 2 * 1024 * 1024);
      assert(snapshot.memory.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255));
      assert.deepEqual(
        snapshot.frames.map((frame) => frame.name),
        fixture.expected.frames
      );
      assert.equal(
        program.sourcePaths,
        undefined,
        'Native DWARF evidence cannot replace physical source paths'
      );
      for (const actual of snapshot.frames) {
        assert.equal(actual.codeOffset, program.code.offset);
        assert.equal(
          actual.pc,
          dwarfPc(actual.location.columnNumber, actual.codeOffset),
          'Paused CDP PC differs from original CODE base and raw location'
        );
        const range = dwarfFunctionRange(dwarfFunction(dies, actual.name));
        assert(actual.pc >= range.low && actual.pc < range.high);
        assert.equal(new Set(actual.locals.map((value) => value.name)).size, actual.locals.length);
        assert(
          Number.isSafeInteger(actual.localCount) && actual.localCount >= actual.locals.length
        );
      }
      const currentProgram = { ...program, dies };
      function query(tool, argv, cwd = output, stdin = null, timeout = 120000) {
        assert([report.tools.llvmDwarf.path, report.tools.symbolizer.path].includes(tool));
        const result = run(tool, argv, stdin, cwd, timeout);
        return {
          command: tool,
          argv,
          cwd,
          stdin,
          status: result.status,
          signal: result.signal,
          stdout: result.stdout || '',
          stderr: result.stderr || ''
        };
      }
      const consume = (name, pc) =>
        consumeDwarfPc({
          program: currentProgram,
          fixture,
          name,
          pc,
          run: query,
          toolPaths: Object.fromEntries(
            Object.entries(report.tools).map(([name, tool]) => [name, tool.path])
          ),
          cwd: output
        });
      const frames = sourceFramesFromNodeTrap(currentProgram, fixture, execution.node, consume);
      assert.deepEqual(
        execution.frames,
        jsonValue(frames),
        'Runtime stack source/line/location receipts differ from current official consumers'
      );
      const live = verifyLiveDwarfValues(fixture, currentProgram, frames, snapshot, consume);
      assert.deepEqual(
        execution.live,
        jsonValue(live),
        'Retained source values differ from actual indexed CDP locals/memory and current DWARF'
      );
      liveFrames += live.length;
    }
  }
  for (const fixture of cases.filter((fixture) => fixture.family === 'frames')) {
    const original = report.cases.find((entry) => entry.id === fixture.id).program;
    for (const control of controls) {
      const entry = report.controls.find((entry) => entry.id === fixture.id + '-' + control.id);
      if (control.kind === 'strip') {
        const bytes = await read(entry.artifact),
          code = llvmCodeSection(
            run(
              report.tools.llvmObjdump.path,
              ['--section-headers', entry.artifact.path],
              null,
              output
            ).stdout
          );
        same(
          dwarfIdentity(bytes.subarray(code.offset, code.offset + code.size)),
          original.codeIdentity,
          'Strip changed executable CODE'
        );
        await inspectDwarfCustomSections(bytes, false);
      } else {
        const dies = await reopenProgram(fixture, entry.program);
        if (control.kind === 'optimized') {
          const die = dwarfFunction(dies, 'debug_leaf'),
            range = dwarfFunctionRange(die);
          const probes = new Set([range.low, range.high - 1]);
          function collect(value) {
            for (const attribute of Object.values(value.attributes))
              for (const match of attribute.matchAll(/\[0x([\da-f]+),\s*0x([\da-f]+)\):/gi)) {
                const pc = Number.parseInt(match[1], 16);
                if (pc >= range.low && pc < range.high) probes.add(pc);
              }
            for (const child of value.children) collect(child);
          }
          collect(die);
          for (const pc of probes) {
            const locations = inspectFunctionLocations(die, pc);
            for (const name of ['adjusted', 'local']) {
              const variable = locations.variables.find((value) => value.name === name);
              assert(
                !variable || variable.location.kind === 'unavailable',
                'O2 invented a supported register location'
              );
            }
          }
          assert.deepEqual(entry.optimizedRegisterLocations, {
            status: 'unavailable',
            probedRangeBoundaries: [...probes]
          });
        }
      }
    }
    for (const optimization of ['0', '2']) {
      const defaults = report.controls.find(
        (entry) =>
          entry.id ===
          fixture.id + (optimization === '0' ? '-default-release' : '-default-release-o2')
      );
      const disabled = report.controls.find(
        (entry) =>
          entry.id === fixture.id + (optimization === '0' ? '-explicit-g0' : '-explicit-g0-o2')
      );
      assert.deepEqual(
        defaults.program.codeIdentity,
        disabled.program.codeIdentity,
        'Default and -g0 changed executable code'
      );
    }
  }
  for (const [index, fixture] of combinations.entries()) {
    const entry = report.combinations[index];
    await reopenProgram(fixture, entry.program);
    await reopenCombination(entry, fixture, report, output, read);
  }
  // Recheck the frozen bytes after running the official consumers as well.
  for (const receipt of frozen.values()) await read(receipt);
  assert.equal(report.counts.liveSourceFrames, liveFrames);
  return { programs, sourceUnits, liveFrames, reopenedFiles: reopened.size };
}

async function reopenCombination(entry, fixture, report, output, read) {
  const spec = fixture.runs[0],
    executions = entry.executions;
  command(
    executions.node.command,
    report.tools.node.path,
    ['--no-warnings', path.join(output, 'run-node.mjs'), entry.program.program.path],
    output,
    0,
    spec.stdin,
    fixture.feature === 'coverage'
      ? {
          DWARF_PROFILE_DIRECTORY: path.join(
            path.dirname(entry.program.program.path),
            'node-profile'
          )
        }
      : {}
  );
  assert.equal(executions.node.command.stdout, spec.stdout);
  assert.equal(executions.node.command.stderr, '');
  assert.equal(executions.chromium.result.exitCode, 0);
  assert(!executions.chromium.result.error);
  assert.equal(executions.chromium.result.stdout, spec.stdout);
  assert.equal(executions.chromium.result.stderr, '');
  assert.equal(
    executions.chromium.result.moduleBytes,
    entry.program.program.bytes,
    'Combined browser execution used another module payload size'
  );
  if (fixture.feature === 'simd') {
    const dump = replay(
      entry.instructions.command,
      report.tools.objdump.path,
      ['-d', entry.program.program.path],
      path.dirname(entry.program.program.path)
    );
    const opcodes = dump.stdout.split('\n').flatMap((line) => {
      const match = /^\s*[a-f0-9]+:\s+(?:[a-f0-9]{2}\s+)+\|\s*(\S+)/i.exec(line);
      return match && /^(?:v128|i8x16|i16x8|i32x4|i64x2|f32x4|f64x2)\./.test(match[1])
        ? [match[1]]
        : [];
    });
    assert(opcodes.includes('i32x4.add'), 'Combined debug/SIMD program lacks real vector addition');
    assert.deepEqual(entry.instructions.simdOpcodes, opcodes);
    for (const value of Object.values(executions)) {
      assert.deepEqual(value.profiles, []);
      assert.deepEqual(value.analysis, []);
    }
    return;
  }
  assert.equal(fixture.feature, 'coverage');
  assert.equal(entry.instrumentation.length, entry.program.units.length);
  for (const [index, unit] of entry.program.units.entries()) {
    const observed = entry.instrumentation[index];
    assert.deepEqual(observed.object, unit.object);
    const dump = replay(
      observed.command,
      report.tools.objdump.path,
      ['-d', unit.object.path],
      path.dirname(unit.object.path)
    );
    assert.deepEqual(
      observed.inspection,
      inspectCoverageObject(await read(unit.object), { mode: 'coverage' }, dump.stdout)
    );
  }
  for (const execution of Object.values(executions)) {
    assert.equal(execution.profiles.length, 1);
    assert.equal(execution.analysis.length, 1);
    const analysis = execution.analysis[0],
      note = entry.program.units[0].notes;
    same(analysis.note, note, 'Combined coverage used another notes file');
    assert.deepEqual(analysis.source, entry.program.units[0].source);
    same(analysis.profile, execution.profiles[0], 'Combined coverage profile copy changed');
    assert.equal(analysis.unit, fixture.coverageUnit.id);
    const directory = path.dirname(analysis.note.path);
    for (const [name, receipt] of [
      ['noteDump', analysis.note],
      ['profileDump', analysis.profile]
    ]) {
      try {
        const dump = replay(
          analysis.commands[name],
          report.tools.gcovDump.path,
          ['-l', receipt.path],
          directory
        );
        assert(dump.stdout.includes("version `B70 '"));
        assert.equal(dump.stderr, '');
      } catch (error) {
        throw new Error('Official gcov-dump rejected combined raw coverage: ' + error.message, {
          cause: error
        });
      }
    }
    command(
      analysis.commands.gcov,
      report.tools.gcov.path,
      ['--json-format', '--branch-probabilities', '--branch-counts', analysis.note.path],
      directory
    );
    assert.equal(analysis.commands.gcov.stderr, '');
    const recorded = JSON.parse((await read(analysis.json)).toString());
    assert.equal(recorded.data_file, analysis.note.path);
    assert.deepEqual(JSON.parse(gunzipSync(await read(analysis.compressedJson))), recorded);
    assert.deepEqual(
      analysis.counts,
      verifyGcovJson(
        recorded,
        fixture.coverageUnit,
        fixture.coverageExpected,
        1,
        analysis.source.path
      )
    );
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dwarf-gcov-verify-'));
    try {
      await fs.chmod(temporary, 0o700);
      const name = path.basename(note.path),
        copiedNote = path.join(temporary, name);
      await fs.writeFile(copiedNote, await read(note), {
        flag: 'wx',
        mode: 0o600
      });
      await fs.writeFile(
        path.join(temporary, name.replace(/\.gcno$/, '.gcda')),
        await read(analysis.profile),
        { flag: 'wx', mode: 0o600 }
      );
      const gcov = run(
        report.tools.gcov.path,
        ['--json-format', '--branch-probabilities', '--branch-counts', copiedNote],
        null,
        temporary
      );
      assert.equal(gcov.stderr, '');
      const outputs = (await fs.readdir(temporary)).filter((name) =>
        name.endsWith('.gcov.json.gz')
      );
      assert.equal(outputs.length, 1);
      const actual = JSON.parse(gunzipSync(await fs.readFile(path.join(temporary, outputs[0]))));
      assert.deepEqual(
        verifyGcovJson(
          actual,
          fixture.coverageUnit,
          fixture.coverageExpected,
          1,
          analysis.source.path
        ),
        analysis.counts
      );
      assert.deepEqual(
        { ...actual, data_file: recorded.data_file },
        recorded,
        'Raw combined coverage pair differs from retained JSON'
      );
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }
}

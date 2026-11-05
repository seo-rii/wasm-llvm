import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { debuggerControlSymbol, debuggerNativeCases, debuggerNativeCounts,
  debuggerNativeRunnerSource, debuggerProbeExports } from './test-debugger-native.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const identity = bytes => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
const content = value => ({ bytes: value.bytes, sha256: value.sha256 });

export function verifyDebuggerNativeReport(report) {
  assert.equal(report.kind, 'gcc-wasi-debugger-native-qualification');
  assert.equal(report.status, 'passed');
  assert.equal(report.host, 'native');
  assert.equal(report.target, 'wasm32-wasi');
  assert.equal(report.standard, 'gnu++26');
  assert.equal(report.inputsUnchanged, true);
  assert.deepEqual(report.counts, debuggerNativeCounts);
  assert.deepEqual(report.expectedCounts, debuggerNativeCounts);
  assert.equal(report.scope.testsActualDebuggerConnection, false, 'Native tests must not pretend to attach a debugger');
  assert.equal(report.profile.controlSymbol, debuggerControlSymbol);
  assert.equal(report.profile.automaticDebuggerDetection, false);
  assert.equal(report.profile.resumable, false);
  assert.equal(report.profile.connectedValue, -1);
  assert.equal(report.profile.disconnectedValue, 0);
  assert.deepEqual(report.cases.map(entry => entry.id), debuggerNativeCases.map(entry => entry.id));
  for (const [index, entry] of report.cases.entries()) {
    const fixture = debuggerNativeCases[index];
    assert.equal(entry.status, 'passed');
    assert.equal(entry.standard, 'gnu++26');
    assert.equal(entry.stdin, fixture.stdin);
    assert.equal(entry.expectedStdout, fixture.stdout);
    assert.equal(entry.expectedExitCode, fixture.exitCode);
    assert.equal(entry.expectedTrap, fixture.trap);
    assert.deepEqual(content(entry.source), identity(Buffer.from(fixture.source)));
    assert.equal(entry.observation.exitCode, fixture.exitCode);
    assert.equal(entry.observation.stdout, fixture.stdout);
    assert.equal(entry.observation.trapped, fixture.trap);
    if (fixture.trap) assert.match(entry.observation.stderr, /RuntimeError: unreachable/);
    else assert.equal(entry.observation.stderr, '');
  }
}

export async function reopenDebuggerQualification({ runtime, qualification, nativeBuild, compilerBuild, baseFiles }) {
  runtime = await fs.realpath(runtime);
  qualification = await fs.realpath(qualification);
  const reopened = new Map();
  async function read(file, expected) {
    const bytes = await fs.readFile(file), actual = identity(bytes);
    if (expected) assert.deepEqual(actual, content(expected), 'Changed debugger evidence: ' + file);
    if (reopened.has(file)) assert.deepEqual(actual, reopened.get(file), 'Input changed: ' + file);
    reopened.set(file, actual);
    return bytes;
  }
  const reportBytes = await read(qualification), report = JSON.parse(reportBytes);
  verifyDebuggerNativeReport(report);
  assert.deepEqual(await read(report.recipe.path, report.recipe), await read(path.join(here, 'test-debugger-native.mjs')));
  const buildFile = path.join(runtime, 'build.json'), buildBytes = await read(buildFile, report.buildReceipt), build = JSON.parse(buildBytes);
  assert.equal(await fs.realpath(report.buildReceipt.path), await fs.realpath(buildFile));
  assert.equal(build.kind, 'gcc-wasi-debugger-runtime-build');
  assert.equal(build.status, 'built-unverified');
  assert.equal(build.host, 'native');
  assert.equal(build.target, 'wasm32-wasi');
  assert.equal(build.inputsUnchanged, true);
  assert.deepEqual(build.gccSource, nativeBuild.gccSource);
  assert.deepEqual(build.gccSource, compilerBuild.gccSource);
  assert.equal(build.gccCommit, nativeBuild.gccCommit);
  const sourceLock = await read(path.join(here, 'sources.lock.json')), sources = JSON.parse(sourceLock);
  assert.deepEqual(content(build.sourceLock), identity(sourceLock));
  const lockBytes = await read(path.join(here, 'debugger-runtime.lock.json')), lock = JSON.parse(lockBytes);
  assert.deepEqual(content(build.debuggerLock), identity(lockBytes));
  assert.deepEqual(build.profile, lock.profile);
  assert.deepEqual(report.profile, lock.profile);
  assert.equal(lock.gccCommit, build.gccCommit);
  assert.deepEqual(content(build.source), lock.gccFiles['libstdc++-v3/src/c++26/debugging.cc']);
  assert.deepEqual(content(build.recipe), identity(await read(path.join(here, 'build-debugger-runtime.py'))));
  for (const input of [...build.inputs, ...report.inputs]) await read(input.path, input);
  for (const file of report.artifacts) await read(file.path, file);
  // These descriptors are mandatory even when a rewritten receipt omits them from inputs.
  for (const [group, names] of [[build.nativeCompiler, ['cc1', 'cc1plus', 'xgcc']],
    [build.tools, ['compiler', 'assembler', 'validator', 'objdump', 'ar', 'nm', 'linker', 'python']],
    [report.tools, ['compiler', 'assembler', 'linker', 'validator', 'node']]]) {
    assert.deepEqual(Object.keys(group).sort(), names.sort(), 'Incomplete debugger tool descriptors');
    for (const file of Object.values(group)) await read(file.path, file);
  }
  for (const name of ['cc1', 'cc1plus', 'xgcc'])
    assert.equal(build.nativeCompiler[name].sha256, nativeBuild.tools[name].sha256, 'Debugger compiler differs from base bundle');
  assert.deepEqual(build.tools.compiler, build.nativeCompiler.cc1plus);
  assert.deepEqual(report.tools.compiler, build.tools.compiler);
  for (const name of ['assembler', 'validator', 'linker']) assert.deepEqual(report.tools[name], build.tools[name]);
  assert.deepEqual(content(report.tools.node), identity(await read(process.execPath)));
  const assembler = JSON.parse(await read(build.assemblerBuild.path, build.assemblerBuild));
  assert.equal(assembler.component, 'wabt');
  assert.equal(assembler.role, 'wasm-object-assembler');
  assert.equal(assembler.host, 'native');
  assert.equal(assembler.inputsUnchanged, true);
  for (const name of ['repository', 'commit', 'version']) assert.equal(assembler[name], sources.wabt[name]);
  const wabtSource = { wabtCommit: sources.wabt.commit, patches: sources.wabt.patches ?? [],
    sourceDiffSha256: sources.wabt.sourceDiffSha256, submodules: sources.wabt.submodules };
  assert.deepEqual(assembler.source, wabtSource, 'Assembler differs from the pinned WABT source');
  assert.deepEqual(build.wabtSource, wabtSource);
  assert.deepEqual(assembler.assemblerArguments, ['-r', '--enable-annotations']);
  assert.deepEqual(Object.keys(assembler.recipes).sort(), ['build-wabt.sh', 'prepare-source.py', 'sources.lock.json'].sort());
  for (const [name, expected] of Object.entries(assembler.recipes))
    await read(path.join(here, name), expected);
  for (const [tool, name] of Object.entries({ assembler: 'wat2wasm', validator: 'wasm-validate', objdump: 'wasm-objdump' })) {
    assert.deepEqual(content(build.tools[tool]), content(assembler.files[name]), 'Debugger tool differs from the pinned WABT build');
    assert.equal(await fs.realpath(build.tools[tool].path), await fs.realpath(path.join(path.dirname(build.assemblerBuild.path), name)));
  }
  for (const [name, expected] of Object.entries(lock.sdk.files)) {
    assert.deepEqual(content(build.sdkFiles[name]), expected, 'Changed SDK debugger component pin');
    await read(build.sdkFiles[name].path, expected);
  }
  const sdkRoot = await fs.realpath(path.resolve(build.sdkFiles['bin/llvm-ar'].path, '../..'));
  for (const [tool, name] of Object.entries({ ar: 'bin/llvm-ar', nm: 'bin/llvm-nm', linker: 'bin/wasm-ld' })) {
    assert.deepEqual(content(build.tools[tool]), lock.sdk.files[name], 'Debugger tool differs from the pinned SDK');
    assert.equal(await fs.realpath(build.tools[tool].path), await fs.realpath(path.join(sdkRoot, name)));
  }
  for (const [name, file] of Object.entries(build.sdkFiles)) {
    assert(Object.hasOwn(lock.sdk.files, name), 'Unexpected SDK debugger component');
    assert.equal(await fs.realpath(file.path), await fs.realpath(path.join(sdkRoot, name)));
  }
  assert.deepEqual(content(build.source), identity(await read(build.source.path)));
  assert.deepEqual(build.baseGnuRuntime.unchanged, true);
  const baseGnu = JSON.parse(await read(build.baseGnuRuntime.build.path, build.baseGnuRuntime.build));
  assert.deepEqual(baseGnu.gccSource, nativeBuild.gccSource);
  assert.equal(baseGnu.debugger, false, 'Auxiliary component must preserve the original base runtime profile');
  for (const [name, file] of Object.entries(build.baseGnuRuntime.libraries)) {
    await read(file.path, file);
    assert(baseFiles?.has('lib/wasm32-wasi/' + name), 'Base bundle lacks a GNU archive');
    assert.deepEqual(content(file), identity(baseFiles.get('lib/wasm32-wasi/' + name)), 'Debugger and base bundle GNU archives differ');
  }
  for (const input of build.inputs) {
    const prefix = path.join(build.baseGnuRuntime.root, 'sysroot') + path.sep;
    if (input.path.startsWith(prefix)) {
      const name = path.relative(prefix, input.path).split(path.sep).join('/');
      assert(baseFiles.has(name), 'GNU input is absent from base bundle: ' + name);
      assert.deepEqual(content(input), identity(baseFiles.get(name)), 'GNU header/archive differs from base bundle: ' + name);
    }
  }
  for (const [name, file] of Object.entries(build.runtime)) {
    await read(file.path, file);
    assert(baseFiles.has('lib/wasm32-wasi/' + name));
    assert.deepEqual(content(file), identity(baseFiles.get('lib/wasm32-wasi/' + name)), 'Base WASI runtime archive differs');
  }
  assert.deepEqual(report.libraries, { ...build.runtime, ...build.baseGnuRuntime.libraries, ...build.libraries });
  assert.deepEqual(Object.keys(build.libraries).sort(), ['libstdc++debugger.a', 'libwasi-emulated-signal.a'].sort());
  for (const [name, file] of Object.entries(build.libraries)) {
    assert.equal(await fs.realpath(file.path), await fs.realpath(path.join(runtime, 'sysroot/lib/wasm32-wasi', name)));
    await read(file.path, file);
  }
  assert.deepEqual(content(build.libraries['libwasi-emulated-signal.a']), lock.sdk.files['share/wasi-sysroot/lib/wasm32-wasi/libwasi-emulated-signal.a']);
  const gnuRoot = await fs.realpath(build.baseGnuRuntime.root);
  const compilerRoot = await fs.realpath(path.dirname(build.nativeCompiler.cc1plus.path));
  for (const [name, file] of Object.entries(build.nativeCompiler))
    assert.equal(await fs.realpath(file.path), await fs.realpath(path.join(compilerRoot, name)));
  const gnuSysroot = path.join(gnuRoot, 'sysroot'), gnuInclude = path.join(gnuSysroot, 'include/c++', sources.gcc.version);
  const gccInclude = path.join(compilerRoot, 'include');
  const targetInclude = path.join(gnuRoot, 'target-headers/include/wasm32-wasi');
  const sdkInclude = path.join(sdkRoot, 'share/wasi-sysroot/include/wasm32-wasi');
  const includeDirectories = [gnuInclude, path.join(gnuInclude, 'wasm32-wasi'), gccInclude, targetInclude, sdkInclude];
  assert.deepEqual(build.includeDirectories, includeDirectories, 'Unknown or reordered debugger include directories');
  for (const directory of includeDirectories) {
    assert(!/\s/.test(directory), 'Unsupported whitespace in debugger include directories');
    assert.equal(await fs.realpath(directory), directory, 'Debugger include directory escapes its trusted root');
  }
  const args = ['-quiet', '-O0', '-g0', '-std=gnu++26', '-mno-simd128', '-fno-exceptions', '-fno-rtti',
    '-fno-threadsafe-statics', '-fuse-cxa-atexit', '-fdiagnostics-color=never', '-nostdinc',
    '-D__GCC_WASI_SINGLE_THREAD__=1', '-D_WASI_EMULATED_SIGNAL=1',
    ...build.includeDirectories.flatMap(directory => ['-isystem', directory])];
  assert.deepEqual(build.compilerArguments, args, 'Changed debugger compiler profile');
  const success = command => {
    assert.equal(command.status, 0, command.stderr);
    assert(!command.error && !command.signal, 'Interrupted qualification command');
  };
  for (const entry of report.cases) {
    const c = entry.commands;
    for (const name of ['dependencies', 'compile', 'assemble', 'link', 'validate']) success(c[name]);
    assert.equal(c.dependencies.command, build.tools.compiler.path);
    assert.deepEqual(c.dependencies.argv, [...args, '-M', '-MF', entry.dependencies.path,
      '-MT', 'main.o', entry.source.path, '-o', '/dev/null']);
    assert.equal(c.compile.command, build.tools.compiler.path);
    assert.deepEqual(c.compile.argv, [...args, entry.source.path, '-o', entry.assembly.path]);
    assert.equal(c.assemble.command, build.tools.assembler.path);
    assert.deepEqual(c.assemble.argv, ['-r', '--enable-annotations', entry.assembly.path, '-o', entry.object.path]);
    const lib = name => report.libraries[name].path;
    assert.equal(c.link.command, build.tools.linker.path);
    assert.deepEqual(c.link.argv, ['--fatal-warnings', '-m', 'wasm32', '-e', '_start', '-o', entry.program.path,
      ...debuggerProbeExports.map(name => '--export=' + name), lib('crt1-command.o'), entry.object.path,
      lib('libstdc++debugger.a'), lib('libwasi-emulated-signal.a'), lib('libstdc++.a'),
      lib('libc-printscan-long-double.a'), lib('libm.a'), lib('libc.a'), lib('libclang_rt.builtins-wasm32.a')]);
    assert.equal(c.validate.command, build.tools.validator.path);
    assert.deepEqual(c.validate.argv, [entry.program.path]);
    assert.deepEqual(await read(entry.source.path, entry.source), Buffer.from(debuggerNativeCases.find(fixture => fixture.id === entry.id).source));
  }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'gcc-debugger-gate-'));
  await fs.chmod(temporary, 0o700);
  const executed = [], dependencyChecks = [];
  try {
    function run(command, argv, input) {
      const result = spawnSync(command, argv, { cwd: temporary, input, encoding: 'utf8', timeout: 120000,
        maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', TMPDIR: temporary } });
      assert.ifError(result.error); assert.equal(result.signal, null);
      return result;
    }
    async function checkDependencies(source, declaredHeaders, label) {
      const dependencies = path.join(temporary, label + '.d');
      const result = run(build.tools.compiler.path, [...args, '-M', '-MF', dependencies,
        '-MT', 'gate.o', source, '-o', '/dev/null']);
      assert.equal(result.status, 0, result.stderr);
      const text = (await fs.readFile(dependencies, 'utf8')).replace(/\\\r?\n/g, ' ');
      assert(text.startsWith('gate.o:'), 'Invalid GCC debugger dependency output');
      const names = [...new Set(text.slice('gate.o:'.length).trim().split(/\s+/))].sort();
      assert(names.includes(source), 'GCC debugger dependency output omits its source');
      const actual = new Map();
      for (const name of names.filter(name => name !== source)) {
        const filename = await fs.realpath(name);
        assert.equal(filename, name, 'Debugger header escapes its trusted root');
        let packaged, pinned;
        const under = root => filename.startsWith(root + path.sep) ? path.relative(root, filename).split(path.sep).join('/') : null;
        const gnu = under(gnuSysroot), gcc = under(gccInclude), target = under(targetInclude), sdk = under(sdkInclude);
        if (gnu) packaged = gnu;
        else if (gcc) {
          packaged = 'lib/gcc/wasm32-wasi/' + sources.gcc.version + '/include/' + gcc;
          assert(compilerBuild.files['resource-include/' + gcc], 'Unpackaged GCC resource header: ' + gcc);
          assert(baseFiles.has(packaged), 'GCC resource header is absent from base bundle: ' + gcc);
          assert.deepEqual(content(compilerBuild.files['resource-include/' + gcc]), identity(baseFiles.get(packaged)), 'GCC resource header differs from its browser compiler build');
        } else if (target || sdk) {
          const relative = target || sdk;
          packaged = 'include/wasm32-wasi/' + relative;
          if (sdk) pinned = lock.sdk.files['share/wasi-sysroot/include/wasm32-wasi/' + relative];
        } else assert.fail('Untrusted debugger header: ' + filename);
        assert(baseFiles.has(packaged) || pinned, 'Debugger header is absent from base bundle: ' + packaged);
        const bytes = await read(filename, pinned);
        if (baseFiles.has(packaged)) assert.deepEqual(identity(bytes), identity(baseFiles.get(packaged)), 'Debugger header differs from base bundle: ' + packaged);
        actual.set(filename, identity(bytes));
      }
      const declared = new Map();
      for (const header of declaredHeaders) {
        assert(!declared.has(header.path), 'Duplicate declared debugger header');
        declared.set(header.path, content(header));
        await read(header.path, header);
      }
      assert.deepEqual(declared, actual, 'Incomplete or changed debugger dependency inventory: ' + label);
      dependencyChecks.push({ source, headers: actual.size, independentlyGenerated: true });
    }
    // Recompute all dependencies before any independent compile. Self-declared input lists are insufficient.
    await checkDependencies(build.source.path, build.headers, 'gnu-debugging');
    for (const entry of report.cases) await checkDependencies(entry.source.path, entry.headers, entry.id);
    // Rebuild the pinned GNU unit independently: source/path claims alone do not admit an archive.
    const assembly = path.join(temporary, 'debugging.wat'), object = path.join(temporary, 'debugging.o'), archive = path.join(temporary, 'libstdc++debugger.a');
    for (const [command, argv] of [[build.tools.compiler.path, [...args, build.source.path, '-o', assembly]],
      [build.tools.assembler.path, ['-r', '--enable-annotations', assembly, '-o', object]],
      [build.tools.ar.path, ['rcs', archive, object]]]) assert.equal(run(command, argv).status, 0);
    assert.deepEqual(identity(await fs.readFile(object)), content(build.object), 'Rebuilt GNU debugger object differs');
    assert.deepEqual(identity(await fs.readFile(archive)), content(build.libraries['libstdc++debugger.a']), 'Rebuilt GNU debugger archive differs');
    const runner = path.join(temporary, 'run-wasi.mjs');
    await fs.writeFile(runner, debuggerNativeRunnerSource, { flag: 'wx', mode: 0o600 });
    for (const [index, entry] of report.cases.entries()) {
      const fixture = debuggerNativeCases[index], directory = path.join(temporary, fixture.id);
      await fs.mkdir(directory);
      const source = path.join(directory, 'main.cpp'), assembly = path.join(directory, 'main.wat'),
        object = path.join(directory, 'main.o'), program = path.join(directory, 'program.wasm');
      await fs.writeFile(source, fixture.source, { flag: 'wx', mode: 0o600 });
      assert.equal(run(build.tools.compiler.path, [...args, source, '-o', assembly]).status, 0);
      assert.equal(run(build.tools.assembler.path, ['-r', '--enable-annotations', assembly, '-o', object]).status, 0);
      const replaced = new Map([[entry.object.path, object], [entry.program.path, program]]);
      assert.equal(run(build.tools.linker.path, entry.commands.link.argv.map(value => replaced.get(value) ?? value)).status, 0);
      const result = run(process.execPath, ['--disable-warning=ExperimentalWarning', runner, program], fixture.stdin);
      assert.equal(result.status, fixture.exitCode, result.stderr);
      assert.equal(result.stdout, fixture.stdout);
      if (fixture.trap) assert.match(result.stderr, /RuntimeError: unreachable/);
      else assert.equal(result.stderr, '');
      const retained = run(process.execPath, ['--disable-warning=ExperimentalWarning', runner, entry.program.path], fixture.stdin);
      assert.equal(retained.status, fixture.exitCode, retained.stderr);
      assert.equal(retained.stdout, fixture.stdout);
      if (fixture.trap) assert.match(retained.stderr, /RuntimeError: unreachable/);
      else assert.equal(retained.stderr, '');
      executed.push({ id: fixture.id, exitCode: result.status, stdout: result.stdout, trapped: fixture.trap,
        independentlyCompiledProgram: identity(await fs.readFile(program)), retainedProgram: content(entry.program),
        retainedProgramExitCode: retained.status,
        // GCC's local assembly ordering need not be reproducible; both genuine compilations execute.
        identicalProgramBytes: identity(await fs.readFile(program)).sha256 === entry.program.sha256 });
    }
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  for (const [file, expected] of reopened) assert.deepEqual(identity(await fs.readFile(file)), expected, 'Evidence changed during admission');
  return { status: 'passed', build: { path: buildFile, ...identity(buildBytes) },
    qualification: { path: qualification, ...identity(reportBytes) }, independentGnuRebuild: true,
    independentlyReexecutedCases: executed, dependencyChecks, reopenedFiles: reopened.size,
    reopenedInputs: [...reopened].map(([path, file]) => ({ path, ...file })), inputsUnchanged: true };
}

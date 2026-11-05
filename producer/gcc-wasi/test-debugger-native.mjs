#!/usr/bin/env node
// Real GCC -> WABT -> wasm-ld -> Node WASI. Debugger attachment is qualified separately.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const debuggerControlSymbol = '_ZN9__gnu_cxx30debugger_signal_for_breakpointE';
export const debuggerProbeExports = [
  debuggerControlSymbol, 'debugger_probe_present',
  'debugger_probe_conditional', 'debugger_probe_breakpoint'
];
export const debuggerNativeCounts = { total: 5, normal: 2, traps: 3 };
const prelude = `#include <debugging>
#include <cstdio>
#include <type_traits>
static_assert(__cpp_lib_debugging == 202403L);
static_assert(std::is_same_v<decltype(std::is_debugger_present()), bool>);
static_assert(noexcept(std::is_debugger_present()));
static_assert(noexcept(std::breakpoint()));
static_assert(noexcept(std::breakpoint_if_debugging()));
namespace __gnu_cxx { extern volatile int debugger_signal_for_breakpoint; }
extern "C" int debugger_probe_present() { return std::is_debugger_present(); }
extern "C" void debugger_probe_conditional() { std::breakpoint_if_debugging(); }
extern "C" void debugger_probe_breakpoint() { std::breakpoint(); }
`;
export const debuggerNativeCases = [
  {
    id: 'disconnected-stdin', stdin: '41\n', stdout: 'present=0 value=42 conditional=returned\n',
    trap: false, exitCode: 0,
    source: prelude + `int main() {
  int value = 0; if (std::scanf("%d", &value) != 1) return 2;
  if (__gnu_cxx::debugger_signal_for_breakpoint != 0 || std::is_debugger_present()) return 3;
  std::breakpoint_if_debugging();
  std::printf("present=%d value=%d conditional=returned\\n", std::is_debugger_present(), value + 1);
}
`
  },
  {
    id: 'registration-transitions', stdin: '', stdout: '0 1 0\n', trap: false, exitCode: 0,
    source: prelude + `int main() {
  __gnu_cxx::debugger_signal_for_breakpoint = 0;
  const int before = std::is_debugger_present(); std::breakpoint_if_debugging();
  __gnu_cxx::debugger_signal_for_breakpoint = -1;
  const int registered = std::is_debugger_present();
  __gnu_cxx::debugger_signal_for_breakpoint = 0;
  const int after = std::is_debugger_present(); std::breakpoint_if_debugging();
  std::printf("%d %d %d\\n", before, registered, after);
  return before != 0 || registered != 1 || after != 0;
}
`
  },
  {
    id: 'breakpoint-unregistered-trap', stdin: '', stdout: 'present=0 before breakpoint\n',
    trap: true, exitCode: 1,
    source: prelude + `int main() {
  std::printf("present=%d before breakpoint\\n", std::is_debugger_present()); std::fflush(stdout);
  std::breakpoint(); std::puts("unexpected continuation"); return 9;
}
`
  },
  {
    id: 'breakpoint-registered-trap', stdin: '', stdout: 'present=1 before breakpoint\n',
    trap: true, exitCode: 1,
    source: prelude + `int main() {
  __gnu_cxx::debugger_signal_for_breakpoint = -1;
  std::printf("present=%d before breakpoint\\n", std::is_debugger_present()); std::fflush(stdout);
  std::breakpoint(); std::puts("unexpected continuation"); return 9;
}
`
  },
  {
    id: 'conditional-registered-trap', stdin: '', stdout: 'present=1 before conditional\n',
    trap: true, exitCode: 1,
    source: prelude + `int main() {
  __gnu_cxx::debugger_signal_for_breakpoint = -1;
  std::printf("present=%d before conditional\\n", std::is_debugger_present()); std::fflush(stdout);
  std::breakpoint_if_debugging(); std::puts("unexpected continuation"); return 9;
}
`
  }
];
export const debuggerNativeRunnerSource = `import { WASI } from 'node:wasi';
import { readFile } from 'node:fs/promises';
const wasi = new WASI({version:'preview1', args:['program'], env:{}, preopens:{}, returnOnExit:true});
const module = await WebAssembly.compile(await readFile(process.argv[2]));
const instance = await WebAssembly.instantiate(module, {wasi_snapshot_preview1:wasi.wasiImport});
process.exitCode = wasi.start(instance);
`;

const content = receipt => ({ bytes: receipt.bytes, sha256: receipt.sha256 });
const digest = bytes => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });

export async function qualifyDebuggerNative(runtime, output) {
  process.umask(0o077);
  runtime = await fs.realpath(runtime);
  output = path.resolve(output);
  assert(output !== runtime && !output.startsWith(runtime + path.sep), 'Output must be outside immutable runtime inputs');
  assert(!/\s/.test(output), 'GCC dependency paths must not contain whitespace');
  await fs.mkdir(output, { recursive: false, mode: 0o700 });
  const inputs = new Map();
  const artifacts = new Map();
  const report = {
    schemaVersion: 1, kind: 'gcc-wasi-debugger-native-qualification', status: 'running',
    host: 'native', target: 'wasm32-wasi', standard: 'gnu++26',
    scope: { compiler: 'gcc', execution: 'node-wasi', debuggerAttached: false,
      testsDebuggerRegistration: true, testsActualDebuggerConnection: false },
    startedAt: new Date().toISOString(), expectedCounts: debuggerNativeCounts,
    cases: [], commands: []
  };
  const save = () => fs.writeFile(path.join(output, 'qualification.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const identify = async file => ({ path: path.resolve(file), ...digest(await fs.readFile(file)) });
  async function freeze(file, expected) {
    const receipt = await identify(file);
    if (expected) assert.deepEqual(content(receipt), content(expected), 'Changed debugger input ' + file);
    if (inputs.has(receipt.path)) assert.deepEqual(receipt, inputs.get(receipt.path), 'Input changed during qualification');
    inputs.set(receipt.path, receipt);
    return receipt;
  }
  async function artifact(file) {
    const receipt = await identify(file);
    artifacts.set(receipt.path, receipt);
    return receipt;
  }
  async function write(file, data) {
    await fs.writeFile(file, data, { flag: 'wx', mode: 0o600 });
    return artifact(file);
  }
  function run(command, argv, cwd, stdin = null) {
    const value = spawnSync(command, argv, { cwd, input: stdin ?? undefined, encoding: 'utf8',
      timeout: 120000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C', TMPDIR: output, TMP: output, TEMP: output } });
    const result = { command, argv, cwd, stdin, status: value.status, signal: value.signal,
      stdout: value.stdout || '', stderr: value.stderr || '', ...(value.error ? { error: value.error.message } : {}) };
    report.commands.push(result);
    return result;
  }
  const success = result => {
    assert.equal(result.status, 0, result.stderr || result.error);
    assert.equal(result.signal, null);
    assert(!result.error);
    return result;
  };
  try {
    report.recipe = await freeze(fileURLToPath(import.meta.url));
    report.buildReceipt = await freeze(path.join(runtime, 'build.json'));
    const build = JSON.parse(await fs.readFile(report.buildReceipt.path, 'utf8'));
    assert.equal(build.kind, 'gcc-wasi-debugger-runtime-build');
    assert.equal(build.status, 'built-unverified');
    assert.equal(build.inputsUnchanged, true);
    for (const input of build.inputs) await freeze(input.path, input);
    for (const library of Object.values(build.libraries)) await freeze(library.path, library);
    assert.equal(build.profile.automaticDebuggerDetection, false);
    assert.equal(build.profile.controlSymbol, debuggerControlSymbol);
    report.profile = build.profile;
    report.gccCommit = build.gccCommit;
    report.tools = {};
    for (const name of ['compiler', 'assembler', 'linker', 'validator'])
      report.tools[name] = await freeze(build.tools[name].path, build.tools[name]);
    report.tools.node = await freeze(process.execPath);
    report.libraries = {
      ...build.runtime, ...build.baseGnuRuntime.libraries, ...build.libraries
    };
    for (const library of Object.values(report.libraries)) await freeze(library.path, library);
    const runner = path.join(output, 'run-wasi.mjs');
    report.runner = await write(runner, debuggerNativeRunnerSource);
    for (const fixture of debuggerNativeCases) {
      const directory = path.join(output, fixture.id);
      await fs.mkdir(directory, { mode: 0o700 });
      const source = path.join(directory, 'main.cpp'), wat = path.join(directory, 'main.wat');
      const object = path.join(directory, 'main.o'), program = path.join(directory, 'program.wasm');
      const dependencies = path.join(directory, 'main.d');
      const entry = { id: fixture.id, status: 'running', standard: 'gnu++26',
        stdin: fixture.stdin, expectedStdout: fixture.stdout, expectedExitCode: fixture.exitCode,
        expectedTrap: fixture.trap, source: await write(source, fixture.source), commands: {} };
      report.cases.push(entry);
      entry.commands.dependencies = success(run(report.tools.compiler.path,
        [...build.compilerArguments, '-M', '-MF', dependencies, '-MT', 'main.o', source, '-o', '/dev/null'], directory));
      entry.dependencies = await artifact(dependencies);
      const dependencyText = (await fs.readFile(dependencies, 'utf8')).replace(/\\\n/g, ' ');
      const headerNames = [...new Set(dependencyText.slice(dependencyText.indexOf(':') + 1).trim().split(/\s+/))]
        .filter(name => name !== source).sort();
      entry.headers = [];
      for (const file of headerNames) entry.headers.push(await freeze(file));
      entry.commands.compile = success(run(report.tools.compiler.path,
        [...build.compilerArguments, source, '-o', wat], directory));
      entry.assembly = await artifact(wat);
      entry.commands.assemble = success(run(report.tools.assembler.path,
        ['-r', '--enable-annotations', wat, '-o', object], directory));
      entry.object = await artifact(object);
      const lib = name => report.libraries[name].path;
      entry.commands.link = success(run(report.tools.linker.path, [
        '--fatal-warnings', '-m', 'wasm32', '-e', '_start', '-o', program,
        ...debuggerProbeExports.map(name => '--export=' + name),
        lib('crt1-command.o'), object, lib('libstdc++debugger.a'),
        lib('libwasi-emulated-signal.a'), lib('libstdc++.a'),
        lib('libc-printscan-long-double.a'), lib('libm.a'), lib('libc.a'),
        lib('libclang_rt.builtins-wasm32.a')
      ], directory));
      entry.program = await artifact(program);
      entry.commands.validate = success(run(report.tools.validator.path, [program], directory));
      const module = await WebAssembly.compile(await fs.readFile(program));
      entry.imports = WebAssembly.Module.imports(module);
      entry.exports = WebAssembly.Module.exports(module);
      assert(entry.imports.every(value => value.module === 'wasi_snapshot_preview1' && value.kind === 'function'));
      assert(entry.exports.some(value => value.name === 'memory' && value.kind === 'memory'));
      for (const name of debuggerProbeExports) assert(entry.exports.some(value => value.name === name));
      const observation = run(process.execPath, ['--disable-warning=ExperimentalWarning', runner, program], directory, fixture.stdin);
      entry.commands.execute = observation;
      assert.equal(observation.signal, null);
      assert(!observation.error);
      assert.equal(observation.status, fixture.exitCode, observation.stderr);
      assert.equal(observation.stdout, fixture.stdout);
      if (fixture.trap) {
        assert.match(observation.stderr, /RuntimeError: unreachable/);
        assert.match(observation.stderr, /wasm-function\[/);
        assert(!observation.stdout.includes('unexpected continuation'));
      } else assert.equal(observation.stderr, '');
      entry.observation = { exitCode: observation.status, stdout: observation.stdout,
        stderr: observation.stderr, trapped: fixture.trap };
      entry.status = 'passed';
      await save();
    }
    report.counts = { total: report.cases.length,
      normal: report.cases.filter(entry => !entry.expectedTrap).length,
      traps: report.cases.filter(entry => entry.expectedTrap).length };
    assert.deepEqual(report.counts, debuggerNativeCounts);
    for (const input of inputs.values()) assert.deepEqual(await identify(input.path), input, 'Qualification input changed');
    for (const product of artifacts.values()) assert.deepEqual(await identify(product.path), product, 'Qualification output changed');
    report.inputs = [...inputs.values()].sort((a, b) => a.path.localeCompare(b.path));
    report.artifacts = [...artifacts.values()].sort((a, b) => a.path.localeCompare(b.path));
    report.inputsUnchanged = true;
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = error.stack || String(error);
    process.exitCode = 1;
  } finally {
    report.completedAt = new Date().toISOString();
    await save();
    console.log(JSON.stringify({ status: report.status, counts: report.counts,
      report: path.join(output, 'qualification.json'), ...(report.error ? { error: report.error } : {}) }));
  }
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const options = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    assert(['--runtime', '--output'].includes(process.argv[index]));
    assert(process.argv[index + 1] && !options[process.argv[index]]);
    options[process.argv[index]] = process.argv[index + 1];
  }
  assert(options['--runtime'] && options['--output'], 'Usage: node test-debugger-native.mjs --runtime DIR --output NEW_DIR');
  await qualifyDebuggerNative(options['--runtime'], options['--output']);
}

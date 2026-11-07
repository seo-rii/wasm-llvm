import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cases, disabledCases, diagnosticCases, relaxedProfiles } from './simd-relaxed-fixtures.mjs';
import { assertRelaxedOutput, verifyRelaxedInstructions } from './simd-relaxed-inspect.mjs';
import { inspectTargetFeatures } from './inspect-target-features.mjs';

export const identity = bytes => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
const sourceIdentity = source => identity(Buffer.from(source));

// GCC emits a prefix of complete, single-line module imports. Hash-table
// iteration may change their order. Preserve each declaration verbatim,
// including names, types, annotations and duplicates, and every other byte.
function normalizeImportOrder(assembly) {
  assert(typeof assembly === 'string' || Buffer.isBuffer(assembly));
  assert(Buffer.byteLength(assembly) <= 16 * 1024 * 1024, 'Oversized GCC assembly');
  const text = typeof assembly === 'string' ? assembly : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(assembly);
  assert.match(text, /^\(module[\s)]/u, 'Expected GCC module');
  const lines = text.split('\n'), positions = [], imports = [];
  let depth = 0, comments = 0, quoted = false, roots = 0, prefixEnded = false;
  for (const [index, line] of lines.entries()) {
    const atModule = depth === 1 && comments === 0 && !quoted;
    const declaration = atModule && /^\s*\(import(?:\s|\()/u.test(line);
    if (declaration) {
      assert(!prefixEnded && line.startsWith('  (import '), 'Import outside the supported GCC declaration prefix');
    } else if (atModule && /^\s*\((?!;)/u.test(line)) prefixEnded = true;
    let declarationEnd = -1;
    for (let cursor = 0; cursor < line.length; cursor++) {
      if (comments) {
        if (line.startsWith('(;', cursor)) { comments++; cursor++; }
        else if (line.startsWith(';)', cursor)) { comments--; cursor++; }
        continue;
      }
      if (quoted) {
        if (line[cursor] === '\\') cursor++;
        else if (line[cursor] === '"') quoted = false;
        continue;
      }
      if (line.startsWith(';;', cursor)) break;
      if (line.startsWith('(;', cursor)) { comments++; cursor++; continue; }
      if (line[cursor] === '"') { quoted = true; continue; }
      if (line[cursor] === '(') { if (!depth) roots++; depth++; }
      if (line[cursor] === ')') {
        assert(depth > 0, 'Unbalanced GCC assembly'); depth--;
        if (declaration && depth === 1 && declarationEnd < 0) declarationEnd = cursor + 1;
      }
    }
    if (declaration) {
      assert(depth === 1 && !quoted && !comments && declarationEnd > 0 && /^\s*$/u.test(line.slice(declarationEnd)),
        'Only complete single-line import declarations may be reordered');
      positions.push(index); imports.push(line);
    }
  }
  assert.equal(depth, 0, 'Unclosed GCC module'); assert.equal(comments, 0, 'Unclosed WAT comment');
  assert.equal(quoted, false, 'Unclosed WAT string'); assert.equal(roots, 1, 'Expected exactly one module');
  imports.sort();
  for (const [index, position] of positions.entries()) lines[position] = imports[index];
  return lines.join('\n');
}

export function assertRelaxedAssemblyReplay(original, fresh) {
  assert.equal(normalizeImportOrder(fresh), normalizeImportOrder(original),
    'Recompiled GCC assembly changed beyond complete import declaration order');
}

export const relaxedWasiRunner = `import { WASI } from 'node:wasi';
import { readFile } from 'node:fs/promises';
const wasi = new WASI({version:'preview1',args:['program'],env:{},returnOnExit:true});
const module = await WebAssembly.compile(await readFile(process.argv[2]));
process.exitCode = wasi.start(await WebAssembly.instantiate(module,{wasi_snapshot_preview1:wasi.wasiImport}));
`;
export function relaxedCompilerArgs(fixture, input, assembly, headerRoots, profile) {
  const flags = profile === 'default' ? [] : profile === 'relaxed-only' ? ['-mrelaxed-simd'] : profile === 'simd-only' ? ['-msimd128'] : profile === 'disabled-relaxed' ? ['-msimd128', '-mno-relaxed-simd']
    : fixture.request.relaxedSimd ? ['-msimd128', '-mrelaxed-simd'] : [fixture.request.simd ? '-msimd128' : '-mno-simd128', '-mno-relaxed-simd'];
  return ['-quiet', `-O${fixture.request.optimization}`, `-std=${fixture.request.standard}`, '-fdiagnostics-color=never', '-Werror=attributes', '-Werror=pragmas',
    '-D__GCC_WASI_SINGLE_THREAD__=1', '-nostdinc', '-isystem', headerRoots.gcc, '-isystem', path.join(headerRoots.target, 'wasm32-wasi'),
    ...(fixture.request.language === 'cpp' ? ['-fno-exceptions', '-fno-rtti'] : ['-Werror=implicit-function-declaration']), ...flags, input, '-o', assembly];
}
export function relaxedExecutions() {
  return [...cases, ...disabledCases].map(fixture => ({ fixture, profile: 'explicit', id: fixture.id }))
    .concat(disabledCases.filter(fixture => !fixture.request.simd).map(fixture => ({ fixture, profile: 'default', id: fixture.id + '-default' })));
}
export function verifyRelaxedSimdQualificationOptions(patches, options) {
  if (!patches.some(patch => patch.path === 'patches/0022-relaxed-simd.patch')) return;
  for (const key of ['simdRelaxedQualification', 'simdHeaderQualification', 'simdConversionsQualification', 'simdSaturatingQualification', 'simdExtendedQualification', 'simdQualification', 'vectorAbiQualification', 'nativeLinker'])
    assert(options[key], 'Relaxed SIMD compiler requires ' + key);
}
export function verifyRelaxedSimdHeaderInstallation({ source, installed, browser, packaged, licenses, packagedLicenses }) {
  assert(Buffer.isBuffer(source) && source.length > 1000, 'Missing relaxed SIMD source header');
  for (const [stage, bytes] of Object.entries({ installed, browser, packaged })) {
    assert(Buffer.isBuffer(bytes), 'Missing ' + stage + ' relaxed SIMD header');
    assert.deepEqual(identity(bytes), identity(source), 'Changed ' + stage + ' relaxed SIMD header');
  }
  for (const profile of relaxedProfiles) assert(source.toString().includes(profile.name + ' ('), 'Missing relaxed header API ' + profile.name);
  assert.match(source.toString(), /GPL-3\.0-or-later WITH GCC-exception-3\.1/u);
  for (const [name, minimum] of [['COPYING3', 30000], ['COPYING.RUNTIME', 3000]]) {
    assert(Buffer.isBuffer(licenses[name]) && licenses[name].length > minimum, 'Missing full ' + name);
    assert.deepEqual(identity(packagedLicenses[name]), identity(licenses[name]), 'Changed packaged ' + name);
  }
}
function commandPassed(command, tool) {
  assert.equal(command.command, tool); assert.equal(command.status, 0, command.stderr); assert.equal(command.signal, null); assert(!command.error);
}
function runtimePaths(report) {
  const library = path.resolve(report.headerRoots.target, '../lib/wasm32-wasi');
  return { library, builtins: path.resolve(report.toolPaths.linker, '../../lib/clang/22/lib/wasm32-unknown-wasi/libclang_rt.builtins.a') };
}
export function verifyRelaxedSimdQualification(report, expected) {
  assert.equal(report.kind, 'gcc-wasi-native-simd-relaxed-qualification'); assert.equal(report.status, 'passed'); assert.equal(report.inputsUnchanged, true);
  assert.deepEqual(expected.cases, cases); assert.deepEqual(expected.disabledCases, disabledCases); assert.deepEqual(expected.diagnosticCases, diagnosticCases);
  for (const key of ['sourcePath', 'gccSource', 'sourceLock', 'nativeBuild', 'sourceRecipe', 'buildRecipe', 'featureRecipe', 'targetSource', 'tools', 'headerRoots', 'headers', 'runtime', 'publicHeader', 'fixtures', 'testRecipe', 'inspectionRecipe', 'gateRecipe'])
    assert.deepEqual(report[key], expected[key], 'Relaxed receipt has stale ' + key);
  assert(path.isAbsolute(report.sourcePath), 'Missing absolute qualified GCC source');
  assert.deepEqual(Object.keys(report.toolPaths).sort(), ['assembler', 'gcc', 'gccCpp', 'linker', 'node', 'objdump', 'validator']);
  assert.deepEqual(Object.keys(report.headerRoots).sort(), ['gcc', 'target']);
  assert.deepEqual(Object.keys(report.runtime).sort(), ['crt1-command.o', 'libc.a', 'libclang_rt.builtins-wasm32.a', 'libm.a']);
  assert.deepEqual(report.publicHeader.source, report.publicHeader.installed);
  assert.deepEqual(report.executionRecipe, sourceIdentity(relaxedWasiRunner));
  assert.deepEqual(report.cases.map(entry => entry.id), [...cases, ...disabledCases].map(fixture => fixture.id));
  assert.deepEqual(report.defaultControls.map(entry => entry.id), relaxedExecutions().filter(item => item.profile === 'default').map(item => item.id));
  assert.deepEqual(report.diagnostics.map(entry => entry.id), diagnosticCases.map(fixture => fixture.id));
  const { library, builtins } = runtimePaths(report);
  for (const { fixture, profile, id } of relaxedExecutions()) {
    const entry = [...report.cases, ...report.defaultControls].find(value => value.id === id);
    assert.equal(entry.status, 'passed'); assert.equal(entry.fixture, fixture.id); assert.equal(entry.profile, profile);
    assert.deepEqual(entry.source, sourceIdentity(fixture.request.code)); assert.deepEqual(entry.fixtureValue, sourceIdentity(JSON.stringify(fixture)));
    assert.equal(entry.stdin, fixture.stdin); assertRelaxedOutput(fixture, entry.stdout);
    const commands = entry.commands; assert.equal(commands.length, 5);
    for (const [index, tool] of ['gcc' + (fixture.request.language === 'cpp' ? 'Cpp' : ''), 'assembler', 'objdump', 'linker', 'node'].entries()) commandPassed(commands[index], report.toolPaths[tool]);
    const source = commands[0].argv.at(-3), base = path.dirname(source), assembly = path.join(base, 'main.wat'), object = path.join(base, 'main.o'), program = path.join(base, 'main.wasm');
    assert.deepEqual(commands[0].argv, relaxedCompilerArgs(fixture, source, assembly, report.headerRoots, profile));
    assert.deepEqual(commands[1].argv, ['-r', '--enable-annotations', ...(fixture.request.relaxedSimd ? ['--enable-relaxed-simd'] : []), assembly, '-o', object]);
    assert.deepEqual(commands[2].argv, ['-d', object]);
    assert.deepEqual(entry.decoded, verifyRelaxedInstructions(fixture, commands[2].stdout));
    assert.deepEqual(commands[3].argv, ['--fatal-warnings', '-m', 'wasm32', '-e', '_start', '-o', program, path.join(library, 'crt1-command.o'), '-L' + library, object, '-lm', '-lc', builtins]);
    assert.deepEqual(commands[4].argv, ['--no-warnings', path.join(path.dirname(base), 'run-wasi.mjs'), program]);
    assertRelaxedOutput(fixture, commands[4].stdout); assert.equal(commands[4].stderr, '');
    assert.equal(entry.features['relaxed-simd'], fixture.request.relaxedSimd ? '+' : undefined);
    if (fixture.request.simd) assert.equal(entry.features.simd128, '+');
    assert(entry.imports.every(value => value.module === 'wasi_snapshot_preview1' && value.kind === 'function'));
    assert(entry.exports.some(value => value.name === '_start' && value.kind === 'function'));
    assert(entry.exports.some(value => value.name === 'memory' && value.kind === 'memory'));
    const validation = entry.relaxedDisabledValidation;
    assert.equal(validation.command, report.toolPaths.validator); assert.deepEqual(validation.argv, [program]);
    assert.equal(validation.status, fixture.request.relaxedSimd ? 1 : 0); assert.equal(validation.signal, null); assert(!validation.error);
  }
  for (const fixture of diagnosticCases) {
    const entry = report.diagnostics.find(value => value.id === fixture.id), command = entry.command;
    assert.equal(entry.profile, fixture.profile); assert.deepEqual(entry.source, sourceIdentity(fixture.request.code)); assert.deepEqual(entry.fixtureValue, sourceIdentity(JSON.stringify(fixture)));
    assert.equal(command.command, report.toolPaths[fixture.request.language === 'cpp' ? 'gccCpp' : 'gcc']);
    assert.deepEqual(command.argv, relaxedCompilerArgs(fixture, command.argv.at(-3), command.argv.at(-1), report.headerRoots, fixture.profile));
    assert.equal(command.status, 1); assert.equal(command.signal, null); assert(!command.error); assert.match(command.stderr, new RegExp(fixture.diagnosticPattern));
    assert.equal(entry.emittedRelaxed, false);
  }
}

export async function reopenRelaxedSimdQualification(report, reportFile, expected) {
  verifyRelaxedSimdQualification(report, expected);
  const root = path.dirname(reportFile);
  const captured = async (file, receipt) => { const bytes = await fs.readFile(file); assert.deepEqual(identity(bytes), receipt, 'Changed relaxed input/artifact: ' + file); return bytes; };
  const here = path.dirname(fileURLToPath(import.meta.url));
  const run = (tool, argv, input, timeout = 120000) => {
    const result = spawnSync(tool, argv, { cwd: root, input, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
    const failure = JSON.stringify({ command: tool, argv, status: result.status, signal: result.signal, error: result.error?.message, stderr: result.stderr });
    assert(!result.error, 'Relaxed qualification tool failed: ' + failure); assert.equal(result.signal, null, failure);
    return result;
  };
  const passed = (tool, argv, input, timeout) => { const result = run(tool, argv, input, timeout); assert.equal(result.status, 0, result.stderr); return result; };
  const inventory = async directory => {
    const actual = {};
    for (const relative of (await fs.readdir(directory, { recursive: true })).sort()) {
      const file = path.join(directory, relative); if ((await fs.stat(file)).isFile()) actual[relative.split(path.sep).join('/')] = identity(await fs.readFile(file));
    }
    return actual;
  };
  // Known dependencies are reopened independently of the report's optional
  // input inventory: deleting an input record cannot remove its verification.
  for (const [field, name] of [['sourceLock', 'sources.lock.json'], ['sourceRecipe', 'prepare-source.py'], ['buildRecipe', 'build-native.sh'],
    ['featureRecipe', 'inspect-target-features.mjs'], ['fixtures', 'simd-relaxed-fixtures.mjs'], ['testRecipe', 'test-simd-relaxed.mjs'],
    ['inspectionRecipe', 'simd-relaxed-inspect.mjs'], ['gateRecipe', 'simd-relaxed-qualification.mjs']])
    await captured(path.join(here, name), report[field]);
  const sourceCheck = () => assert.deepEqual(JSON.parse(passed('python3', [path.join(here, 'prepare-source.py'), '--source', report.sourcePath], undefined, 600000).stdout), report.gccSource);
  sourceCheck();
  assert.deepEqual(await inventory(path.join(report.sourcePath, 'gcc/config/wasm')), report.targetSource);
  await captured(path.join(report.sourcePath, 'gcc/config/wasm/wasm_relaxed_simd.h'), report.publicHeader.source);
  await captured(path.join(report.headerRoots.gcc, 'wasm_relaxed_simd.h'), report.publicHeader.installed);
  const nativeReceipt = JSON.parse(await captured(path.resolve(report.toolPaths.gcc, '../../../native-build.json'), report.nativeBuild));
  assert.deepEqual(nativeReceipt.gccSource, report.gccSource);
  assert.equal(nativeReceipt.sourceLockSha256, report.sourceLock.sha256);
  assert.equal(nativeReceipt.recipeSha256, report.buildRecipe.sha256);
  assert.equal(nativeReceipt.tools.cc1.sha256, report.tools.gcc.sha256);
  assert.equal(nativeReceipt.tools.cc1plus.sha256, report.tools.gccCpp.sha256);
  const { library, builtins } = runtimePaths(report);
  const knownRuntime = { 'crt1-command.o': path.join(library, 'crt1-command.o'), 'libc.a': path.join(library, 'libc.a'), 'libm.a': path.join(library, 'libm.a'), 'libclang_rt.builtins-wasm32.a': builtins };
  for (const [name, file] of Object.entries(knownRuntime)) await captured(file, expected.runtime[name]);
  await captured(path.join(root, 'run-wasi.mjs'), report.executionRecipe);
  for (const [file, receipt] of Object.entries(report.inputs)) await captured(file, receipt);
  for (const [name, file] of Object.entries(report.toolPaths)) await captured(file, report.tools[name]);
  for (const [name, directory] of Object.entries(report.headerRoots)) {
    assert.deepEqual(await inventory(directory), report.headers[name], 'Changed ' + name + ' header inputs');
  }
  const replay = await fs.mkdtemp(path.join(os.tmpdir(), 'gcc-relaxed-reopen-'));
  try {
  for (const { fixture, profile, id } of relaxedExecutions()) {
    const entry = [...report.cases, ...report.defaultControls].find(value => value.id === id), directory = path.join(root, id);
    const source = path.join(directory, fixture.request.language === 'cpp' ? 'main.cc' : 'main.c');
    assert.equal(entry.commands[0].argv.at(-3), source);
    await captured(source, entry.source);
    const assembly = await captured(path.join(directory, 'main.wat'), entry.assembly);
    const object = await captured(path.join(directory, 'main.o'), entry.object);
    assert.equal(WebAssembly.Module.customSections(new WebAssembly.Module(object), 'linking').length, 1);
    assert.deepEqual(inspectTargetFeatures(object).features, entry.features);
    const disassembly = passed(report.toolPaths.objdump, ['-d', path.join(directory, 'main.o')]);
    assert.equal(disassembly.stdout, entry.commands[2].stdout);
    verifyRelaxedInstructions(fixture, disassembly.stdout);
    for (const opcode of fixture.requiredInstructions) assert(assembly.toString().includes('(' + opcode + ' '), 'GCC assembly did not contain ' + opcode);
    if (!fixture.request.relaxedSimd) assert(!/\b(?:i8x16|i16x8|i32x4|i64x2|f32x4|f64x2)\.relaxed_/.test(assembly.toString()));
    const bytes = await captured(path.join(directory, 'main.wasm'), entry.wasm), module = new WebAssembly.Module(bytes);
    assert.deepEqual(WebAssembly.Module.imports(module), entry.imports); assert.deepEqual(WebAssembly.Module.exports(module), entry.exports);
    const fresh = path.join(replay, id); await fs.mkdir(fresh);
    const freshAssembly = path.join(fresh, 'main.wat'), freshObject = path.join(fresh, 'main.o'), freshProgram = path.join(fresh, 'main.wasm');
    const originalDirectory = path.join(fresh, 'original-order'); await fs.mkdir(originalDirectory);
    // LLD records the executable basename in its name section.
    const originalObject = path.join(originalDirectory, 'main.o'), originalProgram = path.join(originalDirectory, 'main.wasm');
    // Bind the supplied original WAT -> object -> program byte for byte,
    // independently of the fresh compiler's permissible import order.
    passed(report.toolPaths.assembler, ['-r', '--enable-annotations', ...(fixture.request.relaxedSimd ? ['--enable-relaxed-simd'] : []), path.join(directory, 'main.wat'), '-o', originalObject]);
    await captured(originalObject, entry.object);
    passed(report.toolPaths.linker, ['--fatal-warnings', '-m', 'wasm32', '-e', '_start', '-o', originalProgram, path.join(library, 'crt1-command.o'), '-L' + library, path.join(directory, 'main.o'), '-lm', '-lc', builtins]);
    await captured(originalProgram, entry.wasm);
    // Preserve the original source filename (including __FILE__), but direct
    // every regenerated artifact into a new private directory.
    passed(report.toolPaths[fixture.request.language === 'cpp' ? 'gccCpp' : 'gcc'], relaxedCompilerArgs(fixture, source, freshAssembly, report.headerRoots, profile));
    assertRelaxedAssemblyReplay(assembly, await fs.readFile(freshAssembly));
    passed(report.toolPaths.assembler, ['-r', '--enable-annotations', ...(fixture.request.relaxedSimd ? ['--enable-relaxed-simd'] : []), freshAssembly, '-o', freshObject]);
    const freshObjectBytes = await fs.readFile(freshObject);
    assert.equal(WebAssembly.Module.customSections(new WebAssembly.Module(freshObjectBytes), 'linking').length, 1);
    assert.deepEqual(inspectTargetFeatures(freshObjectBytes).features, entry.features);
    const freshDisassembly = passed(report.toolPaths.objdump, ['-d', freshObject]);
    verifyRelaxedInstructions(fixture, freshDisassembly.stdout);
    passed(report.toolPaths.linker, ['--fatal-warnings', '-m', 'wasm32', '-e', '_start', '-o', freshProgram, path.join(library, 'crt1-command.o'), '-L' + library, freshObject, '-lm', '-lc', builtins]);
    await captured(freshProgram, entry.wasm);
    const execution = passed(report.toolPaths.node, ['--no-warnings', path.join(root, 'run-wasi.mjs'), freshProgram], fixture.stdin);
    assert.equal(execution.stderr, ''); assertRelaxedOutput(fixture, execution.stdout);
    const validation = run(report.toolPaths.validator, [freshProgram]);
    assert.equal(validation.status, fixture.request.relaxedSimd ? 1 : 0);
    await captured(source, entry.source);
  }
  for (const fixture of diagnosticCases) {
    const entry = report.diagnostics.find(value => value.id === fixture.id), directory = path.join(root, fixture.id);
    const source = path.join(directory, fixture.request.language === 'cpp' ? 'main.cc' : 'main.c');
    assert.equal(entry.command.argv.at(-3), source); await captured(source, entry.source);
    const assembly = await fs.readFile(path.join(directory, 'main.wat')).catch(error => { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error; });
    assert.deepEqual(identity(assembly), entry.partialAssembly);
    assert(!/\b(?:i8x16|i16x8|i32x4|i64x2|f32x4|f64x2)\.relaxed_/.test(assembly.toString()));
    const fresh = path.join(replay, fixture.id); await fs.mkdir(fresh);
    const freshAssembly = path.join(fresh, 'main.wat');
    const diagnostic = run(report.toolPaths[fixture.request.language === 'cpp' ? 'gccCpp' : 'gcc'], relaxedCompilerArgs(fixture, source, freshAssembly, report.headerRoots, fixture.profile));
    assert.equal(diagnostic.status, 1); assert.match(diagnostic.stderr, new RegExp(fixture.diagnosticPattern));
    const partial = await fs.readFile(freshAssembly).catch(error => { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error; });
    assert.deepEqual(identity(partial), entry.partialAssembly);
    assert(!/\b(?:i8x16|i16x8|i32x4|i64x2|f32x4|f64x2)\.relaxed_/.test(partial.toString()));
    await captured(source, entry.source);
  }
  sourceCheck();
  for (const [name, file] of Object.entries(knownRuntime)) await captured(file, expected.runtime[name]);
  for (const [name, file] of Object.entries(report.toolPaths)) await captured(file, report.tools[name]);
  for (const [name, directory] of Object.entries(report.headerRoots)) assert.deepEqual(await inventory(directory), report.headers[name], 'Header changed during replay: ' + name);
  return { executions: relaxedExecutions().length, diagnostics: diagnosticCases.length, replayed: true };
  } finally {
    await fs.rm(replay, { recursive: true, force: true });
  }
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { simdHeaderApis, simdHeaderReference } from './simd-header-api.mjs';
import { conversionInstructions, verifyConversionInstructions } from './simd-conversions-inspect.mjs';

const identity = bytes => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
const sourceIdentity = text => identity(Buffer.from(text));
const simdMnemonic = /\b(?:v128|i8x16|i16x8|i32x4|i64x2|f32x4|f64x2)\./u;
const sorted = values => [...values].sort();
export const simdHeaderWasiRunner = `import { WASI } from 'node:wasi';
import { readFile } from 'node:fs/promises';
const wasi = new WASI({version:'preview1',args:['program'],env:{},returnOnExit:true});
const module = await WebAssembly.compile(await readFile(process.argv[2]));
process.exitCode = wasi.start(await WebAssembly.instantiate(module,{wasi_snapshot_preview1:wasi.wasiImport}));
`;

export function verifyHeaderApiCoverage(cases, disabledCases) {
  assert.equal(simdHeaderApis.length, 169); assert.equal(new Set(simdHeaderApis).size, 169);
  const coverage = Object.fromEntries(simdHeaderApis.map(name => [name, new Set()]));
  assert.equal(new Set([...cases, ...disabledCases].map(fixture => fixture.id)).size, cases.length + disabledCases.length, 'Duplicate header fixture');
  for (const fixture of cases) {
    assert.equal(fixture.request.simd, true); assert(['c', 'cpp'].includes(fixture.request.language));
    assert(['0', '2'].includes(fixture.request.optimization)); assert(fixture.apis?.length);
    assert.match(fixture.request.code, /#\s*include\s*<wasm_simd128\.h>/u, 'Header case must include the public header');
    for (const name of fixture.apis) {
      assert(coverage[name], 'Unknown public SIMD API ' + name);
      assert(new RegExp('\\b' + name + '\\s*\\(').test(fixture.request.code), 'Claimed API was not called: ' + name);
      coverage[name].add(fixture.request.language + '-o' + fixture.request.optimization);
    }
  }
  for (const fixture of disabledCases) { assert.equal(fixture.request.simd, false); assert.deepEqual(fixture.apis, []); }
  const combinations = ['c-o0', 'c-o2', 'cpp-o0', 'cpp-o2'];
  for (const [name, actual] of Object.entries(coverage)) assert.deepEqual(sorted(actual), combinations, 'Incomplete C/C++ O0/O2 API coverage: ' + name);
  return Object.fromEntries(Object.entries(coverage).map(([name, values]) => [name, sorted(values)]));
}

export function headerDiagnosticProfile(fixture) {
  assert(['default', 'disabled', 'enabled-invalid'].includes(fixture.profile), 'Missing explicit header diagnostic profile');
  assert.equal(fixture.request.simd, fixture.profile === 'enabled-invalid');
  assert(typeof fixture.diagnosticPattern === 'string' && fixture.diagnosticPattern.length);
  return fixture.profile;
}

export function verifySimdHeaderQualificationOptions(patches, options) {
  if (!patches.some(patch => patch.path === 'patches/0016-wasm-simd128-header.patch')) return;
  for (const field of ['simdHeaderQualification', 'simdConversionsQualification', 'simdSaturatingQualification', 'simdExtendedQualification', 'simdQualification', 'vectorAbiQualification', 'nativeLinker'])
    assert(options[field], 'Header compiler requires ' + field);
}

export function verifySimdHeaderInstallation({ source, installed, browser, packaged, licenses, packagedLicenses }) {
  assert(Buffer.isBuffer(source) && source.length > 10000, 'Missing source SIMD header');
  const expected = identity(source);
  for (const [stage, bytes] of Object.entries({ installed, browser, packaged })) {
    assert(Buffer.isBuffer(bytes), 'Missing ' + stage + ' SIMD header');
    assert.deepEqual(identity(bytes), expected, 'Changed ' + stage + ' SIMD header');
  }
  assert.match(source.toString(), /GPL-3\.0-or-later WITH GCC-exception-3\.1/u);
  for (const [name, minimum] of [['COPYING3', 30000], ['COPYING.RUNTIME', 3000]]) {
    assert(Buffer.isBuffer(licenses[name]) && licenses[name].length > minimum, 'Missing full ' + name);
    assert(Buffer.isBuffer(packagedLicenses[name]), 'Missing packaged ' + name);
    assert.deepEqual(identity(packagedLicenses[name]), identity(licenses[name]), 'Changed packaged ' + name);
  }
}

function assertCommand(command, tool) {
  assert.equal(command.command, tool); assert.equal(command.status, 0, command.stderr);
  assert.equal(command.signal, null); assert(!command.error);
}
function assertCompilerCommand(command, fixture, profile, tool, family) {
  assertCommand(command, tool);
  assert.deepEqual(command.argv.filter(arg => /^-O/.test(arg)), ['-O' + fixture.request.optimization]);
  assert.deepEqual(command.argv.filter(arg => arg.startsWith('-std=')), ['-std=' + fixture.request.standard]);
  assert.deepEqual(command.argv.filter(arg => /^-m(?:no-)?simd128$/.test(arg)), profile === 'default' ? [] : [profile === 'disabled' ? '-mno-simd128' : '-msimd128']);
  assert(command.argv.includes('-nostdinc')); assert(command.argv.includes('-Werror=attributes')); assert(command.argv.includes('-Werror=pragmas'));
  assert(!command.argv.some(arg => arg === '-include' || arg === '-imacros' || arg.startsWith('-D__builtin_')), 'Header must use actual compiler builtin declarations');
  if (family === 'clang') assert(command.argv.includes('--target=wasm32-wasip1') && command.argv.includes('-c'));
  if (fixture.request.language === 'cpp') assert(command.argv.includes('-fno-exceptions') && command.argv.includes('-fno-rtti'));
}

export function verifySimdHeaderQualification(report, expected) {
  const { cases, disabledCases, diagnosticCases } = expected;
  assert.equal(report.kind, 'gcc-wasi-native-simd-header-qualification'); assert.equal(report.status, 'passed'); assert.equal(report.inputsUnchanged, true);
  assert.deepEqual(report.apis, simdHeaderApis); assert.deepEqual(report.coverage, verifyHeaderApiCoverage(cases, disabledCases));
  for (const key of ['gccSource', 'sourceLock', 'targetSource', 'tools', 'headerRoots', 'headers', 'runtime', 'publicHeader', 'licenses', 'fixtures', 'fixtureDependencies', 'apiContract', 'testRecipe', 'inspectionRecipe', 'gateRecipe'])
    assert.deepEqual(report[key], expected[key], 'Header receipt has stale ' + key);
  assert.deepEqual(report.publicHeader.installed, report.publicHeader.source);
  assert.equal(report.publicHeader.clangReference.sha256, simdHeaderReference.headerSha256);
  assert.deepEqual(report.executionRecipe, sourceIdentity(simdHeaderWasiRunner));
  assert(report.licenses.COPYING3.bytes > 30000 && report.licenses['COPYING.RUNTIME'].bytes > 3000, 'Missing full GCC license notices');
  assert.deepEqual(report.cases.map(entry => entry.id), [...cases, ...disabledCases].map(fixture => fixture.id));
  assert.deepEqual(report.defaultControls.map(entry => entry.id), disabledCases.map(fixture => fixture.id + '-default'));
  const executions = [...cases, ...disabledCases].map(fixture => ({ fixture, profile: fixture.request.simd ? 'enabled' : 'disabled' }));
  executions.push(...disabledCases.map(fixture => ({ fixture, profile: 'default' })));
  for (const { fixture, profile } of executions) {
    const id = fixture.id + (profile === 'default' ? '-default' : '');
    const entry = [...report.cases, ...report.defaultControls].find(entry => entry.id === id);
    assert(entry); assert.equal(entry.status, 'passed'); assert.equal(entry.fixture, fixture.id); assert.equal(entry.profile, profile);
    assert.deepEqual(entry.source, sourceIdentity(fixture.request.code)); assert.deepEqual(entry.fixtureValue, sourceIdentity(JSON.stringify(fixture)));
    assert.deepEqual(entry.apis, fixture.apis); assert.equal(entry.stdin, fixture.stdin);
    const families = profile === 'default' ? ['gcc'] : ['gcc', 'clang']; assert.deepEqual(Object.keys(entry.results), families);
    for (const family of families) {
      const result = entry.results[family]; assert.equal(result.status, 'passed'); assert.equal(result.stdout, fixture.stdout);
      const commands = result.commands; assert.equal(commands.length, family === 'gcc' ? 5 : 4);
      let index = 0;
      assertCompilerCommand(commands[index++], fixture, profile, report.toolPaths[family + (fixture.request.language === 'cpp' ? 'Cpp' : '')], family);
      const includeRoots = commands[0].argv.flatMap((value, i, values) => value === '-isystem' ? [values[i + 1]] : []);
      assert.deepEqual(includeRoots, [report.headerRoots[family], path.join(report.headerRoots.target, 'wasm32-wasi')]);
      if (family === 'gcc') { assertCommand(commands[index], report.toolPaths.assembler); assert.deepEqual(commands[index++].argv.slice(0, 2), ['-r', '--enable-annotations']); }
      const disassembler = commands[index++]; assertCommand(disassembler, report.toolPaths.objdump); assert.equal(disassembler.argv[0], '-d');
      const decodedInstructions = disassembler.stdout.split('\n').flatMap(line => {
        const match = /^\s*[a-f0-9]+:\s+(?:[a-f0-9]{2}\s+)+\|\s*(\S+)/i.exec(line);
        return match && !match[1].startsWith('local[') ? [match[1]] : [];
      });
      assert.deepEqual(result.instructions, decodedInstructions, 'Header instructions differ from disassembly');
      const link = commands[index++]; assertCommand(link, report.toolPaths.linker); assert(link.argv.includes('--fatal-warnings'));
      const execution = commands[index++]; assertCommand(execution, report.toolPaths.node); assert.equal(execution.stdout, fixture.stdout); assert.equal(execution.stderr, '');
      assert(result.imports.every(value => value.module === 'wasi_snapshot_preview1' && value.kind === 'function'));
      assert(result.exports.some(value => value.name === '_start' && value.kind === 'function'));
      assert(result.exports.some(value => value.name === 'memory' && value.kind === 'memory'));
      if (family === 'gcc' && fixture.request.simd) {
        const decoded = conversionInstructions(disassembler.stdout); assert.deepEqual(result.convertFunction, decoded); verifyConversionInstructions(fixture, decoded);
      }
      if (!fixture.request.simd) assert(!result.instructions.some(opcode => simdMnemonic.test(opcode)));
      const validation = result.simdDisabledValidation;
      assert.equal(validation.command, report.toolPaths.validator); assert.equal(validation.status, fixture.request.simd ? 1 : 0); assert.equal(validation.signal, null); assert(!validation.error);
      assert.equal(validation.argv[0], '--disable-simd');
    }
  }
  assert.deepEqual(report.diagnostics.map(entry => entry.id), diagnosticCases.map(fixture => fixture.id));
  for (const fixture of diagnosticCases) {
    const entry = report.diagnostics.find(entry => entry.id === fixture.id), profile = headerDiagnosticProfile(fixture);
    assert.equal(entry.profile, profile); assert.deepEqual(entry.source, sourceIdentity(fixture.request.code)); assert.deepEqual(entry.fixtureValue, sourceIdentity(JSON.stringify(fixture)));
    const command = entry.command; assert.equal(command.status, 1); assert.equal(command.signal, null); assert(!command.error);
    assert.match(command.stderr, new RegExp(fixture.diagnosticPattern)); assert.equal(entry.emittedSimd, false);
    assertCompilerCommand({ ...command, status: 0 }, fixture, profile, report.toolPaths[fixture.request.language === 'cpp' ? 'gccCpp' : 'gcc'], 'gcc');
  }
}

export async function reopenSimdHeaderQualification(report, receiptPath, expected) {
  verifySimdHeaderQualification(report, expected);
  const directory = path.dirname(receiptPath);
  const fixtures = new Map([...expected.cases, ...expected.disabledCases].map(fixture => [fixture.id, fixture]));
  async function captured(file, receipt) { const bytes = await fs.readFile(file); assert.deepEqual(identity(bytes), receipt, 'Header artifact identity mismatch: ' + file); return bytes; }
  await captured(path.join(directory, 'run-wasi.mjs'), report.executionRecipe);
  for (const [name, file] of Object.entries(report.toolPaths)) await captured(file, report.tools[name]);
  const library = path.join(path.dirname(report.headerRoots.target), 'lib/wasm32-wasi');
  const builtins = path.resolve(path.dirname(report.toolPaths.linker), '../lib/clang/22/lib/wasm32-unknown-wasi/libclang_rt.builtins.a');
  for (const name of ['crt1-command.o', 'libc.a', 'libm.a']) await captured(path.join(library, name), report.runtime[name]);
  await captured(builtins, report.runtime['libclang_rt.builtins-wasm32.a']);
  for (const [name, root] of Object.entries(report.headerRoots)) {
    const actual = {};
    for (const relative of (await fs.readdir(root, { recursive: true })).sort()) {
      const file = path.join(root, relative);
      if ((await fs.stat(file)).isFile()) actual[relative.split(path.sep).join('/')] = identity(await fs.readFile(file));
    }
    assert.deepEqual(actual, report.headers[name], 'Changed ' + name + ' header inputs');
  }
  for (const entry of [...report.cases, ...report.defaultControls]) {
    const fixture = fixtures.get(entry.fixture), base = path.join(directory, entry.id);
    assert(/^[A-Za-z0-9_.-]+$/.test(entry.id));
    await captured(path.join(base, fixture.request.language === 'cpp' ? 'main.cc' : 'main.c'), entry.source);
    for (const [family, result] of Object.entries(entry.results)) {
      const root = path.join(base, family), objectFile = path.join(root, 'main.o'), objectBytes = await captured(objectFile, result.object);
      const compilerArgs = result.commands[0].argv;
      assert.equal(compilerArgs.at(-3), path.join(base, fixture.request.language === 'cpp' ? 'main.cc' : 'main.c'));
      assert.equal(compilerArgs.at(-2), '-o'); assert.equal(compilerArgs.at(-1), path.join(root, family === 'gcc' ? 'main.wat' : 'main.o'));
      assert.deepEqual(result.commands.at(-1).argv, ['--disable-warning=ExperimentalWarning', path.join(directory, 'run-wasi.mjs'), path.join(root, 'main.wasm')]);
      assert.deepEqual(result.commands.at(-2).argv, ['--fatal-warnings', '-m', 'wasm32', '-e', '_start', '-o', path.join(root, 'main.wasm'),
        path.join(library, 'crt1-command.o'), '-L' + library, objectFile, '-lm', '-lc', builtins]);
      if (family === 'gcc') assert.deepEqual(result.commands[1].argv, ['-r', '--enable-annotations', path.join(root, 'main.wat'), '-o', objectFile]);
      assert.deepEqual(result.commands.find(command => command.command === report.toolPaths.objdump).argv, ['-d', objectFile]);
      assert.deepEqual(result.simdDisabledValidation.argv, ['--disable-simd', path.join(root, 'main.wasm')]);
      assert.equal(WebAssembly.Module.customSections(new WebAssembly.Module(objectBytes), 'linking').length, 1);
      const disassembly = spawnSync(report.toolPaths.objdump, ['-d', objectFile], { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
      assert.ifError(disassembly.error); assert.equal(disassembly.status, 0, disassembly.stderr); assert.equal(disassembly.signal, null);
      const recorded = result.commands.find(command => command.command === report.toolPaths.objdump); assert.equal(disassembly.stdout, recorded.stdout);
      if (family === 'gcc') {
        const assembly = await captured(path.join(root, 'main.wat'), result.assembly);
        if (!fixture.request.simd) assert(!simdMnemonic.test(assembly.toString()));
        for (const opcode of fixture.requiredInstructions) assert(assembly.toString().includes(`(${opcode} `));
      }
      const program = await captured(path.join(root, 'main.wasm'), result.wasm), module = new WebAssembly.Module(program);
      assert.deepEqual(WebAssembly.Module.imports(module), result.imports); assert.deepEqual(WebAssembly.Module.exports(module), result.exports);
    }
  }
  for (const fixture of expected.diagnosticCases) {
    const entry = report.diagnostics.find(entry => entry.id === fixture.id), root = path.join(directory, fixture.id);
    assert(/^[A-Za-z0-9_.-]+$/.test(fixture.id));
    await captured(path.join(root, fixture.request.language === 'cpp' ? 'main.cc' : 'main.c'), entry.source);
    const partial = await fs.readFile(path.join(root, 'main.wat')).catch(error => { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error; });
    assert.deepEqual(identity(partial), entry.partialAssembly); assert(!simdMnemonic.test(partial.toString()));
  }
}

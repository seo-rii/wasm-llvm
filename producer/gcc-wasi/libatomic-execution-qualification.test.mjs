import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { cases } from './libatomic-fixtures.mjs';
import { sharedCases } from './libatomic-shared-fixtures.mjs';
import { identity, libatomicCompileArgs, libatomicLinkArgs, libatomicWasiRunner } from './libatomic-qualification.mjs';
import { verifyLibatomicExecutionMetadata } from './libatomic-execution-qualification.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const hash = value => identity(Buffer.from(value));
function contract() {
  // Metadata-only paths deliberately do not exist. This cannot qualify a
  // compiler/archive: the public reopener must reopen and execute real files.
  const context = { work: '/contract/work', sdk: '/contract/sdk', sysroot: '/contract/sysroot',
    libatomic: '/contract/libatomic', output: '/contract/output' };
  const expected = { ...context, gccSource: { sourceDiffSha256: 'source' }, sourceLockSha256: hash('lock').sha256,
    nativeBuild: { path: '/contract/work/native-build.json', ...hash('native') },
    archive: { path: '/contract/libatomic/sysroot/lib/wasm32-wasi/libatomic.a', ...hash('archive') } };
  const toolPaths = { gcc: context.work + '/gcc-native/gcc/cc1', gccCpp: context.work + '/gcc-native/gcc/cc1plus',
    assembler: context.work + '/wabt-native/wat2wasm', objdump: context.work + '/wabt-native/wasm-objdump',
    validator: context.work + '/wabt-native/wasm-validate', linker: context.sdk + '/bin/wasm-ld', node: '/contract/node' };
  const report = { schemaVersion: 1, kind: 'gcc-wasi-native-libatomic-qualification', status: 'passed', inputsUnchanged: true,
    host: 'native', target: 'wasm32-wasi', context, gccSource: expected.gccSource, sourceLock: hash('lock'),
    nativeBuild: expected.nativeBuild, archive: expected.archive, counts: { serial: 28, shared: 16, workers: 32 },
    toolPaths, wasiRunner: { path: context.output + '/run-wasi.mjs', ...hash(libatomicWasiRunner) }, cases: [], sharedCases: [] };
  for (const fixture of [...cases, ...sharedCases]) {
    const directory = context.output + '/' + fixture.id;
    const source = directory + (fixture.request.language === 'cpp' ? '/main.cc' : '/main.c');
    const assembly = directory + '/main.wat', object = directory + '/main.o', program = directory + '/main.wasm';
    const command = (command, argv, input = null, stdout = '') => ({ command, argv, cwd: directory, status: 0, signal: null, stdin: input, stdout, stderr: '' });
    const entry = { id: fixture.id, status: 'passed', fixture: hash(JSON.stringify(fixture)),
      source: { path: source, ...hash(fixture.request.code) }, assembly: { path: assembly, ...hash('assembly') },
      object: { path: object, ...hash('object') }, program: { path: program, ...hash('program') },
      helperImports: fixture.requiredSymbols.map(name => ({ module: 'env', kind: 'function', name })),
      commands: [
        command(fixture.request.language === 'cpp' ? toolPaths.gccCpp : toolPaths.gcc, libatomicCompileArgs(fixture, source, assembly, context)),
        command(toolPaths.assembler, ['-r', '--enable-annotations', '--enable-threads', assembly, '-o', object]),
        command(toolPaths.objdump, ['-x', '-d', object]),
        command(toolPaths.linker, libatomicLinkArgs(fixture, object, program, context)),
        command(toolPaths.validator, ['--enable-threads', program]),
        command(toolPaths.objdump, ['-x', '-d', program]),
        fixture.request.sharedMemory
          ? command(toolPaths.node, [path.join(here, 'run-libatomic-shared.mjs'), '--program', program, '--fixture', fixture.id, '--output', directory + '/execution'])
          : command(toolPaths.node, ['--no-warnings', report.wasiRunner.path, program], fixture.stdin, fixture.stdout),
      ],
    };
    if (!fixture.request.sharedMemory) Object.assign(entry, { stdin: fixture.stdin, stdout: fixture.stdout });
    (fixture.request.sharedMemory ? report.sharedCases : report.cases).push(entry);
  }
  return { report, expected, file: context.output + '/qualification.json' };
}

test('execution metadata requires all actual serial and shared compiler profiles', () => {
  const { report, expected, file } = contract(); verifyLibatomicExecutionMetadata(report, file, expected);
});

for (const [name, mutate] of [
  ['missing C++ O0 serial case', r => { r.cases.splice(2, 1); }],
  ['missing shared lock-wrap case', r => { r.sharedCases.pop(); }],
  ['provider substituted for genuine fixture', r => { r.cases[0].source = { ...r.cases[0].source, ...hash('helper provider') }; }],
  ['different library archive', r => { r.archive = { ...r.archive, ...hash('fake archive') }; }],
  ['disabled compiler profile', r => { r.sharedCases[0].commands[0].argv = r.sharedCases[0].commands[0].argv.filter(value => value !== '-matomics'); }],
  ['serial macro in shared compile', r => { r.sharedCases[0].commands[0].argv.push('-D__GCC_WASI_SINGLE_THREAD__=1'); }],
  ['undefined runtime helper allowance', r => { r.sharedCases[0].commands[3].argv.push('--allow-undefined'); }],
  ['wrong stdin', r => { r.cases[0].commands[6].stdin = '4\n'; }],
  ['runtime diagnostic', r => { r.cases[0].commands[6].stderr = 'warning'; }],
  ['unknown runtime output', r => { r.cases[0].stdout = 'unknown\n'; }],
  ['missing actual helper import', r => { r.cases[0].helperImports.pop(); }],
  ['native substituted for shared runtime', r => { r.sharedCases[0].commands[6].argv = r.cases[0].commands[6].argv; }],
]) test(`execution metadata rejects ${name}`, () => {
  const { report, expected, file } = contract(); mutate(report);
  assert.throws(() => verifyLibatomicExecutionMetadata(report, file, expected));
});

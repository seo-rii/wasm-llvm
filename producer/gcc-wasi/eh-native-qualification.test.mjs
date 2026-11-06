import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeEhCases } from './eh-native-fixtures.mjs';
import { verifyNativeExceptionMetadata } from './eh-native-qualification.mjs';
import { canonicalExceptionAssembly, assertExceptionAssemblyReplay } from './eh-assembly-replay.mjs';

const tag = '(import "env" "__cpp_exception" (tag $__cpp_exception (@sym (name "__cpp_exception")) (param i32)))';
const memory = '  (import "env" "memory" (memory 0))';
const callback = '  (import "env" "callback" (func $callback (param i32)))';
const body = '  (func $f (param i32) (call $callback (local.get 0)))';
const wat = imports => ['(module', ...imports, body, ')', ''].join('\n');

test('EH replay changes only complete import declaration order, preserving tag bytes', () => {
  const first = wat([memory, tag, callback]), second = wat([callback, memory, tag]);
  assertExceptionAssemblyReplay(first, second);
  assert.equal(canonicalExceptionAssembly(first).split('\n').filter(line => line === tag).length, 1);
});
for (const [name, mutate] of [
  ['instruction', value => value.replace('local.get 0', 'i32.const 0')],
  ['tag signature', value => value.replace('(@sym (name "__cpp_exception")) (param i32)', '(@sym (name "__cpp_exception")) (param i64)')],
  ['tag name', value => value.replaceAll('__cpp_exception', '__other_exception')],
  ['function signature', value => value.replace('func $callback (param i32)', 'func $callback (param i64)')],
  ['import name', value => value.replace('"callback"', '"different"')],
  ['missing import', value => value.replace(callback + '\n', '')],
  ['duplicate import', value => value.replace(callback, callback + '\n' + callback)],
  ['duplicate tag', value => value.replace(tag, tag + '\n' + tag)],
  ['trailing malformed expression', value => value + '('],
  ['unterminated comment', value => value + '(; unfinished'],
  ['import after body', value => value.replace(callback + '\n', '').replace(body, body + '\n' + callback)],
  ['multiline import', value => value.replace(callback, callback.replace(' (param', '\n    (param'))],
]) test(`EH import replay rejects changed ${name}`, () => {
  const original = wat([memory, tag, callback]);
  assert.throws(() => assertExceptionAssemblyReplay(original, mutate(original)));
});

function metadata() {
  const success = () => ({ exitCode: 0 });
  const compiler = { kind: 'gcc-wasi-native-eh-compiler', status: 'passed', inputsUnchanged: true,
    gnuRuntimeExecuted: false, nativeCaseIds: nativeEhCases.map(item => item.id),
    counts: { nativeFixturePrograms: 14, translationUnits: 18, abiExecutions: 4 },
    cases: nativeEhCases.map(fixture => ({ id: fixture.id, kind: 'gnu-fixture-compile', passed: true,
      callerCatchRetained: fixture.expected.exitCode === 0,
      units: [fixture.request.code, ...(fixture.request.sources ?? [])].map(() => ({
        compile: success(), assemble: success(), inspect: success(), modernEvidence: { legacyTry: false } })) })) };
  for (const language of ['c', 'c++']) for (const opt of ['0', '2']) compiler.cases.push({
    id: `unwind-abi-${language}-o${opt}`, kind: 'unwind-abi', passed: true,
    compile: success(), assemble: success(), link: success(), execute: success() });
  const driver = { kind: 'actual-gcc-EH-driver-controls', status: 'passed', inputsUnchanged: true,
    counts: { driverCompiles: 18, expectedDiagnostics: 3, unwindAbiPartialLinks: 4 }, cases: [] };
  for (const profile of ['default', 'explicit-off', 'enabled', 'last-on', 'last-off', 'pragma-language-only',
    'attribute-language-only', 'pragma-target-attempt', 'ehspec-catchall']) for (const opt of ['0', '2']) {
    const enabled = ['enabled', 'last-on', 'ehspec-catchall'].includes(profile);
    driver.cases.push({ id: `${profile}-o${opt}`, passed: true, expectedEnabled: enabled,
      hasTryTable: enabled, hasExceptionFeature: enabled, compile: success(), inspect: success(),
      wat: {}, object: {}, preprocessed: {} });
  }
  for (const id of ['debug', 'pic', 'non-call']) driver.cases.push({ id, passed: true,
    kind: 'expected-rejection', compile: { exitCode: 1 } });
  for (const language of ['c', 'cpp']) for (const opt of ['0', '2']) driver.cases.push({
    id: `partial-${language}-o${opt}`, passed: true, kind: 'actual-unwind-ABI-link', link: success() });
  return { compiler, driver };
}

test('backend admission scope keeps compile/ABI controls separate from full GNU execution', () => {
  const { compiler, driver } = metadata(); verifyNativeExceptionMetadata(compiler, driver);
});
for (const [name, mutate] of [
  ['missing native fixture', value => value.compiler.cases.shift()],
  ['duplicate case', value => { value.compiler.cases[1].id = value.compiler.cases[0].id; }],
  ['lost caller catch', value => { value.compiler.cases[0].callerCatchRetained = false; }],
  ['legacy EH', value => { value.compiler.cases[0].units[0].modernEvidence.legacyTry = true; }],
  ['fabricated GNU semantic claim', value => { value.compiler.gnuRuntimeExecuted = true; }],
  ['changed inputs', value => { value.compiler.inputsUnchanged = false; }],
  ['failed ABI execution', value => { value.compiler.cases.at(-1).execute.exitCode = 1; }],
  ['false default feature', value => { value.driver.cases[0].hasExceptionFeature = true; }],
  ['missing LSDA regression', value => value.driver.cases.splice(16, 1)],
  ['false diagnostic success', value => { value.driver.cases.find(item => item.id === 'debug').compile.exitCode = 0; }],
  ['failed unwinder link', value => { value.driver.cases.at(-1).link.exitCode = 1; }],
  ['inflated counts', value => { value.compiler.counts.nativeFixturePrograms++; }],
]) test(`backend admission rejects ${name}`, () => {
  const value = metadata(); mutate(value);
  assert.throws(() => verifyNativeExceptionMetadata(value.compiler, value.driver));
});

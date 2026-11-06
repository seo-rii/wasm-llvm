import assert from 'node:assert/strict';
import test from 'node:test';
import { assertTlsAssemblyReplay } from './tls-assembly-replay.mjs';

const declarations = [
  '  (import "env" "__tls_base" (global $__tls_base (mut i32)))',
  '  (import "env" "other" (func $other (@sym) (param) (result i32)))',
  '  (@sym.import.data $__dso_handle (name "__dso_handle"))',
  '  (@sym.import.data $external_tls tls weak (name "external_tls"))',
];
const body = '  (func $probe (result i32) (call $other))';
const module = (imports=declarations, content=body) => `(module\n${imports.join('\n')}\n${content}\n)\n`;

test('accepts complete mixed function and TLS/non-TLS data import reordering', () => {
  assert.doesNotThrow(() => assertTlsAssemblyReplay(module(), module([...declarations].reverse())));
});
test('preserves import names, signatures, TLS and binding flags', () => {
  for (const [before,after] of [['"other"','"changed"'],['(result i32)','(result i64)'],
    [' tls weak',' weak'],[' tls weak',' tls']]) {
    assert.throws(() => assertTlsAssemblyReplay(module(),module().replace(before,after)));
  }
});
test('cannot add, omit or substitute duplicate declarations', () => {
  for (const imports of [declarations.slice(1),[...declarations,declarations[0]],
    [declarations[0],declarations[1],declarations[1],declarations[3]]]) {
    assert.throws(() => assertTlsAssemblyReplay(module(),module(imports)));
  }
});
test('retains every body and non-import metadata byte', () => {
  for (const content of [body.replace('call $other','i32.const 0'),body+'\n  (@custom "changed" "x")']) {
    assert.throws(() => assertTlsAssemblyReplay(module(),module(declarations,content)));
  }
});
test('rejects imports outside the prefix and nested lookalikes', () => {
  const late=`(module\n${body}\n${declarations.join('\n')}\n)\n`;
  assert.throws(() => assertTlsAssemblyReplay(late,late));
  const nested=module([],`  (func $probe\n${declarations[0]}\n  )`);
  assert.throws(() => assertTlsAssemblyReplay(nested,nested.replace('__tls_base','another_tls_base')));
});
test('rejects malformed, multiline, concatenated and unclosed declarations', () => {
  for (const changed of [module().replace('(@sym)', '(@sym'),
    module().replace('(func $other', '(func\n$other'),
    module().replace(declarations[0],declarations[0]+' (func $extra)'),
    module().slice(0,-2),module()+'(module)']) {
    assert.throws(() => assertTlsAssemblyReplay(changed,changed));
  }
});
test('tracks escaped strings and nested block comments without dropping them', () => {
  const special='  (import "e(\\\"n)v" "other" (func $other (@sym) (result i32)))';
  const old=module([special,...declarations.slice(2)],'  (; outer (; nested ;) ;)\n'+body);
  const fresh=module([...declarations.slice(2),special],'  (; outer (; nested ;) ;)\n'+body);
  assert.doesNotThrow(()=>assertTlsAssemblyReplay(old,fresh));
  assert.throws(()=>assertTlsAssemblyReplay(old,fresh.replace('nested','changed')));
});

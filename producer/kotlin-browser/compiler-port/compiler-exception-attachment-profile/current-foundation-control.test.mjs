import assert from 'node:assert/strict';
import test from 'node:test';
import { projectControlArguments } from './current-foundation-control.mjs';

const current = [{ filename: '/actual/unchanged.kt' }, { filename: '/actual/entry.kt' }, { filename: '/actual/helper.kt' }];
const predecessor = [{ filename: '/actual/unchanged.kt' }, { filename: '/before/entry.kt' }, { filename: '/before/psi.kt' }];
const args = ['-Xwasm-target=wasm-js', '-Xcommon-sources=' + current.map(row => row.filename).join(','),
  '-libraries', '/libraries/stdlib.klib:/libraries/syntax.klib', '-ir-output-dir', '/actual/klib',
  '-ir-output-name', 'kotlin-browser-compiler', ...current.map(row => row.filename)];

test('control projects both real source vectors and preserves libraries and compiler flags', () => {
  const result = projectControlArguments(args, current, predecessor, '/control');
  assert.deepEqual(result, ['-Xwasm-target=wasm-js', '-Xcommon-sources=/actual/unchanged.kt,/before/entry.kt,/before/psi.kt',
    '-libraries', '/libraries/stdlib.klib:/libraries/syntax.klib', '-ir-output-dir', '/control/klib',
    '-ir-output-name', 'kotlin-browser-compiler', '/actual/unchanged.kt', '/before/entry.kt', '/before/psi.kt']);
  assert.equal(args[5], '/actual/klib');
});

test('control rejects omitted or differently ordered common inputs and altered positional inputs', () => {
  for (const changed of [args.filter(value => !value.startsWith('-Xcommon-sources=')),
    args.map(value => value.startsWith('-Xcommon-sources=') ? '-Xcommon-sources=/actual/unchanged.kt' : value),
    args.map(value => value.startsWith('-Xcommon-sources=') ? '-Xcommon-sources=' + current.toReversed().map(row => row.filename).join(',') : value),
    [...args.slice(0, -1), '/foreign/helper.kt']])
    assert.throws(() => projectControlArguments(changed, current, predecessor, '/control'));
  assert.throws(() => projectControlArguments(args, current, [...predecessor, predecessor[0]], '/control'));
});

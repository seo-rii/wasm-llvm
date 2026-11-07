import assert from 'node:assert/strict';
import { canonicalTlsAssembly } from './tls-assembly-replay.mjs';

// GCC's EH tag is currently the sole unindented import. Temporarily indent
// exactly that declaration for the existing complete-import parser, then put
// its original bytes back. Only import declaration order may change.
const tag = '(import "env" "__cpp_exception" (tag $__cpp_exception (@sym (name "__cpp_exception")) (param i32)))';
export function canonicalExceptionAssembly(assembly) {
  const text = typeof assembly === 'string' ? assembly
    : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(assembly);
  const lines = text.split('\n');
  const indices = lines.flatMap((line, index) => line === tag ? [index] : []);
  assert(indices.length <= 1, 'Duplicate EH tag import');
  if (indices.length) lines[indices[0]] = '  ' + tag;
  const canonical = canonicalTlsAssembly(lines.join('\n')).split('\n');
  if (indices.length) {
    const matches = canonical.flatMap((line, index) => line === '  ' + tag ? [index] : []);
    assert.equal(matches.length, 1, 'Duplicate or changed EH tag import');
    canonical[matches[0]] = tag;
  }
  return canonical.join('\n');
}

export function assertExceptionAssemblyReplay(original, fresh) {
  assert.equal(canonicalExceptionAssembly(fresh), canonicalExceptionAssembly(original),
    'Recompiled GCC EH assembly changed beyond complete import declaration order');
}

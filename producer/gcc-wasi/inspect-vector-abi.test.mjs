import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectObjectFunctionSignatures, inspectVectorAbi } from './inspect-vector-abi.mjs';

// Small authored Wasm fixtures exercise the binary inspector only. These are
// not GCC code-generation or execution qualification results. Keep the bytes
// inline so the tests need no compiler, assembler, SDK, browser or build output.
const fixtures = {
  // Table/global imports precede two functions: (i32)->i64 and (v128)->v128.
  // A memory import follows them. Defined _start and local(v128)->v128 functions
  // have function indices 2 and 3, independent of the other import kinds.
  imports: 'AGFzbQEAAAABDgNgAX8BfmABewF7YAAAAkYFA2VudgV0YWJsZQFwAAEDZW52Bmdsb2JhbAN/AANlbnYGc2NhbGFyAAADZW52BnZlY3RvcgABA2VudgZtZW1vcnkCAQEDAwMCAgEHLQUGbWVtb3J5AgAGX3N0YXJ0AAIGc2NhbGFyAAAGdmVjdG9yAAEFbG9jYWwAAwoJAgIACwQAIAAL',
  definedSharedMemory: 'AGFzbQEAAAABBAFgAAADAgEABQQBAwEDBxMCBm1lbW9yeQIABl9zdGFydAAACgQBAgAL',
  importedSharedMemory: 'AGFzbQEAAAABBAFgAAACEAEDZW52Bm1lbW9yeQIDAgUDAgEABwoBBl9zdGFydAAACgQBAgAL',
  // All three exports refer to the same (i64)->i64 function.
  unusualNames: 'AGFzbQEAAAABBgFgAX4BfgMCAQAHJAMJX19wcm90b19fAAALY29uc3RydWN0b3IAAAbrsqHthLAAAAoGAQQAIAAL',
  // A data segment contains byte sequences that resemble v128 function types
  // and an export named "fake". Neither is module type/export metadata.
  data: 'AGFzbQEAAAABBAFgAAADAgEABQMBAAEHEwIGbWVtb3J5AgAGX3N0YXJ0AAAKBAECAAsLGAEAQQALEgEGAWABewF7BwgBBGZha2UAAA=='
};
const bytes = name => Buffer.from(fixtures[name], 'base64');
function u32(value) {
  const result = [];
  do { const byte = value & 127; value >>>= 7; result.push(byte | (value ? 128 : 0)); } while (value);
  return result;
}
const wasmName = value => { const encoded = new TextEncoder().encode(value); return [...u32(encoded.length), ...encoded]; };
const section = (kind, body) => [kind, ...u32(body.length), ...body];
const linkingPayload = symbols => [2, ...section(8, [...u32(symbols.length), ...symbols.flat()])];
const appendLinking = (module, payload) => Uint8Array.from([...module, ...section(0, [...wasmName('linking'), ...payload])]);

test('imported function indices and v128 results survive unrelated import kinds', () => {
  assert.deepEqual(inspectVectorAbi(bytes('imports')), {
    exports: {
      _start: { params: [], results: [] },
      scalar: { params: ['i32'], results: ['i64'] },
      vector: { params: ['v128'], results: ['v128'] },
      local: { params: ['v128'], results: ['v128'] }
    },
    memories: [{ minimum: 1, maximum: 3, shared: false }]
  });
});

test('both defined and imported shared memory remain visible to the package gate', () => {
  for (const [name, minimum, maximum] of [
    ['definedSharedMemory', 1, 3],
    ['importedSharedMemory', 2, 5]
  ]) {
    assert.deepEqual(inspectVectorAbi(bytes(name)), {
      exports: { _start: { params: [], results: [] } },
      memories: [{ minimum, maximum, shared: true }]
    });
  }
});

test('arbitrary UTF-8 and prototype-like export names are ordinary own keys', () => {
  const { exports } = inspectVectorAbi(bytes('unusualNames'));
  assert.equal(Object.getPrototypeOf(exports), Object.prototype);
  assert.deepEqual(Object.keys(exports), ['__proto__', 'constructor', '벡터']);
  for (const name of Object.keys(exports)) {
    assert(Object.hasOwn(exports, name));
    assert.deepEqual(exports[name], { params: ['i64'], results: ['i64'] });
  }
});

test('data bytes cannot invent function types or exports', () => {
  assert.deepEqual(inspectVectorAbi(bytes('data')), {
    exports: { _start: { params: [], results: [] } },
    memories: [{ minimum: 1, maximum: null, shared: false }]
  });
});

test('truncated and malformed Wasm is rejected before its ABI is trusted', () => {
  const valid = bytes('imports');
  assert.throws(() => inspectVectorAbi(valid.subarray(0, valid.length - 1)), WebAssembly.CompileError);
  const invalid = Buffer.from(valid);
  invalid[0] = 1;
  assert.throws(() => inspectVectorAbi(invalid), WebAssembly.CompileError);
});

test('object symbols resolve caller imports and provider definitions through actual function types', () => {
  const object = appendLinking(bytes('imports'), linkingPayload([
    [0, 0x10, 0], // Import name "scalar", not import-table position including globals/tables.
    [0, 0x50, 1, ...wasmName('renamed-vector')], // Explicit import symbol alias.
    [0, 0, 2, ...wasmName('entry')],
    [0, 0, 3, ...wasmName('provider')],
    [0, 2, 2, ...wasmName('local')],
    [0, 2, 3, ...wasmName('local')], // Local names are not externally unique.
  ]));
  assert.deepEqual(inspectObjectFunctionSignatures(object), {
    scalar: { params: ['i32'], results: ['i64'] },
    'renamed-vector': { params: ['v128'], results: ['v128'] },
    entry: { params: [], results: [] },
    provider: { params: ['v128'], results: ['v128'] },
  });
  assert.deepEqual(inspectVectorAbi(object), inspectVectorAbi(bytes('imports')));
});

test('data and common symbols cannot shift the following function symbol or invent its type', () => {
  const object = appendLinking(bytes('data'), linkingPayload([
    [1, 0, ...wasmName('payload'), 0, 0, 18],
    [1, 3, ...wasmName('common'), 4, 2],
    [1, 0x10, ...wasmName('external-data')],
    [0, 0, 0, ...wasmName('entry')],
  ]));
  assert.deepEqual(inspectObjectFunctionSignatures(object), { entry: { params: [], results: [] } });
});

test('prototype-like linking symbol names remain own data properties', () => {
  const object = appendLinking(bytes('imports'), linkingPayload([
    [0, 0x50, 0, ...wasmName('__proto__')],
    [0, 0, 3, ...wasmName('constructor')],
  ]));
  const signatures = inspectObjectFunctionSignatures(object);
  assert.equal(Object.getPrototypeOf(signatures), Object.prototype);
  assert.deepEqual(Object.keys(signatures), ['__proto__', 'constructor']);
  assert.deepEqual(signatures.__proto__, { params: ['i32'], results: ['i64'] });
  assert.deepEqual(signatures.constructor, { params: ['v128'], results: ['v128'] });
});

test('object inspection rejects missing, duplicate and unsupported linking metadata', () => {
  const base = bytes('imports');
  assert.throws(() => inspectObjectFunctionSignatures(base), /Missing linking section/);
  assert.throws(() => inspectObjectFunctionSignatures(appendLinking(base, [2])), /Missing linking symbol table/);
  assert.throws(() => inspectObjectFunctionSignatures(appendLinking(base, [3])), /Unsupported linking metadata version/);
  const emptySymbols = linkingPayload([]);
  assert.throws(() => inspectObjectFunctionSignatures(appendLinking(appendLinking(base, emptySymbols), emptySymbols)), /Duplicate linking section/);
  assert.throws(() => inspectObjectFunctionSignatures(appendLinking(base, [2, ...section(8, [0]), ...section(8, [0])])), /Duplicate linking symbol table/);
});

test('custom metadata cannot reference missing functions, mislabel imports or reuse external names', () => {
  for (const [symbols, diagnostic] of [
    [[[0, 0, 99, ...wasmName('absent')]], /function index out of bounds/],
    [[[0, 0, 0, ...wasmName('not-defined')]], /import flag mismatch/],
    [[[0, 0x10, 3]], /import flag mismatch/],
    [[[0, 0, 2, ...wasmName('duplicate')], [0, 0, 3, ...wasmName('duplicate')]], /Duplicate linking function symbol/],
    [[[0, 3, 2, ...wasmName('common-function')]], /cannot use common binding/],
  ]) {
    const object = appendLinking(bytes('imports'), linkingPayload(symbols));
    assert.throws(() => inspectObjectFunctionSignatures(object), diagnostic);
  }
});

test('bounds checks and strict UTF-8 decoding cover engine-opaque linking bytes', () => {
  const base = bytes('imports');
  assert.throws(() => inspectObjectFunctionSignatures(appendLinking(base, [2, 8, 20, 0])), /Truncated linking subsection/);
  assert.throws(() => inspectObjectFunctionSignatures(appendLinking(base, linkingPayload([[0, 0, 2, 20, 97]]))), /Truncated Wasm name/);
  assert.throws(() => inspectObjectFunctionSignatures(appendLinking(base, linkingPayload([[0, 0, 2, 2, 0xc3, 0x28]]))), TypeError);
  assert.throws(() => inspectObjectFunctionSignatures(appendLinking(base, linkingPayload([[9, 0]]))), /Unsupported linking symbol kind/);
  assert.throws(() => inspectObjectFunctionSignatures(appendLinking(base, [2, ...section(8, [0, 0])])), /Trailing linking symbol bytes/);
});

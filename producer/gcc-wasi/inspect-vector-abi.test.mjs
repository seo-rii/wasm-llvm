import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectVectorAbi } from './inspect-vector-abi.mjs';

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

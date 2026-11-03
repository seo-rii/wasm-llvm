import assert from 'node:assert/strict';
import test from 'node:test';
import { permutationInstructions, permutationWatInstructions, verifyRuntimePermutationInstructions } from './runtime-permutation-inspect.mjs';

const fallback = { semanticKind: 'scalar-runtime-permutation', operationFunction: 'convert', feature: 'enabled',
  requiredInstructions: ['i32.load'], forbiddenInstructions: ['i8x16.swizzle', 'i8x16.relaxed_swizzle'] };
const constant = { semanticKind: 'constant-permutation', operationFunction: 'permute', feature: 'enabled',
  requiredInstructions: ['i8x16.shuffle'], forbiddenInstructions: [] };
const dumped = `000040 func[0] <main>:
 000041: fd 0e | i8x16.swizzle
000050 func[1] <convert>:
 000051: 02 7f | local[3..4] type=i32
 000053: 71 | i32.and
 000054: 28 02 00 | i32.load 2 0
 000057: 0b | end
000060 func[2] <other>:
 000061: fd 8e 02 | i8x16.relaxed_swizzle
`;

test('real instruction lines are scoped to the operation and exclude local declarations', () => {
  const operation = permutationInstructions(dumped, 'convert');
  assert.deepEqual(operation, { index: 1, name: 'convert', instructions: ['i32.and', 'i32.load', 'end'] });
  verifyRuntimePermutationInstructions(fallback, operation);
});

test('an opcode in another function cannot satisfy or violate the operation contract', () => {
  assert.throws(() => verifyRuntimePermutationInstructions(fallback,
    permutationInstructions(dumped.replace('i32.load 2 0', 'i32.const 253'), 'convert')), /omitted i32.load/);
  assert.throws(() => verifyRuntimePermutationInstructions(fallback,
    permutationInstructions(dumped.replace('i32.load 2 0', 'i8x16.swizzle'), 'convert')), /omitted i32.load/);
});

test('missing or ambiguous operation symbols fail', () => {
  assert.throws(() => permutationInstructions(dumped, 'missing'), /exactly one/);
  assert.throws(() => permutationInstructions(dumped + dumped.replaceAll('func[1]', 'func[3]'), 'convert'), /exactly one/);
  assert.throws(() => permutationInstructions(dumped.replace('<convert>', '<convert_other>'), 'convert'), /exactly one/);
});

test('WAT inspection ignores comments, strings and unrelated function bodies', () => {
  const wat = `(module
    (func $main (i8x16.swizzle (v128.const i32x4 0 0 0 0) (v128.const i32x4 0 0 0 0)))
    (func $convert (@sym (name "i8x16.swizzle ) ("))
      ;; (i8x16.relaxed_swizzle)
      (; nested (; (i8x16.swizzle) ;) comment ;)
      (i32.load (i32.and (i32.const 32) (i32.const 3)))))`;
  const operation = permutationWatInstructions(wat, 'convert');
  assert.deepEqual(operation.instructions, ['i32.load', 'i32.and', 'i32.const', 'i32.const']);
  verifyRuntimePermutationInstructions(fallback, operation);
  assert.throws(() => permutationWatInstructions(wat.replace('(i32.load (i32.and', '(i32.const (i32.and'), 'missing'), /exactly one/);
});

test('WAT comments cannot provide the required load or mask', () => {
  const missingLoad = permutationWatInstructions('(module (func $convert ;; (i32.load)\n (i32.and (i32.const 1) (i32.const 3))))', 'convert');
  assert.throws(() => verifyRuntimePermutationInstructions(fallback, missingLoad), /omitted i32.load/);
  const missingMask = permutationWatInstructions('(module (func $convert (i32.load (i32.const 0)) (; i32.and ;)))', 'convert');
  assert.throws(() => verifyRuntimePermutationInstructions(fallback, missingMask), /selector masking/);
});

test('constant permutations require the actual shuffle instruction', () => {
  verifyRuntimePermutationInstructions(constant, { name: 'permute', instructions: ['v128.load', 'i8x16.shuffle'] });
  assert.throws(() => verifyRuntimePermutationInstructions(constant, { name: 'permute', instructions: ['v128.load', 'v128.store'] }), /omitted i8x16.shuffle/);
});

test('runtime swizzle and disabled SIMD violate the explicit fallback contract', () => {
  for (const forbidden of fallback.forbiddenInstructions)
    assert.throws(() => verifyRuntimePermutationInstructions(fallback, { name: 'convert', instructions: ['i32.load', 'i32.and', forbidden] }), /forbidden/);
  for (const feature of ['disabled', 'default'])
    assert.throws(() => verifyRuntimePermutationInstructions({ ...fallback, feature },
      { name: 'convert', instructions: ['i32.load', 'i32.and', 'v128.store'] }), /encoded SIMD/);
});

test('truncated WAT and instruction proofs for another symbol fail', () => {
  for (const wat of ['(module (func $convert (i32.load)', '(module (func $convert "unterminated)', '(module (; comment'])
    assert.throws(() => permutationWatInstructions(wat, 'convert'), /Unterminated/);
  assert.throws(() => verifyRuntimePermutationInstructions(fallback, { name: 'unrelated', instructions: ['i32.load', 'i32.and'] }), /another function/);
});

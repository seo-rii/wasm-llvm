import assert from 'node:assert/strict';

export const DCE = 'compiler/ir/backend.js/src/org/jetbrains/kotlin/ir/backend/js/dce/UsefulDeclarationProcessor.kt';
export const INLINING = 'compiler/ir/ir.inline/src/org/jetbrains/kotlin/ir/inline/FunctionInlining.kt';
export const PARTIAL_LINKAGE = 'compiler/ir/serialization.common/src/org/jetbrains/kotlin/backend/common/linkage/partial/PartiallyLinkedIrTreePatcher.kt';
export const INCORPORATOR = 'compiler/resolution.common/src/org/jetbrains/kotlin/resolve/calls/inference/components/ConstraintIncorporator.kt';
export const TYPE_CHECKER = 'core/compiler.common/src/org/jetbrains/kotlin/types/AbstractTypeChecker.kt';
export const SUBTYPE_PATH = 'core/descriptors/src/org/jetbrains/kotlin/types/checker/utils.kt';
export const TARGETS = [DCE, INLINING, PARTIAL_LINKAGE, INCORPORATOR, TYPE_CHECKER, SUBTYPE_PATH];

const change = (before, after, occurrences = 1) => ({ before, after, occurrences });
const dequeImport = original => change(original, 'import kotlin.collections.ArrayDeque\n');
export const RECIPES = [
  { path: DCE, changes: [
    dequeImport('import java.util.*\n'),
    change('val declaration = queue.pollFirst()', 'val declaration = queue.removeFirstOrNull()!!'),
  ] },
  { path: INLINING, changes: [
    dequeImport('import java.util.ArrayDeque\n'),
    change('currentFileEntry = fileEntriesStack.getLast(),', 'currentFileEntry = fileEntriesStack.last(),'),
  ] },
  { path: PARTIAL_LINKAGE, changes: [
    dequeImport('import java.util.*\n'),
    change('stack.push(context)', 'stack.addFirst(context)'),
    change('assert(stack.pop() === context)', 'assert(stack.removeFirst() === context)'),
    change('stack.peek().scheduleForRemoval(this)', 'stack.firstOrNull()!!.scheduleForRemoval(this)'),
    change('stack.peek() ?: ReturnTargetContext.Empty', 'stack.firstOrNull() ?: ReturnTargetContext.Empty'),
    change('stack.push(newContext)', 'stack.addFirst(newContext)'),
    change('assert(stack.pop() == newContext)', 'assert(stack.removeFirst() == newContext)'),
  ] },
  { path: INCORPORATOR, changes: [
    dequeImport('import java.util.*\n'),
    change('stack.push(c.createTypeArgument(this.lowerBound(), TypeVariance.INV))',
      'stack.addFirst(c.createTypeArgument(this.lowerBound(), TypeVariance.INV))'),
    change('stack.push(c.createTypeArgument(this.upperBound(), TypeVariance.INV))',
      'stack.addFirst(c.createTypeArgument(this.upperBound(), TypeVariance.INV))'),
    change('stack.push(c.createTypeArgument(this, TypeVariance.INV))',
      'stack.addFirst(c.createTypeArgument(this, TypeVariance.INV))', 2),
    change('val typeProjection = stack.pop()', 'val typeProjection = stack.removeFirst()'),
  ] },
  { path: TYPE_CHECKER, changes: [
    dequeImport('import java.util.*\n'),
    change('deque.push(start)', 'deque.addFirst(start)'),
    change('val current = deque.pop()', 'val current = deque.removeFirst()'),
  ] },
  { path: SUBTYPE_PATH, changes: [
    dequeImport('import java.util.*\n'),
    change('val lastPathNode = queue.poll()', 'val lastPathNode = queue.removeFirstOrNull()!!'),
  ] },
];

// Apply only to the six complete pinned compiler files. The source preparation
// layer authenticates both full inputs and outputs, including every untouched
// byte. User Kotlin never enters this transform. In particular, existing add()
// calls remain tail insertions while push() remains a head insertion.
export function transformCommonDequeApi(logical, bytes, { reverse = false } = {}) {
  const recipe = RECIPES.find(row => row.path === logical);
  assert(recipe, 'Common deque adaptation requires one of six complete compiler sources');
  assert(Buffer.isBuffer(bytes), 'Common deque source must be a byte buffer');
  let text = bytes.toString('utf8');
  assert.deepEqual(Buffer.from(text), bytes, 'Common deque source must be valid UTF-8');
  for (const row of reverse ? [...recipe.changes].reverse() : recipe.changes) {
    const from = reverse ? row.after : row.before, to = reverse ? row.before : row.after;
    assert(from && to && text.split(from).length - 1 === row.occurrences,
      'Exact common deque transform span/count changed: ' + logical + ': ' + from.slice(0, 90));
    assert(!text.includes(to), 'Common deque replacement already present: ' + logical);
    text = text.split(from).join(to);
  }
  return Buffer.from(text);
}

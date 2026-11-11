import assert from 'node:assert/strict';

// Real Kotlin programs exercise the official frontend, inliner and DCE. These
// fixtures are observations, not a replacement compiler or a language subset.
export const fixtures = [
  { id: 'diamond-generics', files: { 'Main.kt': `
interface Root<out T> { fun value(): T }
interface Left<out T> : Root<T>
interface Right<out T> : Root<T>
class Leaf : Left<String>, Right<String> { override fun value() = "leaf" }
fun <T> merge(first: T, second: T): List<T> = listOf(first, second)
fun <T> read(root: Root<T>): T = root.value()
fun main() { println(read(Leaf())); println(merge(1, 2.5).joinToString("|")) }
` }, stdout: 'leaf\n1|2.5\n' },
  { id: 'inline-nonlocal', files: { 'Helpers.kt': `
inline fun <T> around(block: () -> T): T = block()
inline fun visit(items: List<Int>, action: (Int) -> Unit) { for (item in items) action(item) }
`, 'Main.kt': `
fun search(): Int = around { visit(listOf(1, 2, 3)) { value -> if (value == 2) return value * 10 }; -1 }
fun main() { println(search()); println(around { around { 7 } }) }
` }, stdout: '20\n7\n' },
  { id: 'dce-side-effects', files: { 'Main.kt': `
var count = 0
open class Base { open fun value(): String = "base" }
class Used : Base() { override fun value(): String { count++; return "used" } }
class Unused : Base() { override fun value(): String = error("dead class") }
fun dead(): Nothing = error("dead function")
fun main() { val value: Base = Used(); println(value.value()); println(count) }
` }, stdout: 'used\n1\n' },
  { id: 'recursive-constraints', files: { 'Main.kt': `
interface Item<T : Item<T>> { fun next(): T; fun label(): String }
class Node(private val value: Int) : Item<Node> {
  override fun next() = Node(value + 1)
  override fun label() = "node:" + value
}
fun <T : Item<T>> follow(item: T): T = item.next().next()
fun <T> choose(first: T, second: T, pickFirst: Boolean): T = if (pickFirst) first else second
fun main() { println(follow(Node(3)).label()); println(choose(listOf("a"), setOf("b"), false).joinToString()) }
` }, stdout: 'node:5\nb\n' },
  { id: 'stdin-recovery', files: { 'Main.kt': `
var calls = 0
fun main() { calls++; println("read:" + readln()); println("eof:" + (readlnOrNull() == null)); println("calls:" + calls) }
` }, stdin: '한글 input\n', stdout: 'read:한글 input\neof:true\ncalls:1\n' },
  { id: 'caught-exception', files: { 'Main.kt': `
inline fun <T> attempt(block: () -> T): T = block()
fun main() { try { attempt { error("expected") } } catch (failure: IllegalStateException) { println(failure.message) }; println("after") }
` }, stdout: 'expected\nafter\n' },
  { id: 'uncaught-exception', files: { 'Main.kt': 'fun main() { println("before"); error("expected") }\n' },
    stdout: 'before\n', runtimeError: true },
  { id: 'invalid-generic', files: { 'Main.kt': 'fun <T : Number> number(value: T) = value\nfun main() { println(number("wrong")) }\n' },
    compileError: true },
];

export function verifyResult(fixture, result) {
  assert.equal(result.stdout, fixture.stdout, fixture.id + ': stdout');
  assert.equal(result.stderr, '', fixture.id + ': stderr');
  assert.equal(result.outputLimitExceeded, false);
  if (fixture.runtimeError) {
    assert.equal(result.status, 'runtime-error'); assert.equal(result.exitCode, null);
    assert.equal(typeof result.error, 'string'); assert(result.error.length > 0);
  } else {
    assert.equal(result.status, 'completed'); assert.equal(result.exitCode, 0);
    assert.equal(result.error, undefined);
  }
}

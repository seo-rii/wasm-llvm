import assert from 'node:assert/strict';

// These are complete user programs. Compiler detector/wrapper source is never
// projected, synthesized or edited by this fixture catalog.
export const fixtures = [
  { id: 'no-arg', files: { 'Main.kt': 'var calls = 0\nfun main() { calls++; println("no-arg:$calls") }\n' }, stdout: 'no-arg:1\n' },
  { id: 'args', files: { 'Main.kt': 'fun main(args: Array<String>) { println("args:${args.size}") }\n' }, stdout: 'args:0\n' },
  { id: 'suspend-no-arg', files: { 'Main.kt': 'suspend fun main() { println("suspend-no-arg") }\n' }, stdout: 'suspend-no-arg\n' },
  { id: 'suspend-resume-args', files: { 'Main.kt': `import kotlin.coroutines.*
suspend fun value(): Int = suspendCoroutine { continuation -> continuation.resume(42) }
suspend fun main(args: Array<String>) { val value = value(); println("suspend:" + args.size + ":" + value) }
` }, stdout: 'suspend:0:42\n' },
  { id: 'suspend-caught', files: { 'Main.kt': `import kotlin.coroutines.*
suspend fun fail(): Unit = suspendCoroutine { continuation -> continuation.resumeWithException(IllegalStateException("entry-failure")) }
suspend fun main() { try { fail() } catch (error: IllegalStateException) { println("caught:" + error.message) } }
` }, stdout: 'caught:entry-failure\n' },
  { id: 'suspend-uncaught', files: { 'Main.kt': `import kotlin.coroutines.*
suspend fun fail(): Unit = suspendCoroutine { continuation -> continuation.resumeWithException(IllegalStateException("entry-failure")) }
suspend fun main() { println("before-failure"); fail(); println("unreachable") }
` }, stdout: 'before-failure\n', runtimeError: 'uncaught' },
  { id: 'overloads', files: { 'Main.kt': `fun main() { println("wrong-no-arg") }
fun main(value: Int) { println("wrong-int") }
fun main(args: Array<String>) { println("overload-args:" + args.size) }
` }, stdout: 'overload-args:0\n' },
  { id: 'multi-package', files: { 'Zeta.kt': 'package zeta\nfun main() { println("wrong-zeta") }\n',
    'Alpha.kt': 'package alpha\nfun main(args: Array<String>) { println("alpha:" + args.size) }\n' }, stdout: 'alpha:0\n' },
  { id: 'same-package-overloads', files: { 'NoArgs.kt': 'package same\nfun main() { println("same-no-arg") }\n',
    'Args.kt': 'package same\nfun main(args: Array<String>) { println("same-args:" + args.size) }\n' }, runtimeError: 'duplicate-export', stdout: '' },
  { id: 'suspend-overload-ambiguity', files: { 'Main.kt': 'suspend fun main() { println("suspend") }\nfun main(args: Array<String>) { println("args") }\n' }, runtimeError: 'missing-entry', stdout: '' },
  { id: 'invalid-signature', files: { 'Main.kt': 'fun main(value: Int) { println(value) }\n' }, runtimeError: 'missing-entry', stdout: '' },
  { id: 'no-main', files: { 'Main.kt': 'fun usefulLibraryFunction(): String = "no console entry"\n' }, runtimeError: 'missing-entry', stdout: '' },
  { id: 'invalid-source', files: { 'Main.kt': 'fun main( { println("broken") }\n' }, compileError: true },
  { id: 'stdin-args', files: { 'Main.kt': 'fun main(args: Array<String>) { println("stdin:" + args.size + ":" + readln() + ":" + readlnOrNull()) }\n' },
    stdin: '한글 input\n', stdout: 'stdin:0:한글 input:null\n' },
];

export function verifyRuntimeResult(fixture, result) {
  assert.equal(result.stdout, fixture.stdout, fixture.id + ': stdout');
  assert.equal(result.stderr, '', fixture.id + ': stderr');
  assert.equal(result.outputLimitExceeded, false, fixture.id + ': output limit');
  if (fixture.runtimeError) {
    assert.equal(result.status, 'runtime-error', fixture.id); assert.equal(result.exitCode, null, fixture.id);
    assert(typeof result.error === 'string' && result.error.length > 0, fixture.id + ': real diagnostic required');
    if (fixture.runtimeError === 'missing-entry') assert.equal(result.error, 'Kotlin WASI command must export _start');
    if (fixture.runtimeError === 'duplicate-export') assert.match(result.error, /Duplicate export|duplicate export/i);
  } else {
    assert.equal(result.status, 'completed', fixture.id); assert.equal(result.exitCode, 0, fixture.id);
    assert.equal(result.error, undefined, fixture.id);
  }
}

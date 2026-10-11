import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { gitBlob, sha256, verifyFile } from '../../scripts/source.mjs';
import { COUNTER, transformCounter } from './transform.mjs';
const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(here, '../../../..');
const primaryBytes = await readFile(path.join(here, '../closure.lock.json')), primary = JSON.parse(primaryBytes);
const original = primary.files.find(pin => pin.path === COUNTER), bytes = verifyFile(await readFile(path.join(repo, 'out/kotlin-compiler-port/sources', COUNTER)), original);
const source = bytes.toString(), recipe = [];
function replace(before, after, count = 1) {
    let offset = 0, found = 0;
    while (true) { const start = source.indexOf(before, offset); if (start < 0) break;
        recipe.push({ start, before, after }); found++; offset = start + before.length; }
    assert.equal(found, count, 'Unexpected recipe count for ' + before);
}
replace('import java.lang.management.ManagementFactory\nimport java.util.*\nimport java.util.concurrent.TimeUnit\nimport java.util.concurrent.atomic.AtomicInteger\nimport java.util.concurrent.atomic.AtomicLong\n',
    'import org.jetbrains.kotlin.util.portable.PerformanceCounterWorkerLocal\nimport org.jetbrains.kotlin.util.portable.performanceCounterNanoTime\n');
replace(' * This counter is thread-safe for initialization and usage.\n', ' * This port runs synchronously in one Worker; each request needs a fresh module.\n');
replace('System.nanoTime()', 'performanceCounterNanoTime()');
replace('synchronized(allCounters)', 'run', 5);
replace('        @JvmOverloads\n', '');
replace('ThreadLocal<', 'PerformanceCounterWorkerLocal<', 3);
replace('            var value = threadLocal.get()\n            if (value == null) {\n                value = default()\n                threadLocal.set(value)\n            }\n            return value', '            val existing = threadLocal.get()\n            if (existing != null) return existing\n            val value = default()\n            threadLocal.set(value)\n            return value');
replace('TimeUnit.NANOSECONDS.toMillis(totalTimeNanos)', 'totalTimeNanos / 1_000_000L');
replace('Stack<Boolean>', 'ArrayList<Boolean>', 3);
replace('else peek()', 'else last()');
replace('return intervalUsefulTime { push(usefulCall) }', 'return intervalUsefulTime { add(usefulCall) }');
replace('assert(callStack.peek() == usefulCall)', 'assert(callStack.last() == usefulCall)');
replace('return intervalUsefulTime { pop() }', 'return intervalUsefulTime { removeAt(lastIndex) }');
recipe.sort((a,b) => a.start - b.start);
const pin = (name, bytes) => ({ path: name, bytes: bytes.length, sha256: sha256(bytes), gitBlob: gitBlob(bytes) });
const dependencies = [];
for (const name of ['prepare.mjs', 'transform.mjs', '../assertions/CompilerAssertions.kt']) dependencies.push(pin(name, await readFile(path.join(here, name))));
const lock = { schemaVersion: 1, kind: 'genuine-single-worker-performance-counter', source: primary.source,
    primaryClosureSha256: sha256(primaryBytes), original, output: pin(COUNTER, transformCounter(bytes, recipe)),
    host: pin('PerformanceCounterHost.kt', await readFile(path.join(here, 'PerformanceCounterHost.kt'))), recipe, dependencies };
await writeFile(path.join(here, 'sources.lock.json'), JSON.stringify(lock, null, 2) + '\n');
console.log(JSON.stringify({ spans: recipe.length, original: original.bytes, common: lock.output.bytes }));

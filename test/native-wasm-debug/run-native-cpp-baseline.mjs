import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNativeBaseline } from './run-native-baseline.mjs';

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));

function markerLine(source, marker) {
	const lines = source.split('\n');
	const matches = lines.flatMap((line, index) => line.endsWith(`// ${marker}`) ? [index + 1] : []);
	assert.equal(matches.length, 1, `fixture must contain exactly one ${marker} marker`);
	return matches[0];
}

export function verifyNativeContainerAdaptors(stdout) {
	const first = stdout.indexOf('stop reason = breakpoint 1.1');
	const second = stdout.indexOf('stop reason = breakpoint 2.1', first + 1);
	assert.ok(first >= 0 && second > first, 'container-adaptor fixture must reach both source breakpoints');
	const stages = [stdout.slice(first, second), stdout.slice(second)];
	const expected = [
		{ deque_stack: [1, 2, 3], vector_stack: [4, 5, 6], max_heap: [4, 1, 2],
			min_heap: [1, 4, 2], deque_heap: [1, 4, 2] },
		{ deque_stack: [1, 2], vector_stack: [4, 5, 6, 9], max_heap: [2, 1],
			min_heap: [0, 1, 2, 4], deque_heap: [1, 4, 2] }
	];
	const escaped = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	for (const [index, stage] of stages.entries()) {
		const size = (name, count) => assert.match(stage,
			new RegExp(`\\b${name} = size=${count}(?:\\s|$)`), `${name} must expose a synthetic size at stop ${index + 1}`);
		const scalar = (name) => {
			const value = stage.match(new RegExp(`^\\([^\\r\\n]+\\) ${escaped(name)} = (-?\\d+)(?:\\r?\\n|$)`, 'm'));
			assert.ok(value, `${name} must expose a synthetic scalar at stop ${index + 1}`);
			return Number(value[1]);
		};
		size('empty_stack', 0);
		size('empty_heap', 0);
		for (const [name, values] of Object.entries(expected[index])) {
			size(name, values.length);
			const actual = values.map((_, child) => scalar(`${name}[${child}]`));
			if (name.endsWith('_heap')) {
				assert.equal(actual[0], values[0], `${name} must show its comparator's top first`);
				// A heap's remaining storage is deliberately not asserted as sorted pop order.
				assert.deepEqual(actual.toSorted((left, right) => left - right), values.toSorted((left, right) => left - right));
			} else assert.deepEqual(actual, values, `${name} must follow bottom-to-top storage order`);
		}
		size('nested_stack', 1);
		size('nested_heap', 2);
		assert.equal(scalar('nested_stack[0][0]'), 7);
		assert.equal(scalar('nested_stack[0][1]'), 8);
		assert.equal(scalar('nested_heap[0][0]'), 3);
		assert.equal(scalar('nested_heap[0][1]'), 4);
		size('block_deque', 1025);
		size('large_deque', 17);
		const dequeValues = index === 0
			? { 'block_deque[0]': 5, 'block_deque[1018]': 1023, 'block_deque[1019]': 1024,
				'block_deque[1024]': 1029, 'large_deque[0].value': 10, 'large_deque[14].value': 150,
				'large_deque[15].value': 160, 'large_deque[16].value': 170 }
			: { 'block_deque[0]': 6, 'block_deque[1018]': 1024, 'block_deque[1019]': 1025,
				'block_deque[1024]': 1030, 'large_deque[0].value': 20, 'large_deque[14].value': 160,
				'large_deque[15].value': 170, 'large_deque[16].value': 180 };
		for (const [name, value] of Object.entries(dequeValues))
			assert.equal(scalar(name), value, `${name} must follow block and front-offset changes`);
	}
}

export async function runNativeCppBaseline(options) {
	const hitCount = options.kind === 'hit-count';
	const skipLibrary = options.kind === 'skip-library';
	const adaptors = options.kind === 'container-adaptors';
	const filename = hitCount ? 'hit-count.c' : skipLibrary ? 'skip-library.cpp' : adaptors ? 'container-adaptors.cpp' : 'function-end.cpp';
	const source = await readFile(path.join(fixtureRoot, filename), 'utf8');
	const location = (marker) => markerLine(source, marker);
	const commands = ['process connect -p wasm connect://127.0.0.1:1234'];
	const checks = [];
	if (adaptors) {
		for (const marker of ['adaptors first stop', 'adaptors second stop']) {
			commands.push(`breakpoint set --file ${filename} --line ${location(marker)}`);
		}
		for (const [stackCount, vectorCount, maxCount, minCount] of [[3, 3, 3, 3], [2, 4, 2, 4]]) {
			commands.push('continue', 'frame variable empty_stack empty_heap deque_stack vector_stack max_heap min_heap deque_heap nested_stack nested_heap');
			for (const [name, count] of [['deque_stack', stackCount], ['vector_stack', vectorCount],
				['max_heap', maxCount], ['min_heap', minCount], ['deque_heap', 3]]) {
				commands.push(`frame variable ${Array.from({ length: count }, (_, index) => `${name}[${index}]`).join(' ')}`);
			}
			commands.push('frame variable nested_stack[0][0] nested_stack[0][1] nested_heap[0][0] nested_heap[0][1]');
			commands.push('frame variable --depth 0 block_deque large_deque',
				'frame variable block_deque[0] block_deque[1018] block_deque[1019] block_deque[1024]',
				'frame variable large_deque[0].value large_deque[14].value large_deque[15].value large_deque[16].value');
		}
		commands.push('continue', 'quit');
	} else if (skipLibrary) {
		commands.push('settings set target.process.thread.step-avoid-regexp ^$',
			'settings show target.process.thread.step-avoid-regexp');
		for (const marker of ['library entry', 'callback call', 'comparator breakpoint', 'after call']) {
			commands.push(`breakpoint set --file ${filename} --line ${location(marker)}`);
		}
		commands.push('continue', 'thread step-in', 'thread step-out',
			'settings set target.process.thread.step-avoid-regexp ^(.* )?std::',
			'settings show target.process.thread.step-avoid-regexp',
			'thread step-in', 'frame variable left right', 'breakpoint delete 3',
			'continue', 'frame variable values', 'continue', 'quit');
		checks.push(/step-avoid-regexp \(regex\) = \^\$/, /step-avoid-regexp \(regex\) = \^\(\.\* \)\?std::/,
			/\(lldb\) thread step-in[\s\S]*?frame #0: [^\n]*`[^\n]*std::/,
			new RegExp(`stop reason = breakpoint 3\\.1[\\s\\S]*?frame #0: [^\\n]*\\x60descending\\([^\\n]* at skip-library\\.cpp:${location('comparator breakpoint')}:`),
			/\(int\[3\]\) values = \(\[0\] = 4, \[1\] = 3, \[2\] = 1\)/);
	} else if (hitCount) {
		commands.push(`breakpoint set --file ${filename} --line ${location('hit target')} --ignore-count 2`,
			'continue', 'frame variable n answer', 'continue', 'frame variable n answer', 'continue', 'quit');
		checks.push(/\(int\) n = 3\s+\(int\) answer = 13/, /\(int\) n = 4\s+\(int\) answer = 14/);
	} else {
		for (const marker of ['simple return', 'early return', 'recursive return', 'cleanup return', 'implicit last']) {
			commands.push(`breakpoint set --file ${filename} --line ${location(marker)}`);
		}
		for (const [name, answer] of [['simple', 12], ['early', 22]]) {
			commands.push('continue', 'thread step-over', 'frame variable answer', 'thread step-over');
			checks.push(new RegExp(`frame #0: [^\\n]*\\x60${name}\\([^\\n]* at function-end\\.cpp:${location(`${name} end`)}:[^\\n]*[\\s\\S]*?\\(int\\) answer = ${answer}`));
			checks.push(new RegExp(`frame #0: [^\\n]*\\x60main at function-end\\.cpp:${location(`${name} caller`)}:`));
		}
		// Step Out must return directly to the caller instead of adding a brace stop.
		commands.push('continue', 'thread step-over', 'frame variable n answer', 'thread step-out', 'frame info');
		checks.push(new RegExp(`frame #0: [^\\n]*\\x60recursive\\([^\\n]* at function-end\\.cpp:${location('recursive end')}:[^\\n]*[\\s\\S]*?\\(int\\) n = 0\\s+\\(int\\) answer = 30`));
		checks.push(new RegExp(`\\(lldb\\) thread step-out[\\s\\S]*?frame #0: [^\\n]*\\x60recursive\\(n=1\\) at function-end\\.cpp:${location('recursive call')}:`));
		for (const answer of [61, 93]) {
			commands.push('continue', 'thread step-over', 'frame variable answer', 'thread step-out');
			checks.push(new RegExp(`\\(int\\) answer = ${answer}`));
		}
		checks.push(new RegExp(`\\(lldb\\) thread step-out[\\s\\S]*?frame #0: [^\\n]*\\x60main at function-end\\.cpp:${location('recursive caller')}:`));
		commands.push('continue', 'thread step-over', 'frame variable answer', 'thread step-over',
			'continue', 'thread step-over', 'frame variable answer', 'continue', 'quit');
		for (const name of ['cleanup', 'implicit']) {
			checks.push(new RegExp(`frame #0: [^\\n]*\\x60${name}\\([^\\n]* at function-end\\.cpp:${location(`${name} end`)}:`));
		}
		checks.push(/\(int\) answer = 52/);
	}
	const temporary = await mkdtemp(path.join(tmpdir(), 'wasm-cpp-baseline-'));
	try {
		const commandsPath = path.join(temporary, 'lldb.commands');
		await writeFile(commandsPath, `${commands.join('\n')}\n`);
		const result = await runNativeBaseline({ ...options, commandsPath, cwd: fixtureRoot });
		for (const check of checks) assert.match(result.lldbStdout, check);
		if (adaptors) verifyNativeContainerAdaptors(result.lldbStdout);
		assert.match(result.lldbStdout, /Process 1 exited with status = 0/);
		if (hitCount) {
			assert.doesNotMatch(result.lldbStdout, /\(int\) n = [12](?:\s|$)/);
			assert.equal((result.lldbStdout.match(/stop reason = breakpoint/g) ?? []).length, 2);
		}
		return result;
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}

async function main() {
	const args = process.argv.slice(2);
	const options = {};
	const names = { '--iwasm': 'iwasmPath', '--lldb': 'lldbPath', '--program': 'programPath', '--kind': 'kind' };
	for (let index = 0; index < args.length; index += 2) {
		const name = names[args[index]];
		if (!name || !args[index + 1]) throw new Error('expected --iwasm PATH --lldb PATH --program PATH [--kind function-end|hit-count|skip-library|container-adaptors]');
		options[name] = args[index + 1];
	}
	for (const name of ['iwasmPath', 'lldbPath', 'programPath']) assert.ok(options[name], `${name} is required`);
	options.kind ??= 'function-end';
	assert.ok(['function-end', 'hit-count', 'skip-library', 'container-adaptors'].includes(options.kind));
	const result = await runNativeCppBaseline(options);
	process.stdout.write(result.lldbStdout);
	process.stderr.write(result.lldbStderr);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}

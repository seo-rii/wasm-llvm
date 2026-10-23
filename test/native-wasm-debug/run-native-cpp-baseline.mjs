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

export async function runNativeCppBaseline(options) {
	const hitCount = options.kind === 'hit-count';
	const skipLibrary = options.kind === 'skip-library';
	const filename = hitCount ? 'hit-count.c' : skipLibrary ? 'skip-library.cpp' : 'function-end.cpp';
	const source = await readFile(path.join(fixtureRoot, filename), 'utf8');
	const location = (marker) => markerLine(source, marker);
	const commands = ['process connect -p wasm connect://127.0.0.1:1234'];
	const checks = [];
	if (skipLibrary) {
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
		if (!name || !args[index + 1]) throw new Error('expected --iwasm PATH --lldb PATH --program PATH [--kind function-end|hit-count|skip-library]');
		options[name] = args[index + 1];
	}
	for (const name of ['iwasmPath', 'lldbPath', 'programPath']) assert.ok(options[name], `${name} is required`);
	options.kind ??= 'function-end';
	assert.ok(['function-end', 'hit-count', 'skip-library'].includes(options.kind));
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

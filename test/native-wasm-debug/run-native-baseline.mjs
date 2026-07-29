import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	DEFAULT_NATIVE_TIMEOUT_MS,
	runWithNativeWamr,
	spawnCapturedProcess,
	stopCapturedProcess,
	waitForCapturedProcess
} from './native-processes.mjs';

const DEBUG_ENDPOINT_PATTERN = /connect:\/\/(?:127\.0\.0\.1|localhost):\d+/g;

export async function runNativeBaseline(options) {
	const commandTemplate = await readFile(options.commandsPath, 'utf8');
	const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'wasm-native-debug-'));
	const commandPath = path.join(temporaryDirectory, 'lldb.commands');
	try {
		return await runWithNativeWamr(
			options,
			async ({ deadline, endpoint, environment }) => {
				let replacedEndpoints = 0;
				const commands = commandTemplate.replace(DEBUG_ENDPOINT_PATTERN, () => {
					replacedEndpoints += 1;
					return `connect://${endpoint}`;
				});
				if (replacedEndpoints === 0) {
					throw new Error(
						'LLDB command file does not contain a native WAMR connect endpoint'
					);
				}
				await writeFile(commandPath, commands);
				const lldb = spawnCapturedProcess(
					options.lldbPath,
					['-b', '-s', commandPath, path.resolve(options.programPath)],
					{ cwd: options.cwd, env: environment }
				);
				try {
					const lldbExit = await waitForCapturedProcess(
						lldb,
						'native LLDB',
						deadline
					);
					if (lldbExit.code !== 0) {
						throw new Error(
							`native LLDB exited with status ${String(lldbExit.code)}\n${lldb.stderr()}`
						);
					}
					return {
						lldbStderr: lldb.stderr(),
						lldbStdout: lldb.stdout()
					};
				} finally {
					await stopCapturedProcess(lldb);
				}
			}
		);
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

function verifyTranscriptChecks(transcript, checks) {
	for (const [pattern, message] of checks) {
		if (!pattern.test(transcript)) throw new Error(message);
	}
}

export function verifyNativeCBaseline(result) {
	verifyTranscriptChecks(result.lldbStdout, [
		[
			/breakpoint 1:.*main\.c:18/is,
			'native C baseline did not verify breakpoint resolution'
		],
		[
			/breakpoint 2:.*main\.c:27/is,
			'native C baseline did not verify compound-value breakpoint resolution'
		],
		[
			/\(DebugPair\) pair = \(left = 2, right = 6\)/,
			'native C baseline did not expose the structure fields'
		],
		[
			/\(int\) pair\.left = 2/,
			'native C baseline did not traverse the structure field'
		],
		[
			/\(int\[3\]\) values = \(\[0\] = 2, \[1\] = 4, \[2\] = 6\)/,
			'native C baseline did not expose the array elements'
		],
		[
			/\(int\) values\[1\] = 4/,
			'native C baseline did not traverse the array element'
		],
		[
			/\(int \*\) middle = 0x[0-9a-f]+/i,
			'native C baseline did not expose the pointer value'
		],
		[
			/\(int\) middle\[0\] = 4/,
			'native C baseline did not traverse the pointer pointee'
		],
		[/\(int\) n = 2/, 'native C baseline did not expose the recursive argument'],
		[/\(int\) doubled = 4/, 'native C baseline did not expose the recursive local'],
		[
			/0x[0-9a-f]+:\s+0x00000003/i,
			'native C baseline did not read Wasm linear memory'
		],
		[
			/\(volatile int\) global_bias = 3/,
			'native C baseline did not expose the global variable'
		],
		[
			/Process 1 exited with status = 0/,
			'native C baseline did not report a clean LLDB exit'
		]
	]);
	if (!/(?:^|\n)total=15(?:\n|$)/.test(result.targetStdout)) {
		throw new Error('native C baseline did not preserve target stdout');
	}
}

export function verifyNativeRustBaseline(result) {
	verifyTranscriptChecks(result.lldbStdout, [
		[
			/breakpoint 1:.*main\.rs:16/is,
			'native Rust baseline did not verify the main breakpoint'
		],
		[
			/breakpoint 2:.*main\.rs:11/is,
			'native Rust baseline did not verify the recursive breakpoint'
		],
		[/\(int\) seed = 3/, 'native Rust baseline did not expose the initialized seed'],
		[
			/\(int\) n = 2[\s\S]*?\(int\) doubled = 4[\s\S]*?\(int\) child = 5[\s\S]*?\(int\) result = 9/,
			'native Rust baseline did not expose the first recursive result'
		],
		[
			/\(int\) n = 3[\s\S]*?\(int\) doubled = 6[\s\S]*?\(int\) child = 9/,
			'native Rust baseline did not expose the caller recursive values'
		],
		[
			/Process 1 exited with status = 0/,
			'native Rust baseline did not report a clean LLDB exit'
		]
	]);
	if (!/(?:^|\n)rust-total=15(?:\n|$)/.test(result.targetStdout)) {
		throw new Error('native Rust baseline did not preserve target stdout');
	}
}

function parseCliArguments(argv) {
	const values = new Map();
	for (let index = 0; index < argv.length; index += 2) {
		const name = argv[index];
		const value = argv[index + 1];
		if (!name?.startsWith('--') || value === undefined) {
			throw new Error(
				'usage: run-native-baseline.mjs --iwasm PATH --lldb PATH --program PATH [--language c|rust] [--commands PATH] [--timeout-ms NUMBER]'
			);
		}
		values.set(name, value);
	}
	for (const required of ['--iwasm', '--lldb', '--program']) {
		if (!values.has(required)) throw new Error(`missing required argument ${required}`);
	}
	const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));
	const language = values.get('--language') ?? 'c';
	if (language !== 'c' && language !== 'rust') {
		throw new Error(`unsupported native baseline language: ${language}`);
	}
	return {
		commandsPath:
			values.get('--commands') ??
			path.join(
				fixtureDirectory,
				language === 'rust' ? 'lldb-rust.commands' : 'lldb.commands'
			),
		cwd: fixtureDirectory,
		iwasmPath: values.get('--iwasm'),
		language,
		lldbPath: values.get('--lldb'),
		programPath: values.get('--program'),
		timeoutMs: Number(values.get('--timeout-ms') ?? DEFAULT_NATIVE_TIMEOUT_MS)
	};
}

async function main() {
	const options = parseCliArguments(process.argv.slice(2));
	const result = await runNativeBaseline(options);
	if (options.language === 'rust') verifyNativeRustBaseline(result);
	else verifyNativeCBaseline(result);
	process.stdout.write(`${result.lldbStdout}\n${result.targetStdout}`);
	process.stderr.write(`${result.lldbStderr}${result.targetStderr}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
		process.exitCode = 1;
	});
}

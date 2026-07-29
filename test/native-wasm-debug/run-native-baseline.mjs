import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_TIMEOUT_MS = 30_000;
const TARGET_SHUTDOWN_GRACE_MS = 500;
const DEBUG_ENDPOINT_PATTERN = /connect:\/\/(?:127\.0\.0\.1|localhost):\d+/g;

function capturedProcess(command, args, options) {
	const child = spawn(command, args, {
		cwd: options.cwd,
		env: options.env,
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let stdout = '';
	let stderr = '';
	let spawnError;
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', (chunk) => {
		stdout += chunk;
	});
	child.stderr.on('data', (chunk) => {
		stderr += chunk;
	});
	const exit = new Promise((resolve) => {
		child.once('error', (error) => {
			spawnError = error;
		});
		child.once('close', (code, signal) => {
			resolve({ code, signal, spawnError });
		});
	});
	return {
		child,
		exit,
		stderr: () => stderr,
		stdout: () => stdout
	};
}

async function allocateDebugPort(host) {
	for (;;) {
		const port = await new Promise((resolve, reject) => {
			const server = createServer();
			server.unref();
			server.once('error', reject);
			server.listen(0, host, () => {
				const address = server.address();
				if (!address || typeof address === 'string') {
					server.close();
					reject(new Error('unable to allocate a native WAMR debug port'));
					return;
				}
				server.close((error) => {
					if (error) reject(error);
					else resolve(address.port);
				});
			});
		});
		if (port !== 1234) return port;
	}
}

function remainingTimeout(deadline) {
	return Math.max(1, deadline - Date.now());
}

async function waitForTargetReady(target, endpoint, deadline, startupGraceMs) {
	const marker = `Debug server listening on ${endpoint}`;
	await new Promise((resolve, reject) => {
		let settled = false;
		const finish = (callback) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			clearTimeout(startupGrace);
			target.child.stdout.removeListener('data', check);
			target.child.stderr.removeListener('data', check);
			callback();
		};
		const check = () => {
			if (`${target.stdout()}\n${target.stderr()}`.includes(marker)) {
				finish(resolve);
			}
		};
		const timeout = setTimeout(
			() =>
				finish(() =>
					reject(
						new Error(
							`native WAMR did not listen on ${endpoint}\n${target.stderr()}`
						)
					)
				),
			remainingTimeout(deadline)
		);
		const startupGrace = setTimeout(
			() => finish(resolve),
			Math.min(startupGraceMs, remainingTimeout(deadline))
		);
		target.child.stdout.on('data', check);
		target.child.stderr.on('data', check);
		target.exit.then(({ code, signal, spawnError }) => {
			finish(() =>
				reject(
					spawnError ??
						new Error(
							`native WAMR exited before debugger attach (status ${String(code)}, signal ${String(signal)})\n${target.stderr()}`
						)
				)
			);
		});
		check();
	});
}

async function waitForProcess(process, name, deadline) {
	let timeout;
	const outcome = await Promise.race([
		process.exit,
		new Promise((resolve) => {
			timeout = setTimeout(() => resolve({ timedOut: true }), remainingTimeout(deadline));
		})
	]);
	if (timeout !== undefined) clearTimeout(timeout);
	if ('timedOut' in outcome) {
		process.child.kill('SIGTERM');
		throw new Error(`${name} timed out`);
	}
	if (outcome.spawnError) throw outcome.spawnError;
	return outcome;
}

async function stopProcess(process) {
	if (process.child.exitCode !== null || process.child.signalCode !== null) {
		await process.exit;
		return;
	}
	process.child.kill('SIGTERM');
	let shutdownTimeout;
	const stopped = await Promise.race([
		process.exit.then(() => true),
		new Promise((resolve) => {
			shutdownTimeout = setTimeout(() => resolve(false), TARGET_SHUTDOWN_GRACE_MS);
		})
	]);
	if (shutdownTimeout !== undefined) clearTimeout(shutdownTimeout);
	if (!stopped) {
		process.child.kill('SIGKILL');
		await process.exit;
	}
}

export async function runNativeBaseline(options) {
	const host = options.host ?? '127.0.0.1';
	const port = options.port ?? (await allocateDebugPort(host));
	const endpoint = `${host}:${port}`;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const deadline = Date.now() + timeoutMs;
	const environment = { ...process.env, ...options.env };
	const commandTemplate = await readFile(options.commandsPath, 'utf8');
	let replacedEndpoints = 0;
	const commands = commandTemplate.replace(DEBUG_ENDPOINT_PATTERN, () => {
		replacedEndpoints += 1;
		return `connect://${endpoint}`;
	});
	if (replacedEndpoints === 0) {
		throw new Error('LLDB command file does not contain a native WAMR connect endpoint');
	}

	const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'wasm-native-debug-'));
	const commandPath = path.join(temporaryDirectory, 'lldb.commands');
	await writeFile(commandPath, commands);
	const target = capturedProcess(
		options.iwasmPath,
		[
			'--heap-size=1048576',
			`-g=${endpoint}`,
			path.resolve(options.programPath)
		],
		{ cwd: options.cwd, env: environment }
	);
	let lldb;
	try {
		await waitForTargetReady(
			target,
			endpoint,
			deadline,
			options.targetStartupGraceMs ?? 500
		);
		lldb = capturedProcess(
			options.lldbPath,
			['-b', '-s', commandPath, path.resolve(options.programPath)],
			{ cwd: options.cwd, env: environment }
		);
		const lldbExit = await waitForProcess(lldb, 'native LLDB', deadline);
		if (lldbExit.code !== 0) {
			throw new Error(
				`native LLDB exited with status ${String(lldbExit.code)}\n${lldb.stderr()}`
			);
		}
		const targetExit = await waitForProcess(target, 'native WAMR', deadline);
		if (targetExit.code !== 0) {
			throw new Error(
				`native WAMR exited with status ${String(targetExit.code)}\n${target.stderr()}`
			);
		}
		return {
			lldbStderr: lldb.stderr(),
			lldbStdout: lldb.stdout(),
			port,
			targetStderr: target.stderr(),
			targetStdout: target.stdout()
		};
	} finally {
		if (lldb) await stopProcess(lldb);
		await stopProcess(target);
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

export function verifyNativeCBaseline(result) {
	const checks = [
		[
			/breakpoint 1:.*main\.c:13/is,
			'native C baseline did not verify breakpoint resolution'
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
	];
	for (const [pattern, message] of checks) {
		if (!pattern.test(result.lldbStdout)) throw new Error(message);
	}
	if (!/(?:^|\n)total=15(?:\n|$)/.test(result.targetStdout)) {
		throw new Error('native C baseline did not preserve target stdout');
	}
}

function parseCliArguments(argv) {
	const values = new Map();
	for (let index = 0; index < argv.length; index += 2) {
		const name = argv[index];
		const value = argv[index + 1];
		if (!name?.startsWith('--') || value === undefined) {
			throw new Error(
				'usage: run-native-baseline.mjs --iwasm PATH --lldb PATH --program PATH [--commands PATH] [--timeout-ms NUMBER]'
			);
		}
		values.set(name, value);
	}
	for (const required of ['--iwasm', '--lldb', '--program']) {
		if (!values.has(required)) throw new Error(`missing required argument ${required}`);
	}
	const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));
	return {
		commandsPath:
			values.get('--commands') ?? path.join(fixtureDirectory, 'lldb.commands'),
		cwd: fixtureDirectory,
		iwasmPath: values.get('--iwasm'),
		lldbPath: values.get('--lldb'),
		programPath: values.get('--program'),
		timeoutMs: Number(values.get('--timeout-ms') ?? DEFAULT_TIMEOUT_MS)
	};
}

async function main() {
	const result = await runNativeBaseline(parseCliArguments(process.argv.slice(2)));
	verifyNativeCBaseline(result);
	process.stdout.write(`${result.lldbStdout}\n${result.targetStdout}`);
	process.stderr.write(`${result.lldbStderr}${result.targetStderr}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
		process.exitCode = 1;
	});
}

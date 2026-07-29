import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';

export const DEFAULT_NATIVE_TIMEOUT_MS = 30_000;
const PROCESS_SHUTDOWN_GRACE_MS = 500;

export function spawnCapturedProcess(command, args, options) {
	const child = spawn(command, args, {
		cwd: options.cwd,
		env: options.env,
		stdio: [options.stdin ?? 'ignore', 'pipe', 'pipe']
	});
	let stdout = '';
	let stderr = '';
	let spawnError;
	if (options.stdoutEncoding !== null) child.stdout.setEncoding('utf8');
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

export function remainingNativeTimeout(deadline) {
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
			remainingNativeTimeout(deadline)
		);
		const startupGrace = setTimeout(
			() => finish(resolve),
			Math.min(startupGraceMs, remainingNativeTimeout(deadline))
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

export async function waitForCapturedProcess(process, name, deadline) {
	let timeout;
	const outcome = await Promise.race([
		process.exit,
		new Promise((resolve) => {
			timeout = setTimeout(
				() => resolve({ timedOut: true }),
				remainingNativeTimeout(deadline)
			);
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

export async function stopCapturedProcess(process) {
	if (process.child.exitCode !== null || process.child.signalCode !== null) {
		await process.exit;
		return;
	}
	process.child.kill('SIGTERM');
	let shutdownTimeout;
	const stopped = await Promise.race([
		process.exit.then(() => true),
		new Promise((resolve) => {
			shutdownTimeout = setTimeout(() => resolve(false), PROCESS_SHUTDOWN_GRACE_MS);
		})
	]);
	if (shutdownTimeout !== undefined) clearTimeout(shutdownTimeout);
	if (!stopped) {
		process.child.kill('SIGKILL');
		await process.exit;
	}
}

export async function runWithNativeWamr(options, runClient) {
	const host = options.host ?? '127.0.0.1';
	const port = options.port ?? (await allocateDebugPort(host));
	const endpoint = `${host}:${port}`;
	const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_NATIVE_TIMEOUT_MS);
	const environment = { ...process.env, ...options.env };
	const target = spawnCapturedProcess(
		options.iwasmPath,
		[
			'--heap-size=1048576',
			`-g=${endpoint}`,
			path.resolve(options.programPath)
		],
		{ cwd: options.cwd, env: environment }
	);
	try {
		await waitForTargetReady(
			target,
			endpoint,
			deadline,
			options.targetStartupGraceMs ?? 500
		);
		const clientResult = await runClient({
			deadline,
			endpoint,
			environment,
			port
		});
		const targetExit = await waitForCapturedProcess(target, 'native WAMR', deadline);
		const allowedTargetExitCodes = options.allowedTargetExitCodes ?? [0];
		if (!allowedTargetExitCodes.includes(targetExit.code)) {
			throw new Error(
				`native WAMR exited with status ${String(targetExit.code)}\n${target.stderr()}`
			);
		}
		return {
			...clientResult,
			port,
			targetExitCode: targetExit.code,
			targetStderr: target.stderr(),
			targetStdout: target.stdout()
		};
	} finally {
		await stopCapturedProcess(target);
	}
}

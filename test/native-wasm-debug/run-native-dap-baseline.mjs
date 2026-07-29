import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	DEFAULT_NATIVE_TIMEOUT_MS,
	remainingNativeTimeout,
	runWithNativeWamr,
	spawnCapturedProcess,
	stopCapturedProcess,
	waitForCapturedProcess
} from './native-processes.mjs';

function encodeDapMessage(message) {
	const body = Buffer.from(JSON.stringify(message));
	return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

class NativeDapClient {
	constructor(input, output, deadline) {
		this.input = input;
		this.output = output;
		this.deadline = deadline;
		this.buffer = Buffer.alloc(0);
		this.nextSequence = 1;
		this.pending = new Map();
		this.queuedEvents = new Map();
		this.eventWaiters = new Map();
		this.history = [];
		this.closed = false;
		this.onData = (chunk) => this.receive(chunk);
		this.onEnd = () => this.close(new Error('native lldb-dap closed its stdout'));
		input.on('data', this.onData);
		input.on('end', this.onEnd);
		input.on('error', this.onEnd);
	}

	request(command, args = {}) {
		if (this.closed) return Promise.reject(new Error('native lldb-dap client is closed'));
		const seq = this.nextSequence++;
		const request = {
			seq,
			type: 'request',
			command,
			arguments: args
		};
		this.history.push({ direction: 'send', message: request });
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(seq);
				reject(new Error(`native lldb-dap ${command} request timed out`));
			}, remainingNativeTimeout(this.deadline));
			this.pending.set(seq, {
				command,
				resolve: (body) => {
					clearTimeout(timeout);
					resolve(body);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				}
			});
			this.output.write(encodeDapMessage(request), (error) => {
				if (!error) return;
				const pending = this.pending.get(seq);
				this.pending.delete(seq);
				pending?.reject(error);
			});
		});
	}

	waitForEvent(event) {
		const queued = this.queuedEvents.get(event);
		if (queued?.length) return Promise.resolve(queued.shift());
		if (this.closed) return Promise.reject(new Error('native lldb-dap client is closed'));
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				const waiters = this.eventWaiters.get(event) ?? [];
				const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
				if (index >= 0) waiters.splice(index, 1);
				reject(new Error(`native lldb-dap ${event} event timed out`));
			}, remainingNativeTimeout(this.deadline));
			const waiters = this.eventWaiters.get(event) ?? [];
			waiters.push({
				resolve: (body) => {
					clearTimeout(timeout);
					resolve(body);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				}
			});
			this.eventWaiters.set(event, waiters);
		});
	}

	receive(chunk) {
		this.buffer = Buffer.concat([
			this.buffer,
			Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
		]);
		for (;;) {
			const boundary = this.buffer.indexOf('\r\n\r\n');
			if (boundary < 0) return;
			const header = this.buffer.subarray(0, boundary).toString('ascii');
			const match = /(?:^|\r\n)Content-Length:\s*(\d+)(?:\r\n|$)/i.exec(header);
			if (!match) {
				this.close(new Error('native lldb-dap frame is missing Content-Length'));
				return;
			}
			const length = Number(match[1]);
			const bodyStart = boundary + 4;
			if (this.buffer.length < bodyStart + length) return;
			let message;
			try {
				message = JSON.parse(
					this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8')
				);
			} catch (error) {
				this.close(
					error instanceof Error
						? error
						: new Error('native lldb-dap emitted invalid JSON')
				);
				return;
			}
			this.buffer = this.buffer.subarray(bodyStart + length);
			this.history.push({ direction: 'receive', message });
			this.dispatch(message);
		}
	}

	dispatch(message) {
		if (message.type === 'response') {
			const pending = this.pending.get(message.request_seq);
			if (!pending) return;
			this.pending.delete(message.request_seq);
			if (message.success === false) {
				pending.reject(
					new Error(
						`native lldb-dap ${pending.command} failed: ${message.message ?? 'unknown adapter error'}`
					)
				);
			} else {
				pending.resolve(message.body ?? {});
			}
			return;
		}
		if (message.type !== 'event' || typeof message.event !== 'string') return;
		const waiters = this.eventWaiters.get(message.event);
		const waiter = waiters?.shift();
		if (waiter) {
			waiter.resolve(message.body ?? {});
			return;
		}
		const queued = this.queuedEvents.get(message.event) ?? [];
		queued.push(message.body ?? {});
		this.queuedEvents.set(message.event, queued);
	}

	close(error = new Error('native lldb-dap client closed')) {
		if (this.closed) return;
		this.closed = true;
		this.input.removeListener('data', this.onData);
		this.input.removeListener('end', this.onEnd);
		this.input.removeListener('error', this.onEnd);
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
		for (const waiters of this.eventWaiters.values()) {
			for (const waiter of waiters) waiter.reject(error);
		}
		this.eventWaiters.clear();
	}
}

function protocolSequence(history) {
	const sequence = [];
	for (const { direction, message } of history) {
		if (direction === 'send' && message.type === 'request') {
			if (message.command === 'initialize' || message.command === 'attach') {
				sequence.push(message.command);
			}
			continue;
		}
		if (direction !== 'receive') continue;
		if (message.type === 'event') {
			if (
				[
					'initialized',
					'stopped',
					'continued',
					'exited',
					'terminated'
				].includes(message.event)
			) {
				sequence.push(message.event);
			}
			continue;
		}
		if (message.type !== 'response' || message.success === false) continue;
		if (message.command === 'attach') sequence.push('attach-response');
		else if (
			['configurationDone', 'threads', 'stackTrace', 'continue', 'disconnect'].includes(
				message.command
			)
		) {
			sequence.push(message.command);
		}
	}
	return sequence;
}

export async function runNativeDapBaseline(options) {
	return runWithNativeWamr(
		options,
		async ({ deadline, endpoint, environment }) => {
			const adapter = spawnCapturedProcess(options.lldbDapPath, [], {
				cwd: options.cwd,
				env: environment,
				stdin: 'pipe',
				stdoutEncoding: null
			});
			const client = new NativeDapClient(
				adapter.child.stdout,
				adapter.child.stdin,
				deadline
			);
			try {
				await client.request('initialize', {
					clientID: 'wasm-llvm-native-baseline',
					clientName: 'wasm-llvm native baseline',
					adapterID: 'lldb',
					pathFormat: 'path',
					linesStartAt1: true,
					columnsStartAt1: true,
					supportsRunInTerminalRequest: false
				});
				let attachSettled = false;
				const programPath = path.resolve(options.programPath);
				const quotedProgramPath = `"${programPath
					.replaceAll('\\', '\\\\')
					.replaceAll('"', '\\"')}"`;
				const attach = client
					.request('attach', {
						stopOnEntry: true,
						attachCommands: [
							`target create ${quotedProgramPath}`,
							`process connect -p wasm connect://${endpoint}`
						]
					})
					.finally(() => {
						attachSettled = true;
					});
				await client.waitForEvent('initialized');
				if (attachSettled) {
					throw new Error(
						'native lldb-dap attach response arrived before configurationDone'
					);
				}
				await client.request('configurationDone');
				await attach;
				const stopped = await client.waitForEvent('stopped');
				const threadsResponse = await client.request('threads');
				const threads = threadsResponse.threads ?? [];
				const threadId = stopped.threadId ?? threads[0]?.id;
				if (!Number.isInteger(threadId)) {
					throw new Error('native lldb-dap stopped without a thread ID');
				}
				const stackResponse = await client.request('stackTrace', {
					threadId,
					startFrame: 0,
					levels: 20
				});
				const continued = client.waitForEvent('continued');
				const exited = client.waitForEvent('exited');
				const terminated = client.waitForEvent('terminated');
				await client.request('continue', { threadId });
				await continued;
				const exitEvent = await exited;
				await terminated;
				await client.request('disconnect', {
					restart: false,
					terminateDebuggee: false
				});
				adapter.child.stdin.end();
				const adapterExit = await waitForCapturedProcess(
					adapter,
					'native lldb-dap',
					deadline
				);
				if (adapterExit.code !== 0) {
					throw new Error(
						`native lldb-dap exited with status ${String(adapterExit.code)}\n${adapter.stderr()}`
					);
				}
				return {
					dapStderr: adapter.stderr(),
					exitCode: exitEvent.exitCode,
					sequence: protocolSequence(client.history),
					stackFrames: stackResponse.stackFrames ?? [],
					threads
				};
			} finally {
				client.close();
				adapter.child.stdin.end();
				await stopCapturedProcess(adapter);
			}
		}
	);
}

export function verifyNativeDapBaseline(result) {
	if (!result.stackFrames.some((frame) => frame.name === '_start')) {
		throw new Error('native DAP baseline did not expose the _start frame');
	}
	if (!result.threads.some((thread) => Number.isInteger(thread.id))) {
		throw new Error('native DAP baseline did not expose a target thread');
	}
	if (result.exitCode !== 0) {
		throw new Error(`native DAP baseline exited with status ${String(result.exitCode)}`);
	}
	if (!/(?:^|\n)total=15(?:\n|$)/.test(result.targetStdout)) {
		throw new Error('native DAP baseline did not preserve target stdout');
	}
	const requiredSteps = [
		'initialize',
		'attach',
		'initialized',
		'stopped',
		'configurationDone',
		'attach-response',
		'threads',
		'stackTrace',
		'continue',
		'continued',
		'exited',
		'terminated',
		'disconnect'
	];
	const positions = new Map(
		requiredSteps.map((step) => [step, result.sequence.indexOf(step)])
	);
	for (const [step, index] of positions) {
		if (index < 0) {
			throw new Error(`native DAP baseline did not preserve the ${step} sequence`);
		}
	}
	for (const [before, after] of [
		['initialize', 'attach'],
		['attach', 'initialized'],
		['initialized', 'stopped'],
		['initialized', 'configurationDone'],
		['configurationDone', 'attach-response'],
		['stopped', 'threads'],
		['attach-response', 'threads'],
		['threads', 'stackTrace'],
		['stackTrace', 'continue'],
		['stackTrace', 'continued'],
		['continue', 'exited'],
		['continued', 'exited'],
		['exited', 'terminated'],
		['terminated', 'disconnect']
	]) {
		if (positions.get(before) >= positions.get(after)) {
			throw new Error(
				`native DAP baseline did not preserve the ${before} before ${after} sequence`
			);
		}
	}
}

export async function runNativeDapBaselines(options, repeat = 1) {
	if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100) {
		throw new Error('native DAP repeat count must be an integer between 1 and 100');
	}
	const results = [];
	for (let iteration = 0; iteration < repeat; iteration += 1) {
		const result = await runNativeDapBaseline(options);
		verifyNativeDapBaseline(result);
		results.push(result);
	}
	return results;
}

function parseCliArguments(argv) {
	const values = new Map();
	for (let index = 0; index < argv.length; index += 2) {
		const name = argv[index];
		const value = argv[index + 1];
		if (!name?.startsWith('--') || value === undefined) {
			throw new Error(
				'usage: run-native-dap-baseline.mjs --iwasm PATH --lldb-dap PATH --program PATH [--repeat NUMBER] [--timeout-ms NUMBER]'
			);
		}
		values.set(name, value);
	}
	for (const required of ['--iwasm', '--lldb-dap', '--program']) {
		if (!values.has(required)) throw new Error(`missing required argument ${required}`);
	}
	return {
		cwd: path.dirname(fileURLToPath(import.meta.url)),
		iwasmPath: values.get('--iwasm'),
		lldbDapPath: values.get('--lldb-dap'),
		programPath: values.get('--program'),
		repeat: Number(values.get('--repeat') ?? 1),
		timeoutMs: Number(values.get('--timeout-ms') ?? DEFAULT_NATIVE_TIMEOUT_MS)
	};
}

async function main() {
	const options = parseCliArguments(process.argv.slice(2));
	const results = await runNativeDapBaselines(options, options.repeat);
	let output = results[0];
	if (results.length > 1) {
		output = { iterations: results.length, results };
	}
	process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
		process.exitCode = 1;
	});
}

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
			[
				'configurationDone',
				'continue',
				'disconnect',
				'next',
				'scopes',
				'setBreakpoints',
				'stackTrace',
				'threads',
				'variables'
			].includes(message.command)
		) {
			sequence.push(message.command);
		}
	}
	return sequence;
}

async function startNativeDapAttach(client, options, endpoint) {
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
	return { attach };
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
				const { attach } = await startNativeDapAttach(
					client,
					options,
					endpoint
				);
				const sourcePath = options.sourcePath ?? '/workspace/main.c';
				const breakpointLine = options.breakpointLine ?? 27;
				const breakpointResponse = await client.request('setBreakpoints', {
					source: {
						name: path.basename(sourcePath),
						path: sourcePath
					},
					breakpoints: [{ line: breakpointLine }],
					sourceModified: false
				});
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
				const breakpointContinued = client.waitForEvent('continued');
				const breakpointStopped = client.waitForEvent('stopped');
				await client.request('continue', { threadId });
				await breakpointContinued;
				const breakpointStoppedEvent = await breakpointStopped;
				const breakpointThreadId = breakpointStoppedEvent.threadId ?? threadId;
				const breakpointStackResponse = await client.request('stackTrace', {
					threadId: breakpointThreadId,
					startFrame: 0,
					levels: 20
				});
				const breakpointStackFrames =
					breakpointStackResponse.stackFrames ?? [];
				const breakpointFrameId = breakpointStackFrames[0]?.id;
				if (!Number.isInteger(breakpointFrameId)) {
					throw new Error(
						'native lldb-dap source breakpoint stopped without a frame ID'
					);
				}
				const scopesResponse = await client.request('scopes', {
					frameId: breakpointFrameId
				});
				const scopes = scopesResponse.scopes ?? [];
				const localScope =
					scopes.find((scope) => /^locals$/i.test(scope.name)) ??
					scopes.find(
						(scope) =>
							scope.expensive !== true &&
							Number.isInteger(scope.variablesReference) &&
							scope.variablesReference > 0
					);
				let localVariables = [];
				if (
					Number.isInteger(localScope?.variablesReference) &&
					localScope.variablesReference > 0
				) {
					const variablesResponse = await client.request('variables', {
						variablesReference: localScope.variablesReference
					});
					localVariables = variablesResponse.variables ?? [];
				}
				const pair = localVariables.find((variable) => variable.name === 'pair');
				let pairVariables = [];
				if (
					Number.isInteger(pair?.variablesReference) &&
					pair.variablesReference > 0
				) {
					const pairResponse = await client.request('variables', {
						variablesReference: pair.variablesReference
					});
					pairVariables = pairResponse.variables ?? [];
				}
				const values = localVariables.find((variable) => variable.name === 'values');
				let valuesVariables = [];
				if (
					Number.isInteger(values?.variablesReference) &&
					values.variablesReference > 0
				) {
					const valuesResponse = await client.request('variables', {
						variablesReference: values.variablesReference
					});
					valuesVariables = valuesResponse.variables ?? [];
				}
				const continued = client.waitForEvent('continued');
				const exited = client.waitForEvent('exited');
				const terminated = client.waitForEvent('terminated');
				await client.request('continue', { threadId: breakpointThreadId });
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
					breakpoints: breakpointResponse.breakpoints ?? [],
					breakpointStackFrames,
					breakpointStopReason: breakpointStoppedEvent.reason,
					dapStderr: adapter.stderr(),
					exitCode: exitEvent.exitCode,
					localVariables,
					pairVariables,
					scopes,
					sequence: protocolSequence(client.history),
					stackFrames: stackResponse.stackFrames ?? [],
					threads,
					valuesVariables
				};
			} finally {
				client.close();
				adapter.child.stdin.end();
				await stopCapturedProcess(adapter);
			}
		}
	);
}

export async function runNativeDapTrapBaseline(options) {
	return runWithNativeWamr(
		{
			...options,
			allowedTargetExitCodes: options.allowedTargetExitCodes ?? [1]
		},
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
				const { attach } = await startNativeDapAttach(
					client,
					options,
					endpoint
				);
				const sourcePath = options.sourcePath ?? '/workspace/trap.c';
				const breakpointLine = options.breakpointLine ?? 2;
				const breakpointResponse = await client.request('setBreakpoints', {
					source: {
						name: path.basename(sourcePath),
						path: sourcePath
					},
					breakpoints: [{ line: breakpointLine }],
					sourceModified: false
				});
				await client.request('configurationDone');
				await attach;
				const entryStopped = await client.waitForEvent('stopped');
				const threadsResponse = await client.request('threads');
				const threads = threadsResponse.threads ?? [];
				const threadId = entryStopped.threadId ?? threads[0]?.id;
				if (!Number.isInteger(threadId)) {
					throw new Error('native lldb-dap trap entry stopped without a thread ID');
				}
				const entryStackResponse = await client.request('stackTrace', {
					threadId,
					startFrame: 0,
					levels: 20
				});

				const breakpointContinued = client.waitForEvent('continued');
				const breakpointStopped = client.waitForEvent('stopped');
				await client.request('continue', { threadId });
				await breakpointContinued;
				const breakpointStoppedEvent = await breakpointStopped;
				const breakpointThreadId = breakpointStoppedEvent.threadId ?? threadId;
				const breakpointStackResponse = await client.request('stackTrace', {
					threadId: breakpointThreadId,
					startFrame: 0,
					levels: 20
				});

				const stepContinued = client.waitForEvent('continued');
				const stepStopped = client.waitForEvent('stopped');
				await client.request('next', { threadId: breakpointThreadId });
				await stepContinued;
				const stepStoppedEvent = await stepStopped;
				const stepThreadId = stepStoppedEvent.threadId ?? breakpointThreadId;
				const stepStackResponse = await client.request('stackTrace', {
					threadId: stepThreadId,
					startFrame: 0,
					levels: 20
				});

				const exceptionContinued = client.waitForEvent('continued');
				const exceptionStopped = client.waitForEvent('stopped');
				await client.request('continue', { threadId: stepThreadId });
				await exceptionContinued;
				const exceptionStoppedEvent = await exceptionStopped;
				const exceptionThreadId =
					exceptionStoppedEvent.threadId ?? stepThreadId;
				const exceptionStackResponse = await client.request('stackTrace', {
					threadId: exceptionThreadId,
					startFrame: 0,
					levels: 20
				});
				const exceptionStackFrames =
					exceptionStackResponse.stackFrames ?? [];
				const exceptionFrameId = exceptionStackFrames[0]?.id;
				if (!Number.isInteger(exceptionFrameId)) {
					throw new Error(
						'native lldb-dap trap stopped without an exception frame ID'
					);
				}
				const scopesResponse = await client.request('scopes', {
					frameId: exceptionFrameId
				});
				const scopes = scopesResponse.scopes ?? [];
				const localScope =
					scopes.find((scope) => /^locals$/i.test(scope.name)) ??
					scopes.find(
						(scope) =>
							scope.expensive !== true &&
							Number.isInteger(scope.variablesReference) &&
							scope.variablesReference > 0
					);
				let localVariables = [];
				if (
					Number.isInteger(localScope?.variablesReference) &&
					localScope.variablesReference > 0
				) {
					const variablesResponse = await client.request('variables', {
						variablesReference: localScope.variablesReference
					});
					localVariables = variablesResponse.variables ?? [];
				}
				await client.request('disconnect', {
					restart: false,
					terminateDebuggee: false
				});
				adapter.child.stdin.end();
				const adapterExit = await waitForCapturedProcess(
					adapter,
					'native lldb-dap trap',
					deadline
				);
				if (adapterExit.code !== 0) {
					throw new Error(
						`native lldb-dap trap exited with status ${String(adapterExit.code)}\n${adapter.stderr()}`
					);
				}
				return {
					breakpoints: breakpointResponse.breakpoints ?? [],
					breakpointStackFrames:
						breakpointStackResponse.stackFrames ?? [],
					breakpointStopReason: breakpointStoppedEvent.reason,
					dapStderr: adapter.stderr(),
					entryStackFrames: entryStackResponse.stackFrames ?? [],
					exceptionStackFrames,
					exceptionStopReason: exceptionStoppedEvent.reason,
					localVariables,
					scopes,
					sequence: protocolSequence(client.history),
					stepStackFrames: stepStackResponse.stackFrames ?? [],
					stepStopReason: stepStoppedEvent.reason,
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
	if (
		!result.breakpoints?.some(
			(breakpoint) => breakpoint.verified === true && breakpoint.line === 27
		)
	) {
		throw new Error('native DAP baseline did not resolve the source breakpoint');
	}
	if (
		result.breakpointStopReason !== 'breakpoint' ||
		!result.breakpointStackFrames?.some(
			(frame) =>
				frame.name === 'main' &&
				frame.line === 27 &&
				frame.source?.path?.endsWith('/main.c')
		)
	) {
		throw new Error('native DAP baseline did not stop in main at the source breakpoint');
	}
	const pair = result.localVariables?.find((variable) => variable.name === 'pair');
	const values = result.localVariables?.find(
		(variable) => variable.name === 'values'
	);
	const middle = result.localVariables?.find(
		(variable) => variable.name === 'middle'
	);
	if (
		!pair ||
		!values ||
		!middle ||
		pair.variablesReference <= 0 ||
		values.variablesReference <= 0
	) {
		throw new Error('native DAP baseline did not expose the compound locals');
	}
	if (
		!result.pairVariables?.some(
			(variable) => variable.name === 'left' && variable.value === '2'
		) ||
		!result.pairVariables?.some(
			(variable) => variable.name === 'right' && variable.value === '6'
		)
	) {
		throw new Error('native DAP baseline did not expose the structure children');
	}
	for (const [name, value] of [
		['[0]', '2'],
		['[1]', '4'],
		['[2]', '6']
	]) {
		if (
			!result.valuesVariables?.some(
				(variable) => variable.name === name && variable.value === value
			)
		) {
			throw new Error('native DAP baseline did not expose the array children');
		}
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
		'setBreakpoints',
		'configurationDone',
		'attach-response',
		'threads',
		'stackTrace',
		'continue',
		'continued',
		'scopes',
		'variables',
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
		['initialized', 'setBreakpoints'],
		['setBreakpoints', 'configurationDone'],
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
	const firstStopped = result.sequence.indexOf('stopped');
	const secondStopped = result.sequence.indexOf('stopped', firstStopped + 1);
	const firstStackTrace = result.sequence.indexOf('stackTrace');
	const secondStackTrace = result.sequence.indexOf(
		'stackTrace',
		firstStackTrace + 1
	);
	const firstContinue = result.sequence.indexOf('continue');
	const secondContinue = result.sequence.indexOf('continue', firstContinue + 1);
	const firstContinued = result.sequence.indexOf('continued');
	const secondContinued = result.sequence.indexOf(
		'continued',
		firstContinued + 1
	);
	const scopes = result.sequence.indexOf('scopes');
	const firstVariables = result.sequence.indexOf('variables');
	const secondVariables = result.sequence.indexOf('variables', firstVariables + 1);
	const thirdVariables = result.sequence.indexOf(
		'variables',
		secondVariables + 1
	);
	const exited = result.sequence.indexOf('exited');
	if (
		secondStopped <= firstContinue ||
		secondStopped <= firstContinued ||
		secondStackTrace <= secondStopped ||
		scopes <= secondStackTrace ||
		firstVariables <= scopes ||
		secondVariables <= firstVariables ||
		thirdVariables <= secondVariables ||
		secondContinue <= thirdVariables ||
		secondContinued <= thirdVariables ||
		exited <= secondContinue ||
		exited <= secondContinued
	) {
		throw new Error(
			'native DAP baseline did not preserve the source-breakpoint variable sequence'
		);
	}
}

export function verifyNativeDapTrapBaseline(result) {
	if (!result.entryStackFrames?.some((frame) => frame.name === '_start')) {
		throw new Error('native DAP trap baseline did not expose the _start frame');
	}
	if (
		!result.breakpoints?.some(
			(breakpoint) => breakpoint.verified === true && breakpoint.line === 2
		)
	) {
		throw new Error('native DAP trap baseline did not resolve the source breakpoint');
	}
	if (
		result.breakpointStopReason !== 'breakpoint' ||
		!result.breakpointStackFrames?.some(
			(frame) =>
				frame.name === 'main' &&
				frame.line === 2 &&
				frame.source?.path?.endsWith('/trap.c')
		)
	) {
		throw new Error('native DAP trap baseline did not stop before the trap');
	}
	if (
		!['step', 'breakpoint'].includes(result.stepStopReason) ||
		!result.stepStackFrames?.some(
			(frame) =>
				frame.name === 'main' &&
				frame.line === 3 &&
				frame.source?.path?.endsWith('/trap.c')
		)
	) {
		throw new Error('native DAP trap baseline did not step to the trap line');
	}
	if (result.exceptionStopReason !== 'exception') {
		throw new Error('native DAP trap baseline did not report an exception stop');
	}
	if (
		!result.exceptionStackFrames?.some(
			(frame) =>
				frame.name === 'main' &&
				frame.line === 3 &&
				frame.source?.path?.endsWith('/trap.c')
		)
	) {
		throw new Error('native DAP trap baseline lost the trap source frame');
	}
	if (
		!result.localVariables?.some(
			(variable) => variable.name === 'value' && variable.value === '73'
		)
	) {
		throw new Error('native DAP trap baseline did not preserve frame locals');
	}
	if (!result.threads?.some((thread) => Number.isInteger(thread.id))) {
		throw new Error('native DAP trap baseline did not expose a target thread');
	}
	if (result.targetExitCode !== 1) {
		throw new Error(
			`native DAP trap baseline target exited with status ${String(result.targetExitCode)}`
		);
	}
	for (const step of [
		'initialize',
		'attach',
		'initialized',
		'setBreakpoints',
		'configurationDone',
		'attach-response',
		'threads',
		'next',
		'scopes',
		'variables',
		'disconnect'
	]) {
		if (!result.sequence.includes(step)) {
			throw new Error(
				`native DAP trap baseline did not preserve the ${step} sequence`
			);
		}
	}
	if (
		result.sequence.filter((step) => step === 'stopped').length < 4 ||
		result.sequence.filter((step) => step === 'continued').length < 3 ||
		result.sequence.filter((step) => step === 'stackTrace').length < 4 ||
		result.sequence.filter((step) => step === 'continue').length < 2
	) {
		throw new Error(
			'native DAP trap baseline did not preserve the stop and resume sequence'
		);
	}
	const lastStopped = result.sequence.lastIndexOf('stopped');
	const lastStackTrace = result.sequence.lastIndexOf('stackTrace');
	const scopes = result.sequence.indexOf('scopes', lastStackTrace);
	const variables = result.sequence.indexOf('variables', scopes);
	const disconnect = result.sequence.indexOf('disconnect', variables);
	if (
		lastStackTrace <= lastStopped ||
		scopes <= lastStackTrace ||
		variables <= scopes ||
		disconnect <= variables
	) {
		throw new Error(
			'native DAP trap baseline did not inspect the exception before disconnect'
		);
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
				'usage: run-native-dap-baseline.mjs --iwasm PATH --lldb-dap PATH --program PATH [--scenario variables|trap] [--source PATH] [--repeat NUMBER] [--timeout-ms NUMBER]'
			);
		}
		values.set(name, value);
	}
	for (const required of ['--iwasm', '--lldb-dap', '--program']) {
		if (!values.has(required)) throw new Error(`missing required argument ${required}`);
	}
	const scenario = values.get('--scenario') ?? 'variables';
	if (!['trap', 'variables'].includes(scenario)) {
		throw new Error(`unsupported native DAP scenario: ${scenario}`);
	}
	return {
		cwd: path.dirname(fileURLToPath(import.meta.url)),
		iwasmPath: values.get('--iwasm'),
		lldbDapPath: values.get('--lldb-dap'),
		programPath: values.get('--program'),
		repeat: Number(values.get('--repeat') ?? 1),
		scenario,
		sourcePath:
			values.get('--source') ??
			(scenario === 'trap' ? '/workspace/trap.c' : '/workspace/main.c'),
		timeoutMs: Number(values.get('--timeout-ms') ?? DEFAULT_NATIVE_TIMEOUT_MS)
	};
}

async function main() {
	const options = parseCliArguments(process.argv.slice(2));
	if (options.scenario === 'trap') {
		if (options.repeat !== 1) {
			throw new Error('native DAP trap scenario does not support --repeat');
		}
		const result = await runNativeDapTrapBaseline(options);
		verifyNativeDapTrapBaseline(result);
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		return;
	}
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

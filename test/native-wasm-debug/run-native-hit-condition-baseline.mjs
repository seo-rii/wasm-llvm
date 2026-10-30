import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeDapClient, startNativeDapAttach } from './run-native-dap-baseline.mjs';
import {
	DEFAULT_NATIVE_TIMEOUT_MS,
	runWithNativeWamr,
	spawnCapturedProcess,
	stopCapturedProcess,
	waitForCapturedProcess
} from './native-processes.mjs';

export const HIT_CONDITION_CASES = ['setting', 'clear-omitted', 'clear-empty'];

// The four calls in hit-count.c make a retained ignore count observable: an
// unpatched adapter skips the expected first/second hit instead of passing.
export async function exerciseNativeHitCondition(client, attach, options) {
	assert.ok(HIT_CONDITION_CASES.includes(options.case), 'unknown DAP hit-condition case');
	const sourcePath = options.sourcePath ?? '/workspace/hit-count.c';
	const line = options.breakpointLine ?? 6;
	const clearing = options.case !== 'setting';
	const cleared = options.case === 'clear-empty' ? { hitCondition: '' } : {};
	const updates = [];
	let breakpointId;
	async function setBreakpoint(fields) {
		const specification = { line, ...fields };
		const response = await client.request('setBreakpoints', {
			source: { name: path.basename(sourcePath), path: sourcePath },
			breakpoints: [specification],
			sourceModified: false
		});
		assert.equal(response.breakpoints?.length, 1, 'DAP must return one source breakpoint');
		const breakpoint = response.breakpoints[0];
		assert.equal(breakpoint.verified, true, 'DAP hit-condition breakpoint must resolve');
		assert.ok(Number.isInteger(breakpoint.id), 'DAP breakpoint must have an ID');
		if (breakpointId !== undefined) {
			assert.equal(breakpoint.id, breakpointId, 'updating hitCondition must preserve breakpoint ID');
		}
		breakpointId = breakpoint.id;
		updates.push({ specification, breakpoint });
	}
	await setBreakpoint({ hitCondition: clearing ? '4' : '3' });
	if (clearing) await setBreakpoint(cleared);
	await client.request('configurationDone');
	await attach;
	const entry = await client.waitForEvent('stopped');
	let threadId = entry.threadId;
	if (!Number.isInteger(threadId)) {
		const threads = await client.request('threads');
		threadId = threads.threads?.[0]?.id;
	}
	assert.ok(Number.isInteger(threadId), 'DAP entry stop must identify a thread');
	const stops = [];
	for (const expectedN of clearing ? [1, 2] : [3, 4]) {
		if (clearing && stops.length) {
			// Also clear a new pending count while stopped in an active frame.
			await setBreakpoint({ hitCondition: '4' });
			await setBreakpoint(cleared);
		}
		await client.request('continue', { threadId });
		await client.waitForEvent('continued');
		const stopped = await client.waitForEvent('stopped');
		assert.equal(stopped.reason, 'breakpoint', 'expected a real source-breakpoint stop');
		threadId = stopped.threadId ?? threadId;
		const stack = await client.request('stackTrace', { threadId, startFrame: 0, levels: 1 });
		const frame = stack.stackFrames?.[0];
		assert.ok(Number.isInteger(frame?.id), 'DAP breakpoint stop must have a frame');
		assert.equal(frame.source?.path, sourcePath, 'hit condition must stop in its fixture');
		assert.equal(frame.line, line, 'hit condition must stop on the requested source line');
		const scopes = await client.request('scopes', { frameId: frame.id });
		const locals = scopes.scopes?.find((scope) => /^locals$/i.test(scope.name));
		assert.ok(locals?.variablesReference > 0, 'DAP breakpoint stop must expose locals');
		const values = await client.request('variables', { variablesReference: locals.variablesReference });
		const n = values.variables?.find((value) => value.name === 'n')?.value;
		const answer = values.variables?.find((value) => value.name === 'answer')?.value;
		assert.equal(n, String(expectedN), `${options.case}: wrong call stopped; use a patched lldb-dap for clearing`);
		assert.equal(answer, String(expectedN + 10), 'DAP must read the live call\'s scalar local');
		stops.push({ reason: stopped.reason, frame, n, answer });
	}
	await client.request('setBreakpoints', {
		source: { name: path.basename(sourcePath), path: sourcePath },
		breakpoints: [], sourceModified: false
	});
	await client.request('continue', { threadId });
	await client.waitForEvent('continued');
	const exited = await client.waitForEvent('exited');
	await client.waitForEvent('terminated');
	assert.equal(exited.exitCode, 0, 'hit-condition fixture must complete successfully');
	return { case: options.case, breakpointId, updates, stops, exitCode: exited.exitCode };
}

export async function runNativeHitConditionBaseline(options) {
	const cases = options.case === undefined || options.case === 'all'
		? HIT_CONDITION_CASES : [options.case];
	assert.ok(cases.every((name) => HIT_CONDITION_CASES.includes(name)), 'unknown DAP hit-condition case');
	const results = [];
	for (const name of cases) {
		results.push(await runWithNativeWamr(options, async ({ deadline, endpoint, environment }) => {
			const adapter = spawnCapturedProcess(options.lldbDapPath, [], {
				cwd: options.cwd, env: environment, stdin: 'pipe', stdoutEncoding: null
			});
			const client = new NativeDapClient(adapter.child.stdout, adapter.child.stdin, deadline);
			try {
				const { attach } = await startNativeDapAttach(client, options, endpoint);
				// Keep an attach failure handled if a breakpoint assertion exits first.
				attach.catch(() => {});
				const result = await exerciseNativeHitCondition(client, attach, { ...options, case: name });
				await client.request('disconnect', { restart: false, terminateDebuggee: false });
				adapter.child.stdin.end();
				const exited = await waitForCapturedProcess(adapter, 'native lldb-dap', deadline);
				assert.equal(exited.code, 0, `native lldb-dap failed: ${adapter.stderr()}`);
				return { ...result, dapStderr: adapter.stderr(), protocol: client.history };
			} finally {
				client.close();
				adapter.child.stdin.end();
				await stopCapturedProcess(adapter);
			}
		}));
	}
	return { qualified: cases, results };
}

async function main() {
	const args = process.argv.slice(2);
	const names = { '--iwasm': 'iwasmPath', '--lldb-dap': 'lldbDapPath', '--program': 'programPath',
		'--source': 'sourcePath', '--case': 'case', '--timeout-ms': 'timeoutMs' };
	const options = { cwd: path.dirname(fileURLToPath(import.meta.url)) };
	for (let index = 0; index < args.length; index += 2) {
		assert.ok(names[args[index]] && args[index + 1],
			'usage: --iwasm PATH --lldb-dap PATH --program PATH [--case all|setting|clear-omitted|clear-empty]');
		options[names[args[index]]] = args[index + 1];
	}
	for (const name of ['iwasmPath', 'lldbDapPath', 'programPath']) assert.ok(options[name], `${name} required`);
	options.timeoutMs = Number(options.timeoutMs ?? DEFAULT_NATIVE_TIMEOUT_MS);
	assert.ok(Number.isFinite(options.timeoutMs) && options.timeoutMs > 0, 'timeout must be positive');
	process.stdout.write(`${JSON.stringify(await runNativeHitConditionBaseline(options), null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}

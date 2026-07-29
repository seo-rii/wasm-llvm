import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
	runNativeDapTrapBaseline,
	verifyNativeDapTrapBaseline
} from './native-wasm-debug/run-native-dap-baseline.mjs';

function createVerifiedTrapResult(overrides = {}) {
	return {
		breakpoints: [
			{
				id: 1,
				line: 2,
				source: { path: '/workspace/trap.c' },
				verified: true
			}
		],
		breakpointStackFrames: [
			{
				id: 20,
				name: 'main',
				source: { path: '/workspace/trap.c' },
				line: 2,
				column: 2
			}
		],
		breakpointStopReason: 'breakpoint',
		entryStackFrames: [{ id: 10, name: '_start', line: 42, column: 7 }],
		exceptionStackFrames: [
			{
				id: 30,
				name: 'main',
				source: { path: '/workspace/trap.c' },
				line: 3,
				column: 2
			}
		],
		exceptionStopReason: 'exception',
		localVariables: [
			{ name: 'value', value: '73', variablesReference: 0 }
		],
		sequence: [
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
			'stopped',
			'stackTrace',
			'next',
			'continued',
			'stopped',
			'stackTrace',
			'continue',
			'continued',
			'stopped',
			'stackTrace',
			'scopes',
			'variables',
			'disconnect'
		],
		stepStackFrames: [
			{
				id: 25,
				name: 'main',
				source: { path: '/workspace/trap.c' },
				line: 3,
				column: 2
			}
		],
		stepStopReason: 'step',
		targetExitCode: 1,
		targetStderr: '',
		targetStdout: '',
		threads: [{ id: 1, name: 'nobody' }],
		...overrides
	};
}

test('stops on a native WebAssembly trap and keeps frame locals available', async (context) => {
	const directory = await mkdtemp(path.join(tmpdir(), 'wasm-native-dap-trap-test-'));
	context.after(() => rm(directory, { recursive: true, force: true }));
	const target = path.join(directory, 'fake-iwasm.mjs');
	await writeFile(
		target,
		`#!/usr/bin/env node
const debugArgument = process.argv.find((argument) => argument.startsWith('-g='));
process.stderr.write(\`Debug server listening on \${debugArgument?.slice(3)}\\n\`);
process.on('SIGTERM', () => process.exit(0));
setTimeout(() => process.exit(1), 750);
`
	);
	await chmod(target, 0o755);
	const dap = path.join(directory, 'fake-lldb-dap.mjs');
	await writeFile(
		dap,
		`#!/usr/bin/env node
let buffer = Buffer.alloc(0);
let sequence = 1;
let attachRequest;
let state = 'entry';
let outputQueue = Promise.resolve();
function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([Buffer.from(\`Content-Length: \${body.length}\\r\\n\\r\\n\`), body]);
}
function send(message, fragmented = false) {
  const bytes = frame({ seq: sequence++, ...message });
  const chunks = fragmented ? [bytes.subarray(0, 11), bytes.subarray(11)] : [bytes];
  for (const chunk of chunks) {
    outputQueue = outputQueue.then(
      () => new Promise((resolve) => process.stdout.write(chunk, resolve))
    );
  }
}
function respond(request, body = {}) {
  send({
    type: 'response',
    request_seq: request.seq,
    success: true,
    command: request.command,
    body
  });
}
function stopped(reason) {
  send({
    type: 'event',
    event: 'stopped',
    body: { reason, threadId: 1, allThreadsStopped: true }
  }, reason === 'exception');
}
function handle(request) {
  if (request.command === 'initialize') {
    respond(request, { supportsConfigurationDoneRequest: true });
    return;
  }
  if (request.command === 'attach') {
    const commands = request.arguments?.attachCommands ?? [];
    if (!commands.some((command) => /trap program\\.wasm"$/.test(command))) process.exit(11);
    if (!commands.some((command) => /connect:\\/\\/127\\.0\\.0\\.1:\\d+/.test(command))) {
      process.exit(12);
    }
    if (request.arguments?.stopOnEntry !== true) process.exit(13);
    attachRequest = request;
    send({ type: 'event', event: 'initialized' });
    stopped('entry');
    return;
  }
  if (request.command === 'setBreakpoints') {
    if (request.arguments?.source?.path !== '/workspace/trap.c') process.exit(14);
    if (request.arguments?.breakpoints?.[0]?.line !== 2) process.exit(15);
    respond(request, {
      breakpoints: [{
        id: 1,
        verified: true,
        source: { path: '/workspace/trap.c' },
        line: 2
      }]
    });
    return;
  }
  if (request.command === 'configurationDone') {
    respond(request);
    respond(attachRequest);
    return;
  }
  if (request.command === 'threads') {
    respond(request, { threads: [{ id: 1, name: 'nobody' }] });
    return;
  }
  if (request.command === 'stackTrace') {
    const stackFrames = state === 'entry'
      ? [{ id: 10, name: '_start', line: 42, column: 7 }]
      : [{
        id: state === 'breakpoint' ? 20 : state === 'step' ? 25 : 30,
        name: 'main',
        source: { path: '/workspace/trap.c' },
        line: state === 'breakpoint' ? 2 : 3,
        column: 2
      }];
    respond(request, { stackFrames, totalFrames: stackFrames.length });
    return;
  }
  if (request.command === 'continue') {
    respond(request, { allThreadsContinued: true });
    send({ type: 'event', event: 'continued', body: { threadId: 1 } });
    if (state === 'entry') {
      state = 'breakpoint';
      stopped('breakpoint');
      return;
    }
    if (state === 'step') {
      state = 'trap';
      stopped('exception');
      return;
    }
    process.exit(16);
  }
  if (request.command === 'next') {
    if (state !== 'breakpoint') process.exit(17);
    respond(request);
    send({ type: 'event', event: 'continued', body: { threadId: 1 } });
    state = 'step';
    stopped('step');
    return;
  }
  if (request.command === 'scopes') {
    if (state !== 'trap' || request.arguments?.frameId !== 30) process.exit(18);
    respond(request, {
      scopes: [{ name: 'Locals', variablesReference: 100, expensive: false }]
    });
    return;
  }
  if (request.command === 'variables') {
    if (request.arguments?.variablesReference !== 100) process.exit(19);
    respond(request, {
      variables: [{ name: 'value', value: '73', variablesReference: 0 }]
    });
    return;
  }
  if (request.command === 'disconnect') {
    respond(request);
    outputQueue.then(() => process.exit(0));
    return;
  }
  process.exit(20);
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const boundary = buffer.indexOf('\\r\\n\\r\\n');
    if (boundary < 0) return;
    const header = buffer.subarray(0, boundary).toString();
    const match = /Content-Length:\\s*(\\d+)/i.exec(header);
    if (!match) process.exit(21);
    const length = Number(match[1]);
    const bodyStart = boundary + 4;
    if (buffer.length < bodyStart + length) return;
    const message = JSON.parse(buffer.subarray(bodyStart, bodyStart + length));
    buffer = buffer.subarray(bodyStart + length);
    handle(message);
  }
});
`
	);
	await chmod(dap, 0o755);
	const program = path.join(directory, 'trap program.wasm');
	await writeFile(program, 'fixture');

	const result = await runNativeDapTrapBaseline({
		cwd: directory,
		iwasmPath: target,
		lldbDapPath: dap,
		programPath: program,
		timeoutMs: 2_000
	});

	assert.equal(result.targetExitCode, 1);
	assert.doesNotThrow(() => verifyNativeDapTrapBaseline(result));
});

test('rejects a native trap transcript without an exception stop', () => {
	assert.throws(
		() =>
			verifyNativeDapTrapBaseline(
				createVerifiedTrapResult({ exceptionStopReason: 'breakpoint' })
			),
		/native DAP trap baseline did not report an exception stop/
	);
});

test('rejects a native trap transcript without the expected WAMR exit', () => {
	assert.throws(
		() =>
			verifyNativeDapTrapBaseline(
				createVerifiedTrapResult({ targetExitCode: 0 })
			),
		/native DAP trap baseline target exited with status 0/
	);
});

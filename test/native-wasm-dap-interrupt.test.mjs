import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
	runNativeDapInterruptBaseline,
	verifyNativeDapInterruptBaseline
} from './native-wasm-debug/run-native-dap-baseline.mjs';

function createVerifiedInterruptResult(overrides = {}) {
	return {
		breakpoints: [
			{
				id: 1,
				line: 2,
				source: { path: '/workspace/interrupt.c' },
				verified: true
			}
		],
		breakpointStackFrames: [
			{
				id: 20,
				name: 'main',
				source: { path: '/workspace/interrupt.c' },
				line: 2,
				column: 2
			}
		],
		breakpointStopReason: 'breakpoint',
		entryStackFrames: [{ id: 10, name: '_start', line: 42, column: 7 }],
		interruptStackFrames: [
			{
				id: 30,
				name: 'main',
				source: { path: '/workspace/interrupt.c' },
				line: 4,
				column: 3
			}
		],
		interruptStopReason: 'exception',
		localVariables: [
			{ name: 'value', value: '41', variablesReference: 0 }
		],
		pauseRequested: true,
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
			'pause',
			'stackTrace',
			'scopes',
			'variables',
			'disconnect'
		],
		stepStackFrames: [
			{
				id: 25,
				name: 'main',
				source: { path: '/workspace/interrupt.c' },
				line: 3,
				column: 2
			}
		],
		stepStopReason: 'step',
		targetExitCode: 0,
		targetStderr: '',
		targetStdout: '',
		targetTerminatedByRunner: true,
		threads: [{ id: 1, name: 'nobody' }],
		...overrides
	};
}

test('interrupts a running native WebAssembly target and inspects its frame', async (context) => {
	const directory = await mkdtemp(
		path.join(tmpdir(), 'wasm-native-dap-interrupt-test-')
	);
	context.after(() => rm(directory, { recursive: true, force: true }));
	const terminationFile = path.join(directory, 'target-terminated');
	const target = path.join(directory, 'fake-iwasm.mjs');
	await writeFile(
		target,
		`#!/usr/bin/env node
const { writeFileSync } = await import('node:fs');
const debugArgument = process.argv.find((argument) => argument.startsWith('-g='));
process.stderr.write(\`Debug server listening on \${debugArgument?.slice(3)}\\n\`);
process.on('SIGTERM', () => {
  writeFileSync(process.env.TARGET_TERMINATION_FILE, 'terminated');
  process.exit(0);
});
setInterval(() => {}, 1_000);
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
  const chunks = fragmented ? [bytes.subarray(0, 13), bytes.subarray(13)] : [bytes];
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
    if (!commands.some((command) => /interrupt program\\.wasm"$/.test(command))) {
      process.exit(11);
    }
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
    if (request.arguments?.source?.path !== '/workspace/interrupt.c') process.exit(14);
    if (request.arguments?.breakpoints?.[0]?.line !== 2) process.exit(15);
    respond(request, {
      breakpoints: [{
        id: 1,
        verified: true,
        source: { path: '/workspace/interrupt.c' },
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
        source: { path: '/workspace/interrupt.c' },
        line: state === 'breakpoint' ? 2 : state === 'step' ? 3 : 4,
        column: state === 'paused' ? 3 : 2
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
      state = 'running';
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
  if (request.command === 'pause') {
    if (state !== 'running' || request.arguments?.threadId !== 1) process.exit(18);
    state = 'paused';
    stopped('exception');
    respond(request);
    return;
  }
  if (request.command === 'scopes') {
    if (state !== 'paused' || request.arguments?.frameId !== 30) process.exit(19);
    respond(request, {
      scopes: [{ name: 'Locals', variablesReference: 100, expensive: false }]
    });
    return;
  }
  if (request.command === 'variables') {
    if (request.arguments?.variablesReference !== 100) process.exit(20);
    respond(request, {
      variables: [{ name: 'value', value: '41', variablesReference: 0 }]
    });
    return;
  }
  if (request.command === 'disconnect') {
    respond(request);
    outputQueue.then(() => process.exit(0));
    return;
  }
  process.exit(21);
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const boundary = buffer.indexOf('\\r\\n\\r\\n');
    if (boundary < 0) return;
    const header = buffer.subarray(0, boundary).toString();
    const match = /Content-Length:\\s*(\\d+)/i.exec(header);
    if (!match) process.exit(22);
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
	const program = path.join(directory, 'interrupt program.wasm');
	await writeFile(program, 'fixture');

	const result = await runNativeDapInterruptBaseline({
		cwd: directory,
		env: { TARGET_TERMINATION_FILE: terminationFile },
		iwasmPath: target,
		lldbDapPath: dap,
		pauseDelayMs: 1,
		programPath: program,
		timeoutMs: 2_000
	});

	assert.equal(result.targetTerminatedByRunner, true);
	assert.equal(await readFile(terminationFile, 'utf8'), 'terminated');
	assert.doesNotThrow(() => verifyNativeDapInterruptBaseline(result));
});

test('rejects an interrupt transcript without the raw exception stop', () => {
	assert.throws(
		() =>
			verifyNativeDapInterruptBaseline(
				createVerifiedInterruptResult({ interruptStopReason: 'breakpoint' })
			),
		/native DAP interrupt baseline did not report the raw exception stop/
	);
});

test('rejects an interrupt transcript not terminated by the runner', () => {
	assert.throws(
		() =>
			verifyNativeDapInterruptBaseline(
				createVerifiedInterruptResult({ targetTerminatedByRunner: false })
			),
		/native DAP interrupt baseline did not terminate the running target/
	);
});

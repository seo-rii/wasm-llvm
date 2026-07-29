import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
	runNativeDapBaselines,
	verifyNativeDapBaseline
} from './native-wasm-debug/run-native-dap-baseline.mjs';

async function createExecutable(directory, name, source) {
	const executable = path.join(directory, name);
	await writeFile(executable, `#!/usr/bin/env node\n${source}`);
	await chmod(executable, 0o755);
	return executable;
}

function createVerifiedDapResult(overrides = {}) {
	return {
		breakpoints: [
			{
				id: 1,
				line: 27,
				source: { path: '/workspace/main.c' },
				verified: true
			}
		],
		breakpointStopReason: 'breakpoint',
		breakpointStackFrames: [
			{
				id: 27,
				name: 'main',
				source: { path: '/workspace/main.c' },
				line: 27,
				column: 2
			}
		],
		exitCode: 0,
		localVariables: [
			{ name: 'pair', value: '{left = 2, right = 6}', variablesReference: 101 },
			{ name: 'values', value: 'int[3]', variablesReference: 102 },
			{ name: 'middle', value: '0x0000ffec', variablesReference: 103 }
		],
		pairVariables: [
			{ name: 'left', value: '2', variablesReference: 0 },
			{ name: 'right', value: '6', variablesReference: 0 }
		],
		port: 1234,
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
			'scopes',
			'variables',
			'variables',
			'variables',
			'continue',
			'continued',
			'exited',
			'terminated',
			'disconnect'
		],
		stackFrames: [{ id: 7, name: '_start', line: 12, column: 13 }],
		targetStderr: '',
		targetStdout: 'total=15\n',
		threads: [{ id: 1, name: 'nobody' }],
		valuesVariables: [
			{ name: '[0]', value: '2', variablesReference: 0 },
			{ name: '[1]', value: '4', variablesReference: 0 },
			{ name: '[2]', value: '6', variablesReference: 0 }
		],
		...overrides
	};
}

test('repeats the deferred native lldb-dap attach lifecycle over stdio', async (context) => {
	const directory = await mkdtemp(path.join(tmpdir(), 'wasm-native-dap-test-'));
	context.after(() => rm(directory, { recursive: true, force: true }));
	const target = await createExecutable(
		directory,
		'fake-iwasm.mjs',
		`
const debugArgument = process.argv.find((argument) => argument.startsWith('-g='));
process.stderr.write(\`Debug server listening on \${debugArgument?.slice(3)}\\n\`);
process.on('SIGTERM', () => process.exit(0));
setTimeout(() => {
  process.stdout.write('total=15\\n');
  process.exit(0);
}, 750);
`
	);
	const dap = await createExecutable(
		directory,
		'fake-lldb-dap.mjs',
		`
let buffer = Buffer.alloc(0);
let sequence = 1;
let attachRequest;
let atBreakpoint = false;
let outputQueue = Promise.resolve();
function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([Buffer.from(\`Content-Length: \${body.length}\\r\\n\\r\\n\`), body]);
}
function send(message, fragmented = false) {
  const bytes = frame({ seq: sequence++, ...message });
  const chunks = fragmented ? [bytes.subarray(0, 9), bytes.subarray(9)] : [bytes];
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
function handle(request) {
  if (request.command === 'initialize') {
    respond(request, { supportsConfigurationDoneRequest: true });
    return;
  }
  if (request.command === 'attach') {
    const commands = request.arguments?.attachCommands ?? [];
    if (!commands.some((command) => /^target create ".*program with spaces\\.wasm"$/.test(command))) {
      process.exit(11);
    }
    if (!commands.some((command) => /connect:\\/\\/127\\.0\\.0\\.1:\\d+/.test(command))) {
      process.exit(12);
    }
    if (request.arguments?.stopOnEntry !== true) process.exit(13);
    attachRequest = request;
    send({ type: 'event', event: 'initialized' });
    send({
      type: 'event',
      event: 'stopped',
      body: { reason: 'entry', threadId: 1, allThreadsStopped: true }
    }, true);
    return;
  }
  if (request.command === 'configurationDone') {
    respond(request);
    respond(attachRequest);
    return;
  }
  if (request.command === 'setBreakpoints') {
    if (request.arguments?.source?.path !== '/workspace/main.c') process.exit(16);
    if (request.arguments?.breakpoints?.[0]?.line !== 27) process.exit(17);
    respond(request, {
      breakpoints: [{
        id: 1,
        verified: true,
        source: { path: '/workspace/main.c' },
        line: 27
      }]
    });
    return;
  }
  if (request.command === 'threads') {
    respond(request, { threads: [{ id: 1, name: 'nobody' }] });
    return;
  }
  if (request.command === 'stackTrace') {
    respond(request, {
      stackFrames: atBreakpoint
        ? [{
          id: 27,
          name: 'main',
          source: { path: '/workspace/main.c' },
          line: 27,
          column: 2
        }]
        : [{
          id: 7,
          name: '_start',
          source: { path: '/workspace/crt1-command.c' },
          line: 12,
          column: 13
        }],
      totalFrames: 1
    });
    return;
  }
  if (request.command === 'scopes') {
    if (request.arguments?.frameId !== 27) process.exit(18);
    respond(request, {
      scopes: [{ name: 'Locals', variablesReference: 100, expensive: false }]
    });
    return;
  }
  if (request.command === 'variables') {
    if (request.arguments?.variablesReference === 100) {
      respond(request, {
        variables: [
          { name: 'pair', value: '{left = 2, right = 6}', variablesReference: 101 },
          { name: 'values', value: 'int[3]', variablesReference: 102 },
          { name: 'middle', value: '0x0000ffec', variablesReference: 103 }
        ]
      });
      return;
    }
    if (request.arguments?.variablesReference === 101) {
      respond(request, {
        variables: [
          { name: 'left', value: '2', variablesReference: 0 },
          { name: 'right', value: '6', variablesReference: 0 }
        ]
      });
      return;
    }
    if (request.arguments?.variablesReference === 102) {
      respond(request, {
        variables: [
          { name: '[0]', value: '2', variablesReference: 0 },
          { name: '[1]', value: '4', variablesReference: 0 },
          { name: '[2]', value: '6', variablesReference: 0 }
        ]
      });
      return;
    }
    process.exit(19);
  }
  if (request.command === 'continue') {
    send({ type: 'event', event: 'continued', body: { threadId: 1 } });
    respond(request, { allThreadsContinued: true });
    if (!atBreakpoint) {
      atBreakpoint = true;
      send({
        type: 'event',
        event: 'stopped',
        body: {
          reason: 'breakpoint',
          threadId: 1,
          allThreadsStopped: true
        }
      });
      return;
    }
    send({ type: 'event', event: 'exited', body: { exitCode: 0 } });
    send({ type: 'event', event: 'terminated' });
    return;
  }
  if (request.command === 'disconnect') {
    respond(request);
    outputQueue.then(() => process.exit(0));
    return;
  }
  process.exit(14);
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const boundary = buffer.indexOf('\\r\\n\\r\\n');
    if (boundary < 0) return;
    const header = buffer.subarray(0, boundary).toString();
    const match = /Content-Length:\\s*(\\d+)/i.exec(header);
    if (!match) process.exit(15);
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
	const program = path.join(directory, 'program with spaces.wasm');
	await writeFile(program, 'fixture');

	const results = await runNativeDapBaselines(
		{
			cwd: directory,
			iwasmPath: target,
			lldbDapPath: dap,
			programPath: program,
			timeoutMs: 2_000
		},
		3
	);

	assert.equal(results.length, 3);
	for (const result of results) {
		assert.deepEqual(result.sequence, [
			'initialize',
			'attach',
			'initialized',
			'stopped',
			'setBreakpoints',
			'configurationDone',
			'attach-response',
			'threads',
			'stackTrace',
			'continued',
			'continue',
			'stopped',
			'stackTrace',
			'scopes',
			'variables',
			'variables',
			'variables',
			'continued',
			'continue',
			'exited',
			'terminated',
			'disconnect'
		]);
		assert.doesNotThrow(() => verifyNativeDapBaseline(result));
	}
});

test('rejects invalid native DAP repeat counts before launching tools', async () => {
	await assert.rejects(
		runNativeDapBaselines({}, 0),
		/native DAP repeat count must be an integer between 1 and 100/
	);
});

test('rejects a native DAP transcript without an entry frame', () => {
	assert.throws(
		() =>
			verifyNativeDapBaseline({
				exitCode: 0,
				port: 1234,
				sequence: ['initialize', 'attach'],
				stackFrames: [],
				targetStderr: '',
				targetStdout: 'total=15\n',
				threads: [{ id: 1, name: 'nobody' }]
			}),
		/native DAP baseline did not expose the _start frame/
	);
});

test('rejects a native DAP transcript without a resolved source breakpoint', () => {
	assert.throws(
		() => verifyNativeDapBaseline(createVerifiedDapResult({ breakpoints: [] })),
		/native DAP baseline did not resolve the source breakpoint/
	);
});

test('rejects a native DAP transcript without lazy structure children', () => {
	assert.throws(
		() => verifyNativeDapBaseline(createVerifiedDapResult({ pairVariables: [] })),
		/native DAP baseline did not expose the structure children/
	);
});

test('rejects a native DAP transcript without locals from the stopped frame', () => {
	assert.throws(
		() => verifyNativeDapBaseline(createVerifiedDapResult({ localVariables: [] })),
		/native DAP baseline did not expose the compound locals/
	);
});

test('rejects a native DAP transcript without lazy array children', () => {
	assert.throws(
		() => verifyNativeDapBaseline(createVerifiedDapResult({ valuesVariables: [] })),
		/native DAP baseline did not expose the array children/
	);
});

test('accepts either valid ordering of the continue response and event', () => {
	assert.doesNotThrow(() => verifyNativeDapBaseline(createVerifiedDapResult()));
});

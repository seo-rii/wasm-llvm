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
  if (request.command === 'threads') {
    respond(request, { threads: [{ id: 1, name: 'nobody' }] });
    return;
  }
  if (request.command === 'stackTrace') {
    respond(request, {
      stackFrames: [
        {
          id: 7,
          name: '_start',
          source: { path: '/workspace/crt1-command.c' },
          line: 12,
          column: 13
        }
      ],
      totalFrames: 1
    });
    return;
  }
  if (request.command === 'continue') {
    send({ type: 'event', event: 'continued', body: { threadId: 1 } });
    respond(request, { allThreadsContinued: true });
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
			'configurationDone',
			'attach-response',
			'threads',
			'stackTrace',
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

test('accepts either valid ordering of the continue response and event', () => {
	assert.doesNotThrow(() =>
		verifyNativeDapBaseline({
			exitCode: 0,
			port: 1234,
			sequence: [
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
			],
			stackFrames: [{ id: 7, name: '_start', line: 12, column: 13 }],
			targetStderr: '',
			targetStdout: 'total=15\n',
			threads: [{ id: 1, name: 'nobody' }]
		})
	);
});

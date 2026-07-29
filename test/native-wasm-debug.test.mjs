import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
	runNativeBaseline,
	verifyNativeCBaseline
} from './native-wasm-debug/run-native-baseline.mjs';

async function createExecutable(directory, name, source) {
	const executable = path.join(directory, name);
	await writeFile(executable, `#!/usr/bin/env node\n${source}`);
	await chmod(executable, 0o755);
	return executable;
}

test('runs LLDB against a dynamic port when WAMR buffers its readiness log', async (context) => {
	const directory = await mkdtemp(path.join(tmpdir(), 'wasm-native-debug-test-'));
	context.after(() => rm(directory, { recursive: true, force: true }));
	const target = await createExecutable(
		directory,
		'fake-iwasm.mjs',
		`
const debugArgument = process.argv.find((argument) => argument.startsWith('-g='));
const endpoint = debugArgument?.slice(3);
if (!endpoint) process.exit(10);
setTimeout(() => {
  process.stdout.write('total=15\\n');
  process.exit(0);
}, 100);
`
	);
	const lldb = await createExecutable(
		directory,
		'fake-lldb.mjs',
		`
const { readFileSync } = await import('node:fs');
const commandPath = process.argv[process.argv.indexOf('-s') + 1];
const commands = readFileSync(commandPath, 'utf8');
if (/connect:\\/\\/127\\.0\\.0\\.1:1234/.test(commands)) process.exit(9);
if (!/connect:\\/\\/127\\.0\\.0\\.1:\\d+/.test(commands)) process.exit(8);
process.stdout.write([
  'Breakpoint 1: main.c:13',
  '(int) n = 2',
  '(int) doubled = 4',
  '0x00010960: 0x00000003',
  '(volatile int) global_bias = 3',
  'Process 1 exited with status = 0'
].join('\\n'));
`
	);
	const program = path.join(directory, 'program.wasm');
	const commands = path.join(directory, 'lldb.commands');
	await writeFile(program, 'fixture');
	await writeFile(
		commands,
		'process connect -p wasm connect://127.0.0.1:1234\ncontinue\n'
	);

	const result = await runNativeBaseline({
		commandsPath: commands,
		cwd: directory,
		iwasmPath: target,
		lldbPath: lldb,
		programPath: program,
		targetStartupGraceMs: 25,
		timeoutMs: 2_000
	});

	assert.equal(result.targetStderr, '');
	assert.match(result.targetStdout, /total=15/);
	assert.doesNotMatch(result.lldbStdout, /127\.0\.0\.1:1234/);
	assert.doesNotThrow(() => verifyNativeCBaseline(result));
});

test('terminates WAMR when LLDB fails', async (context) => {
	const directory = await mkdtemp(path.join(tmpdir(), 'wasm-native-debug-test-'));
	context.after(() => rm(directory, { recursive: true, force: true }));
	const terminationFile = path.join(directory, 'target-terminated');
	const target = await createExecutable(
		directory,
		'fake-iwasm.mjs',
		`
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
	const lldb = await createExecutable(
		directory,
		'fake-lldb.mjs',
		`process.stderr.write('synthetic LLDB failure\\n'); process.exit(7);\n`
	);
	const program = path.join(directory, 'program.wasm');
	const commands = path.join(directory, 'lldb.commands');
	await writeFile(program, 'fixture');
	await writeFile(
		commands,
		'process connect -p wasm connect://127.0.0.1:1234\n'
	);

	await assert.rejects(
		runNativeBaseline({
			commandsPath: commands,
			cwd: directory,
			env: { TARGET_TERMINATION_FILE: terminationFile },
			iwasmPath: target,
			lldbPath: lldb,
			programPath: program,
			timeoutMs: 2_000
		}),
		/native LLDB exited with status 7.*synthetic LLDB failure/s
	);
	assert.equal(await readFile(terminationFile, 'utf8'), 'terminated');
});

test('force-terminates an LLDB process that ignores the timeout signal', async (context) => {
	const directory = await mkdtemp(path.join(tmpdir(), 'wasm-native-debug-test-'));
	context.after(() => rm(directory, { recursive: true, force: true }));
	const lldbPidFile = path.join(directory, 'lldb.pid');
	const target = await createExecutable(
		directory,
		'fake-iwasm.mjs',
		`
const debugArgument = process.argv.find((argument) => argument.startsWith('-g='));
process.stderr.write(\`Debug server listening on \${debugArgument?.slice(3)}\\n\`);
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1_000);
`
	);
	const lldb = await createExecutable(
		directory,
		'fake-lldb.mjs',
		`
const { writeFileSync } = await import('node:fs');
writeFileSync(process.env.LLDB_PID_FILE, String(process.pid));
process.on('SIGTERM', () => {});
setInterval(() => {}, 1_000);
`
	);
	const program = path.join(directory, 'program.wasm');
	const commands = path.join(directory, 'lldb.commands');
	await writeFile(program, 'fixture');
	await writeFile(
		commands,
		'process connect -p wasm connect://127.0.0.1:1234\n'
	);

	await assert.rejects(
		runNativeBaseline({
			commandsPath: commands,
			cwd: directory,
			env: { LLDB_PID_FILE: lldbPidFile },
			iwasmPath: target,
			lldbPath: lldb,
			programPath: program,
			timeoutMs: 500
		}),
		/native LLDB timed out/
	);
	const lldbPid = Number(await readFile(lldbPidFile, 'utf8'));
	context.after(() => {
		try {
			process.kill(lldbPid, 'SIGKILL');
		} catch {}
	});
	assert.throws(
		() => process.kill(lldbPid, 0),
		(error) => error?.code === 'ESRCH'
	);
});

test('rejects an incomplete native C transcript', () => {
	assert.throws(
		() =>
			verifyNativeCBaseline({
				lldbStderr: '',
				lldbStdout: 'Process 1 exited with status = 0',
				port: 1234,
				targetStderr: '',
				targetStdout: 'total=15'
			}),
		/native C baseline did not verify breakpoint resolution/
	);
});

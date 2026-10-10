// Environment-neutral acceptance harness shared by the Node and Chromium smokes.
// It uses only the documented module contract: a fresh factory instance, a
// caller-owned bounded memory, byte stdin/stdout callbacks, FS and callMain.

export const INITIAL_MEMORY_BYTES = 64 * 1024 * 1024;
export const MAXIMUM_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;

/** The Lisp form a consumer passes to `--eval`: LOAD the program, report conditions, exit. */
export function loadForm(file) {
	return (
		'(handler-bind ((serious-condition (lambda (c)' +
		' (ignore-errors (finish-output *standard-output*))' +
		' (format *error-output* "~&;;; Unhandled ~a: ~a~%" (type-of c) c)' +
		' (finish-output *error-output*) (ext:quit 1))))' +
		` (load ${JSON.stringify(file)} :verbose nil :print nil)` +
		' (finish-output *standard-output*) (ext:quit 0))'
	);
}

export async function runEcl({ createModule, wasmBinary, source, stdin = '', maximumMemoryBytes = MAXIMUM_MEMORY_BYTES }) {
	const input = new TextEncoder().encode(stdin);
	let offset = 0;
	const stdout = [];
	const stderr = [];
	const wasmMemory = new WebAssembly.Memory({
		initial: INITIAL_MEMORY_BYTES / 65536,
		maximum: Math.floor(maximumMemoryBytes / 65536)
	});
	const started = Date.now();
	const module = await createModule({
		noInitialRun: true,
		wasmBinary,
		wasmMemory,
		stdin: () => (offset < input.length ? input[offset++] : null),
		stdout: (value) => stdout.push(value & 255),
		stderr: (value) => stderr.push(value & 255)
	});
	module.FS.mkdirTree('/work');
	module.FS.writeFile('/work/main.lisp', source);
	module.FS.chdir('/work');
	let exitCode = null;
	let trap = null;
	// Under Node, Emscripten's exit path also sets process.exitCode; the program status belongs to
	// this run's result, not to the host process.
	const hostExitCode = globalThis.process?.exitCode;
	try {
		exitCode = module.callMain(['--norc', '--eval', loadForm('main.lisp')]);
	} catch (error) {
		if (error?.name === 'ExitStatus' && Number.isInteger(error.status)) exitCode = error.status;
		else if (error instanceof RangeError) trap = `${error.name}: ${error.message}`;
		else throw error;
	} finally {
		if (globalThis.process) globalThis.process.exitCode = hostExitCode;
	}
	const decoder = new TextDecoder();
	return {
		exitCode,
		trap,
		stdout: decoder.decode(Uint8Array.from(stdout)),
		stderr: decoder.decode(Uint8Array.from(stderr)),
		elapsedMs: Date.now() - started,
		memoryBytes: wasmMemory.buffer.byteLength
	};
}

/** Runs every fixture through `run(name, source, stdin)` and asserts upstream behaviour. */
export async function acceptEcl(run, fixtures) {
	const fail = (message, result) => {
		throw new Error(`${message}\n${JSON.stringify(result, null, 2)}`);
	};
	const stdin = await run('stdin.lisp', fixtures['stdin.lisp'], 'Common Lisp 안녕\n20\n');
	if (
		stdin.exitCode !== 0 ||
		!stdin.stdout.includes('What is your name? Hello, Common Lisp 안녕!\n') ||
		!stdin.stdout.includes('fibonacci(20) = 6765\n') ||
		!stdin.stdout.includes('(:ECL "26.5.5" 1267650600228229401496703205376)') ||
		!stdin.stdout.includes('eof: EOF\n')
	)
		fail('ECL did not round-trip stdin/stdout', stdin);
	const error = await run('error.lisp', fixtures['error.lisp'], '');
	if (
		error.exitCode !== 1 ||
		error.stdout !== 'before error\n' ||
		!/;;; Unhandled SIMPLE-ERROR: acceptance condition 42/u.test(error.stderr)
	)
		fail('ECL did not report an unhandled condition with exit status 1', error);
	const gc = await run('gc.lisp', fixtures['gc.lisp'], '');
	if (gc.exitCode !== 0 || !gc.stdout.includes('clos=250500\ngc ok\n'))
		fail('ECL failed the collector/CLOS stress fixture', gc);
	const recursion = await run('recursion.lisp', fixtures['recursion.lisp'], '');
	if (
		recursion.exitCode !== null ||
		recursion.stdout !== 'depth=100\n' ||
		!/^RangeError: Maximum call stack size exceeded/u.test(recursion.trap ?? '')
	)
		fail('ECL deep recursion was not contained as an engine stack trap', recursion);
	return {
		stdinStdout: true,
		unhandledCondition: true,
		garbageCollection: true,
		recursionTrap: true,
		recursionTrapMessage: recursion.trap,
		elapsedMs: {
			stdin: stdin.elapsedMs,
			error: error.elapsedMs,
			gc: gc.elapsedMs,
			recursion: recursion.elapsedMs
		}
	};
}

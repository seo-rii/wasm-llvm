#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PRODUCER_ROOT, VALIDATION_CASES, run, sha256, writeJson } from './shared.mjs';
import { verifyArtifacts } from './producer.mjs';

async function evaluate(directory, testCase) {
	const createLFortran = (await import(pathToFileURL(path.join(directory, 'lfortran.js')).href)).default;
	const data = await readFile(path.join(directory, 'lfortran.data'));
	const input = Buffer.from(testCase.stdin);
	let inputOffset = 0;
	let stdout = '';
	let stderr = '';
	const compiler = await createLFortran({
		noInitialRun: true,
		noExitRuntime: true,
		wasmBinary: await readFile(path.join(directory, 'lfortran.wasm')),
		locateFile: (name) => path.join(directory, name),
		getPreloadedPackage: () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
		stdin: () => inputOffset < input.length ? input[inputOffset++] : null,
		print: (line) => { stdout += `${line}\n`; },
		printErr: (line) => { stderr += `${line}\n`; }
	});
	const source = await readFile(path.join(PRODUCER_ROOT, 'fixtures', testCase.fixture));
	compiler.FS.writeFile('/program.f90', source);
	let exitCode;
	try { exitCode = compiler.callMain(['/program.f90']); }
	catch (error) {
		if (error.name !== 'ExitStatus') throw error;
		exitCode = error.status;
	}
	const generated = [];
	function collect(directory, depth = 0) {
		if (depth > 4) return;
		for (const name of compiler.FS.readdir(directory)) {
			if (name === '.' || name === '..') continue;
			const file = `${directory}/${name}`;
			const info = compiler.FS.stat(file);
			if (compiler.FS.isDir(info.mode)) collect(file, depth + 1);
			else if (/\.(wasm|o)$/.test(name)) {
				const bytes = compiler.FS.readFile(file);
				generated.push({ name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
			}
		}
	}
	collect('/tmp');
	if (exitCode !== testCase.exitCode || stdout !== testCase.stdout) {
		throw new Error(`${testCase.name}: exit=${exitCode}, stdout=${JSON.stringify(stdout)}, stderr=${JSON.stringify(stderr.slice(-1500))}`);
	}
	if (testCase.exitCode === 0 && (!generated.some((item) => item.name.endsWith('.o')) || !generated.some((item) => item.name.endsWith('.wasm')))) {
		throw new Error(`${testCase.name}: upstream LLVM object and dynamic Wasm output were not observed`);
	}
	if (testCase.exitCode !== 0 && !stderr.includes('this_symbol_is_not_declared')) {
		throw new Error('Invalid input did not produce the upstream symbol diagnostic');
	}
	return {
		name: testCase.name, exitCode, stdout, diagnostic: stderr.slice(-1500),
		sourceSha256: createHash('sha256').update(source).digest('hex'),
		stdinSha256: createHash('sha256').update(input).digest('hex'),
		generated
	};
}

async function main() {
	const [directoryArg, caseFlag, caseName] = process.argv.slice(2);
	if (!directoryArg) throw new Error('Usage: validate.mjs <artifact-directory>');
	const directory = path.resolve(directoryArg);
	if (caseFlag === '--case') {
		const testCase = VALIDATION_CASES.find((item) => item.name === caseName);
		if (!testCase) throw new Error('Unknown validation case');
		console.log(JSON.stringify(await evaluate(directory, testCase)));
		// Emscripten also assigns Node's process.exitCode when the compiler
		// rejects input. A successfully verified negative case is a passing test.
		process.exitCode = 0;
		return;
	}
	if (caseFlag) throw new Error('Unexpected validation argument');
	const receipt = await verifyArtifacts(directory, false);
	const cases = [];
	// A fresh Node process matches the consumer's required one-Worker-per-run
	// lifetime and prevents retained Emscripten side modules from leaking state.
	for (const testCase of VALIDATION_CASES) {
		const result = await run(process.execPath, [fileURLToPath(import.meta.url), directory, '--case', testCase.name], { capture: true, timeoutMs: 180_000 });
		cases.push(JSON.parse(result));
	}
	receipt.validation = {
		passed: true, engine: 'node', nodeVersion: process.version,
		validatorSha256: await sha256(fileURLToPath(import.meta.url)), cases,
		browserAcceptance: false
	};
	await writeJson(path.join(directory, 'producer-receipt.json'), receipt);
	await verifyArtifacts(directory);
	console.log(`Validated ${cases.length} real upstream LLVM compilation/evaluation cases; Chromium consumer acceptance remains separate.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

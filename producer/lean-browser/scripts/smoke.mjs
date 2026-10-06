// Run real Lean programs from a packaged lean-browser artifact directory under Node.
// The library is unpacked into Emscripten MEMFS exactly as a browser consumer does it.
// Usage: node smoke.mjs [artifactDir]
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRODUCER = path.dirname(HERE);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Read lean.wasm and the unpacked Init library from an artifact directory. */
export async function loadArtifacts(directory) {
	const index = JSON.parse(await readFile(path.join(directory, 'lean-init.index.json'), 'utf8'));
	const pack = new Uint8Array(index.totalBytes);
	let offset = 0;
	for (const chunk of index.chunks) {
		const bytes = gunzipSync(await readFile(path.join(directory, chunk.path)));
		if (bytes.length !== chunk.uncompressedBytes || offset !== chunk.offset)
			throw new Error(`${chunk.path} does not match the library index`);
		pack.set(bytes, offset);
		offset += bytes.length;
	}
	if (offset !== index.totalBytes || sha256(pack) !== index.sha256)
		throw new Error('unpacked library does not match the index digest');
	const library = index.files.map((file) => ({
		path: file.path,
		bytes: pack.subarray(file.offset, file.offset + file.bytes)
	}));
	return {
		moduleUrl: pathToFileURL(path.join(directory, 'lean.mjs')).href,
		wasm: gunzipSync(await readFile(path.join(directory, 'lean.wasm.gz'))),
		library
	};
}

/** Run `lean --run /work/Main.lean` with byte stdin in a fresh module instance. */
export async function runLean(artifacts, { source, stdin = '', args = [] }) {
	const { default: createLean } = await import(artifacts.moduleUrl);
	const input = new TextEncoder().encode(stdin);
	let inputOffset = 0;
	let stdout = '';
	let stderr = '';
	let exitCode;
	const lean = await createLean({
		noInitialRun: true,
		wasmBinary: artifacts.wasm,
		stdin: () => (inputOffset < input.length ? input[inputOffset++] : null),
		print: (line) => (stdout += `${line}\n`),
		printErr: (line) => (stderr += `${line}\n`),
		onExit: (status) => (exitCode = status)
	});
	// `IO.appPath` reports /lean/bin/lean; Lean resolves its library relative to that directory.
	lean.FS.mkdirTree('/lean/bin');
	for (const file of artifacts.library) {
		const target = `/lean/lib/lean/${file.path}`;
		lean.FS.mkdirTree(target.slice(0, target.lastIndexOf('/')));
		lean.FS.writeFile(target, file.bytes, { canOwn: true });
	}
	lean.FS.mkdirTree('/work');
	lean.FS.writeFile('/work/Main.lean', source);
	lean.FS.chdir('/work');
	const started = Date.now();
	try {
		exitCode = lean.callMain(['-j1', '--run', '/work/Main.lean', ...args]);
	} catch (error) {
		if (error?.name !== 'ExitStatus') throw error;
		exitCode = error.status;
	}
	return { exitCode, stdout, stderr, milliseconds: Date.now() - started };
}

/** Acceptance cases recorded in the producer receipt. */
export async function acceptance(directory) {
	const artifacts = await loadArtifacts(directory);
	const fixture = async (name) => readFile(path.join(PRODUCER, 'fixtures', name), 'utf8');
	const program = await fixture('Main.lean');
	const invalid = await fixture('Invalid.lean');
	const run = await runLean(artifacts, { source: program, stdin: '안녕\n1 2 -3 40\n' });
	const expected = 'Hello, 안녕!\nsum = 40\n';
	if (run.exitCode !== 0 || run.stdout !== expected)
		throw new Error(`Lean stdin/stdout smoke failed: ${JSON.stringify(run)}`);
	const failed = await runLean(artifacts, { source: invalid });
	if (failed.exitCode !== 1 || !/^\/work\/Main\.lean:2:\d+: error/m.test(failed.stdout + failed.stderr))
		throw new Error(`Lean diagnostic smoke failed: ${JSON.stringify(failed)}`);
	return {
		engine: `node ${process.version}`,
		fixtures: { 'Main.lean': sha256(program), 'Invalid.lean': sha256(invalid) },
		smokeScriptSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
		program: { stdinSha256: sha256('안녕\n1 2 -3 40\n'), stdout: run.stdout, exitCode: 0 },
		diagnostic: {
			exitCode: failed.exitCode,
			firstLine: (failed.stdout + failed.stderr).split('\n')[0]
		}
	};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const directory = path.resolve(
		process.argv[2] || path.join(PRODUCER, '../../artifacts/lean-browser')
	);
	console.log(JSON.stringify(await acceptance(directory), null, 2));
	process.exit(0);
}

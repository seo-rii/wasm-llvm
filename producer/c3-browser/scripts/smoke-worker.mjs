// Acceptance harness only. Each request gets a fresh compiler Worker because c3c exits after main.
export async function compileFixture({ compilerUrl, source, args }) {
	const { default: createCompiler } = await import(compilerUrl);
	const stdout = [];
	const stderr = [];
	const compiler = await createCompiler({
		noInitialRun: true,
		print: (line) => stdout.push(String(line)),
		printErr: (line) => stderr.push(String(line))
	});
	compiler.FS.mkdir('/work');
	compiler.FS.chdir('/work');
	compiler.FS.writeFile('/work/main.c3', source);
	let exitCode;
	try {
		exitCode = compiler.callMain(args) ?? 0;
	} catch (error) {
		if (!Number.isInteger(error?.status)) throw error;
		exitCode = error.status;
	}
	const files = [];
	const collect = (directory) => {
		for (const name of compiler.FS.readdir(directory)) {
			if (name === '.' || name === '..') continue;
			const filename = `${directory}/${name}`;
			const info = compiler.FS.stat(filename);
			if (compiler.FS.isDir(info.mode)) collect(filename);
			else if (/\.(?:o|wasm)$/u.test(name)) {
				files.push({ path: filename, bytes: compiler.FS.readFile(filename) });
			}
		}
	};
	collect('/work');
	return { exitCode, stdout: stdout.join('\n'), stderr: stderr.join('\n'), files };
}

if (typeof process === 'object' && process.versions?.node) {
	const { parentPort, workerData } = await import('node:worker_threads');
	if (parentPort) {
		try {
			parentPort.postMessage({ result: await compileFixture(workerData) });
		} catch (error) {
			parentPort.postMessage({ error: error.stack || String(error) });
		}
	}
} else {
	globalThis.onmessage = async ({ data }) => {
		try {
			globalThis.postMessage({ result: await compileFixture(data) });
		} catch (error) {
			globalThis.postMessage({ error: error.stack || String(error) });
		}
	};
}

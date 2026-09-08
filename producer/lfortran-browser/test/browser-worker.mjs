// Acceptance harness only. Consumer Workers and input transport belong to wasm-idle.
import createLFortran from '/artifacts/lfortran.js';

async function digest(bytes) {
	return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
		(value) => value.toString(16).padStart(2, '0')).join('');
}

self.onmessage = async ({ data }) => {
	let stdout = '';
	let stderr = '';
	try {
		const input = new TextEncoder().encode(data.stdin);
		let offset = 0;
		const [wasmBinary, preloaded] = await Promise.all(
			['lfortran.wasm', 'lfortran.data'].map(async (name) => {
				const response = await fetch('/artifacts/' + name);
				if (!response.ok) throw new Error('Artifact request failed: ' + name);
				return response.arrayBuffer();
			}));
		const compiler = await createLFortran({
			noInitialRun: true,
			noExitRuntime: true,
			wasmBinary,
			locateFile: (name) => '/artifacts/' + name,
			getPreloadedPackage: () => preloaded,
			stdin: () => offset < input.length ? input[offset++] : null,
			print: (line) => { stdout += line + '\n'; },
			printErr: (line) => { stderr += line + '\n'; }
		});
		compiler.FS.writeFile('/program.f90', data.source);
		let exitCode;
		try { exitCode = compiler.callMain(['/program.f90']); }
		catch (error) {
			if (error.name !== 'ExitStatus') throw error;
			exitCode = error.status;
		}
		const generated = [];
		async function collect(directory, depth = 0) {
			if (depth > 4) return;
			for (const name of compiler.FS.readdir(directory)) {
				if (name === '.' || name === '..') continue;
				const file = directory + '/' + name;
				const info = compiler.FS.stat(file);
				if (compiler.FS.isDir(info.mode)) await collect(file, depth + 1);
				else if (/\.(o|wasm)$/u.test(name)) {
					const bytes = compiler.FS.readFile(file);
					generated.push({ name, size: bytes.length, sha256: await digest(bytes) });
				}
			}
		}
		await collect('/tmp');
		self.postMessage({ exitCode, stdout, stderr, generated });
	} catch (error) {
		self.postMessage({ error: String(error), exitCode: null, stdout, stderr });
	}
};

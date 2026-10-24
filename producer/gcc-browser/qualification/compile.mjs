// Standalone real-tool adapter for Node qualification. The browser acceptance
// gate separately exercises wasm-idle's public Worker/API; it does not use this
// adapter. Each CLI invocation gets a fresh OS process and Emscripten heaps.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readTarEntries } from '../../../scripts/lib/tar.mjs';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function loadBundle(directory, expectedManifestSha256) {
	const root = await fs.realpath(directory);
	const manifestBytes = await fs.readFile(path.join(root, 'gcc-toolchain.v1.json'));
	const manifestSha256 = sha256(manifestBytes);
	if (expectedManifestSha256) assert.equal(manifestSha256, expectedManifestSha256, 'Manifest SHA-256 mismatch');
	const manifest = JSON.parse(manifestBytes);
	assert.equal(manifest.schemaVersion, 1);
	assert.equal(manifest.kind, 'gcc-x86_64-linux-gnu');
	assert.equal(manifest.host, 'wasm32-emscripten');
	assert.equal(manifest.target, 'x86_64-linux-gnu');
	assert.equal(manifest.compiler.family, 'gcc');
	assert.equal(manifest.linkMode, 'static');
	assert.equal(manifest.sysrootPath, '/sysroot');
	assert(/^\/sysroot\/usr\/lib\/gcc\/x86_64-linux-gnu\/\d+$/.test(manifest.gccInstallation));
	assert.equal(manifest.resourceDir, `${manifest.gccInstallation}/include`);
	assert(/^\d+$/.test(manifest.gnu.gccVersion));
	assert.deepEqual(manifest.cpuProfiles, ['x86-64', 'avx2-fma']);
	const assetPath = async (name) => {
		const asset = manifest.assets[name];
		assert(asset && typeof asset.path === 'string' && asset.path.split('/').every((part) => part && part !== '.' && part !== '..') &&
			!/[\\\x00-\x1f\x7f:]/.test(asset.path), `Invalid ${name} path`);
		const resolved = await fs.realpath(path.join(root, asset.path));
		assert(resolved.startsWith(root + path.sep), `${name} escapes bundle`);
		assert(Number.isSafeInteger(asset.bytes) && asset.bytes > 0 && /^[a-f0-9]{64}$/.test(asset.sha256), `Invalid ${name} identity`);
		return resolved;
	};
	const readAsset = async (name) => {
		const bytes = await fs.readFile(await assetPath(name));
		assert.equal(bytes.length, manifest.assets[name].bytes, `${name} size mismatch`);
		assert.equal(sha256(bytes), manifest.assets[name].sha256, `${name} SHA-256 mismatch`);
		return bytes;
	};
	return { root, manifest, manifestSha256, assetPath, readAsset };
}

export async function compileReal(bundle, request) {
	const { manifest } = bundle;
	const language = request.language ?? 'cpp';
	const emit = request.emit ?? 'assembly';
	const cpu = request.cpu ?? 'x86-64';
	const optimization = request.optimization ?? '2';
	assert(['c', 'cpp'].includes(language) && ['assembly', 'object', 'executable'].includes(emit));
	assert(['x86-64', 'avx2-fma'].includes(cpu) && ['0', '1', '2', '3', 's'].includes(optimization));
	const sourceName = `/work/main.${request.preprocessed ? language === 'c' ? 'i' : 'ii' : language === 'c' ? 'c' : 'cpp'}`;
	const source = new TextEncoder().encode(request.code);
	const sysroot = await bundle.readAsset('sysroot');
	const entries = readTarEntries(sysroot);
	const artifacts = new Map([[sourceName, source]]);
	const stages = [];
	const stdout = [];
	const stderr = [];
	const invoke = async (tool, argv, outputPath) => {
		const loader = await bundle.readAsset(`${tool}Js`);
		const wasm = await bundle.readAsset(`${tool}Wasm`);
		assert(wasm.subarray(0, 4).equals(Buffer.from([0, 0x61, 0x73, 0x6d])), `${tool} is not a WebAssembly binary`);
		const factory = (await import(pathToFileURL(await bundle.assetPath(`${tool}Js`)).href)).default;
		assert.equal(typeof factory, 'function', `${tool} loader does not export a module factory`);
		const stageOut = [];
		const stageErr = [];
		const start = performance.now();
		let exitCode = 0;
		let module = await factory({ noInitialRun: true, noExitRuntime: false, wasmBinary: wasm,
			print: (line) => stageOut.push(String(line)), printErr: (line) => stageErr.push(String(line)),
			onExit: (status) => { exitCode = status; } });
		assert(module.FS && typeof module.callMain === 'function', `${tool} lacks the Emscripten runtime contract`);
		module.FS.mkdirTree('/work');
		module.FS.mkdirTree('/tmp');
		module.FS.mkdirTree('/sysroot');
		for (const [name, entry] of entries) {
			if (!name) continue;
			const destination = `/sysroot/${name}`;
			if (entry.directory) module.FS.mkdirTree(destination);
			else {
				module.FS.mkdirTree(path.posix.dirname(destination));
				module.FS.writeFile(destination, sysroot.subarray(entry.offset, entry.offset + entry.size));
			}
		}
		for (const [name, bytes] of artifacts) module.FS.writeFile(name, bytes);
		module.FS.chdir('/work');
		const previousHostExitCode = process.exitCode;
		let normalExit = false;
		try {
			const returned = module.callMain([...argv]);
			if (Number.isInteger(returned)) exitCode = returned;
			normalExit = true;
		} catch (error) {
			if (error?.name === 'ExitStatus' && Number.isInteger(error.status)) {
				exitCode = error.status;
				normalExit = true;
			}
			else throw error;
		} finally {
			// Emscripten's Node quit_ sets process.exitCode even when callMain
			// catches ExitStatus. A compiler diagnostic is a result, not failure
			// of this qualification host. Unexpected runtime errors still fail.
			if (normalExit) process.exitCode = previousHostExitCode;
		}
		assert(Number.isInteger(exitCode), `${tool} returned an invalid exit code`);
		const peakMemoryBytes = module.HEAPU8?.buffer.byteLength;
		assert(Number.isSafeInteger(peakMemoryBytes) && peakMemoryBytes > 0, `${tool} does not expose Wasm linear memory`);
		stages.push({ tool, argv, exitCode, milliseconds: performance.now() - start, peakMemoryBytes,
			loaderSha256: sha256(loader), wasmSha256: sha256(wasm), stdout: stageOut.join('\n'), stderr: stageErr.join('\n') });
		stdout.push(...stageOut); stderr.push(...stageErr);
		if (exitCode === 0) {
			const output = module.FS.readFile(outputPath);
			assert(output.length > 0, `${tool} exited successfully without producing ${outputPath}`);
			artifacts.set(outputPath, new Uint8Array(output));
		}
		module = null;
		globalThis.gc?.();
		return exitCode;
	};
	const standard = request.standard ?? (language === 'c' ? 'gnu17' : 'gnu++20');
	const cpuArgs = ['-march=x86-64', ...(cpu === 'avx2-fma' ? ['-mavx2', '-mfma'] : [])];
	const includes = language === 'cpp' ? [
		`/sysroot/usr/include/c++/${manifest.gnu.gccVersion}`,
		`/sysroot/usr/include/x86_64-linux-gnu/c++/${manifest.gnu.gccVersion}`,
		`/sysroot/usr/include/c++/${manifest.gnu.gccVersion}/backward`
	] : [];
	includes.push(manifest.resourceDir, '/sysroot/usr/include/x86_64-linux-gnu', '/sysroot/usr/include');
	const ccArgs = ['-quiet', '-imultiarch', 'x86_64-linux-gnu', '-isysroot', '/sysroot', '-nostdinc',
		...includes.flatMap((name) => ['-isystem', name]), `-std=${standard}`, `-O${optimization}`, ...cpuArgs,
		'-fno-pie', '-fno-pic', '-fasynchronous-unwind-tables', ...(language === 'cpp' ? ['-fexceptions', '-D_GNU_SOURCE'] : []),
		...(request.preprocessed ? ['-fpreprocessed'] : []), sourceName, '-o', '/work/main.s'];
	let exitCode = await invoke(language === 'c' ? 'cc1' : 'cc1plus', ccArgs, '/work/main.s');
	if (exitCode === 0 && emit !== 'assembly') {
		exitCode = await invoke('as', ['--64', '-o', '/work/main.o', '/work/main.s'], '/work/main.o');
	}
	if (exitCode === 0 && emit === 'executable') {
		const gcc = manifest.gccInstallation;
		const lib = '/sysroot/usr/lib/x86_64-linux-gnu';
		const ldArgs = ['-m', 'elf_x86_64', '--sysroot=/sysroot', '-static', '-o', '/work/main.elf',
			`${lib}/crt1.o`, `${lib}/crti.o`, `${gcc}/crtbeginT.o`, '/work/main.o',
			`-L${gcc}`, `-L${lib}`, '-L/sysroot/lib/x86_64-linux-gnu',
			'--start-group', ...(language === 'cpp' ? ['-lstdc++', '-lm'] : []), '-lgcc', '-lgcc_eh', '-lc', '--end-group',
			`${gcc}/crtend.o`, `${lib}/crtn.o`];
		exitCode = await invoke('ld', ldArgs, '/work/main.elf');
	}
	const result = { exitCode, stdout: stdout.join('\n'), stderr: stderr.join('\n'), stages };
	if (exitCode === 0) {
		const extension = { assembly: 's', object: 'o', executable: 'elf' }[emit];
		result.artifact = { compiler: 'gcc', compilerHost: manifest.host, target: manifest.target,
			format: { assembly: 'assembly', object: 'elf-object', executable: 'elf-executable' }[emit],
			fileName: `main.${extension}`, cpu, bytes: artifacts.get(`/work/main.${extension}`) };
	}
	return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const [bundleDirectory, manifestSha256, requestPath, output] = process.argv.slice(2);
		assert(bundleDirectory && /^[a-f0-9]{64}$/.test(manifestSha256) && requestPath && output, 'This internal CLI requires bundle, manifest SHA-256, request and output paths');
		const bundle = await loadBundle(bundleDirectory, manifestSha256);
		const result = await compileReal(bundle, JSON.parse(await fs.readFile(requestPath, 'utf8')));
		if (result.artifact) {
			const artifactPath = path.join(output, result.artifact.fileName);
			await fs.writeFile(artifactPath, result.artifact.bytes, { flag: 'wx', mode: 0o600 });
			result.artifact = { ...result.artifact, bytes: result.artifact.bytes.length,
				sha256: sha256(result.artifact.bytes), path: artifactPath };
		}
		result.hostMaximumRssKiB = process.resourceUsage().maxRSS;
		await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
	} catch (error) {
		console.error(error.stack ?? String(error)); process.exitCode = 1;
	}
}

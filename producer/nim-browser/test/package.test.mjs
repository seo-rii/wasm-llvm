import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { gzipSync } from 'node:zlib';
import { downloadLockedArchive, loadContract, packageNim, verifyNimArtifacts } from '../scripts/package.mjs';
import { patchClangJs, patchNimLicense, upgradeLegacyClangJs } from '../scripts/patches.mjs';
import { describeArtifact, jsonBytes, sha256, writeArtifact } from '../../../scripts/lib/verified-artifacts.mjs';

const run = promisify(execFile);
const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const emptyModule = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);

function clangFixture() {
	const worker = 'var a;class e{constructor(options){globalThis.options=options;this.ready=Promise.resolve()}}let s,i;let r=null;const n=async t=>{const{id:o,payload:h}=t.data;switch(o){case"constructor":i=h.port,s=new e((a=h.path,{readBuffer:async t=>(await fetch(`${a}/${t}`)).arrayBuffer(),async compileStreaming(t){const e=await fetch(`${a}/${t}`,{cache:"no-store"});return WebAssembly.compile(await e.arrayBuffer())}}));break;case"compile-each-link":{const files=h.files;const o=s.memfs.getFileContents(h.out);const inst=await s.hostLogAsync(`Compiling ${h.out}`,WebAssembly.compile(o));const finalResult=await s.run(inst,h.out);i.postMessage({id:"compile-each-link-done",data:finalResult?{ok:true}:{ok:false}});break;}}};globalThis.handle=n;';
	return `const a="${Buffer.from(worker).toString('base64')}";class o{constructor(l){const c={};this.worker={postMessage(p,t){globalThis.sent={p,t}}};this.worker.postMessage({id:"constructor",payload:{port:c,path:l}},[c]);}}let m,y;async function p({path:l}){m||(y=new o(l||location.origin),await y.onReady,m=!0)}globalThis.outerInit=p;`;
}

// Model the previous published host contract independently of the producer upgrade entry point.
function legacyLoader(raw) {
	const patched = patchClangJs(raw);
	const encoded = patched.match(/a="([A-Za-z0-9+/=]+)"/)[1];
	const worker = Buffer.from(encoded, 'base64').toString('utf8')
		.replace(/function validateModules\(a\)\{.*?\}function readAsset/u, 'function readAsset')
		.replace('h.modules=validateModules(h.modules),', '')
		.replace('h.modules?h.modules[t]:WebAssembly.compile(readAsset(a,t))', 'WebAssembly.compile(readAsset(a,t))');
	return patched.replace(encoded, Buffer.from(worker).toString('base64'))
		.replace('Object.values(l.assets)', 'Object.values(l)')
		.replace('assets:l.assets,modules:l.modules', 'assets:l')
		.replace('async function p({assets:l,modules:c}){m||(y=new o({assets:l,modules:c}),await y.onReady,m=!0)}',
			'async function p({assets:l}){m||(y=new o(l),await y.onReady,m=!0)}');
}

async function fixture() {
	const root = await mkdtemp(path.join(os.tmpdir(), 'nim-producer-test-'));
	roots.push(root);
	const sourceDir = path.join(root, 'distribution');
	const contract = structuredClone(await loadContract());
	const rawClang = clangFixture();
	const sourceFiles = new Map([
		['nim/nim-bundle.js', Buffer.from('__NIM_USER_CODE__; callMain();\n')], ['nim/nim.wasm', emptyModule],
		['nim/nimbase.h', Buffer.from('#define NIM_INTBITS 32\n')], ['clang/clang.js', Buffer.from(rawClang)],
		['clang/clang.wasm', emptyModule], ['clang/lld.wasm', emptyModule], ['clang/memfs.wasm', emptyModule],
		['clang/sysroot.tar', Buffer.alloc(1024)]
	]);
	const outputs = new Map();
	for (const entry of contract.lock.assets) {
		const source = sourceFiles.get(entry.path);
		const output = entry.path === 'clang/clang.js' ? Buffer.from(patchClangJs(source.toString('utf8'))) : source;
		Object.assign(entry, { sourceBytes: source.length, sourceSha256: sha256(source), bytes: output.length, sha256: sha256(output) });
		outputs.set(entry.path, output);
		await writeArtifact(sourceDir, `demo/static/${entry.path}`, source);
	}
	const license = Buffer.from('MIT License\nThis includes the binji/clang.js project (https://github.com/binji/clang.js).\n');
	const derivedLicense = Buffer.from(patchNimLicense(license.toString('utf8')));
	Object.assign(contract.lock.license, { sourceBytes: license.length, sourceSha256: sha256(license), bytes: derivedLicense.length, sha256: sha256(derivedLicense) });
	await writeArtifact(sourceDir, 'LICENSE', license);
	outputs.set('LICENSE', derivedLicense);
	const readme = Buffer.from('Nim fixture documentation\n');
	Object.assign(contract.lock.documentation, { bytes: readme.length, sha256: sha256(readme) });
	await writeArtifact(sourceDir, 'README.md', readme);
	outputs.set('README.md', readme);
	outputs.set('THIRD_PARTY_NOTICES.md', await readFile(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url)));
	const oldClang = Buffer.from(legacyLoader(rawClang));
	contract.lock.legacyRuntime.clangJs = { bytes: oldClang.length, sha256: sha256(oldClang) };
	contract.outputs = contract.outputs.map(({ path: name }) => describeArtifact(name, outputs.get(name)));
	return { root, sourceDir, outputDir: path.join(root, 'output'), contract, outputs, oldClang };
}

test('packages the exact raw compiler, modified loader and legal receipt graph deterministically', async () => {
	const value = await fixture();
	const receipt = await packageNim(value);
	assert.equal(receipt.artifacts.length, 11);
	assert.deepEqual(await verifyNimArtifacts(value.outputDir, value.contract), receipt);
	assert.deepEqual(await packageNim({ ...value, outputDir: path.join(value.root, 'second') }), receipt);
	assert.deepEqual(await readFile(path.join(value.outputDir, 'clang/clang.wasm')), emptyModule);
});

test('upgrades only the pinned installed legacy loader and preserves all native bytes', async () => {
	const value = await fixture();
	const runtime = path.join(value.root, 'installed');
	for (const entry of value.contract.lock.assets) {
		const compressed = !['nim/nimbase.h', 'clang/clang.js'].includes(entry.path);
		const bytes = entry.path === 'clang/clang.js' ? value.oldClang : value.outputs.get(entry.path);
		await writeArtifact(runtime, `${entry.path}${compressed ? '.gz.bin' : '.bin'}`, compressed ? gzipSync(bytes) : bytes);
	}
	for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md']) await writeArtifact(runtime, name, value.outputs.get(name));
	const migrated = await packageNim({ fromRuntimeDir: runtime, outputDir: value.outputDir, contract: value.contract });
	const raw = await packageNim({ ...value, outputDir: path.join(value.root, 'raw-output') });
	assert.deepEqual(migrated, raw);
	await writeFile(path.join(runtime, 'clang/clang.js.bin'), 'untrusted legacy loader');
	await assert.rejects(packageNim({ fromRuntimeDir: runtime, outputDir: path.join(value.root, 'bad'), contract: value.contract }), /Legacy runtime clang.js/u);
});

test('rejects mutated upstream bytes, symlinks and explicit missing inputs without fallback', async () => {
	const value = await fixture();
	const compiler = path.join(value.sourceDir, 'demo/static/nim/nim.wasm');
	await writeFile(compiler, Buffer.alloc(8));
	await assert.rejects(packageNim(value), /pinned size and SHA-256/u);
	await rm(compiler);
	await symlink('/etc/passwd', compiler);
	await assert.rejects(packageNim(value), /regular file/u);
	await assert.rejects(packageNim({ ...value, sourceDir: path.join(value.root, 'missing') }), /ENOENT/u);
	await assert.rejects(packageNim({ ...value, download: true }), /exactly one/u);
});

test('rejects recomputed artifact receipts that disagree with code-pinned output hashes', async () => {
	const value = await fixture();
	await packageNim(value);
	const file = path.join(value.outputDir, 'producer-receipt.json');
	const receipt = JSON.parse(await readFile(file));
	const altered = Buffer.alloc(8);
	await writeFile(path.join(value.outputDir, 'nim/nim.wasm'), altered);
	receipt.artifacts = receipt.artifacts.map((entry) => entry.path === 'nim/nim.wasm' ? describeArtifact(entry.path, altered) : entry);
	await writeFile(file, jsonBytes(receipt));
	await assert.rejects(verifyNimArtifacts(value.outputDir, value.contract), /does not match its contract/u);
});

test('rejects overlapping or existing output directories without replacing previous content', async () => {
	const value = await fixture();
	await assert.rejects(packageNim({ ...value, outputDir: path.join(value.sourceDir, 'output') }), /overlap/u);
	await packageNim(value);
	const before = await readFile(path.join(value.outputDir, 'producer-receipt.json'));
	await assert.rejects(packageNim(value), /already exists/u);
	assert.deepEqual(await readFile(path.join(value.outputDir, 'producer-receipt.json')), before);
});

test('accepts a pinned local source archive without extracting its paths to disk', async () => {
	const value = await fixture();
	const archivePath = path.join(value.root, 'source.tar.gz');
	await run('tar', ['-czf', archivePath, '-C', value.root, 'distribution']);
	const bytes = await readFile(archivePath);
	Object.assign(value.contract.lock.artifact, { archiveRoot: 'distribution', bytes: bytes.length, sha256: sha256(bytes) });
	// Output outside the archive's directory preserves the producer's no-overlap boundary.
	const destination = await mkdtemp(path.join(os.tmpdir(), 'nim-archive-output-'));
	roots.push(destination);
	const receipt = await packageNim({ archivePath, outputDir: path.join(destination, 'out'), contract: value.contract });
	assert.equal(receipt.artifacts.length, 11);
	await writeFile(archivePath, Buffer.alloc(bytes.length));
	await assert.rejects(packageNim({ archivePath, outputDir: path.join(destination, 'bad'), contract: value.contract }), /pinned size and SHA-256/u);
});

test('bounds download bodies and rejects redirects, length mismatch, truncation and bad hashes offline', async () => {
	const bytes = Buffer.from('verified archive fixture');
	const artifact = { archiveUrl: 'https://example.invalid/pinned.tar.gz', bytes: bytes.length, sha256: sha256(bytes) };
	const mock = (body = bytes, overrides = {}) => async (_url, options) => {
		assert.equal(options.redirect, 'error');
		assert.equal(options.credentials, 'omit');
		return { ok: true, url: artifact.archiveUrl, headers: new Headers(),
			body: new ReadableStream({ start(controller) { controller.enqueue(body); controller.close(); } }), ...overrides };
	};
	assert.deepEqual(await downloadLockedArchive(artifact, mock()), bytes);
	await assert.rejects(downloadLockedArchive(artifact, mock(bytes, { url: 'https://other.invalid/' })), /unexpected response/u);
	await assert.rejects(downloadLockedArchive(artifact, mock(bytes, { headers: new Headers({ 'content-length': '1' }) })), /Content-Length/u);
	await assert.rejects(downloadLockedArchive(artifact, mock(Buffer.alloc(bytes.length + 1))), /exceeds/u);
	await assert.rejects(downloadLockedArchive(artifact, mock(Buffer.alloc(bytes.length - 1))), /truncated/u);
	await assert.rejects(downloadLockedArchive(artifact, mock(Buffer.alloc(bytes.length))), /pinned size and SHA-256/u);
	await assert.rejects(downloadLockedArchive(artifact, mock(bytes, { body: null })), /unexpected response/u);
});

test('passes cached native Modules by structured clone and uses them without compiling again', async () => {
	const source = patchClangJs(clangFixture());
	assert.equal(upgradeLegacyClangJs(legacyLoader(clangFixture())), source);
	const encoded = source.match(/a="([A-Za-z0-9+/=]+)"/)[1];
	const worker = Buffer.from(encoded, 'base64').toString('utf8');
	assert.ok(!worker.includes('fetch('));
	let compiles = 0;
	const context = vm.createContext({ ArrayBuffer, WebAssembly: {
		Module: WebAssembly.Module, compile: async (bytes) => { compiles++; return WebAssembly.compile(bytes); }
	} });
	vm.runInContext(worker, context);
	const module = await WebAssembly.compile(emptyModule);
	const modules = Object.fromEntries(['clang.wasm', 'lld.wasm', 'memfs.wasm'].map((key) => [key, module]));
	const assets = Object.fromEntries([...Object.keys(modules), 'sysroot.tar'].map((key) => [key, emptyModule.buffer.slice(emptyModule.byteOffset, emptyModule.byteOffset + emptyModule.byteLength)]));
	await context.handle({ data: { id: 'constructor', payload: { assets, modules, port: {} } } });
	assert.equal(await context.options.compileStreaming('clang.wasm'), module);
	assert.equal(compiles, 0);
	await assert.rejects(context.handle({ data: { id: 'constructor', payload: { assets, modules: { ...modules, extra: module }, port: {} } } }), /invalid compiler module map/u);
	await assert.rejects(context.handle({ data: { id: 'constructor', payload: { assets, modules: { ...modules, 'clang.wasm': {} }, port: {} } } }), /invalid compiler module/u);
	await context.handle({ data: { id: 'constructor', payload: { assets, port: {} } } });
	await context.options.compileStreaming('lld.wasm');
	assert.equal(compiles, 1);
	const outer = vm.createContext({});
	vm.runInContext(source, outer);
	await outer.outerInit({ assets, modules });
	assert.equal(outer.sent.p.payload.modules, modules);
	assert.equal(outer.sent.t.length, 5);
	assert.ok(outer.sent.t.slice(1).every((entry) => entry instanceof ArrayBuffer));
});

test('fails closed when upstream loader or license patch anchors drift', () => {
	assert.throws(() => patchClangJs(clangFixture().replace('path:l', 'location:l')), /outer worker constructor/u);
	assert.throws(() => patchNimLicense('unexpected license'), /expected legacy notice/u);
	assert.throws(() => upgradeLegacyClangJs('unexpected loader'), /no embedded worker/u);
});

test('verify CLI only verifies, with an optional output directory', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'nim-producer-cli-'));
	roots.push(root);
	const script = fileURLToPath(new URL('../scripts/package.mjs', import.meta.url));
	const env = { ...process.env, WASM_LLVM_NIM_SOURCE_DIR: root };
	const explicit = await run(process.execPath, [script, '--verify', '--', root], { env }).catch((error) => error);
	assert.match(explicit.stderr, /producer-receipt\.json/u);
	const defaulted = await run(process.execPath, [script, '--verify'], { env }).catch((error) => error);
	const output = `${defaulted.stdout}${defaulted.stderr}`;
	assert.doesNotMatch(output, /Packaged|requires|Invalid/u);
	assert.ok(!output.includes(root), 'verification must not read the packaging source');
	await assert.rejects(run(process.execPath, [script, '--verify', '--source', root], { env }), /cannot be combined/u);
});

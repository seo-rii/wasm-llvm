#!/usr/bin/env node
// Optional derived profiles. This never rewrites the existing full sysroot/release.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
const MAX_BYTES = 128 * 1024 * 1024;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ordered = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export function isCppSysrootPath(name) {
	return name.split('/').includes('c++') || /^libc\+\+(?:abi)?\.a$/.test(path.posix.basename(name));
}
function safePath(name) {
	if (!name || name.startsWith('/') || /[\\\x00-\x1f\x7f:]/.test(name) || name.split('/').some(p => !p || p === '.' || p === '..'))
		throw new Error(`Unsafe sysroot path: ${JSON.stringify(name)}`);
	return name;
}
export async function readSysroot(root) {
	root = path.resolve(root);
	if (!(await fs.lstat(root)).isDirectory()) throw new Error('Sysroot must be a real directory');
	const result = []; let total = 0;
	async function walk(relative) {
		for (const entry of (await fs.readdir(path.join(root, relative), { withFileTypes: true })).sort((a,b)=>ordered(a.name,b.name))) {
			const name = safePath(relative ? `${relative}/${entry.name}` : entry.name);
			if (entry.isDirectory()) { await walk(name); continue; }
			if (!entry.isFile()) throw new Error(`Non-regular sysroot entry: ${name}`);
			const handle = await fs.open(path.join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				const stat = await handle.stat();
				if (!stat.isFile() || stat.size > MAX_BYTES - total || result.length >= 20000) throw new Error('Sysroot exceeds file/byte budget');
				const bytes = await handle.readFile();
				if (bytes.length > MAX_BYTES - total) throw new Error('Sysroot exceeds byte budget');
				total += bytes.length; result.push({ path: name, bytes });
			} finally { await handle.close(); }
		}
	}
	await walk(''); return result;
}
export function deterministicTar(files) {
	const chunks = [];
	const sortedFiles = [...files].sort((a,b)=>ordered(a.path,b.path));
	const directories = new Set(), seenFiles = new Set();
	for (const file of sortedFiles) {
		const name = safePath(file.path);
		if (seenFiles.has(name)) throw new Error(`Duplicate sysroot file: ${name}`);
		seenFiles.add(name);
		for (let parent = path.posix.dirname(name); parent !== '.'; parent = path.posix.dirname(parent)) directories.add(parent);
	}
	const sortedDirectories = [...directories].sort((a,b)=>a.split('/').length-b.split('/').length || ordered(a,b));
	for (const entry of [
		...sortedDirectories.map(name=>({ name, bytes:Buffer.alloc(0), directory:true })),
		...sortedFiles.map(file=>({ name:file.path, bytes:file.bytes, directory:false }))
	]) {
		const name = entry.name; let tail = name, prefix = '';
		if (Buffer.byteLength(tail) > 100) {
			const slash = [...name.matchAll(/\//g)].map(m=>m.index).reverse().find(i=>Buffer.byteLength(name.slice(i+1))<=100 && Buffer.byteLength(name.slice(0,i))<=155);
			if (slash === undefined) throw new Error(`Path exceeds USTAR limit: ${name}`);
			prefix = name.slice(0,slash); tail = name.slice(slash+1);
		}
		const header = Buffer.alloc(512);
		const field = (text, at, length) => { const value = Buffer.from(text); if (value.length > length) throw new Error('USTAR field overflow'); value.copy(header,at); };
		const octal = (value, at, length) => field(value.toString(8).padStart(length-1,'0')+'\0',at,length);
		field(tail,0,100); octal(entry.directory?0o755:0o644,100,8); octal(0,108,8); octal(0,116,8);
		octal(entry.bytes.length,124,12); octal(0,136,12); header.fill(32,148,156); header[156]=entry.directory?53:48;
		field('ustar\0',257,6); field('00',263,2); field(prefix,345,155);
		field([...header].reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ',148,8);
		chunks.push(header);
		if (!entry.directory) chunks.push(Buffer.from(entry.bytes),Buffer.alloc((512-entry.bytes.length%512)%512));
	}
	return Buffer.concat([...chunks,Buffer.alloc(1024)]);
}
function insideDirectory(root, candidate) {
	const relative = path.relative(root, candidate);
	return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
async function realPathForPotentialOutput(candidate) {
	const missing = [];
	let existing = candidate;
	for (;;) {
		try { return path.resolve(await fs.realpath(existing), ...missing.reverse()); }
		catch (error) {
			if (error.code !== 'ENOENT') throw error;
			const parent = path.dirname(existing);
			if (parent === existing) throw error;
			missing.push(path.basename(existing)); existing = parent;
		}
	}
}
export async function packageLanguageSysroots({ sysroot, output, toolchainReceipt }) {
	const root = path.resolve(sysroot), out = path.resolve(output);
	const realRoot = await fs.realpath(root);
	if (insideDirectory(root,out) || insideDirectory(realRoot,await realPathForPotentialOutput(out)))
		throw new Error('Output must be outside the sysroot');
	const receiptBytes = await fs.readFile(toolchainReceipt);
	const receipt = JSON.parse(receiptBytes);
	if (!/^[a-f0-9]{40}$/.test(receipt.llvmCommit) || typeof receipt.llvmVersion !== 'string' || !receipt.llvmVersion)
		throw new Error('Toolchain receipt must identify the exact LLVM revision/version');
	const entries = await readSysroot(root);
	const paths = entries.map(e=>e.path);
	for (const required of [/^include\/(?:wasm32-wasi\/)?stdio\.h$/, /(?:^|\/)crt1\.o$/, /(?:^|\/)libc\.a$/, /(?:^|\/)libclang_rt\.builtins[^/]*\.a$/])
		if (!paths.some(p=>required.test(p))) throw new Error(`Missing required C sysroot input: ${required}`);
	const core = entries.filter(e=>!isCppSysrootPath(e.path));
	const extra = entries.filter(e=>isCppSysrootPath(e.path));
	if (!extra.some(e=>e.path.split('/').includes('c++')) || !extra.some(e=>e.path.endsWith('/libc++.a')))
		throw new Error('Expected a full C/C++ source sysroot');
	const files = entries.map(e=>({ path:e.path, bytes:e.bytes.length, sha256:digest(e.bytes) }));
	const manifest = {
		format:'wasm-clang-language-sysroots-v1',
		source:{ llvmVersion:receipt.llvmVersion, llvmCommit:receipt.llvmCommit, toolchainReceiptSha256:digest(receiptBytes), inventorySha256:digest(JSON.stringify(files)) },
		profiles:{ c:['c-sysroot.tar.gz'], cpp:['c-sysroot.tar.gz','cpp-addon.tar.gz'] }, assets:{}
	};
	await fs.mkdir(path.dirname(out), { recursive:true });
	if (insideDirectory(realRoot,await realPathForPotentialOutput(out)))
		throw new Error('Output must be outside the sysroot');
	// Reserve the final path atomically. A prior lstat followed by rename can replace a
	// concurrently created empty directory on POSIX filesystems.
	try { await fs.mkdir(out); }
	catch (error) { if (error.code === 'EEXIST') throw new Error('Output already exists'); throw error; }
	try {
		for (const [name, selected] of [['c-sysroot.tar.gz',core],['cpp-addon.tar.gz',extra]]) {
			const tar = deterministicTar(selected), compressed = gzipSync(tar,{level:9,mtime:0});
			manifest.assets[name] = { bytes:compressed.length, sha256:digest(compressed), uncompressedBytes:tar.length, uncompressedSha256:digest(tar), files:selected.map(e=>files.find(f=>f.path===e.path)) };
			await fs.writeFile(path.join(out,name),compressed,{flag:'wx'});
		}
		const metadata=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
		const partialManifest=path.join(out,'.language-sysroots.v1.json.tmp');
		await fs.writeFile(partialManifest,metadata,{flag:'wx'});
		// The final manifest is the atomic completion marker for this reserved output.
		await fs.link(partialManifest,path.join(out,'language-sysroots.v1.json'));
		await fs.unlink(partialManifest);
		return { manifest, manifestSha256:digest(metadata) };
	} catch (error) {
		await fs.rm(out,{recursive:true,force:true});
		throw error;
	}
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	if (args.length!==6 || args[0]!=='--sysroot' || args[2]!=='--toolchain-receipt' || args[4]!=='--output') {
		console.error('Usage: node package-language-sysroots.mjs --sysroot DIR --toolchain-receipt FILE --output NEW_DIR'); process.exitCode=1;
	} else {
		try { console.log(JSON.stringify(await packageLanguageSysroots({sysroot:args[1],toolchainReceipt:args[3],output:args[5]}),null,2)); }
		catch(error) { console.error(error.message); process.exitCode=1; }
	}
}

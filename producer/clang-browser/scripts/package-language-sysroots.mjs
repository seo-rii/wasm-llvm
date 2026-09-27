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
	for (const file of [...files].sort((a,b)=>ordered(a.path,b.path))) {
		const name = safePath(file.path); let tail = name, prefix = '';
		if (Buffer.byteLength(tail) > 100) {
			const slash = [...name.matchAll(/\//g)].map(m=>m.index).reverse().find(i=>Buffer.byteLength(name.slice(i+1))<=100 && Buffer.byteLength(name.slice(0,i))<=155);
			if (slash === undefined) throw new Error(`Path exceeds USTAR limit: ${name}`);
			prefix = name.slice(0,slash); tail = name.slice(slash+1);
		}
		const header = Buffer.alloc(512);
		const field = (text, at, length) => { const value = Buffer.from(text); if (value.length > length) throw new Error('USTAR field overflow'); value.copy(header,at); };
		const octal = (value, at, length) => field(value.toString(8).padStart(length-1,'0')+'\0',at,length);
		field(tail,0,100); octal(0o644,100,8); octal(0,108,8); octal(0,116,8);
		octal(file.bytes.length,124,12); octal(0,136,12); header.fill(32,148,156); header[156]=48;
		field('ustar\0',257,6); field('00',263,2); field(prefix,345,155);
		field([...header].reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ',148,8);
		chunks.push(header,Buffer.from(file.bytes),Buffer.alloc((512-file.bytes.length%512)%512));
	}
	return Buffer.concat([...chunks,Buffer.alloc(1024)]);
}
export async function packageLanguageSysroots({ sysroot, output, toolchainReceipt }) {
	const root = path.resolve(sysroot), out = path.resolve(output);
	if (out === root || out.startsWith(root+path.sep)) throw new Error('Output must be outside the sysroot');
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
	try { await fs.lstat(out); throw new Error('Output already exists'); } catch(error) { if(error.code!=='ENOENT') throw error; }
	const temp = await fs.mkdtemp(out+'.tmp-');
	try {
		for (const [name, selected] of [['c-sysroot.tar.gz',core],['cpp-addon.tar.gz',extra]]) {
			const tar = deterministicTar(selected), compressed = gzipSync(tar,{level:9,mtime:0});
			manifest.assets[name] = { bytes:compressed.length, sha256:digest(compressed), uncompressedBytes:tar.length, uncompressedSha256:digest(tar), files:selected.map(e=>files.find(f=>f.path===e.path)) };
			await fs.writeFile(path.join(temp,name),compressed);
		}
		const metadata=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
		await fs.writeFile(path.join(temp,'language-sysroots.v1.json'),metadata);
		// Check again immediately before publication; never intentionally replace a release.
		try { await fs.lstat(out); throw new Error('Output already exists'); } catch(error) { if(error.code!=='ENOENT') throw error; }
		await fs.rename(temp,out);
		return { manifest, manifestSha256:digest(metadata) };
	} finally { await fs.rm(temp,{recursive:true,force:true}); }
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

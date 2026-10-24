#!/usr/bin/env node
// Import only selected, installed GNU development-package files. This never
// downloads packages or treats installed-file hashes as source-archive hashes.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const TARGET = 'x86_64-linux-gnu';
const MAX_FILES = 50000;
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const PACKAGE_FORMAT = '${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\t${Architecture}\t${db:Status-Status}\n';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function inside(root, candidate) {
	const relative = path.relative(root, candidate);
	return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function absolutePackagePath(value) {
	assert(typeof value === 'string' && value.startsWith('/') && !/[\\\x00-\x1f\x7f:]/.test(value) &&
		value.slice(1).split('/').every((part) => part && part !== '.' && part !== '..'), `Unsafe package path: ${value}`);
	return value;
}

function packageRecord(stdout, requested) {
	const rows = stdout.trim().split('\n');
	assert.equal(rows.length, 1, `Ambiguous package metadata: ${requested}`);
	const [name, version, sourcePackage, sourceVersion, architecture, status, extra] = rows[0].split('\t');
	assert.equal(name?.split(':')[0], requested.split(':')[0], `Unexpected package: ${name}`);
	assert.equal(status, 'installed', `Package is not installed: ${requested}`);
	assert(['amd64', 'all'].includes(architecture), `Package has the wrong architecture: ${name}`);
	assert.equal(extra, undefined, `Malformed package metadata: ${requested}`);
	for (const field of [name, version, sourcePackage, sourceVersion]) {
		assert(/^[A-Za-z0-9.+:~_-]+$/.test(field || ''), `Missing or invalid package identity: ${requested}`);
	}
	return { name, version, sourcePackage, sourceVersion, architecture };
}

function distributionIdentity(text) {
	// os-release is data, never shell input. Debian and Ubuntu are the explicitly
	// supported layouts; other distributions need their own curated importer.
	const values = new Map(text.split('\n').flatMap((line) => {
		const match = /^([A-Z_]+)=(?:"([^"\\]*)"|'([^'\\]*)'|([^\s'"\\]*))$/.exec(line);
		return match ? [[match[1], match[2] ?? match[3] ?? match[4]]] : [];
	}));
	assert(['debian', 'ubuntu'].includes(values.get('ID')), 'Only Debian and Ubuntu package layouts are supported');
	assert(values.get('PRETTY_NAME') && values.get('VERSION_ID'), 'Distribution name and version are required');
	return values.get('PRETTY_NAME');
}

function selectedPath(name, gccVersion) {
	if (name.startsWith('/usr/include/')) return true;
	if (/^\/usr\/lib\/x86_64-linux-gnu\/[^/]+\.(?:a|o)$/.test(name)) return true;
	const directory = `/usr/lib/gcc/${TARGET}/${gccVersion}/`;
	if (!name.startsWith(directory)) return false;
	// Clang supplies its own resource headers. Sanitizers, OpenMP, offload, LTO
	// plugins and other executable tools are not part of this static C/C++ profile.
	return /^(?:lib(?:gcc|gcc_eh|stdc\+\+|stdc\+\+fs|supc\+\+|atomic)\.a|crt(?:begin[ST]?|endS?|fastmath|prec(?:32|64|80))\.o)$/.test(name.slice(directory.length));
}

function assertNativeObject(bytes, label) {
	assert(bytes.length >= 64 && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
		bytes[4] === 2 && bytes[5] === 1 && bytes[6] === 1 && bytes.readUInt16LE(16) === 1 && bytes.readUInt16LE(18) === 62,
		`${label}: expected an x86-64 ELF relocatable object`);
}

function assertNativeLibrary(bytes, label) {
	// Debian's libmcheck.a is a single relocatable ELF object despite its suffix.
	if (bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
		assertNativeObject(bytes, label);
		return;
	}
	if (bytes.subarray(0, 8).toString() !== '!<arch>\n') {
		// glibc libm.a may be a textual GROUP script. The packager verifies its
		// references against the complete normalized tree before publishing it.
		assert(!bytes.includes(0) && /\b(?:GROUP|INPUT)\s*\(/.test(bytes.toString('utf8')), `${label}: expected a static archive or GNU linker script`);
		return;
	}
	let offset = 8;
	while (offset < bytes.length) {
		assert(offset + 60 <= bytes.length, `${label}: truncated archive header`);
		const header = bytes.subarray(offset, offset + 60);
		assert.equal(header.subarray(58).toString(), '`\n', `${label}: malformed archive header`);
		const sizeText = header.subarray(48, 58).toString().trim();
		assert(/^\d+$/.test(sizeText), `${label}: malformed archive size`);
		const size = Number(sizeText);
		assert(Number.isSafeInteger(size) && size <= bytes.length - offset - 60, `${label}: truncated archive member`);
		const name = header.subarray(0, 16).toString().trim();
		if (!['/', '//', '/SYM64/'].includes(name)) {
			assertNativeObject(bytes.subarray(offset + 60, offset + 60 + size), `${label}(${name})`);
		}
		offset += 60 + size + size % 2;
	}
	assert.equal(offset, bytes.length, `${label}: truncated archive padding`);
}

async function query(run, command, args) {
	const result = await run(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
	return result.stdout;
}

/** Build a read-only inventory. root/run are injectable solely for fixture tests. */
export async function planNativeSysroot({ root = '/', compiler = 'g++', run = execute } = {}) {
	root = await fs.realpath(root);
	assert(/^(?:x86_64-linux-gnu-)?g\+\+(?:-\d+)?$/.test(path.basename(compiler)) &&
		!/[\x00-\x1f\x7f]/.test(compiler), 'Compiler must be a native GNU g++ executable');
	const target = (await query(run, compiler, ['-dumpmachine'])).trim();
	assert.equal(target, TARGET, 'Native compiler target must be x86_64-linux-gnu');
	const compilerVersion = (await query(run, compiler, ['-dumpfullversion', '-dumpversion'])).trim();
	assert(/^\d+(?:\.\d+){1,2}$/.test(compilerVersion), 'Invalid native GCC version');
	const libgcc = (await query(run, compiler, ['-print-libgcc-file-name'])).trim();
	const installation = /^\/usr\/lib\/gcc\/x86_64-linux-gnu\/(\d+(?:\.\d+){0,2})\/libgcc\.a$/.exec(libgcc);
	assert(installation, 'Native GCC must use the supported /usr/lib/gcc/x86_64-linux-gnu layout');
	const gccVersion = installation[1];
	const major = compilerVersion.split('.')[0];
	assert.equal(gccVersion.split('.')[0], major, 'GCC compiler and installation versions differ');
	const distribution = distributionIdentity(await fs.readFile(path.join(root, 'etc/os-release'), 'utf8'));
	const packages = [];
	const owned = new Set();
	for (const name of ['libc6-dev:amd64', 'linux-libc-dev:amd64', `libgcc-${major}-dev:amd64`, `libstdc++-${major}-dev:amd64`]) {
		let metadata;
		try { metadata = await query(run, 'dpkg-query', ['-W', `-f=${PACKAGE_FORMAT}`, name]); }
		catch (error) {
			// Debian 13 ships all architecture-specific Linux headers in one all
			// package. Keep the amd64 query first to disambiguate older multiarch hosts.
			if (name !== 'linux-libc-dev:amd64' || error.code !== 1) throw error;
			metadata = await query(run, 'dpkg-query', ['-W', `-f=${PACKAGE_FORMAT}`, 'linux-libc-dev:all']);
		}
		const record = packageRecord(metadata, name);
		if (name !== 'linux-libc-dev:amd64') {
			assert.equal(record.architecture, 'amd64', `Native development package must be amd64: ${name}`);
		}
		packages.push(record);
		for (const filename of (await query(run, 'dpkg-query', ['-L', record.name])).trim().split('\n')) {
			if (filename === '/.') continue;
			owned.add(absolutePackagePath(filename));
		}
	}
	const gccPackages = packages.filter((record) => /^lib(?:gcc|stdc\+\+)-/.test(record.name));
	assert.equal(gccPackages[0].sourcePackage, gccPackages[1].sourcePackage, 'GCC development packages have different sources');
	assert.equal(gccPackages[0].sourceVersion, gccPackages[1].sourceVersion, 'GCC development packages have different source versions');
	assert(gccPackages[0].sourceVersion.replace(/^\d+:/, '').startsWith(`${compilerVersion}-`), 'GCC development packages do not match the native compiler version');
	const glibcSource = packages[0].sourceVersion.replace(/^\d+:/, '');
	const glibcVersion = /^(\d+(?:\.\d+){1,2})(?:-|$)/.exec(glibcSource)?.[1];
	assert(glibcVersion, 'Invalid glibc source version');

	const files = new Map();
	const licenseFiles = new Set();
	let totalBytes = 0;
	async function add(filename, { license = false, allowDirectory = false, noticeDirectories = [] } = {}) {
		absolutePackagePath(filename);
		if (files.has(filename.slice(1))) return;
		const input = path.join(root, filename.slice(1));
		const resolved = await fs.realpath(input);
		assert(inside(root, resolved), `Input symlink escapes source root: ${filename}`);
		const logicalResolved = `/${path.relative(root, resolved).split(path.sep).join('/')}`;
		if (license) {
			const allowedNotice = noticeDirectories.some((directory) => logicalResolved === `/usr/share/doc/${directory}/copyright`);
			assert(allowedNotice || (filename.startsWith('/usr/share/common-licenses/') && logicalResolved.startsWith('/usr/share/common-licenses/')),
				`License symlink escapes its notice directories: ${filename}`);
		} else {
			assert(owned.has(logicalResolved) && selectedPath(logicalResolved, gccVersion), `Input symlink leaves selected package files: ${filename}`);
		}
		const stat = await fs.stat(resolved);
		if (stat.isDirectory() && allowDirectory) {
			assert(!(await fs.lstat(input)).isSymbolicLink(), `Directory symlinks are unsupported: ${filename}`);
			return;
		}
		assert(stat.isFile(), `Input is not a regular file: ${filename}`);
		assert(files.size < MAX_FILES && stat.size <= MAX_FILE_BYTES && stat.size <= MAX_BYTES - totalBytes,
			'Sysroot exceeds the 512 MiB / 50000 file budget (64 MiB per file)');
		const bytes = await fs.readFile(resolved);
		assert.equal(bytes.length, stat.size, `Input changed during inspection: ${filename}`);
		if (filename.endsWith('.o')) assertNativeObject(bytes, filename);
		if (filename.endsWith('.a')) assertNativeLibrary(bytes, filename);
		totalBytes += bytes.length;
		files.set(filename.slice(1), { path: filename.slice(1), bytes: bytes.length, sha256: digest(bytes), input, resolved });
		if (license) licenseFiles.add(filename.slice(1));
		return bytes;
	}
	for (const filename of [...owned].filter((name) => selectedPath(name, gccVersion)).sort()) {
		await add(filename, { allowDirectory: true });
	}
	const commonLicenses = new Set();
	for (const record of packages) {
		const packageName = record.name.split(':')[0];
		const filename = `/usr/share/doc/${packageName}/copyright`;
		const text = (await add(filename, { license: true,
			noticeDirectories: [packageName, record.sourcePackage, `${record.sourcePackage}-base`] })).toString('utf8');
		for (const match of text.matchAll(/\/usr\/share\/common-licenses\/[A-Za-z0-9.+_-]+/g)) {
			commonLicenses.add(match[0].replace(/\.+$/, ''));
		}
	}
	if (commonLicenses.size) {
		packages.push(packageRecord(await query(run, 'dpkg-query', ['-W', `-f=${PACKAGE_FORMAT}`, 'base-files']), 'base-files'));
		for (const filename of [...commonLicenses].sort()) await add(filename, { license: true });
	}
	const required = ['usr/include/stdio.h', 'usr/include/stdlib.h', 'usr/include/features.h',
		`usr/include/c++/${gccVersion}/vector`, `usr/include/c++/${gccVersion}/ext/pb_ds/assoc_container.hpp`,
		`usr/include/x86_64-linux-gnu/c++/${gccVersion}/bits/c++config.h`,
		...['crt1.o', 'crti.o', 'crtn.o', 'libc.a', 'libm.a'].map((name) => `usr/lib/x86_64-linux-gnu/${name}`),
		...['crtbeginT.o', 'crtend.o', 'libstdc++.a', 'libgcc.a', 'libgcc_eh.a'].map((name) => `usr/lib/gcc/${TARGET}/${gccVersion}/${name}`)];
	for (const filename of required) assert(files.has(filename), `Required GNU development file is missing: ${filename}`);
	assert(files.has(`usr/include/c++/${gccVersion}/bits/stdc++.h`) || files.has(`usr/include/x86_64-linux-gnu/c++/${gccVersion}/bits/stdc++.h`), 'GNU bits/stdc++.h is missing');
	const sortedFiles = [...files.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
	const provenance = {
		schemaVersion: 1, target: TARGET, gccVersion, compilerVersion, glibcVersion, distribution,
		source: { kind: 'debian-packages', packages,
			evidence: 'Installed package identities and selected-file SHA-256 digests. Original binary/source archives were not fetched or verified.' },
		licenseFiles: [...licenseFiles].sort(),
		files: sortedFiles.map(({ path: name, bytes, sha256 }) => ({ path: name, bytes, sha256 }))
	};
	return { provenance, totalBytes, files: sortedFiles, sourceRoot: root };
}

async function absent(filename, label) {
	try { await fs.lstat(filename); }
	catch (error) { if (error.code === 'ENOENT') return; throw error; }
	throw new Error(`${label} already exists: ${filename}`);
}

async function destinationPath(filename) {
	let parent = path.dirname(filename);
	const suffix = [path.basename(filename)];
	for (;;) {
		try { return path.join(await fs.realpath(parent), ...suffix); }
		catch (error) {
			if (error.code !== 'ENOENT') throw error;
			suffix.unshift(path.basename(parent));
			parent = path.dirname(parent);
		}
	}
}

/** Copy a completed inventory; write the receipt only after every hash agrees. */
export async function importNativeSysroot({ output, provenance: provenanceFile, ...options }) {
	assert(typeof output === 'string' && output && typeof provenanceFile === 'string' && provenanceFile, 'Output and provenance paths are required');
	output = path.resolve(output);
	provenanceFile = path.resolve(provenanceFile);
	assert(!inside(output, provenanceFile), 'Provenance must be outside the sysroot output');
	await absent(provenanceFile, 'Provenance');
	let outputExists = false;
	try {
		const stat = await fs.lstat(output);
		assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Output must be a directory, not a symlink');
		assert.equal((await fs.readdir(output)).length, 0, 'Output directory must be empty');
		outputExists = true;
	} catch (error) { if (error.code !== 'ENOENT') throw error; }
	const plan = await planNativeSysroot(options);
	const canonicalOutput = await destinationPath(output);
	for (const file of plan.files) assert(!inside(canonicalOutput, file.resolved), 'Output overlaps the native source files');
	const canonicalProvenance = await destinationPath(provenanceFile);
	assert(!inside(canonicalOutput, canonicalProvenance), 'Provenance must be outside the sysroot output');
	for (const directory of ['usr/include', 'usr/lib/gcc', 'usr/lib/x86_64-linux-gnu', 'usr/share/doc', 'usr/share/common-licenses']) {
		const sourceDirectory = path.join(plan.sourceRoot, directory);
		assert(!inside(sourceDirectory, canonicalOutput) && !inside(sourceDirectory, canonicalProvenance), 'Outputs must not modify the native source directories');
	}
	await absent(canonicalProvenance, 'Provenance');
	await fs.mkdir(path.dirname(canonicalOutput), { recursive: true });
	await fs.mkdir(path.dirname(canonicalProvenance), { recursive: true });
	if (!outputExists) await fs.mkdir(canonicalOutput);
	for (const file of plan.files) {
		assert.equal(await fs.realpath(file.input), file.resolved, `Input symlink changed: ${file.path}`);
		const bytes = await fs.readFile(file.resolved);
		assert(bytes.length === file.bytes && digest(bytes) === file.sha256, `Input changed while copying: ${file.path}`);
		const destination = path.join(canonicalOutput, file.path);
		await fs.mkdir(path.dirname(destination), { recursive: true });
		assert(inside(canonicalOutput, await fs.realpath(path.dirname(destination))), `Output symlink escapes sysroot: ${file.path}`);
		await fs.writeFile(destination, bytes, { flag: 'wx', mode: 0o644 });
	}
	await fs.writeFile(canonicalProvenance, `${JSON.stringify(plan.provenance, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
	return { output: canonicalOutput, provenance: canonicalProvenance, files: plan.files.length, bytes: plan.totalBytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const options = {};
		let preflight = false;
		const args = process.argv.slice(2);
		for (let index = 0; index < args.length; index += 1) {
			const option = args[index];
			if (option === '--preflight') { assert(!preflight, 'Duplicate --preflight'); preflight = true; continue; }
			const key = { '--output': 'output', '--provenance': 'provenance', '--compiler': 'compiler' }[option];
			assert(key && !options[key] && args[index + 1] && !args[index + 1].startsWith('--'), `Invalid option: ${option}`);
			options[key] = args[++index];
		}
		if (preflight) {
			assert(!options.output && !options.provenance, '--preflight does not accept output paths');
			const { provenance, totalBytes } = await planNativeSysroot(options);
			console.log(JSON.stringify({ target: provenance.target, distribution: provenance.distribution,
				gccVersion: provenance.gccVersion, compilerVersion: provenance.compilerVersion, glibcVersion: provenance.glibcVersion,
				packages: provenance.source.packages, files: provenance.files.length, bytes: totalBytes, status: 'read-only-preflight' }, null, 2));
		} else console.log(JSON.stringify(await importNativeSysroot(options), null, 2));
	} catch (error) {
		console.error(error.message);
		console.error('Usage: node cross/import-sysroot.mjs --output EMPTY_DIR --provenance NEW_JSON [--compiler g++-VERSION]\n       node cross/import-sysroot.mjs --preflight [--compiler g++-VERSION]');
		process.exitCode = 1;
	}
}

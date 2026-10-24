import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { importNativeSysroot, planNativeSysroot } from '../producer/clang-browser/cross/import-sysroot.mjs';
import { readNativeTree, validateGnuSysroot } from '../producer/clang-browser/cross/package.mjs';

function elf(machine = 62) {
	const bytes = Buffer.alloc(64);
	bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
	bytes.writeUInt16LE(1, 16);
	bytes.writeUInt16LE(machine, 18);
	return bytes;
}

function archive(bytes = elf()) {
	const header = Buffer.from(`${'object.o/'.padEnd(16)}${'0'.padEnd(12)}${'0'.padEnd(6)}${'0'.padEnd(6)}${'644'.padEnd(8)}${String(bytes.length).padEnd(10)}\x60\n`);
	return Buffer.concat([Buffer.from('!<arch>\n'), header, bytes, ...(bytes.length % 2 ? [Buffer.from('\n')] : [])]);
}

async function fixture(t, { linuxArchitecture = 'amd64' } = {}) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gnu-sysroot-import-'));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const root = path.join(directory, 'native');
	const output = path.join(directory, 'sysroot');
	const provenance = path.join(directory, 'source.json');
	const manifests = new Map();
	const records = new Map();
	const calls = [];
	const state = { target: 'x86_64-linux-gnu' };
	async function write(name, bytes = '/* GNU fixture */\n') {
		const filename = path.join(root, name.replace(/^\//, ''));
		await fs.mkdir(path.dirname(filename), { recursive: true });
		await fs.writeFile(filename, bytes);
	}
	async function addPackage(name, version, sourcePackage, sourceVersion, entries, architecture = 'amd64') {
		const binaryPackage = architecture === 'all' ? name : `${name}:${architecture}`;
		records.set(`${name}:${architecture}`, [binaryPackage, version, sourcePackage, sourceVersion, architecture, 'installed'].join('\t') + '\n');
		manifests.set(binaryPackage, ['/.', '/usr', '/usr/include', ...Object.keys(entries)]);
		for (const [filename, bytes] of Object.entries(entries)) await write(filename, bytes);
		await write(`/usr/share/doc/${name}/copyright`, 'GNU notice; see /usr/share/common-licenses/GPL-3.\n');
	}
	await write('/etc/os-release', 'ID=debian\nVERSION_ID="12"\nPRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\n');
	await addPackage('libc6-dev', '2.36-1', 'glibc', '2.36-1', {
		'/usr/include/stdio.h': '/* GNU stdio */\n', '/usr/include/stdlib.h': '/* GNU stdlib */\n', '/usr/include/features.h': '/* GNU feature macros */\n',
		'/usr/include/stdint.h': 'typedef unsigned uint32_t;\n',
		...Object.fromEntries(['crt1.o', 'crti.o', 'crtn.o'].map((name) => [`/usr/lib/x86_64-linux-gnu/${name}`, elf()])),
		'/usr/lib/x86_64-linux-gnu/libc.a': archive(),
		'/usr/lib/x86_64-linux-gnu/libmcheck.a': elf(),
		'/usr/lib/x86_64-linux-gnu/libm.a': 'GROUP ( /usr/lib/x86_64-linux-gnu/libm-2.36.a )\n',
		'/usr/lib/x86_64-linux-gnu/libm-2.36.a': archive()
	});
	await addPackage('linux-libc-dev', '6.1-1', 'linux', '6.1-1', { '/usr/include/linux/types.h': '/* Linux types */\n' }, linuxArchitecture);
	await addPackage('libgcc-12-dev', '12.2.0-1', 'gcc-12', '12.2.0-1', {
		...Object.fromEntries(['crtbeginT.o', 'crtend.o'].map((name) => [`/usr/lib/gcc/x86_64-linux-gnu/12/${name}`, elf()])),
		...Object.fromEntries(['libgcc.a', 'libgcc_eh.a', 'libatomic.a'].map((name) => [`/usr/lib/gcc/x86_64-linux-gnu/12/${name}`, archive()])),
		'/usr/lib/gcc/x86_64-linux-gnu/12/libgomp.a': archive(),
		'/usr/lib/gcc/x86_64-linux-gnu/12/include/immintrin.h': '/* GCC-only resource header, excluded */\n'
	});
	await addPackage('libstdc++-12-dev', '12.2.0-1', 'gcc-12', '12.2.0-1', {
		'/usr/include/c++/12/vector': '// GNU vector\n',
		'/usr/include/c++/12/ext/pb_ds/assoc_container.hpp': '// Real GNU PBDS\n',
		'/usr/include/c++/12/ext/pb_ds/detail/rb_tree_map_/rb_tree_.hpp': '// GNU PBDS tree\n',
		'/usr/include/c++/12/ext/pb_ds/detail/tree_policy/order_statistics_imp.hpp': '// GNU PBDS policy\n',
		'/usr/include/x86_64-linux-gnu/c++/12/bits/c++config.h': '// GNU configuration\n',
		'/usr/include/x86_64-linux-gnu/c++/12/bits/stdc++.h': '// GNU bits/stdc++.h\n',
		'/usr/lib/gcc/x86_64-linux-gnu/12/libstdc++.a': archive()
	});
	await write('/usr/share/common-licenses/GPL-3', 'GNU GENERAL PUBLIC LICENSE fixture\n');
	records.set('base-files', 'base-files\t12.4\tbase-files\t12.4\tamd64\tinstalled\n');
	await write('/usr/include/boost/unrelated.hpp', 'Do not bundle arbitrary host headers.\n');
	async function run(command, args) {
		calls.push([command, args]);
		if (command === 'g++' && args[0] === '-dumpmachine') return { stdout: `${state.target}\n` };
		if (command === 'g++' && args[0] === '-dumpfullversion') return { stdout: '12.2.0\n' };
		if (command === 'g++' && args[0] === '-print-libgcc-file-name') return { stdout: '/usr/lib/gcc/x86_64-linux-gnu/12/libgcc.a\n' };
		if (command === 'dpkg-query' && args[0] === '-W') {
			if (records.has(args.at(-1))) return { stdout: records.get(args.at(-1)) };
			throw Object.assign(new Error(`No packages found matching ${args.at(-1)}`), { code: 1 });
		}
		if (command === 'dpkg-query' && args[0] === '-L' && manifests.has(args[1])) return { stdout: `${manifests.get(args[1]).join('\n')}\n` };
		throw new Error(`Unexpected process: ${command} ${args.join(' ')}`);
	}
	return { directory, root, output, provenance, manifests, records, calls, state, write, run };
}

test('imports only package-owned native files, flattens safe links, and records actual file hashes and notices', async (t) => {
	const f = await fixture(t);
	const alias = '/usr/include/stdint-alias.h';
	await fs.symlink('stdint.h', path.join(f.root, alias.slice(1)));
	f.manifests.get('libc6-dev:amd64').push(alias);
	// Debian libgcc/libstdc++ notice directories commonly point to gcc-N-base.
	const doc = path.join(f.root, 'usr/share/doc/libgcc-12-dev');
	await fs.rename(doc, path.join(f.root, 'usr/share/doc/gcc-12-base'));
	await fs.symlink('gcc-12-base', doc);
	const result = await importNativeSysroot(f);
	const receipt = JSON.parse(await fs.readFile(f.provenance, 'utf8'));
	assert.equal(receipt.target, 'x86_64-linux-gnu');
	assert.equal(receipt.gccVersion, '12');
	assert.equal(receipt.compilerVersion, '12.2.0');
	assert.equal(receipt.glibcVersion, '2.36');
	assert.equal(receipt.distribution, 'Debian GNU/Linux 12 (bookworm)');
	assert.equal(receipt.source.kind, 'debian-packages');
	assert.equal(receipt.source.packages[0].sourcePackage, 'glibc');
	assert.match(receipt.source.evidence, /archives were not fetched or verified/);
	assert(receipt.licenseFiles.includes('usr/share/common-licenses/GPL-3'));
	assert(receipt.licenseFiles.includes('usr/share/doc/libgcc-12-dev/copyright'));
	assert.equal(result.files, receipt.files.length);
	let bytes = 0;
	for (const entry of receipt.files) {
		const filename = path.join(f.output, entry.path);
		assert((await fs.lstat(filename)).isFile(), entry.path);
		const contents = await fs.readFile(filename);
		assert.equal(entry.bytes, contents.length);
		assert.equal(entry.sha256, createHash('sha256').update(contents).digest('hex'));
		bytes += contents.length;
	}
	assert.equal(result.bytes, bytes);
	assert.deepEqual(validateGnuSysroot(await readNativeTree(f.output), receipt), {
		gccInstallation: '/sysroot/usr/lib/gcc/x86_64-linux-gnu/12', fileCount: receipt.files.length
	});
	for (const excluded of ['usr/include/boost/unrelated.hpp', 'usr/lib/gcc/x86_64-linux-gnu/12/include/immintrin.h', 'usr/lib/gcc/x86_64-linux-gnu/12/libgomp.a']) {
		await assert.rejects(fs.stat(path.join(f.output, excluded)), { code: 'ENOENT' });
	}
	assert.deepEqual(await fs.readFile(path.join(f.output, alias)), await fs.readFile(path.join(f.output, 'usr/include/stdint.h')));
	assert(f.calls.every(([command]) => ['g++', 'dpkg-query'].includes(command)));
});

test('preflight is read-only and requires the expected native target and matching package versions', async (t) => {
	const f = await fixture(t);
	const plan = await planNativeSysroot(f);
	assert(plan.totalBytes > 0);
	await assert.rejects(fs.stat(f.output), { code: 'ENOENT' });
	await assert.rejects(fs.stat(f.provenance), { code: 'ENOENT' });
	f.state.target = 'wasm32-wasi';
	await assert.rejects(planNativeSysroot(f), /target must be x86_64-linux-gnu/);
	f.state.target = 'x86_64-linux-gnu';
	f.records.set('libstdc++-12-dev:amd64', 'libstdc++-12-dev:amd64\t12.3.0-1\tgcc-12\t12.3.0-1\tamd64\tinstalled\n');
	await assert.rejects(planNativeSysroot(f), /different source versions/);
});

for (const architecture of ['amd64', 'all']) {
	test(`imports ${architecture} Linux headers using the package's returned binary identity`, async (t) => {
		const f = await fixture(t, { linuxArchitecture: architecture });
		await importNativeSysroot(f);
		const receipt = JSON.parse(await fs.readFile(f.provenance, 'utf8'));
		const linux = receipt.source.packages.find((record) => record.sourcePackage === 'linux');
		assert.equal(linux.architecture, architecture);
		assert.equal(linux.name, architecture === 'all' ? 'linux-libc-dev' : 'linux-libc-dev:amd64');
		assert.equal(await fs.readFile(path.join(f.output, 'usr/include/linux/types.h'), 'utf8'), '/* Linux types */\n');
		const queries = f.calls.filter(([command, args]) => command === 'dpkg-query' && args[0] === '-W' && args.at(-1).startsWith('linux-libc-dev'));
		assert.deepEqual(queries.map(([, args]) => args.at(-1)), architecture === 'all'
			? ['linux-libc-dev:amd64', 'linux-libc-dev:all'] : ['linux-libc-dev:amd64']);
		assert(f.calls.some(([command, args]) => command === 'dpkg-query' && args[0] === '-L' && args[1] === linux.name));
		validateGnuSysroot(await readNativeTree(f.output), receipt);
	});
}

test('rejects foreign Linux headers and does not retry failed dpkg operations as missing packages', async (t) => {
	const f = await fixture(t);
	f.records.set('linux-libc-dev:amd64', 'linux-libc-dev:arm64\t6.1-1\tlinux\t6.1-1\tarm64\tinstalled\n');
	await assert.rejects(planNativeSysroot(f), /wrong architecture/);
	const error = Object.assign(new Error('dpkg database is unreadable'), { code: 2 });
	await assert.rejects(planNativeSysroot({ ...f, run: async (command, args) => {
		if (command === 'dpkg-query' && args[0] === '-W' && args.at(-1) === 'linux-libc-dev:amd64') throw error;
		return f.run(command, args);
	} }), (failure) => failure === error);
	assert(!f.calls.some(([, args]) => args.at(-1) === 'linux-libc-dev:all'));
});

for (const name of ['libc6-dev', 'libgcc-12-dev', 'libstdc++-12-dev']) {
	test(`retains the amd64 requirement for ${name}`, async (t) => {
		const f = await fixture(t, { linuxArchitecture: 'all' });
		const record = f.records.get(`${name}:amd64`).trim().split('\t');
		record[0] = name; record[4] = 'all';
		f.records.set(`${name}:amd64`, `${record.join('\t')}\n`);
		await assert.rejects(importNativeSysroot(f), /Native development package must be amd64/);
		await assert.rejects(fs.stat(f.output), { code: 'ENOENT' });
	});
}

test('refuses nonempty output and existing receipts without modifying them', async (t) => {
	const f = await fixture(t);
	await fs.mkdir(f.output);
	await fs.writeFile(path.join(f.output, 'keep.txt'), 'user data');
	await assert.rejects(importNativeSysroot(f), /must be empty/);
	assert.equal(await fs.readFile(path.join(f.output, 'keep.txt'), 'utf8'), 'user data');
	assert.equal(f.calls.length, 0);
	await fs.rm(path.join(f.output, 'keep.txt'));
	await fs.writeFile(f.provenance, 'existing receipt');
	await assert.rejects(importNativeSysroot(f), /Provenance already exists/);
	assert.equal(await fs.readFile(f.provenance, 'utf8'), 'existing receipt');
});

test('rejects traversal in a manifest and links to unowned or outside-root data', async (t) => {
	const f = await fixture(t);
	const entries = f.manifests.get('libc6-dev:amd64');
	entries.push('/usr/include/../../secret');
	await assert.rejects(planNativeSysroot(f), /Unsafe package path/);
	entries.pop();
	const filename = path.join(f.root, 'usr/include/stdio.h');
	await fs.rm(filename);
	await fs.symlink('boost/unrelated.hpp', filename);
	await assert.rejects(planNativeSysroot(f), /leaves selected package files/);
	await fs.rm(filename);
	await fs.writeFile(path.join(f.directory, 'outside.h'), 'outside root');
	await fs.symlink(path.join(f.directory, 'outside.h'), filename);
	await assert.rejects(planNativeSysroot(f), /escapes source root/);
});

test('rejects Wasm and non-x86 archive members before creating any output', async (t) => {
	const f = await fixture(t);
	const library = '/usr/lib/gcc/x86_64-linux-gnu/12/libgcc.a';
	await f.write(library, archive(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])));
	await assert.rejects(importNativeSysroot(f), /expected an x86-64 ELF/);
	await assert.rejects(fs.stat(f.output), { code: 'ENOENT' });
	await f.write(library, archive(elf(183)));
	await assert.rejects(planNativeSysroot(f), /expected an x86-64 ELF/);
	await f.write(library, Buffer.from('!<thin>\n'));
	await assert.rejects(planNativeSysroot(f), /expected a static archive/);
});

test('refuses output symlinks and receipts placed inside the resulting sysroot', async (t) => {
	const f = await fixture(t);
	await assert.rejects(importNativeSysroot({ ...f, provenance: path.join(f.output, 'source.json') }), /outside the sysroot/);
	await fs.mkdir(path.join(f.directory, 'elsewhere'));
	await fs.symlink(path.join(f.directory, 'elsewhere'), f.output);
	await assert.rejects(importNativeSysroot(f), /not a symlink/);
});

test('refuses license links outside their source package and output inside native include directories', async (t) => {
	const f = await fixture(t);
	await assert.rejects(importNativeSysroot({ ...f, output: path.join(f.root, 'usr/include/new-parent/new-sysroot') }), /must not modify the native source/);
	await assert.rejects(fs.stat(path.join(f.root, 'usr/include/new-parent')), { code: 'ENOENT' });
	const copyright = path.join(f.root, 'usr/share/doc/libc6-dev/copyright');
	await fs.rm(copyright);
	await f.write('/usr/share/doc/unrelated/copyright', 'not the GNU runtime notice');
	await fs.symlink('../unrelated/copyright', copyright);
	await assert.rejects(planNativeSysroot(f), /License symlink escapes/);
});

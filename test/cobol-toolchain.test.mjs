import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { verify } from '../producer/cobol-browser/scripts/verify-artifacts.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('verifies the committed COBOL runtime and C sysroot TAR contracts', async () => {
	await verify(path.join(REPO_ROOT, 'artifacts/cobol-browser'));
});

test('rejects a structurally invalid TAR even when the wrapper receipt matches', async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'cobol-tar-'));
	try {
		await cp(path.join(REPO_ROOT, 'artifacts/cobol-browser'), directory, { recursive: true });
		const receipt = JSON.parse(await readFile(path.join(directory, 'toolchain.json'), 'utf8'));
		for (const tar of [Buffer.alloc(1024, 65), Buffer.alloc(1024)]) {
			const writer = new ZipWriter(new Uint8ArrayWriter());
			await writer.add('rootfs.tar', new Uint8ArrayReader(tar));
			const bytes = await writer.close();
			await writeFile(path.join(directory, 'rootfs.tar.zip'), bytes);
			receipt.assets['rootfs.tar.zip'] = {
				bytes: bytes.length,
				sha256: createHash('sha256').update(bytes).digest('hex')
			};
			await writeFile(path.join(directory, 'toolchain.json'), JSON.stringify(receipt));
			await assert.rejects(verify(directory), /TAR|nonempty regular file/);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('keeps compiler temporary files inside the configured producer cache by default', async () => {
	const source = await readFile(
		path.join(REPO_ROOT, 'producer/cobol-browser/scripts/build.sh'),
		'utf8'
	);

	assert.match(source, /TMPDIR=\$\{TMPDIR:-\$CACHE_ROOT\/tmp\}\nexport TMPDIR/);
	assert.match(source, /mkdir -p[^\n]*"\$TMPDIR"/);
});

test('links the non-libtool WASI compatibility object only into the cobc executable', async () => {
	const source = await readFile(
		path.join(REPO_ROOT, 'producer/cobol-browser/scripts/build.sh'),
		'utf8'
	);

	assert.match(
		source,
		/LIBS="-lsetjmp -lwasi-emulated-getpid -lwasi-emulated-signal"[\s\S]*make -j"\$\{JOBS:-4\}" -C libcob libcob\.la/
	);
	assert.match(
		source,
		/make -j"\$\{JOBS:-4\}" -C cobc cobc \\\n\s*LIBS="\$COMPAT_O -lsetjmp -lwasi-emulated-getpid -lwasi-emulated-signal"/
	);
	assert.doesNotMatch(source, /\n\s*LIBS="\$COMPAT_O[^\n]*" \\\n\s*GMP_CFLAGS=/);
});

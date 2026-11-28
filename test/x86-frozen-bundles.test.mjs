import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readTarEntries } from '../scripts/lib/tar.mjs';

const fixtures = new URL('./fixtures/x86-cross/', import.meta.url);
const pins = readFileSync(new URL('README.md', fixtures), 'utf8');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

for (const archive of ['clang.tar.xz', 'gcc.tar.xz', 'gcc13.tar.xz']) {
	test(`frozen x86 bundle matches its published inputs: ${archive}`, () => {
		const row = pins.split('\n').find((line) => line.startsWith(`| \`${archive}\` |`));
		assert.ok(row, `missing pin for ${archive}`);
		const [, manifestName, sha256] = row.match(/\| `([\w.-]+\.json)` \| `([a-f0-9]{64})` \|$/) ?? [];
		assert.ok(sha256, `invalid manifest pin for ${archive}`);
		const bytes = execFileSync('xz', ['-dc', fileURLToPath(new URL(archive, fixtures))], {
			maxBuffer: 192 * 1024 * 1024
		});
		const outer = readTarEntries(bytes);
		function member(name) {
			const entry = outer.get(name);
			assert.ok(entry && !entry.directory, `missing bundle member: ${name}`);
			return bytes.subarray(entry.offset, entry.offset + entry.size);
		}
		const manifestBytes = member(manifestName);
		assert.equal(digest(manifestBytes), sha256, manifestName);
		const manifest = JSON.parse(manifestBytes);
		const provenance = manifest.provenance;
		const records = [
			...Object.values(manifest.assets),
			{ path: 'compiler-build.json', ...provenance.compilerReceipt },
			{ path: 'gnu-provenance.json', ...provenance.gnuReceipt },
			...[provenance.inventory, provenance.profile, provenance.sources].filter(Boolean),
			...(provenance.sourcePatches ?? []),
			...(provenance.hostLicenseFiles ?? [])
		];
		for (const record of records) {
			const actual = member(record.path);
			if (record.bytes !== undefined) assert.equal(actual.length, record.bytes, record.path);
			assert.equal(digest(actual), record.sha256, record.path);
		}
		const sysroot = readTarEntries(member(manifest.assets.sysroot.path));
		const files = [...sysroot.values()].filter((entry) => !entry.directory);
		assert.equal(files.length, manifest.fileCount, 'sysroot fileCount');
		if (manifest.compiler.family === 'gcc') {
			const unwind = sysroot.get(`${manifest.resourceDir.slice('/sysroot/'.length)}/unwind.h`);
			assert.ok(unwind && !unwind.directory && unwind.size > 0, 'missing GCC unwind.h');
		}
	});
}

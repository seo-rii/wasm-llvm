import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

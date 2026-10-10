// Package supplemental license notices separately from the accepted runtime bytes.
// The original builder/acceptance hashes in producer-receipt.json remain unchanged.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const producer = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(producer, '../..');
const name = 'THIRD_PARTY_NOTICES.txt';
const expected = await readFile(path.join(producer, name));
const directories = process.argv.includes('--verify')
	? [path.join(repo, 'artifacts/ecl-browser-notices')]
	: [path.join(repo, 'artifacts/ecl-browser-notices'), path.join(repo, 'out/ecl-browser-notices')];
for (const directory of directories) {
	if (!process.argv.includes('--verify')) {
		await mkdir(directory, { recursive: true });
		await writeFile(path.join(directory, name), expected);
	}
	if (!(await readFile(path.join(directory, name))).equals(expected))
		throw new Error(`ECL third-party notices mismatch: ${directory}`);
}
console.log('Verified ECL third-party notices.');

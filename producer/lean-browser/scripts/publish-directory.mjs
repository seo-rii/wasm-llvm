import { lstat, mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';

/** Serialize publishers and preserve the previous directory until preparation succeeds.
 * A hard process kill can leave the lock and a transaction directory behind; neither is
 * removed automatically because it may belong to a live publisher or hold the last release.
 */
export async function publishDirectory(outDir, prepare, { remove = rm, warn = console.warn } = {}) {
	outDir = path.resolve(outDir);
	await mkdir(path.dirname(outDir), { recursive: true });
	outDir = path.join(await realpath(path.dirname(outDir)), path.basename(outDir));
	const lock = `${outDir}.lock`;
	try {
		await mkdir(lock);
	} catch (error) {
		if (error.code === 'EEXIST') throw new Error(`release output is locked: ${lock}`);
		throw error;
	}
	let transaction;
	let preserveBackup = false;
	let published = false;
	try {
		try {
			if (!(await lstat(outDir)).isDirectory()) throw new Error('release output must be a real directory');
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
		}
		transaction = await mkdtemp(path.join(path.dirname(outDir), `.${path.basename(outDir)}.staging-`));
		const staging = path.join(transaction, 'next');
		const backup = path.join(transaction, 'previous');
		await mkdir(staging);
		const result = await prepare(staging);
		let backedUp = false;
		try {
			await rename(outDir, backup);
			backedUp = true;
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
		}
		try {
			await rename(staging, outDir);
			published = true;
		} catch (error) {
			if (backedUp) {
				try { await rename(backup, outDir); }
				catch (rollbackError) {
					preserveBackup = true;
					throw new AggregateError([error, rollbackError], `restore release manually from ${backup}`);
				}
			}
			throw error;
		}
		return result;
	} finally {
		if (!preserveBackup) {
			for (const target of [transaction, lock].filter(Boolean)) {
				try { await remove(target, { recursive: true, force: true }); }
				catch (error) {
					if (!published) throw error;
					// Publication has committed. Report cleanup separately so callers do not
					// mistake it for a failed release and retry an already completed write.
					warn(`Release published; remove leftover ${target} after inspecting it: ${error.message}`);
				}
			}
		}
	}
}

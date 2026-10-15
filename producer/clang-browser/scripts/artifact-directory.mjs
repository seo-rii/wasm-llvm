import fs from 'node:fs/promises';
import path from 'node:path';

// All validation and writes happen in a unique sibling directory. A per-output
// lock excludes cooperating writers. Publication rolls back on rename failure;
// no recursive writes or deletes ever touch the previous output's contents.
export async function replaceArtifactDirectory(output, prepare) {
	const absolute = path.resolve(output);
	if (absolute === path.parse(absolute).root) throw new Error('Cannot replace a filesystem root');
	await fs.mkdir(path.dirname(absolute), { recursive: true });
	const parent = await fs.realpath(path.dirname(absolute));
	const target = path.join(parent, path.basename(absolute));
	const lock = `${target}.lock`;
	try {
		await fs.mkdir(lock);
	} catch (error) {
		if (error.code === 'EEXIST') throw new Error(`Artifact output is locked: ${lock}`);
		throw error;
	}
	let transaction;
	let movedPrevious = false;
	let published = false;
	let preserveRecovery = false;
	try {
		const stat = await fs.lstat(target).catch((error) => {
			if (error.code === 'ENOENT') return null;
			throw error;
		});
		if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
			throw new Error(`Artifact output must be a directory: ${target}`);
		transaction = await fs.mkdtemp(path.join(parent, `.${path.basename(target)}.staging-`));
		const staged = path.join(transaction, 'next');
		await fs.mkdir(staged);
		await prepare(staged);
		if (stat) {
			await fs.rename(target, path.join(transaction, 'previous'));
			movedPrevious = true;
		}
		try {
			await fs.rename(staged, target);
			published = true;
		} catch (error) {
			if (movedPrevious) {
				try {
					await fs.rename(path.join(transaction, 'previous'), target);
					movedPrevious = false;
				} catch (rollbackError) {
					preserveRecovery = true;
					throw new AggregateError([error, rollbackError], `Publication rollback failed; previous output preserved in ${transaction}/previous; lock retained at ${lock}`);
				}
			}
			throw error;
		}
	} finally {
		// Interrupted processes leave the lock/staging for explicit recovery. Never
		// guess that another process's lock or staged directory is safe to delete.
		if (!preserveRecovery) {
			if (transaction) {
				try {
					await fs.rm(transaction, { recursive: true, force: true });
				} catch (error) {
					if (!published) throw error;
					console.warn(`Published ${target}; old output cleanup pending at ${transaction}: ${error.message}`);
				}
			}
			try {
				await fs.rmdir(lock);
			} catch (error) {
				if (!published) throw error;
				console.warn(`Published ${target}; lock cleanup pending at ${lock}: ${error.message}`);
			}
		}
	}
}

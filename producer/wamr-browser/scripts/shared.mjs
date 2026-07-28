import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const producerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function readSourceLock() {
	return JSON.parse(await readFile(path.join(producerRoot, 'sources.lock.json'), 'utf8'));
}

export async function verifyGitRevision(directory, expectedCommit, label) {
	const actualCommit = await run('git', ['rev-parse', 'HEAD'], {
		cwd: directory,
		capture: true
	});
	if (actualCommit !== expectedCommit) {
		throw new Error(
			`${label} checkout mismatch: expected ${expectedCommit}, received ${actualCommit}`
		);
	}
}

export function parseArguments(argv) {
	const result = {};
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index];
		if (!value.startsWith('--')) throw new Error(`unexpected argument: ${value}`);
		const key = value.slice(2);
		const next = argv[index + 1];
		if (!next || next.startsWith('--')) throw new Error(`missing value for --${key}`);
		result[key] = next;
		index += 1;
	}
	return result;
}

export function isMain(importMetaUrl) {
	return (
		typeof process.argv[1] === 'string' &&
		path.resolve(process.argv[1]) === fileURLToPath(importMetaUrl)
	);
}

export function run(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
		});
		let stdout = '';
		let stderr = '';
		child.stdout?.on('data', (chunk) => {
			stdout += chunk;
		});
		child.stderr?.on('data', (chunk) => {
			stderr += chunk;
		});
		child.on('error', reject);
		child.on('close', (code) => {
			if (code === 0) {
				resolve(options.capture ? stdout.trim() : undefined);
				return;
			}
			reject(
				new Error(
					`${command} exited with ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`
				)
			);
		});
	});
}

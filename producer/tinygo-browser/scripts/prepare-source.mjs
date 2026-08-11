#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
	loadTinyGoProducerContract,
	prepareTinyGoSourceReceipt,
	verifyTinyGoSourceReceipt
} from './source-contract.mjs';

const execFileAsync = promisify(execFile);
const THIS_FILE = fileURLToPath(import.meta.url);

export function parsePrepareSourceArgs(argv) {
	const positional = [];
	let verify = false;
	for (const argument of argv) {
		if (argument === '--') continue;
		if (argument === '--verify') verify = true;
		else if (argument === '--help' || argument === '-h') return { help: true };
		else if (argument.startsWith('-')) throw new Error(`Unknown option: ${argument}`);
		else positional.push(argument);
	}
	if (positional.length !== 2) {
		throw new Error('Expected SOURCE_DIR and RECEIPT_PATH');
	}
	return {
		help: false,
		verify,
		sourceDir: path.resolve(positional[0]),
		receiptPath: path.resolve(positional[1])
	};
}

export async function ensurePinnedTinyGoCheckout({
	sourceDir,
	lock,
	execFileImpl = execFileAsync
}) {
	const gitDirectory = path.join(sourceDir, '.git');
	const cloned = !(await stat(gitDirectory).catch(() => null));
	if (cloned) {
		const existing = await readdir(sourceDir).catch((error) => {
			if (error?.code === 'ENOENT') return [];
			throw error;
		});
		if (existing.length > 0) {
			throw new Error(`Refusing to replace non-Git source directory: ${sourceDir}`);
		}
		await execFileImpl(
			'git',
			[
				'clone',
				'--filter=blob:none',
				'--no-checkout',
				'--branch',
				lock.tinygo.ref,
				'--depth=1',
				lock.tinygo.repository,
				sourceDir
			],
			{ encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
		);
		await execFileImpl(
			'git',
			['-C', sourceDir, 'checkout', '--detach', lock.tinygo.commit],
			{ encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
		);
	}
	await execFileImpl(
		'git',
		['-C', sourceDir, 'submodule', 'update', '--init', '--recursive', '--depth=1'],
		{ encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
	);
	return { cloned, sourceDir };
}

export async function runPrepareSource(argv = process.argv.slice(2)) {
	const options = parsePrepareSourceArgs(argv);
	if (options.help) {
		console.log(
			[
				'Usage: node scripts/prepare-source.mjs [--verify] SOURCE_DIR RECEIPT_PATH',
				'',
				'Without --verify, clone the locked upstream TinyGo source when needed and write',
				'a deterministic source receipt. With --verify, reject stale receipts and any',
				'modified or untracked source, including custom wasmbridge compiler code.'
			].join('\n')
		);
		return null;
	}
	if (options.verify) {
		const receipt = await verifyTinyGoSourceReceipt(options);
		console.log(`Verified upstream TinyGo source receipt ${options.receiptPath}`);
		return receipt;
	}

	const { lock } = await loadTinyGoProducerContract();
	await ensurePinnedTinyGoCheckout({ sourceDir: options.sourceDir, lock });
	const receipt = await prepareTinyGoSourceReceipt(options);
	console.log(`Prepared upstream TinyGo source receipt ${options.receiptPath}`);
	return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
	runPrepareSource().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}

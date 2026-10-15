#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const pinsPath = fileURLToPath(new URL('../config/bootstrap-toolchains.json', import.meta.url));
const pinsBytes = await fs.readFile(pinsPath);
const pins = JSON.parse(pinsBytes);
const manifestSha256 = createHash('sha256').update(pinsBytes).digest('hex');

export async function inspectFile(file) {
	let bytes = 0;
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(file)) { bytes += chunk.length; hash.update(chunk); }
	return { bytes, sha256: hash.digest('hex') };
}

export async function verifyBootstrapFile(file, pin) {
	if (!pin || !/^[a-f0-9]{64}$/.test(pin.sha256)) throw new Error('Unknown or invalid bootstrap pin');
	const identity = await inspectFile(file);
	if (identity.sha256 !== pin.sha256) throw new Error('Bootstrap SHA-256 mismatch; refusing to execute or extract input');
	return { ...pin, ...identity };
}

async function updateReceipt(file, update) {
	const receipt = await fs.readFile(file, 'utf8').then(JSON.parse).catch((error) => {
		if (error.code !== 'ENOENT') throw error;
		return { schemaVersion: 1, producerId: 'wasm-llvm/tinygo-browser', manifestSha256, inputs: {}, tools: {} };
	});
	if (receipt.manifestSha256 !== manifestSha256) throw new Error('Bootstrap receipt belongs to different input pins');
	await update(receipt);
	await fs.mkdir(path.dirname(file), { recursive: true });
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		await fs.writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
		await fs.rename(temporary, file);
	} finally { await fs.rm(temporary, { force: true }); }
}

export async function recordTools(receipt, entries) {
	for (const name of ['llvmInstaller', 'wasiSdk', 'tinygo', 'go']) {
		if (receipt.inputs[name]?.sha256 !== pins[name].sha256) throw new Error(`Missing verified bootstrap input: ${name}`);
	}
	for (const [name, executable] of entries) {
		if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(name) || !executable) throw new Error('Invalid native tool identity');
		const args = ['tinygo', 'go'].includes(name) ? ['version'] : ['--version'];
		const identity = await inspectFile(executable);
		const { stdout, stderr } = await execFileAsync(executable, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
		receipt.tools[name] = { ...identity, version: `${stdout}${stderr}`.trim() };
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [command, ...args] = process.argv.slice(2);
	if (command === '--verify' && args.length === 3) {
		const [name, file, receipt] = args;
		const identity = await verifyBootstrapFile(file, pins[name]);
		await updateReceipt(receipt, async (value) => { value.inputs[name] = identity; });
	} else if (command === '--record-tools' && args.length >= 2) {
		const [receipt, ...entries] = args;
		await updateReceipt(receipt, (value) => recordTools(value, entries.map((entry) => {
			const separator = entry.indexOf('=');
			return [entry.slice(0, separator), entry.slice(separator + 1)];
		})));
	} else throw new Error('Usage: verify-bootstrap.mjs --verify <pin> <file> <receipt> | --record-tools <receipt> <name=executable>...');
}

import { ZipReader, Uint8ArrayReader } from '@zip.js/zip.js';
import { assertClangWasiContract } from './clang-wasi-contract.mjs';

export const MAX_CLANG_ASSET_BYTES = 512 * 1024 * 1024;

// This producer uses exactly one named regular file per ZIP, with no directory entries.
export async function readClangZip(bytes, expectedName) {
	const reader = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false });
	try {
		const entries = await reader.getEntries();
		const entry = entries[0];
		const mode = entry?.externalFileAttributes >>> 16;
		if (entries.length !== 1 || !entry || entry.directory || entry.filename !== expectedName ||
			entry.encrypted || ![0, 8].includes(entry.compressionMethod) ||
			(mode & 0xf000) !== 0 && (mode & 0xf000) !== 0x8000 ||
			!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize <= 0 ||
			entry.uncompressedSize > MAX_CLANG_ASSET_BYTES) {
			throw new Error(`Invalid ${expectedName} ZIP: expected exactly one named regular file within the size limit`);
		}
		const chunks = [];
		let length = 0;
		await entry.getData(new WritableStream({
			write(chunk) {
				length += chunk.length;
				if (length > entry.uncompressedSize || length > MAX_CLANG_ASSET_BYTES)
					throw new Error(`Invalid ${expectedName} ZIP: expanded size exceeds its limit`);
				chunks.push(Buffer.from(chunk));
			}
		}), { checkSignature: true });
		if (length !== entry.uncompressedSize)
			throw new Error(`Invalid ${expectedName} ZIP: expanded size mismatch`);
		return Buffer.concat(chunks, length);
	} finally {
		await reader.close();
	}
}

export async function assertWasm(label, bytes) {
	if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d)
		throw new Error(`${label} is not a WebAssembly module`);
	const module = await WebAssembly.compile(bytes);
	if (label === 'clang' || label === 'lld') assertClangWasiContract(label, bytes, module);
}

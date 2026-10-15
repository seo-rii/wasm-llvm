// A deliberately small TAR contract for producer artifacts: regular files and directories.
// PAX, GNU long names, links, sparse files, and base-256 sizes must be normalized by
// the producer before packaging instead of silently changing the meaning of a path.
export function readTarEntries(bytes) {
	if (!(bytes instanceof Uint8Array) || bytes.length < 1024 || bytes.length % 512 !== 0)
		throw new Error('TAR must contain complete blocks and a two-block terminator');
	const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
	const entries = new Map();
	let terminated = false;
	for (let offset = 0; offset < bytes.length; ) {
		const header = bytes.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) {
			if (offset + 1024 > bytes.length || !bytes.subarray(offset).every((byte) => byte === 0))
				throw new Error('TAR has an incomplete terminator or trailing data');
			terminated = true;
			break;
		}
		const text = (start, length) => {
			const field = header.subarray(start, start + length);
			const end = field.indexOf(0);
			if (end >= 0 && !field.subarray(end).every((byte) => byte === 0))
				throw new Error('TAR text field contains data after NUL');
			return decoder.decode(end < 0 ? field : field.subarray(0, end));
		};
		const octal = (start, length) => {
			const value = decoder.decode(header.subarray(start, start + length)).replace(/[\0 ]+$/g, '').trim();
			if (!/^[0-7]+$/.test(value)) throw new Error('TAR has an invalid octal number');
			const number = Number.parseInt(value, 8);
			if (!Number.isSafeInteger(number)) throw new Error('TAR number exceeds the safe integer range');
			return number;
		};
		const checksum = octal(148, 8);
		const actualChecksum = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
		if (checksum !== actualChecksum) throw new Error('TAR header checksum mismatch');
		const magic = decoder.decode(header.subarray(257, 263));
		if (magic !== 'ustar\0' && magic !== 'ustar ') throw new Error('TAR must use ustar or GNU headers');
		const type = header[156];
		if (![0, 48, 53].includes(type)) throw new Error(`TAR entry type ${type} is unsupported`);
		const prefix = magic === 'ustar\0' ? text(345, 155) : '';
		const rawName = prefix ? `${prefix}/${text(0, 100)}` : text(0, 100);
		const name = rawName.replace(/^\.\//, '').replace(/\/$/, '');
		const directory = type === 53;
		if (/[\x00-\x1f\x7f\\]/.test(rawName) || rawName.startsWith('/') ||
			(name && name.split('/').some((part) => !part || part === '.' || part === '..')) ||
			(!name && (!directory || rawName !== './')) || (!directory && rawName.endsWith('/')))
			throw new Error(`TAR has an unsafe path: ${rawName}`);
		if (entries.has(name)) throw new Error(`TAR has a duplicate path: ${name}`);
		const size = octal(124, 12);
		if (directory && size !== 0) throw new Error(`TAR directory has a payload: ${name}`);
		const next = offset + 512 + Math.ceil(size / 512) * 512;
		if (!Number.isSafeInteger(next) || next <= offset || next > bytes.length)
			throw new Error(`TAR payload is truncated: ${name}`);
		entries.set(name, { name, directory, size, offset: offset + 512 });
		offset = next;
	}
	if (!terminated) throw new Error('TAR is missing its two-block terminator');
	for (const name of entries.keys()) {
		const parts = name.split('/');
		for (let i = 1; i < parts.length; i++) {
			const ancestor = entries.get(parts.slice(0, i).join('/'));
			if (ancestor && !ancestor.directory) throw new Error(`TAR file is also a directory: ${ancestor.name}`);
		}
	}
	return entries;
}

export function requireTarFiles(bytes, required, label = 'TAR') {
	const entries = readTarEntries(bytes);
	for (const name of required) {
		const entry = entries.get(name.replace(/^\.\//, ''));
		if (!entry || entry.directory || entry.size === 0)
			throw new Error(`${label} requires a nonempty regular file: ${name}`);
	}
	return entries;
}

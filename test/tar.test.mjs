import assert from 'node:assert/strict';
import test from 'node:test';
import { readTarEntries, requireTarFiles } from '../scripts/lib/tar.mjs';

function checksum(header) {
	header.fill(32, 148, 156);
	const sum = header.reduce((a, b) => a + b, 0);
	header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
	return header;
}

function member(name = 'include/test.h', payload = 'hello', type = '0') {
	const header = Buffer.alloc(512);
	header.write(name);
	header.write(`${Buffer.byteLength(payload).toString(8).padStart(11, '0')}\0`, 124);
	header.write(type, 156);
	header.write('ustar\0', 257);
	header.write('00', 263);
	const data = Buffer.alloc(Math.ceil(Buffer.byteLength(payload) / 512) * 512);
	data.write(payload);
	return Buffer.concat([checksum(header), data]);
}
const archive = (...members) => Buffer.concat([...members, Buffer.alloc(1024)]);

test('TAR accepts regular files, directories and ustar prefixes', () => {
	const file = member();
	file.write('sysroot', 345);
	checksum(file.subarray(0, 512));
	const entries = requireTarFiles(archive(member('./', '', '5'), file), ['sysroot/include/test.h']);
	assert.equal(entries.get('sysroot/include/test.h').size, 5);
});

for (const size of ['-1000', '8', '00000garbage', '77777777777']) {
	test(`TAR rejects malformed or out-of-bounds size ${size}`, () => {
		const file = member();
		file.fill(0, 124, 136);
		file.write(size, 124);
		checksum(file.subarray(0, 512));
		assert.throws(() => readTarEntries(archive(file)), /octal|truncated/);
	});
}

test('TAR size fields accept ASCII octal with space and NUL padding', () => {
	for (const size of ['5', '000000000005', '   5', '5   ', ' 5\0 ', '5\0\0 ']) {
		const file = member();
		file.fill(0, 124, 136);
		file.write(size, 124);
		checksum(file.subarray(0, 512));
		assert.equal(readTarEntries(archive(file)).get('include/test.h').size, 5, JSON.stringify(size));
	}
});

test('TAR octal fields reject Unicode whitespace, control bytes and digits after padding', () => {
	for (const size of ['\u00a05', '5\u00a0', '\u20035', '\ufeff5', '\t5', '5\r', '\n5',
		'  ', '\0', '\x005', '5\0 1', '5 1']) {
		const file = member();
		file.fill(0, 124, 136);
		file.write(size, 124);
		checksum(file.subarray(0, 512));
		assert.throws(() => readTarEntries(archive(file)), /invalid octal/, JSON.stringify(size));
	}
	for (const whitespace of ['\u00a0', '\u2003', '\ufeff', '\t', '\n', '\r']) {
		const file = member();
		file[148] = 32;
		const sum = file.subarray(0, 512).reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
		file.fill(0, 148, 156);
		file.write(whitespace + sum.toString(8), 148);
		assert.throws(() => readTarEntries(archive(file)), /invalid octal/, `checksum ${JSON.stringify(whitespace)}`);
	}
});

test('TAR rejects checksum corruption, truncation and invalid termination', () => {
	const file = member();
	const corrupt = Buffer.from(file);
	corrupt[0] ^= 1;
	assert.throws(() => readTarEntries(archive(corrupt)), /checksum/);
	assert.throws(() => readTarEntries(file), /terminator/);
	assert.throws(() => readTarEntries(Buffer.concat([file, Buffer.alloc(512)])), /terminator/);
	assert.throws(() => readTarEntries(archive(file).subarray(0, -1)), /complete blocks/);
	assert.throws(() => readTarEntries(archive(file, Buffer.alloc(1024), file)), /trailing/);
});

for (const type of ['1', '2', 'x', 'L', 'S']) {
	test(`TAR explicitly rejects unsupported entry type ${type}`, () => {
		assert.throws(() => readTarEntries(archive(member('entry', '', type))), /unsupported/);
	});
}

for (const name of ['../escape', '/absolute', 'x/../escape', 'x\\escape', 'x//y', 'x\ny']) {
	test(`TAR rejects unsafe path ${JSON.stringify(name)}`, () => {
		assert.throws(() => readTarEntries(archive(member(name))), /unsafe path/);
	});
}

test('TAR rejects duplicate paths, file-directory collisions and missing required payloads', () => {
	assert.throws(() => readTarEntries(archive(member('a'), member('./a'))), /duplicate/);
	assert.throws(() => readTarEntries(archive(member('a/b'), member('a'))), /also a directory/);
	for (const entry of [member('required', '', '5'), member('required', ''), member('other')])
		assert.throws(() => requireTarFiles(archive(entry), ['required']), /nonempty regular file/);
});

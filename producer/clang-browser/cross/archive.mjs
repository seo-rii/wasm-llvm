import assert from 'node:assert/strict';

export function assertGnuArchive(bytes, label, allowEmpty, checkObject) {
	assert.equal(bytes.subarray(0, 8).toString(), '!<arch>\n', `${label}: expected a regular static archive, not thin/LTO-only input`);
	let offset = 8;
	const objects = new Set();
	let index;
	let indexWidth;
	while (offset < bytes.length) {
		assert(offset + 60 <= bytes.length, `${label}: truncated archive header`);
		const header = bytes.subarray(offset, offset + 60);
		assert.equal(header.subarray(58).toString(), '`\n', `${label}: bad archive header`);
		const sizeText = header.subarray(48, 58).toString().trim();
		assert(/^\d+$/.test(sizeText), `${label}: invalid member size`);
		const size = Number(sizeText);
		const name = header.subarray(0, 16).toString().trim();
		assert(Number.isSafeInteger(size) && size <= bytes.length - offset - 60, `${label}: truncated archive member`);
		let member = bytes.subarray(offset + 60, offset + 60 + size);
		if (name === '/' || name === '/SYM64/') {
			assert.equal(offset, 8, `${label}: GNU archive symbol index must be the first member`);
			index = member;
			indexWidth = name === '/' ? 4 : 8;
		} else if (name !== '//') {
			if (name.startsWith('#1/')) {
				const nameSize = Number(name.slice(3));
				assert(Number.isSafeInteger(nameSize) && nameSize >= 0 && nameSize < member.length, `${label}: bad BSD member name`);
				member = member.subarray(nameSize);
			}
			checkObject(member, `${label}(${name})`);
			objects.add(offset);
		}
		offset += 60 + size + size % 2;
	}
	assert(offset === bytes.length && (objects.size > 0 || allowEmpty), `${label}: empty or malformed archive`);
	// GNU ld accepts empty archives and zero-symbol indexes. A nonempty
	// archive produced with ar's S modifier cannot be linked by GNU ld.
	assert(index || !objects.size, `${label}: archive has no GNU symbol index`);
	if (!index) return;
	const readIndex = (at) => indexWidth === 4 ? index.readUInt32BE(at) : Number(index.readBigUInt64BE(at));
	assert(index.length >= indexWidth, `${label}: truncated archive symbol index`);
	const symbols = readIndex(0);
	let nameOffset = (1 + symbols) * indexWidth;
	assert(nameOffset <= index.length, `${label}: truncated archive symbol offsets`);
	for (let symbol = 0; symbol < symbols; symbol++) {
		assert(objects.has(readIndex((1 + symbol) * indexWidth)), `${label}: symbol index points outside archive members`);
		const terminator = index.indexOf(0, nameOffset);
		assert(terminator > nameOffset, `${label}: invalid archive symbol name`);
		nameOffset = terminator + 1;
	}
}

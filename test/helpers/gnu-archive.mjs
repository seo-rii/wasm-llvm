// A regular GNU ar file with one ELF member. The default index describes
// an object without exported symbols, as produced by ar rcs for that input.
export function archiveMember(name, contents) {
	const header = Buffer.alloc(60, 0x20);
	header.write(name);
	header.write(String(contents.length), 48);
	header.write('`\n', 58);
	return Buffer.concat([header, contents, ...(contents.length % 2 ? [Buffer.from('\n')] : [])]);
}

export function gnuArchive(object) {
	return Buffer.concat([Buffer.from('!<arch>\n'), archiveMember('/', Buffer.alloc(4)), archiveMember('member.o/', object)]);
}

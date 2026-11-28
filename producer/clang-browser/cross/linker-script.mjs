import assert from 'node:assert/strict';

// Read the GNU ld commands used by static sysroot libraries. Keep quotes on
// tokens until deciding whether an input denotes a filename or a -l option.
export function libraryScriptInputs(bytes, label) {
	const source = bytes.toString('utf8');
	assert(!source.includes('\0'), `${label}: expected a static archive or GNU linker script`);
	const lexer = /\s+|\/\*[\s\S]*?(?:\*\/|$)|#[^\n]*|"[^"\0]*"|[(),;]|[^\s(),;"#][^\s();"]*/gy;
	function next(allowHashComment = false) {
		while (lexer.lastIndex < source.length) {
			const match = lexer.exec(source);
			assert(match, `${label}: malformed GNU linker script token`);
			const token = match[0];
			if (/^\s/.test(token)) continue;
			if (token.startsWith('/*')) {
				assert(token.length >= 4 && token.endsWith('*/'), `${label}: unterminated linker script comment`);
				continue;
			}
			if (allowHashComment && token.startsWith('#')) continue;
			return token;
		}
		return null;
	}
	const unquote = token => token.startsWith('"') ? token.slice(1, -1) : token;
	const expect = token => assert.equal(next(), token, `${label}: expected ${token} in GNU linker script`);
	const references = [];
	for (let command; (command = next(true)) !== null;) {
		if (command === ';') continue;
		if (command === 'OUTPUT_FORMAT') {
			expect('(');
			let formats = 0;
			let separator;
			do {
				const format = next();
				assert(format && unquote(format) === 'elf64-x86-64', `${label}: unsupported output format`);
				formats++;
				separator = next();
			} while (separator === ',');
			assert(separator === ')' && [1, 3].includes(formats), `${label}: malformed OUTPUT_FORMAT`);
			continue;
		}
		assert(command === 'GROUP' || command === 'INPUT', `${label}: expected a static archive or GNU linker script, unsupported command ${command}`);
		expect('(');
		const needsInput = [true];
		while (needsInput.length) {
			const token = next();
			const level = needsInput.length - 1;
			assert(token !== null, `${label}: unterminated ${command}`);
			if (token === ';') continue;
			if (token === ',' || token === ')') {
				assert(!needsInput[level], `${label}: expected a library input`);
				if (token === ')') needsInput.pop();
				else needsInput[level] = true;
				continue;
			}
			needsInput[level] = false;
			if (token === 'AS_NEEDED') {
				expect('(');
				needsInput.push(true);
			} else {
				const name = unquote(token);
				const library = token.startsWith('-l');
				assert(library || /\.(?:a|o)$/.test(name), `${label}: unsupported linker-script input ${token}`);
				references.push({ name, library });
			}
		}
	}
	assert(references.length, `${label}: expected a static archive or GNU linker script with inputs`);
	return references;
}

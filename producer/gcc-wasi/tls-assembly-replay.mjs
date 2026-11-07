import assert from 'node:assert/strict';

// TLS C++ can interleave data-symbol imports (__dso_handle) with function
// imports in GCC's unordered declaration map. Reorder only those complete
// top-level declarations; retain every byte of their contents and the body.
export function canonicalTlsAssembly(assembly) {
  assert(typeof assembly === 'string' || Buffer.isBuffer(assembly));
  assert(Buffer.byteLength(assembly) <= 16 * 1024 * 1024, 'Oversized GCC TLS assembly');
  const text = typeof assembly === 'string' ? assembly
    : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(assembly);
  assert.match(text, /^\(module[\s)]/u, 'Expected GCC module');
  const lines = text.split('\n'), positions = [], imports = [];
  let depth = 0, comments = 0, quoted = false, roots = 0, prefixEnded = false;
  const declarationStart = /^\s*\((?:import|@sym\.import\.data)(?:\s|\()/u;
  const exactIndent = /^  \((?:import|@sym\.import\.data) /u;
  for (const [index, line] of lines.entries()) {
    const atModule = depth === 1 && comments === 0 && !quoted;
    const declaration = atModule && declarationStart.test(line);
    if (declaration) {
      assert(!prefixEnded && exactIndent.test(line), 'Import outside the supported GCC TLS declaration prefix');
    } else if (atModule && /^\s*\((?!;)/u.test(line)) prefixEnded = true;
    let declarationEnd = -1;
    for (let cursor = 0; cursor < line.length; cursor++) {
      if (comments) {
        if (line.startsWith('(;', cursor)) { comments++; cursor++; }
        else if (line.startsWith(';)', cursor)) { comments--; cursor++; }
        continue;
      }
      if (quoted) {
        if (line[cursor] === '\\') cursor++;
        else if (line[cursor] === '"') quoted = false;
        continue;
      }
      if (line.startsWith(';;', cursor)) break;
      if (line.startsWith('(;', cursor)) { comments++; cursor++; continue; }
      if (line[cursor] === '"') { quoted = true; continue; }
      if (line[cursor] === '(') { if (!depth) roots++; depth++; }
      if (line[cursor] === ')') {
        assert(depth > 0, 'Unbalanced GCC TLS assembly'); depth--;
        if (declaration && depth === 1 && declarationEnd < 0) declarationEnd = cursor + 1;
      }
    }
    if (declaration) {
      assert(depth === 1 && !quoted && !comments && declarationEnd > 0
        && /^\s*$/u.test(line.slice(declarationEnd)),
      'Only complete single-line import declarations may be reordered');
      positions.push(index); imports.push(line);
    }
  }
  assert.equal(depth, 0, 'Unclosed GCC module');
  assert.equal(comments, 0, 'Unclosed WAT comment');
  assert.equal(quoted, false, 'Unclosed WAT string');
  assert.equal(roots, 1, 'Expected exactly one module');
  imports.sort();
  for (const [index, position] of positions.entries()) lines[position] = imports[index];
  return lines.join('\n');
}

export function assertTlsAssemblyReplay(original, fresh) {
  assert.equal(canonicalTlsAssembly(fresh), canonicalTlsAssembly(original),
    'Recompiled GCC TLS assembly changed beyond complete import declaration order');
}

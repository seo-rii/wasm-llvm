/** Conservative qualified-import/same-package lexical references, not a semantic compiler call graph. */
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MODIFIERS = '(?:(?:public|private|internal|protected|abstract|open|sealed|data|value|enum|annotation|inline|suspend|tailrec|operator|infix|external|const|lateinit|override|expect|actual|final) +)*';

export function selectedDeclarations(text) {
  const packageName = /^package +([\w.]+)/m.exec(text)?.[1]; if (!packageName) throw new Error('Missing selected declaration package');
  const declarations = [];
  // Inputs are individually immutable source pins; the exact inventories are sealed in the profile lock.
  for (const line of text.split('\n')) {
    const type = new RegExp('^' + MODIFIERS + '(?:fun +)?(class|interface|object|typealias) +([A-Za-z_][A-Za-z0-9_]*)').exec(line);
    const fn = new RegExp('^' + MODIFIERS + 'fun +(?:<[^>]+> +)?([^({]+)\\(').exec(line);
    const property = new RegExp('^' + MODIFIERS + '(val|var) +([\\w.]+)').exec(line);
    const kind = type?.[1] ?? (fn ? 'function' : property?.[1]);
    const name = type?.[2] ?? (fn ? /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(fn[1])?.[1] : property?.[2]?.split('.').at(-1));
    if (kind && !name) throw new Error('Unrecognized selected declaration header');
    if (kind) declarations.push({ packageName, name, kind });
  }
  return declarations;
}

export function declarationReferences(text, declaration) {
  if (!text.includes(declaration.name)) return [];
  const packageName = /^package +([\w.]+)/m.exec(text)?.[1]; const qualified = declaration.packageName + '.' + declaration.name;
  const matches = [];
  // Comments and strings are intentionally retained: interpolation, reflective name literals and KDoc matches
  // may conservatively retain extra files, but can never hide a reference to a removed declaration.
  if (packageName === declaration.packageName && new RegExp('\\b' + escaped(declaration.name) + '\\b').test(text)) matches.push('same-package identifier');
  if (new RegExp('\\b' + escaped(qualified) + '\\b').test(text)) matches.push('qualified identifier/import');
  const imports = [...text.matchAll(/^import +([\w.*]+)(?: +as +(\w+))?/gm)];
  for (const [, target, alias] of imports) {
    if (target === qualified || target.startsWith(qualified + '.')) matches.push('explicit imported declaration/member');
    if (target === declaration.packageName + '.*' && new RegExp('\\b' + escaped(declaration.name) + '\\b').test(text)) matches.push('package wildcard identifier');
    if (target === qualified && alias && new RegExp('\\b' + escaped(alias) + '\\b').test(text)) matches.push('import alias identifier');
  }
  return [...new Set(matches)];
}

export function chooseExclusions({ candidates, splits, retained }) {
  const excluded = new Set(candidates.keys()); const promoted = [];
  while (true) {
    const active = new Map([...retained, ...[...candidates].filter(([name]) => !excluded.has(name)), ...splits]);
    const next = [];
    for (const filename of excluded) {
      const source = candidates.get(filename); const incoming = [];
      for (const declaration of source.declarations) for (const [caller, value] of active) {
        const reasons = declarationReferences(value.text, declaration);
        if (reasons.length) incoming.push({ caller, declaration: declaration.name, packageName: declaration.packageName, reasons });
      }
      if (incoming.length) next.push({ filename, incoming });
    }
    if (!next.length) break;
    for (const { filename, incoming } of next) { excluded.delete(filename); promoted.push({ filename, incoming }); }
  }
  const active = new Map([...retained, ...[...candidates].filter(([name]) => !excluded.has(name)), ...splits]);
  const unclosed = [];
  for (const [filename, source] of splits) for (const declaration of source.removedDeclarations) for (const [caller, value] of active) {
    const reasons = declarationReferences(value.text, declaration); if (reasons.length) unclosed.push({ source: filename, caller, declaration: declaration.name, packageName: declaration.packageName, reasons });
  }
  return { excluded: [...excluded].sort(), promoted, unclosed, active };
}

/** Records coupling among the separately selected files; it does not infer type resolution. */
export function selectedFileGraph(sources) {
  const edges = [];
  for (const [target, source] of sources) for (const [caller, consumer] of sources) {
    if (target === caller) continue;
    const declarations = source.declarations.filter(declaration => declarationReferences(consumer.text, declaration).length);
    if (declarations.length) edges.push({ from: caller, to: target, declarations: [...new Set(declarations.map(value => value.name))].sort() });
  }
  const adjacency = new Map([...sources.keys()].map(filename => [filename, edges.filter(edge => edge.from === filename).map(edge => edge.to)]));
  const indices = new Map(), low = new Map(), stack = [], pending = new Set(), components = [];
  function visit(filename) {
    const index = indices.size; indices.set(filename, index); low.set(filename, index); stack.push(filename); pending.add(filename);
    for (const next of adjacency.get(filename)) {
      if (!indices.has(next)) { visit(next); low.set(filename, Math.min(low.get(filename), low.get(next))); }
      else if (pending.has(next)) low.set(filename, Math.min(low.get(filename), indices.get(next)));
    }
    if (low.get(filename) !== indices.get(filename)) return;
    const component = []; let item;
    do { item = stack.pop(); pending.delete(item); component.push(item); } while (item !== filename);
    components.push(component.sort());
  }
  for (const filename of sources.keys()) if (!indices.has(filename)) visit(filename);
  const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
  return { edges: edges.sort((a, b) => compare(a.from + '\0' + a.to, b.from + '\0' + b.to)), components: components.sort((a, b) => compare(a[0], b[0])) };
}

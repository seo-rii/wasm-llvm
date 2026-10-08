import { compare } from './source.mjs';

// A declaration reader, deliberately not a Kotlin DSL evaluator. Unhandled expressions stay
// unresolved; this inventory cannot establish selected Gradle variants or symbol reachability.
export function tokens(text) {
  const result = [];
  let position = 0;
  let line = 1;
  while (position < text.length) {
    const start = position;
    const startLine = line;
    const character = text[position];
    if (/\s/.test(character)) { if (character === '\n') line++; position++; continue; }
    if (text.startsWith('//', position)) {
      while (position < text.length && text[position] !== '\n') position++;
      continue;
    }
    if (text.startsWith('/*', position)) {
      position += 2;
      let depth = 1;
      while (depth && position < text.length) {
        if (text.startsWith('/*', position)) { depth++; position += 2; }
        else if (text.startsWith('*/', position)) { depth--; position += 2; }
        else { if (text[position] === '\n') line++; position++; }
      }
      if (depth) throw new Error('Unclosed Gradle comment');
      continue;
    }
    if (character === '"' || character === "'") {
      const triple = text.startsWith('"""', position);
      const delimiter = triple ? '"""' : character;
      position += delimiter.length;
      let value = '';
      while (position < text.length && !text.startsWith(delimiter, position)) {
        if (!triple && text[position] === '\\') {
          position++;
          const escaped = text[position++];
          value += ({ n: '\n', r: '\r', t: '\t' })[escaped] ?? escaped;
        } else {
          if (text[position] === '\n') line++;
          value += text[position++];
        }
      }
      if (position >= text.length) throw new Error('Unclosed Gradle string');
      position += delimiter.length;
      result.push({ value, kind: character === '"' ? 'string' : 'character', start, end: position, line: startLine });
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      while (position < text.length && /[A-Za-z_0-9]/.test(text[position])) position++;
      result.push({ value: text.slice(start, position), kind: 'name', start, end: position, line: startLine });
      continue;
    }
    result.push({ value: character, kind: 'punctuation', start, end: ++position, line: startLine });
  }
  return result;
}

function delimiters(items) {
  const pairs = new Map();
  const stack = [];
  for (let index = 0; index < items.length; index++) {
    const value = items[index].value;
    if (items[index].kind !== 'punctuation') continue;
    if (['(', '{', '['].includes(value)) stack.push(index);
    else if ([')', '}', ']'].includes(value)) {
      const start = stack.pop();
      if (start === undefined || ({ ')': '(', '}': '{', ']': '[' })[value] !== items[start].value) {
        throw new Error('Unbalanced Gradle delimiters');
      }
      pairs.set(start, index);
      pairs.set(index, start);
    }
  }
  if (stack.length) throw new Error('Unclosed Gradle delimiters');
  return pairs;
}

function callAt(items, pairs, index) {
  if (items[index]?.kind !== 'name' || items[index + 1]?.value !== '(') return null;
  const end = pairs.get(index + 1);
  return end === undefined ? null : { name: items[index].value, index, open: index + 1, end,
    args: items.slice(index + 2, end) };
}

function staticString(items) {
  return items.length === 1 && items[0].kind === 'string' && !items[0].value.includes('$') ? items[0].value : null;
}

function firstArgument(items) {
  let depth = 0;
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (item.kind !== 'punctuation') continue;
    if (['(', '[', '{'].includes(item.value)) depth++;
    else if ([')', ']', '}'].includes(item.value)) depth--;
    else if (item.value === ',' && depth === 0) return items.slice(0, index);
  }
  return items;
}

function argumentsOf(items) {
  const result = [];
  let remaining = items;
  while (remaining.length) {
    const argument = firstArgument(remaining);
    result.push(argument);
    remaining = remaining.slice(argument.length + 1);
  }
  return result;
}

export function projectDirectories(text) {
  const items = tokens(text);
  const pairs = delimiters(items);
  const projects = new Map();
  const overrides = new Set();
  const unresolved = [];
  for (let index = 0; index < items.length; index++) {
    const call = callAt(items, pairs, index);
    if (!call) continue;
    if (call.name === 'include') {
      for (const argument of argumentsOf(call.args)) {
        const id = staticString(argument);
        if (id && /^:[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)*$/.test(id)) {
          const parts = id.slice(1).split(':');
          for (let end = 1; end <= parts.length; end++) {
            const id = ':' + parts.slice(0, end).join(':');
            if (!projects.has(id)) projects.set(id, parts.slice(0, end).join('/'));
          }
        } else unresolved.push({ kind: 'dynamic-project-include', line: argument[0]?.line ?? items[index].line,
          expression: argument.length ? text.slice(argument[0].start, argument.at(-1).end) : '' });
      }
    }
    if (call.name !== 'project' || items[call.end + 1]?.value !== '.' ||
        items[call.end + 2]?.value !== 'projectDir' || items[call.end + 3]?.value !== '=') continue;
    const id = staticString(call.args);
    const fileCall = callAt(items, pairs, call.end + 4);
    let directory = fileCall && ['File', 'file'].includes(fileCall.name) && fileCall.args.length === 1 &&
      fileCall.args[0].kind === 'string' ? fileCall.args[0].value : null;
    if (directory?.startsWith('$rootDir/')) directory = directory.slice('$rootDir/'.length);
    if (directory?.startsWith('${rootDir}/')) directory = directory.slice('${rootDir}/'.length);
    if (!id || !directory || directory.includes('$') || directory.startsWith('/') || directory.includes('\\') ||
        directory.split('/').some((part) => !part || part === '.' || part === '..')) {
      unresolved.push({ kind: 'dynamic-project-directory', project: id, line: items[index].line });
      if (id) projects.delete(id);
    } else { projects.set(id, directory); overrides.add(id); }
  }
  for (const id of [...projects.keys()].sort((a, b) => a.split(':').length - b.split(':').length || compare(a, b))) {
    const end = id.lastIndexOf(':');
    const parent = id.slice(0, end);
    if (!overrides.has(id) && parent) {
      if (projects.has(parent)) projects.set(id, projects.get(parent) + '/' + id.slice(end + 1));
      else { projects.delete(id); unresolved.push({ kind: 'inherited-project-directory-unresolved', project: id }); }
    }
  }
  return { projects, unresolved };
}

function contextLabel(items, pairs, index) {
  const previous = items[index - 1];
  if (!previous) return { label: '', sourceSet: null };
  if (previous.value === ')' && previous.kind === 'punctuation') {
    const opening = pairs.get(index - 1);
    const name = items[opening - 1]?.value ?? '';
    const args = items.slice(opening + 1, index - 1);
    return { label: name, sourceSet: ['named', 'getByName'].includes(name) ? staticString(args) : null };
  }
  const label = previous.value;
  let sourceSet = previous.kind === 'string' || /(?:Main|Test)$/.test(label) || ['main', 'test'].includes(label) ? label : null;
  if (label === 'getting' || label === 'creating') {
    if (items[index - 2]?.value === 'by') sourceSet = items[index - 3]?.value ?? null;
  }
  if (label === 'dependencies' && items[index - 2]?.value === '.') sourceSet = items[index - 3]?.value ?? null;
  return { label, sourceSet };
}

const productionConfiguration = /^(api|implementation|compileOnly|runtimeOnly|compile|runtime|embedded|klib|intellijCore|intellijCoreApi|intellijCoreAnalysisApi|intellijCoreImplementation|jflex|generator|protobuf|wasmRuntimeOnly|wasmJsImplementation|wasmWasiImplementation)$/;
const testName = (value) => /test/i.test(value ?? '');

export function declarations(text) {
  const items = tokens(text);
  const pairs = delimiters(items);
  const projects = [];
  const ignoredTestProjects = [];
  const unresolved = [];
  const sourceSets = new Set();
  const variants = new Set();
  const plugins = new Set();
  const stack = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const call = callAt(items, pairs, index);
    if (call?.name === 'kotlin' || call?.name === 'id') {
      const id = staticString(call.args);
      if (id && stack.some((scope) => scope.label === 'plugins')) plugins.add(call.name === 'kotlin' ? 'kotlin:' + id : id);
    }
    if (call && ['jvm', 'wasmJs', 'wasmWasi', 'js'].includes(call.name)) variants.add(call.name);
    if (item.kind === 'punctuation' && item.value === '{') {
      const context = contextLabel(items, pairs, index);
      if (['jvm', 'wasmJs', 'wasmWasi', 'js'].includes(context.label)) variants.add(context.label);
      if (context.sourceSet && (stack.some((scope) => scope.label === 'sourceSets') || context.label === 'dependencies')) {
        sourceSets.add(context.sourceSet);
      }
      stack.push({ close: pairs.get(index), ...context });
    }
    if (item.kind === 'punctuation' && item.value === '(') {
      stack.push({ close: pairs.get(index), label: '', call: callAt(items, pairs, index - 1) });
    }
    if (item.kind === 'punctuation' && [')', '}'].includes(item.value)) {
      if (stack.at(-1)?.close !== index) throw new Error('Inconsistent declaration context');
      stack.pop();
    }
    if (!call) continue;
    const dependencyScope = stack.some((scope) => scope.label === 'dependencies');
    const calls = stack.filter((scope) => scope.call).map((scope) => scope.call);
    const parent = calls[0];
    const configuration = parent?.name === 'add' ? staticString(firstArgument(parent.args)) : parent?.name ?? null;
    const test = stack.some((scope) => testName(scope.sourceSet)) || testName(configuration);
    if (call.name === 'project') {
      let target = staticString(firstArgument(call.args));
      if (call.args[0]?.value === 'path' && call.args[1]?.value === '=') target = staticString(firstArgument(call.args.slice(2)));
      const evidence = { project: target, configuration, line: item.line,
        expression: text.slice(item.start, items[call.end].end), wrappers: calls.slice(1).map((wrapper) => wrapper.name),
        sourceSet: [...stack].reverse().find((scope) => scope.sourceSet)?.sourceSet ?? null };
      if (!dependencyScope && !productionConfiguration.test(configuration ?? '') && !testName(configuration)) {
        unresolved.push({ kind: 'project-reference-outside-dependency-declaration', ...evidence });
      } else if (test) ignoredTestProjects.push(evidence);
      else if (!target || !/^:[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)*$/.test(target)) {
        unresolved.push({ kind: 'dynamic-project-dependency', ...evidence });
      } else {
        projects.push(evidence);
        if (!productionConfiguration.test(configuration ?? '')) unresolved.push({ kind: 'unresolved-configuration', ...evidence });
      }
    }
    if (dependencyScope && !test && (productionConfiguration.test(call.name) || call.name === 'add') &&
        !parent) {
      const argument = call.name === 'add' ? call.args.slice(firstArgument(call.args).length + 1) : call.args;
      if (!argument.some((token) => token.kind === 'name' && token.value === 'project')) {
        unresolved.push({ kind: 'external-or-helper-dependency', configuration: call.name, line: item.line,
          expression: text.slice(item.start, items[call.end].end) });
      }
    }
    if (dependencyScope && !test && !parent && !testName(call.name) &&
        !productionConfiguration.test(call.name) && call.name !== 'add') {
      unresolved.push({ kind: 'unresolved-dependency-helper', line: item.line,
        expression: text.slice(item.start, items[call.end].end) });
    }
    if (!test && (call.name === 'projectDefault' || call.name === 'generatedDir' || /(?:[Gg]enerat|[Pp]rotobuf|[Jj]flex)/.test(call.name))) {
      unresolved.push({ kind: 'source-or-generator-helper', line: item.line, expression: text.slice(item.start, items[call.end].end) });
    }
  }
  // JVM plugin declarations do not imply an available Wasm artifact variant.
  if (plugins.has('kotlin:jvm')) variants.add('jvm');
  return { projects, ignoredTestProjects, unresolved, sourceSets: [...sourceSets].sort(compare),
    declaredTargets: [...variants].sort(compare), plugins: [...plugins].sort(compare) };
}

export function stronglyConnectedComponents(nodes) {
  const visited = new Map();
  const low = new Map();
  const stack = [];
  const pending = new Set();
  const components = [];
  let next = 0;
  const visit = (id) => {
    visited.set(id, next);
    low.set(id, next++);
    stack.push(id);
    pending.add(id);
    for (const target of [...new Set(nodes.get(id) ?? [])].sort(compare)) {
      if (!nodes.has(target)) continue;
      if (!visited.has(target)) { visit(target); low.set(id, Math.min(low.get(id), low.get(target))); }
      else if (pending.has(target)) low.set(id, Math.min(low.get(id), visited.get(target)));
    }
    if (low.get(id) === visited.get(id)) {
      const component = [];
      let target;
      do { target = stack.pop(); pending.delete(target); component.push(target); } while (target !== id);
      components.push(component.sort(compare));
    }
  };
  for (const id of [...nodes.keys()].sort(compare)) if (!visited.has(id)) visit(id);
  return components.sort((a, b) => compare(a[0], b[0]));
}

#!/usr/bin/env node
// Actual assembler/LLD/engine checks. These are not a C++ implementation proof.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { identity } from '../clang-browser/cross/package.mjs';
import { inspectAliasObject } from './symbol-alias-inspect.mjs';
import { inspectTargetFeatures } from './inspect-target-features.mjs';
import { watEhCases, ehLinkCases } from './wabt-eh-fixtures.mjs';

const [workArg, sdkArg, outputArg, baselineArg, ...options] = process.argv.slice(2);
assert(workArg && sdkArg && outputArg && baselineArg,
  'Usage: test-wabt-eh.mjs <work> <wasi-sdk> <output> <baseline-wat2wasm> [--native-only] [--reference=dir] [--playwright=file] [--chromium=file]');
const [work, sdk, output, baseline] = [workArg, sdkArg, outputArg, baselineArg].map(value => path.resolve(value));
const here = path.dirname(fileURLToPath(import.meta.url));
const option = name => options.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const nativeOnly = options.includes('--native-only');
const inputs = new Map();
const input = async file => { const bytes = await fs.readFile(file); inputs.set(path.resolve(file), identity(bytes)); return bytes; };
await fs.mkdir(output, { recursive: false });
const report = { kind: 'gcc-wasi-wabt-eh-qualification', status: 'running',
  scope: 'Assembler relocation transport and engine execution; no GCC C++ feature claim',
  startedAt: new Date().toISOString(), cases: [], malformed: [], programs: [], references: [] };
let browser;
const command = (entry, executable, argv, reject = false) => {
  const result = spawnSync(executable, argv, { encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  const evidence = { executable, argv, exitCode: result.status, signal: result.signal,
    stdout: result.stdout || '', stderr: result.stderr || '' };
  entry.commands ??= []; entry.commands.push(evidence);
  assert.ifError(result.error); assert.equal(result.signal, null);
  if (reject) assert.notEqual(result.status, 0, `${entry.id}: accepted invalid input`);
  else assert.equal(result.status, 0, `${entry.id}: ${evidence.stderr}`);
  return evidence;
};
const leb = value => { const bytes = []; do { const next = value & 127; value = Math.floor(value / 128); bytes.push(next | (value ? 128 : 0)); } while (value); return Buffer.from(bytes); };
const reader = (bytes, pos = 0, end = bytes.length) => ({
  pos, end,
  byte() { assert(this.pos < this.end); return bytes[this.pos++]; },
  u32() { let value = 0; for (let shift = 0; shift <= 28; shift += 7) { const b = this.byte(); value += (b & 127) * 2 ** shift; if (!(b & 128)) return value; } assert.fail('Invalid fixture u32'); },
  name() { const size = this.u32(); assert(this.pos + size <= this.end); const value = bytes.subarray(this.pos, this.pos + size).toString(); this.pos += size; return value; },
});
// Decode only the fixture metadata being mutated; all resulting files go back
// through the real WABT reader, not a duplicate acceptance implementation.
function objectLayout(bytes) {
  const sections = [], r = reader(bytes, 8);
  while (r.pos < r.end) {
    const start = r.pos, id = r.byte(), size = r.u32(), payload = r.pos, end = payload + size;
    assert(end <= bytes.length); const s = reader(bytes, payload, end), name = id === 0 ? s.name() : null;
    sections.push({ start, id, payload, end, name, content: s.pos }); r.pos = end;
  }
  const section = sections.find(value => value.name?.toLowerCase() === 'reloc.code'); assert(section);
  const q = reader(bytes, section.content, section.end), targetIndex = q.u32(), entries = [];
  for (let count = q.u32(); count; --count) {
    const type = q.u32(), offset = q.u32(), index = q.u32();
    assert([0, 6, 10].includes(type), 'Fixture unexpectedly needs an addend');
    entries.push({ type, offset, index });
  }
  assert.equal(q.pos, q.end);
  return { section, target: sections[targetIndex], targetIndex, entries };
}
function mutateRelocs(bytes, mutate) {
  const layout = objectLayout(bytes), entries = structuredClone(layout.entries); mutate(entries, layout);
  const name = Buffer.from(layout.section.name);
  const payload = Buffer.concat([leb(name.length), name, leb(layout.targetIndex), leb(entries.length),
    ...entries.flatMap(({ type, offset, index }) => [leb(type), leb(offset), leb(index)])]);
  return Buffer.concat([bytes.subarray(0, layout.section.start), Buffer.from([0]), leb(payload.length), payload,
    bytes.subarray(layout.section.end)]);
}
const tagSemantics = bytes => inspectAliasObject(bytes).relocations.filter(reloc => reloc.type === 10).map(reloc => reloc.symbol);

try {
  const lock = JSON.parse(await input(path.join(here, 'sources.lock.json')));
  const expectedSource = { wabtCommit: lock.wabt.commit, patches: lock.wabt.patches,
    sourceDiffSha256: lock.wabt.sourceDiffSha256, submodules: lock.wabt.submodules };
  report.assemblerSource = expectedSource;
  for (const host of nativeOnly ? ['native'] : ['native', 'browser']) {
    const receipt = JSON.parse(await input(path.join(work, `wabt-${host}/provenance.json`)));
    assert(receipt.inputsUnchanged); assert.deepEqual(receipt.source, expectedSource);
    for (const [name, expected] of Object.entries(receipt.files))
      assert.deepEqual(identity(await input(path.join(work, `wabt-${host}`, name))), expected);
  }
  for (const file of [baseline, process.execPath, path.join(sdk, 'bin/wasm-ld'), fileURLToPath(import.meta.url),
    ...['wabt-eh-fixtures.mjs', 'symbol-alias-inspect.mjs', 'inspect-target-features.mjs'].map(name => path.join(here, name))]) await input(file);
  const tools = Object.fromEntries(['wat2wasm', 'wasm2wat', 'wasm-validate'].map(name => [name, path.join(work, 'wabt-native', name)]));
  let createModule, wasmBinary;
  if (!nativeOnly) {
    createModule = (await import(pathToFileURL(path.join(work, 'wabt-browser/as.mjs')).href)).default;
    wasmBinary = await input(path.join(work, 'wabt-browser/as.wasm'));
  }
  for (const fixture of watEhCases) {
    const entry = { id: fixture.id, status: 'running', commands: [], fixture: identity(Buffer.from(fixture.wat)) };
    report.cases.push(entry);
    const directory = path.join(output, fixture.id); await fs.mkdir(directory);
    const wat = path.join(directory, 'input.wat'), object = path.join(directory, 'native.o');
    await fs.writeFile(wat, fixture.wat);
    const result = command(entry, tools.wat2wasm, ['--enable-exceptions', '-r', '--enable-annotations', wat, '-o', object], !!fixture.reject);
    if (fixture.reject) assert.match(result.stderr, fixture.reject);
    if (!nativeOnly) {
      const diagnostics = [], assembler = await createModule({ wasmBinary, noInitialRun: true,
        print: message => diagnostics.push(String(message)), printErr: message => diagnostics.push(String(message)) });
      assembler.FS.writeFile('/input.wat', fixture.wat);
      let status;
      try { status = assembler.callMain(['--enable-exceptions', '-r', '--enable-annotations', '/input.wat', '-o', '/output.o']) ?? 0; }
      catch (error) { if (typeof error?.status !== 'number') throw error; status = error.status; }
      entry.wasmHost = { engine: process.version, status, diagnostics };
      assert.equal(status, fixture.reject ? 1 : 0);
      if (fixture.reject) assert.match(diagnostics.join('\n'), fixture.reject);
      else {
        const bytes = Buffer.from(assembler.FS.readFile('/output.o'));
        assert.deepEqual(bytes, await fs.readFile(object), 'Native/Wasm-host bytes differ');
        await fs.writeFile(path.join(directory, 'wasm-host.o'), bytes);
      }
    }
    if (!fixture.reject) {
      const bytes = await fs.readFile(object);
      assert.deepEqual(tagSemantics(bytes), fixture.tags);
      assert.deepEqual(inspectTargetFeatures(bytes).features, fixture.features);
      command(entry, tools['wasm-validate'], ['--enable-exceptions', object]);
      const wat2 = path.join(directory, 'roundtrip.wat'), obj2 = path.join(directory, 'roundtrip.o');
      command(entry, tools.wasm2wat, ['--enable-exceptions', '-r', '--enable-annotations', object, '-o', wat2]);
      command(entry, tools.wat2wasm, ['--enable-exceptions', '-r', '--enable-annotations', wat2, '-o', obj2]);
      assert.deepEqual(tagSemantics(await fs.readFile(obj2)), fixture.tags);
      assert.deepEqual(inspectTargetFeatures(await fs.readFile(obj2)).features, fixture.features);
      entry.object = { path: object, ...identity(bytes), tagRelocations: fixture.tags };
      entry.roundtrip = { path: obj2, ...identity(await fs.readFile(obj2)) };
      if (fixture.baselineIdentical) {
        const old = path.join(directory, 'baseline.o');
        command(entry, baseline, ['--enable-exceptions', '-r', '--enable-annotations', wat, '-o', old]);
        assert.deepEqual(await fs.readFile(old), bytes); entry.baselineIdentical = true;
      }
    }
    entry.status = 'passed';
  }

  // The tag is thrown by a different object with a different local tag order.
  // A throw and its handler in one object could both be misbound yet appear
  // to work; this retained old-assembler control demonstrates the real error.
  const baselineDirectory = path.join(output, 'baseline-cross-object'); await fs.mkdir(baselineDirectory);
  const baselineEntry = report.baselineTagReordering = { id: 'baseline-cross-object', commands: [] };
  for (const id of ['cross-tag-provider', 'modern-cross-catch'])
    command(baselineEntry, baseline, ['--enable-exceptions', '-r', '--enable-annotations',
      path.join(output, id, 'input.wat'), '-o', path.join(baselineDirectory, `${id}.o`)]);
  const baselineProgram = path.join(baselineDirectory, 'main.wasm');
  command(baselineEntry, path.join(sdk, 'bin/wasm-ld'), ['--no-entry', '--export=cross_run',
    ...['cross-tag-provider', 'modern-cross-catch'].map(id => path.join(baselineDirectory, `${id}.o`)), '-o', baselineProgram]);
  baselineEntry.expectedValues = [89, 1097];
  try {
    const baselineExports = new WebAssembly.Instance(new WebAssembly.Module(await fs.readFile(baselineProgram))).exports;
    baselineEntry.actualValues = [baselineExports.cross_run(1), baselineExports.cross_run(0)];
  } catch (error) {
    // Missing tag relocations also let LLD garbage-collect live tags.
    assert(error instanceof WebAssembly.CompileError); assert.match(error.message, /tag index/i);
    baselineEntry.invalidLinkedTag = String(error);
  }
  if (!baselineEntry.invalidLinkedTag)
    assert.notDeepEqual(baselineEntry.actualValues, baselineEntry.expectedValues, 'Baseline unexpectedly preserves cross-object tags');
  baselineEntry.status = 'reproduced-baseline-defect';

  // A relocatable operand may contain a valid placeholder. Its symbol,
  // rather than the raw local tag index, determines the relocated reference.
  const placeholder = await fs.readFile(path.join(output, 'modern-cross-catch/native.o'));
  const placeholderLayout = objectLayout(placeholder);
  for (const reloc of placeholderLayout.entries.filter(value => value.type === 10)) {
    const at = placeholderLayout.target.payload + reloc.offset;
    placeholder.set([0x80, 0x80, 0x80, 0x80, 0], at);
  }
  const placeholderFile = path.join(output, 'tag-symbol-placeholder.o'); await fs.writeFile(placeholderFile, placeholder);
  const placeholderEntry = report.symbolPlaceholder = { id: 'tag-symbol-placeholder', commands: [] };
  const placeholderWat = path.join(output, 'tag-symbol-placeholder.wat'), placeholderObject = path.join(output, 'tag-symbol-placeholder-roundtrip.o');
  command(placeholderEntry, tools.wasm2wat, ['--enable-exceptions', '-r', '--enable-annotations', placeholderFile, '-o', placeholderWat]);
  command(placeholderEntry, tools.wat2wasm, ['--enable-exceptions', '-r', '--enable-annotations', placeholderWat, '-o', placeholderObject]);
  assert.deepEqual(tagSemantics(await fs.readFile(placeholderObject)), ['red', 'blue']);
  const placeholderProgram = path.join(output, 'tag-symbol-placeholder.wasm');
  command(placeholderEntry, path.join(sdk, 'bin/wasm-ld'), ['--no-entry', '--export=cross_run',
    path.join(output, 'cross-tag-provider/native.o'), placeholderObject, '-o', placeholderProgram]);
  const placeholderExports = new WebAssembly.Instance(new WebAssembly.Module(await fs.readFile(placeholderProgram))).exports;
  placeholderEntry.values = [placeholderExports.cross_run(1), placeholderExports.cross_run(0)];
  assert.deepEqual(placeholderEntry.values, [89, 1097]); placeholderEntry.status = 'passed';

  const original = await fs.readFile(path.join(output, 'modern-catch/native.o'));
  const functionIndex = inspectAliasObject(original).symbols.find(symbol => symbol.kind === 'function').symbolIndex;
  const mutations = [
    ['wrong-symbol-kind', entries => { entries.find(e => e.type === 10).index = functionIndex; }],
    ['invalid-symbol-index', entries => { entries.find(e => e.type === 10).index = 10000; }],
    ['duplicate-tag-reloc', entries => { entries.push({ ...entries.find(e => e.type === 10) }); }],
    ['tag-offset-inside', entries => { entries.find(e => e.type === 10).offset++; }],
    ['tag-offset-depth', entries => { entries.find(e => e.type === 10).offset += 5; }],
    ['tag-wrong-type', entries => { entries.find(e => e.type === 10).type = 0; }],
    ['overlap-from-before', entries => { const e = entries.find(e => e.type === 10); e.type = 0; e.offset--; }],
    ['overlap-from-inside', entries => { const e = entries.find(e => e.type === 10); e.type = 0; e.offset++; }],
  ];
  const malformed = mutations.map(([id, mutate]) => ({ id, bytes: mutateRelocs(original, mutate) }));
  const short = Buffer.from(original), layout = objectLayout(short);
  const throwReloc = layout.entries.find(e => e.type === 10 && short[layout.target.payload + e.offset - 1] === 0x08); assert(throwReloc);
  const offset = layout.target.payload + throwReloc.offset;
  short[offset] &= 127; short.fill(1, offset + 1, offset + 5);
  malformed.push({ id: 'unpadded-tag-operand', bytes: short });
  for (const { id, bytes } of malformed) {
    const entry = { id, commands: [] }; report.malformed.push(entry);
    const file = path.join(output, `${id}.o`); await fs.writeFile(file, bytes);
    const result = command(entry, tools.wasm2wat, ['--enable-exceptions', '-r', '--enable-annotations', file, '-o', path.join(output, `${id}.wat`)], true);
    assert.match(result.stderr, /exception tag relocation/); entry.status = 'passed';
  }

  if (option('playwright') || option('chromium')) {
    assert(option('playwright') && option('chromium'));
    await input(option('playwright')); await input(option('chromium'));
    const { chromium } = await import(pathToFileURL(path.resolve(option('playwright'))).href);
    browser = await chromium.launch({ executablePath: path.resolve(option('chromium')), headless: true, args: ['--no-sandbox'] });
    report.browser = await browser.version();
  }
  for (const host of nativeOnly ? ['native', 'roundtrip'] : ['native', 'wasm-host', 'roundtrip']) {
    for (const fixture of ehLinkCases) {
      const entry = { id: `${host}-${fixture.id}`, commands: [] }; report.programs.push(entry);
      const program = path.join(output, `${entry.id}.wasm`);
      command(entry, path.join(sdk, 'bin/wasm-ld'), ['--fatal-warnings', '--no-entry',
        ...[...new Set(fixture.calls.map(call => call[0]))].map(name => `--export=${name}`),
        ...fixture.objects.map(id => path.join(output, id, `${host}.o`)), '-o', program]);
      const bytes = await fs.readFile(program);
      const execute = `import fs from 'node:fs'; import assert from 'node:assert/strict';
        const m=new WebAssembly.Module(fs.readFileSync(process.argv[1])); assert.deepEqual(WebAssembly.Module.imports(m),[]);
        const e=new WebAssembly.Instance(m).exports, calls=JSON.parse(process.argv[2]);
        const values=calls.map(([name,args,expected])=>{const actual=e[name](...args);assert.equal(actual,expected);return actual;});
        console.log(JSON.stringify({engine:process.version,values}));`;
      entry.execution = JSON.parse(command(entry, process.execPath,
        [...(fixture.modern ? ['--no-experimental-wasm-legacy-eh'] : []), '--input-type=module', '-e', execute, program, JSON.stringify(fixture.calls)]).stdout);
      entry.program = { path: program, ...identity(bytes) };
      if (browser) {
        const page = await browser.newPage();
        entry.worker = await page.evaluate(async ({ bytes, calls }) => {
          const source = `onmessage=({data})=>{try{const m=new WebAssembly.Module(new Uint8Array(data.bytes));
            const imports=WebAssembly.Module.imports(m),e=new WebAssembly.Instance(m).exports;
            postMessage({ok:true,imports,values:data.calls.map(([name,args])=>e[name](...args))});
            }catch(error){postMessage({ok:false,error:String(error)})}};`;
          const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
          const worker = new Worker(url);
          try { return await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Worker timeout')), 30000);
            worker.onmessage = event => { clearTimeout(timer); resolve(event.data); }; worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
            worker.postMessage({ bytes, calls }); }); }
          finally { worker.terminate(); URL.revokeObjectURL(url); }
        }, { bytes: [...bytes], calls: fixture.calls });
        await page.close();
        if (fixture.modern) { assert(entry.worker.ok, entry.worker.error); assert.deepEqual(entry.worker.imports, []); assert.deepEqual(entry.worker.values, fixture.calls.map(call => call[2])); }
        else if (entry.worker.ok) assert.deepEqual(entry.worker.values, fixture.calls.map(call => call[2]));
        else assert.match(entry.worker.error, /CompileError|legacy/);
      }
      entry.status = 'passed';
    }
  }

  if (option('reference')) {
    const reference = path.resolve(option('reference'));
    for (const [directory, name] of [['int-cleanup-o0', 'unit0.o'], ['modern-multitu-o2', 'unit0.o'], ['modern-multitu-o2', 'unit1.o']]) {
      const entry = { id: `${directory}-${name}`, commands: [], scope: 'Clang object transport only' }; report.references.push(entry);
      const source = path.join(reference, directory, name), bytes = await input(source);
      const wat = path.join(output, `${entry.id}.wat`), object = path.join(output, `${entry.id}.o`);
      command(entry, tools.wasm2wat, ['--enable-all', '-r', '--enable-annotations', source, '-o', wat]);
      command(entry, tools.wat2wasm, ['--enable-all', '-r', '--enable-annotations', wat, '-o', object]);
      assert.deepEqual(tagSemantics(await fs.readFile(object)), tagSemantics(bytes));
      entry.original = { path: source, ...identity(bytes) }; entry.roundtrip = { path: object, ...identity(await fs.readFile(object)) };
      entry.status = 'passed';
    }
    const originalReport = JSON.parse(await input(path.join(reference, 'modern-multitu-o2/report.json')));
    const originalResult = JSON.parse(await input(path.join(reference, 'modern-multitu-o2/result.json')));
    const linker = originalReport.commands.find(value => path.basename(value.argv[0]) === 'wasm-ld'); assert(linker);
    assert.equal(linker.argv[0], path.join(sdk, 'bin/wasm-ld'));
    const entry = { id: 'modern-clang-roundtrip-execution', scope: 'Clang object transport and execution only', commands: [] };
    report.references.push(entry);
    const directory = path.join(output, 'modern-clang-roundtrip'); await fs.mkdir(directory);
    const program = path.join(directory, 'main.wasm');
    const replacements = new Map([
      ...['unit0.o', 'unit1.o'].map(name => [path.join(reference, 'modern-multitu-o2', name), path.join(output, `modern-multitu-o2-${name}.o`)]),
      [path.join(reference, 'modern-multitu-o2/main.wasm'), program],
    ]);
    for (const file of linker.argv.slice(1).filter(value => path.isAbsolute(value) && !replacements.has(value))) await input(file);
    command(entry, linker.argv[0], linker.argv.slice(1).map(value => replacements.get(value) || value));
    const runner = path.join(reference, 'run-node.mjs'); await input(runner);
    await fs.writeFile(path.join(directory, 'stdin.txt'), '');
    command(entry, process.execPath, ['--no-experimental-wasm-legacy-eh', '--no-warnings', runner, program, directory]);
    const result = JSON.parse(await fs.readFile(path.join(directory, 'result.json'), 'utf8'));
    for (const key of ['exitCode', 'stdout', 'stderr', 'cppExceptionTagExport']) assert.deepEqual(result[key], originalResult[key], key);
    entry.program = { path: program, ...identity(await fs.readFile(program)) };
    entry.execution = result; entry.status = 'passed';
  }
  for (const [file, expected] of inputs) assert.deepEqual(identity(await fs.readFile(file)), expected, `Input changed: ${file}`);
  report.inputsUnchanged = true; report.status = 'passed'; process.exitCode = 0;
} catch (error) {
  report.status = 'failed'; report.error = error.stack; process.exitCode = 1;
} finally {
  await browser?.close(); report.inputs = Object.fromEntries(inputs);
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(output, 'qualification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, cases: report.cases.length, malformed: report.malformed.length,
    programs: report.programs.length, references: report.references.length, inputsUnchanged: report.inputsUnchanged,
    report: path.join(output, 'qualification.json'), error: report.error?.split('\n').slice(0, 3) }));
}

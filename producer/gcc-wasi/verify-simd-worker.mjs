#!/usr/bin/env node
// Verify actual Chromium GCC SIMD captures; this script does not compile code.
// First run wasm-idle/scripts/verify-gcc-wasi.mjs with --manifest, --suite pointing
// to this directory's simd-fixtures.mjs, and --save-intermediates (all 25 cases).
// Usage: node producer/gcc-wasi/verify-simd-worker.mjs \
//   --qualification /path/to/qualification.json \
//   --objdump /path/to/native/wasm-objdump --output /path/to/NEW.json
// The qualification, sibling manifest.json, and each .wat/.o/.wasm must remain
// together. Existing output files are never overwritten. A failed check writes
// a failed receipt and exits nonzero; it is not compiler qualification evidence.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const recipePath = fileURLToPath(import.meta.url);
const fixturePath = fileURLToPath(new URL('./simd-fixtures.mjs', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const identify = bytes => ({ bytes: bytes.length, sha256: sha256(bytes) });
const simdMnemonic = /^(?:v128|i8x16|i16x8|i32x4|i64x2|f32x4|f64x2)\.[a-z0-9_]+$/;
const options = {};
for (let index = 2; index < process.argv.length; index++) {
  const key = process.argv[index];
  if (key === '--help') {
    console.log('Usage: node producer/gcc-wasi/verify-simd-worker.mjs --qualification QUALIFICATION.json --objdump NATIVE_WASM_OBJDUMP --output NEW.json\nRequires the complete 25-case Chromium GCC SIMD suite captured with --save-intermediates.');
    process.exit(0);
  }
  assert(['--qualification', '--objdump', '--output'].includes(key), `Unknown argument ${key}`);
  assert(!Object.hasOwn(options, key.slice(2)), `Duplicate argument ${key}`);
  const value = process.argv[++index];
  assert(value && !value.startsWith('--'), `Missing value for ${key}`);
  options[key.slice(2)] = value;
}
for (const name of ['qualification', 'objdump', 'output']) assert(options[name], `Required --${name}`);
const output = path.resolve(options.output);
await fs.mkdir(path.dirname(output), { recursive: true });
const outputFile = await fs.open(output, 'wx', 0o600);
const report = {
  schemaVersion: 1,
  kind: 'gcc-wasi-chromium-simd-opcode-verification',
  startedAt: new Date().toISOString(),
  host: { platform: process.platform, architecture: process.arch, node: process.versions.node },
  success: false,
  cases: []
};
const inputs = new Map();

async function readInput(file) {
  const canonical = await fs.realpath(file);
  const bytes = await fs.readFile(canonical);
  const receipt = { path: canonical, ...identify(bytes) };
  if (inputs.has(canonical)) assert.deepEqual(receipt, inputs.get(canonical), `${canonical}: input changed`);
  inputs.set(canonical, receipt);
  return { bytes, receipt };
}

function checkIdentity(bytes, receipt, label) {
  assert(receipt && Number.isSafeInteger(receipt.bytes) && receipt.bytes > 0, `${label}: missing byte count`);
  assert.match(receipt.sha256 || '', /^[a-f0-9]{64}$/, `${label}: missing SHA-256`);
  assert.equal(bytes.length, receipt.bytes, `${label}: byte count mismatch`);
  assert.equal(sha256(bytes), receipt.sha256, `${label}: SHA-256 mismatch`);
}

function run(command, argv) {
  const result = spawnSync(command, argv, {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C' }
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${path.basename(command)} ${argv.join(' ')}: ${result.stderr || result.signal}`);
  return {
    command, argv, exitCode: result.status,
    stdout: result.stdout || '', stderr: result.stderr || ''
  };
}

// Ignore strings and nested comments before looking at instruction tokens.
// This also accepts unfolded WAT, without treating labels as instructions.
function watInstructions(text) {
  const tokens = [];
  let cursor = 0, depth = 0;
  while (cursor < text.length) {
    if (/\s/.test(text[cursor])) { cursor++; continue; }
    if (text.startsWith(';;', cursor)) {
      const end = text.indexOf('\n', cursor + 2);
      cursor = end === -1 ? text.length : end + 1;
      continue;
    }
    if (text.startsWith('(;', cursor)) {
      let comments = 1;
      cursor += 2;
      while (cursor < text.length && comments) {
        if (text.startsWith('(;', cursor)) { comments++; cursor += 2; }
        else if (text.startsWith(';)', cursor)) { comments--; cursor += 2; }
        else cursor++;
      }
      assert.equal(comments, 0, 'Unterminated WAT block comment');
      continue;
    }
    if (text[cursor] === '"') {
      cursor++;
      let closed = false;
      while (cursor < text.length) {
        if (text[cursor] === '\\') cursor += 2;
        else if (text[cursor++] === '"') { closed = true; break; }
      }
      assert(closed, 'Unterminated WAT string');
      continue;
    }
    if (text[cursor] === '(') { depth++; cursor++; continue; }
    if (text[cursor] === ')') {
      assert(depth-- > 0, 'Unbalanced WAT closing parenthesis');
      cursor++;
      continue;
    }
    const start = cursor;
    while (cursor < text.length && !/[\s()"]/.test(text[cursor]) && !text.startsWith(';;', cursor)) cursor++;
    tokens.push(text.slice(start, cursor));
  }
  assert.equal(depth, 0, 'Unbalanced WAT opening parenthesis');
  assert.equal(tokens[0], 'module', 'Expected GCC WebAssembly text module');
  return { simd: tokens.filter(token => simdMnemonic.test(token)), v128Types: tokens.filter(token => token === 'v128').length };
}

function objectInstructions(text) {
  assert.match(text, /file format wasm 0x1/, 'Objdump did not identify a WebAssembly v1 object');
  assert.match(text, /Code Disassembly:/, 'Objdump omitted the code section');
  const instructions = [];
  for (const line of text.split('\n')) {
    const match = /^\s*([a-f0-9]+):\s+((?:[a-f0-9]{2}\s+)+)\|\s*(\S+)/i.exec(line);
    if (!match) continue;
    const encoding = match[2].trim().split(/\s+/).map(byte => byte.toLowerCase());
    const mnemonic = match[3];
    // Local declaration counts are LEB128 data and can also start with 0xfd.
    if (mnemonic.startsWith('local[')) continue;
    if (encoding[0] === 'fd' || simdMnemonic.test(mnemonic)) {
      assert.equal(encoding[0], 'fd', `${mnemonic}: missing SIMD opcode prefix`);
      assert(simdMnemonic.test(mnemonic), `Unrecognized SIMD opcode ${mnemonic}`);
      instructions.push({ offset: match[1], encoding: encoding.join(' '), mnemonic });
    }
  }
  return instructions;
}

function counts(names) {
  const result = {};
  for (const name of names) result[name] = (result[name] || 0) + 1;
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

function checkCompilation(compilation, fixture, emit) {
  const label = `${fixture.id}: ${emit}`;
  assert.equal(compilation?.exitCode, 0, `${label}: compilation failed`);
  assert(Array.isArray(compilation.stages), `${label}: missing stages`);
  const expected = emit === 'assembly' ? ['cc1'] : emit === 'object' ? ['cc1', 'as'] : ['cc1', 'as', 'ld'];
  assert.deepEqual(compilation.stages.map(stage => stage.tool), expected, `${label}: unexpected compiler stages`);
  for (const stage of compilation.stages) {
    assert.equal(stage.exitCode, 0, `${label}: ${stage.tool} failed`);
    assert(Array.isArray(stage.argv) && stage.argv.every(arg => typeof arg === 'string'), `${label}: invalid argv`);
  }
  const argv = compilation.stages[0].argv;
  const flag = fixture.request.simd ? '-msimd128' : '-mno-simd128';
  assert.deepEqual(argv.filter(arg => /^-O/.test(arg)), [`-O${fixture.request.optimization}`], `${label}: optimization mismatch`);
  assert.deepEqual(argv.filter(arg => /^-m(?:no-)?simd128$/.test(arg)), [flag], `${label}: SIMD option mismatch`);
  assert(argv.includes(`-std=${fixture.request.standard}`), `${label}: language standard mismatch`);
}

try {
  report.recipe = (await readInput(recipePath)).receipt;
  const suiteInput = await readInput(fixturePath);
  report.suite = suiteInput.receipt;
  const { cases, disabledCases } = await import('./simd-fixtures.mjs');
  const fixtures = [...cases, ...disabledCases];
  assert.equal(cases.length, 19, 'Expected 19 enabled SIMD fixtures');
  assert.equal(disabledCases.length, 6, 'Expected six disabled SIMD fixtures');
  assert(cases.every(fixture => fixture.request.simd === true));
  assert(disabledCases.every(fixture => fixture.request.simd === false));
  const ids = fixtures.map(fixture => fixture.id);
  assert.equal(new Set(ids).size, 25, 'Expected exactly 25 unique fixtures');
  assert(ids.every(id => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)), 'Unsafe fixture id');
  const qualificationInput = await readInput(options.qualification);
  report.qualification = qualificationInput.receipt;
  const qualification = JSON.parse(qualificationInput.bytes);
  const directory = path.dirname(report.qualification.path);
  async function captured(name, expected) {
    const input = await readInput(path.join(directory, name));
    assert.equal(path.dirname(input.receipt.path), directory, `${name}: capture escapes qualification directory`);
    checkIdentity(input.bytes, expected, name);
    return input;
  }
  assert.equal(qualification.schemaVersion, 1, 'Unsupported qualification schema');
  assert.equal(qualification.kind, 'gcc-wasi-real-chromium-compiler-qualification', 'Requires real Chromium GCC compilation');
  assert.equal(qualification.success, true, 'Qualification did not pass');
  assert.equal(qualification.target, 'wasm32-wasi');
  assert.equal(qualification.compilerHost, 'wasm32-emscripten');
  assert.deepEqual(qualification.execution, ['node-wasi-preview1', 'chromium-worker-wasi-preview1']);
  assert.equal(typeof qualification.browser, 'string', 'Missing Chromium version');
  assert(qualification.browser.length > 0, 'Missing Chromium version');
  assert.deepEqual(qualification.selectedCases, ids, 'Qualification must select all 25 SIMD fixtures in suite order');
  assert.deepEqual(qualification.unselectedCases, [], 'Qualification omitted fixtures');
  assert.deepEqual(qualification.cases?.map(entry => entry.id), ids, 'Qualification case set mismatch');
  assert.deepEqual(qualification.fixtures?.map(entry => entry.id), ids, 'Qualification fixture set mismatch');
  checkIdentity(suiteInput.bytes, qualification.suite, 'SIMD suite');
  const manifestInput = await readInput(path.join(directory, 'manifest.json'));
  report.manifest = manifestInput.receipt;
  assert.equal(report.manifest.sha256, qualification.manifestSha256, 'Manifest digest mismatch');
  const manifest = JSON.parse(manifestInput.bytes);
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.kind, 'gcc-wasm32-wasi');
  assert.equal(manifest.host, 'wasm32-emscripten');
  assert.equal(manifest.target, 'wasm32-wasi');
  assert.equal(manifest.compiler?.family, 'gcc');
  assert.match(manifest.compiler.commit || '', /^[a-f0-9]{40}$/, 'Missing GCC source commit');
  assert.equal(manifest.capabilities?.simd, true, 'Manifest does not advertise SIMD');
  assert.deepEqual(qualification.compiler, manifest.compiler, 'GCC identity mismatch');
  assert.deepEqual(qualification.toolchain, Object.fromEntries(['compiler', 'assembler', 'linker', 'sysroot', 'abi', 'capabilities'].map(key => [key, manifest[key]])), 'Toolchain receipt mismatch');
  assert.deepEqual(qualification.provenance, manifest.provenance, 'Build provenance mismatch');
  const identity = qualification.identity;
  assert.equal(identity?.compiler, 'gcc');
  assert.equal(identity.compilerHost, manifest.host);
  assert.equal(identity.target, manifest.target);
  assert.equal(identity.compilerVersion, manifest.compiler.version);
  assert.equal(identity.compilerCommit, manifest.compiler.commit);
  assert.equal(identity.manifestSha256, report.manifest.sha256);
  assert.equal(identity.sysrootSha256, manifest.assets.sysroot.sha256);
  report.compiler = identity;
  report.browser = qualification.browser;
  const toolInput = await readInput(options.objdump);
  // A native executable is required; a Wasm-host tool cannot serve as this oracle.
  assert.notDeepEqual([...toolInput.bytes.subarray(0, 4)], [0, 97, 115, 109], 'Objdump must run on the native host');
  const version = run(toolInput.receipt.path, ['--version']);
  assert(version.stdout.trim(), 'Objdump did not report its version');
  report.objdump = { ...toolInput.receipt, version: version.stdout.trim(), versionResult: version };
  for (const [index, fixture] of fixtures.entries()) {
    const entry = qualification.cases[index];
    const fixtureSha256 = sha256(JSON.stringify(fixture));
    assert.equal(qualification.fixtures[index].sha256, fixtureSha256, `${fixture.id}: source/options/IO digest mismatch`);
    const result = { id: fixture.id, simd: fixture.request.simd, fixtureSha256, source: identify(Buffer.from(fixture.request.code)), success: false };
    report.cases.push(result);
    assert.equal(entry.success, true, `${fixture.id}: qualification failed`);
    assert.equal(entry.status, 'passed', `${fixture.id}: qualification incomplete`);
    checkCompilation(entry.compilation, fixture, 'executable');
    for (const host of ['chromiumWorker', 'node']) {
      assert.equal(entry[host]?.exitCode, 0, `${fixture.id}: ${host} failed`);
      assert.equal(entry[host].stdout, fixture.stdout, `${fixture.id}: ${host} stdout mismatch`);
      assert.equal(entry[host].stderr, '', `${fixture.id}: ${host} stderr mismatch`);
    }
    assert.equal(entry.sdkInspection?.features?.simd128, fixture.request.simd, `${fixture.id}: SDK SIMD inspection mismatch`);
    assert.deepEqual(entry.intermediates?.map(capture => capture.emit), ['assembly', 'object'], `${fixture.id}: requires --save-intermediates`);
    for (const capture of entry.intermediates) {
      assert.equal(capture.translationUnit, 'main', `${fixture.id}: unexpected translation unit`);
      checkCompilation(capture.compilation, fixture, capture.emit);
    }
    const assembly = await captured(`${fixture.id}.wat`, entry.intermediates[0]);
    const object = await captured(`${fixture.id}.o`, entry.intermediates[1]);
    const executable = await captured(`${fixture.id}.wasm`, entry.artifact);
    const module = new WebAssembly.Module(object.bytes);
    assert.equal(WebAssembly.Module.customSections(module, 'linking').length, 1, `${fixture.id}: missing relocatable object metadata`);
    const wat = watInstructions(new TextDecoder('utf-8', { fatal: true }).decode(assembly.bytes));
    const dumped = run(report.objdump.path, ['-d', object.receipt.path]);
    const encoded = objectInstructions(dumped.stdout);
    const watCounts = counts(wat.simd), objectCounts = counts(encoded.map(instruction => instruction.mnemonic));
    for (const instruction of fixture.requiredInstructions) {
      assert(simdMnemonic.test(instruction), `${fixture.id}: invalid required instruction ${instruction}`);
      assert(watCounts[instruction] > 0, `${fixture.id}: GCC WAT omitted ${instruction}`);
      assert(objectCounts[instruction] > 0, `${fixture.id}: Wasm object omitted ${instruction}`);
    }
    if (!fixture.request.simd) {
      assert.equal(wat.simd.length, 0, `${fixture.id}: disabled profile emitted SIMD WAT`);
      assert.equal(wat.v128Types, 0, `${fixture.id}: disabled profile emitted v128 types`);
      assert.equal(encoded.length, 0, `${fixture.id}: disabled profile encoded SIMD instructions`);
    }
    Object.assign(result, {
      assembly: assembly.receipt, object: object.receipt, executable: executable.receipt,
      requiredInstructions: fixture.requiredInstructions,
      watInstructionCounts: watCounts,
      disassembly: {
        command: dumped.command, argv: dumped.argv, exitCode: dumped.exitCode,
        stdout: identify(Buffer.from(dumped.stdout)), stderr: identify(Buffer.from(dumped.stderr)),
        instructionCounts: objectCounts, simdInstructions: encoded
      },
      success: true
    });
  }
  for (const receipt of inputs.values()) checkIdentity(await fs.readFile(receipt.path), receipt, receipt.path);
  report.inputsStable = true;
  report.success = true;
} catch (error) {
  report.error = String(error?.stack || error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  report.inputs = [...inputs.values()];
  report.resultsSha256 = sha256(JSON.stringify(report.cases));
  const bytes = Buffer.from(JSON.stringify(report, null, 2) + '\n');
  try { await outputFile.writeFile(bytes); }
  finally { await outputFile.close(); }
  console.log(JSON.stringify({ success: report.success, passed: report.cases.filter(entry => entry.success).length, output, ...identify(bytes), ...(report.error ? { error: report.error } : {}) }));
}

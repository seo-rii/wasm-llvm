import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { buildCrateRegistry, inventoryDirectory, parseCrateRegistryPlan, sha256 } from '../scripts/build-crate-registry.mjs';

const json = (value) => JSON.stringify(value, null, 2) + '\n';
const commit = '1'.repeat(40);
const version = `rustc 1.99.0\ncommit-hash: ${commit}\nhost: x86_64-unknown-linux-gnu\nrelease: 1.99.0\nLLVM version: 22.1.8\n`;

async function fixture(t, mode = 'success') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'crate-registry-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const options = { sourceRoot: path.join(root, 'sources'), sysroot: path.join(root, 'sysroot'),
    producerManifestPath: path.join(root, 'manifest.json'), rustc: path.join(root, 'fake-rustc'),
    outputDir: path.join(root, 'out'), planPath: path.join(root, 'plan.json') };
  const log = path.join(root, 'calls.jsonl');
  const producer = { schemaVersion: 1, producerId: '@seo-rii/wasm-llvm/rust-browser',
    sources: { rust: { commit, patchedTree: '2'.repeat(40) } } };
  await fs.writeFile(options.producerManifestPath, json(producer));
  const targetRoot = path.join(options.sysroot, 'lib/rustlib/wasm32-wasip1/lib');
  await fs.mkdir(targetRoot, { recursive: true });
  await fs.writeFile(path.join(targetRoot, 'libstd.rlib'), '!<arch>\nfixture');
  const contents = {
    numbers: { 'src/lib.rs': 'mod value; pub fn answer() -> u32 { value::answer() }', 'src/value.rs': 'pub fn answer() -> u32 { 42 }' },
    util: { 'src/lib.rs': 'pub fn answer() -> u32 { renamed::answer() }' },
    top: { 'src/lib.rs': 'pub fn answer() -> u32 { helper::answer() }' },
    unrelated: { 'src/lib.rs': 'pub fn unused() {}' }
  };
  const crates = [];
  for (const [id, files] of Object.entries(contents)) {
    for (const [name, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(options.sourceRoot, id, name)), { recursive: true });
      await fs.writeFile(path.join(options.sourceRoot, id, name), content);
    }
    crates.push({ id, name: id, version: '0.1.0', edition: '2024', entry: 'src/lib.rs',
      features: id === 'util' ? ['std'] : [], dependencies: id === 'util' ? { renamed: 'numbers' } : id === 'top' ? { helper: 'util' } : {},
      sources: (await inventoryDirectory(path.join(options.sourceRoot, id))).files });
  }
  // This process is a controlled fake compiler, not Rust. It checks the real subprocess
  // contract and creates a synthetic ar payload so tests can exercise the publisher.
  const fake = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const args = process.argv.slice(2);
if (args[0] === '-vV') { process.stdout.write(${JSON.stringify(version)}); process.exit(0); }
const get = key => args[args.indexOf(key)+1];
const deps = get('-L').slice('dependency='.length);
const remap = get('--remap-path-prefix').split('=')[0];
const normalized = args.map(s => s.replaceAll(remap, '/crates').replaceAll(${JSON.stringify(options.sysroot)}, '/sysroot'));
const row = { args: normalized, envKeys: Object.keys(process.env).sort(), files: fs.readdirSync(deps).sort() };
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(row)+'\\n');
if (${JSON.stringify(mode)} === 'fail') { process.stderr.write('fixture compile error'); process.exit(1); }
if (${JSON.stringify(mode)} === 'hang') { setTimeout(() => {}, 30000); }
else {
 const source = fs.readFileSync(args.at(-1));
 const digest = crypto.createHash('sha256').update(source).digest('hex');
 fs.writeFileSync(get('-o'), (${JSON.stringify(mode)} === 'bad-archive' ? 'bad' : '!<arch>\\n') + JSON.stringify({ normalized, digest, files: row.files }));
}
`;
  await fs.writeFile(options.rustc, fake, { mode: 0o700 });
  const plan = { schemaVersion: 1, target: 'wasm32-wasip1',
    producerManifestSha256: sha256(json(producer)), rustcExecutableSha256: sha256(fake),
    rustcVersionSha256: sha256(version), sysrootInventorySha256: (await inventoryDirectory(targetRoot)).sha256,
    crates: crates.reverse() };
  const write = () => fs.writeFile(options.planPath, json(plan));
  await write();
  return { root, options, plan, write, targetRoot, log,
    calls: async () => (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse),
    build: () => buildCrateRegistry(options) };
}

async function absent(filename) { await assert.rejects(fs.stat(filename), { code: 'ENOENT' }); }

test('orders locked crates, copies multi-file sources and exposes only the dependency closure', async t => {
  const f = await fixture(t), result = await f.build(), calls = await f.calls();
  assert.deepEqual(calls.map(row => row.args[row.args.indexOf('--crate-name') + 1]), ['numbers', 'util', 'top', 'unrelated']);
  assert.equal(calls[0].files.length, 0);
  assert.equal(calls[1].files.length, 1);
  assert.equal(calls[2].files.length, 2);
  assert.ok(calls[1].args.some(arg => arg.startsWith('renamed=') && arg.includes('libnumbers-')));
  assert.ok(calls[2].args.some(arg => arg.startsWith('helper=') && arg.includes('libutil-')));
  assert.ok(calls[1].args.includes('feature="std"'));
  assert.equal(result.promotion, 'requires-browser-consumer-probe');
  assert.equal(result.crates.find(c => c.id === 'numbers').sources.length, 2);
  await absent(path.join(f.options.outputDir, '.work'));
  for (const crate of result.crates) {
    const raw = await fs.readFile(path.join(f.options.outputDir, crate.rlib.path));
    const gz = await fs.readFile(path.join(f.options.outputDir, crate.rlib.storagePath));
    assert.equal(raw.length, crate.rlib.bytes);
    assert.equal(sha256(raw), crate.rlib.sha256);
    assert.equal(sha256(gz), crate.rlib.storageSha256);
    assert.deepEqual(gunzipSync(gz), raw);
  }
});

test('produces identical recipe-keyed manifests and gzip for the same fake-compiler inputs', async t => {
  const f = await fixture(t), first = await f.build();
  const old = f.options.outputDir;
  f.options.outputDir = path.join(f.root, 'out-again');
  const second = await f.build();
  assert.deepEqual(second, first);
  for (const crate of first.crates) assert.deepEqual(
    await fs.readFile(path.join(old, crate.rlib.storagePath)),
    await fs.readFile(path.join(f.options.outputDir, crate.rlib.storagePath)));
});

test('does not inherit wrappers, rust flags or build-operator environment', async t => {
  const f = await fixture(t);
  process.env.WASM_REGISTRY_TEST_MARKER = 'not-forwarded';
  try { await f.build(); } finally { delete process.env.WASM_REGISTRY_TEST_MARKER; }
  for (const call of await f.calls()) assert.deepEqual(call.envKeys, ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'TZ']);
});

test('rejects cycles, missing dependencies, duplicate IDs and aliases', async t => {
  const f = await fixture(t), copy = () => structuredClone(f.plan);
  let p = copy(); p.crates.find(c => c.id === 'numbers').dependencies = { top: 'top' };
  assert.throws(() => parseCrateRegistryPlan(p), /Cyclic/);
  p = copy(); p.crates[0].dependencies = { missing: 'absent' };
  assert.throws(() => parseCrateRegistryPlan(p), /Missing dependency/);
  p = copy(); p.crates.push(p.crates[0]); assert.throws(() => parseCrateRegistryPlan(p), /Duplicate/);
  p = copy(); p.crates[0].dependencies = { 'bad=alias': 'numbers' };
  assert.throws(() => parseCrateRegistryPlan(p), /alias/);
});

test('rejects unsupported capabilities, malformed features and source paths before subprocesses', async t => {
  const f = await fixture(t);
  for (const patch of [{ buildScript: 'build.rs' }, { crateType: 'proc-macro' }, { flags: ['--cfg', 'unlocked'] },
    { features: ['std', 'std'] }, { features: ['bad"cfg'] }, { entry: '../main.rs' }]) {
    const p = structuredClone(f.plan); Object.assign(p.crates[0], patch);
    assert.throws(() => parseCrateRegistryPlan(p));
  }
  for (const name of ['build.rs', 'src/build.rs', '/absolute.rs', 'src/../a.rs', '.deps/file', 'C:/a.rs']) {
    const p = structuredClone(f.plan); p.crates[0].sources[0].path = name;
    assert.throws(() => parseCrateRegistryPlan(p));
  }
  await absent(f.log);
});

test('rejects source hash changes and undeclared source files before invoking rustc', async t => {
  const f = await fixture(t);
  const source = path.join(f.options.sourceRoot, 'numbers/src/value.rs');
  await fs.writeFile(source, 'changed');
  await assert.rejects(f.build(), /inventory mismatch/);
  await absent(f.log); await absent(f.options.outputDir);
});

test('rejects extra files even if entry and other hashes still match', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.options.sourceRoot, 'numbers/extra'), 'undeclared');
  await assert.rejects(f.build(), /inventory mismatch/); await absent(f.log);
});

test('rejects symlinks in source inventories', async t => {
  const f = await fixture(t);
  await fs.symlink(f.options.planPath, path.join(f.options.sourceRoot, 'numbers/linked'));
  await assert.rejects(f.build(), /Non-regular/); await absent(f.log);
});

test('checks exact compiler, producer and sysroot identities', async t => {
  const f = await fixture(t);
  for (const field of ['producerManifestSha256', 'rustcExecutableSha256', 'sysrootInventorySha256']) {
    const previous = f.plan[field]; f.plan[field] = '0'.repeat(64); await f.write();
    await assert.rejects(f.build(), /SHA-256 mismatch/); f.plan[field] = previous;
    await absent(f.options.outputDir);
  }
  await absent(f.log);
});

test('checks verbose rustc version before compiling and removes failed output reservation', async t => {
  const f = await fixture(t); f.plan.rustcVersionSha256 = '0'.repeat(64); await f.write();
  await assert.rejects(f.build(), /version\/commit/); await absent(f.options.outputDir); await absent(f.log);
});

test('does not overwrite an existing output directory', async t => {
  const f = await fixture(t); await fs.mkdir(f.options.outputDir);
  const sentinel = path.join(f.options.outputDir, 'keep'); await fs.writeFile(sentinel, 'keep');
  await assert.rejects(f.build(), { code: 'EEXIST' }); assert.equal(await fs.readFile(sentinel, 'utf8'), 'keep');
  await absent(f.log);
});

test('does not create output within source or sysroot inputs', async t => {
  const f = await fixture(t);
  f.options.outputDir = path.join(f.options.sourceRoot, 'out');
  await assert.rejects(f.build(), /outside build inputs/); await absent(f.options.outputDir);
  f.options.outputDir = path.join(f.options.sysroot, 'out');
  await assert.rejects(f.build(), /outside build inputs/); await absent(f.log);
});

test('cleans failed compiler output and never publishes an index', async t => {
  const f = await fixture(t, 'fail'); await assert.rejects(f.build(), /fixture compile error/);
  await absent(f.options.outputDir); assert.equal((await f.calls()).length, 1);
});

test('rejects successful commands that did not emit an archive', async t => {
  const f = await fixture(t, 'bad-archive'); await assert.rejects(f.build(), /rlib archive/);
  await absent(f.options.outputDir);
});

test('bounds command runtime and cleans a timed-out build', async t => {
  const f = await fixture(t, 'hang'); f.options.timeoutMs = 200;
  await assert.rejects(f.build()); await absent(f.options.outputDir);
});

test('supports cancellation during native command execution', async t => {
  const f = await fixture(t, 'hang'), controller = new AbortController();
  f.options.signal = controller.signal;
  const work = f.build(), rejected = assert.rejects(work, /abort/i);
  for (let i = 0; i < 100; i++) {
    try { await fs.stat(f.log); break; } catch { await new Promise(r => setTimeout(r, 5)); }
  }
  controller.abort(); await rejected; await absent(f.options.outputDir);
});

test('changing resolved features changes that crate and dependent build identities', async t => {
  const f = await fixture(t), a = await f.build();
  f.plan.crates.find(c => c.id === 'util').features.push('extra'); await f.write();
  f.options.outputDir = path.join(f.root, 'other'); const b = await f.build();
  const key = (result, id) => result.crates.find(c => c.id === id).buildKey;
  assert.equal(key(a, 'numbers'), key(b, 'numbers'));
  assert.notEqual(key(a, 'util'), key(b, 'util'));
  assert.notEqual(key(a, 'top'), key(b, 'top'));
});

test('inventory order is canonical across directory/file lexical boundaries', async t => {
  const f = await fixture(t), root = path.join(f.root, 'inventory');
  await fs.mkdir(path.join(root, 'a'), { recursive: true });
  await fs.writeFile(path.join(root, 'a/x'), 'x'); await fs.writeFile(path.join(root, 'a.txt'), 't');
  const inventory = await inventoryDirectory(root);
  assert.deepEqual(inventory.files.map(f => f.path), ['a.txt', 'a/x']);
});

test('rejects malformed source limits and excessive crate counts', async t => {
  const f = await fixture(t);
  for (const size of [-1, 8 * 1024 * 1024 + 1, NaN]) {
    const p = structuredClone(f.plan); p.crates[0].sources[0].bytes = size;
    assert.throws(() => parseCrateRegistryPlan(p), /byte count/);
  }
  const p = structuredClone(f.plan); p.crates = Array(65).fill(p.crates[0]);
  assert.throws(() => parseCrateRegistryPlan(p), /crate count/);
});


test('rejects non-string names and identities rather than coercing them', async t => {
  const f = await fixture(t);
  for (const [field, value] of [['id', ['numbers']], ['name', ['numbers']], ['version', ['0.1.0']]]) {
    const p = structuredClone(f.plan); p.crates[0][field] = value;
    assert.throws(() => parseCrateRegistryPlan(p));
  }
});

test('a nested source change invalidates the full dependent recipe chain', async t => {
  const f = await fixture(t), original = await f.build();
  await fs.writeFile(path.join(f.options.sourceRoot, 'numbers/src/value.rs'), 'pub fn answer() -> u32 { 43 }');
  f.plan.crates.find(c => c.id === 'numbers').sources = (await inventoryDirectory(path.join(f.options.sourceRoot, 'numbers'))).files;
  await f.write(); f.options.outputDir = path.join(f.root, 'changed-source');
  const changed = await f.build();
  const key = (result, id) => result.crates.find(c => c.id === id).buildKey;
  for (const id of ['numbers', 'util', 'top']) assert.notEqual(key(original, id), key(changed, id));
  assert.equal(key(original, 'unrelated'), key(changed, 'unrelated'));
});

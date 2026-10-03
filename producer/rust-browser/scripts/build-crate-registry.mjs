#!/usr/bin/env node
/** Build explicitly locked, multi-file rlib crates. This is not Cargo or a sandbox. */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const TARGETS = new Set(['wasm32-wasip1', 'wasm32-wasip2', 'wasm32-wasip3']);
const HEX = /^[a-f0-9]{64}$/;
const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const RESERVED = new Set(['self', 'Self', 'super', 'crate', 'std', 'core', 'alloc']);
const MAX_SOURCE = 64 * 1024 * 1024;
const MAX_OUTPUT = 256 * 1024 * 1024;
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const encode = (value) => JSON.stringify(value, null, 2) + '\n';
const fail = (message) => { throw new Error(message); };
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function fields(value, keys, label) {
  if (!plain(value) || Object.keys(value).some((key) => !keys.includes(key))) fail(`Invalid ${label} fields`);
}
function canonical(value) {
  if (typeof value !== 'string' || value.length > 240 || !value || /[\\\x00-\x1f\x7f:=]/.test(value) ||
      value.split('/').some((part) => !part || part === '.' || part === '..')) fail('Unsafe relative path');
  return value;
}
function identifier(value) {
  if (typeof value !== 'string' || !IDENT.test(value) || RESERVED.has(value)) fail('Invalid crate name or dependency alias');
  return value;
}
function digest(value, label) {
  if (typeof value !== 'string' || !HEX.test(value)) fail(`Invalid ${label} SHA-256`);
  return value;
}
function count(value, max, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) fail(`Invalid ${label} byte count`);
  return value;
}

export function parseCrateRegistryPlan(value) {
  fields(value, ['schemaVersion', 'producerManifestSha256', 'rustcExecutableSha256',
    'rustcVersionSha256', 'sysrootInventorySha256', 'target', 'crates'], 'plan');
  if (value.schemaVersion !== 1 || !TARGETS.has(value.target)) fail('Unsupported registry schema or target');
  const plan = { schemaVersion: 1, target: value.target };
  for (const key of ['producerManifestSha256', 'rustcExecutableSha256', 'rustcVersionSha256', 'sysrootInventorySha256'])
    plan[key] = digest(value[key], key);
  if (!Array.isArray(value.crates) || !value.crates.length || value.crates.length > 64) fail('Invalid crate count');
  let sourceBytes = 0, sourceCount = 0;
  plan.crates = value.crates.map((item) => {
    fields(item, ['id', 'name', 'version', 'edition', 'entry', 'features', 'dependencies', 'sources'], 'crate');
    if (typeof item.id !== 'string' || !/^[a-z][a-z0-9_-]{0,79}$/.test(item.id) ||
        typeof item.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(item.version) ||
        !['2021', '2024'].includes(item.edition)) fail('Invalid crate identity, version or edition');
    const name = identifier(item.name), entry = canonical(item.entry);
    if (!entry.endsWith('.rs')) fail('Crate entry must be a Rust source file');
    if (!Array.isArray(item.features) || item.features.length > 128 ||
        item.features.some((feature) => typeof feature !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_+-]{0,79}$/.test(feature)) ||
        new Set(item.features).size !== item.features.length) fail('Invalid resolved features');
    if (!plain(item.dependencies) || Object.keys(item.dependencies).length > 64) fail('Invalid dependencies');
    const dependencies = Object.fromEntries(Object.entries(item.dependencies).sort().map(([alias, id]) => {
      identifier(alias);
      if (typeof id !== 'string') fail('Dependency must identify a locked crate');
      return [alias, id];
    }));
    if (!Array.isArray(item.sources) || !item.sources.length || item.sources.length > 1024) fail('Invalid source inventory');
    const sources = item.sources.map((file) => {
      fields(file, ['path', 'bytes', 'sha256'], 'source');
      const filePath = canonical(file.path), bytes = count(file.bytes, 8 * 1024 * 1024, 'source');
      if (filePath === '.deps' || filePath.startsWith('.deps/')) fail('Source uses reserved .deps directory');
      if (path.posix.basename(filePath) === 'build.rs') fail('build.rs is not supported in this profile');
      sourceBytes += bytes; sourceCount++;
      if (sourceBytes > MAX_SOURCE || sourceCount > 8192) fail('Source inventory exceeds build budget');
      return { path: filePath, bytes, sha256: digest(file.sha256, 'source') };
    }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    if (new Set(sources.map((file) => file.path)).size !== sources.length || !sources.some((file) => file.path === entry))
      fail('Duplicate source or missing entry');
    return { id: item.id, name, version: item.version, edition: item.edition, entry,
      features: [...item.features].sort(), dependencies, sources };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const byId = new Map(plan.crates.map((item) => [item.id, item]));
  if (byId.size !== plan.crates.length) fail('Duplicate crate identity');
  const visiting = new Set(), visited = new Set(), ordered = [];
  const visit = (id) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) fail('Cyclic crate dependencies');
    const item = byId.get(id);
    if (!item) fail(`Missing dependency ${id}`);
    visiting.add(id);
    for (const dependency of Object.values(item.dependencies)) visit(dependency);
    visiting.delete(id); visited.add(id); ordered.push(item);
  };
  for (const item of plan.crates) visit(item.id);
  return { plan, ordered };
}

/** Input directories must be immutable and owned by the build operator. */
async function readRegular(filename, maxBytes) {
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) fail(`Not a bounded regular file: ${filename}`);
    const chunks = []; let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > maxBytes) fail(`File exceeds byte limit: ${filename}`);
      chunks.push(chunk);
    }
    if (size !== stat.size) fail(`File changed during read: ${filename}`);
    return Buffer.concat(chunks, size);
  } finally { await handle.close(); }
}

export async function inventoryDirectory(directory, { maxBytes = 512 * 1024 * 1024, maxFiles = 4096 } = {}) {
  const rows = []; let total = 0;
  const walk = async (current, prefix) => {
    if (!(await fs.lstat(current)).isDirectory()) fail(`Not a regular directory: ${current}`);
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const relative = canonical(prefix ? `${prefix}/${entry.name}` : entry.name);
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(file, relative);
      else {
        if (!entry.isFile() || rows.length >= maxFiles) fail('Non-regular input or file count exceeded');
        const bytes = await readRegular(file, maxBytes - total); total += bytes.length;
        rows.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
      }
    }
  };
  await walk(directory, '');
  if (!rows.length) fail('Empty source/sysroot inventory');
  rows.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { files: rows, sha256: sha256(encode(rows)), bytes: total };
}

function inside(root, destination) {
  const relative = path.relative(root, destination);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function compilerCall(executable, args, cwd, timeout, signal) {
  const env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC', HOME: cwd, TMPDIR: cwd };
  // Do not inherit Cargo/rustup wrappers, RUSTFLAGS, preload hooks or operator secrets.
  return execute(executable, args, { cwd, env, timeout, signal, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 });
}

export async function buildCrateRegistry(options) {
  const { plan, ordered } = parseCrateRegistryPlan(JSON.parse(await readRegular(path.resolve(options.planPath), 2 * 1024 * 1024)));
  const sourceRoot = await fs.realpath(options.sourceRoot), sysroot = await fs.realpath(options.sysroot);
  const output = path.resolve(await fs.realpath(path.dirname(path.resolve(options.outputDir))), path.basename(options.outputDir));
  const rustc = path.resolve(options.rustc), timeout = options.timeoutMs ?? 120000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600000) fail('Invalid compiler timeout');
  if (inside(sourceRoot, output) || inside(sysroot, output)) fail('Output must be outside build inputs');
  options.signal?.throwIfAborted();
  const manifestBytes = await readRegular(path.resolve(options.producerManifestPath), 2 * 1024 * 1024);
  if (sha256(manifestBytes) !== plan.producerManifestSha256) fail('Producer manifest SHA-256 mismatch');
  const manifest = JSON.parse(manifestBytes);
  if (manifest.schemaVersion !== 1 || manifest.producerId !== '@seo-rii/wasm-llvm/rust-browser' ||
      !/^[a-f0-9]{40}$/.test(manifest.sources?.rust?.commit ?? '') ||
      !/^[a-f0-9]{40}$/.test(manifest.sources?.rust?.patchedTree ?? '')) fail('Invalid Rust producer provenance');
  if (sha256(await readRegular(rustc, 512 * 1024 * 1024)) !== plan.rustcExecutableSha256)
    fail('Native rustc executable SHA-256 mismatch');
  const targetLibrary = path.join(sysroot, 'lib', 'rustlib', plan.target, 'lib');
  const initialSysroot = await inventoryDirectory(targetLibrary);
  if (initialSysroot.sha256 !== plan.sysrootInventorySha256) fail('Sysroot inventory SHA-256 mismatch');
  // Validate the complete source inventories before creating output or invoking any compiler.
  for (const item of ordered) {
    const actual = await inventoryDirectory(path.join(sourceRoot, item.id), { maxBytes: MAX_SOURCE, maxFiles: 1024 });
    if (encode(actual.files) !== encode(item.sources)) fail(`Source inventory mismatch: ${item.id}`);
  }
  await fs.mkdir(output, { mode: 0o700 }); // Exclusive reservation; existing output is never replaced.
  const work = path.join(output, '.work');
  try {
    await fs.mkdir(work, { mode: 0o700 });
    const { stdout: version } = await compilerCall(rustc, ['-vV'], work, Math.min(timeout, 10000), options.signal);
    if (sha256(version) !== plan.rustcVersionSha256 || !version.split(/\r?\n/).includes(`commit-hash: ${manifest.sources.rust.commit}`))
      fail('Native rustc version/commit does not match the locked producer');
    const results = new Map(); let outputBytes = 0;
    for (const item of ordered) {
      options.signal?.throwIfAborted();
      const crateRoot = path.join(work, item.id), depsRoot = path.join(crateRoot, '.deps');
      await fs.mkdir(depsRoot, { recursive: true });
      const closure = new Set();
      const collect = (id) => {
        if (closure.has(id)) return;
        closure.add(id);
        for (const dependency of Object.values(results.get(id).dependencies)) collect(dependency);
      };
      for (const id of Object.values(item.dependencies)) collect(id);
      for (const id of [...closure].sort()) {
        const dependency = results.get(id);
        await fs.copyFile(path.join(output, dependency.rlib.path), path.join(depsRoot, path.basename(dependency.rlib.path)));
      }
      for (const file of item.sources) {
        if (file.path === '.deps' || file.path.startsWith('.deps/')) fail('Source uses reserved .deps directory');
        const bytes = await readRegular(path.join(sourceRoot, item.id, file.path), file.bytes);
        if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) fail('Source changed before snapshot');
        const target = path.join(crateRoot, file.path);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
      }
      const key = sha256(encode({ toolchain: { producer: plan.producerManifestSha256, compiler: plan.rustcExecutableSha256,
        version: plan.rustcVersionSha256, sysroot: plan.sysrootInventorySha256 }, target: plan.target, crate: item,
        dependencies: Object.entries(item.dependencies).map(([alias, id]) => [alias, results.get(id).buildKey]),
        profile: 'rlib-abort-O2-cgu1-v1' }));
      const basename = `lib${item.name}-${key}.rlib`, artifactPath = path.join(crateRoot, basename);
      const args = ['--crate-type=rlib', '--crate-name', item.name, '--edition', item.edition,
        '--target', plan.target, '--sysroot', sysroot, '-Cpanic=abort', '-Copt-level=2', '-Ccodegen-units=1',
        '-Cdebuginfo=0', `-Cmetadata=${key}`, '--remap-path-prefix', `${work}=/crates`,
        '-L', `dependency=${depsRoot}`];
      for (const feature of item.features) args.push('--cfg', `feature=${JSON.stringify(feature)}`);
      for (const [alias, id] of Object.entries(item.dependencies))
        args.push('--extern', `${alias}=${path.join(depsRoot, path.basename(results.get(id).rlib.path))}`);
      args.push('-o', artifactPath, path.join(crateRoot, item.entry));
      await compilerCall(rustc, args, crateRoot, timeout, options.signal);
      const bytes = await readRegular(artifactPath, Math.min(64 * 1024 * 1024, MAX_OUTPUT - outputBytes));
      if (!bytes.subarray(0, 8).equals(Buffer.from('!<arch>\n'))) fail('Compiler did not produce an rlib archive');
      outputBytes += bytes.length;
      const rlibPath = `artifacts/${basename}`, storage = gzipSync(bytes, { level: 9, mtime: 0 });
      await fs.mkdir(path.join(output, 'artifacts'), { recursive: true });
      await fs.writeFile(path.join(output, rlibPath), bytes, { flag: 'wx', mode: 0o644 });
      await fs.writeFile(path.join(output, `${rlibPath}.gz`), storage, { flag: 'wx', mode: 0o644 });
      results.set(item.id, { ...item, buildKey: key, rlib: { path: rlibPath, bytes: bytes.length, sha256: sha256(bytes),
        storagePath: `${rlibPath}.gz`, storageBytes: storage.length, storageSha256: sha256(storage) } });
      await fs.rm(crateRoot, { recursive: true });
    }
    if ((await inventoryDirectory(targetLibrary)).sha256 !== initialSysroot.sha256 ||
        sha256(await readRegular(rustc, 512 * 1024 * 1024)) !== plan.rustcExecutableSha256)
      fail('Compiler/sysroot changed during registry build');
    options.signal?.throwIfAborted();
    const registry = { schemaVersion: 1, kind: 'wasm-rust-precompiled-crates', promotion: 'requires-browser-consumer-probe',
      target: plan.target, producerManifestSha256: plan.producerManifestSha256,
      rustcExecutableSha256: plan.rustcExecutableSha256, rustcVersionSha256: plan.rustcVersionSha256,
      rustSourceCommit: manifest.sources.rust.commit, rustPatchedTree: manifest.sources.rust.patchedTree,
      sysrootInventorySha256: plan.sysrootInventorySha256, profile: 'rlib-abort-O2-cgu1-v1',
      crates: [...results.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
    await fs.rm(work, { recursive: true });
    await fs.writeFile(path.join(output, 'registry.v1.json'), encode(registry), { flag: 'wx', mode: 0o644 });
    return registry;
  } catch (error) {
    await fs.rm(output, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = {}, names = {
      '--plan': 'planPath', '--sources': 'sourceRoot', '--sysroot': 'sysroot',
      '--rustc': 'rustc', '--producer-manifest': 'producerManifestPath', '--out': 'outputDir'
    };
    if (args.length !== 12) fail('Usage: --plan FILE --sources DIR --sysroot DIR --rustc FILE --producer-manifest FILE --out NEW_DIR');
    for (let i = 0; i < args.length; i += 2) {
      const key = names[args[i]];
      if (!key || options[key] || !args[i + 1]) fail('Unknown, duplicate or missing CLI option');
      options[key] = args[i + 1];
    }
    const registry = await buildCrateRegistry(options);
    console.log(`Built ${registry.crates.length} locked crates; browser compatibility promotion is still required.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

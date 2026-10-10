#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rm, statfs } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readJson, readRegular, relativePath, sha256, writeJson } from '../scripts/source.mjs';

const HERE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(HERE), '..');
const REPOSITORY = path.resolve(ROOT, '..', '..');
const execute = promisify(execFile);
export const defaultCache = path.join(REPOSITORY, 'out', 'kotlin-browser-bootstrap', '2.5.0-dev-10106');

export async function loadBootstrapLock(root = ROOT) {
  const lock = await readJson(path.join(root, 'build', 'bootstrap.lock.json'));
  const manifest = await readJson(path.join(root, 'manifest.json'));
  const sources = await readJson(path.join(root, 'sources.lock.json'));
  if (lock.schemaVersion !== 1 || lock.version !== '2.5.0-dev-10106' ||
      lock.selectedSourceCommit !== manifest.source.commit || lock.selectedSourceCommit !== sources.source.commit ||
      lock.compilerSourceCommit !== null || !Array.isArray(lock.artifacts) || !lock.artifacts.length) {
    throw new Error('Invalid bootstrap/source identity');
  }
  if (!sources.toolAndArtifactDeclarations.some((tool) => tool.name === 'bootstrap-compiler' && tool.version === lock.version)) {
    throw new Error('Bootstrap version differs from the selected upstream default');
  }
  const ids = new Set();
  const files = new Set();
  const bootstrapIds = new Set(['compiler', 'build-tools-api', 'stdlib-jvm', 'daemon', 'stdlib-wasi', 'stdlib-js']);
  for (const pin of lock.artifacts) {
    relativePath(pin.file);
    if (pin.file.includes('/') || ids.has(pin.id) || files.has(pin.file) ||
        !/^[a-z0-9.-]+$/.test(pin.group) || !/^[a-z0-9-]+$/.test(pin.artifact) ||
        !/^[A-Za-z0-9.-]+$/.test(pin.version) || !Number.isSafeInteger(pin.bytes) || pin.bytes <= 0 ||
        pin.bytes > 128 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(pin.sha256)) throw new Error('Invalid bootstrap artifact pin');
    if (bootstrapIds.has(pin.id) && pin.version !== lock.version) throw new Error('Mixed bootstrap compiler/library versions');
    const extension = ['stdlib-wasi', 'stdlib-js'].includes(pin.id) ? '.klib' : '.jar';
    if (pin.file !== pin.artifact + '-' + pin.version + extension) throw new Error('Bootstrap artifact filename mismatch');
    const suffix = `${pin.group.replaceAll('.', '/')}/${pin.artifact}/${pin.version}/${pin.file}`;
    const base = pin.version === lock.version ? 'https://redirector.kotlinlang.org/maven/bootstrap/' : 'https://repo.maven.apache.org/maven2/';
    if (pin.url !== base + suffix) throw new Error('Bootstrap artifact URL/coordinate mismatch');
    ids.add(pin.id);
    files.add(pin.file);
  }
  for (const id of ['compiler', 'build-tools-api', 'stdlib-jvm', 'daemon', 'stdlib-wasi', 'stdlib-js', 'reflect', 'coroutines', 'annotations']) {
    if (!ids.has(id)) throw new Error('Missing bootstrap artifact: ' + id);
  }
  return lock;
}

export async function verifyArtifact(filename, pin) {
  await assertNoSymlink(filename);
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== pin.bytes) throw new Error('Bootstrap artifact size mismatch: ' + pin.id);
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) { bytes += chunk.length; hash.update(chunk); }
    if (bytes !== pin.bytes || hash.digest('hex') !== pin.sha256) throw new Error('Bootstrap artifact hash mismatch: ' + pin.id);
    return { id: pin.id, path: filename, file: pin.file, bytes, sha256: pin.sha256, version: pin.version, verified: true };
  } finally { await handle.close(); }
}

async function publishArtifact(filename, pin, iterable) {
  const temporary = filename + '.download-' + process.pid;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    try {
      for await (const chunk of iterable) {
        bytes += chunk.length;
        if (bytes > pin.bytes) throw new Error('Bootstrap download exceeds pinned bytes: ' + pin.id);
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) offset += (await handle.write(chunk, offset)).bytesWritten;
      }
      if (bytes !== pin.bytes || hash.digest('hex') !== pin.sha256) throw new Error('Bootstrap download does not match pin: ' + pin.id);
    } finally { await handle.close(); }
    await link(temporary, filename);
  } finally { await rm(temporary, { force: true }); }
}

async function cachedGradleArtifact(pin, reuseRoot) {
  if (!reuseRoot) return null;
  const directory = path.join(reuseRoot, pin.group, pin.artifact, pin.version);
  let hashes;
  try { hashes = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  for (const hash of hashes.sort()) {
    if (!/^[a-f0-9]{40}$/.test(hash)) continue;
    const filename = path.join(directory, hash, pin.file);
    try { await verifyArtifact(filename, pin); return filename; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return null;
}

export async function verifyBootstrap(cacheRoot = defaultCache, { root = ROOT } = {}) {
  const lock = await loadBootstrapLock(root);
  const artifacts = [];
  for (const pin of lock.artifacts) artifacts.push(await verifyArtifact(path.join(cacheRoot, pin.file), pin));
  return { lock, cacheRoot, artifacts, classPath: artifacts.filter((item) => item.file.endsWith('.jar')).map((item) => item.path).join(path.delimiter),
    wasmWasiStdlib: artifacts.find((item) => item.id === 'stdlib-wasi').path,
    wasmJsStdlib: artifacts.find((item) => item.id === 'stdlib-js').path };
}

export async function prepareBootstrap({ cacheRoot = defaultCache, reuseRoot = path.join(os.homedir(), '.gradle', 'caches', 'modules-2', 'files-2.1'),
  root = ROOT, fetcher = fetch, java = 'java' } = {}) {
  const lock = await loadBootstrapLock(root);
  await assertNoSymlink(cacheRoot);
  await mkdir(cacheRoot, { recursive: true });
  const available = await statfs(cacheRoot, { bigint: true });
  const budget = lock.artifacts.reduce((sum, pin) => sum + BigInt(pin.bytes), 0n) + 100n * 1024n * 1024n;
  if (available.bavail * available.bsize < budget) throw new Error('Insufficient disk space for the bounded bootstrap artifact set');
  for (const pin of lock.artifacts) {
    const filename = path.join(cacheRoot, pin.file);
    try { await lstat(filename); await verifyArtifact(filename, pin); continue; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const cached = await cachedGradleArtifact(pin, reuseRoot);
    if (cached) await publishArtifact(filename, pin, createReadStream(cached));
    else {
      let response;
      try { response = await fetcher(pin.url, { redirect: 'follow', signal: AbortSignal.timeout(120000) }); }
      catch (error) { throw new Error('Bootstrap download failed: ' + pin.id + ' (' + (error.cause?.code ?? error.name) + ')'); }
      if (!response.ok || !response.body || response.url && new URL(response.url).protocol !== 'https:') {
        throw new Error('Bootstrap download failed: ' + pin.id + ' HTTP ' + response.status);
      }
      await publishArtifact(filename, pin, response.body);
    }
    console.log('verified ' + pin.id + ': ' + pin.bytes + ' bytes');
  }
  const prepared = await verifyBootstrap(cacheRoot, { root });
  const version = await execute(java, ['-Xmx1g', '-cp', prepared.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-version'],
    { timeout: 60000, maxBuffer: 1024 * 1024 });
  const output = (version.stdout + version.stderr).trim();
  if (/kotlinc-jvm ([^\s]+)/.exec(output)?.[1] !== lock.version) throw new Error('Bootstrap compiler reports a different version');
  const jdk = await execute(java, ['-version'], { timeout: 10000, maxBuffer: 65536 });
  const receipt = { schemaVersion: 1, kind: 'official-kotlin-bootstrap-preparation', version: lock.version,
    selectedSourceCommit: lock.selectedSourceCommit, compilerSourceCommit: null,
    bootstrapLockSha256: sha256(await readRegular(path.join(root, 'build', 'bootstrap.lock.json'))),
    artifacts: prepared.artifacts.map(({ path: ignored, ...item }) => item),
    compilerVersionOutput: output, javaVersionOutput: (jdk.stdout + jdk.stderr).trim(),
    readiness: { R0: 'not-run', browserCompiler: 'not-built', ready: false } };
  const receiptFile = path.join(cacheRoot, 'bootstrap-receipt.json');
  try { await writeJson(receiptFile, receipt); }
  catch (error) {
    if (error.code !== 'EEXIST' || JSON.stringify(await readJson(receiptFile)) !== JSON.stringify(receipt)) throw error;
  }
  return { ...prepared, receipt, receiptFile };
}

if (process.argv[1] && path.resolve(process.argv[1]) === HERE) {
  try {
    const args = process.argv.slice(2).filter((argument) => argument !== '--');
    const command = args.shift();
    if (!command || command === '--help') console.log('Usage: node producer/kotlin-browser/build/bootstrap.mjs <prepare|verify> [--cache-dir DIR] [--reuse-dir GRADLE_MODULE_CACHE]');
    else {
      if (!['prepare', 'verify'].includes(command)) throw new Error('Unknown bootstrap command');
      const options = {};
      while (args.length) {
        const option = args.shift();
        if (!['--cache-dir', '--reuse-dir'].includes(option) || !args[0] || args[0].startsWith('--')) throw new Error('Invalid bootstrap option');
        const key = option === '--cache-dir' ? 'cacheRoot' : 'reuseRoot';
        if (options[key]) throw new Error('Duplicate bootstrap option');
        options[key] = path.resolve(args.shift());
      }
      const result = command === 'prepare' ? await prepareBootstrap(options) : await verifyBootstrap(options.cacheRoot);
      console.log(JSON.stringify({ cacheRoot: result.cacheRoot, version: result.lock.version,
        artifacts: result.artifacts.length, classPath: result.classPath, wasmWasiStdlib: result.wasmWasiStdlib, wasmJsStdlib: result.wasmJsStdlib,
        receipt: result.receiptFile ?? null }));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

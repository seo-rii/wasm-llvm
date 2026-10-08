import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execute = promisify(execFile);
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const gitBlob = (bytes) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
export const json = (value) => JSON.stringify(value, null, 2) + '\n';
export const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function relativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') ||
      value.startsWith('/') || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Expected a non-empty POSIX relative path');
  }
  return value;
}

function repository(value) {
  if (typeof value !== 'string' || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(value)) {
    throw new Error('Expected a pinned GitHub HTTPS source repository');
  }
  return value.replace(/\.git$/, '');
}

export function validateLock(lock, manifest) {
  if (lock?.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(lock.source?.commit ?? '') ||
      !/^[a-f0-9]{40}$/.test(lock.source?.treeSha ?? '')) throw new Error('Invalid source lock identity');
  repository(lock.source.repository);
  if (manifest && (manifest.schemaVersion !== 1 || lock.source.commit !== manifest.source?.commit ||
      repository(lock.source.repository) !== repository(manifest.source?.repository))) {
    throw new Error('Manifest/source lock revision mismatch');
  }
  if (!Array.isArray(lock.files) || !lock.files.length || lock.files.length > 2000 ||
      !Array.isArray(lock.roots) || !lock.roots.length) throw new Error('Invalid source lock inventory');
  const seen = new Set();
  for (const file of lock.files) {
    relativePath(file.path);
    if (seen.has(file.path)) throw new Error('Duplicate source lock path: ' + file.path);
    seen.add(file.path);
    validateFilePin(file);
  }
  if (!seen.has('settings.gradle.kts')) throw new Error('Source lock must pin settings.gradle.kts');
  const roots = new Set();
  for (const root of lock.roots) {
    if (typeof root !== 'string' || !/^:[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)*$/.test(root)) {
      throw new Error('Invalid Gradle root project ID');
    }
    if (roots.has(root)) throw new Error('Duplicate Gradle root project ID');
    roots.add(root);
  }
  if (manifest?.auditRoots && json([...manifest.auditRoots].sort(compare)) !== json([...lock.roots].sort(compare))) {
    throw new Error('Manifest/source lock audit roots mismatch');
  }
  return lock;
}

export function validateFilePin(file) {
  if (!/^[a-f0-9]{40}$/.test(file.gitBlob ?? '') || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '') ||
      !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_SOURCE_BYTES) {
    throw new Error('Invalid source file pin: ' + (file.path ?? file.file));
  }
  return file;
}

export function verifyFile(bytes, pin) {
  if (bytes.length !== pin.bytes || gitBlob(bytes) !== pin.gitBlob || sha256(bytes) !== pin.sha256) {
    throw new Error('Pinned source content mismatch: ' + pin.path);
  }
  return bytes;
}

export async function assertNoSymlink(filename) {
  filename = path.resolve(filename);
  let current = path.parse(filename).root;
  for (const part of filename.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('Symlink paths are not accepted: ' + current);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

export async function readRegular(filename, maximum = MAX_SOURCE_BYTES) {
  await assertNoSymlink(filename);
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximum) throw new Error('Expected a bounded regular file: ' + filename);
    const bytes = await handle.readFile();
    if (bytes.length > maximum) throw new Error('File grew beyond its size limit: ' + filename);
    return bytes;
  } finally { await handle.close(); }
}

export async function responseBytes(url, maximum, fetcher, headers = {}, { publicRedirect = false } = {}) {
  let response;
  if (publicRedirect && Object.keys(headers).length) throw new Error('Public redirect requests cannot carry authentication headers');
  try { response = await fetcher(url, { headers, signal: AbortSignal.timeout(30000), redirect: publicRedirect ? 'follow' : 'error' }); }
  catch (error) { throw new Error('Source request failed at ' + url + ' (' + (error.cause?.code ?? error.name) + ')'); }
  if (response.url && new URL(response.url).protocol !== 'https:') throw new Error('Source requests require HTTPS');
  if (!response.ok || !response.body) throw new Error('Source request failed: HTTP ' + response.status + ' at ' + url);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > maximum) throw new Error('Source response exceeds pinned size at ' + url);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function readVerifiedSources(lock, { sourceDir, fetcher = fetch } = {}) {
  validateLock(lock);
  const files = new Map();
  if (sourceDir) {
    await assertNoSymlink(sourceDir);
    const directory = await realpath(sourceDir);
    const runGit = async (args) => (await execute('git', args, { cwd: directory, maxBuffer: 1024 * 1024 })).stdout.trim();
    if (await runGit(['rev-parse', '--show-toplevel']) !== directory ||
        await runGit(['rev-parse', 'HEAD']) !== lock.source.commit ||
        await runGit(['rev-parse', 'HEAD^{tree}']) !== lock.source.treeSha) {
      throw new Error('Source directory must be the checkout root at the locked commit/tree');
    }
    const tree = await runGit(['ls-tree', '-rz', '--full-tree', lock.source.commit, '--', ...lock.files.map((file) => file.path)]);
    const blobs = new Map(tree.split('\0').filter(Boolean).map((item) => {
      const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/s.exec(item);
      if (!match) throw new Error('Locked source tree entry must be a regular Git blob');
      return [match[3], match[2]];
    }));
    for (const pin of lock.files) {
      if (blobs.get(pin.path) !== pin.gitBlob) throw new Error('Source tree/blob identity mismatch: ' + pin.path);
      files.set(pin.path, verifyFile(await readRegular(path.join(directory, pin.path), pin.bytes), pin));
    }
  } else {
    const repo = repository(lock.source.repository).slice('https://github.com/'.length);
    const headers = { Accept: 'application/vnd.github+json' };
    if (process.env.GITHUB_TOKEN) headers.Authorization = 'Bearer ' + process.env.GITHUB_TOKEN;
    const commit = JSON.parse((await responseBytes(`https://api.github.com/repos/${repo}/git/commits/${lock.source.commit}`,
      1024 * 1024, fetcher, headers)).toString('utf8'));
    if (commit.sha !== lock.source.commit || commit.tree?.sha !== lock.source.treeSha) {
      throw new Error('Remote commit/tree does not match the source lock');
    }
    // The checked-in lock is the trust root for selected blobs. This is a selected-file audit,
    // not an assertion that the entire remote tree, Gradle build, or symbol closure was audited.
    for (let offset = 0; offset < lock.files.length; offset += 4) {
      const batch = await Promise.all(lock.files.slice(offset, offset + 4).map(async (pin) => {
        const suffix = pin.path.split('/').map(encodeURIComponent).join('/');
        const url = `https://raw.githubusercontent.com/${repo}/${lock.source.commit}/${suffix}`;
        return [pin.path, verifyFile(await responseBytes(url, pin.bytes, fetcher), pin)];
      }));
      for (const [filename, bytes] of batch) files.set(filename, bytes);
    }
  }
  return files;
}

export async function writeJson(filename, value) {
  await assertNoSymlink(filename);
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = filename + '.tmp-' + process.pid;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { await handle.writeFile(json(value)); } finally { await handle.close(); }
    // link() publishes atomically and rejects existing targets; rename() could overwrite evidence.
    await link(temporary, filename);
  } finally { await rm(temporary, { force: true }); }
}

export async function readJson(filename) { return JSON.parse((await readRegular(filename)).toString('utf8')); }

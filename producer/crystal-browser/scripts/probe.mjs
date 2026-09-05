#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_FILE = fileURLToPath(import.meta.url);
const PRODUCER_ROOT = path.resolve(path.dirname(THIS_FILE), '..');
const REPO_ROOT = path.resolve(PRODUCER_ROOT, '..', '..');
export const manifest = JSON.parse(await readFile(path.join(PRODUCER_ROOT, 'manifest.json'), 'utf8'));

export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function verifyBootstrap(file) {
  if ((await stat(file)).size !== manifest.bootstrap.bytes || await sha256(file) !== manifest.bootstrap.sha256) {
    throw new Error('Crystal bootstrap archive does not match the pinned size and SHA-256');
  }
}

export function run(command, args, { cwd, env = process.env, timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let escalation;
    const terminate = (signal) => {
      try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate('SIGTERM');
      escalation = setTimeout(() => terminate('SIGKILL'), 2000);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-1024 * 1024); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-1024 * 1024); });
    child.once('error', (error) => { clearTimeout(timer); clearTimeout(escalation); reject(error); });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      clearTimeout(escalation);
      resolve({ exitCode, signal, timedOut, stdout, stderr });
    });
  });
}

async function checked(command, args, options) {
  const result = await run(command, args, options);
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(command + ' failed: ' + (result.stderr || result.stdout).slice(-12000));
  }
  return result.stdout.trim();
}

async function downloadBootstrap(file) {
  try { await access(file); await verifyBootstrap(file); return; } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = file + '.download-' + process.pid;
  const response = await fetch(manifest.bootstrap.url, { signal: AbortSignal.timeout(240000) });
  if (!response.ok || !response.body) throw new Error('Bootstrap download failed: HTTP ' + response.status);
  let size = 0;
  try {
    await pipeline(response.body, new Transform({
      transform(chunk, encoding, callback) {
        size += chunk.length;
        callback(size > manifest.bootstrap.bytes ? new Error('Bootstrap exceeds pinned size') : null, chunk);
      }
    }), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    await verifyBootstrap(temporary);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function verifySource(source, expected = manifest.sources.crystal) {
  const commit = await checked('git', ['rev-parse', 'HEAD'], { cwd: source });
  if (commit !== expected.commit) throw new Error('Source revision does not match the manifest: ' + source);
  const changes = await checked('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: source });
  if (changes) throw new Error('Crystal source checkout must be clean');
  return commit;
}

export async function prepare(workRoot) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Pinned bootstrap requires Linux x86_64');
  await mkdir(workRoot, { recursive: true });
  const archive = path.join(workRoot, 'crystal-bootstrap.tar.gz');
  await downloadBootstrap(archive);
  const checkouts = {};
  for (const [name, pin] of Object.entries(manifest.sources)) {
    const checkout = path.join(workRoot, name === 'crystal' ? 'source' : name + '-source');
    try { await access(checkout); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await checked('git', ['clone', '--filter=blob:none', '--no-checkout', '--depth=1', '--branch', pin.tag,
        pin.repository, checkout], { timeoutMs: 240000 });
      await checked('git', ['checkout', '--detach', pin.commit], { cwd: checkout });
    }
    await verifySource(checkout, pin);
    checkouts[name] = checkout;
  }
  // Extract the verified upstream archive into a fresh task-owned directory on each run.
  const bootstrap = await mkdtemp(path.join(workRoot, 'bootstrap-'));
  await checked('tar', ['-xzf', archive, '--strip-components=2', '-C', bootstrap]);
  const compiler = path.join(bootstrap, 'bin', 'crystal');
  const version = await checked(compiler, ['--version']);
  if (!version.startsWith('Crystal ' + manifest.sources.crystal.version + ' ')) {
    throw new Error('Bootstrap compiler reports an unexpected version: ' + version);
  }
  return { source: checkouts.crystal, checkouts, archive, bootstrap, compiler, version, compilerSha256: await sha256(compiler) };
}

export function assertWasmObject(bytes) {
  if (bytes.length < 8 || !Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) {
    throw new Error('Expected a WebAssembly object; native output is not a compiler-host success');
  }
  const module = new WebAssembly.Module(bytes);
  const linking = WebAssembly.Module.customSections(module, 'linking');
  if (linking.length !== 1 || new Uint8Array(linking[0])[0] !== 2) {
    throw new Error('Expected a WebAssembly relocatable object with a version 2 linking section');
  }
}

export function classifyProbe({ baseline, negative, compilerHost }) {
  return {
    nativeWasiObject: baseline.exitCode === 0 && baseline.wasmObject === true,
    nativeDiagnostics: negative.exitCode !== null && negative.exitCode !== 0 && !negative.timedOut &&
      /Syntax error|Error:/u.test(negative.stderr + negative.stdout),
    compilerHostObject: compilerHost.exitCode === 0 && compilerHost.wasmObject === true,
    browserCompiler: false,
    browserStdinStdout: false,
    ready: false
  };
}

export async function probe(workRoot, { llvmConfig } = {}) {
  const startedAt = new Date().toISOString();
  const inputs = await prepare(workRoot);
  const directory = await mkdtemp(path.join(workRoot, 'probe-'));
  const env = { ...process.env,
    CRYSTAL_PATH: Object.values(inputs.checkouts).map((checkout) => path.join(checkout, 'src')).join(path.delimiter),
    CRYSTAL_CACHE_DIR: path.join(directory, 'cache') };
  let llvm = null;
  if (llvmConfig) {
    env.LLVM_CONFIG = path.resolve(llvmConfig);
    llvm = { path: env.LLVM_CONFIG, sha256: await sha256(env.LLVM_CONFIG),
      version: await checked(env.LLVM_CONFIG, ['--version']) };
  }
  const commonArgs = ['--cross-compile', '--target', manifest.target, '--no-debug', '-Dwithout_mt'];
  const steps = {};
  const cases = [
    ['baseline', path.join(PRODUCER_ROOT, 'fixtures', 'stdin-sum.cr'), []],
    ['negative', path.join(PRODUCER_ROOT, 'fixtures', 'invalid.cr'), []],
    ['compilerHost', path.join(inputs.source, 'src', 'compiler', 'crystal.cr'),
      ['-Di_know_what_im_doing', '-Dwithout_playground', '-Dwithout_interpreter', '-Dwithout_libxml2', '-Dwithout_openssl', '-Dwithout_zlib']]
  ];
  for (const [name, source, flags] of cases) {
    const output = path.join(directory, name + '.wasm');
    const args = ['build', source, ...commonArgs, ...flags, '-o', output];
    const result = await run(inputs.compiler, args, { cwd: directory, env });
    // With --cross-compile Crystal writes the relocatable object directly to -o.
    const object = output;
    let objectReceipt = null;
    if (result.exitCode === 0) {
      try {
        const bytes = await readFile(object);
        assertWasmObject(bytes);
        objectReceipt = { path: object, bytes: bytes.length, sha256: await sha256(object) };
      } catch (error) {
        result.validationError = error.message;
      }
    }
    steps[name] = { command: [inputs.compiler, ...args], ...result, wasmObject: objectReceipt !== null, object: objectReceipt };
    console.log(name + ': exit=' + result.exitCode + ', wasmObject=' + (objectReceipt !== null));
    if (result.exitCode !== 0) console.log((result.stderr || result.stdout).slice(-12000));
  }
  const receipt = {
    format: 'wasm-llvm-crystal-portability-v1', startedAt, completedAt: new Date().toISOString(),
    target: manifest.target, manifestSha256: await sha256(path.join(PRODUCER_ROOT, 'manifest.json')),
    sourceCommit: manifest.sources.crystal.commit,
    dependencyCommits: Object.fromEntries(Object.entries(manifest.sources).map(([name, pin]) => [name, pin.commit])),
    llvm,
    bootstrap: { archiveSha256: manifest.bootstrap.sha256, compilerSha256: inputs.compilerSha256, version: inputs.version },
    fixtureSha256: await sha256(path.join(PRODUCER_ROOT, 'fixtures', 'stdin-sum.cr')),
    steps, gates: classifyProbe(steps)
  };
  const receiptPath = path.join(directory, 'receipt.json');
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ receipt: receiptPath, gates: receipt.gates }));
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
  try {
    const args = process.argv.slice(2).filter((item) => item !== '--');
    const command = args.shift();
    if (!command || command === '--help') {
      console.log('Usage: node producer/crystal-browser/scripts/probe.mjs <prepare|probe> [--work-root DIR] [--llvm-config FILE]');
    } else {
      if (!['prepare', 'probe'].includes(command)) throw new Error('Unknown command: ' + command);
      const options = { workRoot: path.join(REPO_ROOT, 'out', 'crystal-browser-work') };
      while (args.length) {
        const option = args.shift();
        if (!['--work-root', '--llvm-config'].includes(option) || !args[0] || args[0].startsWith('--')) {
          throw new Error('Invalid option: ' + option);
        }
        options[option === '--work-root' ? 'workRoot' : 'llvmConfig'] = path.resolve(args.shift());
      }
      if (command === 'prepare') console.log(JSON.stringify(await prepare(options.workRoot)));
      else {
        const receipt = await probe(options.workRoot, options);
        if (!receipt.gates.nativeWasiObject || !receipt.gates.nativeDiagnostics || !receipt.gates.compilerHostObject) process.exitCode = 1;
      }
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

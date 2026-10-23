import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { constants, brotliCompressSync, gzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { commonBuildFingerprint, git, inventory, json, sha256 } from './prepare-elf-linker-experiment.mjs';

const GiB = 1024 ** 3;
const scriptDir = fileURLToPath(new URL('.', import.meta.url));

export async function resources(directory) {
  const disk = await fs.statfs(directory);
  const memory = await fs.readFile('/proc/meminfo', 'utf8');
  return { diskBytes: disk.bavail * disk.bsize,
    availableMemoryBytes: Number(memory.match(/^MemAvailable:\s+(\d+) kB$/m)?.[1] || 0) * 1024 };
}

export function assertResources(actual, { diskGiB, memoryGiB }) {
  if (actual.diskBytes < diskGiB * GiB) throw new Error(`Need ${diskGiB} GiB free disk; available ${(actual.diskBytes / GiB).toFixed(2)}`);
  if (actual.availableMemoryBytes < memoryGiB * GiB) throw new Error(`Need ${memoryGiB} GiB available memory; available ${(actual.availableMemoryBytes / GiB).toFixed(2)}`);
}

export function baselineDiskRequirement(plan, { verifiedCheckpoint, allocatedWorkBytes = 0 }) {
  // A mere launch attempt is not a checkpoint. Once a pinned common phase completed, subtract only
  // actual work-directory allocation from the original 60 GiB reservation, retaining the 12 GiB floor.
  return verifiedCheckpoint
    ? Math.max(plan.gates.phaseDiskGiB, plan.gates.initialDiskGiB - allocatedWorkBytes / GiB)
    : plan.gates.initialDiskGiB;
}

async function baselineResourceGate(plan) {
  let verifiedCheckpoint = false;
  try {
    const owner = JSON.parse(await fs.readFile(path.join(plan.work, 'stamp-ownership.json'), 'utf8'));
    const stamp = (await fs.readFile(path.join(plan.work, 'build/stamps/llvm-host.done'), 'utf8')).trim();
    const manifest = JSON.parse(await fs.readFile(path.join(plan.variants.baseline.root, 'manifest.json'), 'utf8'));
    const clang = await fs.stat(path.join(plan.work, 'build/llvm-host-build/bin/clang'));
    verifiedCheckpoint = owner.common === plan.variants.baseline.commonFingerprint &&
      owner.variant === plan.variants.baseline.manifestSha256 && stamp === String(manifest.sourceDateEpoch) && clang.size > 0;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let allocatedWorkBytes = 0;
  if (verifiedCheckpoint) {
    const measured = execFileSync('du', ['-s', '-x', '-B1', '--', plan.work], { encoding: 'utf8' });
    allocatedWorkBytes = Number(measured.split(/\s+/, 1)[0]);
    if (!Number.isSafeInteger(allocatedWorkBytes) || allocatedWorkBytes < 0) throw new Error('Invalid work-directory allocation');
  }
  return { verifiedCheckpoint, allocatedWorkBytes, diskGiB: baselineDiskRequirement(plan, { verifiedCheckpoint, allocatedWorkBytes }),
    memoryGiB: plan.gates.availableMemoryGiB };
}

async function writeState(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, json(value), { mode: 0o600 });
  await fs.rename(temporary, file);
}

export async function liveGroupMembers(group) {
  const members = [];
  for (const name of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = await fs.readFile(`/proc/${name}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) === group && fields[0] !== 'Z') members.push(Number(name));
    } catch (error) { if (!['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) throw error; }
  }
  return members;
}

async function terminateGroup(group, graceMs) {
  const signal = (name) => {
    try { process.kill(-group, name); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  signal('SIGTERM');
  const deadline = Date.now() + graceMs;
  while ((await liveGroupMembers(group)).length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, graceMs)));
  }
  let escalated = false;
  if ((await liveGroupMembers(group)).length) { signal('SIGKILL'); escalated = true; }
  const killedDeadline = Date.now() + 5000;
  let remaining;
  do {
    remaining = await liveGroupMembers(group);
    if (!remaining.length) return { escalated, remaining };
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < killedDeadline);
  throw new Error(`Process group ${group} still contains live processes: ${remaining.join(',')}`);
}

export class PhaseRunner {
  constructor(root, { resourceReader = resources, emergencyDiskGiB = 4, pollMs = 15000,
    terminateGraceMs = 10000, signal, statusWriter = writeState } = {}) {
    this.root = root;
    this.resourceReader = resourceReader;
    this.emergencyDiskGiB = emergencyDiskGiB;
    this.pollMs = pollMs;
    this.terminateGraceMs = terminateGraceMs;
    this.signal = signal;
    this.statusWriter = statusWriter;
  }

  async run(name, command, args, { env = process.env, cwd = this.root, timeoutMs = 96 * 60 * 60 * 1000 } = {}) {
    this.signal?.throwIfAborted();
    const directory = path.join(this.root, 'phases');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const attempt = `${name}-${Date.now()}-${process.pid}`;
    const logPath = path.join(directory, `${attempt}.log`);
    const statusPath = path.join(directory, `${attempt}.status.json`);
    const log = await fs.open(logPath, 'wx', 0o600);
    try { this.signal?.throwIfAborted(); } catch (error) { await log.close(); throw error; }
    const startedAt = new Date().toISOString();
    const start = performance.now();
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', log.fd, log.fd] });
    let stopReason = null;
    let finished = false;
    let groupCleanup;
    let timeout;
    let guard;
    let setupError;
    let completed;
    const stop = (reason) => {
      if (stopReason || finished) return;
      stopReason = reason;
      groupCleanup = child.pid ? terminateGroup(child.pid, this.terminateGraceMs)
        .catch((error) => ({ error: error.message })) : Promise.resolve({ escalated: false, remaining: [] });
    };
    const onSignal = () => stop('runner-interrupted');
    // Attach exit listeners before the first await, including setup/status failures.
    const completion = new Promise((resolve) => {
      child.once('error', (error) => resolve({ exitCode: 127, error: String(error) }));
      child.once('close', (exitCode, signal) => resolve({ exitCode: exitCode ?? 128, signal }));
    });
    const result = { name, attempt, command, args, cwd, startedAt, pid: child.pid, logPath, statusPath, status: 'running' };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    this.signal?.addEventListener('abort', onSignal, { once: true });
    if (this.signal?.aborted) onSignal();
    try {
      await this.statusWriter(statusPath, result);
      timeout = setTimeout(() => stop('timeout'), timeoutMs);
      let checking = false;
      guard = setInterval(async () => {
        if (checking || stopReason || finished) return;
        checking = true;
        try {
          const current = await this.resourceReader(this.root);
          if (current.diskBytes < this.emergencyDiskGiB * GiB) stop('emergency-disk-floor');
        } catch (error) { stop(`resource-check-failed: ${error.message}`); }
        finally { checking = false; }
      }, this.pollMs);
      completed = await completion;
    } catch (error) {
      setupError = error;
      stop('phase-setup-failed');
      completed = await completion;
    } finally {
      clearInterval(guard);
      clearTimeout(timeout);
      // A build shell can fail (or even exit zero) while background descendants still run.
      if (!groupCleanup && child.pid && (await liveGroupMembers(child.pid)).length) stop('descendants-after-child-exit');
      finished = true;
      const groupResult = await groupCleanup;
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      this.signal?.removeEventListener('abort', onSignal);
      await log.close();
      Object.assign(result, completed, {
        status: groupResult?.error ? 'cleanup-failed' : 'finished',
        childExitCode: completed?.exitCode, endedAt: new Date().toISOString(),
        elapsedMs: performance.now() - start, stopReason, groupCleanup: groupResult,
        ...(setupError ? { setupError: setupError.message } : {})
      });
    }
    if (stopReason) result.exitCode = stopReason === 'timeout' ? 124 :
      stopReason === 'descendants-after-child-exit' && completed.exitCode ? completed.exitCode : 125;
    await this.statusWriter(statusPath, result);
    await this.statusWriter(path.join(directory, `${name}.latest.json`), result);
    if (result.exitCode !== 0) {
      const error = new Error(`Phase ${name} failed (${result.exitCode}); see ${statusPath}`);
      error.phase = result;
      throw error;
    }
    return result;
  }
}

export async function recoverInterruptedPhases(root) {
  const directory = path.join(root, 'phases');
  let names;
  try { names = await fs.readdir(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const name of names.filter((name) => name.endsWith('.status.json'))) {
    const file = path.join(directory, name);
    const status = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!['running', 'cleanup-failed'].includes(status.status) || !status.pid) continue;
    const recoveryFile = `${file}.recovery.json`;
    try { await fs.access(recoveryFile); continue; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const remaining = await liveGroupMembers(status.pid);
    if (remaining.length) throw new Error(`Previous phase still has live processes (${remaining.join(',')}): ${file}`);
    // Preserve the original incomplete record; absence of live processes does not prove success.
    await writeState(recoveryFile, { status: 'interrupted', exitCode: null, originalStatus: file,
      checkedAt: new Date().toISOString(), remaining });
  }
}

async function verifyPlan(plan, bytes) {
  if (plan.schemaVersion !== 1 || plan.kind !== 'rust-browser-elf-linker-experiment' ||
      ![1, 2].includes(plan.jobs) || plan.promotion !== 'experiment-only-no-publish') throw new Error('Invalid experiment plan');
  if (Object.entries({ initialDiskGiB: 60, phaseDiskGiB: 12, availableMemoryGiB: 12, emergencyDiskGiB: 4 })
    .some(([key, minimum]) => !Number.isFinite(plan.gates?.[key]) || plan.gates[key] < minimum)) throw new Error('Unsafe resource gates');
  for (const variant of Object.values(plan.variants)) {
    const manifestBytes = await fs.readFile(path.join(variant.root, 'manifest.json'));
    if (sha256(manifestBytes) !== variant.manifestSha256) {
      throw new Error('A prepared manifest changed');
    }
    if (commonBuildFingerprint(JSON.parse(manifestBytes), await fs.readFile(path.join(variant.root, 'scripts/build.sh'), 'utf8')) !== variant.commonFingerprint) {
      throw new Error('Common bootstrap inputs changed');
    }
  }
  if (sha256(await fs.readFile(path.join(plan.out, 'candidate-overlay.patch'))) !== plan.overlaySha256) throw new Error('Candidate overlay changed');
  const snapshot = path.join(plan.out, 'consumer');
  const files = await inventory(snapshot);
  if (sha256(json(files)) !== plan.consumer.sha256) throw new Error('Prepared consumer code changed');
  if (sha256(json(await inventory(plan.runner.root))) !== plan.runner.sha256) throw new Error('Prepared runner changed');
  if (sha256(json(await inventory(plan.consumer.engine.root))) !== plan.consumer.engine.sha256) throw new Error('Pinned Chromium engine changed');
  return sha256(bytes);
}

export async function claimStamps(plan, name, { transition = false } = {}) {
  const ownershipPath = path.join(plan.work, 'stamp-ownership.json');
  const expected = { common: plan.variants[name].commonFingerprint, variant: plan.variants[name].manifestSha256 };
  let actual;
  try { actual = JSON.parse(await fs.readFile(ownershipPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const stampRoot = path.join(plan.work, 'build', 'stamps');
  let stamps = [];
  try { stamps = await fs.readdir(stampRoot); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!actual && stamps.length) throw new Error('Refusing unowned phase stamps');
  if (actual && actual.common !== expected.common) throw new Error('Common bootstrap stamp identity changed');
  if (actual && actual.variant !== expected.variant) {
    if (!transition || actual.variant !== plan.variants.baseline.manifestSha256 || name !== 'candidate' ||
        ['llvm-cross.done', 'rust-stage2.done', 'rust-package.done'].some((stamp) => stamps.includes(stamp))) {
      throw new Error('Phase stamps belong to another variant');
    }
  }
  await writeState(ownershipPath, expected);
}

async function activate(plan, name) {
  const link = path.join(plan.out, 'active-producer');
  const temporary = `${link}.${process.pid}.tmp`;
  await fs.symlink(plan.variants[name].root, temporary);
  await fs.rename(temporary, link);
}

export async function transitionCandidate(plan) {
  const rust = path.join(plan.work, 'patched', 'rust');
  const actual = Object.fromEntries(await Promise.all(Object.keys(plan.sourceFiles.before).map(async (name) =>
    [name, sha256(await fs.readFile(path.join(rust, name)))])));
  const matches = (expected) => Object.keys(actual).every((name) => actual[name] === expected[name]);
  if (matches(plan.sourceFiles.before)) {
    git(rust, ['apply', '--check', path.join(plan.out, 'candidate-overlay.patch')]);
    git(rust, ['apply', '--whitespace=error-all', path.join(plan.out, 'candidate-overlay.patch')]);
  } else if (!matches(plan.sourceFiles.after)) throw new Error('Rust sources are neither the baseline nor the exact candidate');
  const saved = path.join(plan.out, 'baseline', 'phase-stamps');
  await fs.mkdir(saved, { recursive: true });
  for (const name of ['llvm-cross', 'rust-stage2', 'rust-package']) {
    const stamp = `${name}.done`;
    try {
      // A second transition after interruption must not overwrite the retained baseline stamp.
      await fs.access(path.join(saved, stamp));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await fs.rename(path.join(plan.work, 'build', 'stamps', stamp), path.join(saved, stamp));
    }
  }
  await claimStamps(plan, 'candidate', { transition: true });
}

async function nativeProbe(plan, name, runner, env) {
  const base = path.join(plan.work, 'build', 'rust-build', 'x86_64-unknown-linux-gnu');
  let compiler;
  for (const stage of ['stage2', 'stage1']) {
    const file = path.join(base, stage, 'bin', 'rustc');
    try { await fs.access(file); compiler = file; break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!compiler) throw new Error('No matching native bootstrap compiler is available');
  const directory = path.join(plan.out, name, 'native-probe');
  await fs.mkdir(directory, { recursive: true });
  const source = path.join(directory, 'main.rs');
  const binary = path.join(directory, 'main');
  await fs.writeFile(source, 'fn main() { println!("native-elf-ok"); }\n');
  const nativeEnv = { ...env, LD_LIBRARY_PATH: path.join(path.dirname(path.dirname(compiler)), 'lib') };
  await runner.run(`${name}-native-compile`, compiler, [source, '-o', binary], { env: nativeEnv });
  const magic = (await fs.readFile(binary)).subarray(0, 4).toString('hex');
  if (magic !== '7f454c46') throw new Error('Native bootstrap probe did not produce ELF');
  const executed = await runner.run(`${name}-native-execute`, binary, [], { env: nativeEnv });
  if ((await fs.readFile(executed.logPath, 'utf8')) !== 'native-elf-ok\n') throw new Error('Unexpected native ELF output');
  const tools = {};
  for (const tool of ['clang', 'lld', 'llvm-config']) {
    const file = path.join(plan.work, 'build', 'llvm-host-build', 'bin', tool);
    tools[tool] = sha256(await fs.readFile(file));
  }
  await writeState(path.join(plan.out, name, 'native-probe.json'), { compiler, compilerSha256: sha256(await fs.readFile(compiler)), tools });
}

export async function compilerSize(file) {
  const raw = await fs.readFile(file);
  const compressed = {
    raw,
    gzip9: gzipSync(raw, { level: 9, mtime: 0 }),
    brotli5: brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } })
  };
  return Object.fromEntries(Object.entries(compressed).map(([encoding, bytes]) =>
    [encoding, { bytes: bytes.length, sha256: sha256(bytes) }]));
}

export async function compare(plan) {
  const reports = {};
  for (const [name, variant] of Object.entries(plan.variants)) {
    const receipt = JSON.parse(await fs.readFile(path.join(variant.out, 'producer-receipt.json'), 'utf8'));
    const sysroots = receipt.assets.filter((asset) => /^rust\/lib\/rustlib\/wasm32-wasip[123]\/lib\//.test(asset.path));
    reports[name] = {
      manifestSha256: variant.manifestSha256,
      receiptSha256: sha256(await fs.readFile(path.join(variant.out, 'producer-receipt.json'))),
      compiler: await compilerSize(path.join(variant.out, 'rust', 'bin', 'rustc.wasm')),
      targetSysrootsSha256: sha256(json(sysroots)),
      native: JSON.parse(await fs.readFile(path.join(plan.out, name, 'native-probe.json'), 'utf8')),
      browser: JSON.parse(await fs.readFile(path.join(plan.out, name, 'browser-report.json'), 'utf8'))
    };
  }
  const controls = {
    sameNativeLlvmTools: JSON.stringify(reports.baseline.native.tools) === JSON.stringify(reports.candidate.native.tools),
    sameTargetSysroots: reports.baseline.targetSysrootsSha256 === reports.candidate.targetSysrootsSha256,
    sameConsumer: reports.baseline.browser.consumerSha256 === reports.candidate.browser.consumerSha256,
    sameBrowserEngine: reports.baseline.browser.engineSha256 === reports.candidate.browser.engineSha256,
    sameWorkload: reports.baseline.browser.sourceSha256 === reports.candidate.browser.sourceSha256
  };
  const result = { schemaVersion: 1, kind: plan.kind, promotion: plan.promotion, controls,
    comparable: Object.values(controls).every(Boolean), reports,
    compilerBytesChanged: reports.baseline.compiler.raw.sha256 !== reports.candidate.compiler.raw.sha256,
    bytesSaved: Object.fromEntries(Object.keys(reports.baseline.compiler).map((kind) =>
      [kind, reports.baseline.compiler[kind].bytes - reports.candidate.compiler[kind].bytes])) };
  await writeState(path.join(plan.out, 'comparison.json'), result);
  if (!result.comparable) throw new Error('Comparison controls differ; inspect comparison.json before attributing changes to ELF');
  return result;
}

export async function runExperiment(planPath) {
  const bytes = await fs.readFile(planPath);
  const plan = JSON.parse(bytes);
  const planSha256 = await verifyPlan(plan, bytes);
  const statePath = path.join(plan.out, 'state.json');
  let state;
  try { state = JSON.parse(await fs.readFile(statePath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; state = { schemaVersion: 1, planSha256, stage: 'baseline' }; }
  if (state.planSha256 !== planSha256) throw new Error('Cannot resume a different experiment plan');
  if (state.schemaVersion !== 1 || !['baseline', 'baseline-ready', 'candidate', 'compare', 'complete'].includes(state.stage)) throw new Error('Invalid experiment checkpoint');
  await recoverInterruptedPhases(plan.out);
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error('Experiment interrupted'));
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const runner = new PhaseRunner(plan.out, { emergencyDiskGiB: plan.gates.emergencyDiskGiB, signal: controller.signal });
  state.pid = process.pid;
  state.status = 'running';
  const env = { ...process.env, PATH: `${path.dirname(plan.node)}:/usr/bin:/bin:/usr/local/bin`,
    NINJA_JOBS: String(plan.jobs), CARGO_BUILD_JOBS: String(plan.jobs),
    CMAKE_BUILD_PARALLEL_LEVEL: String(plan.jobs), WASM_LLVM_RUST_BROWSER_WORK_DIR: plan.work,
    CARGO_TARGET_DIR: path.join(plan.work, 'cargo-target'), CARGO_BUILD_BUILD_DIR: path.join(plan.work, 'cargo-intermediates'),
    CARGO_HOME: path.join(plan.work, 'cargo-home'),
    TMPDIR: path.join(plan.work, 'tmp'), WASM_LLVM_RUST_BROWSER_RUNNER: 'host' };
  for (const key of ['CC', 'CXX', 'RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'RUSTC', 'RUSTDOC', 'RUSTC_WRAPPER',
    'RUSTC_WORKSPACE_WRAPPER', 'LD_PRELOAD', 'LD_LIBRARY_PATH']) delete env[key];
  for (const directory of [env.CARGO_HOME, env.TMPDIR]) await fs.mkdir(directory, { recursive: true });
  const verify = async (name) => {
    const variant = plan.variants[name];
    await runner.run(`${name}-verify-output`, plan.node, [path.join(variant.root, 'scripts/producer.mjs'),
      'verify-output', '--out-dir', variant.out], { env });
  };
  try {
    if (state.stage === 'baseline') {
      state.resourceGate = await baselineResourceGate(plan);
      assertResources(await resources(plan.work), state.resourceGate);
      await writeState(statePath, state);
    }
    for (const name of ['baseline', 'candidate']) {
      if (name === 'candidate' && state.stage === 'baseline-ready') {
        await verify('baseline');
        await transitionCandidate(plan);
        state.stage = 'candidate';
        await writeState(statePath, state);
      }
      if (state.stage !== name) continue;
      assertResources(await resources(plan.work), { diskGiB: plan.gates.phaseDiskGiB, memoryGiB: plan.gates.availableMemoryGiB });
      const variant = plan.variants[name];
      await claimStamps(plan, name);
      await activate(plan, name);
      await runner.run(`${name}-build`, 'bash', [path.join(plan.out, 'active-producer', 'scripts/build.sh')],
        { env: { ...env, WASM_LLVM_RUST_BROWSER_OUT_DIR: variant.out }, cwd: plan.work });
      await verify(name);
      await nativeProbe(plan, name, runner, env);
      await runner.run(`${name}-browser`, 'flock', [plan.browserLock, plan.node,
        path.join(scriptDir, 'probe-elf-linker-browser.mjs'), '--plan', planPath, '--variant', name], { env, timeoutMs: 30 * 60 * 1000 });
      state.stage = name === 'baseline' ? 'baseline-ready' : 'compare';
      await writeState(statePath, state);
    }
    if (state.stage === 'compare' || state.stage === 'complete') {
      await verify('baseline');
      await verify('candidate');
      await runner.run('comparison', plan.node, [path.join(scriptDir, 'run-elf-linker-experiment.mjs'), '--compare', planPath], { env });
      state.stage = 'complete';
      state.status = 'finished';
      state.exitCode = 0;
      state.finishedAt = new Date().toISOString();
      delete state.failure;
      await writeState(statePath, state);
    }
    return state;
  } catch (error) {
    state.status = 'finished';
    state.exitCode = error.phase?.exitCode || 1;
    state.failure = { message: error.message, phase: error.phase?.statusPath || null, at: new Date().toISOString() };
    await writeState(statePath, state);
    throw error;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const compareOnly = process.argv[2] === '--compare';
  const planPath = path.resolve(process.argv[compareOnly ? 3 : 2] || '');
  // flock survives detached launch and releases on exit, including a killed runner.
  if (compareOnly) {
    try {
      const bytes = await fs.readFile(planPath);
      const plan = JSON.parse(bytes);
      await verifyPlan(plan, bytes);
      console.log(json(await compare(plan)));
    } catch (error) { console.error(error.stack); process.exitCode = 1; }
  } else if (process.env.WASM_RUST_ELF_RUNNER_LOCKED !== planPath) {
    const child = spawn('flock', ['--no-fork', '--nonblock', `${planPath}.lock`, process.execPath, fileURLToPath(import.meta.url), planPath],
      { stdio: 'inherit', env: { ...process.env, WASM_RUST_ELF_RUNNER_LOCKED: planPath } });
    const forward = (signal) => { if (child.pid) child.kill(signal); };
    const interrupt = () => forward('SIGINT');
    const terminate = () => forward('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
    child.on('exit', (code) => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
      process.exitCode = code ?? 1;
    });
  } else {
    try { console.log(json(await runExperiment(planPath))); }
    catch (error) { console.error(error.stack); process.exitCode = error.phase?.exitCode || 1; }
  }
}

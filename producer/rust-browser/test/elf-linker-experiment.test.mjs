import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { bridgePath, buildRsPath, candidateSources, deriveCandidate, experimentBuildScript, git, json, sha256 } from '../scripts/prepare-elf-linker-experiment.mjs';
import { assertResources, baselineDiskRequirement, claimStamps, liveGroupMembers, PhaseRunner, recoverInterruptedPhases, transitionCandidate } from '../scripts/run-elf-linker-experiment.mjs';

const originalBridge = `#include "lld/Common/Driver.h"

LLD_HAS_DRIVER(elf)
LLD_HAS_DRIVER(wasm)

extern "C" int RustRunLld(int argc, char **argv) {
  llvm::ArrayRef<const char *> args(argv, argv + argc);
  auto r = lld::lldMain(
      args, llvm::outs(), llvm::errs(),
      {{lld::Gnu, &lld::elf::link}, {lld::Wasm, &lld::wasm::link}});
  return r.retCode;
}
`;
const originalBuildRs = `fn main() {
    rerun_if_changed_anything_in_dir(Path::new("llvm-wrapper"));
    println!("cargo:rustc-link-lib=static=lldCommon");
    println!("cargo:rustc-link-lib=static=lldELF");
    println!("cargo:rustc-link-lib=static=lldWasm");
}
`;

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rust-elf-experiment-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function fixture(t) {
  const root = await temporary(t);
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  git(source, ['init', '--quiet']);
  for (const [name, bytes] of [[buildRsPath, originalBuildRs], [bridgePath, originalBridge]]) {
    await fs.mkdir(path.dirname(path.join(source, name)), { recursive: true });
    await fs.writeFile(path.join(source, name), bytes);
  }
  git(source, ['add', '.']);
  git(source, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
  const manifest = { commit: git(source, ['rev-parse', 'HEAD']), patchedTree: git(source, ['rev-parse', 'HEAD^{tree}']) };
  return { root, source, manifest };
}

describe('Rust ELF experiment preparation', () => {
  it('keeps the native ELF driver linkable and removes its symbol requirement only with the browser macro', async (t) => {
    const root = await temporary(t);
    const candidate = candidateSources(originalBuildRs, originalBridge);
    await fs.mkdir(path.join(root, 'lld/Common'), { recursive: true });
    await fs.writeFile(path.join(root, 'lld/Common/Driver.h'), `#pragma once
#include <initializer_list>
#include <iostream>
namespace llvm {
template<class T> struct ArrayRef { template<class I> ArrayRef(I, I) {} };
inline int outs() { return 0; } inline int errs() { return 0; }
}
namespace lld {
enum Flavor { Gnu, Wasm };
struct Driver { Flavor flavor; int (*link)(); };
struct Result { int retCode; };
inline Result lldMain(llvm::ArrayRef<const char*>, int, int, std::initializer_list<Driver> drivers) {
  for (auto driver: drivers) std::cout << (driver.flavor == Gnu ? "elf " : "wasm ");
  return {0};
}
}
#define LLD_HAS_DRIVER(name) namespace lld { namespace name { int link(); } }
`);
    await fs.writeFile(path.join(root, 'LLD.cpp'), candidate[bridgePath]);
    await fs.writeFile(path.join(root, 'main.cpp'), `extern "C" int RustRunLld(int, char**);
#ifndef RUST_BROWSER_WASM_ONLY_LLD
namespace lld::elf { int link() { return 0; } }
#endif
namespace lld::wasm { int link() { return 0; } }
int main(int argc, char** argv) { return RustRunLld(argc, argv); }
`);
    for (const [name, flags, expected] of [['native', [], 'elf wasm '], ['browser', ['-DRUST_BROWSER_WASM_ONLY_LLD'], 'wasm ']]) {
      const binary = path.join(root, name);
      execFileSync('c++', ['-std=c++17', '-I', root, ...flags, path.join(root, 'LLD.cpp'), path.join(root, 'main.cpp'), '-o', binary]);
      assert.equal(execFileSync(binary, { encoding: 'utf8' }), expected);
    }
    assert.match(candidate[buildRsPath], /browser_wasm_only_lld = target == "wasm32-wasip1-threads"/);
    assert.match(candidate[buildRsPath], /if !browser_wasm_only_lld \{\n\s+println!\("cargo:rustc-link-lib=static=lldELF"\);/);
  });

  it('derives an applicable full patch and candidate tree without changing the retained source', async (t) => {
    const { root, source, manifest } = await fixture(t);
    const candidate = await deriveCandidate({ source, manifest, scratch: path.join(root, 'objects.git') });
    assert.equal(git(source, ['status', '--porcelain']), '');
    assert.equal(await fs.readFile(path.join(source, bridgePath), 'utf8'), originalBridge);
    const patchFile = path.join(root, 'candidate.patch');
    await fs.writeFile(patchFile, candidate.patch);
    git(source, ['apply', '--check', patchFile]);
    git(source, ['apply', patchFile]);
    git(source, ['add', '.']);
    assert.equal(git(source, ['write-tree']), candidate.tree);
    assert.equal(sha256(await fs.readFile(path.join(source, bridgePath))), candidate.after[bridgePath]);
  });

  it('fails if the pinned LLD recipe drifts and bounds bootstrap as well as Ninja jobs', () => {
    assert.throws(() => candidateSources(originalBuildRs.replace('lldELF', 'changed'), originalBridge), /Expected one pinned input/);
    const input = './x.py build \\\n        --stage 2\n  local targets=(lldCommon lldELF lldWasm LLVMOption)\n';
    assert.match(experimentBuildScript(input, false), /x\.py build -j "\$JOBS"/);
    assert.match(experimentBuildScript(input, false), /targets=\(lldCommon lldELF lldWasm LLVMOption\)/);
    assert.match(experimentBuildScript(input, true), /targets=\(lldCommon lldWasm LLVMOption\)/);
  });
});

describe('Rust ELF durable execution', () => {
  it('records a failed child exit and preserves its log before reporting failure', async (t) => {
    const root = await temporary(t);
    const runner = new PhaseRunner(root);
    await assert.rejects(runner.run('failure', process.execPath, ['-e', 'console.error("fixture failure"); process.exit(7)']), /failed \(7\)/);
    const status = JSON.parse(await fs.readFile(path.join(root, 'phases/failure.latest.json')));
    assert.equal(status.status, 'finished');
    assert.equal(status.exitCode, 7);
    assert.match(await fs.readFile(status.logPath, 'utf8'), /fixture failure/);
    assert.equal((await fs.stat(status.logPath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(status.statusPath)).mode & 0o777, 0o600);
  });

  it('terminates its own process group on timeout and emergency disk floor', async (t) => {
    const root = await temporary(t);
    const timeoutRunner = new PhaseRunner(root);
    await assert.rejects(timeoutRunner.run('timeout', process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 80 }), /failed \(124\)/);
    const diskRunner = new PhaseRunner(root, { pollMs: 20, resourceReader: async () => ({ diskBytes: 0 }) });
    await assert.rejects(diskRunner.run('disk', process.execPath, ['-e', 'setInterval(() => {}, 1000)']), /failed \(125\)/);
    const status = JSON.parse(await fs.readFile(path.join(root, 'phases/disk.latest.json')));
    assert.equal(status.stopReason, 'emergency-disk-floor');
    assert.throws(() => assertResources({ diskBytes: 59 * 1024 ** 3, availableMemoryBytes: 16 * 1024 ** 3 }, { diskGiB: 60, memoryGiB: 12 }), /free disk/);
    assert.throws(() => assertResources({ diskBytes: 80 * 1024 ** 3, availableMemoryBytes: 11 * 1024 ** 3 }, { diskGiB: 60, memoryGiB: 12 }), /available memory/);
    const plan = { gates: { initialDiskGiB: 60, phaseDiskGiB: 12 } };
    assert.equal(baselineDiskRequirement(plan, { verifiedCheckpoint: false, allocatedWorkBytes: 40 * 1024 ** 3 }), 60);
    assert.equal(baselineDiskRequirement(plan, { verifiedCheckpoint: true, allocatedWorkBytes: 25 * 1024 ** 3 }), 35);
    assert.equal(baselineDiskRequirement(plan, { verifiedCheckpoint: true, allocatedWorkBytes: 65 * 1024 ** 3 }), 12);
  });

  it('finishes only after killing a TERM-ignoring descendant whose parent already exited', async (t) => {
    const root = await temporary(t);
    const runner = new PhaseRunner(root, { terminateGraceMs: 100 });
    const code = `const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); console.log("descendant-ready"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);`;
    await assert.rejects(runner.run('descendant', process.execPath, ['-e', code], { timeoutMs: 1200 }), /failed \(124\)/);
    const status = JSON.parse(await fs.readFile(path.join(root, 'phases/descendant.latest.json')));
    assert.match(await fs.readFile(status.logPath, 'utf8'), /descendant-ready/);
    assert.equal(status.groupCleanup.escalated, true);
    assert.deepEqual(status.groupCleanup.remaining, []);
    assert.deepEqual(await liveGroupMembers(status.pid), []);
  });

  it('cleans up descendants when the direct child fails without any timeout or signal', async (t) => {
    const root = await temporary(t);
    const runner = new PhaseRunner(root, { terminateGraceMs: 100 });
    const code = `const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'inherit'] });
child.stdout.once('data', () => process.exit(7));`;
    await assert.rejects(runner.run('early-parent-exit', process.execPath, ['-e', code]), /failed \(7\)/);
    const status = JSON.parse(await fs.readFile(path.join(root, 'phases/early-parent-exit.latest.json')));
    assert.equal(status.stopReason, 'descendants-after-child-exit');
    assert.equal(status.groupCleanup.escalated, true);
    assert.deepEqual(await liveGroupMembers(status.pid), []);
  });

  it('refuses resume while a previously interrupted phase still has live processes', async (t) => {
    const root = await temporary(t);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    const completion = new Promise((resolve) => child.once('exit', resolve));
    t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} });
    const phaseRoot = path.join(root, 'phases');
    await fs.mkdir(phaseRoot);
    const file = path.join(phaseRoot, 'stale.status.json');
    await fs.writeFile(file, json({ pid: child.pid, status: 'running' }));
    await assert.rejects(recoverInterruptedPhases(root), /still has live processes/);
    process.kill(-child.pid, 'SIGKILL');
    await completion;
    await recoverInterruptedPhases(root);
    assert.equal(JSON.parse(await fs.readFile(file)).status, 'running');
    assert.equal(JSON.parse(await fs.readFile(`${file}.recovery.json`)).exitCode, null);
    await recoverInterruptedPhases(root);
  });

  it('cleans up setup failures and observes an abort delivered while status setup is awaiting', async (t) => {
    const root = await temporary(t);
    for (const failure of ['write', 'abort']) {
      const controller = new AbortController();
      const runner = new PhaseRunner(root, { signal: controller.signal, terminateGraceMs: 100,
        statusWriter: async (file, status) => {
          if (status.status === 'running') {
            if (failure === 'write') throw new Error('fixture status write failure');
            controller.abort();
          }
          await fs.writeFile(file, json(status));
        } });
      await assert.rejects(runner.run(`setup-${failure}`, process.execPath, ['-e', 'setInterval(() => {}, 1000)']), /failed \(125\)/);
      const status = JSON.parse(await fs.readFile(path.join(root, `phases/setup-${failure}.latest.json`)));
      assert.deepEqual(await liveGroupMembers(status.pid), []);
      assert.equal(status.stopReason, failure === 'write' ? 'phase-setup-failed' : 'runner-interrupted');
    }
  });

  it('refuses unowned/mismatched stamps and resumes a partially completed candidate transition', async (t) => {
    const { root, source, manifest } = await fixture(t);
    const candidate = await deriveCandidate({ source, manifest, scratch: path.join(root, 'objects.git') });
    const out = path.join(root, 'experiment');
    const work = path.join(out, 'work');
    await fs.mkdir(path.join(work, 'patched'), { recursive: true });
    await fs.symlink(source, path.join(work, 'patched/rust'));
    await fs.writeFile(path.join(out, 'candidate-overlay.patch'), candidate.overlay);
    const plan = { out, work, sourceFiles: { before: candidate.before, after: candidate.after },
      variants: { baseline: { manifestSha256: 'baseline', commonFingerprint: 'same' }, candidate: { manifestSha256: 'candidate', commonFingerprint: 'same' } } };
    const stamps = path.join(work, 'build/stamps');
    await fs.mkdir(stamps, { recursive: true });
    await fs.writeFile(path.join(stamps, 'llvm-host.done'), 'completed');
    await assert.rejects(claimStamps(plan, 'baseline'), /unowned/);
    await fs.rename(path.join(stamps, 'llvm-host.done'), path.join(out, 'unowned-stamp'));
    await claimStamps(plan, 'baseline');
    for (const name of ['llvm-host', 'llvm-cross', 'rust-stage2', 'rust-package']) await fs.writeFile(path.join(stamps, `${name}.done`), name);
    await assert.rejects(claimStamps(plan, 'candidate'), /another variant/);
    // Simulate a crash after source patching and the first stamp archive.
    git(source, ['apply', path.join(out, 'candidate-overlay.patch')]);
    await fs.mkdir(path.join(out, 'baseline/phase-stamps'), { recursive: true });
    await fs.rename(path.join(stamps, 'llvm-cross.done'), path.join(out, 'baseline/phase-stamps/llvm-cross.done'));
    await transitionCandidate(plan);
    await transitionCandidate(plan);
    assert.deepEqual(await fs.readdir(stamps), ['llvm-host.done']);
    assert.deepEqual((await fs.readdir(path.join(out, 'baseline/phase-stamps'))).sort(), ['llvm-cross.done', 'rust-package.done', 'rust-stage2.done']);
    assert.equal(JSON.parse(await fs.readFile(path.join(work, 'stamp-ownership.json'))).variant, 'candidate');
    await claimStamps(plan, 'candidate');
    await assert.rejects(claimStamps(plan, 'baseline'), /another variant/);
    await fs.appendFile(path.join(source, bridgePath), '// unexpected edit\n');
    await assert.rejects(transitionCandidate(plan), /neither the baseline/);
  });
});

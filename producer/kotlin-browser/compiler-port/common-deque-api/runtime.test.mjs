import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test, after } from 'node:test';
import { promisify } from 'node:util';
import { sha256, writeJson } from '../../scripts/source.mjs';
import { verifyDequeRuntime } from './runtime-probe.mjs';

// Run only after the producer exits, before any parallel proof verifier starts.
// Real artifacts are temporarily changed so tests cannot pass solely by rejecting
// a synthetic receipt path. Every byte and mtime is restored even on rejection.
assert(process.env.KOTLIN_DEQUE_RUNTIME_RECEIPT, 'Set KOTLIN_DEQUE_RUNTIME_RECEIPT to a completed real runtime receipt');
assert(process.env.KOTLIN_DEQUE_RUNTIME_MUTATIONS, 'Set KOTLIN_DEQUE_RUNTIME_MUTATIONS to an external result filename');
const receiptFile = path.resolve(process.env.KOTLIN_DEQUE_RUNTIME_RECEIPT);
const output = path.resolve(process.env.KOTLIN_DEQUE_RUNTIME_MUTATIONS);
const receiptBytes = await readFile(receiptFile), original = JSON.parse(receiptBytes);
assert(!output.startsWith(original.outputRoot + path.sep));
const originalStat = await stat(receiptFile, { bigint: true }), changed = new Map(), rejected = [];
const execute = promisify(execFile);
let finalRestored = false;
let authenticPreflightPassed = false;

async function restoreTimes(filename, saved) {
  await execute('python3', ['-c', 'import os,sys;os.utime(sys.argv[1],ns=(int(sys.argv[2]),int(sys.argv[3])))',
    filename, String(saved.atimeNs), String(saved.mtimeNs)]);
  assert.equal((await stat(filename, { bigint: true })).mtimeNs, saved.mtimeNs);
}

async function restore() {
  for (const [filename, saved] of changed) {
    await writeFile(filename, saved.bytes); await restoreTimes(filename, saved.stat);
    assert.deepEqual(await readFile(filename), saved.bytes);
  }
  changed.clear();
  await writeFile(receiptFile, receiptBytes); await restoreTimes(receiptFile, originalStat);
  assert.deepEqual(await readFile(receiptFile), receiptBytes);
}

async function replaceArtifact(receipt, relative, edit) {
  const filename = path.resolve(original.outputRoot, relative);
  assert(filename.startsWith(original.outputRoot + path.sep));
  const bytes = await readFile(filename);
  assert(!changed.has(filename)); changed.set(filename, { bytes, stat: await stat(filename, { bigint: true }) });
  const replacement = Buffer.from(edit(bytes)); await writeFile(filename, replacement);
  const row = receipt.artifacts.find(item => item.path === relative); assert(row);
  // Repair the advertised artifact pin too: rejection must come from the
  // canonical source/fixture/engine contract, not merely a stale file hash.
  row.bytes = replacement.length; row.sha256 = sha256(replacement);
}

async function rejectsMutation(name, mutate) {
  const receipt = structuredClone(original);
  try {
    await mutate(receipt);
    await writeFile(receiptFile, JSON.stringify(receipt, null, 2) + '\n');
    await assert.rejects(verifyDequeRuntime(receiptFile), error => error.code === 'ERR_ASSERTION', name);
    rejected.push(name);
  } finally { await restore(); }
}

describe('completed real compiler deque runtime evidence', { concurrency: false }, () => {
  test('reopens the authentic complete source, commands and both engines', async () => {
    const result = await verifyDequeRuntime(receiptFile);
    assert.deepEqual({ sources: result.sources, nodeCases: result.nodeCases, chromiumCases: result.chromiumCases },
      { sources: 10, nodeCases: 16, chromiumCases: 16 });
    const diagnostics = [];
    for (const variant of ['original', 'common']) {
      const stderr = await readFile(path.join(original.outputRoot, 'logs', 'invalid-generic-' + variant + '-source.stderr'), 'utf8');
      // Class-origin records are launcher metadata, not compiler diagnostics.
      diagnostics.push(stderr.split('\n').filter(line => !line.startsWith('DEQUE_ORIGIN\t')).join('\n'));
    }
    assert.equal(diagnostics[0], diagnostics[1], 'Invalid user program must retain the exact official compiler diagnostics');
    authenticPreflightPassed = true;
  });
  test('rejects changing the common frontend to the original overlay', async () => {
    await rejectsMutation('common-frontend-replaced-with-original', receipt => {
      const command = receipt.commands.find(row => row.phase === 'diamond-generics-common-source').command;
      const cp = command.indexOf('-cp') + 1;
      command[cp] = command[cp].replace(path.join(receipt.outputRoot, 'common.jar'), path.join(receipt.outputRoot, 'original.jar'));
      const launcher = command.indexOf('org.jetbrains.kotlin.portable.deque.runtime.RuntimeCompilerLauncherKt');
      command[launcher + 1] = path.join(receipt.outputRoot, 'original.jar');
    });
  });
  test('rejects removing a complete changed compiler source', async () => {
    await rejectsMutation('changed-compiler-source-omitted', receipt => { receipt.originalSources.splice(0, 1); });
  });
  test('rejects a rehashed replacement user program', async () => {
    await rejectsMutation('fixture-replaced-with-precomputed-output', receipt => replaceArtifact(receipt,
      'fixtures/diamond-generics/source/Main.kt', () => 'fun main() { println("leaf"); println("1|2.5") }\n'));
  });
  test('rejects whitespace-normalized output even with a matching artifact hash', async () => {
    await rejectsMutation('node-output-normalized', receipt => replaceArtifact(receipt, 'node.json', bytes => {
      const observation = JSON.parse(bytes);
      observation.results.find(row => row.id === 'diamond-generics/common').result.stdout = 'leaf\n1|2.5';
      return JSON.stringify(observation, null, 2) + '\n';
    }));
  });
  test('rejects dropping a Chromium execution even with a matching artifact hash', async () => {
    await rejectsMutation('chromium-case-omitted', receipt => replaceArtifact(receipt, 'chromium.json', bytes => {
      const observation = JSON.parse(bytes); observation.results.pop(); return JSON.stringify(observation, null, 2) + '\n';
    }));
  });
  test('rejects presenting the JVM observation as browser compilation', async () => {
    await rejectsMutation('false-browser-compiler-readiness', receipt => { receipt.browserKotlinCompilation = true; });
  });
  test('restores and reopens the entire authentic result after mutations', async () => {
    await restore(); await verifyDequeRuntime(receiptFile); finalRestored = true;
  });
});

after(async () => {
  await restore();
  await writeJson(output, { kind: 'actual-deque-runtime-evidence-mutations', result: authenticPreflightPassed && finalRestored && rejected.length === 6 ? 'pass' : 'fail',
    receipt: { filename: receiptFile, bytes: receiptBytes.length, sha256: sha256(receiptBytes) },
    rejected, rejectedCount: rejected.length, sourceAndArtifactBytesRestored: changed.size === 0,
    finalAuthenticVerificationPassed: finalRestored, invalidProgramDiagnosticsEqual: authenticPreflightPassed,
    completeCompilerFiles: 10, nodeCases: 16, chromiumCases: 16 });
});

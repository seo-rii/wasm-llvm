import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256 } from '../../scripts/source.mjs';
import { verifyMainRuntime } from './runtime-probe.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
test('completed actual runtime receipt rejects omitted, duplicate and altered evidence', async t => {
  const receiptFile = process.env.OFFICIAL_MAIN_RUNTIME_RECEIPT;
  assert(receiptFile, 'Set OFFICIAL_MAIN_RUNTIME_RECEIPT to the completed runtime-receipt.json');
  const bytes = await readRegular(receiptFile, 32 * 1024 * 1024), original = JSON.parse(bytes);
  const verified = await verifyMainRuntime(receiptFile);
  await mkdir(path.join(repository, 'out'), { recursive: true });
  const outputRoot = await mkdtemp(path.join(repository, 'out/entry-runtime-v-integrity-'));
  const cases = [];
  const mutations = [
    ['missing case', row => row.cases.pop()],
    ['duplicate case', row => { row.cases[1] = structuredClone(row.cases[0]); }],
    ['extra case', row => row.cases.push(structuredClone(row.cases[0]))],
    ['reordered cases', row => { [row.cases[0], row.cases[1]] = [row.cases[1], row.cases[0]]; }],
    ['variant changed', row => { row.cases[0].variant = 'pinned-overlay'; }],
    ['stdin changed', row => { row.cases.at(-1).stdin.push(10); }],
    ['missing input pin', row => row.inputPins.pop()],
    ['duplicate input pin', row => row.inputPins.push(structuredClone(row.inputPins[0]))],
    ['extra input pin', row => row.inputPins.push({ filename: fileURLToPath(import.meta.url), bytes: 0, sha256: '0'.repeat(64) })],
    ['missing class origin', row => row.classOrigins[0].rows.pop()],
    ['duplicate class origin', row => { row.classOrigins[0].rows[1] = structuredClone(row.classOrigins[0].rows[0]); }],
    ['extra class origin', row => row.classOrigins[0].rows.push(structuredClone(row.classOrigins[0].rows[0]))],
    ['bootstrap fallback origin', row => { row.classOrigins[0].rows[0].filename = row.compiler.artifacts.find(pin => pin.id === 'compiler').path; }],
    ['omitted artifact', row => row.artifacts.pop()],
    ['duplicate artifact', row => row.artifacts.push(structuredClone(row.artifacts[0]))],
    ['different complete source snapshot', row => { row.originals[0].snapshot = row.originals[1].snapshot; }],
    ['changed original identity', row => { row.originals[0].original.sha256 = '0'.repeat(64); }],
    ['extra overlay source argument', row => row.commands[0].command.push(row.commands[0].command.at(-1))],
    ['missing compiler phase', row => row.commands.splice(2, 1)],
    ['node execution bypass', row => { row.commands.at(-1).command = ['true']; }],
    ['wrong compiler cwd', row => { row.commands[1].cwd = '/tmp'; }],
    ['different phase log', row => { row.commands[1].stderr = row.commands[0].stderr; }],
    ['compiled fixture claim changed', row => { row.compiled[0].generatedProgram = false; }],
    ['consumer file omitted', row => row.consumerFiles.pop()],
    ['consumer source identity changed', row => { row.consumerFiles[0].sha256 = '0'.repeat(64); }],
    ['consumer generated identity changed', row => { row.consumerFiles[0].generated.sha256 = '0'.repeat(64); }],
    ['stdlib metadata disconnected from input', row => { row.stdlib.filename = row.compiler.artifacts.find(pin => pin.id === 'stdlib-wasi').path; }],
    ['browser metadata disconnected from artifact', row => { row.browser.version = 'invented-version'; }],
    ['full browser compiler claim rejected', row => { row.browserKotlinCompilation = true; }],
    ['full FIR Wasm claim rejected', row => { row.fullFirToIrWasmExecuted = true; }],
    ['public language claim rejected', row => { row.publicLanguageSupport = true; }],
    ['unqualified comparison claim', row => { row.comparison.rawOverlayEqualsBootstrap = false; }],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      const changed = structuredClone(original); mutate(changed);
      const filename = path.join(outputRoot, 'case-' + cases.length + '.json');
      await writeFile(filename, JSON.stringify(changed, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      await assert.rejects(() => verifyMainRuntime(filename)); cases.push({ name, rejected: true });
    });
  }
  assert.deepEqual(await readRegular(receiptFile, 32 * 1024 * 1024), bytes);
  await verifyMainRuntime(receiptFile);
  const report = { kind: 'official-main-actual-runtime-integrity-guards', result: 'pass', cases,
    completedReceipt: { filename: receiptFile, bytes: bytes.length, sha256: sha256(bytes) },
    actualInputsAndArtifactsReopened: verified, originalEvidenceUnmodified: true };
  const output = path.join(outputRoot, 'guards.json');
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ guardReceipt: output, rejected: cases.length }));
});

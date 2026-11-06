import assert from 'node:assert/strict';
import path from 'node:path';
import { readRegular, sha256 } from '../../scripts/source.mjs';
import { ENTRY, TARGETS, HELPERS } from './transform.mjs';

/** Compare messages by authenticated logical source; transformed line numbers differ. */
export async function compareDiagnostics(currentBuild, currentLog, baselineBuild, baselineLog) {
  async function read(build, log) {
    const receiptFile = path.join(build, 'compiler-build-receipt.json');
    const receiptBytes = await readRegular(receiptFile, 96 * 1024 * 1024), receipt = JSON.parse(receiptBytes);
    const argsFile = path.join(build, 'compiler-klib.args'), argsBytes = await readRegular(argsFile, 16 * 1024 * 1024);
    const command = receipt.commands.find(row => row.phase === 'official-compiler-source-to-wasmjs-klib');
    assert(command, 'Cannot compare diagnostics from a preparation-only failure');
    assert.equal(command.argumentFileSha256, sha256(argsBytes));
    const args = argsBytes.toString().trimEnd().split('\n').map(JSON.parse);
    const filenames = args.slice(-receipt.compileSources.length);
    const owners = new Map(receipt.compileSources.map((row, index) => [filenames[index], row.path]));
    const logBytes = await readRegular(log, 64 * 1024 * 1024), entries = [];
    for (const line of logBytes.toString().split(/\r?\n/)) {
      const match = /^(.*?):(\d+):(\d+): error: (.*)$/.exec(line);
      if (!match) continue;
      const owner = owners.get(path.resolve(build, match[1]));
      entries.push({ source: owner ?? match[1], line: Number(match[2]), column: Number(match[3]), message: match[4] });
    }
    const pin = (filename, bytes) => ({ filename, bytes: bytes.length, sha256: sha256(bytes) });
    return { entries, inputs: [pin(receiptFile, receiptBytes), pin(argsFile, argsBytes), pin(log, logBytes)] };
  }
  const current = await read(currentBuild, currentLog), baseline = await read(baselineBuild, baselineLog);
  const targets = new Set([...TARGETS, ...HELPERS]);
  const prior = new Map();
  for (const row of baseline.entries.filter(row => targets.has(row.source))) {
    const key = JSON.stringify([row.source, row.message]);
    prior.set(key, (prior.get(key) ?? 0) + 1);
  }
  const newProfileDiagnosticEntries = [];
  for (const row of current.entries.filter(row => targets.has(row.source))) {
    const key = JSON.stringify([row.source, row.message]);
    if (prior.get(key)) prior.set(key, prior.get(key) - 1);
    else newProfileDiagnosticEntries.push(row);
  }
  const otherPrior = new Map(), newOtherDiagnosticEntries = [];
  for (const row of baseline.entries.filter(row => !targets.has(row.source))) {
    const key = JSON.stringify([row.source, row.message]);
    otherPrior.set(key, (otherPrior.get(key) ?? 0) + 1);
  }
  for (const row of current.entries.filter(row => !targets.has(row.source))) {
    const key = JSON.stringify([row.source, row.message]);
    if (otherPrior.get(key)) otherPrior.set(key, otherPrior.get(key) - 1);
    else newOtherDiagnosticEntries.push(row);
    if (/\b(?:compilerExceptionHost|withCompilerExceptionHost|CompilerExceptionHost)\b/.test(row.message))
      newProfileDiagnosticEntries.push(row);
  }
  return { kind: 'compiler-exception-logical-diagnostic-comparison',
    currentBuild, currentLog, baselineBuild, baselineLog, inputs: [...baseline.inputs, ...current.inputs],
    baselineTotal: baseline.entries.length, currentTotal: current.entries.length,
    baselineProfileEntries: baseline.entries.filter(row => targets.has(row.source)),
    currentProfileEntries: current.entries.filter(row => targets.has(row.source)),
    newProfileDiagnosticEntries, newOtherDiagnosticEntries, requestEntry: ENTRY,
    interpretation: 'Cascading messages are not independent bugs. Equality of remaining messages does not establish whole compiler correctness.' };
}

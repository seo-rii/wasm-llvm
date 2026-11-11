import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular } from '../../scripts/source.mjs';
import { inspectCompletedDequeEvidence } from './verify.mjs';

async function fresh(filename, bytes) {
  await assertNoSymlink(filename);
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
}

export async function sealDequeEvidence(configuration) {
  const result = await inspectCompletedDequeEvidence(configuration);
  await fresh(result.evidence.diagnostics.filename, result.diagnosticsBytes);
  await fresh(result.evidence.configuration.evidenceFile, JSON.stringify(result.evidence, null, 2) + '\n');
  return { result: 'pass', evidenceFile: result.evidence.configuration.evidenceFile,
    diagnosticsFile: result.evidence.diagnostics.filename, compiler: result.evidence.compiler,
    diagnosticComparison: result.evidence.diagnosticComparison, runtime: result.evidence.runtime,
    fullCompilerBuilt: false, browserKotlinCompilation: false, publicLanguageSupport: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3, 'Pass the completed whole-build/runtime evidence configuration');
  console.log(JSON.stringify(await sealDequeEvidence(JSON.parse(await readRegular(path.resolve(process.argv[2]))))));
}

import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256 } from '../../scripts/source.mjs';
import { compareMainDiagnostics } from './diagnostics.mjs';
import { verifyMainEvidence } from './verify.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
async function pin(filename) {
  filename = path.resolve(filename);
  const bytes = await readRegular(filename, 128 * 1024 * 1024);
  return { filename, bytes: bytes.length, sha256: sha256(bytes) };
}
async function record(value) {
  return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([name, file]) => [name, await pin(file)])));
}
async function fresh(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await writeFile(filename, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

export async function sealMainEvidence(configuration) {
  const previousFile = path.join(here, '../fir-tower-mode-map/evidence/current-foundation-v1.json');
  const previous = JSON.parse(await readRegular(previousFile));
  const job = JSON.parse(await readRegular(configuration.wholeJob));
  assert.equal(job.cwd, repository);
  const buildRoot = path.resolve(configuration.buildRoot);
  const build = { snapshotRoot: repository, buildRoot,
    receipt: await pin(path.join(buildRoot, 'compiler-build-receipt.json')),
    status: await pin(job.status), log: await pin(configuration.wholeLog) };
  const diagnostics = await compareMainDiagnostics(buildRoot, build.log.filename,
    previous.build.buildRoot, previous.build.log.filename);
  await fresh(configuration.diagnosticsFile, diagnostics);
  const shippingNames = (await readdir(here)).filter(name => /\.(mjs|json|kt)$/.test(name));
  shippingNames.push('../build.mjs', '../fir-lighttree-psi-views/verify.mjs',
    '../fir-lighttree-psi-views/fixture.mjs',
    '../native-js-output-profile/phase-boundary.mjs', '../native-js-output-profile/update-recipe.mjs',
    '../native-js-output-profile/sources.lock.json');
  const evidence = {
    schemaVersion: 1, kind: 'official-main-entry-current-foundation-v1', result: 'pass',
    sourceLock: await pin(path.join(here, 'sources.lock.json')),
    baselineQualification: await pin(previousFile), baseline: previous.build, build,
    frozenInputs: await pin(configuration.wholeJob),
    shippingInputs: await Promise.all(shippingNames.sort().map(name => pin(path.resolve(here, name)))),
    runtime: await record(configuration.runtime),
    runtimeIntegrity: await record(configuration.runtimeIntegrity),
    checks: [
      { kind: 'source', ...await record(configuration.sourceChecks) },
      { kind: 'diagnostics', ...await record(configuration.diagnosticChecks) },
    ],
    diagnostics: await pin(configuration.diagnosticsFile),
    validationScope: 'One complete production entry replacement in the actual 3571-source compiler; full pinned main detector/wrapper JVM overlay produces real programs for the unchanged Node/Chromium consumer; all 1250 compiler diagnostics preserved exactly',
    fullCompilerBuilt: false, browserKotlinCompilation: false, wholeFirResolutionExecuted: false, publicLanguageSupport: false,
  };
  const result = await verifyMainEvidence(evidence);
  await fresh(configuration.evidenceFile, evidence);
  return { result: result.result, evidenceFile: configuration.evidenceFile,
    compilerComparison: result.compilerComparison, sourceInventoryFiles: result.sourceInventoryFiles,
    baselineDiagnostics: diagnostics.baselineTotal, currentDiagnostics: diagnostics.currentTotal,
    currentTargetDiagnostics: diagnostics.currentProfileEntries.length, runtimeCases: result.runtime.cases,
    fullCompilerBuilt: false, publicLanguageSupport: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3, 'Pass the completed whole/runtime/check configuration');
  console.log(JSON.stringify(await sealMainEvidence(JSON.parse(await readRegular(path.resolve(process.argv[2]))))));
}

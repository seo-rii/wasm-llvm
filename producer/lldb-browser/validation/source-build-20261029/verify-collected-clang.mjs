import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(process.argv[2] || path.join(here, '../../..'));
const qualificationCommit = 'ff18b37c934f7526885f5a49d77698712615f23a';
const debuggerCommit = '7bd1d38d61c6602fd05260f04af979abbfdc8e0f';
const workflowRun = 40811368673;
const jobId = 123242404833;
const expectedArchive = { id: 12878926055, bytes: 43274481,
  digest: 'sha256:7946033ebff4d384c51750d7140ed7b63b9860783808d611d39e17e0900e8aa3' };
const collected = path.resolve(process.argv[3] || path.join(here, `../clang-${workflowRun}`));
const expectedSourceFile = path.resolve(process.argv[4] || path.join(here, 'expected-clang-inputs.json'));
const products = path.join(collected, 'products');
const producer = path.join(source, 'producer/clang-browser');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
const json = async filename => JSON.parse(await fs.readFile(filename, 'utf8'));

assert.equal(git('rev-parse', 'HEAD'), qualificationCommit);
assert.equal(git('status', '--porcelain', '--', 'producer/clang-browser'), '');
const producerTree = git('rev-parse', `${qualificationCommit}:producer/clang-browser`);
assert.equal(git('diff', '--name-only', debuggerCommit, qualificationCommit, '--',
  'producer/clang-browser/manifest.json', 'producer/clang-browser/patches',
  'producer/lldb-browser', 'producer/wamr-browser'), '');
const collectedMetadata = await json(path.join(collected, 'collected.json'));
assert.equal(collectedMetadata.component, 'clang');
assert.equal(collectedMetadata.source, qualificationCommit);
assert.equal(collectedMetadata.workflowRun, workflowRun);
const artifact = await json(path.join(collected, 'github-artifact.json'));
assert.equal(artifact.id, collectedMetadata.artifactId);
assert.equal(artifact.digest, collectedMetadata.artifactDigest);
assert.deepEqual({ id: artifact.id, bytes: artifact.size_in_bytes, digest: artifact.digest }, expectedArchive);
assert.equal(artifact.expired, false);
assert.equal(artifact.name, `clang-browser-${qualificationCommit}`);
assert.equal(artifact.workflow_run.head_sha, qualificationCommit);
assert.equal(artifact.workflow_run.id, workflowRun);
assert.equal(artifact.workflow_run.head_branch, 'perf/lldb-module-api-20261023');
const sourceBuild = await json(path.join(collected, 'github-source-build.json'));
assert.equal(sourceBuild.run.id, workflowRun);
assert.equal(sourceBuild.run.head_sha, qualificationCommit);
assert.equal(sourceBuild.run.event, 'workflow_dispatch');
assert.equal(sourceBuild.run.path, '.github/workflows/lldb-browser.yml');
assert.equal(sourceBuild.run.repository.full_name, 'seo-rii/wasm-llvm');
assert.equal(sourceBuild.run.head_repository.full_name, 'seo-rii/wasm-llvm');
const buildJob = sourceBuild.jobs.jobs.find(job => job.id === jobId);
assert.equal(buildJob?.name, 'build-clang');
assert.equal(buildJob.status, 'completed');
assert.equal(buildJob.conclusion, 'success');
assert.equal(buildJob.head_sha, qualificationCommit);
for (const step of ['Build all pinned Clang producer outputs', 'Verify current build receipts and all packaged Wasm assets']) {
  const found = buildJob.steps.filter(value => value.name === step);
  assert.equal(found.length, 1);
  assert.equal(found[0].conclusion, 'success');
}
const prerequisites = sourceBuild.jobs.jobs.filter(job => job.name === 'producer-contracts');
assert.equal(prerequisites.length, 1);
assert.equal(prerequisites[0].conclusion, 'success');
assert.equal(prerequisites[0].head_sha, qualificationCommit);
const archive = await fs.readFile(path.join(collected, 'source-build.zip'));
assert.equal(archive.byteLength, artifact.size_in_bytes);
assert.equal(`sha256:${hash(archive)}`, artifact.digest);

const { loadVerifiedClangArtifacts } = await import(pathToFileURL(path.join(producer, 'scripts/verify-artifacts.mjs')));
const verified = await loadVerifiedClangArtifacts(products, { requireBuildReceipt: true });
assert.equal(verified.manifestCompatibility, 'current');
assert.equal(verified.metadata.buildProvenance.status, 'verified');
const manifestBytes = await fs.readFile(path.join(producer, 'manifest.json'));
const manifest = JSON.parse(manifestBytes);
assert.equal(hash(manifestBytes), 'de99e0be692a813c854edf8f42606f35226c285b567b246c617a1cecc74c62d9');
const receiptBytes = await fs.readFile(path.join(products, 'clang-build-receipt.json'));
const receipt = JSON.parse(receiptBytes);
for (const name of ['emsdkPython', 'emsdkPythonWrapper']) {
  assert(receipt.tools[name].bytes > 0);
  assert.match(receipt.tools[name].sha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.tools[name].version, /^Python 3\./);
}
assert.equal(receipt.tools.emsdkPythonWrapper.version, receipt.tools.emsdkPython.version);
const expectedSourceBytes = await fs.readFile(expectedSourceFile);
const expectedSource = JSON.parse(expectedSourceBytes);
assert.equal(expectedSource.qualificationCommit, qualificationCommit);
assert.equal(expectedSource.manifestSha256, hash(manifestBytes));
for (const key of ['repository', 'commit', 'tree', 'diffSha256', 'patches'])
  assert.deepEqual(receipt.sources.llvm[key], expectedSource[key]);
assert.equal(receipt.manifestSha256, hash(manifestBytes));
assert.equal(receipt.sources.llvm.commit, manifest.sources.llvm.commit);
assert.equal(receipt.sources.emsdk.commit, manifest.toolchains.emsdk.commit);
assert.equal(receipt.buildOptions.llvmVersion, manifest.sources.llvm.version);
assert.equal(receipt.buildOptions.wasiSdkVersion, manifest.toolchains.wasiSdk.version);
assert.equal(receipt.buildOptions.emsdkVersion, manifest.toolchains.emsdk.version);
assert.equal(receipt.buildOptions.yowaspWasiPatchRepo, manifest.sources.wasiHostPatch.repository);
assert.equal(receipt.buildOptions.yowaspWasiPatchCommit, manifest.sources.wasiHostPatch.commit);
for (const key of ['llvmWasiClosePatch', 'lldWasmOnlyPatch', 'clangdEmscriptenStdinPatch', 'wasmFunctionEndPatch']) {
  const expected = manifest.sources[key];
  assert.equal(hash(await fs.readFile(path.join(producer, expected.path))), expected.sha256);
  assert.deepEqual(receipt.sources.llvm.patches.find(patch => patch.path === expected.path), expected);
}
const files = {};
for (const [name, bytes] of [...verified.files, ...verified.sidecars])
  files[name] = { bytes: bytes.byteLength, sha256: hash(bytes) };
files['toolchain.json'] = { bytes: (await fs.stat(path.join(products, 'toolchain.json'))).size,
  sha256: hash(await fs.readFile(path.join(products, 'toolchain.json'))) };
const delivered = [];
async function visit(directory, relative = '') {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    assert(!entry.isSymbolicLink(), `Unexpected artifact symlink: ${name}`);
    if (entry.isDirectory()) await visit(path.join(directory, entry.name), name);
    else { assert(entry.isFile()); delivered.push(name); }
  }
}
await visit(products);
assert.deepEqual(delivered.sort(), Object.keys(files).sort());
const result = {
  schemaVersion: 1, kind: 'clang-source-build-evidence-verification', passed: true,
  checkedAt: new Date().toISOString(), qualificationCommit, combinedCommit: qualificationCommit,
  debuggerCommit, producerTree, workflowRun, jobId, archive: expectedArchive,
  physicalProducts: await fs.realpath(products), manifestSha256: hash(manifestBytes),
  receiptSha256: hash(receiptBytes), independentlyReconstructedInputsSha256: hash(expectedSourceBytes),
  checks: ['authenticated GitHub archive digest and source identity',
    'LLVM patch manifest and patches, LLDB producer and WAMR producer unchanged from the independently qualified debugger source',
    'current producer manifest and complete packaged asset hashes',
    'verified source-to-output receipt with exact recipe hashes',
    'pinned LLVM, YoWASP, Emsdk and WASI SDK identities',
    'LLVM patched Git tree and binary diff independently reconstructed from pinned Git objects, five patches and the WASI signal stub',
    'four local patch digests checked against actual source files',
    'fresh output directory and recorded installed SDK trees',
    'real Python interpreter and bytecode-disabled wrapper executable identities recorded',
    'compiler, linker, clangd WebAssembly contracts, ZIP and sysroot TAR structure',
    'MemFS receipt, source identity and license sidecars'],
  limits: ['Independent input reconstruction does not claim an independent compiler-output rebuild.',
    'Host SDK trees and tool executables were checked by the authenticated successful build; only their receipt identities are available locally.'],
  sources: receipt.sources, installedToolchains: receipt.installedToolchains, files
};
const resultFile = path.join(collected, 'clang-evidence-verification.json');
await fs.writeFile(resultFile, JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ passed: result.passed, resultFile, products: result.physicalProducts,
  manifestSha256: result.manifestSha256, receiptSha256: result.receiptSha256, files: Object.keys(files).length }));

import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readRegular, assertNoSymlink, sha256, writeJson } from '../../scripts/source.mjs';
import { BASELINE_COMMIT, FOUNDATION_COMMIT, projectBaselineBuild, authenticateBaselineVariant } from './baseline-variant.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..');
const [snapshot, evidence] = process.argv.slice(2);
assert(snapshot && evidence, 'Usage: prepare-baseline-variant.mjs SEPARATE_SNAPSHOT_ROOT NEW_EVIDENCE_DIRECTORY');
const root = path.resolve(snapshot), output = path.resolve(evidence);
assert.notEqual(root, repository, 'The validation inverse must never modify the shipping checkout');
assert(output.startsWith(path.join(root, 'out') + path.sep));
await assertNoSymlink(root);
await assertNoSymlink(output);
const relative = 'producer/kotlin-browser/compiler-port/build.mjs';
const filename = path.join(root, relative), shipping = (await readRegular(path.join(repository, relative))).toString();
assert.equal((await readRegular(filename)).toString(), shipping, 'Start with an exact separate shipping source snapshot');
const original = commit => execFileSync('git', ['show', commit + ':' + relative],
  { cwd: repository, encoding: 'utf8', maxBuffer: 1024 * 1024 });
const baseline = original(BASELINE_COMMIT), foundation = original(FOUNDATION_COMMIT), variant = projectBaselineBuild(shipping);
const proof = authenticateBaselineVariant({ baseline, foundation, shipping, variant });
await mkdir(output, { mode: 0o700 });
async function preserve(name, source) {
  const filename = path.join(output, name + '-build.mjs'), bytes = Buffer.from(source);
  await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
  return { filename, bytes: bytes.length, sha256: sha256(bytes) };
}
await writeJson(path.join(output, 'projection.json'), { ...proof,
  baseline: await preserve('baseline', baseline), foundation: await preserve('foundation', foundation) });
await writeFile(filename, variant);
console.log(JSON.stringify({ status: 'prepared-validation-only', snapshotRoot: root,
  projection: path.join(output, 'projection.json'), ...proof }));

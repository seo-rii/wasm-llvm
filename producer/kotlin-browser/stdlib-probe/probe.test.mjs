import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { HERE, loadRecipe } from './prepare.mjs';
import { fragmentArguments, versionGenerator } from './build.mjs';
import { validateTargetReceipt } from './baseline.mjs';
import { readJson, readRegular, sha256 } from '../scripts/source.mjs';

test('complete stdlib inventory retains both WASI parents and excludes the JS branch', async () => {
  const recipe = await loadRecipe();
  const sources = recipe.files.filter((pin) => ['compile', 'builtin-copy'].includes(pin.kind))
    .map((pin) => ({ sourceSet: pin.sourceSet, filename: '/verified/' + (pin.generatedPath ?? pin.path) }));
  assert.equal(sources.length, 501);
  const args = fragmentArguments(recipe, sources);
  assert.ok(args.includes('-Xfragment-refines=wasmWasiMain:wasmCommonMain'));
  assert.ok(args.includes('-Xfragment-refines=wasmWasiMain:nativeWasmWasiMain'));
  assert.equal(args.filter((argument) => argument.startsWith('-Xfragment-sources=')).length, 501);
  assert.ok(!sources.some((source) => source.filename.includes('/wasm/js/') || source.filename.includes('/common-js-wasmjs/')));
});

test('stdlib recipe fails closed on changed fragment ownership and semantic bypasses', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kotlin-stdlib-recipe-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const recipe = await loadRecipe();
  const reject = async (edit, message) => {
    const changed = structuredClone(recipe);
    edit(changed);
    await writeFile(path.join(directory, 'recipe.json'), JSON.stringify(changed));
    await assert.rejects(loadRecipe(directory), message);
  };
  await reject((value) => { value.fragments.at(-1).refines.pop(); }, /fragment parents/);
  await reject((value) => { value.fragments.at(-1).roots.push('wasm/js/src'); }, /fragment roots/);
  await reject((value) => { value.files.find((pin) => pin.kind === 'compile').sourceSet = 'wasmJsMain'; }, /outside its declared/);
  await reject((value) => { value.files[1] = value.files[0]; }, /Duplicate/);
  await reject((value) => { value.flags.push('-Xwasm-use-traps-instead-of-exceptions'); }, /semantic bypass/);
  await reject((value) => { value.flags = value.flags.filter((flag) => flag !== '-Werror'); }, /semantic bypass/);
  await reject((value) => { value.source.commit = 'a'.repeat(40); }, /source recipe/);
});

test('target receipt rejects mixed source, patch, generator and compiler provenance', async () => {
  const recipe = await loadRecipe();
  const recipeHash = sha256(await readRegular(path.join(HERE, 'recipe.json')));
  const receipt = await readJson(path.join(HERE, '..', 'evidence', 'stdlib-source-build.json'));
  assert.doesNotThrow(() => validateTargetReceipt(receipt, recipe, recipeHash));
  for (const edit of [
    (value) => { value.stdlib.sourceCommit = 'a'.repeat(40); },
    (value) => { value.stdlib.patched = false; },
    (value) => { value.stdlib.path = '../old.klib'; },
    (value) => { value.compiler.sourceCommit = recipe.source.commit; },
    (value) => { value.versionGeneration.unchangedOfficialLogicExecution = 'not-run'; },
    (value) => { value.recipeSha256 = '0'.repeat(64); },
    (value) => { value.publicLanguageSupport = true; }
  ]) {
    const changed = structuredClone(receipt);
    edit(changed);
    assert.throws(() => validateTargetReceipt(changed, recipe, recipeHash), /identity mismatch|POSIX relative path/);
  }
});

test('version adapter preserves extracted function and task body and rejects changed boundaries', () => {
  const source = `header
    fun Task.replaceVersion(versionFile: File) { println("preserved") }
    doLast {
        replaceVersion(versionFile) { "original body" }
    }
}

val writePluginVersion = task
`;
  const generated = versionGenerator(source);
  assert.equal(generated.functionText, '    fun Task.replaceVersion(versionFile: File) { println("preserved") }');
  assert.equal(generated.executionText, '        replaceVersion(versionFile) { "original body" }');
  assert.ok(generated.harness.includes(generated.functionText));
  assert.ok(generated.harness.includes(generated.executionText));
  assert.throws(() => versionGenerator(source.replace('doLast', 'altered')), /extraction boundary/);
});

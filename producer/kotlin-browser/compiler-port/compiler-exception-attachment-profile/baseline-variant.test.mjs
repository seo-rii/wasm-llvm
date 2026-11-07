import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BASELINE_COMMIT, FOUNDATION_COMMIT, projectBaselineBuild, authenticateBaselineVariant } from './baseline-variant.mjs';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const filename = 'producer/kotlin-browser/compiler-port/build.mjs';
const revision = commit => execFileSync('git', ['show', commit + ':' + filename],
  { cwd: repository, encoding: 'utf8', maxBuffer: 1024 * 1024 });
const baseline = revision(BASELINE_COMMIT), foundation = revision(FOUNDATION_COMMIT);
const shipping = readFileSync(new URL('../build.mjs', import.meta.url), 'utf8');
const inputs = { baseline, foundation, shipping, variant: projectBaselineBuild(shipping) };

test('three-region inverse preserves all exception delta and reconstructs the authentic baseline', () => {
  assert.equal(projectBaselineBuild(foundation), baseline);
  const proof = authenticateBaselineVariant(inputs);
  assert.equal(proof.inverseRegions, 3);
  assert.equal(proof.currentFoundationQualified, false);
  assert.equal(proof.remainingShippingDeltaUnchanged, true);
});

test('a different historical source or unrelated validation edit cannot masquerade as the baseline', () => {
  assert.throws(() => authenticateBaselineVariant({ ...inputs, baseline: baseline + '\n' }), assert.AssertionError);
  assert.throws(() => authenticateBaselineVariant({ ...inputs, foundation: foundation + '\n' }), assert.AssertionError);
  assert.throws(() => authenticateBaselineVariant({ ...inputs, variant: inputs.variant + '\n' }), assert.AssertionError);
});

test('the inverse cannot hide a modified shipping JVM signature stage', () => {
  const changed = shipping.replace('assert.equal(component.commonSources.length, 18);',
    'assert.equal(component.commonSources.length, 17);');
  assert.notEqual(changed, shipping);
  assert.throws(() => authenticateBaselineVariant({ ...inputs, shipping: changed,
    variant: projectBaselineBuild(changed) }), assert.AssertionError);
});

test('the inverse cannot use the old graph in place of the exception predecessor', () => {
  const changed = inputs.variant.replace('retainedSources: compilerExceptionPredecessorSources,',
    'retainedSources: [],');
  assert.notEqual(changed, inputs.variant);
  assert.throws(() => authenticateBaselineVariant({ ...inputs, variant: changed }), assert.AssertionError);
});

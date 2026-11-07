import assert from 'node:assert/strict';
import { sha256 } from '../../scripts/source.mjs';

export const BASELINE_COMMIT = '4b6f787429335426368fc16b69f463d05a226fe1';
export const FOUNDATION_COMMIT = '31b83cf7fdb63986dc4d6c5871a0758d086f1509';
export const BASELINE_BUILD_SHA256 = '7442a2427adcf8be6a40dfb22121e28be33c1f4b329caaeb57c673daea2c5d10';
export const FOUNDATION_BUILD_SHA256 = '3b38ff04662757ea0eb02bce1de2243c3e9f06692f007780496111bc00473f13';

function once(source, before, after) {
  assert.equal(source.split(before).length, 2, 'Baseline projection must replace exactly one verified region');
  return source.replace(before, after);
}

// Validation only. The shipping recipe retains all eighteen JVM signature sources.
// This inverse has exactly the three regions introduced by FOUNDATION_COMMIT;
// authenticating its result against BASELINE_COMMIT prevents hiding other changes.
export function projectBaselineBuild(source) {
  let result = once(source, '  let jvmDescriptorSignatureComposition;\n', '');
  const start = result.indexOf("        ['jvmDescriptorSignatureImplementationsReceipt', async ({ outputRoot }) => {");
  const end = result.indexOf("        ['performanceCounterReceipt',", start);
  assert(start > 0 && end > start);
  const component = result.slice(start, end);
  assert.equal(component.split('\n').length - 1, 34);
  result = once(result, component, '');
  const finalStart = result.indexOf("      const jvmSignatures = await import('./jvm-descriptor-signature-implementations/prepare.mjs');");
  const finalEnd = result.indexOf('      receipt.descriptorTypeAliasConstructorBindingsFinalReceipt = typeAliasFinal.receipt;', finalStart);
  assert(finalStart > 0 && finalEnd > finalStart);
  const region = result.slice(finalStart, finalEnd);
  const prefix = "      const jvmSignatures = await import('./jvm-descriptor-signature-implementations/prepare.mjs');\n" +
    '      const jvmSignatureFinal = await jvmSignatures.verifyFinalJvmDescriptorSignatureImplementations({\n' +
    '        ...jvmDescriptorSignatureComposition,\n';
  const suffix = '      });\n' +
    '      receipt.jvmDescriptorSignatureImplementationsFinalReceipt = jvmSignatureFinal.receipt;\n' +
    '      const typeAliasFinal = await typealiases.verifyFinalDescriptorTypeAliasConstructorBindings({\n' +
    '        ...descriptorTypeAliasComposition,\n' +
    '        retainedSources: jvmSignatureFinal.predecessorRetainedSources,\n' +
    '        recordedPropertyImports: receipt.propertyImports.imports,\n' +
    '      });\n';
  assert(region.startsWith(prefix) && region.endsWith(suffix));
  const retained = region.slice(prefix.length, -suffix.length);
  assert(retained.startsWith('        retainedSources: '));
  assert(retained.endsWith('        recordedPropertyImports: receipt.propertyImports.imports,\n'));
  result = once(result, region,
    '      const typeAliasFinal = await typealiases.verifyFinalDescriptorTypeAliasConstructorBindings({\n' +
    '        ...descriptorTypeAliasComposition,\n' + retained + '      });\n');
  assert(!result.includes('jvmDescriptorSignature'));
  return result;
}

export function authenticateBaselineVariant({ baseline, foundation, shipping, variant }) {
  assert.equal(sha256(Buffer.from(baseline)), BASELINE_BUILD_SHA256);
  assert.equal(sha256(Buffer.from(foundation)), FOUNDATION_BUILD_SHA256);
  const region = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  const componentStart = "        ['jvmDescriptorSignatureImplementationsReceipt',";
  const componentEnd = "        ['performanceCounterReceipt',";
  assert.equal(region(shipping, componentStart, componentEnd), region(foundation, componentStart, componentEnd));
  const finalStart = "      const jvmSignatures = await import('./jvm-descriptor-signature-implementations/prepare.mjs');";
  const finalEnd = '      receipt.descriptorTypeAliasConstructorBindingsFinalReceipt = typeAliasFinal.receipt;';
  assert.equal(region(shipping, finalStart, finalEnd), region(foundation, finalStart, finalEnd).replace(
    "retainedSources: [...files].filter(([sourcePath, pin]) => pin.compile && sourcePath.endsWith('.kt'))\n" +
    '          .map(([sourcePath, pin]) => ({ path: sourcePath, ...pin })),',
    'retainedSources: compilerExceptionPredecessorSources,'));
  assert.equal(projectBaselineBuild(foundation), baseline,
    'The three-region inverse must reproduce the authentic baseline recipe byte for byte');
  assert.equal(projectBaselineBuild(shipping), variant,
    'Validation variant must preserve every shipping change outside the exact inverse');
  assert(variant.includes('retainedSources: compilerExceptionPredecessorSources,'));
  return { kind: 'explicit-baseline-plus-exception-delta', baselineCommit: BASELINE_COMMIT,
    foundationCommit: FOUNDATION_COMMIT, inverseRegions: 3, removedSignatureSources: 18,
    baselineBuildSha256: sha256(Buffer.from(baseline)), foundationBuildSha256: sha256(Buffer.from(foundation)),
    shippingBuildSha256: sha256(Buffer.from(shipping)), variantBuildSha256: sha256(Buffer.from(variant)),
    authenticBaselineReproduced: true, remainingShippingDeltaUnchanged: true,
    currentFoundationQualified: false };
}

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { descriptorBaseFixture } from './fixture.mjs';
import { VALUE_PARAMETER } from './transform.mjs';
import { prepareDescriptorBaseImplementations, verifyFinalDescriptorBaseImplementations } from './prepare.mjs';
import { verifyFinalIrPropertyTypeGetter } from '../ir-property-type-getter/prepare.mjs';
import { verifyFinalCopyBuilderPlatform } from '../copy-builder-platform/prepare.mjs';
import { verifyFinalDescriptorPlatformSignatures } from '../descriptor-platform-signatures/prepare.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const root = path.resolve(process.argv[2]); assert(root.startsWith(path.join(REPO, 'out') + path.sep)); await mkdir(root, { mode: 0o700 });
const build = path.join(REPO, 'out/kotlin-compiler-port/builds/module-ir-native-whole-1791654238457260213');
const buildReceiptBytes = await readRegular(path.join(build, 'compiler-build-receipt.json'), 64 * 1024 * 1024), buildReceipt = JSON.parse(buildReceiptBytes);
const argsBytes = await readRegular(path.join(build, 'compiler-klib.args'));
const filenames = argsBytes.toString().trimEnd().split('\n').map(line => JSON.parse(line)).filter(name => !name.startsWith('-') && name.endsWith('.kt'));
assert.equal(filenames.length, buildReceipt.compileSources.length);
const historical = [];
for (const [index, pin] of buildReceipt.compileSources.entries()) {
    const filename = path.resolve(build, filenames[index]), bytes = await readRegular(filename);
    assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256);
    historical.push({ ...pin, filename });
}
const fixture = await descriptorBaseFixture();
const before = historical.map(row => row.path === VALUE_PARAMETER ? fixture.retainedSources[0] : row);
assert.equal(before.filter(row => row.path === VALUE_PARAMETER).length, 1);
const component = await prepareDescriptorBaseImplementations({ sourceRoot: path.join(REPO, 'out/kotlin-compiler-port/sources'), outputRoot: path.join(root, 'prepared'), descriptorVisitorComponent: fixture.descriptorVisitorComponent, retainedSources: before });
const added = [];
for (const pin of component.receipt.files) {
    const filename = path.join(component.outputRoot, pin.path), bytes = await readRegular(filename);
    let text = bytes.toString().replace(/(^package[^\n]*)/m, '$1\n' + buildReceipt.propertyImports.imports.map(name => 'import ' + name).join('\n') + '\n');
    if (/@(?:\w+:)?(?:Jvm[A-Za-z]+|Volatile|Transient|Synchronized)\b/.test(bytes.toString())) text = text.replace(/(^package[^\n]*)/m, '$1\nimport kotlin.jvm.*\n');
    const assembled = Buffer.from(text);
    await writeFile(filename, assembled); added.push({ path: pin.path, filename, bytes: assembled.length, sha256: sha256(assembled) });
}
const selected = [...before.filter(row => row.path !== VALUE_PARAMETER), ...added];
const base = await verifyFinalDescriptorBaseImplementations({ outputRoot: component.outputRoot, retainedSources: selected, recordedPropertyImports: buildReceipt.propertyImports.imports });
assert.deepEqual(base.predecessorRetainedSources.sort((a,b)=>a.path.localeCompare(b.path)), [...before].sort((a,b)=>a.path.localeCompare(b.path)));
const imports = ['kotlin.jvm.*', ...buildReceipt.propertyImports.imports, 'org.jetbrains.kotlin.portable.assertions.compilerAssert as assert'];
const ir = await verifyFinalIrPropertyTypeGetter({ profileRoot: path.join(build, 'components/irPropertyTypeGetterReceipt'), retainedSources: base.predecessorRetainedSources, allowedAddedImports: imports });
const builder = await verifyFinalCopyBuilderPlatform({ profileRoot: path.join(build, 'components/copyBuilderPlatformReceipt'), retainedSources: ir.predecessorRetainedSources, allowedAddedImports: imports });
const signatures = await verifyFinalDescriptorPlatformSignatures({ profileRoot: path.join(build, 'components/descriptorPlatformSignaturesReceipt'), retainedSources: builder.predecessorRetainedSources, allowedAddedImports: imports });
for (const pin of historical) { const bytes = await readRegular(pin.filename); assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256); }
await writeJson(path.join(root, 'receipt.json'), { schemaVersion: 1, kind: 'actual-descriptor-base-final-composition', result: 'pass', build, buildReceiptSha256: sha256(buildReceiptBytes), argumentFileSha256: sha256(argsBytes),
    actualHistoricalSources: historical.length, preparationSources: before.length, finalSources: selected.length,
    fixtureBinding: 'Only historical ValueParameter path rebound to the genuine unchanged visitor preparation used by this unit; other actual selected files retain exact owner and bytes.',
    historicalValueParameter: historical.find(row => row.path === VALUE_PARAMETER), canonicalVisitorValueParameter: fixture.retainedSources[0],
    preparation: component.receipt, base: base.receipt, ir: ir.receipt, builder: builder.receipt, signatures,
    allHistoricalBytesUnchanged: true, fullCompilerBuilt: false, languageReadiness: false });
console.log(JSON.stringify({ result: 'pass', actualHistoricalSources: historical.length, finalSources: selected.length, chain: 'base->IR->CopyBuilder->signatures' }));

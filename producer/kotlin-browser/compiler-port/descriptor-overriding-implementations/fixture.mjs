import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256 } from '../../scripts/source.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export async function overridingImplementationFixture() {
    const root = path.join(REPO, 'out/kotlin-compiler-port/builds/closure-selection-whole-1791789518688526956');
    const bytes = await readRegular(path.join(root, 'compiler-build-receipt.json'), 64 * 1024 * 1024), receipt = JSON.parse(bytes);
    const args = await readRegular(path.join(root, 'compiler-klib.args'), 16 * 1024 * 1024);
    assert.equal(receipt.commands.length, 1); const command = receipt.commands[0];
    assert.equal(command.phase, 'official-compiler-source-to-wasmjs-klib'); assert.equal(command.exitCode, 1); assert.equal(command.signal, null);
    assert(command.command.includes('org.jetbrains.kotlin.cli.js.KotlinWasmCompiler')); assert.equal(command.command.at(-1), '@' + path.join(root, 'compiler-klib.args'));
    assert.equal(sha256(args), command.argumentFileSha256);
    const filenames = args.toString().trim().split('\n').map(line => JSON.parse(line)).filter(value => !value.startsWith('-') && value.endsWith('.kt'));
    assert.equal(filenames.length, receipt.compileSources.length); assert.equal(filenames.length, 3549);
    const retainedSources = [];
    for (const [i, pin] of receipt.compileSources.entries()) { const body = await readRegular(filenames[i]); assert.equal(body.length, pin.bytes); assert.equal(sha256(body), pin.sha256); retainedSources.push({ ...pin, filename: filenames[i], compile: true }); }
    const components = {};
    for (const [name, directory] of [
        ['preparedClassImplementations', 'descriptorClassImplementationsReceipt'], ['preparedLazyMutableImplementations', 'descriptorLazyMutableImplementationsReceipt'],
        ['preparedDescriptorBases', 'descriptorBaseImplementationsReceipt'], ['preparedFunctions', 'descriptorFunctionImplementationsReceipt'],
        ['preparedReceivers', 'descriptorReceiverFactoryReceipt'], ['preparedDescriptorSubstitutor', 'descriptorSubstitutorReceipt'],
        ['preparedPropertyConstructors', 'descriptorPropertyConstructorsReceipt'], ['preparedDescriptorContracts', 'descriptorReceipt/compiler-port-descriptors'],
        ['preparedTypeContracts', 'typeContractReceipt/compiler-port-type-contracts'], ['preparedTypeUtilities', 'typeUtilitiesReceipt/compiler-port-type-utilities'],
        ['preparedKindFilterHost', 'descriptorKindFilterHostReceipt'],
    ]) { const outputRoot = path.join(root, 'components', directory); components[name] = { outputRoot, receipt: JSON.parse(await readRegular(path.join(outputRoot, 'receipt.json'))) }; }
    return { sourceRoot: path.join(REPO, 'out/kotlin-compiler-port/sources'), retainedSources, ...components, recordedPropertyImports: receipt.propertyImports.imports,
        historical: { outputRoot: root, receiptSha256: sha256(bytes), argumentFileSha256: sha256(args), selectedSources: retainedSources.length, compilerExitCode: 1, head: '1a6d8a7878bc534c2a147f27dddc4e0d8e2c3b8e' } };
}

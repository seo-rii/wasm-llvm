import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256 } from '../../scripts/source.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export async function jvmDescriptorSignatureFixture() {
    const root = path.join(REPO, 'out/kotlin-compiler-port/builds/overriding-semantic-alias-whole-1791799796857706594');
    const bytes = await readRegular(path.join(root, 'compiler-build-receipt.json'), 80 * 1024 * 1024), receipt = JSON.parse(bytes);
    const args = await readRegular(path.join(root, 'compiler-klib.args'), 16 * 1024 * 1024), command = receipt.commands[0];
    assert.equal(receipt.commands.length, 1); assert.equal(command.phase, 'official-compiler-source-to-wasmjs-klib');
    assert.equal(command.exitCode, 1); assert.equal(command.signal, null); assert.equal(command.command.at(-1), '@' + path.join(root, 'compiler-klib.args'));
    assert(command.command.includes('org.jetbrains.kotlin.cli.js.KotlinWasmCompiler')); assert.equal(sha256(args), command.argumentFileSha256);
    const values = args.toString().trim().split('\n').map(line => JSON.parse(line));
    const filenames = values.filter(value => !value.startsWith('-') && value.endsWith('.kt'));
    const common = values.filter(value => value.startsWith('-Xcommon-sources=')); assert.equal(common.length, 1);
    assert.deepEqual(common[0].slice('-Xcommon-sources='.length).split(','), filenames);
    assert.equal(filenames.length, 3553); assert.equal(receipt.compileSources.length, 3553);
    const retainedSources = [];
    for (const [i, pin] of receipt.compileSources.entries()) {
        assert(filenames[i].endsWith('/' + pin.path)); const body = await readRegular(filenames[i]);
        assert.equal(body.length, pin.bytes); assert.equal(sha256(body), pin.sha256); retainedSources.push({ ...pin, filename: filenames[i], compile: true });
    }
    const components = {};
    for (const [name, directory, file = 'receipt.json'] of [
        ['preparedCore', 'coreReceipt', 'compiler-port-core/name-inputs.json'],
        ['preparedClassImplementations', 'descriptorClassImplementationsReceipt'], ['preparedFunctions', 'descriptorFunctionImplementationsReceipt'],
        ['preparedReceivers', 'descriptorReceiverFactoryReceipt'], ['preparedPropertyConstructors', 'descriptorPropertyConstructorsReceipt'],
        ['preparedTypeContracts', 'typeContractReceipt/compiler-port-type-contracts'], ['preparedTypeUtilities', 'typeUtilitiesReceipt/compiler-port-type-utilities'],
        ['preparedDescriptorBases', 'descriptorBaseImplementationsReceipt'], ['preparedOverriding', 'descriptorOverridingImplementationsReceipt'],
    ]) { const outputRoot = path.join(root, 'components', directory); components[name] = { outputRoot, receipt: JSON.parse(await readRegular(path.join(outputRoot, file))) }; }
    return { retainedSources, ...components, recordedPropertyImports: receipt.propertyImports.imports,
        historical: { outputRoot: root, receiptSha256: sha256(bytes), argumentFileSha256: sha256(args), selectedSources: 3553,
            compilerExitCode: 1, head: '4b6f787', latestErrors: 1422 } };
}

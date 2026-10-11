import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256 } from '../../scripts/source.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export async function receiverFactoryFixture() {
    const root = path.join(REPO, 'out/kotlin-compiler-port/builds/function-syntax-whole-1791708437574091361');
    const bytes = await readRegular(path.join(root, 'compiler-build-receipt.json'), 64 * 1024 * 1024), receipt = JSON.parse(bytes);
    assert.equal(sha256(bytes), 'e04c68596ee7b36a94b609637a136e52e74dfece4c4cf660b11e9f171d55c2e4', 'Historical whole failure receipt changed');
    const args = await readRegular(path.join(root, 'compiler-klib.args'), 16 * 1024 * 1024), command = receipt.commands[0];
    assert.equal(receipt.commands.length, 1); assert.equal(command.exitCode, 1); assert.equal(command.signal, null);
    assert.equal(command.phase, 'official-compiler-source-to-wasmjs-klib');
    assert(command.command.includes('org.jetbrains.kotlin.cli.js.KotlinWasmCompiler'));
    assert.equal(command.command.at(-1), '@' + path.join(root, 'compiler-klib.args'));
    assert.equal(sha256(args), command.argumentFileSha256);
    const filenames = args.toString().trim().split('\n').map(line => JSON.parse(line)).filter(value => !value.startsWith('-') && value.endsWith('.kt'));
    assert.equal(filenames.length, receipt.compileSources.length);
    const retainedSources = [];
    for (const [i, pin] of receipt.compileSources.entries()) {
        const body = await readRegular(filenames[i]); assert.equal(body.length, pin.bytes); assert.equal(sha256(body), pin.sha256);
        retainedSources.push({ ...pin, filename: filenames[i] });
    }
    const components = {};
    for (const [name, relative] of [
        ['preparedDescriptorFunctions', 'descriptorFunctionImplementationsReceipt'],
        ['preparedDescriptorBases', 'descriptorBaseImplementationsReceipt'],
        ['preparedTypeContracts', 'typeContractReceipt/compiler-port-type-contracts'],
        ['preparedDescriptorContracts', 'descriptorReceipt/compiler-port-descriptors'],
    ]) {
        const outputRoot = path.join(root, 'components', relative);
        components[name] = { outputRoot, receipt: JSON.parse(await readRegular(path.join(outputRoot, 'receipt.json'))) };
    }
    return { sourceRoot: path.join(REPO, 'out/kotlin-compiler-port/sources'), retainedSources, ...components,
        recordedPropertyImports: receipt.propertyImports.imports,
        historical: { outputRoot: root, receiptSha256: sha256(bytes), argumentsSha256: sha256(args), selectedSources: retainedSources.length } };
}

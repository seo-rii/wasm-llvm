import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256 } from '../../scripts/source.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
/** Load the completed, failed whole compiler's actual selected files; no mock contracts. */
export async function functionFixture() {
    const root = path.join(REPO, 'out/kotlin-compiler-port/builds/memory-host-whole-1791700702126849235');
    const bytes = await readRegular(path.join(root, 'compiler-build-receipt.json'), 64 * 1024 * 1024), receipt = JSON.parse(bytes);
    const args = await readRegular(path.join(root, 'compiler-klib.args'), 16 * 1024 * 1024);
    assert.equal(receipt.commands.length, 1, 'Expected one actual completed compiler invocation');
    const command = receipt.commands[0];
    assert.equal(command.phase, 'official-compiler-source-to-wasmjs-klib');
    assert.equal(command.exitCode, 1); assert.equal(command.signal, null);
    assert(command.command.includes('org.jetbrains.kotlin.cli.js.KotlinWasmCompiler'));
    assert.equal(command.command.at(-1), '@' + path.join(root, 'compiler-klib.args'));
    assert.equal(sha256(args), command.argumentFileSha256, 'Actual compiler invocation argfile changed');
    const filenames = args.toString().trim().split('\n').map(line => JSON.parse(line)).filter(value => !value.startsWith('-') && value.endsWith('.kt'));
    assert.equal(filenames.length, receipt.compileSources.length);
    const retainedSources = [];
    for (const [i, pin] of receipt.compileSources.entries()) {
        const actual = await readRegular(filenames[i]); assert.equal(actual.length, pin.bytes); assert.equal(sha256(actual), pin.sha256);
        retainedSources.push({ ...pin, filename: filenames[i] });
    }
    const components = {};
    for (const [name, directory] of [['preparedDescriptorBases', 'descriptorBaseImplementationsReceipt'], ['preparedCopyBuilderPlatform', 'copyBuilderPlatformReceipt'],
        ['preparedTypeImplementations', 'typeImplementationReceipt/compiler-port-type-implementation']]) {
        const outputRoot = path.join(root, 'components', directory);
        components[name] = { outputRoot, receipt: JSON.parse(await readRegular(path.join(outputRoot, 'receipt.json'))) };
    }
    return { sourceRoot: path.join(REPO, 'out/kotlin-compiler-port/sources'), retainedSources, ...components, recordedPropertyImports: receipt.propertyImports.imports,
        historical: { outputRoot: root, receiptSha256: sha256(bytes), argumentsSha256: sha256(args), selectedSources: retainedSources.length } };
}

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256 } from '../../scripts/source.mjs';
export const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
export const BUILD = path.join(REPO, 'out/kotlin-compiler-port/builds/property-metadata-whole-1791764871402591253');
export async function actualFixture() {
    const bytes = await readRegular(path.join(BUILD, 'compiler-build-receipt.json'), 64 * 1024 * 1024), receipt = JSON.parse(bytes);
    const evidence = JSON.parse(await readRegular(path.join(HERE, '../evidence/property-metadata-build-failure.json')));
    assert.equal(sha256(bytes), evidence.sourceBuildReceipt.sha256); assert.equal(receipt.status, 'failed');
    assert.equal(receipt.commands.length, 1); assert.equal(receipt.commands[0].exitCode, 1);
    const argsBytes = await readRegular(path.join(BUILD, 'compiler-klib.args'));
    assert.equal(sha256(argsBytes), receipt.commands[0].argumentFileSha256);
    const args = argsBytes.toString().trimEnd().split('\n').map(JSON.parse), filenames = args.slice(-receipt.compileSources.length);
    const retainedSources = receipt.compileSources.map((row, index) => ({ ...row, filename: filenames[index] }));
    assert.equal(retainedSources.length, 3540);
    const hostRoot = path.join(BUILD, 'components/sourceHostReceipt'), parserRoot = path.join(BUILD, 'components/parserProfileReceipt/compiler-port-parser-profile');
    return { sourceRoot: path.join(REPO, 'out/kotlin-compiler-port/sources'), retainedSources,
        recordedPropertyImports: receipt.propertyImports.imports,
        preparedHost: { receipt: receipt.sourceHostReceipt, receiptPath: path.join(hostRoot, 'compiler-port-host/host-receipt.json'),
            commonSources: receipt.sourceHostReceipt.sources.map(pin => path.join(hostRoot, pin.path)) },
        preparedParserProfile: { receipt: receipt.parserProfileReceipt, receiptPath: path.join(parserRoot, 'parser-profile-inputs.json'),
            commonSources: [...receipt.parserProfileReceipt.transformed.map(pin => path.join(parserRoot, pin.originalPath)), path.join(parserRoot, 'ParserProfile.kt')] },
        historical: { receiptSha256: sha256(bytes), argumentFileSha256: sha256(argsBytes), selectedSources: retainedSources.length } };
}

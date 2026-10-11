import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { prepareKlibSources } from '../klib/prepare.mjs';
import { prepareKlibSignatureIndex, verifyKlibSignatureIndex } from '../klib-signature-index/prepare.mjs';
import { INDEX, MEMORY } from '../klib-signature-index/transform.mjs';
import { prepareServiceLoaderProfile, verifyServiceLoaderFinalSources, TARGET as SERVICE } from '../service-loader-profile/prepare.mjs';
import { prepareKlibDiskSourceProfile, verifyKlibDiskFinalSources } from './prepare.mjs';
import { CONFIG, TARGETS } from './transform.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const pin = (logical, filename, bytes) => ({ path: logical, filename, bytes: bytes.length, sha256: sha256(bytes) });
function assemble(bytes, imports) {
    let text = bytes.toString();
    const add = block => { text = text.replace(/(^package[^\r\n]+)/m, '$1\n' + block + '\n'); };
    if (/@(?:\w+:)?(?:Jvm[A-Za-z]+|Volatile|Transient|Synchronized)\b/.test(text) && !/^import kotlin\.jvm\.\*\s*$/m.test(text)) add('import kotlin.jvm.*');
    const missing = imports.filter(name => !text.includes('import ' + name)); if (missing.length) add(missing.map(name => 'import ' + name).join('\n'));
    if (/\bassert\s*\(/.test(text) || /^import kotlin\.assert\s*$/m.test(text)) {
        assert(!/\bkotlin\.assert\s*\(/.test(text)); text = text.replace(/^import kotlin\.assert[ \t]*\r?\n/gm, '');
        if (!text.split(/\r?\n/).some(line => line.trimEnd() === 'import org.jetbrains.kotlin.portable.assertions.compilerAssert as assert')) add('import org.jetbrains.kotlin.portable.assertions.compilerAssert as assert');
    }
    return Buffer.from(text);
}
export async function runDiskProbe({ sourceRoot, outputRoot, frozenBuildRoot }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot); frozenBuildRoot = path.resolve(frozenBuildRoot);
    assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep)); await mkdir(outputRoot, { mode: 0o700 });
    const wholeBytes = await readRegular(path.join(frozenBuildRoot, 'compiler-build-receipt.json'), 64 * 1024 * 1024), whole = JSON.parse(wholeBytes);
    const argsBytes = await readRegular(path.join(frozenBuildRoot, 'compiler-klib.args'), 64 * 1024 * 1024);
    const filenames = argsBytes.toString().trim().split('\n').map(JSON.parse).filter(value => path.isAbsolute(value) && value.endsWith('.kt'));
    assert.equal(filenames.length, whole.compileSources.length);
    const actual = whole.compileSources.map((row, n) => ({ ...row, filename: filenames[n] }));
    for (const row of actual) { const bytes = await readRegular(row.filename); assert.equal(bytes.length, row.bytes); assert.equal(sha256(bytes), row.sha256); }
    const historicalService = whole.serviceLoaderProfileReceipt;
    assert.deepEqual(historicalService.selection.sources.filter(row => row.path !== SERVICE), actual);
    const selected = historicalService.selection.sources.map(row => ({ ...row }));
    const restoredService = selected.find(row => row.path === SERVICE); assert(restoredService);
    const serviceBytes = await readRegular(restoredService.filename); assert.equal(serviceBytes.length, restoredService.bytes); assert.equal(sha256(serviceBytes), restoredService.sha256);
    const klibComponent = await prepareKlibSources({ sourceRoot, outputRoot: path.join(outputRoot, 'klib') });
    const memoryFile = klibComponent.commonSources.find(file => file.endsWith('/' + MEMORY));
    const indexComponent = await prepareKlibSignatureIndex({ sourceRoot, outputRoot: path.join(outputRoot, 'index'), klibComponent,
        retainedSources: [pin(INDEX, path.join(sourceRoot, INDEX), await readRegular(path.join(sourceRoot, INDEX))), pin(MEMORY, memoryFile, await readRegular(memoryFile))] });
    await verifyKlibSignatureIndex(indexComponent.outputRoot);
    const imports = whole.propertyImports.imports;
    for (const filename of indexComponent.commonSources) {
        const bytes = assemble(await readRegular(filename), imports); await writeFile(filename, bytes);
        const logical = path.relative(indexComponent.outputRoot, filename), found = selected.find(row => row.path === logical);
        if (found) Object.assign(found, pin(logical, filename, bytes)); else selected.push(pin(logical, filename, bytes));
    }
    const prepared = await prepareKlibDiskSourceProfile({ sourceRoot, outputRoot: path.join(outputRoot, 'disk'), retainedSources: selected,
        preparedKlibSignatureIndex: indexComponent, recordedPropertyImports: imports });
    const diskOnly = selected.filter(row => !TARGETS.includes(row.path)).map(row => row.path === CONFIG ? prepared.receipt.configuration.after : row);
    const beforeServiceFinal = await verifyKlibDiskFinalSources({ outputRoot: prepared.outputRoot, expectedReceiptSha256: prepared.receiptSha256, retainedSources: diskOnly });
    const service = await prepareServiceLoaderProfile({ sourceRoot, outputRoot: path.join(outputRoot, 'service'), retainedSources: diskOnly });
    const retainedSources = diskOnly.filter(row => row.path !== SERVICE), serviceLoaderProfile = { outputRoot: service.outputRoot, expectedReceiptSha256: service.receiptSha256 };
    const serviceFinal = await verifyServiceLoaderFinalSources({ ...serviceLoaderProfile, retainedSources });
    const final = await verifyKlibDiskFinalSources({ outputRoot: prepared.outputRoot, expectedReceiptSha256: prepared.receiptSha256, retainedSources, serviceLoaderProfile });
    const fixture = { outputRoot: prepared.outputRoot, expectedReceiptSha256: prepared.receiptSha256, retainedSources, serviceLoaderProfile,
        beforeServiceSources: diskOnly, priorSources: selected, sourceRoot, preparedKlibSignatureIndex: indexComponent, recordedPropertyImports: imports };
    await writeJson(path.join(outputRoot, 'fixture.json'), fixture);
    const evidence = { schemaVersion: 1, kind: 'klib-disk-profile-recovered-actual-selection-proof', result: 'pass',
        frozenBuildRoot, frozenReceipt: { bytes: wholeBytes.length, sha256: sha256(wholeBytes) }, argumentSha256: sha256(argsBytes),
        actualFrozenSources: actual.length, recoveredBeforeService: historicalService.selection.sources.length, beforeDisk: selected.length,
        afterDiskBeforeService: diskOnly.length, finalSources: retainedSources.length, originalAudit: prepared.receipt.originalAudit,
        preparationReceipt: { path: prepared.receiptPath, ...pin('receipt.json', prepared.receiptPath, await readRegular(prepared.receiptPath, 64 * 1024 * 1024)) },
        final, beforeServiceFinal, serviceFinal, preparedIndex: { outputRoot: indexComponent.outputRoot, receiptSha256: sha256(await readRegular(indexComponent.receiptPath)) },
        limitations: ['Recovered completed actual 3527-source build plus canonical signature-index overlay and its recorded assembly imports; this is not another complete compiler preparation/build.',
            'Original ServiceLoaderLite owner is restored at its historical position solely to exercise the real later service-profile exclusion.'],
        fullCompilerBuilt: false, languageReadiness: false };
    await writeJson(path.join(outputRoot, 'selection.json'), evidence);
    return { outputRoot, finalSources: retainedSources.length, originalSources: prepared.receipt.originalAudit.inspectedFiles, result: 'pass' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const options = {}; for (let n = 2; n < process.argv.length; n += 2) { assert(['--source-root', '--output', '--frozen-build-root'].includes(process.argv[n])); options[process.argv[n]] = process.argv[n + 1]; }
    console.log(JSON.stringify(await runDiskProbe({ sourceRoot: options['--source-root'], outputRoot: options['--output'], frozenBuildRoot: options['--frozen-build-root'] })));
}

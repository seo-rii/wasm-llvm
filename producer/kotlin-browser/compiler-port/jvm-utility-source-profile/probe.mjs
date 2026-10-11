import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { prepareKlibDiskSourceProfile, verifyKlibDiskFinalSources } from '../klib-disk-source-profile/prepare.mjs';
import { CONFIG, TARGETS as DISK } from '../klib-disk-source-profile/transform.mjs';
import { prepareServiceLoaderProfile, verifyServiceLoaderFinalSources, TARGET as SERVICE } from '../service-loader-profile/prepare.mjs';
import { prepareJvmUtilitySourceProfile, verifyJvmUtilityFinalSources } from './prepare.mjs';
import { TARGETS } from './references.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const limit = 64 * 1024 * 1024;
const identity = (filename, bytes) => ({ filename, bytes: bytes.length, sha256: sha256(bytes) });

export async function runJvmUtilityProbe({ sourceRoot, outputRoot, frozenBuildRoot }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot); frozenBuildRoot = path.resolve(frozenBuildRoot);
    assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep)); await mkdir(outputRoot, { mode: 0o700 });
    const lock = JSON.parse(await readRegular(path.join(HERE, 'sources.lock.json'))), inputs = [];
    for (const name of new Set(['sources.lock.json', 'probe.mjs', 'prepare.test.mjs', ...lock.dependencies.map(row => row.path)])) {
        const filename = path.resolve(HERE, name); inputs.push(identity(filename, await readRegular(filename)));
    }
    const wholePath = path.join(frozenBuildRoot, 'compiler-build-receipt.json'), argsPath = path.join(frozenBuildRoot, 'compiler-klib.args');
    const wholeBytes = await readRegular(wholePath, limit), whole = JSON.parse(wholeBytes), argsBytes = await readRegular(argsPath, limit);
    assert.equal(whole.commands.length, 1, 'Proof requires an actual compiler invocation');
    assert.equal(sha256(argsBytes), whole.commands[0].argumentFileSha256, 'Actual compiler argument binding changed');
    const filenames = argsBytes.toString().trim().split('\n').map(JSON.parse).filter(value => path.isAbsolute(value) && value.endsWith('.kt'));
    assert.equal(filenames.length, whole.compileSources.length);
    const actual = whole.compileSources.map((row, n) => ({ path: row.path, filename: filenames[n], bytes: row.bytes, sha256: row.sha256 }));
    for (let n = 0; n < actual.length; n += 24) {
        const batch = await Promise.allSettled(actual.slice(n, n + 24).map(async row => {
            const bytes = await readRegular(row.filename); assert.deepEqual(identity(row.filename, bytes), { filename: row.filename, bytes: row.bytes, sha256: row.sha256 });
        }));
        for (const result of batch) if (result.status !== 'fulfilled') throw result.reason;
    }
    const historicalDisk = whole.klibDiskSourceProfileReceipt, historicalService = whole.serviceLoaderProfileReceipt;
    const recovered = historicalDisk.selection.sources;
    const historicalAfterDisk = recovered.filter(row => !DISK.includes(row.path)).map(row => row.path === CONFIG ? historicalDisk.configuration.after : row);
    assert.deepEqual(historicalService.selection.sources, historicalAfterDisk);
    assert.deepEqual(historicalAfterDisk.filter(row => row.path !== SERVICE), actual);
    const signatureIndex = historicalDisk.signatureIndex, indexBytes = await readRegular(signatureIndex.receiptPath, limit);
    assert.equal(sha256(indexBytes), signatureIndex.receiptSha256);
    const preparedKlibSignatureIndex = { outputRoot: signatureIndex.outputRoot, receiptPath: signatureIndex.receiptPath, receipt: JSON.parse(indexBytes) };
    const prepared = await prepareJvmUtilitySourceProfile({ sourceRoot, outputRoot: path.join(outputRoot, 'utilities'), retainedSources: recovered });
    const afterUtilities = recovered.filter(row => !TARGETS.includes(row.path));
    const immediate = await verifyJvmUtilityFinalSources({ outputRoot: prepared.outputRoot, expectedReceiptSha256: prepared.receiptSha256, retainedSources: afterUtilities });
    const disk = await prepareKlibDiskSourceProfile({ sourceRoot, outputRoot: path.join(outputRoot, 'disk'), retainedSources: afterUtilities,
        preparedKlibSignatureIndex, recordedPropertyImports: whole.propertyImports.imports });
    const afterDisk = afterUtilities.filter(row => !DISK.includes(row.path)).map(row => row.path === CONFIG ? disk.receipt.configuration.after : row);
    const service = await prepareServiceLoaderProfile({ sourceRoot, outputRoot: path.join(outputRoot, 'service'), retainedSources: afterDisk });
    const serviceLoaderProfile = { outputRoot: service.outputRoot, expectedReceiptSha256: service.receiptSha256 };
    const retainedSources = afterDisk.filter(row => row.path !== SERVICE);
    const serviceFinal = await verifyServiceLoaderFinalSources({ ...serviceLoaderProfile, retainedSources });
    const klibDiskProfile = { outputRoot: disk.outputRoot, expectedReceiptSha256: disk.receiptSha256, serviceLoaderProfile };
    const diskFinal = await verifyKlibDiskFinalSources({ ...klibDiskProfile, retainedSources });
    const final = await verifyJvmUtilityFinalSources({ outputRoot: prepared.outputRoot, expectedReceiptSha256: prepared.receiptSha256, retainedSources, klibDiskProfile });
    assert.deepEqual(final.diskFinal, diskFinal); assert.deepEqual(diskFinal.serviceFinal, serviceFinal);
    const fixture = { outputRoot: prepared.outputRoot, expectedReceiptSha256: prepared.receiptSha256, retainedSources, klibDiskProfile,
        afterUtilities, sourceRoot, recovered, frozenBuildRoot };
    await writeJson(path.join(outputRoot, 'fixture.json'), fixture);
    const bindings = [identity(wholePath, wholeBytes), identity(argsPath, argsBytes), identity(signatureIndex.receiptPath, indexBytes)];
    const artifacts = [];
    for (const filename of [prepared.receiptPath, disk.receiptPath, service.receiptPath, path.join(outputRoot, 'fixture.json'), ...prepared.originalReferenceSources]) {
        artifacts.push(identity(filename, await readRegular(filename, limit)));
    }
    for (const pin of inputs) assert.deepEqual(identity(pin.filename, await readRegular(pin.filename)), pin, 'Proof input changed during execution');
    const evidence = { schemaVersion: 1, kind: 'jvm-utility-actual-source-selection-proof', result: 'pass', inputs, bindings, artifacts,
        actualCompiledSources: actual.length, recoveredPreDiskSources: recovered.length, afterUtilitySources: afterUtilities.length,
        afterDiskSources: afterDisk.length, finalSources: retainedSources.length, exactExcludedSources: TARGETS,
        originalAudit: prepared.receipt.originalAudit, immediate, final,
        limitation: 'The exact completed compiler selection and recorded pre-disk owners are replayed through real utility/disk/service preparation and final guards. This is not a new whole compiler build or a runtime reachability proof.',
        fullCompilerBuilt: false, languageReadiness: false };
    await writeJson(path.join(outputRoot, 'selection.json'), evidence);
    return { outputRoot, result: 'pass', actualCompiledSources: actual.length, recoveredPreDiskSources: recovered.length,
        afterUtilitySources: afterUtilities.length, finalSources: retainedSources.length, originalAuditedSources: prepared.receipt.originalAudit.inspectedFiles };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const options = {}; for (let n = 2; n < process.argv.length; n += 2) {
        assert(['--source-root', '--output', '--frozen-build-root'].includes(process.argv[n])); options[process.argv[n]] = process.argv[n + 1];
    }
    console.log(JSON.stringify(await runJvmUtilityProbe({ sourceRoot: options['--source-root'], outputRoot: options['--output'], frozenBuildRoot: options['--frozen-build-root'] })));
}

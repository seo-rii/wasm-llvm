import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256 } from '../../scripts/source.mjs';
import { prepareTypeImplementations } from '../type-implementation/prepare.mjs';
import { prepareDescriptorBaseImplementations } from '../descriptor-base-implementations/prepare.mjs';
import { descriptorBaseFixture } from '../descriptor-base-implementations/fixture.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
export async function getterFixture(outputRoot) {
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    const historical = path.resolve(process.env.TYPE_GETTER_BUILD ?? path.join(REPO, 'out/kotlin-compiler-port/builds/disk-retry-whole-1791692102097271136'));
    const receiptBytes = await readRegular(path.join(historical, 'compiler-build-receipt.json'), 64 * 1024 * 1024), receipt = JSON.parse(receiptBytes);
    const argumentBytes = await readRegular(path.join(historical, 'compiler-klib.args'), 16 * 1024 * 1024);
    const filenames = argumentBytes.toString().trim().split('\n').map(line => JSON.parse(line)).filter(name => !name.startsWith('-') && name.endsWith('.kt'));
    assert.equal(filenames.length, receipt.compileSources.length);
    const retainedSources = [];
    for (const [i, pin] of receipt.compileSources.entries()) {
        const bytes = await readRegular(filenames[i]); assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256);
        retainedSources.push({ ...pin, filename: filenames[i] });
    }
    const primaryRoot = path.join(REPO, 'out/kotlin-compiler-port/sources'), sourceRoot = path.join(outputRoot, 'sources');
    const lock = JSON.parse(await readRegular(path.join(HERE, 'sources.lock.json')));
    for (const pin of lock.originals) {
        const target = path.join(sourceRoot, pin.path); await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, await readRegular(path.join(primaryRoot, pin.path)), { flag: 'wx', mode: 0o600 });
    }
    const preparedTypeImplementations = await prepareTypeImplementations(primaryRoot, path.join(outputRoot, 'types'));
    const preparedDescriptorBases = await prepareDescriptorBaseImplementations({ sourceRoot: primaryRoot, outputRoot: path.join(outputRoot, 'bases'), ...await descriptorBaseFixture() });
    for (const pin of lock.selected) {
        const existing = retainedSources.find(item => item.path === pin.path); assert(existing);
        const filename = pin.path.startsWith('compiler-port-type-implementation/') ? path.join(preparedTypeImplementations.outputRoot, 'common', path.basename(pin.path))
            : pin.path.endsWith('/ValueParameterDescriptorImpl.kt') ? path.join(preparedDescriptorBases.outputRoot, pin.path) : path.join(outputRoot, 'selected-originals', pin.path);
        if (!pin.path.startsWith('compiler-port-type-implementation/') && !pin.path.endsWith('/ValueParameterDescriptorImpl.kt')) {
            await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
            await writeFile(filename, await readRegular(path.join(sourceRoot, pin.path)), { flag: 'wx', mode: 0o600 });
            assert(!filename.startsWith(sourceRoot + path.sep), 'Original consumer fixture must model actual build clones outside canonical source root');
        }
        const bytes = await readRegular(filename); Object.assign(existing, { filename, bytes: bytes.length, sha256: sha256(bytes) });
    }
    return { sourceRoot, retainedSources, preparedTypeImplementations, preparedDescriptorBases,
        historical: { outputRoot: historical, receiptSha256: sha256(receiptBytes), argumentSha256: sha256(argumentBytes), actualSources: retainedSources.length },
        recordedPropertyImports: receipt.propertyImports.imports };
}

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { PREFIX, applyRecipe } from './transform.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
async function load(sourceRoot) {
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    const closureBytes = await readRegular(path.join(HERE, '../closure.lock.json')), closure = JSON.parse(closureBytes);
    assert.equal(lock.kind, 'genuine-performance-manager-report-family'); assert.equal(lock.schemaVersion, 1);
    assert.equal(lock.primaryClosureSha256, sha256(closureBytes)); assert.deepEqual(lock.source, closure.source);
    for (const pin of lock.dependencies) verifyFile(await readRegular(path.join(HERE, pin.path)), pin);
    const files = [];
    for (const source of lock.sources) {
        assert.deepEqual(source.original, closure.files.find(item => item.path === source.original.path));
        assert.equal(source.output.path, source.original.path, 'Manager logical source path changed');
        const original = verifyFile(await readRegular(path.join(sourceRoot, source.original.path)), source.original);
        files.push({ pin: source.output, bytes: verifyFile(applyRecipe(original, source.recipe), source.output) });
    }
    for (const pin of lock.hosts) files.push({ pin: { ...pin, path: PREFIX + pin.path }, bytes: verifyFile(await readRegular(path.join(HERE, pin.path)), pin) });
    assert.equal(new Set(files.map(item => item.pin.path)).size, files.length, 'Duplicate manager source owner');
    return { lock, lockBytes, files };
}

function roots(sourceRoot, outputRoot) {
    assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep), 'Manager output must be under out/');
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep), 'Manager roots must not overlap');
}
function receiptFor(input) {
    return { schemaVersion: 1, kind: 'genuine-performance-manager-report-preparation', source: input.lock.source,
        sourceLockSha256: sha256(input.lockBytes), primaryClosureSha256: input.lock.primaryClosureSha256,
        sources: input.lock.sources, files: input.files.map(item => item.pin),
        requiredHost: 'Explicit request-scoped clock, metrics, worker identity, files, formatting and date providers; no defaults.',
        executionContract: 'Single synchronous Worker; caller installs performance counter clock and performance manager host for the complete request.',
        originalAlgorithmsRetained: true, fullCompilerBuilt: false, languageReadiness: false };
}
export async function preparePerformanceManager({ sourceRoot, outputRoot }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot); roots(sourceRoot, outputRoot);
    await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot);
    const input = await load(sourceRoot), receipt = receiptFor(input), commonSources = [];
    for (const { pin, bytes } of input.files) {
        const filename = path.join(outputRoot, relativePath(pin.path)); await assertNoSymlink(filename);
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); commonSources.push(filename);
    }
    const receiptPath = path.join(outputRoot, 'receipt.json'); await writeJson(receiptPath, receipt);
    return { outputRoot, receiptPath, receipt, commonSources, replacedOriginalPaths: input.lock.sources.map(item => item.original.path) };
}
export async function verifyPerformanceManager({ sourceRoot, outputRoot }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot); roots(sourceRoot, outputRoot);
    const input = await load(sourceRoot), receipt = receiptFor(input);
    assert.deepEqual(JSON.parse(await readRegular(path.join(outputRoot, 'receipt.json'))), receipt, 'Manager preparation receipt changed');
    for (const pin of receipt.files) verifyFile(await readRegular(path.join(outputRoot, pin.path)), pin);
    return receipt;
}
function normalizeAssemblyImports(bytes, imports) {
    assert(Array.isArray(imports) && imports.every(name => typeof name === 'string' && name && !/[\r\n]/.test(name)), 'Invalid manager recorded imports');
    assert.equal(new Set(imports).size, imports.length, 'Duplicate manager recorded import');
    const markers = ['\nimport kotlin.jvm.*\n', '\nimport org.jetbrains.kotlin.portable.assertions.compilerAssert as assert\n'];
    if (imports.length) markers.push('\n' + imports.map(name => 'import ' + name).join('\n') + '\n');
    const seen = new Set(); let text = bytes.toString();
    for (let step = 0; step < markers.length; step++) {
        const pkg = /^package[^\r\n]+/m.exec(text); assert(pkg, 'Missing manager package');
        const end = pkg.index + pkg[0].length, marker = markers.find(item => text.startsWith(item, end));
        if (!marker) break;
        assert(!seen.has(marker), 'Duplicate manager assembly import block'); seen.add(marker);
        text = text.slice(0, end) + text.slice(end + marker.length);
    }
    return Buffer.from(text);
}
export async function verifyFinalPerformanceManager({ sourceRoot, outputRoot, retainedSources, recordedPropertyImports = [] }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot); roots(sourceRoot, outputRoot);
    const input = await load(sourceRoot), receipt = receiptFor(input);
    assert.deepEqual(JSON.parse(await readRegular(path.join(outputRoot, 'receipt.json'))), receipt, 'Manager preparation receipt changed');
    assert(Array.isArray(retainedSources) && retainedSources.length, 'Manager final selection required');
    const paths = new Set(), filenames = new Set(), checked = [];
    for (const item of retainedSources) {
        relativePath(item.path); assert(!paths.has(item.path), 'Duplicate manager selection logical path'); paths.add(item.path);
        assert(path.isAbsolute(item.filename) && !filenames.has(item.filename), 'Duplicate manager selection file'); filenames.add(item.filename);
        const pin = receipt.files.find(pin => pin.path === item.path); if (!pin) continue;
        assert.equal(item.filename, path.join(outputRoot, pin.path), 'Wrong manager output owner');
        const bytes = await readRegular(item.filename);
        assert.equal(bytes.length, item.bytes, 'Manager final size mismatch'); assert.equal(sha256(bytes), item.sha256, 'Manager final hash mismatch');
        verifyFile(normalizeAssemblyImports(bytes, recordedPropertyImports), pin);
        checked.push({ path: item.path, filename: item.filename, bytes: item.bytes, sha256: item.sha256 });
    }
    assert.equal(checked.length, receipt.files.length, 'Missing manager final source');
    return { schemaVersion: 1, kind: 'genuine-performance-manager-report-final', sourceLockSha256: sha256(input.lockBytes),
        checked, exactBodyAndImportsVerified: true, fullCompilerBuilt: false, languageReadiness: false };
}

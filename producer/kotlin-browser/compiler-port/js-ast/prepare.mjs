/** Prepare the pinned full AST implementation, preserving all selected shared compiler consumers. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, gitBlob, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { adaptKotlin } from './adapt.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');

function propertyImports(properties) {
    const names = new Set([...properties.toString().matchAll(/^(?:var|val)\s+\w+\.(\w+):/gm)].map(match => match[1]));
    for (const name of ['currentNode', 'replaceMe', 'addPrevious']) names.add(name);
    assert.equal(names.size, 69);
    const imports = [...names].sort().map(name => 'org.jetbrains.kotlin.js.backend.ast.' + name);
    imports.push('org.jetbrains.kotlin.js.util.position', 'org.jetbrains.kotlin.js.util.line', 'org.jetbrains.kotlin.js.util.column');
    assert(imports.every(value => /^[a-zA-Z0-9_.]+$/.test(value)));
    return imports;
}

export async function prepareJsAstSources({ sourceRoot, outputRoot }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep), 'AST output must remain under out');
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep), 'AST output overlaps original source cache');
    for (const root of [sourceRoot, outputRoot]) await assertNoSymlink(root);
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json'));
    const lock = JSON.parse(lockBytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'official-java-js-ast-common-source-port');
    assert.equal(lock.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
    assert.equal(lock.browserCompilerBuilt, false); assert.equal(lock.languageReadiness, false);
    assert.equal(lock.sources.length, 107); assert.equal(new Set(lock.sources.map(pin => relativePath(pin.path))).size, 107);
    assert.equal(lock.sources.filter(pin => pin.language === 'java').length, 63);
    assert.equal(lock.sources.filter(pin => pin.language === 'kotlin').length, 44);
    const closureBytes = await readRegular(path.join(HERE, '../closure.lock.json'));
    assert.equal(sha256(closureBytes), lock.primaryClosureSha256);
    const closure = JSON.parse(closureBytes);
    assert.deepEqual(lock.sources, closure.files.filter(pin => pin.path.startsWith('js/js.ast/src/')), 'AST originals differ from primary closure');
    for (const pin of lock.referenceDependencies) assert.deepEqual(pin, closure.files.find(item => item.path === pin.path));
    for (const pin of lock.tools) verifyFile(await readRegular(path.join(HERE, relativePath(pin.path))), pin);
    for (const pin of lock.licenses) {
        assert.equal(pin.sourceCommit, lock.source.commit);
        verifyFile(await readRegular(path.join(HERE, relativePath(pin.path))), pin);
    }
    verifyFile(await readRegular(path.join(HERE, relativePath(lock.characterPolicy.path))), lock.characterPolicy);
    const numberLock = JSON.parse(verifyFile(await readRegular(path.join(HERE, lock.numberBoundary.sourceLock.path)), lock.numberBoundary.sourceLock));
    const numberEvidence = JSON.parse(verifyFile(await readRegular(path.join(HERE, lock.numberBoundary.evidence.path)), lock.numberBoundary.evidence));
    assert.equal(numberEvidence.sourceLockSha256, lock.numberBoundary.sourceLock.sha256);
    for (const name of ['originalJvmEqualsCommonJvm', 'originalJvmEqualsNodeWasm', 'originalJvmEqualsOfflineChromium']) assert.equal(numberEvidence.comparison[name], true);
    assert.equal(numberEvidence.comparison.normalizedText, false);
    assert.deepEqual(numberEvidence.portedSource, numberLock.portedSource);
    const formatter = lock.portable.find(pin => pin.path.endsWith('/AstDoubleFormat.kt'));
    assert(formatter && formatter.bytes === numberEvidence.portedSource.bytes && formatter.sha256 === numberEvidence.portedSource.sha256);
    const dependencies = [];
    for (const pin of lock.commonDependencies) {
        assert(['../collections/SmartList.kt', '../assertions/CompilerAssertions.kt'].includes(pin.path));
        verifyFile(await readRegular(path.join(HERE, pin.path)), pin);
        dependencies.push({ ...pin, filename: path.join(HERE, pin.path) });
    }
    const originals = new Map();
    for (const pin of [...lock.sources, ...lock.referenceDependencies]) {
        originals.set(pin.path, verifyFile(await readRegular(path.join(sourceRoot, relativePath(pin.path))), pin));
    }
    assert.equal(new Set(lock.portable.map(pin => relativePath(pin.path))).size, lock.portable.length);
    assert.equal(new Set(lock.portable.filter(pin => pin.originalPath).map(pin => pin.originalPath)).size, 63);
    for (const original of lock.sources.filter(pin => pin.language === 'java')) {
        assert(lock.portable.some(pin => pin.originalPath === original.path), 'Missing genuine Java AST port: ' + original.path);
    }
    for (const name of ['JavaProperties.kt', 'AstCharacter.kt', 'AstInteger.kt', 'AstSourceReader.kt', 'JavaListView.kt', 'AstDoubleFormat.kt']) {
        assert(lock.portable.some(pin => pin.path.endsWith('/' + name)), 'Missing common AST boundary: ' + name);
    }
    // Read and verify every implementation before publishing any preparation.
    const ports = new Map();
    for (const pin of lock.portable) ports.set(pin.path, verifyFile(await readRegular(path.join(HERE, relativePath(pin.path))), pin));
    const propertyPin = lock.portable.find(pin => pin.path.endsWith('/JavaProperties.kt'));
    const propertyAliasImports = propertyImports(ports.get(propertyPin.path));
    const files = []; const commonSources = [];
    async function output(name, bytes, details) {
        name = relativePath(name); const filename = path.join(outputRoot, name);
        await assertNoSymlink(filename); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); commonSources.push(filename);
        files.push({ path: name, bytes: bytes.length, sha256: sha256(bytes), gitBlob: gitBlob(bytes), ...details });
    }
    for (const pin of lock.sources.filter(pin => pin.language === 'kotlin')) {
        const adapted = adaptKotlin(pin.path, originals.get(pin.path));
        await output(pin.path, adapted.bytes, { originalPath: pin.path, originalSha256: pin.sha256, transformations: adapted.transformations });
    }
    for (const pin of lock.portable) {
        await output(pin.outputPath, ports.get(pin.path), { originalPath: pin.originalPath, implementationPath: pin.path });
    }
    for (const pin of [...lock.sources, ...lock.referenceDependencies]) {
        assert.deepEqual(await readRegular(path.join(sourceRoot, pin.path)), originals.get(pin.path), 'Original AST source was changed');
    }
    const receipt = { schemaVersion: 1, kind: 'official-java-js-ast-source-preparation', source: lock.source,
        sourceLockSha256: sha256(lockBytes), primaryClosureSha256: lock.primaryClosureSha256,
        preparationToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
        sourceFiles: lock.sources, portableFiles: lock.portable, commonDependencies: dependencies,
        characterPolicy: lock.characterPolicy, numberBoundary: lock.numberBoundary, licenses: lock.licenses, propertyAliasImports,
        tools: lock.tools, files, originalSourceUnmodified: true,
        completeCompilerBuilt: false, differentialValidated: false, languageReadiness: false };
    const receiptPath = path.join(outputRoot, 'js-ast-inputs.json'); await writeJson(receiptPath, receipt);
    return { outputRoot, receipt, receiptPath, commonSources, dependencySources: dependencies.map(pin => pin.filename),
        propertyAliasImports,
        noticeFiles: lock.licenses.map(pin => path.join(HERE, pin.path)),
        replacedOriginalPaths: lock.sources.map(pin => pin.path) };
}

/** Recompute prepared bytes from sealed originals and current implementation pins. */
export async function verifyJsAstPreparation(outputRoot, { sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources') } = {}) {
    outputRoot = path.resolve(outputRoot); sourceRoot = path.resolve(sourceRoot);
    assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep));
    await assertNoSymlink(outputRoot); await assertNoSymlink(sourceRoot);
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')); const lock = JSON.parse(lockBytes);
    const receipt = JSON.parse(await readRegular(path.join(outputRoot, 'js-ast-inputs.json')));
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.kind, 'official-java-js-ast-source-preparation');
    assert.deepEqual(receipt.source, lock.source);
    assert.equal(receipt.primaryClosureSha256, lock.primaryClosureSha256);
    const closureBytes = await readRegular(path.join(HERE, '../closure.lock.json'));
    assert.equal(sha256(closureBytes), lock.primaryClosureSha256);
    const closure = JSON.parse(closureBytes);
    assert.deepEqual(lock.sources, closure.files.filter(pin => pin.path.startsWith('js/js.ast/src/')));
    for (const pin of lock.referenceDependencies) assert.deepEqual(pin, closure.files.find(item => item.path === pin.path));
    for (const pin of [...lock.sources, ...lock.referenceDependencies]) verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin);
    assert.equal(receipt.sourceLockSha256, sha256(lockBytes));
    assert.equal(receipt.preparationToolSha256, sha256(await readRegular(fileURLToPath(import.meta.url))));
    assert.deepEqual(receipt.sourceFiles, lock.sources); assert.deepEqual(receipt.portableFiles, lock.portable);
    assert.deepEqual(receipt.characterPolicy, lock.characterPolicy); assert.deepEqual(receipt.numberBoundary, lock.numberBoundary);
    assert.deepEqual(receipt.licenses, lock.licenses);
    assert.deepEqual(receipt.tools, lock.tools);
    for (const pin of [...lock.tools, ...lock.licenses]) verifyFile(await readRegular(path.join(HERE, pin.path)), pin);
    verifyFile(await readRegular(path.join(HERE, lock.characterPolicy.path)), lock.characterPolicy);
    for (const pin of [lock.numberBoundary.sourceLock, lock.numberBoundary.evidence]) verifyFile(await readRegular(path.join(HERE, pin.path)), pin);
    const dependencies = [];
    for (const pin of lock.commonDependencies) {
        verifyFile(await readRegular(path.join(HERE, pin.path)), pin);
        dependencies.push({ ...pin, filename: path.join(HERE, pin.path) });
    }
    assert.deepEqual(receipt.commonDependencies, dependencies);
    const propertyPin = lock.portable.find(pin => pin.path.endsWith('/JavaProperties.kt'));
    assert.deepEqual(receipt.propertyAliasImports, propertyImports(verifyFile(await readRegular(path.join(HERE, propertyPin.path)), propertyPin)));
    assert.equal(receipt.languageReadiness, false); assert.equal(receipt.completeCompilerBuilt, false);
    assert.equal(receipt.differentialValidated, false); assert.equal(receipt.originalSourceUnmodified, true);
    const expected = [];
    for (const pin of lock.sources.filter(pin => pin.language === 'kotlin')) {
        const adapted = adaptKotlin(pin.path, verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin));
        expected.push({ path: pin.path, bytes: adapted.bytes.length, sha256: sha256(adapted.bytes), gitBlob: gitBlob(adapted.bytes),
            originalPath: pin.path, originalSha256: pin.sha256, transformations: adapted.transformations });
    }
    for (const pin of lock.portable) {
        verifyFile(await readRegular(path.join(HERE, pin.path)), pin);
        expected.push({ path: pin.outputPath, bytes: pin.bytes, sha256: pin.sha256, gitBlob: pin.gitBlob,
            originalPath: pin.originalPath, implementationPath: pin.path });
    }
    // JSON publication omits an undefined originalPath on genuinely supplemental common helpers.
    assert.deepEqual(receipt.files, JSON.parse(JSON.stringify(expected)));
    for (const pin of expected) verifyFile(await readRegular(path.join(outputRoot, pin.path)), pin);
    return { receipt, commonSources: expected.map(pin => path.join(outputRoot, pin.path)) };
}

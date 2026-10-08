/** Genuine version sources and SHA-bound producer resource for the compiler C source set. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');

function kotlinLiteral(value) {
    return '"' + Array.from({ length: value.length }, (_, index) => '\\u' + value.charCodeAt(index).toString(16).padStart(4, '0')).join('') + '"';
}

export function resolveBuildVersion(input, defaultSnapshotVersion) {
    assert.equal(input.schemaVersion, 1); assert.equal(input.kind, 'official-compiler-version-build-input');
    assert.equal(input.sourceCommit, '4d78aae1e337cd40f69baa865aed950fe807a775');
    assert(typeof input.provenance === 'string' && input.provenance.length > 0 && input.provenance.length <= 4096);
    const values = input.properties;
    assert(values && Object.keys(values).sort().join(',') === 'buildNumber,defaultSnapshotVersion,deployVersion');
    for (const value of Object.values(values)) assert(value === null || typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\r\n\0]/.test(value));
    assert.equal(values.defaultSnapshotVersion, defaultSnapshotVersion, 'Pinned defaultSnapshotVersion mismatch');
    const version = values.deployVersion !== null ?
        (values.deployVersion === 'default.snapshot' ? values.defaultSnapshotVersion : values.deployVersion) :
        (values.buildNumber !== null ? values.buildNumber : values.defaultSnapshotVersion);
    assert(typeof version === 'string' && version !== '@snapshot@', 'Unresolved production compiler version');
    return version;
}

function generateUnicodeData(policy) {
    assert.equal(policy.schemaVersion, 1); assert.equal(policy.kind, 'jdk17-version-parser-unicode-policy');
    const names = ['digitPairs', 'lowercasePairs', 'casedRanges', 'wordCategoryRanges', 'stateTable', 'backwardsStateTable', 'endStates', 'lookaheadStates'];
    for (const name of names) {
        const values = policy[name]; assert(Array.isArray(values) && values.length > 0 && values.length < 10000);
        assert(values.every(value => Number.isSafeInteger(value) && value >= -1 && value <= 0x10ffff));
        if (name.endsWith('Pairs') || name.endsWith('Ranges')) {
            assert.equal(values.length % 2, 0);
            for (let index = 2; index < values.length; index += 2) assert(values[index - 2] < values[index]);
        }
    }
    assert.equal(policy.endStates.length, policy.lookaheadStates.length);
    assert.equal(policy.stateTable.length % policy.endStates.length, 0);
    assert.equal(policy.backwardsStateTable.length % (policy.stateTable.length / policy.endStates.length), 0);
    return Buffer.from('/* Generated from SHA-bound reference JDK data; GPL2 with Classpath exception, see LICENSES.md. */\n' +
        'package org.jetbrains.kotlin.portable.versions\n\ninternal object VersionUnicodeData {\n' +
        '    private fun decode(text: String): IntArray = text.split(\',\').map { it.toInt() }.toIntArray()\n' +
        names.map(name => `    val ${name}: IntArray = decode("${policy[name].join(',')}")`).join('\n') + '\n}\n');
}

export async function prepareVersionSources({ sourceRoot, additionalSourceRoot = path.join(REPO, 'out/kotlin-versions-reference-inputs'),
    outputRoot, buildVersionInput, buildVersionInputSha256 }) {
    sourceRoot = path.resolve(sourceRoot); additionalSourceRoot = path.resolve(additionalSourceRoot); outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep));
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep));
    for (const root of [sourceRoot, additionalSourceRoot, outputRoot]) await assertNoSymlink(root);
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')); const lock = JSON.parse(lockBytes);
    assert.equal(lock.kind, 'official-version-algorithms-common-source-port'); assert.equal(lock.sources.length, 3);
    assert.equal(lock.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
    assert.equal(sha256(await readRegular(path.join(HERE, lock.generator.path))), lock.generator.sha256);
    const sourceInputs = new Map(); const originalSources = [];
    for (const pin of [...lock.sources, ...lock.references]) {
        const relative = relativePath(pin.path);
        const source = path.join(pin.location === 'closure' ? sourceRoot : additionalSourceRoot, relative);
        const bytes = verifyFile(await readRegular(source, pin.bytes), pin); sourceInputs.set(relative, { source, bytes });
        const filename = path.join(outputRoot, 'originals', relative); await assertNoSymlink(filename);
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
        if (lock.sources.includes(pin)) originalSources.push(filename);
    }
    assert.equal(typeof buildVersionInput, 'string', 'A bound producer build-version input is required');
    assert(/^[a-f0-9]{64}$/.test(buildVersionInputSha256 ?? ''), 'An expected producer input digest is required');
    const versionInputBytes = await readRegular(path.resolve(buildVersionInput), 16384);
    assert.equal(sha256(versionInputBytes), buildVersionInputSha256, 'Producer build-version input digest mismatch');
    const versionInput = JSON.parse(versionInputBytes);
    if (versionInput.upstreamProperty !== undefined) {
        const pinned = lock.references.find(pin => pin.path === 'gradle.properties');
        const property = versionInput.upstreamProperty;
        for (const key of ['path', 'gitBlob', 'bytes', 'sha256']) assert.equal(property[key], pinned[key], 'Producer upstream property pin mismatch');
        assert.equal(property.key, 'defaultSnapshotVersion'); assert.equal(property.value, versionInput.properties?.defaultSnapshotVersion);
    }
    const properties = sourceInputs.get('gradle.properties').bytes.toString();
    const match = /^defaultSnapshotVersion=([^\r\n]+)$/m.exec(properties); assert(match);
    const version = resolveBuildVersion(versionInput, match[1]);
    const template = sourceInputs.get(lock.versionInput.template).bytes.toString(); assert.equal(template, '@snapshot@');
    const tokenRule = sourceInputs.get(lock.versionInput.tokenRule).bytes.toString();
    assert(tokenRule.includes('kotlinBuildProperties.kotlinVersion.get()') && tokenRule.includes('"snapshot" to kotlinVersionLocal'));
    const propertyRule = sourceInputs.get(lock.versionInput.propertyRule).bytes.toString();
    assert(propertyRule.includes('if (deploySnapshotStr != "default.snapshot") deploySnapshotStr else defaultSnapshotVersion.get()') && propertyRule.includes('}.orElse(buildNumber)'));
    const resource = Buffer.from(template.replace('@snapshot@', version), 'utf8');
    const versionSource = Buffer.from('/* Producer generated from the pinned upstream ProcessResources rule and explicit input digest. */\n' +
        'package org.jetbrains.kotlin.config\ninternal object CompilerVersionResource {\n' +
        `    const val firstLine: String = ${kotlinLiteral(version)}\n}\n`);
    const files = [];
    async function output(relative, bytes) {
        const filename = path.join(outputRoot, relativePath(relative)); await assertNoSymlink(filename);
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
        files.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) }); return filename;
    }
    const commonSources = [];
    for (const pin of lock.portableFiles) {
        const bytes = await readRegular(path.join(HERE, relativePath(pin.path)), pin.bytes);
        assert.equal(bytes.length, pin.bytes); assert.equal(sha256(bytes), pin.sha256);
        commonSources.push(await output(pin.outputPath, bytes));
    }
    const patch = await readRegular(path.join(HERE, lock.patch.path)); assert.equal(sha256(patch), lock.patch.sha256);
    const policyBytes = await readRegular(path.join(HERE, lock.unicodePolicy.path)); assert.equal(sha256(policyBytes), lock.unicodePolicy.sha256);
    assert.equal(sha256(await readRegular(path.join(HERE, lock.unicodePolicyOrigin.generator.path))), lock.unicodePolicyOrigin.generator.sha256);
    commonSources.push(await output('compiler-port-versions/VersionUnicodeData.kt', generateUnicodeData(JSON.parse(policyBytes))));
    commonSources.push(await output('compiler-port-versions/CompilerVersionResource.kt', versionSource));
    const resourcePath = await output('resources/META-INF/compiler.version', resource);
    for (const { source, bytes } of sourceInputs.values()) assert.deepEqual(await readRegular(source, bytes.length), bytes);
    const receipt = { schemaVersion: 1, kind: 'official-version-common-source-preparation', source: lock.source,
        sourceLockSha256: sha256(lockBytes), preparationToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
        sourceFiles: lock.sources, references: lock.references, portableFiles: lock.portableFiles, patch: lock.patch,
        unicodePolicy: lock.unicodePolicy, unicodePolicyOrigin: lock.unicodePolicyOrigin, unicodeAlgorithmReferences: lock.unicodeAlgorithmReferences,
        versionGeneration: { template: lock.versionInput.template, tokenRule: lock.versionInput.tokenRule, propertyRule: lock.versionInput.propertyRule,
            input: versionInput, inputSha256: buildVersionInputSha256, resolvedVersion: version, resourceSha256: sha256(resource),
            generatedKotlinSha256: sha256(versionSource), actualGradleProcessResourcesExecuted: false,
            bootstrapVersionIsSourceVersion: false, targetStdlibVersionIsCompilerVersion: false },
        files, originalSourceUnmodified: true, fullCompilerBuilt: false, readiness: false };
    const receiptPath = path.join(outputRoot, 'version-inputs.json'); await writeJson(receiptPath, receipt);
    return { outputRoot, receipt, receiptPath, commonSources, originalSources, resourcePath, replacedOriginalPaths: lock.replacedOriginalPaths };
}

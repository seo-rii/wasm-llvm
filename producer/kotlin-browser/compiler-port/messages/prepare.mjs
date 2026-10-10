/** Bind actual compiler message models to a common host; retain their bodies. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');

export function transformCompilerMessages(source, name) {
    if (name === 'CompilerMessageLocation.kt') {
        assert.equal(source.split('import java.io.Serializable\n').length, 2);
        assert.equal(source.split('interface CompilerMessageSourceLocation : Serializable {').length, 2);
        return source.replace('import java.io.Serializable\n', '')
            .replace('interface CompilerMessageSourceLocation : Serializable {', 'interface CompilerMessageSourceLocation {')
            .replace('package org.jetbrains.kotlin.cli.common.messages\n', 'package org.jetbrains.kotlin.cli.common.messages\nimport kotlin.jvm.JvmStatic\n');
    }
    if (name === 'CompilerMessageSeverity.kt') {
        const declaration = 'val VERBOSE: EnumSet<CompilerMessageSeverity> = EnumSet.of(LOGGING)';
        assert.equal(source.split('import java.util.*').length, 2);
        assert.equal(source.split(declaration).length, 2);
        return source.replace('import java.util.*', 'import kotlin.jvm.JvmField')
            .replace(declaration, 'val VERBOSE: MutableSet<CompilerMessageSeverity> = CompilerSeveritySet(LOGGING)');
    }
    if (name === 'MessageCollector.kt') {
        assert.equal(source.split('@JvmDefaultWithCompatibility\n').length, 3);
        return source.replaceAll('@JvmDefaultWithCompatibility\n', '');
    }
    assert.equal(name, 'MessageCollectorImpl.kt');
    return source;
}

export async function prepareCompilerMessageSources({ sourceRoot, outputRoot }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep));
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep));
    await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot);
    const lockBytes = await readRegular(path.join(here, 'sources.lock.json'));
    const lock = JSON.parse(lockBytes);
    assert.equal(lock.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
    assert.equal(lock.prepareSha256, sha256(await readRegular(fileURLToPath(import.meta.url))));
    const root = path.join(outputRoot, 'compiler-port-messages');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const commonSources = [], originalSources = [], sources = [];
    for (const pin of lock.sources) {
        const original = verifyFile(await readRegular(path.join(sourceRoot, relativePath(pin.path)), pin.bytes), pin);
        const name = path.basename(pin.path);
        const portable = Buffer.from(transformCompilerMessages(original.toString('utf8'), name));
        assert.equal(sha256(portable), pin.portableSha256);
        assert.equal(portable.length, pin.portableBytes);
        const filename = path.join(root, name);
        const reference = path.join(root, 'original', name);
        await mkdir(path.dirname(reference), { recursive: true, mode: 0o700 });
        await writeFile(filename, portable, { flag: 'wx', mode: 0o600 });
        await writeFile(reference, original, { flag: 'wx', mode: 0o600 });
        commonSources.push(filename); originalSources.push(reference);
        sources.push({ path: 'compiler-port-messages/' + name, bytes: portable.length, sha256: pin.portableSha256, originalPath: pin.path, originalSha256: pin.sha256 });
    }
    const helper = verifyFile(await readRegular(path.join(here, lock.adapter.path)), lock.adapter);
    const helperFile = path.join(root, lock.adapter.path);
    await writeFile(helperFile, helper, { flag: 'wx', mode: 0o600 }); commonSources.push(helperFile);
    sources.push({ path: 'compiler-port-messages/' + lock.adapter.path, bytes: helper.length, sha256: lock.adapter.sha256, originalPath: null });
    const receipt = { schemaVersion: 1, kind: 'official-compiler-message-host-preparation', source: lock.source,
        sourceLockSha256: sha256(lockBytes), sources, replacedOriginalPaths: lock.sources.map(pin => pin.path),
        transformation: ['JVM Serializable marker and JVM default bridge annotations remain only in original JVM input.',
            'Location constructors, range defaults, message formatting, severity predicates and diagnostic-ID dispatch are unchanged.',
            'Mutable verbose severity membership, enum order and iterator snapshot/remove behavior have a common adapter.'],
        readiness: { fullCompilerBuilt: false, browserSourceCompilation: 'not-run', publicLanguageSupport: false } };
    const receiptPath = path.join(root, 'receipt.json'); await writeJson(receiptPath, receipt);
    return { commonSources, originalSources, replacedOriginalPaths: receipt.replacedOriginalPaths, receiptPath, receipt };
}

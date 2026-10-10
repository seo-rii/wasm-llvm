#!/usr/bin/env node
/** Connects the official lowering/code-generation/writer sources to a memory host. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const execute = promisify(execFile);

export async function prepareBackendSources({ sourceRoot, outputRoot }) {
    sourceRoot = path.resolve(sourceRoot);
    outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep));
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep));
    await assertNoSymlink(sourceRoot);
    await assertNoSymlink(outputRoot);
    const lockBytes = await readRegular(path.join(here, 'sources.lock.json'));
    const lock = JSON.parse(lockBytes);
    assert.equal(lock.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
    const original = new Map();
    for (const pin of lock.sources) {
        relativePath(pin.path);
        assert(!original.has(pin.path));
        const bytes = verifyFile(await readRegular(path.join(sourceRoot, pin.path), pin.bytes), pin);
        original.set(pin.path, { pin, bytes });
    }
    const patchFile = path.join(here, lock.patch.path);
    const patch = await readRegular(patchFile);
    assert.equal(sha256(patch), lock.patch.sha256);
    for (const { pin, bytes } of original.values()) {
        if (!pin.patchedSha256) continue;
        const destination = path.join(outputRoot, pin.path);
        await assertNoSymlink(destination);
        try { assert.equal(sha256(await readRegular(destination)), pin.sha256); }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            await mkdir(path.dirname(destination), { recursive: true });
            await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
        }
    }
    const commands = [];
    for (const argv of [['apply', '--check', patchFile], ['apply', patchFile], ['apply', '--reverse', '--check', patchFile]]) {
        await execute('git', argv, { cwd: outputRoot, timeout: 10000, maxBuffer: 65536 });
        commands.push({ argv: ['git', ...argv], exitCode: 0 });
    }
    const sources = [];
    for (const { pin } of original.values()) {
        if (!pin.patchedSha256) continue;
        const bytes = await readRegular(path.join(outputRoot, pin.path));
        assert.equal(sha256(bytes), pin.patchedSha256);
        sources.push({ path: pin.path, bytes: bytes.length, sha256: pin.patchedSha256, originalSha256: pin.sha256 });
    }

    // These helpers are lifted verbatim from the selected official driver. The
    // CLI filesystem/cache-guard shell is excluded; code generation is preserved.
    const codegen = original.get(lock.codegen.path).bytes.toString('utf8');
    const wholeProgram = codegen.slice(codegen.indexOf(lock.codegen.start), codegen.indexOf(lock.codegen.end));
    assert.equal(sha256(Buffer.from(wholeProgram)), lock.codegen.sha256);
    const driver = original.get(lock.linker.path).bytes.toString('utf8');
    const linker = driver.slice(driver.indexOf(lock.linker.start), driver.indexOf(lock.linker.end));
    assert.equal(sha256(Buffer.from(linker)), lock.linker.sha256);
    const helpers = '/* Lifted from pinned official Kotlin driver; see backend source receipt. */\n' +
        'package org.jetbrains.kotlin.browser.compiler\n\n' +
        'import org.jetbrains.kotlin.backend.wasm.*\n' +
        'import org.jetbrains.kotlin.backend.wasm.ir2wasm.*\n' +
        'import org.jetbrains.kotlin.config.CompilerConfiguration\n' +
        'import org.jetbrains.kotlin.ir.declarations.IdSignatureRetriever\n' +
        'import org.jetbrains.kotlin.js.config.dce\n' +
        'import org.jetbrains.kotlin.js.config.outputName\n' +
        'import org.jetbrains.kotlin.js.config.sourceMap\n' +
        'import org.jetbrains.kotlin.platform.wasm.WasmTarget\n' +
        'import org.jetbrains.kotlin.wasm.config.*\n' +
        'import org.jetbrains.kotlin.wasm.ir.WasmModule\n\n' +
        wholeProgram + linker.replace(/^    /gm, '').replace('private fun linkWasmIr', 'internal fun linkWasmIr');
    const generated = path.join(outputRoot, 'compiler-port-backend');
    await mkdir(generated, { recursive: true });
    for (const [filename, bytes] of [['OfficialWasmDriver.kt', Buffer.from(helpers)],
        ['BrowserWasmWriter.kt', await readRegular(path.join(here, 'BrowserWasmWriter.kt'))],
        ['BoundedByteSink.kt', await readRegular(path.join(here, '../../writer-probe/BoundedByteSink.kt'))]]) {
        await writeFile(path.join(generated, filename), bytes, { flag: 'wx', mode: 0o600 });
        sources.push({ path: 'compiler-port-backend/' + filename, bytes: bytes.length, sha256: sha256(bytes), originalSha256: null });
    }
    const receipt = { schemaVersion: 1, kind: 'official-wasm-backend-memory-host-preparation', source: lock.source,
        sourceLockSha256: sha256(lockBytes), patch: lock.patch, codegen: lock.codegen, linker: lock.linker,
        commands, sources, filesystemResultWriterExcluded: true, browserCompiler: 'not-built' };
    await writeJson(path.join(generated, 'backend-receipt.json'), receipt);
    return { receipt, commonSources: sources.map((pin) => path.join(outputRoot, pin.path)) };
}

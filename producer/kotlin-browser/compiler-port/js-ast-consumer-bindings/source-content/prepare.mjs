import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, gitBlob, readRegular, sha256, verifyFile, writeJson } from '../../../scripts/source.mjs';
import { UTILS, sourceContentBinding } from './transform.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../../..');
const PROVIDER = 'compiler-port-js-ast-source-content/org/jetbrains/kotlin/js/portable/RequestSourceContent.kt';
const UTILS_OUTPUT = 'compiler-port-js-ast-source-content/' + UTILS;
async function inputs(sourceRoot) {
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')), lock = JSON.parse(lockBytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'pinned-request-source-content-binding');
    const closureBytes = await readRegular(path.join(HERE, '../../closure.lock.json')); assert.equal(sha256(closureBytes), lock.primaryClosureSha256);
    const closure = JSON.parse(closureBytes), originals = new Map(); assert.deepEqual(lock.source, closure.source);
    for (const pin of lock.sources) { assert.deepEqual(pin, closure.files.find(item => item.path === pin.path)); originals.set(pin.path, verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin)); }
    for (const pin of [...lock.dependencies, ...lock.tools, ...lock.observers, lock.provider]) verifyFile(await readRegular(path.join(HERE, pin.path)), pin);
    const original = originals.get(UTILS), bound = sourceContentBinding(original);
    assert.equal(sha256(Buffer.from(bound.originalBody)), lock.originalBodySha256);
    assert.equal(sha256(bound.bytes), lock.prepared.sha256);
    const provider = verifyFile(await readRegular(path.join(HERE, lock.provider.path)), lock.provider);
    return { lock, lockBytes, bound, provider };
}
function receiptFor(input) {
    const pin = (name, bytes) => ({ path: name, bytes: bytes.length, sha256: sha256(bytes), gitBlob: gitBlob(bytes) });
    return { schemaVersion: 1, kind: 'request-source-content-preparation', source: input.lock.source,
        sourceLockSha256: sha256(input.lockBytes), sourceFiles: input.lock.sources, dependencyPins: input.lock.dependencies,
        files: [pin(UTILS_OUTPUT, input.bound.bytes), pin(PROVIDER, input.provider)], originalSourceUnmodified: true,
        originalSupplierChanged: true, hostBinding: 'Request-owned immutable raw source text; exact path-or-name keys; supplier captures current registry and opens fresh readers.',
        installationRequired: 'After entry request source snapshots, call installRequestSourceContent(configuration,sources). Entry installation is not part of this preparer.',
        fileIdentityPreserved: true, missingSourceIsNull: true, fullJsAstUtilsBuilt: false,
        sourceMapBuilderBuilt: false, fullCompilerBuilt: false, languageReadiness: false };
}
export async function prepareSourceContentBindings({ sourceRoot, outputRoot }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(REPO, 'out') + path.sep));
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep));
    await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot); const input = await inputs(sourceRoot);
    const receipt = receiptFor(input), commonSources = [];
    for (const [name, bytes] of [[UTILS_OUTPUT, input.bound.bytes], [PROVIDER, input.provider]]) {
        const filename = path.join(outputRoot, name); await assertNoSymlink(filename); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); commonSources.push(filename);
    }
    const receiptPath = path.join(outputRoot, 'source-content-inputs.json'); await writeJson(receiptPath, receipt);
    return { commonSources, replacedOriginalPaths: [UTILS], receipt, receiptPath };
}
export async function verifySourceContentBindings({ sourceRoot, outputRoot, receiptPath }) {
    const input = await inputs(sourceRoot), receipt = receiptFor(input);
    for (const pin of receipt.files) verifyFile(await readRegular(path.join(outputRoot, pin.path)), pin);
    assert.deepEqual(JSON.parse(await readRegular(receiptPath)), receipt); return receipt;
}

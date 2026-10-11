/** Maintainer command: explicitly seal reviewed source/recipe bytes; never called by preparation. */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, gitBlob } from '../../scripts/source.mjs';
import { INDEX, MEMORY, SIGNATURE, applyExact, indexChanges, memoryChanges } from './transform.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const pin = (path, bytes) => ({ path, bytes: bytes.length, sha256: sha256(bytes), gitBlob: gitBlob(bytes) });
const primaryBytes = await readFile(path.join(HERE, '../closure.lock.json')), primary = JSON.parse(primaryBytes);
const source = await readFile(path.join(REPO, 'out/kotlin-compiler-port/sources', INDEX));
const memory = await readFile(path.join(HERE, '../klib/MemoryKotlinLibrary.kt'));
const helper = await readFile(path.join(HERE, 'SignatureIndexTypeName.kt'));
const dependencies = [];
for (const name of ['prepare.mjs', 'transform.mjs', '../../scripts/source.mjs', '../klib/prepare.mjs', '../klib/sources.lock.json',
    '../klib/patches/in-memory-klib.patch', '../klib/MemoryKotlinLibrary.kt', '../klib/LibraryPathOperations.kt',
    '../host/LibraryPath.kt', '../linker/prepare.mjs', '../linker/sources.lock.json', '../linker/patches/in-memory-linker.patch',
    '../linker/MemoryKlibOutput.kt', '../linker/MemoryJarManifest.kt']) dependencies.push(pin(name, await readFile(path.join(HERE, name))));
const lock = { schemaVersion: 1, kind: 'genuine-memory-klib-signature-index', source: primary.source,
    primaryClosureSha256: sha256(primaryBytes), originals: [INDEX, SIGNATURE].map(name => primary.files.find(row => row.path === name)), dependencies,
    predecessor: pin(MEMORY, memory), helper: { ...pin('SignatureIndexTypeName.kt', helper), outputPath: 'compiler-port-klib-signature-index/SignatureIndexTypeName.kt' },
    outputs: [pin(INDEX, applyExact(source, indexChanges)), pin(MEMORY, applyExact(memory, memoryChanges)), pin('compiler-port-klib-signature-index/SignatureIndexTypeName.kt', helper)] };
await writeFile(path.join(HERE, 'sources.lock.json'), JSON.stringify(lock, null, 2) + '\n');
console.log(JSON.stringify({ originals: lock.originals.length, outputs: lock.outputs.length, indexSpans: indexChanges.length, memorySpans: memoryChanges.length }));

/** Explicit maintainer seal, never invoked by preparation or guards. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, gitBlob } from '../../scripts/source.mjs';
import { selectedDeclarations } from '../backend-profile/references.mjs';
import { CONFIG, TARGETS, DECLARATIONS, transformConfiguration } from './transform.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const pin = (path, bytes) => ({ path, bytes: bytes.length, sha256: sha256(bytes), gitBlob: gitBlob(bytes) });
const primaryBytes = await readFile(path.join(HERE, '../closure.lock.json')), primary = JSON.parse(primaryBytes);
const dependencies = [];
for (const name of ['prepare.mjs', 'transform.mjs', '../../scripts/source.mjs', '../native-js-output-profile/references.mjs', '../backend-profile/references.mjs',
    '../klib-signature-index/prepare.mjs', '../klib-signature-index/transform.mjs', '../klib-signature-index/sources.lock.json',
    '../klib/sources.lock.json', '../linker/sources.lock.json', '../linker/MemoryKlibOutput.kt', '../linker/MemoryKlibLoader.kt', '../linker/LoadMemoryWebKlibs.kt',
    '../service-loader-profile/prepare.mjs', '../service-loader-profile/sources.lock.json', '../serializer-comment-type-names/sources.lock.json']) dependencies.push(pin(name, await readFile(path.join(HERE, name))));
const index = JSON.parse(await readFile(path.join(HERE, '../klib-signature-index/sources.lock.json'))), boundaries = index.outputs.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
for (const name of ['MemoryKlibOutput.kt', 'MemoryKlibLoader.kt', 'LoadMemoryWebKlibs.kt']) boundaries.push(pin('compiler-port-linker/' + name, await readFile(path.join(HERE, '../linker', name))));
for (const group of ['klib', 'linker']) {
    const lock = JSON.parse(await readFile(path.join(HERE, '..', group, 'sources.lock.json')));
    for (const row of lock.sources.filter(row => /\/(?:Klib|KlibMetadataComponent|KlibIrComponent|lowLevelReaders|lowLevelWriters|KlibWriter)\.kt$/.test(row.path))) {
        assert(row.portableBytes && row.portableSha256); boundaries.push({ path: row.path, bytes: row.portableBytes, sha256: row.portableSha256 });
    }
}
const targetDeclarationInventory = {};
for (const logical of TARGETS) targetDeclarationInventory[logical] = selectedDeclarations((await readFile(path.join(REPO, 'out/kotlin-compiler-port/sources', logical))).toString());
const original = await readFile(path.join(REPO, 'out/kotlin-compiler-port/sources', CONFIG));
const lock = { schemaVersion: 1, kind: 'unreachable-klib-disk-source-profile', source: primary.source, primaryClosureSha256: sha256(primaryBytes),
    targets: TARGETS.map(name => primary.files.find(row => row.path === name)), targetDeclarationInventory, declarations: DECLARATIONS,
    configuration: { input: primary.files.find(row => row.path === CONFIG), output: pin(CONFIG, transformConfiguration(original)) },
    boundaries, dependencies, recordedPropertyImports: JSON.parse(await readFile(path.join(HERE, '../serializer-comment-type-names/sources.lock.json'))).recordedPropertyImports };
await writeFile(path.join(HERE, 'sources.lock.json'), JSON.stringify(lock, null, 2) + '\n');
console.log(JSON.stringify({ targets: lock.targets.length, configurationSpans: 3, publicAndInternalDeclarations: DECLARATIONS.length, boundaries: boundaries.length }));

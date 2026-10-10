import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitBlob, readRegular, sha256 } from '../../../scripts/source.mjs';
import { DESERIALIZER, INTEGER_IMPORT } from '../integer/prepare.mjs';
import { transformLengthBoundary } from './transform.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../../..');
async function pin(name) { const bytes = await readRegular(path.join(HERE, name)); return { path: name, bytes: bytes.length, sha256: sha256(bytes), gitBlob: gitBlob(bytes) }; }
const integer = JSON.parse(await readRegular(path.join(HERE, '../integer/sources.lock.json')));
const original = await readRegular(path.join(REPO, 'out/kotlin-compiler-port/sources', DESERIALIZER));
const body = original.toString().match(/    private inline fun <R> readBytes\([\s\S]*?(?=\n    private fun readByteArray)/)[0].trimEnd();
const predecessor = Buffer.from(original.toString().replace('import java.math.BigInteger', INTEGER_IMPORT)), output = transformLengthBoundary(predecessor, body);
const lock = { schemaVersion: 1, kind: 'pinned-js-ast-byte-length-boundary', source: integer.source,
    primaryClosureSha256: integer.primaryClosureSha256, sources: integer.sources,
    predecessor: await Promise.all(['../integer/sources.lock.json', '../integer/prepare.mjs', '../integer/verify.mjs', '../integer/extract.mjs'].map(pin)),
    predecessorOutput: { bytes: predecessor.length, sha256: sha256(predecessor), gitBlob: gitBlob(predecessor) },
    originalReadBytes: body, output: { bytes: output.length, sha256: sha256(output), gitBlob: gitBlob(output) },
    tools: await Promise.all(['prepare.mjs', 'transform.mjs', 'check.mjs', 'integrity.test.mjs', 'update-recipe.mjs'].map(pin)),
    observers: await Promise.all(['BoundsProbe.kt', 'JvmEntry.kt', 'WasmEntry.kt'].map(pin)),
    intentionalMalformedContractChange: true, fullCompilerBuilt: false, languageReadiness: false };
await writeFile(path.join(HERE, 'sources.lock.json'), JSON.stringify(lock, null, 2) + '\n');

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitBlob, readRegular, sha256 } from '../../../scripts/source.mjs';
import { DESERIALIZER, INTEGER_IMPORT } from './prepare.mjs';
import { extracts } from './extract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../../..');
async function pin(name) { const bytes = await readRegular(path.join(HERE, name)); return { path: name, bytes: bytes.length, sha256: sha256(bytes), gitBlob: gitBlob(bytes) }; }
const closureBytes = await readRegular(path.join(HERE, '../../closure.lock.json')); const closure = JSON.parse(closureBytes);
const names = [DESERIALIZER, DESERIALIZER.replace('JsIrAstDeserializer.kt', 'JsIrAstSerializer.kt'), DESERIALIZER.replace('JsIrAstDeserializer.kt', 'Constants.kt')];
const sources = names.map(name => closure.files.find(pin => pin.path === name));
const original = await Promise.all(names.map(name => readRegular(path.join(REPO, 'out/kotlin-compiler-port/sources', name))));
const parts = extracts(...original);
const prepared = Buffer.from(original[0].toString().replace('import java.math.BigInteger', INTEGER_IMPORT));
const lock = { schemaVersion: 1, kind: 'pinned-js-ast-signed-integer-consumer-binding', source: closure.source,
    primaryClosureSha256: sha256(closureBytes), sources,
    astSourceLock: await pin('../../js-ast/sources.lock.json'),
    astEvidence: await pin('../../js-ast/evidence/receipt.json'),
    astDependencies: [await pin('../../js-ast/portable/org/jetbrains/kotlin/js/util/AstInteger.kt')],
    extracts: Object.fromEntries(Object.entries(parts).map(([name, body]) => [name, sha256(Buffer.from(body))])),
    prepared: { bytes: prepared.length, sha256: sha256(prepared), gitBlob: gitBlob(prepared) },
    observers: await Promise.all(['Probe.kt', 'OriginalSupport.kt', 'PortableSupport.kt', 'JvmEntry.kt', 'WasmEntry.kt'].map(pin)),
    tools: await Promise.all(['prepare.mjs', 'verify.mjs', 'extract.mjs', 'compare-profile.mjs', 'check.mjs', 'seal.mjs', 'integrity.test.mjs', 'update-recipe.mjs'].map(pin)),
    selectedBaseline: { sourceCount: 3515,
        arguments: await pin('../../../../../out/kotlin-compiler-port/builds/ast-dsl-whole-1791633110599192554/compiler-klib.args') },
    fullDeserializerBuilt: false, byteBufferPorted: false, fullCompilerBuilt: false, languageReadiness: false };
await writeFile(path.join(HERE, 'sources.lock.json'), JSON.stringify(lock, null, 2) + '\n');
console.log(JSON.stringify({ originals: sources.length, preparedImportOnly: true }));

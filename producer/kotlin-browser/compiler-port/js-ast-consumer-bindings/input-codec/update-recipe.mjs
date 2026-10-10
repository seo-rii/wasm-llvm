import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitBlob, readRegular, sha256 } from '../../../scripts/source.mjs';
import { DESERIALIZER } from '../integer/prepare.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../../..');
async function pin(name) { const bytes = await readRegular(path.join(HERE, name)); return { path: name, bytes: bytes.length, sha256: sha256(bytes), gitBlob: gitBlob(bytes) }; }
const closureBytes = await readRegular(path.join(HERE, '../../closure.lock.json')), closure = JSON.parse(closureBytes);
const original = await readRegular(path.join(REPO, 'out/kotlin-compiler-port/sources', DESERIALIZER));
const textLock = JSON.parse(await readRegular(path.join(HERE, '../../text/sources.lock.json')));
const lock = { schemaVersion: 1, kind: 'pinned-selected-js-ast-input-codec', source: closure.source,
    primaryClosureSha256: sha256(closureBytes), consumer: closure.files.find(pin => pin.path === DESERIALIZER),
    selectedCalls: [...original.toString().matchAll(/\bbuffer\.([^\n]+)/g)].map(match => match[1]),
    implementation: await pin('JsAstInput.kt'),
    dependencies: await Promise.all(['../../text/sources.lock.json', '../../text/generate.mjs', '../../text/prepare.mjs', '../../text/CompilerUtf8Api.kt', '../../text/upstream/utf8Encoding.kt', '../../text/evidence/differential.json'].map(pin)),
    sharedDependencies: [textLock.generatedAlgorithm, textLock.api],
    tools: await Promise.all(['prepare.mjs', 'check.mjs', 'integrity.test.mjs', 'update-recipe.mjs'].map(pin)),
    observers: await Promise.all(['Probe.kt', 'OriginalSupport.kt', 'CommonSupport.kt', 'JvmEntry.kt', 'WasmEntry.kt'].map(pin)),
    javaFacadeIntroduced: false, fullCompilerBuilt: false, languageReadiness: false };
await writeFile(path.join(HERE, 'sources.lock.json'), JSON.stringify(lock, null, 2) + '\n');

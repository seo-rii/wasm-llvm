import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { gitBlob, sha256, verifyFile } from '../../scripts/source.mjs';
import { DECLARATIONS, TARGETS, SYMBOLS, FACADES, DEFERRED, HOMONYM, distributionDeclarations } from './references.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const primaryBytes = await readFile(path.join(here, '../closure.lock.json')), primary = JSON.parse(primaryBytes);
const sourceRoot = path.resolve(here, '../../../../out/kotlin-compiler-port/sources');
const targets = TARGETS.map(logical => primary.files.find(pin => pin.path === logical));
for (const pin of targets) distributionDeclarations(pin.path, verifyFile(await readFile(path.join(sourceRoot, pin.path)), pin).toString());
const dependencies = [];
for (const logical of ['prepare.mjs', 'references.mjs', 'update-lock.mjs', '../../scripts/source.mjs', '../backend-profile/references.mjs',
    '../native-js-output-profile/references.mjs', '../serializer-output-bindings/transform.mjs', '../serializer-comment-type-names/sources.lock.json',
    '../jvm-utility-source-profile/prepare.mjs', '../jvm-utility-source-profile/references.mjs', '../jvm-utility-source-profile/sources.lock.json']) {
    const bytes = await readFile(path.join(here, logical)); dependencies.push({ path: logical, bytes: bytes.length, sha256: sha256(bytes), gitBlob: gitBlob(bytes) });
}
const lock = { schemaVersion: 1, kind: 'unreachable-distribution-path-source-profile', source: primary.source,
    primaryClosureSha256: sha256(primaryBytes), targets, declarations: DECLARATIONS, symbols: SYMBOLS, facades: FACADES,
    homonymConsumer: primary.files.find(pin => pin.path === HOMONYM), deferredIncoming: primary.files.find(pin => pin.path === DEFERRED),
    recordedPropertyImports: JSON.parse(await readFile(path.join(here, '../serializer-comment-type-names/sources.lock.json'))).recordedPropertyImports, dependencies };
await writeFile(path.join(here, 'sources.lock.json'), JSON.stringify(lock, null, 2) + '\n');
console.log(JSON.stringify({ targets: targets.length, commonOutputs: 0, netSources: -3, sourceLockSha256: sha256(Buffer.from(JSON.stringify(lock, null, 2) + '\n')) }));

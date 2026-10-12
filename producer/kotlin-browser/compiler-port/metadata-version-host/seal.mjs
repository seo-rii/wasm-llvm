import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256, gitBlob, writeJson } from '../../scripts/source.mjs';
import { TARGET, RECIPE, transformMetadataVersion } from './transform.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const closureBytes = await readRegular(path.join(HERE, '../closure.lock.json')), closure = JSON.parse(closureBytes);
const original = closure.files.find(row => row.path === TARGET), bytes = await readRegular(path.join(REPO, 'out/kotlin-compiler-port/sources', TARGET));
if (sha256(bytes) !== original.sha256) throw new Error('Original metadata helper pin differs');
const common = transformMetadataVersion(bytes), dependencies = [];
for (const name of ['prepare.mjs', 'transform.mjs', '../../scripts/source.mjs', '../tower-group/transform.mjs']) {
    const bytes = await readRegular(path.join(HERE, name)); dependencies.push({ path: name, bytes: bytes.length, sha256: sha256(bytes), gitBlob: gitBlob(bytes) });
}
await writeJson(path.join(HERE, 'sources.lock.json'), { schemaVersion: 1, kind: 'genuine-metadata-version-host', source: closure.source,
    primaryClosureSha256: sha256(closureBytes), original, output: { path: TARGET, bytes: common.length, sha256: sha256(common), gitBlob: gitBlob(common) },
    recipe: RECIPE, dependencies });

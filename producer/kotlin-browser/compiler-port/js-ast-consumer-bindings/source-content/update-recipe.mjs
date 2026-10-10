import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitBlob, readRegular, sha256 } from '../../../scripts/source.mjs';
import { UTILS, sourceContentBinding } from './transform.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../../..');
async function pin(name) { const bytes = await readRegular(path.join(HERE, name)); return { path: name, bytes: bytes.length, sha256: sha256(bytes), gitBlob: gitBlob(bytes) }; }
const closureBytes = await readRegular(path.join(HERE, '../../closure.lock.json')), closure = JSON.parse(closureBytes);
const names = [UTILS, 'compiler/config/src/org/jetbrains/kotlin/config/CompilerConfiguration.kt', 'compiler/config/src/org/jetbrains/kotlin/config/CompilerConfigurationKey.kt',
    'compiler/frontend.common/src/org/jetbrains/kotlin/KtSourceFile.kt', 'compiler/ir/backend.js/src/org/jetbrains/kotlin/ir/backend/js/utils/JsGenerationContext.kt',
    'compiler/ir/backend.js/src/org/jetbrains/kotlin/ir/backend/js/utils/JsStaticContext.kt', 'compiler/ir/backend.js/src/org/jetbrains/kotlin/ir/backend/js/JsIrBackendContext.kt'];
const original = await readRegular(path.join(REPO, 'out/kotlin-compiler-port/sources', UTILS)), bound = sourceContentBinding(original);
const lock = { schemaVersion: 1, kind: 'pinned-request-source-content-binding', source: closure.source, primaryClosureSha256: sha256(closureBytes),
    sources: names.map(name => { const pin = closure.files.find(item => item.path === name); if (!pin) throw new Error('Missing pinned source ' + name); return pin; }),
    originalBodySha256: sha256(Buffer.from(bound.originalBody)), prepared: { bytes: bound.bytes.length, sha256: sha256(bound.bytes), gitBlob: gitBlob(bound.bytes) },
    provider: await pin('RequestSourceContent.kt'),
    dependencies: await Promise.all(['../../config/sources.lock.json', '../../config/prepare.mjs', '../../config/ConfigurationHost.kt', '../../host/sources.lock.json',
        '../../host/patches/source-host.patch', '../../js-ast/portable/org/jetbrains/kotlin/js/util/AstSourceReader.kt', '../../js-ast/sources.lock.json'].map(pin)),
    tools: await Promise.all(['prepare.mjs', 'transform.mjs', 'check.mjs', 'integrity.test.mjs', 'update-recipe.mjs'].map(pin)),
    observers: await Promise.all(['Probe.kt', 'JvmEntry.kt', 'WasmEntry.kt', 'RawTextProbe.kt', 'CommonSupport.kt', 'OriginalSupport.kt'].map(pin)),
    fullCompilerBuilt: false, languageReadiness: false };
await writeFile(path.join(HERE, 'sources.lock.json'), JSON.stringify(lock, null, 2) + '\n');

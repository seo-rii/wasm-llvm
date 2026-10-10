import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitBlob, readRegular, sha256 } from '../../scripts/source.mjs';
import { bindSourceMapJson, JSON_SOURCE, ECMA_SOURCE } from './transform.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
async function pin(name) { const bytes = await readRegular(path.join(HERE, name)); return { path: name, bytes: bytes.length, sha256: sha256(bytes), gitBlob: gitBlob(bytes) }; }
const audit = path.join(REPO, 'out/kotlin-js-source-map-audit'), inventory = JSON.parse(await readRegular(path.join(audit, 'inventory.json')));
const closureBytes = await readRegular(path.join(HERE, '../closure.lock.json')), closure = JSON.parse(closureBytes);
const originals = [JSON_SOURCE, ECMA_SOURCE];
const sources = originals.map(name => ({ ...inventory.files.find(pin => pin.path === name), language: 'kotlin', compile: true, role: 'source', module: 'js/js.parser' }));
const tests = inventory.files.filter(pin => pin.path.startsWith('js/js.parser/test/'));
const tree = JSON.parse(await readRegular(path.join(audit, 'tree.json'))), directories = new Set(['']);
for (const pin of [...sources, ...tests]) {
    let directory = path.posix.dirname(pin.path.slice(3));
    while (directory !== '.') { directories.add(directory); directory = path.posix.dirname(directory); }
}
const treeProof = [...directories].sort().map(directory => ({ path: directory,
    sha: directory ? tree.tree.find(entry => entry.path === directory).sha : tree.sha,
    entries: tree.tree.filter(entry => path.posix.dirname(entry.path) === (directory || '.'))
        .map(entry => ({ name: path.posix.basename(entry.path), type: entry.type, mode: entry.mode, sha: entry.sha,
            ...(entry.size !== undefined ? { size: entry.size } : {}) }))
        .sort((a, b) => Buffer.compare(Buffer.from(a.name + (a.type === 'tree' ? '/' : '')), Buffer.from(b.name + (b.type === 'tree' ? '/' : '')))) }));
const ast = JSON.parse(await readRegular(path.join(HERE, '../js-ast/sources.lock.json'))), number = ast.portable.find(pin => pin.path.endsWith('/AstDoubleFormat.kt'));
const prepared = await Promise.all(sources.map(async source => {
    const bound = bindSourceMapJson(source.path, await readRegular(path.join(audit, 'sources', source.path)));
    return { path: 'compiler-port-source-map-json/' + source.path, originalPath: source.path, bytes: bound.bytes.length, sha256: sha256(bound.bytes), gitBlob: gitBlob(bound.bytes) };
}));
const lock = { schemaVersion: 1, kind: 'genuine-source-map-json-ecma-foundation', source: closure.source, primaryClosureSha256: sha256(closureBytes),
    jsTree: closure.treeSnapshots.find(pin => pin.path === 'js'), treeProof, sources, tests, prepared, numberSource: number,
    sharedDependencies: [{ component: 'jsAstReceipt', path: number.outputPath, bytes: number.bytes, sha256: number.sha256, gitBlob: number.gitBlob }],
    dependencies: await Promise.all(['test-libraries.lock.json', '../js-ast/sources.lock.json', '../js-ast/portable/org/jetbrains/kotlin/js/util/AstDoubleFormat.kt',
        '../js-ast/numbers/source.lock.json', '../js-ast/numbers/evidence/receipt.json', '../js-ast/numbers/build-probe.mjs'].map(pin)),
    tools: await Promise.all(['transform.mjs', 'prepare.mjs', 'check.mjs', 'integrity.test.mjs', 'tools.mjs', 'verify-tree.mjs', 'update-recipe.mjs'].map(pin)),
    observers: await Promise.all(['Probe.kt', 'JvmEntry.kt', 'WasmEntry.kt'].map(pin)), originalMethodsRemoved: false,
    originalIndexSectionsSupported: false, parserRuntimeBuilt: false, fullCompilerBuilt: false, languageReadiness: false };
await writeFile(path.join(HERE, 'sources.lock.json'), JSON.stringify(lock, null, 2) + '\n');

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { inventory } from '../scripts/audit.mjs';
import { fixtureLedger } from '../scripts/fixtures.mjs';
import { declarations, projectDirectories, stronglyConnectedComponents } from '../scripts/gradle.mjs';
import { gitBlob, json, readJson, readVerifiedSources, sha256, validateLock, verifyFile, writeJson } from '../scripts/source.mjs';
import { publishedWasmJsVariants, verifyPublishedMetadata, verifyToolDeclarations } from '../scripts/tools.mjs';

const execute = promisify(execFile);
const pin = (filename, bytes) => ({ path: filename, gitBlob: gitBlob(bytes), bytes: bytes.length, sha256: sha256(bytes) });
function inputs(extra = {}) {
  const files = new Map(Object.entries({
    'settings.gradle.kts': 'include(":compiler:ir.tree", ":compiler:ir.tree:generator", ":compiler:backend.wasm")\nproject(":compiler:ir.tree").projectDir = File("$rootDir/compiler/ir/ir.tree")\nproject(":compiler:backend.wasm").projectDir = file("$rootDir/compiler/ir/backend.wasm")\n',
    'compiler/ir/ir.tree/build.gradle.kts': 'plugins { kotlin("jvm") }\ndependencies { api(project(":compiler:backend.wasm"))\n testImplementation(project(":test-only")) }\n',
    'compiler/ir/backend.wasm/build.gradle.kts': 'dependencies { implementation(project(":compiler:ir.tree"))\n api(libs.kotlin.stdlib)\n implementation(project(variable)) }\n',
    ...extra
  }).map(([filename, text]) => [filename, Buffer.from(text)]));
  const lock = { schemaVersion: 1, source: { repository: 'https://github.com/JetBrains/kotlin.git', commit: 'a'.repeat(40), treeSha: 'b'.repeat(40) },
    files: [...files].map(([filename, bytes]) => pin(filename, bytes)), roots: [':compiler:backend.wasm'] };
  return { files, lock };
}

test('reads explicit projectDir mappings, literal dots, and inherited parent paths', () => {
  const { files } = inputs();
  const mapped = projectDirectories(files.get('settings.gradle.kts').toString());
  assert.equal(mapped.projects.get(':compiler:ir.tree'), 'compiler/ir/ir.tree');
  assert.equal(mapped.projects.get(':compiler:ir.tree:generator'), 'compiler/ir/ir.tree/generator');
  assert.equal(mapped.projects.get(':compiler:backend.wasm'), 'compiler/ir/backend.wasm');
  assert.deepEqual(mapped.unresolved, []);
  const dynamic = projectDirectories('include(":x")\nproject(":x").projectDir = chooseDirectory()');
  assert.equal(dynamic.projects.has(':x'), false);
  assert.equal(dynamic.unresolved[0].kind, 'dynamic-project-directory');
  const include = projectDirectories('include(":prefix" + suffix, *entries, ":fixed")');
  assert.equal(include.projects.has(':prefix'), false);
  assert.equal(include.projects.get(':fixed'), 'fixed');
  assert.equal(include.unresolved.filter((item) => item.kind === 'dynamic-project-include').length, 2);
});

test('distinguishes main declarations from test configurations and test source sets', () => {
  const result = declarations(`
    plugins { kotlin("multiplatform") }
    kotlin { jvm(); wasmJs { browser() }; sourceSets {
      val commonMain by getting { dependencies { api(project(":main")) } }
      val commonTest by getting { dependencies { implementation(project(":test")) } }
      named("wasmJsTest") { dependencies { api(project(":wasm-test")) } }
    } }
    dependencies {
      testRuntimeOnly(project(":runtime-test"))
      api(project(path = ":shared", configuration = "runtimeElements"))
      api(project(":selected", configuration = "runtimeElements"))
      implementation(testFixtures(project(":production-fixture-variant")))
      // api(project(":comment"))
      implementation("group:artifact:1")
    }
    /* nested /* project(":ignored") */ comment */
    val source = "project(\\\":string\\\")"
  `);
  assert.deepEqual(result.projects.map((item) => item.project), [':main', ':shared', ':selected', ':production-fixture-variant']);
  assert.deepEqual(result.projects.at(-1).wrappers, ['testFixtures']);
  assert.equal(result.projects.at(-1).configuration, 'implementation');
  assert.deepEqual(result.ignoredTestProjects.map((item) => item.project), [':test', ':wasm-test', ':runtime-test']);
  assert.deepEqual(result.declaredTargets, ['jvm', 'wasmJs']);
  assert.deepEqual(result.sourceSets, ['commonMain', 'commonTest', 'wasmJsTest']);
  assert.equal(result.unresolved.filter((item) => item.kind === 'external-or-helper-dependency').length, 1);
});

test('records a source-verified declared cycle without claiming resolved variants or G0 success', () => {
  const { files, lock } = inputs();
  const report = inventory(lock, files);
  assert.equal(report.summary.projects, 2);
  assert.equal(report.summary.productionProjectEdges, 2);
  assert.equal(report.summary.ignoredTestDeclarations, 1);
  assert.deepEqual(report.components, [[':compiler:backend.wasm', ':compiler:ir.tree']]);
  assert.equal(report.gates.G0.status, 'blocked');
  assert.equal(report.gates.G0.passed, false);
  assert.equal(report.readiness.ready, false);
  assert.ok(report.unresolved.some((item) => item.kind === 'dynamic-project-dependency'));
  assert.ok(report.unresolved.some((item) => item.kind === 'external-or-helper-dependency'));
  for (const module of report.modules) assert.equal(module.variants.selectedWasmVariant, null);
  assert.equal(json(inventory(lock, new Map([...files].reverse()))), json(report));
});

test('keeps unresolved module nodes rather than silently dropping dependency edges', () => {
  const { files, lock } = inputs({ 'compiler/ir/backend.wasm/build.gradle.kts': 'dependencies { api(project(":not-in-settings")) }' });
  const report = inventory(lock, files);
  assert.ok(report.modules.some((item) => item.project === ':not-in-settings' && item.status === 'blocked'));
  assert.ok(report.unresolved.some((item) => item.kind === 'project-directory-unresolved'));
  const graph = new Map([['a', ['a', 'b']], ['b', ['c']], ['c', ['b']], ['d', []]]);
  assert.deepEqual(stronglyConnectedComponents(graph), [['a'], ['b', 'c'], ['d']]);
});

test('rejects wrong pins, missing files, duplicate paths, traversal, and changed content', () => {
  const { files, lock } = inputs();
  assert.throws(() => validateLock(lock, { schemaVersion: 1, source: { ...lock.source, commit: 'c'.repeat(40) } }), /mismatch/);
  const duplicate = structuredClone(lock);
  duplicate.files.push(duplicate.files[0]);
  assert.throws(() => validateLock(duplicate), /Duplicate/);
  const traversal = structuredClone(lock);
  traversal.files[0].path = '../outside';
  assert.throws(() => validateLock(traversal), /relative path/);
  const absent = new Map(files);
  absent.delete('settings.gradle.kts');
  assert.throws(() => inventory(lock, absent), /Missing verified source/);
  const changed = new Map(files);
  changed.set('settings.gradle.kts', Buffer.from('tampered'));
  assert.throws(() => inventory(lock, changed), /content mismatch/);
  assert.throws(() => verifyFile(Buffer.from('tampered'), lock.files[0]), /content mismatch/);
});

test('remote reader checks the commit/tree and each locked Git blob and SHA-256', async () => {
  const { files, lock } = inputs();
  let tampered = false;
  const fetcher = async (url) => {
    if (url.includes('/git/commits/')) return new Response(JSON.stringify({ sha: lock.source.commit, tree: { sha: lock.source.treeSha } }));
    const filename = decodeURIComponent(url.split(lock.source.commit + '/')[1]);
    return new Response(tampered ? 'changed' : files.get(filename));
  };
  assert.deepEqual([...await readVerifiedSources(lock, { fetcher })], [...files]);
  tampered = true;
  await assert.rejects(readVerifiedSources(lock, { fetcher }), /pinned size|content mismatch/);
  await assert.rejects(readVerifiedSources(lock, { fetcher: async () => new Response(JSON.stringify({ sha: '0'.repeat(40), tree: { sha: lock.source.treeSha } })) }), /commit\/tree/);
});

test('local reader checks checkout identity and detects assume-unchanged edits and symlinks', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kotlin-audit-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const { files, lock } = inputs();
  for (const [filename, bytes] of files) {
    await mkdir(path.dirname(path.join(directory, filename)), { recursive: true });
    await writeFile(path.join(directory, filename), bytes);
  }
  const git = async (args) => (await execute('git', args, { cwd: directory })).stdout.trim();
  await git(['init', '--quiet']);
  await git(['add', '.']);
  await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'test']);
  lock.source.commit = await git(['rev-parse', 'HEAD']);
  lock.source.treeSha = await git(['rev-parse', 'HEAD^{tree}']);
  assert.deepEqual([...await readVerifiedSources(lock, { sourceDir: directory })], [...files]);
  await git(['update-index', '--assume-unchanged', 'settings.gradle.kts']);
  await writeFile(path.join(directory, 'settings.gradle.kts'), 'tampered');
  await assert.rejects(readVerifiedSources(lock, { sourceDir: directory }), /content mismatch/);
  await rm(path.join(directory, 'settings.gradle.kts'));
  await writeFile(path.join(directory, 'outside'), files.get('settings.gradle.kts'));
  await symlink('outside', path.join(directory, 'settings.gradle.kts'));
  await assert.rejects(readVerifiedSources(lock, { sourceDir: directory }), /Symlink/);
});

test('fixture ledger verifies exact upstream input bytes and never invents baseline results', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kotlin-fixture-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('\uFEFFfun main() { println("한글🦀") }\r\n');
  const { lock } = inputs({ 'compiler/fir/testData/unicode.kt': bytes.toString() });
  lock.fixtures = [{ id: 'KT-UNICODE', file: 'fixtures/unicode.kt', category: 'unicode', origin: 'upstream-parser', upstreamPath: 'compiler/fir/testData/unicode.kt' }];
  await mkdir(path.join(directory, 'fixtures'));
  await writeFile(path.join(directory, 'fixtures/unicode.kt'), bytes);
  const ledger = await fixtureLedger(lock, { root: directory });
  assert.equal(ledger.totals.required, 1);
  assert.equal(ledger.totals.notRun, 1);
  assert.equal(ledger.totals.passed, 0);
  assert.equal(ledger.cases[0].input.sha256, sha256(bytes));
  for (const result of Object.values(ledger.cases[0].executions)) {
    assert.equal(result.status, 'not-run');
    assert.equal(result.result, null);
  }
  const output = path.join(directory, 'ledger.json');
  await writeJson(output, ledger);
  assert.deepEqual(await readJson(output), ledger);
  await writeFile(path.join(directory, 'fixtures/unicode.kt'), bytes.toString().replaceAll('\r\n', '\n'));
  await assert.rejects(fixtureLedger(lock, { root: directory }), /content mismatch/);
});

test('tool declarations are checked against locked source bytes instead of trusting claimed versions', () => {
  const files = new Map([
    ['gradle.properties', Buffer.from('bootstrap.kotlin.default.version=2.5.0-dev-test\n')],
    ['wrapper.properties', Buffer.from('distributionUrl=https\\://example.invalid/gradle-9.7.1-bin.zip\ndistributionSha256Sum=' + '1'.repeat(64) + '\n')]
  ]);
  const lock = { toolAndArtifactDeclarations: [
    { name: 'bootstrap-compiler', sourcePath: 'gradle.properties', version: '2.5.0-dev-test', artifactBytesVerified: false },
    { name: 'gradle', sourcePath: 'wrapper.properties', version: '9.7.1', declaredArchiveSha256: '1'.repeat(64), artifactBytesVerified: false }
  ] };
  verifyToolDeclarations(lock, files);
  const changed = structuredClone(lock);
  changed.toolAndArtifactDeclarations[0].version = '2.2.20';
  assert.throws(() => verifyToolDeclarations(changed, files), /version\/verification claim/);
  changed.toolAndArtifactDeclarations[0] = lock.toolAndArtifactDeclarations[0];
  changed.toolAndArtifactDeclarations[1].declaredArchiveSha256 = '2'.repeat(64);
  assert.throws(() => verifyToolDeclarations(changed, files), /checksum mismatch/);
});

test('downloaded module metadata confirms published declarations while leaving KLIB bytes unverified', async () => {
  const metadata = { variants: [{ name: 'wasmJsRuntimeElements-published',
    attributes: { 'org.jetbrains.kotlin.platform.type': 'wasm', 'org.jetbrains.kotlin.wasm.target': 'js' },
    files: [{ name: 'library.klib', size: 100, sha256: 'a'.repeat(64) }] }] };
  const bytes = Buffer.from(json(metadata));
  const lock = { toolAndArtifactDeclarations: [{ name: 'published-module-metadata',
    url: 'https://packages.jetbrains.team/maven/p/ij/intellij-dependencies/example/test.module',
    metadataBytes: bytes.length, metadataSha256: sha256(bytes), publishedWasmJsVariants: publishedWasmJsVariants(metadata) }] };
  const result = await verifyPublishedMetadata(lock, { fetcher: async () => new Response(bytes) });
  assert.equal(result[0].status, 'pass');
  assert.equal(result[0].selectedGradleVariant, null);
  assert.equal(result[0].artifactBytesVerified, false);
  assert.equal(result[0].publishedWasmJsVariants[0].files[0].artifactBytesVerified, false);
  await assert.rejects(verifyPublishedMetadata(lock, { fetcher: async () => new Response('{}') }), /content mismatch/);
});

test('atomic evidence publication rejects existing output and preserves its bytes', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kotlin-evidence-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'receipt.json');
  const original = Buffer.from('{"observed":"original"}\n');
  await writeFile(output, original);
  await assert.rejects(writeJson(output, { observed: 'replacement' }), { code: 'EEXIST' });
  assert.deepEqual(await readFile(output), original);
  await rm(output);
  await writeJson(output, { observed: 'new' });
  assert.deepEqual(await readJson(output), { observed: 'new' });
});

test('checked-in fixture ledger keeps every baseline unexecuted and matches checked-in source pins', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const lock = JSON.parse(await readFile(path.join(root, 'sources.lock.json'), 'utf8'));
  const ledger = await fixtureLedger(lock, { root });
  const stored = JSON.parse(await readFile(path.join(root, 'evidence/fixture-ledger.json'), 'utf8'));
  assert.deepEqual(ledger, stored);
  assert.equal(ledger.totals.passed, 0);
  assert.equal(ledger.totals.notRun, ledger.totals.required);
});

import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { preparePositioningSources, defaultPositioningSourceRoot } from './prepare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const recipe = JSON.parse(await readFile(path.join(here, 'positioning.recipe.json'), 'utf8'));
const canonical = path.join(repository, 'out/kotlin-compiler-port/sources');
async function fixture(t) {
    const root = await mkdtemp(path.join(repository, 'out/positioning-guard-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const sourceRoot = path.join(root, 'source'); const positioningSourceRoot = path.join(root, 'additional');
    for (const pin of recipe.originals) {
        const base = pin.sourceRoot === 'compiler-closure' ? canonical : defaultPositioningSourceRoot;
        const targetRoot = pin.sourceRoot === 'compiler-closure' ? sourceRoot : positioningSourceRoot;
        const target = path.join(targetRoot, pin.path);
        await mkdir(path.dirname(target), { recursive: true }); await copyFile(path.join(base, pin.path), target);
    }
    await copyFile(path.join(defaultPositioningSourceRoot, 'positioning-cache.json'), path.join(positioningSourceRoot, 'positioning-cache.json'));
    return { root, sourceRoot, positioningSourceRoot, outputRoot: path.join(root, 'output') };
}

test('exact legacy declarations and light-tree strategy registrations remain complete without token mapping', async (t) => {
    const options = await fixture(t); const prepared = await preparePositioningSources(options);
    assert.equal(prepared.commonSources.length, 23);
    assert.equal(prepared.receipt.sourceStrategyCount, 93);
    assert.deepEqual(prepared.receipt.declarations, recipe.declarations);
    assert.equal(prepared.receipt.placeholderBridge, 'retained-unchanged');
    assert.equal(prepared.receipt.kmpSyntaxToLegacyTokenMapping, 'absent');
    assert.equal(prepared.receipt.differentialStatus, 'not-run');
    assert.equal(prepared.receipt.languageReadiness, false);
    const bridge = recipe.originals.find((pin) => pin.path.endsWith('/KotlinLightTreeStructure.kt'));
    assert.deepEqual(await readFile(path.join(options.sourceRoot, bridge.path)), await readFile(path.join(canonical, bridge.path)));
    const strategies = await readFile(prepared.commonSources.find((file) => file.endsWith('/LightTreePositioningStrategies.kt')), 'utf8');
    assert(strategies.includes('val UNREACHABLE_CODE'));
    assert(strategies.includes('diagnostic as KtDiagnosticWithParameters2<Set<KtSourceElement>, Set<KtSourceElement>>'));
    assert(!strategies.includes('import com.intellij.lang.LighterASTNode'));
    assert(strategies.includes('when (node.tokenType)'));
    const tokens = await readFile(prepared.commonSources.find((file) => file.endsWith('/KtTokens.kt')), 'utf8');
    assert(tokens.includes('KtSingleValueToken("SEMICOLON", ";", SEMICOLON_Id)'));
    assert(tokens.includes('KtSingleValueToken("DOUBLE_SEMICOLON", ";;", DOUBLE_SEMICOLON_Id)'));
});

test('oversized original positioning source fails before publishing output or receipt', async (t) => {
    const options = await fixture(t); const pin = recipe.originals.find((pin) => pin.path.endsWith('/LightTreePositioningStrategies.kt'));
    await writeFile(path.join(options.positioningSourceRoot, pin.path), Buffer.alloc(pin.bytes + 1));
    await assert.rejects(preparePositioningSources(options));
    await assert.rejects(readFile(path.join(options.outputRoot, 'compiler-port-positioning/positioning-inputs.json')), { code: 'ENOENT' });
});

test('same-sized changed source and symlink replacement cannot masquerade as official source', async (t) => {
    const options = await fixture(t); const pin = recipe.originals.find((pin) => pin.path.endsWith('/KtTokens.java'));
    const target = path.join(options.positioningSourceRoot, pin.path); const original = await readFile(target);
    const changed = Buffer.from(original); changed[0] ^= 1; await writeFile(target, changed);
    await assert.rejects(preparePositioningSources(options));
    await rm(target); await symlink(path.join(defaultPositioningSourceRoot, pin.path), target);
    await assert.rejects(preparePositioningSources(options));
});

test('output symlinks, cache nesting, and existing output files fail without success publication', async (t) => {
    const options = await fixture(t);
    await mkdir(path.join(options.root, 'other')); await symlink(path.join(options.root, 'other'), options.outputRoot);
    await assert.rejects(preparePositioningSources(options)); await rm(options.outputRoot);
    await assert.rejects(preparePositioningSources({ ...options, outputRoot: path.join(options.sourceRoot, 'nested') }));
    const destination = path.join(options.outputRoot, 'compiler-port-positioning/KtTokens.kt');
    await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, 'existing');
    await assert.rejects(preparePositioningSources(options)); assert.equal(await readFile(destination, 'utf8'), 'existing');
    await assert.rejects(readFile(path.join(options.outputRoot, 'compiler-port-positioning/positioning-inputs.json')), { code: 'ENOENT' });
});

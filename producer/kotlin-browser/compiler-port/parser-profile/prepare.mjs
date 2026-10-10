import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile } from '../../scripts/source.mjs';
import { prepareParserProfileSourceCache } from './fetch.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const execute = promisify(execFile);
const forbidden = /\b(?:LightTree2Fir|LightTreeRawFirDeclarationBuilder|AbstractLightTreeRawFirBuilder|toKotlinParsingErrorListener|kmpId|buildFirFromKtFiles|buildResolveAndCheckFirFromKtFiles)\b/;

export async function prepareParserProfileSources({ sourceRoot, outputRoot, supplementalSourceRoot } = {}) {
    assert(sourceRoot && outputRoot, 'sourceRoot and outputRoot required');
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep), 'Parser profile output must stay under repository out/');
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep) && !outputRoot.startsWith(sourceRoot + path.sep), 'Do not modify the original source cache');
    await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot);
    const recipeBytes = await readRegular(path.join(here, 'parser-profile.recipe.json'));
    const recipe = JSON.parse(recipeBytes);
    assert.equal(recipe.schemaVersion, 1); assert.equal(recipe.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
    const closureBytes = await readRegular(path.join(here, '../closure.lock.json'));
    assert.equal(sha256(closureBytes), recipe.sourceClosureLockSha256, 'Source closure lock changed');
    const closure = JSON.parse(closureBytes);
    assert.deepEqual(closure.source, recipe.source);
    const sourceFiles = new Map();
    for (const pin of closure.files) {
        const bytes = verifyFile(await readRegular(path.join(sourceRoot, relativePath(pin.path)), pin.bytes), pin);
        sourceFiles.set(pin.path, { pin, bytes });
    }
    for (const pin of recipe.originals) {
        const actual = sourceFiles.get(pin.path);
        assert(actual, 'Missing parser profile input: ' + pin.path);
        verifyFile(actual.bytes, pin);
    }
    const hostLockBytes = await readRegular(path.join(here, '../host/sources.lock.json'));
    assert.equal(sha256(hostLockBytes), recipe.hostContract.sourceLockSha256, 'Host profile contract changed');
    const host = JSON.parse(hostLockBytes);
    const hostPatch = await readRegular(path.join(here, '../host', relativePath(host.patch.path)), host.patch.bytes);
    assert.equal(sha256(hostPatch), host.patch.sha256, 'Host profile patch changed');
    for (const required of recipe.hostContract.sources) {
        const pin = host.sources.find((item) => item.path === required.path);
        assert(pin && pin.portableBytes === required.bytes && pin.portableSha256 === required.sha256, 'Host source contract mismatch');
    }
    if (!supplementalSourceRoot) supplementalSourceRoot = (await prepareParserProfileSourceCache()).supplementalSourceRoot;
    supplementalSourceRoot = path.resolve(supplementalSourceRoot);
    await assertNoSymlink(supplementalSourceRoot);
    const supplemental = new Map();
    for (const pin of recipe.supplementalSources) supplemental.set(pin.path,
        verifyFile(await readRegular(path.join(supplementalSourceRoot, relativePath(pin.path)), pin.bytes), pin));
    const patchPath = path.join(here, relativePath(recipe.patch.path));
    const patch = await readRegular(patchPath, recipe.patch.bytes);
    assert.equal(patch.byteLength, recipe.patch.bytes); assert.equal(sha256(patch), recipe.patch.sha256);
    const helperPin = recipe.portable[0];
    const helperBytes = await readRegular(path.join(here, relativePath(helperPin.path)), helperPin.bytes);
    assert.equal(helperBytes.byteLength, helperPin.bytes); assert.equal(sha256(helperBytes), helperPin.sha256);
    const originals = new Map(recipe.originals.map((pin) => [pin.path, sourceFiles.get(pin.path).bytes.toString('utf8')]));
    const declarations = [];
    for (const record of recipe.declarations) {
        const text = (originals.has(record.sourcePath) ? Buffer.from(originals.get(record.sourcePath)) : supplemental.get(record.sourcePath)).toString('utf8');
        const declaration = text.slice(record.startUtf16, record.endUtf16);
        assert.equal(Buffer.byteLength(declaration), record.bytes); assert.equal(sha256(Buffer.from(declaration)), record.sha256);
        declarations.push({ ...record, text: declaration });
    }
    const helperDeclaration = declarations.find((record) => record.name === 'AbstractTreeRawFirBuilder.unquoteIdentifier');
    const expectedHelper = helperDeclaration.text.split('\n').map((line) => line.startsWith('    ') ? line.slice(4) : line).join('\n')
        .replace('private fun unquoteIdentifier(', 'internal fun unquoteParserIdentifier(');
    assert(helperBytes.toString('utf8').includes(expectedHelper), 'Pure Kotlin helper body differs from selected source');
    const root = path.join(outputRoot, 'compiler-port-parser-profile');
    await assertNoSymlink(root); await mkdir(outputRoot, { recursive: true }); await mkdir(root, { recursive: false });
    const commands = [];
    for (const pin of recipe.transformed) {
        const filename = path.join(root, relativePath(pin.originalPath));
        await assertNoSymlink(filename); await mkdir(path.dirname(filename), { recursive: true });
        await writeFile(filename, sourceFiles.get(pin.originalPath).bytes, { flag: 'wx', mode: 0o600 });
    }
    for (const args of [['init', '--quiet'], ['apply', '--check', patchPath], ['apply', patchPath], ['apply', '--reverse', '--check', patchPath]]) {
        await execute('git', args, { cwd: root, timeout: 10000, maxBuffer: 65536 });
        commands.push({ argv: ['git', ...args], exitCode: 0 });
    }
    const commonSources = [];
    const transformed = new Map();
    for (const pin of recipe.transformed) {
        const filename = path.join(root, pin.originalPath);
        const bytes = await readRegular(filename, pin.bytes);
        assert.equal(bytes.byteLength, pin.bytes); assert.equal(sha256(bytes), pin.sha256, 'Portable parser source differs');
        transformed.set(pin.originalPath, bytes.toString('utf8'));
        commonSources.push(filename);
    }
    const preservedResolution = declarations.find((record) => record.name === 'resolveAndCheckFir');
    const firUtils = transformed.get(preservedResolution.sourcePath);
    assert(firUtils.includes(preservedResolution.text), 'Resolution and common checker declaration changed');
    assert.equal(firUtils.split('MultiplatformParsing2Fir(this, firProvider.kotlinScopeProvider, diagnosticsReporter)').length, 2);
    assert(firUtils.indexOf('requireMultiplatformParser(useMultiplatformParsing)') < firUtils.indexOf('val firProvider ='));
    assert(firUtils.includes('useMultiplatformParsing = true'));
    assert(firUtils.includes('file.getContentsAsText()') && firUtils.includes('code.toSourceLinesMapping()'));
    assert(!firUtils.includes('getContentsAsStream') && !firUtils.includes('readSourceFileWithMapping'));
    assert(firUtils.includes('firProvider.recordFile(firFile)') && firUtils.includes('sourcesToPathsMapper.registerFileSource'));
    const excluded = new Set(recipe.exclusions.map((pin) => pin.path));
    assert.equal(excluded.size, 5, 'Only the five audited legacy files may be excluded');
    const callerAudit = [];
    for (const { pin, bytes } of sourceFiles.values()) {
        if (!pin.compile || !pin.path.endsWith('.kt') || excluded.has(pin.path)) continue;
        const text = transformed.get(pin.path) ?? bytes.toString('utf8');
        assert(!forbidden.test(text), 'Retained caller requires an excluded parser/PSI declaration: ' + pin.path);
        callerAudit.push({ path: pin.path, sha256: sha256(Buffer.from(text)) });
    }
    const helperOutput = path.join(root, helperPin.path);
    await assertNoSymlink(helperOutput); await writeFile(helperOutput, helperBytes, { flag: 'wx', mode: 0o600 });
    commonSources.push(helperOutput);
    const jvmOnly = declarations.filter((record) => record.role === 'jvm-only-reference');
    const reference = jvmOnly.map((record) => record.text).join('\n\n') + '\n';
    await writeFile(path.join(root, 'JvmFirConvenience.kt.reference'), reference, { flag: 'wx', mode: 0o600 });
    for (const pin of recipe.originals) verifyFile(await readRegular(path.join(sourceRoot, pin.path), pin.bytes), pin);
    const replacedOriginalPaths = recipe.transformed.map((pin) => pin.originalPath);
    const sourceSetExclusions = recipe.exclusions.map((pin) => pin.path);
    const receipt = { schemaVersion: 1, kind: 'official-new-parser-only-source-profile', source: recipe.source,
        recipeSha256: sha256(recipeBytes), sourceClosureLockSha256: sha256(closureBytes), patch: recipe.patch,
        originals: recipe.originals, supplementalSources: recipe.supplementalSources, portable: recipe.portable, transformed: recipe.transformed,
        retainedSharedSources: recipe.retainedSharedSources, retainedNewParserSources: recipe.retainedNewParserSources,
        exclusions: recipe.exclusions, declarations: declarations.map(({ text, ...record }) => record),
        hostContract: recipe.hostContract, replacedOriginalPaths, sourceSetExclusions, commands,
        callerAudit: { selectedKotlinFiles: callerAudit.length, inventorySha256: sha256(Buffer.from(JSON.stringify(callerAudit))), unsupportedRemainingCalls: 0 },
        resolutionDeclarationPreserved: true, platformCheckerSourcesUnmodified: true, syntaxDiagnosticHostPatchUnmodified: true,
        originalSourcesUnmodified: true, resolvedFirExecution: 'not-run', browserCompiler: 'not-built', languageReadiness: false };
    const receiptPath = path.join(root, 'parser-profile-inputs.json');
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { commonSources, replacedOriginalPaths, sourceSetExclusions, receiptPath, receipt };
}

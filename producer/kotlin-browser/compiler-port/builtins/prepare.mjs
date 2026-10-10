/** Verify and prepare the complete official builtins source port without mutating original sources. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = path.resolve(HERE, '../../../..');
const execute = promisify(execFile);
const JAVA = 'core/descriptors/src/org/jetbrains/kotlin/builtins/KotlinBuiltIns.java';
const LOADER = 'core/descriptors/src/org/jetbrains/kotlin/builtins/BuiltInsLoader.kt';

export async function prepareBuiltInsSources({ sourceRoot, outputRoot }) {
    assert(sourceRoot && outputRoot);
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(REPOSITORY, 'out') + path.sep), 'Builtins sources must be generated under out/');
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep), 'Do not change the original source cache');
    await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot);
    const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')); const lock = JSON.parse(lockBytes);
    assert.equal(lock.schemaVersion, 1); assert.equal(lock.kind, 'official-kotlin-builtins-common-source-port');
    assert.equal(lock.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
    assert.equal(lock.originalJavaPath, JAVA); assert.deepEqual(lock.replacedOriginalPaths, [JAVA, LOADER]);
    assert.equal(lock.sources.length, 10); assert.equal(new Set(lock.sources.map(pin => pin.path)).size, 10);
    assert.equal(lock.methods.length, 169); assert.equal(lock.getterAliases.length, 63);
    const originals = [];
    for (const pin of lock.sources) {
        relativePath(pin.path);
        originals.push({ pin, bytes: verifyFile(await readRegular(path.join(sourceRoot, pin.path), pin.bytes), pin) });
    }
    const generator = await readRegular(path.join(HERE, relativePath(lock.generator.path)));
    assert.equal(sha256(generator), lock.generator.sha256, 'Builtins generator changed');
    const base = await readRegular(path.join(HERE, relativePath(lock.portable.path)));
    assert.equal(base.length, lock.portable.bytes); assert.equal(sha256(base), lock.portable.sha256, 'Builtins source changed');
    const declared = [...base.toString().matchAll(/\bfun (\w+)\(/g)].map(match => match[1]).sort();
    assert.deepEqual(declared, lock.methods.filter(method => method.name !== 'KotlinBuiltIns').map(method => method.name).sort(),
        'The common class must preserve every original method and overload');
    assert.equal(base.toString().split('    // GENERATED_GETTER_ALIASES').length, 2);
    const aliasNames = new Set();
    const aliases = lock.getterAliases.map(({ method, property, type }) => {
        assert(/^get[A-Z][a-zA-Z0-9]*$/.test(method) && /^[a-z][a-zA-Z0-9]*$/.test(property));
        assert(['ClassDescriptor', 'SimpleType', 'KotlinType'].includes(type));
        assert(!aliasNames.has(property)); aliasNames.add(property);
        const original = lock.methods.find(item => item.name === method);
        assert(original && original.returnType === type && !original.static && !original.parameters.length && original.visibility === 'public');
        return `    @get:JvmName("${property}Property")\n    val ${property}: ${type} get() = ${method}()`;
    }).join('\n');
    const portable = Buffer.from(base.toString().replace('    // GENERATED_GETTER_ALIASES', aliases));
    assert.equal(portable.length, lock.portable.outputBytes); assert.equal(sha256(portable), lock.portable.outputSha256);
    const patchFile = path.join(HERE, relativePath(lock.patch.path)); const patch = await readRegular(patchFile);
    assert.equal(patch.length, lock.patch.bytes); assert.equal(sha256(patch), lock.patch.sha256);
    const originalLoader = originals.find(({ pin }) => pin.path === LOADER);
    const loaderPath = path.join(outputRoot, LOADER);
    await assertNoSymlink(loaderPath); await mkdir(path.dirname(loaderPath), { recursive: true, mode: 0o700 });
    await writeFile(loaderPath, originalLoader.bytes, { flag: 'wx', mode: 0o600 });
    const commands = [];
    for (const args of [['apply', '--check', patchFile], ['apply', patchFile], ['apply', '--reverse', '--check', patchFile]]) {
        await execute('git', args, { cwd: outputRoot, timeout: 10000, maxBuffer: 65536 });
        commands.push({ command: 'git', args, exitCode: 0 });
    }
    const loader = await readRegular(loaderPath);
    assert.equal(loader.length, lock.patchedLoader.bytes); assert.equal(sha256(loader), lock.patchedLoader.sha256);
    const portablePath = path.join(outputRoot, relativePath(lock.portable.outputPath));
    await assertNoSymlink(portablePath); await mkdir(path.dirname(portablePath), { recursive: true, mode: 0o700 });
    await writeFile(portablePath, portable, { flag: 'wx', mode: 0o600 });
    for (const { pin, bytes } of originals) assert.deepEqual(await readRegular(path.join(sourceRoot, pin.path), pin.bytes), bytes, 'Original source was changed');
    const receipt = { schemaVersion: 1, kind: 'official-kotlin-builtins-common-source-preparation', source: lock.source,
        sourceLockSha256: sha256(lockBytes), preparationToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
        sourceFiles: lock.sources, patch: lock.patch, portable: lock.portable,
        methods: 168, originalConstructors: 1, syntheticGetterAliases: 70, generatedGetterAliases: 63,
        originalSourceUnmodified: true, commands, replacedOriginalPaths: lock.replacedOriginalPaths,
        files: [{ path: lock.portable.outputPath, bytes: portable.length, sha256: sha256(portable) },
            { path: LOADER, bytes: loader.length, sha256: sha256(loader) }],
        semantics: lock.semantics,
        concreteDependencies: ['StorageManager', 'ModuleDescriptorImpl', 'BuiltInFictitiousFunctionClassFactory',
            'BuiltInsPackageFragment', 'StandardNames', 'UnsignedTypes', 'DescriptorUtils', 'KotlinTypeFactory',
            'KotlinTypeChecker', 'TypeProjectionImpl', 'findClassAcrossModuleDependencies', 'toDefaultAttributes'],
        browserLoaderFactory: 'not configured by this unit; real external-module initialization is preserved',
        wasmBuild: 'not-run: concrete descriptor/type closure required', browserCompilerBuilt: false, readiness: false };
    const receiptPath = path.join(outputRoot, 'compiler-port-builtins/builtins-inputs.json');
    await writeJson(receiptPath, receipt);
    return { outputRoot, receipt, receiptPath, commonSources: [portablePath, loaderPath], replacedOriginalPaths: lock.replacedOriginalPaths };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2); const options = {};
    for (let i = 0; i < args.length; i += 2) {
        assert(['--source-root', '--output-root'].includes(args[i]) && args[i + 1] && !options[args[i]], 'Invalid builtins preparation option');
        options[args[i]] = args[i + 1];
    }
    const result = await prepareBuiltInsSources({ sourceRoot: options['--source-root'], outputRoot: options['--output-root'] });
    console.log(JSON.stringify({ outputRoot: result.outputRoot, sources: result.commonSources.length, readiness: false }));
}

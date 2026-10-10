/** Bounded real DescriptorUtils source compilation and original/common JVM comparison. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { prepareDescriptorUtilsSources } from './prepare.mjs';
import { verifyBootstrap, defaultCache } from '../../build/bootstrap.mjs';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)); const execute = promisify(execFile);

export async function verifyDescriptorUtils({ sourceRoot, outputRoot, bootstrapCache = defaultCache }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
    await mkdir(outputRoot, { recursive: false, mode: 0o700 });
    const common = await prepareDescriptorUtilsSources({ sourceRoot, outputRoot: path.join(outputRoot, 'common') });
    const jvm = await prepareDescriptorUtilsSources({ sourceRoot, outputRoot: path.join(outputRoot, 'jvm'), jvmAdapter: true });
    const bootstrap = await verifyBootstrap(bootstrapCache);
    const compiler = bootstrap.artifacts.find(item => item.id === 'compiler').path;
    const stdlib = bootstrap.artifacts.find(item => item.id === 'stdlib-jvm').path;
    const annotations = bootstrap.artifacts.find(item => item.id === 'annotations').path;
    const classPath = [compiler, stdlib, annotations].join(path.delimiter);
    const flagBytes = await readRegular(path.resolve(HERE, '../build-flags.json')); const flags = JSON.parse(flagBytes);
    assert.equal(flags.source.commit, common.receipt.source.commit);
    const commands = [];
    async function run(command, args) {
        try {
            const result = await execute(command, args, { cwd: outputRoot, timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
            commands.push({ command, args, exitCode: 0 }); return result.stdout;
        } catch (error) {
            throw new Error(`${command} failed (${error.code ?? error.signal}): ${String(error.stderr ?? error.message).slice(-10000)}`);
        }
    }
    const compile = ['-ea', '-Xmx768m', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
        '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-language-version', flags.languageVersion, '-api-version', flags.apiVersion, ...flags.compilerFlags];
    const assertionSource = path.resolve(HERE, '../assertions/CompilerAssertions.kt');
    const portableJar = path.join(outputRoot, 'descriptor-utils.jar');
    await run('java', [...compile, '-classpath', classPath, '-d', portableJar, ...jvm.commonSources, assertionSource]);
    const originalClasses = path.join(outputRoot, 'original-classes'); await mkdir(originalClasses, { mode: 0o700 });
    const originalFile = path.join(sourceRoot, 'core/descriptors/src/org/jetbrains/kotlin/resolve/DescriptorUtils.java');
    await run('javac', ['-J-Xmx512m', '-proc:none', '-source', '17', '-target', '17', '-classpath', classPath, '-d', originalClasses, originalFile]);
    const referenceBytes = await readRegular(path.join(HERE, 'Reference.java')); const referenceFile = path.join(outputRoot, 'Reference.java');
    await writeFile(referenceFile, referenceBytes, { flag: 'wx', mode: 0o600 });
    await run('javac', ['-J-Xmx256m', '-proc:none', '-d', outputRoot, referenceFile]);
    const originalApi = await run('java', ['-ea', '-Xmx768m', '-cp', [outputRoot, originalClasses, classPath].join(path.delimiter), 'Reference']);
    const portableApi = await run('java', ['-ea', '-Xmx768m', '-cp', [outputRoot, portableJar, classPath].join(path.delimiter), 'Reference']);
    const companion = 'field:public static final:Companion:org.jetbrains.kotlin.resolve.DescriptorUtils$Companion';
    const additionalApi = portableApi.trim().split('\n').filter(line => line.includes('org.jetbrains.kotlin.resolve.DescriptorType'));
    assert.equal(additionalApi.length, 2); assert.equal(portableApi.trim().split('\n').filter(line => line === companion).length, 1);
    const normalized = portableApi.trim().split('\n').filter(line => line !== companion && !additionalApi.includes(line))
        .map(line => line.replace('method:public static final:', 'method:public static:')).sort().join('\n') + '\n';
    assert.equal(normalized, originalApi, 'Original erased API contracts differ');
    await writeFile(path.join(outputRoot, 'original-api.txt'), originalApi, { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(outputRoot, 'portable-api.txt'), portableApi, { flag: 'wx', mode: 0o600 });
    const probeBytes = await readRegular(path.join(HERE, 'AlgorithmProbe.kt')); const probeFile = path.join(outputRoot, 'AlgorithmProbe.kt');
    await writeFile(probeFile, probeBytes, { flag: 'wx', mode: 0o600 }); const probeJar = path.join(outputRoot, 'probe.jar');
    await run('java', [...compile, '-classpath', [originalClasses, classPath].join(path.delimiter), '-d', probeJar, probeFile]);
    const main = 'org.jetbrains.kotlin.portable.descriptorutils.probe.AlgorithmProbeKt';
    const reference = await run('java', ['-ea', '-Xmx768m', '-cp', [probeJar, originalClasses, classPath].join(path.delimiter), main]);
    const portable = await run('java', ['-ea', '-Xmx768m', '-cp', [probeJar, portableJar, classPath].join(path.delimiter), main]);
    await writeFile(path.join(outputRoot, 'original-observations.txt'), reference, { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(outputRoot, 'portable-observations.txt'), portable, { flag: 'wx', mode: 0o600 });
    if (reference !== portable) {
        const a = reference.split('\n'), b = portable.split('\n'); const differences = [];
        for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) differences.push({ line: i + 1, original: a[i], portable: b[i] });
        await writeJson(path.join(outputRoot, 'differences.json'), differences);
        throw new Error('DescriptorUtils observations differ: ' + JSON.stringify(differences.slice(0, 10)));
    }
    const cases = reference.trim().split('\n').map(line => line.split('\t')[0]);
    assert(cases.length > 10000 && new Set(cases).size === cases.length);
    assert(!reference.includes('real-fake-override-count\t0'), 'Genuine fake overrides must be exercised');
    const typedBytes = await readRegular(path.join(HERE, 'TypedParentProbe.kt')); const typedFile = path.join(outputRoot, 'TypedParentProbe.kt');
    await writeFile(typedFile, typedBytes, { flag: 'wx', mode: 0o600 }); const typedJar = path.join(outputRoot, 'typed-parent.jar');
    await run('java', [...compile, '-classpath', [portableJar, classPath].join(path.delimiter), '-d', typedJar, typedFile]);
    const typed = await run('java', ['-ea', '-Xmx768m', '-cp', [typedJar, portableJar, classPath].join(path.delimiter), 'org.jetbrains.kotlin.portable.descriptorutils.probe.TypedParentProbeKt']);
    assert(/^typed parent identity checks: [1-9][0-9]*\n$/.test(typed));
    const receipt = { schemaVersion: 1, kind: 'official-descriptor-utils-original-common-jvm-differential', source: common.receipt.source, result: 'pass',
        preparation: common.receipt, jvmPreparation: jvm.receipt, sourceLockSha256: sha256(await readRegular(path.join(HERE, 'sources.lock.json'))),
        verificationToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))), probeSourceSha256: sha256(probeBytes),
        referenceToolSha256: sha256(referenceBytes), typedParentProbeSha256: sha256(typedBytes), buildFlagsSha256: sha256(flagBytes),
        assertionSourceSha256: sha256(await readRegular(assertionSource)),
        api: { originalRecords: originalApi.trim().split('\n').length, originalSha256: sha256(Buffer.from(originalApi)), portableSha256: sha256(Buffer.from(portableApi)),
            additionalCommonTypeApis: additionalApi, companionField: companion, staticBridgeModifiers: 'Kotlin static bridges are final',
            classModifier: 'Common utility class is final with a private constructor; the original private-constructor Java class is non-final' },
        comparison: { required: cases.length, passed: cases.length, failed: 0, notRun: 0, skipped: 0,
            originalSha256: sha256(Buffer.from(reference)), portableSha256: sha256(Buffer.from(portable)), cases },
        typedParentResult: typed.trim(), normalization: ['descriptor identity hex in exception messages', 'only unordered getAllOverriddenDeclarations set results are sorted; linked override postorder is retained'],
        bootstrap: { version: bootstrap.lock.version, sourceCommit: null, artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
        helpers: 'genuine verified bootstrap JVM descriptor/type/metadata helpers; source revision equality is not proved', commands,
        outputs: await Promise.all(['descriptor-utils.jar', 'probe.jar', 'typed-parent.jar', 'original-api.txt', 'portable-api.txt', 'original-observations.txt', 'portable-observations.txt']
            .map(async name => { const data = await readRegular(path.join(outputRoot, name), 16 * 1024 * 1024); return { path: name, bytes: data.length, sha256: sha256(data) }; })),
        commonClassNameAssertionText: 'not-run in Wasm; actual KClass text may differ from Java Class text, invariant predicate is unchanged',
        wasmBuild: 'not-run: concrete helper/PSI closure required', browserCompilerBuilt: false, readiness: false };
    await writeJson(path.join(outputRoot, 'differential-receipt.json'), receipt); return { outputRoot, receipt };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2); const options = {};
    for (let i = 0; i < args.length; i += 2) {
        if (!['--source-root', '--output-root'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('Invalid descriptor utilities probe option');
        options[args[i]] = args[i + 1];
    }
    const result = await verifyDescriptorUtils({ sourceRoot: options['--source-root'], outputRoot: options['--output-root'] });
    console.log(JSON.stringify({ result: result.receipt.result, cases: result.receipt.comparison.required, typedParent: result.receipt.typedParentResult, readiness: false }));
}

#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { prepareSerialResolveSources } from './prepare.mjs';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '../../../..');
const execute = promisify(execFile);
const parent = path.join(repository, 'out/kotlin-compiler-serial-resolve/checks');
await mkdir(parent, { recursive: true });
const output = await mkdtemp(path.join(parent, 'run-'));
await execute('git', ['init', '--quiet', output]);
const sourceRoot = path.join(repository, 'out/kotlin-compiler-port/sources');
const prepared = await prepareSerialResolveSources({ sourceRoot, outputRoot: output });
const lock = JSON.parse(await readRegular(path.join(here, 'sources.lock.json')));
const original = verifyFile(await readRegular(path.join(sourceRoot, lock.sourceFile.path)), lock.sourceFile).toString();
const start = original.indexOf(lock.controlFlowSlice.start, original.indexOf('abstract class FirLazyDeclarationResolver'));
const end = original.indexOf(lock.controlFlowSlice.end, start);
const slice = original.slice(start, end);
assert.equal(sha256(Buffer.from(slice)), lock.controlFlowSlice.sha256);
const phaseSignatures = '    abstract fun startResolvingPhase(phase: FirResolvePhase)\n\n    abstract fun finishResolvingPhase(phase: FirResolvePhase)\n\n';
assert.equal(slice.split(phaseSignatures).length, 2);
const methods = slice.replace(phaseSignatures, '');
const forbidden = /class FirLazyResolveForbiddenException\(\) : IllegalStateException\("Lazy resolve is forbidden"\)/.exec(original)?.[0];
assert(forbidden, 'Missing original permission error type');
const header = 'package org.jetbrains.kotlin.portable.resolvecheck\nimport org.jetbrains.kotlin.util.PrivateForInline\n';
const originalControl = Buffer.from(header + '\nclass ResolveControl {\n' + methods +
    '    fun checkAllowed() = assertLazyResolveAllowed()\n}\n\n' + forbidden + '\n');
const portableControl = Buffer.from(originalControl.toString().replace(header,
    header + 'import org.jetbrains.kotlin.portable.resolve.SerialResolveState\n')
    .replaceAll('ThreadLocal<Boolean> = ThreadLocal.withInitial', 'SerialResolveState<Boolean> = SerialResolveState.withInitial'));
const observerText = `package org.jetbrains.kotlin.portable.resolvecheck
import org.jetbrains.kotlin.util.PrivateForInline
@OptIn(PrivateForInline::class)
fun observeState(): String {
    val observations = mutableListOf<String>()
    val control = ResolveControl()
    fun flags(name: String) { observations += "$name:" + control.lazyResolveContractChecksEnabled + ":" + control._lazyResolveIsAllowed.get() }
    fun attempt(name: String, action: () -> Unit) {
        try { action(); observations += "$name:ok" }
        catch (error: Throwable) { observations += "$name:" + error::class.simpleName + ":" + error.message }
    }
    flags("initial")
    control.checkAllowed()
    val result = control.disableLazyResolveContractChecksInside {
        flags("contract.outer")
        control.disableLazyResolveContractChecksInside { flags("contract.inner"); 7 }
    }
    observations += "contract.result:$result"
    flags("contract.restored")
    attempt("contract.throw") { control.disableLazyResolveContractChecksInside { flags("contract.throw.inside"); error("action failed") } }
    flags("contract.throw.restored")
    attempt("forbid") { control.forbidLazyResolveInside { flags("forbid.inside"); control.checkAllowed() } }
    flags("forbid.restored")
    control.forbidLazyResolveInside {
        control.disableLazyResolveContractChecksInside {
            flags("both")
            control.forbidLazyResolveInside { flags("both.inner") }
            flags("both.inner.restored")
        }
        flags("both.contract.restored")
    }
    flags("both.restored")
    fun returnFromContract(): Int { control.disableLazyResolveContractChecksInside { flags("nonlocal.contract"); return 19 } }
    fun returnFromForbid(): Int { control.forbidLazyResolveInside { flags("nonlocal.forbid"); return 23 } }
    observations += "nonlocal.contract.result:" + returnFromContract()
    flags("nonlocal.contract.restored")
    observations += "nonlocal.forbid.result:" + returnFromForbid()
    flags("nonlocal.forbid.restored")
    control.disableLazyResolveContractChecks()
    flags("disabled")
    control.disableLazyResolveContractChecksInside { flags("disabled.scope") }
    flags("disabled.scope.restored")
    val fresh = ResolveControl()
    observations += "fresh:" + fresh.lazyResolveContractChecksEnabled + ":" + fresh._lazyResolveIsAllowed.get()
    var initializations = 0
    val state = STATE.withInitial { initializations += 1; "value" }
    observations += "lazy.before:$initializations"
    observations += "lazy.first:" + state.get() + ":$initializations"
    observations += "lazy.repeat:" + state.get() + ":$initializations"
    state.set("changed")
    observations += "set:" + state.get() + ":$initializations"
    state.remove()
    observations += "remove.before:$initializations"
    observations += "remove.after:" + state.get() + ":$initializations"
    var failedAttempts = 0
    val throwing = STATE.withInitial { failedAttempts += 1; if (failedAttempts == 1) error("initializer failed"); "recovered" }
    attempt("initializer.throw") { throwing.get() }
    observations += "initializer.retry:" + throwing.get() + ":$failedAttempts"
    val nullable = STATE.withInitial<String?> { null }
    observations += "null.initial:" + nullable.get()
    nullable.set("set")
    observations += "null.set:" + nullable.get()
    nullable.set(null)
    observations += "null.explicit:" + nullable.get()
    nullable.remove()
    observations += "null.removed:" + nullable.get()
    return observations.joinToString("\\n")
}
`;
const paths = {};
for (const [name, bytes] of [['OriginalControl.kt', originalControl], ['PortableControl.kt', portableControl],
    ['OriginalObserver.kt', Buffer.from(observerText.replaceAll('STATE.', 'ThreadLocal.'))],
    ['PortableObserver.kt', Buffer.from(observerText.replace('import org.jetbrains.kotlin.util.PrivateForInline\n',
        'import org.jetbrains.kotlin.util.PrivateForInline\nimport org.jetbrains.kotlin.portable.resolve.SerialResolveState\n')
        .replaceAll('STATE.', 'SerialResolveState.'))],
    ['PrivateForInline.kt', verifyFile(await readRegular(path.join(sourceRoot, lock.probeAnnotation.path)), lock.probeAnnotation)],
    ['JvmMain.kt', Buffer.from('package org.jetbrains.kotlin.portable.resolvecheck\nfun main() = print(observeState())\n')],
    ['WasmExport.kt', Buffer.from('package org.jetbrains.kotlin.portable.resolvecheck\nimport kotlin.js.JsExport\n@JsExport fun resolveStateProbe(): String = observeState()\n')]]) {
    paths[name] = path.join(output, name);
    await writeFile(paths[name], bytes, { flag: 'wx', mode: 0o600 });
}
const bootstrap = await verifyBootstrap();
const flagsBytes = await readRegular(path.join(here, '../build-flags.json'));
const flags = JSON.parse(flagsBytes);
assert.equal(flags.source.commit, lock.source.commit);
const commands = [];
async function command(phase, binary, args) {
    const started = performance.now();
    const result = await execute(binary, args, { timeout: 180000, maxBuffer: 1024 * 1024 });
    if (result.stderr) process.stderr.write(result.stderr);
    commands.push({ phase, command: [binary, ...args], exitCode: 0, elapsedMs: performance.now() - started });
    return result.stdout;
}
const compiler = ['-Xmx768m', '-cp', bootstrap.classPath];
const jvmCompiler = [...compiler, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect',
    '-language-version', '2.5', '-api-version', '2.5', ...flags.compilerFlags, '-classpath', bootstrap.classPath];
const originalJar = path.join(output, 'original.jar'), portableJar = path.join(output, 'portable.jar');
await command('original-jvm-control-flow', 'java', [...jvmCompiler, '-d', originalJar,
    paths['OriginalControl.kt'], paths['OriginalObserver.kt'], paths['PrivateForInline.kt'], paths['JvmMain.kt']]);
const reference = await command('original-jvm-state', 'java', ['-ea', '-cp', [originalJar, bootstrap.classPath].join(path.delimiter),
    'org.jetbrains.kotlin.portable.resolvecheck.JvmMainKt']);
const adapterPath = prepared.commonSources.find(file => file.endsWith('/SerialResolveState.kt'));
assert(adapterPath);
const portableSources = [adapterPath, paths['PortableControl.kt'], paths['PortableObserver.kt'], paths['PrivateForInline.kt']];
await command('portable-jvm-control-flow', 'java', [...jvmCompiler, '-d', portableJar, ...portableSources, paths['JvmMain.kt']]);
const portable = await command('portable-jvm-state', 'java', ['-ea', '-cp', [portableJar, bootstrap.classPath].join(path.delimiter),
    'org.jetbrains.kotlin.portable.resolvecheck.JvmMainKt']);
assert.equal(portable, reference, 'FIR resolution control state differs from original JVM ThreadLocal');
const klib = path.join(output, 'klib'), wasm = path.join(output, 'wasm'); await mkdir(klib); await mkdir(wasm);
const wasmCompiler = [...compiler, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js',
    '-language-version', '2.5', '-api-version', '2.5', ...flags.compilerFlags, '-libraries', bootstrap.wasmJsStdlib];
await command('portable-wasmjs-klib', 'java', [...wasmCompiler, '-ir-output-dir', klib, '-ir-output-name', 'resolve-state',
    ...portableSources, paths['WasmExport.kt']]);
await command('portable-wasmjs-binary', 'java', [...wasmCompiler, '-Xir-produce-js', '-Xinclude=' + path.join(klib, 'resolve-state.klib'),
    '-ir-output-dir', wasm, '-ir-output-name', 'resolve-state', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
const loader = pathToFileURL(path.join(wasm, 'resolve-state.mjs')).href;
const result = await command('portable-node-wasm-state', 'node', ['--experimental-wasm-exnref', '--input-type=module', '-e',
    `const module = await import(${JSON.stringify(loader)}); process.stdout.write(module.resolveStateProbe());`]);
assert.equal(result, reference, 'FIR resolution control state differs on the actual Wasm host');
const receipt = { schemaVersion: 1, kind: 'official-fir-resolve-serial-state-differential', source: lock.source,
    sourcePreparation: prepared.receipt, buildFlags: { sha256: sha256(flagsBytes), compilerFlags: flags.compilerFlags },
    toolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
    probeSources: await Promise.all(Object.entries(paths).map(async ([name, file]) => {
        const bytes = await readRegular(file); return { path: name, bytes: bytes.length, sha256: sha256(bytes) };
    })), commands, comparisons: { required: reference.split('\n').length, passed: reference.split('\n').length,
        failed: 0, notRun: 0, originalJvm: sha256(Buffer.from(reference)), portableJvm: sha256(Buffer.from(portable)),
        wasmNode: sha256(Buffer.from(result)), mismatches: 0 }, observedOutput: reference,
    limits: ['Actual FIR control-flow slice and real error class are compared; full FIR objects, phases and resolution are not exercised.',
        'Single serialized Worker thread only. Multi-thread state isolation is outside the selected host.',
        'Node Wasm execution is not browser compiler acceptance.'],
    browserExecution: 'not-run', fullBrowserCompiler: false, readiness: false };
await writeJson(path.join(output, 'state-evidence.json'), receipt);
console.log(JSON.stringify({ output, comparisons: receipt.comparisons, fullBrowserCompiler: false }));

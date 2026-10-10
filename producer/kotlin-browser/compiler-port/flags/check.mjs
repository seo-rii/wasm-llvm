#!/usr/bin/env node
/** Compare real metadata/IR flag behavior with the exact original Java helpers. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { prepareFlagsSources } from './prepare.mjs';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');
const execute = promisify(execFile);
const sourceRoot = path.join(repository, 'out/kotlin-compiler-port/sources');
const parent = path.join(repository, 'out/kotlin-compiler-flags/checks');
await mkdir(parent, { recursive: true });
const output = await mkdtemp(path.join(parent, 'run-'));
const bootstrap = await verifyBootstrap();
const reference = path.resolve(process.argv[2] ?? path.join(repository, 'out/kotlin-compiler-serialization/probe-7/reference'));
const codecBuild = path.resolve(process.argv[3] ?? path.join(repository, 'out/kotlin-compiler-serialization/probe-8/codec'));
const codec = JSON.parse(await readRegular(path.join(codecBuild, 'receipt.json')));
assert.equal(codec.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
const codecJvm = codec.outputs.find((pin) => pin.kind === 'jvm-reference-host-codec');
const codecWasm = codec.outputs.find((pin) => pin.kind === 'portable-compiler-dependency-klib');
for (const pin of [codecJvm, codecWasm]) {
    assert(pin);
    const bytes = await readRegular(path.join(codecBuild, pin.path), pin.bytes);
    assert.equal(sha256(bytes), pin.sha256);
}
const prepared = await prepareFlagsSources({ sourceRoot, outputRoot: output });
const observerParts = ['package org.jetbrains.kotlin.portable.flagscheck\n',
    'import org.jetbrains.kotlin.metadata.deserialization.Flags\n',
    'import org.jetbrains.kotlin.backend.common.serialization.IrFlags\n',
    'import org.jetbrains.kotlin.metadata.ProtoBuf\n',
    'import org.jetbrains.kotlin.protobuf.Internal\n',
    '@Suppress("UNCHECKED_CAST")\nfun observeFlags(): String {\n',
    '    var digest = 0x12345678\n    var count = 0L\n',
    '    fun record(value: Int) { digest = (digest xor value) * 16777619; count++ }\n',
    '    fun observe(field: Flags.FlagField<*>, raw: Int) {\n',
    '        val value = field.get(raw)\n',
    '        when (value) {\n',
    '            null -> record(-12345)\n',
    '            is Boolean -> { record(if (value) 1 else 0); record((field as Flags.BooleanFlagField).toFlags(value)); record(field.invert(raw)) }\n',
    '            is Internal.EnumLite -> { record(value.getNumber()); record((field as Flags.FlagField<Internal.EnumLite>).toFlags(value)) }\n',
    '            else -> error("Unexpected flag value")\n',
    '        }\n    }\n',
    '    val allFields = listOf<Flags.FlagField<*>>(\n'];
for (const [index, source] of prepared.receipt.sources.entries()) {
    const owner = index ? 'IrFlags' : 'Flags';
    for (const field of source.fields) observerParts.push(`        ${owner}.${field.name},\n`);
}
// Include Java's inherited static fields, whose Kotlin aliases must stay identical.
for (const field of prepared.receipt.sources[0].fields) observerParts.push(`        IrFlags.${field.name},\n`);
observerParts.push('    )\n    for (field in allFields) {\n',
    '        record(field.offset); record(field.bitWidth)\n',
    '        for (raw in 0..65535) observe(field, raw)\n',
    '        for (raw in listOf(Int.MIN_VALUE, Int.MAX_VALUE, -1, -65536)) observe(field, raw)\n    }\n',
    '    class Numbered(val value: Int) : Internal.EnumLite { override fun getNumber() = value }\n',
    '    for (offset in 0..35) {\n',
    '        val previous = Flags.BooleanFlagField(offset - 1)\n',
    '        for (entries in listOf(emptyArray(), arrayOf(Numbered(0)), arrayOf(Numbered(0), Numbered(3)), arrayOf(Numbered(0), Numbered(1), Numbered(7)))) {\n',
    '            val field = Flags.FlagField.after(previous, entries)\n',
    '            record(field.offset); record(field.bitWidth)\n',
    '            for (raw in listOf(0, 1, 3, 7, 255, -1, Int.MIN_VALUE)) observe(field, raw)\n',
    '        }\n    }\n');
for (const [index, pin] of prepared.receipt.sources.entries()) {
    const text = (await readRegular(path.join(sourceRoot, pin.original.path))).toString('utf8');
    for (const match of text.matchAll(/public static int (\w+)\((.*?)\)\s*\{\s*return\s+.*?;\s*\}/gs)) {
        const name = match[1];
        const parameters = match[2].replace(/@(NotNull|Nullable)\s+/g, '').split(',').map((parameter) => parameter.trim().split(/\s+/));
        const bools = parameters.filter(([kind]) => kind === 'boolean').length;
        const enums = parameters.filter(([kind]) => kind !== 'boolean').map(([kind]) => kind);
        let enumCases = '1';
        for (const kind of enums) enumCases += ` * ${kind}.values().size`;
        observerParts.push(`    for (bits in 0 until ${1 << bools}) for (choice in 0 until (${enumCases})) {\n`);
        let booleanIndex = 0;
        let enumDivisor = '1';
        const args = parameters.map(([kind]) => {
            if (kind === 'boolean') return `(bits and ${1 << booleanIndex++}) != 0`;
            const expression = `${kind}.values()[(choice / (${enumDivisor})) % ${kind}.values().size]`;
            enumDivisor += ` * ${kind}.values().size`;
            return expression;
        });
        observerParts.push(`        record(${index ? 'IrFlags' : 'Flags'}.${name}(${args.join(', ')}))\n    }\n`);
    }
}
observerParts.push('    return "$count:$digest"\n}\n');
const observer = path.join(output, 'Observer.kt');
const jvmMain = path.join(output, 'JvmMain.kt');
const wasmExport = path.join(output, 'WasmExport.kt');
await writeFile(observer, observerParts.join(''), { flag: 'wx', mode: 0o600 });
await writeFile(jvmMain, 'package org.jetbrains.kotlin.portable.flagscheck\nfun main() = print(observeFlags())\n', { flag: 'wx', mode: 0o600 });
await writeFile(wasmExport, 'package org.jetbrains.kotlin.portable.flagscheck\nimport kotlin.js.JsExport\n@JsExport fun flagsProbe(): String = observeFlags()\n', { flag: 'wx', mode: 0o600 });
const commands = [];
async function command(phase, binary, args) {
    const started = performance.now();
    const result = await execute(binary, args, { timeout: 180000, maxBuffer: 1024 * 1024 });
    if (result.stderr) process.stderr.write(result.stderr);
    commands.push({ phase, command: [binary, ...args], exitCode: 0, elapsedMs: performance.now() - started });
    return result.stdout;
}
const originalClasses = path.join(output, 'original-classes');
await mkdir(originalClasses);
const referenceClassPath = [reference, bootstrap.classPath].join(path.delimiter);
await command('original-java-helpers', 'javac', ['-cp', referenceClassPath, '-d', originalClasses,
    ...prepared.receipt.sources.map((pin) => path.join(sourceRoot, pin.original.path))]);
const compiler = ['-Xmx768m', '-cp', bootstrap.classPath];
const originalJvm = path.join(output, 'original.jar');
await command('original-jvm-observer', 'java', [...compiler, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
    '-no-stdlib', '-no-reflect', '-language-version', '2.5', '-api-version', '2.5', '-classpath', [originalClasses, referenceClassPath].join(path.delimiter),
    '-d', originalJvm, observer, jvmMain]);
const original = await command('original-jvm-run', 'java', ['-cp', [originalJvm, originalClasses, referenceClassPath].join(path.delimiter),
    'org.jetbrains.kotlin.portable.flagscheck.JvmMainKt']);
const portableJvm = path.join(output, 'portable.jar');
await command('portable-jvm', 'java', [...compiler, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect',
    '-language-version', '2.5', '-api-version', '2.5', '-Xmulti-platform', '-Xcommon-sources=' + prepared.commonSources.join(','),
    '-classpath', [path.join(codecBuild, codecJvm.path), bootstrap.classPath].join(path.delimiter), '-d', portableJvm,
    ...prepared.commonSources, observer, jvmMain]);
const portable = await command('portable-jvm-run', 'java', ['-cp', [portableJvm, path.join(codecBuild, codecJvm.path), bootstrap.classPath].join(path.delimiter),
    'org.jetbrains.kotlin.portable.flagscheck.JvmMainKt']);
assert.equal(portable, original, 'Portable JVM flags differ from original Java');
const klib = path.join(output, 'klib');
const wasm = path.join(output, 'wasm');
await mkdir(klib); await mkdir(wasm);
const wasmCompiler = [...compiler, 'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '-Xwasm-target=wasm-js',
    '-language-version', '2.5', '-api-version', '2.5', '-libraries', [bootstrap.wasmJsStdlib, path.join(codecBuild, codecWasm.path)].join(path.delimiter)];
await command('portable-wasmjs-klib', 'java', [...wasmCompiler, '-Xmulti-platform', '-Xcommon-sources=' + prepared.commonSources.join(','),
    '-ir-output-dir', klib, '-ir-output-name', 'flags', ...prepared.commonSources, observer, wasmExport]);
await command('portable-wasmjs-binary', 'java', [...wasmCompiler, '-Xir-produce-js', '-Xinclude=' + path.join(klib, 'flags.klib'),
    '-ir-output-dir', wasm, '-ir-output-name', 'flags', '-main', 'noCall', '-Xwasm-enable-array-range-checks', '-Xwasm-enable-asserts']);
const loader = pathToFileURL(path.join(wasm, 'flags.mjs')).href;
const node = await command('portable-node-wasm-run', 'node', ['--experimental-wasm-exnref', '--input-type=module', '-e',
    `const module = await import(${JSON.stringify(loader)}); process.stdout.write(module.flagsProbe());`]);
assert.equal(node, original, 'Portable Wasm flags differ from original Java');
const receipt = { schemaVersion: 1, kind: 'official-compiler-flags-differential', source: prepared.receipt.source,
    sourcePreparation: prepared.receipt, commands, observerSha256: sha256(await readRegular(observer)),
    comparisons: { originalJvm: original, portableJvm: portable, wasmNode: node, mismatches: 0 },
    browserExecution: 'not-run', fullBrowserCompiler: false };
await writeJson(path.join(output, 'flags-evidence.json'), receipt);
console.log(JSON.stringify({ output, comparisons: receipt.comparisons, fullBrowserCompiler: false }));

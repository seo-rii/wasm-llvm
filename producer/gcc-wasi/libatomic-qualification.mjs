import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const identity = bytes => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
const contentIdentity = record => ({ bytes: record.bytes, sha256: record.sha256 });
const publicOperations = ['load', 'store', 'exchange', 'compare_exchange', 'test_and_set',
  'fetch_add', 'add_fetch', 'fetch_sub', 'sub_fetch', 'fetch_and', 'and_fetch',
  'fetch_or', 'or_fetch', 'fetch_xor', 'xor_fetch', 'fetch_nand', 'nand_fetch'];
const sizedObjects = ['load', 'store', 'cas', 'exch', 'fadd', 'fsub', 'fand', 'fior', 'fxor', 'fnand', 'tas'];
export const expectedLibatomicMembers = ['gload', 'gstore', 'gcas', 'gexch', 'glfree', 'lock', 'init', 'fenv', 'fence', 'flag']
  .map(name => name + '.o').concat([1, 2, 4, 8, 16].flatMap(size => sizedObjects.map(name => `${name}_${size}_.o`))).sort();
export const expectedLibatomicSymbols = ['__atomic_load', '__atomic_store', '__atomic_exchange', '__atomic_compare_exchange',
  '__atomic_is_lock_free', '__atomic_feraiseexcept', 'atomic_thread_fence', 'atomic_signal_fence',
  'atomic_flag_test_and_set', 'atomic_flag_test_and_set_explicit', 'atomic_flag_clear', 'atomic_flag_clear_explicit',
  ...[1, 2, 4, 8, 16].flatMap(size => publicOperations.map(name => `__atomic_${name}_${size}`))].sort();

export const libatomicWasiRunner = `import {WASI} from 'node:wasi';
import {readFile} from 'node:fs/promises';
const wasi = new WASI({version:'preview1',args:['program'],env:{},returnOnExit:true});
const module = await WebAssembly.compile(await readFile(process.argv[2]));
process.exitCode = wasi.start(await WebAssembly.instantiate(module,{wasi_snapshot_preview1:wasi.wasiImport}));
`;

export function libatomicCompileArgs(fixture, source, assembly, context) {
  return ['-quiet', `-O${fixture.request.optimization}`, '-std=' + fixture.request.standard,
    '-fdiagnostics-color=never', '-fno-stack-protector', '-nostdinc', '-matomics',
    ...(fixture.request.sharedMemory ? [] : ['-D__GCC_WASI_SINGLE_THREAD__=1']),
    ...(fixture.request.language === 'cpp' ? ['-fno-exceptions', '-fno-rtti'] : []),
    '-isystem', path.join(context.work, 'gcc-native/gcc/include'),
    '-isystem', path.join(context.sysroot, 'include/wasm32-wasi'), source, '-o', assembly];
}

export function libatomicLinkArgs(fixture, object, program, context) {
  const library = path.join(context.sysroot, 'lib/wasm32-wasi');
  const archive = path.join(context.libatomic, 'sysroot/lib/wasm32-wasi/libatomic.a');
  const shared = fixture.request.sharedMemory;
  const flags = shared ? ['--no-entry', '--import-memory', '--shared-memory', '--export-memory',
    '--no-stack-first', '--global-base=1024', '-z', 'stack-size=0',
    '--initial-memory=' + shared.initialPages * 65536, '--max-memory=' + shared.maximumPages * 65536,
    '--extra-features=atomics,bulk-memory,mutable-globals',
    ...['__stack_pointer', '__heap_base', '__data_end', '__wasm_call_ctors', '__tls_size', shared.entry].map(name => '--export=' + name)]
    : ['-e', '_start', path.join(library, 'crt1-command.o')];
  return ['--fatal-warnings', '-m', 'wasm32', '-o', program, ...flags, '-L' + library,
    object, archive, '-lm', '-lc', path.join(library, 'libclang_rt.builtins-wasm32.a')];
}

export function inspectLibatomicProgram(fixture, text, bytes) {
  const module = new WebAssembly.Module(bytes), imports = WebAssembly.Module.imports(module);
  const functions = new Map(); let current;
  for (const line of text.split('\n')) {
    const header = /^\s*[a-f0-9]+ func\[(\d+)\](?: <([^>]+)>)?:/u.exec(line);
    if (header) { current = { index: Number(header[1]), name: header[2], instructions: [] }; functions.set(current.index, current); continue; }
    const instruction = /^\s*[a-f0-9]+:\s+(?:[a-f0-9]{2}\s+)+\|\s*(\S+)/u.exec(line);
    if (current && instruction && !instruction[1].startsWith('local[')) current.instructions.push(instruction[1]);
  }
  const exports = WebAssembly.Module.exports(module);
  if (fixture.request.sharedMemory) {
    assert.deepEqual(imports, [{ module: 'env', name: 'memory', kind: 'memory' }]);
    const ctor = [...functions.values()].filter(fn => fn.name === '__wasm_call_ctors');
    assert.equal(ctor.length, 1); assert.deepEqual(ctor[0].instructions, ['end'], 'Shared runtime constructors must be empty');
    const startup = [...functions.values()].filter(fn => fn.name === '__wasm_init_memory');
    assert.equal(startup.length, 1, 'LLD shared initialization is missing');
    for (const opcode of ['i32.atomic.rmw.cmpxchg', 'i32.atomic.store', 'memory.atomic.notify', 'memory.atomic.wait32']) {
      assert(startup[0].instructions.includes(opcode), `Missing shared startup instruction ${opcode}`);
    }
    assert(startup[0].instructions.some(op => op === 'memory.init' || op === 'memory.fill'));
    assert.match(text, new RegExp(`Start:\\s*\\n\\s*- start function: ${startup[0].index}\\b`, 'u'));
    for (const line of text.split('\n').filter(line => /^ - segment\[/u.test(line))) assert.match(line, /^ - segment\[\d+\] passive /u);
    assert.match(text, / - global\[\d+\] i32 mutable=0 <__tls_size> - init i32=0/u);
    const entry = fixture.request.sharedMemory.entry;
    const exported = new RegExp(` - func\\[(\\d+)\\](?: <[^>]+>)? -> "${entry}"`, 'u').exec(text);
    assert(exported, 'Missing shared entry export');
    const signature = new RegExp(` - func\\[${exported[1]}\\] sig=(\\d+)`, 'u').exec(text); assert(signature);
    const type = new RegExp(` - type\\[${signature[1]}\\] \\(([^)]*)\\) -> (\\S+)`, 'u').exec(text); assert(type);
    assert.equal(type[1], fixture.run.workerArguments[0].map(() => 'i32').join(', ')); assert.equal(type[2], 'i32');
  } else {
    assert(imports.every(item => item.module === 'wasi_snapshot_preview1' && item.kind === 'function'));
    assert(exports.some(item => item.name === '_start' && item.kind === 'function'));
  }
  return { imports, exports, functions: [...functions.values()].map(fn => ({ name: fn.name, index: fn.index, instructionCount: fn.instructions.length })) };
}

// GCC emits a prefix of complete, single-line module imports. Hash-table
// iteration may change their order. Preserve each declaration verbatim,
// including names, types, annotations and duplicates, and every other byte.
function normalizeImportOrder(assembly) {
  assert(typeof assembly === 'string' || Buffer.isBuffer(assembly));
  assert(Buffer.byteLength(assembly) <= 16 * 1024 * 1024, 'Oversized GCC assembly');
  const text = typeof assembly === 'string' ? assembly : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(assembly);
  assert.match(text, /^\(module[\s)]/u, 'Expected GCC module');
  const lines = text.split('\n'), positions = [], imports = [];
  let depth = 0, comments = 0, quoted = false, roots = 0, prefixEnded = false;
  for (const [index, line] of lines.entries()) {
    const atModule = depth === 1 && comments === 0 && !quoted;
    const declaration = atModule && /^\s*\(import(?:\s|\()/u.test(line);
    if (declaration) {
      assert(!prefixEnded && line.startsWith('  (import '), 'Import outside the supported GCC declaration prefix');
    } else if (atModule && /^\s*\((?!;)/u.test(line)) prefixEnded = true;
    let declarationEnd = -1;
    for (let cursor = 0; cursor < line.length; cursor++) {
      if (comments) {
        if (line.startsWith('(;', cursor)) { comments++; cursor++; }
        else if (line.startsWith(';)', cursor)) { comments--; cursor++; }
        continue;
      }
      if (quoted) {
        if (line[cursor] === '\\') cursor++;
        else if (line[cursor] === '"') quoted = false;
        continue;
      }
      if (line.startsWith(';;', cursor)) break;
      if (line.startsWith('(;', cursor)) { comments++; cursor++; continue; }
      if (line[cursor] === '"') { quoted = true; continue; }
      if (line[cursor] === '(') { if (!depth) roots++; depth++; }
      if (line[cursor] === ')') {
        assert(depth > 0, 'Unbalanced GCC assembly'); depth--;
        if (declaration && depth === 1 && declarationEnd < 0) declarationEnd = cursor + 1;
      }
    }
    if (declaration) {
      assert(depth === 1 && !quoted && !comments && declarationEnd > 0 && /^\s*$/u.test(line.slice(declarationEnd)),
        'Only complete single-line import declarations may be reordered');
      positions.push(index); imports.push(line);
    }
  }
  assert.equal(depth, 0, 'Unclosed GCC module'); assert.equal(comments, 0, 'Unclosed WAT comment');
  assert.equal(quoted, false, 'Unclosed WAT string'); assert.equal(roots, 1, 'Expected exactly one module');
  imports.sort();
  for (const [index, position] of positions.entries()) lines[position] = imports[index];
  return lines.join('\n');
}

export function assertLibatomicAssemblyReplay(original, fresh) {
  assert.equal(normalizeImportOrder(fresh), normalizeImportOrder(original),
    'Recompiled GCC assembly changed beyond complete import declaration order');
}

export function verifyLibatomicBuildMetadata(report, expected) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, 'gcc-wasi-libatomic-build');
  assert.equal(report.status, 'built-unverified', 'An archive build is not runtime execution qualification');
  assert.equal(report.target, 'wasm32-wasi');
  assert.equal(report.inputsUnchanged, true);
  assert.deepEqual(report.gccSource, expected.gccSource);
  assert.equal(report.sourceLock.sha256, expected.sourceLockSha256);
  assert.deepEqual(contentIdentity(report.nativeBuild), contentIdentity(expected.nativeBuild));
  assert.deepEqual(report.objects.map(item => item.member).sort(), expectedLibatomicMembers);
  assert.deepEqual(report.archiveInspection.publicSymbols, expectedLibatomicSymbols);
  assert.equal(report.archiveInspection.recursiveCalls, false);
  assert.deepEqual(report.profile, {
    implementation: 'pinned-gnu-libatomic', atomics: true, lockFreeSizes: [1, 2, 4, 8],
    lockFreeAlignment: 'natural', lockFree16: false, sizedHelperAlignment: 'natural',
    genericRuntimeUnalignedFallback: true, genericBuiltinMaySpecialize: true,
    locks: { slots: 64, watchBytes: 64, slotBytes: 64,
      acquisition: 'unique-slots-ascending', release: 'descending', sharedBss: true,
      startup: 'single-shared-initialization' },
    pthread: false, tls: false, sharedRuntimeQualified: false,
  });
  assert.equal(report.configurationChecks.definitions.WORDSIZE, '8');
  for (const name of ['LDST', 'CAS', 'EXCHANGE', 'FETCH_ADD', 'FETCH_OP']) {
    for (const size of [1, 2, 4, 8]) assert.equal(report.configurationChecks.definitions[`HAVE_ATOMIC_${name}_${size}`], '1');
    assert.equal(report.configurationChecks.definitions[`HAVE_ATOMIC_${name}_16`], '0');
  }
  assert.deepEqual(report.licenses.map(item => path.basename(item.installed.path)).sort(), ['COPYING.RUNTIME', 'COPYING3']);
}

async function readRecord(record, expectedPath) {
  assert(record && typeof record.path === 'string', 'Missing on-disk identity');
  if (expectedPath) assert.equal(path.resolve(record.path), path.resolve(expectedPath), 'Unexpected evidence path');
  const bytes = await fs.readFile(record.path);
  assert.deepEqual(identity(bytes), contentIdentity(record), `Changed libatomic evidence: ${record.path}`);
  return bytes;
}

async function identify(file) { return { path: file, ...identity(await fs.readFile(file)) }; }

export async function runLibatomicValidationCommand(command, argv, directory, label, timeout = 180000, input) {
  const stdout = path.join(directory, label + '.stdout'), stderr = path.join(directory, label + '.stderr');
  const out = await fs.open(stdout, 'wx'), err = await fs.open(stderr, 'wx');
  const receipt = { command, argv, cwd: directory, timeoutMilliseconds: timeout, stdin: input ?? null };
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(command, argv, { cwd: directory, stdio: [input === undefined ? 'ignore' : 'pipe', out.fd, err.fd] });
      if (input !== undefined) child.stdin.end(input);
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
      child.once('error', error => { clearTimeout(timer); receipt.error = error.message; reject(error); });
      child.once('close', (status, signal) => {
        clearTimeout(timer); Object.assign(receipt, { status, signal, timedOut });
        if (status === 0 && signal === null && !timedOut) resolve();
        else reject(new Error(`libatomic replay failed (${label}): status=${status}, signal=${signal}, timeout=${timedOut}; ${stderr}`));
      });
    });
  } finally {
    await out.close(); await err.close();
    receipt.stdout = await identify(stdout); receipt.stderr = await identify(stderr);
    await fs.writeFile(path.join(directory, label + '.command.json'), JSON.stringify(receipt, null, 2) + '\n');
  }
  return receipt;
}
const run = runLibatomicValidationCommand;

const inspectionProgram = `import json, pathlib, runpy, sys
module = runpy.run_path(sys.argv[1])
spec = json.loads(pathlib.Path(sys.argv[2]).read_text())
objects = [module['decode_object'](item['member'], pathlib.Path(item['disassembly']).read_text()) for item in spec['objects']]
configuration = module['check_configuration'](pathlib.Path(spec['header']).read_text(), pathlib.Path(spec['makefile']).read_text())
inspection = module['check_archive'](objects, spec['publicSymbols'])
print(json.dumps({'configuration': configuration, 'inspection': inspection}, sort_keys=True))
`;

export async function reopenLibatomicBuild(directory, expected) {
  for (const key of ['work', 'sdk', 'sysroot', 'gccSource', 'sourceLockSha256', 'nativeBuild']) assert(expected[key], `Missing libatomic build context ${key}`);
  directory = path.resolve(directory);
  const work = path.resolve(expected.work), sdk = path.resolve(expected.sdk), sysroot = path.resolve(expected.sysroot);
  const source = await fs.realpath(path.join(work, 'gcc')), compiler = path.join(work, 'gcc-native/gcc');
  const reportPath = path.join(directory, 'build.json');
  const reportBytes = await fs.readFile(reportPath), report = JSON.parse(reportBytes);
  verifyLibatomicBuildMetadata(report, expected);
  const frozen = new Map();
  const verify = async (record, file) => {
    const bytes = await readRecord(record, file); frozen.set(path.resolve(record.path), identity(bytes)); return bytes;
  };
  for (const input of report.inputs) await verify(input);
  for (const name of ['build-libatomic.py', 'prepare-source.py']) await verify(report.recipes[name], path.join(here, name));
  await verify(report.sourceLock, path.join(here, 'sources.lock.json'));
  await verify(report.runtimeLock, path.join(here, 'runtime.lock.json'));
  const nativeBytes = await verify(report.nativeBuild, path.join(work, 'native-build.json'));
  assert.equal(path.resolve(expected.nativeBuild.path), path.join(work, 'native-build.json'));
  const native = JSON.parse(nativeBytes);
  assert.deepEqual(native.gccSource, expected.gccSource);
  assert.equal(native.sourceLockSha256, expected.sourceLockSha256);
  for (const name of ['cc1', 'cc1plus', 'xgcc']) {
    await verify(report.nativeCompiler[name], path.join(compiler, name));
    assert.equal(report.nativeCompiler[name].sha256, native.tools[name].sha256);
  }
  const paths = { assembler: path.join(work, 'wabt-native/wat2wasm'), validator: path.join(work, 'wabt-native/wasm-validate'),
    objdump: path.join(work, 'wabt-native/wasm-objdump'), ar: path.join(sdk, 'bin/llvm-ar'), nm: path.join(sdk, 'bin/llvm-nm'),
    ranlib: path.join(sdk, 'bin/llvm-ranlib'), linker: path.join(sdk, 'bin/wasm-ld') };
  for (const [name, file] of Object.entries(paths)) await verify(report.tools[name], await fs.realpath(file));
  for (const name of ['make', 'python', 'shell']) await verify(report.tools[name]);
  const runtimeBytes = await verify(report.runtimeImport, path.join(sysroot, '../runtime-build.json'));
  const runtime = JSON.parse(runtimeBytes);
  assert.deepEqual(runtime.runtimeLock, contentIdentity(report.runtimeLock));
  for (const file of runtime.files) {
    const actual = path.join(sysroot, file.path);
    await verify({ path: actual, bytes: file.bytes, sha256: file.sha256 });
  }
  for (const name of ['crt1-command.o', 'libc.a', 'libm.a', 'libclang_rt.builtins-wasm32.a']) {
    await verify(report.runtimeLibraries[name], path.join(sysroot, 'lib/wasm32-wasi', name));
  }
  for (const record of [...report.resourceHeaders, ...report.librarySources, ...report.configureSupport, ...report.driver]) await verify(record);
  for (const [name, record] of Object.entries(report.configuration)) await verify(record, path.join(directory, 'configuration', name));
  const archive = path.join(directory, 'sysroot/lib/wasm32-wasi/libatomic.a');
  await verify(report.library, archive);
  assert.deepEqual(report.files, [{ path: 'lib/wasm32-wasi/libatomic.a', ...contentIdentity(report.library) }]);
  const licenses = {};
  for (const item of report.licenses) {
    const name = path.basename(item.installed.path);
    const original = await verify(item.source, path.join(source, name));
    const installed = await verify(item.installed, path.join(directory, 'licenses', name));
    assert(original.equals(installed), `Changed GNU libatomic license: ${name}`);
    licenses[name] = item.installed;
  }
  // Preserve every replay in a new private directory, including failures.
  // Never replace source, supplied archive, configuration or earlier evidence.
  const replay = await fs.mkdtemp(path.join(os.tmpdir(), 'gcc-libatomic-replay-'));
  await fs.chmod(replay, 0o700);
  const evidence = { schemaVersion: 1, kind: 'gcc-wasi-libatomic-build-reopen', status: 'running',
    original: { path: reportPath, ...identity(reportBytes) }, commands: [], replayDirectory: replay };
  const save = () => fs.writeFile(path.join(replay, 'reopen.json'), JSON.stringify(evidence, null, 2) + '\n');
  try {
    const list = await run(paths.ar, ['t', archive], replay, 'archive-members'); evidence.commands.push(list);
    assert.deepEqual((await fs.readFile(list.stdout.path, 'utf8')).trimEnd().split('\n').sort(), expectedLibatomicMembers);
    const inspectionSpec = { objects: [], header: report.configuration['auto-config.h'].path,
      makefile: report.configuration.Makefile.path, publicSymbols: expectedLibatomicSymbols };
    await fs.mkdir(path.join(replay, 'original-assembly'));
    for (const object of report.objects) {
      await verify(object.object, path.join(directory, 'members', object.member));
      const storedAssembly = await verify(object.assembly);
      await verify(object.disassembly); await verify(object.symbols);
      const prefix = object.member.replace(/\.o$/u, '');
      const extracted = await run(paths.ar, ['p', archive, object.member], replay, prefix + '-extract'); evidence.commands.push(extracted);
      assert.deepEqual(contentIdentity(extracted.stdout), contentIdentity(object.object), `Archive member changed: ${object.member}`);
      const freshObject = path.join(replay, 'original-assembly', object.member);
      const original = await run(paths.assembler,
        ['-r', '--enable-annotations', '--enable-threads', object.assembly.path, '-o', freshObject], replay, prefix + '-assemble-original');
      evidence.commands.push(original);
      assert.deepEqual(identity(await fs.readFile(freshObject)), contentIdentity(object.object), `Stored assembly no longer produces ${object.member}`);
      const valid = await run(paths.validator, ['--enable-threads', freshObject], replay, prefix + '-validate'); evidence.commands.push(valid);
      const disassembly = await run(paths.objdump, ['-x', '-d', freshObject], replay, prefix + '-inspect'); evidence.commands.push(disassembly);
      inspectionSpec.objects.push({ member: object.member, disassembly: disassembly.stdout.path });
      assert(storedAssembly.length > 0);
    }
    const inspectionFile = path.join(replay, 'inspection-spec.json');
    await fs.writeFile(inspectionFile, JSON.stringify(inspectionSpec, null, 2) + '\n');
    const inspected = await run(report.tools.python.path,
      ['-c', inspectionProgram, path.join(here, 'build-libatomic.py'), inspectionFile], replay, 'inspect-actual-archive');
    evidence.commands.push(inspected);
    const actualInspection = JSON.parse(await fs.readFile(inspected.stdout.path, 'utf8'));
    assert.deepEqual(actualInspection.configuration, report.configurationChecks);
    assert.deepEqual(actualInspection.inspection, report.archiveInspection);
    const rebuilt = path.join(replay, 'rebuilt');
    const build = await run(report.tools.python.path, [path.join(here, 'build-libatomic.py'),
      '--work', work, '--sdk', sdk, '--sysroot', sysroot, '--output', rebuilt, '--jobs', '2'], replay, 'rebuild-gnu-library', 3600000);
    evidence.commands.push(build);
    const rebuiltReport = JSON.parse(await fs.readFile(path.join(rebuilt, 'build.json'), 'utf8'));
    verifyLibatomicBuildMetadata(rebuiltReport, expected);
    evidence.assemblyComparisons = [];
    for (const object of report.objects) {
      const other = rebuiltReport.objects.find(item => item.member === object.member);
      const original = await fs.readFile(object.assembly.path), fresh = await readRecord(other.assembly);
      assertLibatomicAssemblyReplay(original, fresh);
      evidence.assemblyComparisons.push({ member: object.member,
        original: object.assembly, fresh: other.assembly, rawEqual: original.equals(fresh),
        comparison: 'complete-import-order-only' });
    }
    evidence.rebuilt = await identify(path.join(rebuilt, 'build.json'));
    for (const [file, expectedIdentity] of frozen) assert.deepEqual(identity(await fs.readFile(file)), expectedIdentity, `libatomic input changed during replay: ${file}`);
    evidence.status = 'passed'; evidence.inputsUnchanged = true;
    await save();
    return { build: { path: reportPath, ...identity(reportBytes) }, archive: report.library, licenses,
      gccSource: report.gccSource, nativeBuild: report.nativeBuild, profile: report.profile,
      status: 'built-unverified', replay: await identify(path.join(replay, 'reopen.json')) };
  } catch (error) {
    evidence.status = 'failed'; evidence.error = String(error?.stack || error); await save();
    error.message += `; libatomic replay evidence preserved at ${replay}`; throw error;
  }
}


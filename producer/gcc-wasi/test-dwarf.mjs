#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  cases,
  controls,
  diagnostics,
  debugProfile,
  requiredCounts,
  combinations
} from './dwarf-fixtures.mjs';
import { verifyGcovJson, inspectCoverageObject } from './coverage-inspect.mjs';
import {
  dwarfIdentity,
  llvmCodeSection,
  dwarfPc,
  llvmDwarfDies,
  dwarfDieName,
  dwarfFunction,
  dwarfFunctionRange,
  inspectFunctionLocations,
  verifyPrologueLocationBoundary,
  cdpNumericLocal,
  measuredBoundaryVariables,
  assertRecordType,
  assertUserCompilationUnit,
  assertWideTypes,
  inspectDwarfCustomSections,
  consumeDwarfPc,
  sourceFramesFromNodeTrap,
  verifyLiveDwarfValues
} from './dwarf-inspect.mjs';

if (process.argv.includes('--help')) {
  console.log(
    'Usage: node test-dwarf.mjs --work DIR --sdk DIR --sysroot DIR --gcc-cxx-sysroot DIR --output NEW_DIR --playwright INDEX_MJS --chromium EXECUTABLE --wasi-shim DIST_DIR [--libgcov DIR --native-gcov FILE] [--cases ID,ID] [--compiler DIR] [--assembler DIR] [--source DIR] [--wabt-source DIR]'
  );
  console.log(
    'Start Node with a short private /data TMPDIR. Full runs require current-compiler GNU runtime provenance; selected smoke runs are explicitly partial.'
  );
  process.exit(0);
}
const here = path.dirname(fileURLToPath(import.meta.url)),
  options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index].replace(/^--/, '');
  assert(
    [
      'work',
      'compiler',
      'assembler',
      'source',
      'wabt-source',
      'sdk',
      'sysroot',
      'gcc-cxx-sysroot',
      'output',
      'playwright',
      'chromium',
      'wasi-shim',
      'libgcov',
      'native-gcov',
      'cases'
    ].includes(key) &&
      process.argv[index + 1] &&
      !options[key],
    `Invalid option ${process.argv[index]}`
  );
  options[key] = key === 'cases' ? process.argv[index + 1] : path.resolve(process.argv[index + 1]);
}
for (const key of [
  'work',
  'sdk',
  'sysroot',
  'gcc-cxx-sysroot',
  'output',
  'playwright',
  'chromium',
  'wasi-shim'
])
  assert(options[key], `Required --${key}`);
const { work, sdk, sysroot, output } = options,
  compiler = options.compiler ?? path.join(work, 'gcc-native/gcc');
const assemblerRoot = options.assembler ?? path.join(work, 'wabt-native');
const selected = options.cases
  ? cases.filter((fixture) => options.cases.split(',').includes(fixture.id))
  : cases;
assert(selected.length && (!options.cases || selected.length === options.cases.split(',').length));
await fs.mkdir(output, { recursive: false, mode: 0o700 });
const inputs = new Map(),
  artifacts = new Map();
async function identity(file) {
  return { path: path.resolve(file), ...dwarfIdentity(await fs.readFile(file)) };
}
async function freeze(file) {
  const receipt = await identity(file);
  if (inputs.has(receipt.path))
    assert.deepEqual(receipt, inputs.get(receipt.path), 'Changed input ' + file);
  inputs.set(receipt.path, receipt);
  return receipt;
}
async function artifact(file) {
  const receipt = await identity(file);
  artifacts.set(receipt.path, receipt);
  return receipt;
}
async function write(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, data, { flag: 'wx', mode: 0o600 });
  return artifact(file);
}
async function inventory(directory) {
  const values = [];
  for (const item of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) values.push(...(await inventory(file)));
    else {
      assert(item.isFile());
      values.push(await freeze(file));
    }
  }
  return values;
}
function run(command, argv, cwd = output, stdin = null, timeout = 120000, environment = {}) {
  const value = spawnSync(command, argv, {
    cwd,
    input: stdin ?? undefined,
    encoding: 'utf8',
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C', ...environment }
  });
  return {
    command,
    argv,
    cwd,
    stdin,
    ...(Object.keys(environment).length ? { environment } : {}),
    status: value.status,
    signal: value.signal,
    stdout: value.stdout || '',
    stderr: value.stderr || '',
    ...(value.error ? { error: value.error.message } : {})
  };
}
function success(result) {
  if (result.status !== 0 || result.signal !== null || result.error) report.failedCommand = result;
  assert.equal(result.status, 0, result.stderr || result.error || 'Tool failed');
  assert.equal(result.signal, null);
  assert(!result.error);
  return result;
}
const toolPaths = {
  gcc: path.join(compiler, 'cc1'),
  gccCpp: path.join(compiler, 'cc1plus'),
  linker: path.join(sdk, 'bin/wasm-ld'),
  assembler: path.join(assemblerRoot, 'wat2wasm'),
  objdump: path.join(assemblerRoot, 'wasm-objdump'),
  validator: path.join(assemblerRoot, 'wasm-validate'),
  llvmDwarf: path.join(sdk, 'bin/llvm-dwarfdump'),
  symbolizer: path.join(sdk, 'bin/llvm-symbolizer'),
  llvmObjdump: path.join(sdk, 'bin/llvm-objdump'),
  objcopy: path.join(sdk, 'bin/llvm-objcopy'),
  node: process.execPath,
  chromium: options.chromium
};
if (!options.cases) {
  assert(
    options.libgcov && options['native-gcov'],
    'Full qualification requires --libgcov and --native-gcov'
  );
  toolPaths.gcov = options['native-gcov'];
  toolPaths.gcovDump = path.join(path.dirname(options['native-gcov']), 'gcov-dump');
}
const report = {
  schemaVersion: 1,
  kind: 'gcc-wasi-native-dwarf-qualification',
  status: 'running',
  profile: debugProfile,
  scope: {
    fullMatrix: !options.cases,
    selectedCases: selected.map((fixture) => fixture.id),
    compilerHost: 'native',
    target: 'wasm32-wasi',
    browserRunsCompiler: false
  },
  cases: [],
  controls: [],
  diagnostics: [],
  combinations: [],
  sourceChecks: []
};
async function save(stage) {
  await fs.writeFile(
    path.join(output, 'progress.json'),
    JSON.stringify({
      status: report.status,
      stage,
      cases: report.cases.length,
      passedCases: report.cases.filter((value) => value.status === 'passed').length,
      controls: report.controls.length,
      diagnostics: report.diagnostics.length
    }) + '\n'
  );
  await fs.writeFile(
    path.join(output, 'qualification.json'),
    JSON.stringify(report, null, 2) + '\n'
  );
}
const runnerSource = `import {readFile} from 'node:fs/promises'; import {WASI} from 'node:wasi';
const wasi=new WASI({version:'preview1',args:['program',...process.argv.slice(3)],env:{},preopens:process.env.DWARF_PROFILE_DIRECTORY?{'/profile':process.env.DWARF_PROFILE_DIRECTORY}:{},returnOnExit:true});
const instance=await WebAssembly.instantiate(await WebAssembly.compile(await readFile(process.argv[2])),{wasi_snapshot_preview1:wasi.wasiImport});process.exitCode=wasi.start(instance);\n`;
let archives, includes, runner;
async function compileFixture(fixture, profile, suffix) {
  const directory = path.join(output, 'programs', fixture.id, suffix);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const files = [];
  for (const file of fixture.files)
    files.push(await write(path.join(directory, file.path), file.contents));
  const units = [];
  for (const [index, sourceName] of fixture.sources.entries()) {
    const source = path.join(directory, sourceName),
      wat = path.join(directory, `unit${index}.wat`),
      object = path.join(directory, `unit${index}.o`),
      cpp = fixture.language === 'cpp';
    const debug =
      profile.debug === 'dwarf4'
        ? debugProfile.compilerFlags
        : profile.debug === 'g0'
          ? ['-g0']
          : [];
    const argv = [
      '-quiet',
      '-O' + profile.optimization,
      '-std=' + fixture.standard,
      profile.simd ? '-msimd128' : '-mno-simd128',
      '-fdiagnostics-color=never',
      '-nostdinc',
      '-D__GCC_WASI_SINGLE_THREAD__=1',
      ...(cpp
        ? ['-fno-exceptions', '-frtti', '-fuse-cxa-atexit', '-fno-threadsafe-statics']
        : ['-Werror=implicit-function-declaration']),
      ...debug,
      ...(profile.coverage
        ? [
            '-fprofile-arcs',
            '-ftest-coverage',
            '-fprofile-update=single',
            '-fprofile-dir=/profile',
            '-fprofile-prefix-path=' + directory,
            '-dumpbase',
            `program${index ? '.' + index : ''}.c`,
            '-dumpbase-ext',
            '.c'
          ]
        : []),
      '-I' + directory,
      ...(cpp ? includes.cpp : includes.c).flatMap((value) => ['-isystem', value]),
      source,
      '-o',
      wat
    ];
    const compilation = success(
      run(cpp ? toolPaths.gccCpp : toolPaths.gcc, argv, directory, null, 600000)
    );
    const assembly = await artifact(wat),
      assembling = success(
        run(
          toolPaths.assembler,
          ['-r', '--enable-annotations', wat, '-o', object],
          directory,
          null,
          600000
        )
      );
    const objectReceipt = await artifact(object),
      validation = success(run(toolPaths.validator, [object], directory));
    const verify = success(run(toolPaths.llvmDwarf, ['--verify', object], directory));
    const dwarf = success(
      run(toolPaths.llvmDwarf, ['--debug-info', '--debug-line', '--debug-loc', object], directory)
    );
    await write(path.join(directory, `unit${index}.dwarf.txt`), dwarf.stdout);
    const sourceUnit =
      profile.debug === 'dwarf4' ? assertUserCompilationUnit(dwarf.stdout, source) : null;
    const objectSections = await inspectDwarfCustomSections(
      await fs.readFile(object),
      profile.debug === 'dwarf4'
    );
    units.push({
      sourceName,
      sourceUnit,
      source: await freeze(source),
      assembly,
      object: objectReceipt,
      objectSections,
      ...(profile.coverage
        ? { notes: await artifact(path.join(directory, `program${index ? '.' + index : ''}.gcno`)) }
        : {}),
      commands: { compilation, assembling, validation, verify },
      dwarfText: dwarf.stdout
    });
  }
  const program = path.join(directory, 'program.wasm');
  const linkArgv = [
    '--fatal-warnings',
    '--gc-sections',
    '-m',
    'wasm32',
    '-e',
    '_start',
    '-o',
    program,
    archives.crt,
    '-L' + path.dirname(archives.libc),
    '-L' + path.dirname(archives.libstdcxx),
    ...units.map((unit) => unit.object.path),
    ...(fixture.language === 'cpp' ? ['-lstdc++'] : []),
    ...(profile.coverage ? [archives.libgcov, archives.getpid] : []),
    '-lm',
    '-lc',
    archives.builtins
  ];
  const linking = success(run(toolPaths.linker, linkArgv, directory, null, 600000)),
    programReceipt = await artifact(program);
  const verify = success(run(toolPaths.llvmDwarf, ['--verify', program], directory));
  const headers = success(run(toolPaths.llvmObjdump, ['--section-headers', program], directory)),
    code = llvmCodeSection(headers.stdout);
  const bytes = await fs.readFile(program),
    codeIdentity = dwarfIdentity(bytes.subarray(code.offset, code.offset + code.size));
  const sections = await inspectDwarfCustomSections(
    bytes,
    profile.debug === 'dwarf4' ? true : null
  );
  const dwarf = success(
    run(
      toolPaths.llvmDwarf,
      ['--debug-info', '--debug-line', '--debug-loc', program],
      directory,
      null,
      600000
    )
  );
  if (profile.debug !== 'dwarf4')
    for (const unit of units)
      assert(
        !dwarf.stdout.includes('\"' + unit.source.path + '\"'),
        'Release user source leaked into inherited runtime DWARF'
      );
  const dump = await write(path.join(directory, 'linked.dwarf.txt'), dwarf.stdout),
    dies = llvmDwarfDies(dwarf.stdout);
  const result = {
    fixtureId: fixture.id,
    profile,
    files,
    units,
    program: programReceipt,
    code,
    codeIdentity,
    debugSections: sections,
    dwarfDump: dump,
    commands: { linking, verify, headers },
    dies
  };
  if (profile.debug === 'dwarf4') {
    const consumer = path.join(directory, 'consumer.wasm');
    result.commands.consumerCopy = success(
      run(
        toolPaths.objcopy,
        ['--remove-section=name', '--remove-section=EXPORT', program, consumer],
        directory
      )
    );
    result.consumer = await artifact(consumer);
    result.commands.consumerVerify = success(
      run(toolPaths.llvmDwarf, ['--verify', consumer], directory)
    );
    const consumerHeaders = success(
        run(toolPaths.llvmObjdump, ['--section-headers', consumer], directory)
      ),
      consumerCode = llvmCodeSection(consumerHeaders.stdout),
      consumerBytes = await fs.readFile(consumer);
    assert.deepEqual(
      dwarfIdentity(
        consumerBytes.subarray(consumerCode.offset, consumerCode.offset + consumerCode.size)
      ),
      codeIdentity
    );
    assert.deepEqual(
      await inspectDwarfCustomSections(consumerBytes),
      sections,
      'Consumer copy changed raw debug custom bytes'
    );
    result.consumerCode = consumerCode;
    result.consumerBytesPreserved = true;
  }
  return result;
}
function compactProgram(program) {
  const { dies, ...value } = program;
  return { ...value, units: value.units.map(({ dwarfText, ...unit }) => unit) };
}
function normalNode(program, runSpec) {
  const command = success(
    run(
      toolPaths.node,
      ['--no-warnings', runner, program.program.path, ...(runSpec.args ?? [])],
      output,
      runSpec.stdin
    )
  );
  assert.equal(command.stdout, runSpec.stdout);
  assert.equal(command.stderr, '');
  return command;
}
function officialSourceConsumers(program, fixture, name, pc) {
  return consumeDwarfPc({ program, fixture, name, pc, run, toolPaths, cwd: output });
}
function symbolizedFrames(program, fixture, nodeTrap) {
  return sourceFramesFromNodeTrap(program, fixture, nodeTrap, (name, pc) =>
    officialSourceConsumers(program, fixture, name, pc)
  );
}

const browserHostSource = `import {WASI,File,OpenFile,ConsoleStdout,PreopenDirectory} from '/shim/index.js';
globalThis.guestMemory=null;
globalThis.runGuest=async(id,stdin,args,coverage=false)=>{const streams=[[],[]];const out=index=>new ConsoleStdout(bytes=>streams[index].push(...bytes));
const profile=new Map(),fds=[new OpenFile(new File(new TextEncoder().encode(stdin),{readonly:true})),out(0),out(1)];if(coverage)fds.push(new PreopenDirectory('/profile',profile));
const wasi=new WASI(['program',...args],[],fds,{debug:false});
const bytes=await(await fetch('/program/'+id)).arrayBuffer();const module=await WebAssembly.compile(bytes);const instance=await WebAssembly.instantiate(module,{wasi_snapshot_preview1:wasi.wasiImport});globalThis.guestMemory=instance.exports.memory;
let exitCode,error;try{exitCode=wasi.start(instance);}catch(value){error={message:value.message,stack:value.stack};}
const profiles=[];for(const[name,file]of profile){if(!(file instanceof File)||name.includes('/')||file.data.length>16*1024*1024)throw Error('Unexpected coverage output');profiles.push({name,contents:Array.from(file.data)});}
return{exitCode,error,stdout:new TextDecoder().decode(Uint8Array.from(streams[0])),stderr:new TextDecoder().decode(Uint8Array.from(streams[1])),moduleBytes:bytes.byteLength,profiles};};\n`;
let browser, server, page, cdp, currentPlan, activePause;
const browserPrograms = new Map(),
  scripts = new Map(),
  pauseFailures = [];
async function startBrowser() {
  assert(
    os.tmpdir().startsWith('/data/') &&
      Buffer.byteLength(
        path.join(os.tmpdir(), 'playwright_chromiumdev_profile-XXXXXX/SingletonSocket')
      ) < 100,
    'Use short private /data TMPDIR before starting Node'
  );
  await write(path.join(output, 'browser-host.mjs'), browserHostSource);
  const shim = await fs.realpath(options['wasi-shim']);
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    try {
      if (pathname === '/probe') {
        response.setHeader('Content-Type', 'text/html');
        response.end(
          '<!doctype html><title>Genuine GCC DWARF qualification</title><script type="module" src="/host.mjs"></script>'
        );
        return;
      }
      let file;
      if (pathname === '/host.mjs') file = path.join(output, 'browser-host.mjs');
      else if (pathname.startsWith('/program/')) {
        const program = browserPrograms.get(decodeURIComponent(pathname.slice(9)));
        assert(program);
        file = program.program.path;
      } else if (pathname.startsWith('/shim/')) {
        file = await fs.realpath(path.resolve(shim, pathname.slice(6)));
        assert(file.startsWith(shim + path.sep));
      } else {
        response.statusCode = 404;
        response.end('Missing qualification input');
        return;
      }
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader(
        'Content-Type',
        file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript'
      );
      response.end(await fs.readFile(file));
    } catch (error) {
      response.statusCode = 500;
      response.end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { chromium } = await import(pathToFileURL(options.playwright));
  browser = await chromium.launch({ headless: true, executablePath: options.chromium });
  report.browser = await browser.version();
  page = await browser.newPage();
  cdp = await page.context().newCDPSession(page);
  cdp.on('Debugger.scriptParsed', (script) => {
    if (script.scriptLanguage === 'WebAssembly') scripts.set(script.scriptId, script);
  });
  cdp.on('Debugger.paused', async (event) => {
    const wasmFrames = event.callFrames.filter((frame) => scripts.has(frame.location.scriptId));
    if (!wasmFrames.length) {
      await cdp.send('Debugger.resume');
      return;
    }
    try {
      assert(currentPlan && !activePause, 'Unexpected or repeated Wasm pause');
      activePause = { reason: event.reason, frames: [] };
      for (const frame of wasmFrames) {
        const script = scripts.get(frame.location.scriptId);
        assert.equal(script.codeOffset, currentPlan.program.code.offset);
        const pc = dwarfPc(frame.location.columnNumber, script.codeOffset),
          plan = currentPlan.frames.find((value) => pc >= value.range.low && pc < value.range.high);
        if (!plan) continue;
        const scope = frame.scopeChain.find((value) => value.type === 'local');
        assert(scope);
        const properties = await cdp.send('Runtime.getProperties', {
          objectId: scope.object.objectId,
          ownProperties: true
        });
        const locations = inspectFunctionLocations(
          dwarfFunction(currentPlan.program.dies, plan.name),
          pc
        );
        const wantedIndices = new Set();
        if (locations.frameBase.kind === 'local') wantedIndices.add(locations.frameBase.index);
        for (const name of Object.keys(plan.expected)) {
          const location = locations.variables.find((variable) => variable.name === name)?.location;
          assert(location && location.kind !== 'unavailable');
          if (location.kind === 'local') wantedIndices.add(location.index);
          if (location.kind === 'pieces')
            for (const index of location.indices) wantedIndices.add(index);
        }
        const locals = [];
        for (const index of wantedIndices) {
          const property = properties.result.find((value) => value.name === '$var' + index);
          assert(property, `CDP lacks actual indexed local $var${index}`);
          let value = property.value;
          if (value.objectId) {
            const fields = await cdp.send('Runtime.getProperties', {
              objectId: value.objectId,
              ownProperties: true
            });
            value = fields.result.find((field) => field.name === 'value')?.value;
          }
          assert(value);
          locals.push({ name: property.name, value });
        }
        activePause.frames.push({
          name: plan.name,
          runtimeFunction: frame.functionName,
          location: frame.location,
          codeOffset: script.codeOffset,
          pc,
          localCount: properties.result.length,
          locals
        });
      }
      const memory = await cdp.send('Runtime.evaluate', {
        expression: 'Array.from(new Uint8Array(globalThis.guestMemory.buffer))',
        returnByValue: true,
        silent: true
      });
      assert(Array.isArray(memory.result.value) && memory.result.value.length <= 2 * 1024 * 1024);
      activePause.memory = memory.result.value;
    } catch (error) {
      pauseFailures.push(error.stack || String(error));
    }
    await cdp.send('Debugger.resume');
  });
  await cdp.send('Debugger.enable');
  await page.goto('http://127.0.0.1:' + server.address().port + '/probe');
  await page.waitForFunction(() => typeof globalThis.runGuest === 'function');
}
function verifyLiveValues(fixture, program, frames, pause) {
  return verifyLiveDwarfValues(fixture, program, frames, pause, (name, pc) =>
    officialSourceConsumers(program, fixture, name, pc)
  );
}

async function evaluateGuest(value) {
  let timer;
  try {
    return await Promise.race([
      page.evaluate(
        ({ id, stdin, args, coverage }) => globalThis.runGuest(id, stdin, args, coverage),
        value
      ),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          browser?.close().catch(() => {});
          reject(new Error('Actual Chromium WASI execution exceeded 120 seconds'));
        }, 120000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function executeFixture(fixture, program) {
  const executions = [];
  browserPrograms.set(fixture.id, program);
  if (fixture.family === 'frames')
    program.recordType = assertRecordType(program.dies, fixture.expected.recordType);
  if (fixture.family === 'wide') program.wideTypes = assertWideTypes(program.dies);
  if (fixture.family === 'main-abi') {
    const main = dwarfFunction(program.dies, 'main'),
      parameters = main.children
        .filter((die) => die.tag === 'DW_TAG_formal_parameter')
        .map((die) => dwarfDieName(die));
    assert.deepEqual(parameters, fixture.abi === 'void' ? [] : ['argc', 'argv']);
    program.mainAbi = { kind: fixture.abi, formalParameterNames: parameters };
  }
  for (const spec of fixture.runs) {
    await save('execute-' + fixture.id + '-' + spec.id);
    if (!spec.trap) {
      const native = normalNode(program, spec);
      await cdp.send('Debugger.setPauseOnExceptions', { state: 'none' });
      const chromium = await evaluateGuest({
        id: fixture.id,
        stdin: spec.stdin,
        args: spec.args ?? []
      });
      assert.equal(chromium.exitCode, 0);
      assert.equal(chromium.stdout, spec.stdout);
      assert.equal(chromium.stderr, '');
      assert(!chromium.error);
      executions.push({ id: spec.id, node: native, chromium, status: 'passed' });
    } else {
      const native = run(
        toolPaths.node,
        ['--no-warnings', runner, program.program.path, ...(spec.args ?? [])],
        output,
        spec.stdin
      );
      assert.notEqual(native.status, 0);
      assert.match(native.stderr, /unreachable/);
      assert.equal(native.stdout, spec.stdout);
      const frames = symbolizedFrames(program, fixture, native);
      currentPlan = { program, frames };
      activePause = undefined;
      await cdp.send('Debugger.setPauseOnExceptions', { state: 'all' });
      const chromium = await evaluateGuest({
        id: fixture.id,
        stdin: spec.stdin,
        args: spec.args ?? []
      });
      assert.match(chromium.error?.message, /unreachable/);
      assert.equal(chromium.stdout, spec.stdout);
      assert.equal(chromium.stderr, '');
      assert(activePause);
      assert.deepEqual(pauseFailures, []);
      const live = verifyLiveValues(fixture, program, frames, activePause);
      const snapshot = await write(
        path.join(path.dirname(program.program.path), 'pause.json'),
        JSON.stringify(activePause, null, 2) + '\n'
      );
      executions.push({
        id: spec.id,
        node: native,
        chromium,
        frames,
        live,
        pause: snapshot,
        status: 'passed'
      });
      currentPlan = undefined;
    }
  }
  await cdp.send('Debugger.setPauseOnExceptions', { state: 'none' });
  return executions;
}

async function extraNormal(fixture, program, id) {
  const spec = fixture.runs.find((value) => !value.trap),
    node = normalNode(program, spec);
  browserPrograms.set(id, program);
  await cdp.send('Debugger.setPauseOnExceptions', { state: 'none' });
  const chromium = await evaluateGuest({ id, stdin: spec.stdin, args: spec.args ?? [] });
  assert.equal(chromium.exitCode, 0);
  assert.equal(chromium.stdout, spec.stdout);
  assert.equal(chromium.stderr, '');
  assert(!chromium.error);
  return { node, chromium };
}
async function qualifyControls(fixture, debugProgram) {
  const releases = [];
  for (const control of controls.filter((value) => value.kind !== 'strip')) {
    await save('control-' + fixture.id + '-' + control.id);
    const program = await compileFixture(fixture, control, 'control-' + control.id);
    const execution = await extraNormal(fixture, program, fixture.id + '-' + control.id);
    const proof = {
      id: fixture.id + '-' + control.id,
      control,
      program: compactProgram(program),
      execution,
      status: 'passed'
    };
    if (control.kind === 'release') releases.push({ control, program });
    else {
      const die = dwarfFunction(program.dies, 'debug_leaf'),
        range = dwarfFunctionRange(die),
        probes = new Set([range.low, range.high - 1]);
      function collectRanges(value) {
        for (const attribute of Object.values(value.attributes))
          for (const match of attribute.matchAll(/\[0x([\da-f]+),\s*0x([\da-f]+)\):/gi)) {
            const pc = Number.parseInt(match[1], 16);
            if (pc >= range.low && pc < range.high) probes.add(pc);
          }
        for (const child of value.children) collectRanges(child);
      }
      collectRanges(die);
      for (const pc of probes) {
        const locations = inspectFunctionLocations(die, pc);
        for (const name of ['adjusted', 'local']) {
          const variable = locations.variables.find((value) => value.name === name);
          assert(
            !variable || variable.location.kind === 'unavailable',
            `Unsupported O2 register location must remain unavailable: ${name} at ${pc}`
          );
        }
      }
      proof.optimizedRegisterLocations = {
        status: 'unavailable',
        probedRangeBoundaries: [...probes]
      };
    }
    report.controls.push(proof);
  }
  for (const optimization of ['0', '2']) {
    const pair = releases.filter((value) => value.control.optimization === optimization);
    assert.equal(pair.length, 2);
    assert.deepEqual(
      pair[0].program.codeIdentity,
      pair[1].program.codeIdentity,
      'Default and -g0 changed executable code'
    );
  }
  for (const control of controls.filter((value) => value.kind === 'strip')) {
    const file = path.join(path.dirname(debugProgram.program.path), control.id + '.wasm');
    const copying = success(
      run(toolPaths.objcopy, [control.option, debugProgram.program.path, file])
    );
    const receipt = await artifact(file),
      bytes = await fs.readFile(file),
      headers = success(run(toolPaths.llvmObjdump, ['--section-headers', file])),
      code = llvmCodeSection(headers.stdout);
    assert.deepEqual(
      dwarfIdentity(bytes.subarray(code.offset, code.offset + code.size)),
      debugProgram.codeIdentity,
      'Strip changed actual CODE payload'
    );
    await inspectDwarfCustomSections(bytes, false);
    const stripped = { ...debugProgram, program: receipt, code },
      execution = await extraNormal(fixture, stripped, fixture.id + '-' + control.id);
    report.controls.push({
      id: fixture.id + '-' + control.id,
      control,
      copying,
      artifact: receipt,
      codeBytesPreserved: true,
      debugSectionsRemoved: true,
      execution,
      status: 'passed'
    });
  }
}
async function analyzeCombinationCoverage(fixture, program, profile, directory) {
  const built = program.units[0];
  assert.equal(program.units.length, 1);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const note = path.join(directory, 'program.gcno'),
    data = path.join(directory, 'program.gcda');
  await fs.copyFile(built.notes.path, note);
  await fs.copyFile(profile.path, data);
  const analysis = {
    unit: fixture.coverageUnit.id,
    source: built.source,
    note: await artifact(note),
    profile: await artifact(data),
    commands: {}
  };
  assert.equal(analysis.note.sha256, built.notes.sha256);
  assert.equal(analysis.profile.sha256, profile.sha256);
  for (const [name, file] of [
    ['noteDump', note],
    ['profileDump', data]
  ]) {
    analysis.commands[name] = success(run(toolPaths.gcovDump, ['-l', file], directory));
    assert(analysis.commands[name].stdout.includes("version `B70 '"));
    assert.equal(analysis.commands[name].stderr, '');
  }
  analysis.commands.gcov = success(
    run(
      toolPaths.gcov,
      ['--json-format', '--branch-probabilities', '--branch-counts', note],
      directory
    )
  );
  assert.equal(analysis.commands.gcov.stderr, '');
  const compressed = (await fs.readdir(directory)).filter((name) => name.endsWith('.gcov.json.gz'));
  assert.equal(compressed.length, 1);
  analysis.compressedJson = await artifact(path.join(directory, compressed[0]));
  const decoded = gunzipSync(await fs.readFile(analysis.compressedJson.path));
  analysis.json = await write(path.join(directory, 'gcov.json'), decoded);
  const dataJson = JSON.parse(decoded);
  assert.equal(dataJson.data_file, note);
  analysis.counts = verifyGcovJson(
    dataJson,
    fixture.coverageUnit,
    fixture.coverageExpected,
    1,
    built.source.path
  );
  return analysis;
}

async function qualifyCombinations() {
  for (const fixture of combinations) {
    await save('combination-' + fixture.id);
    const entry = {
      id: fixture.id,
      feature: fixture.feature,
      fixtureSha256: dwarfIdentity(Buffer.from(JSON.stringify(fixture))).sha256,
      status: 'running',
      executions: {}
    };
    report.combinations.push(entry);
    const coverage = fixture.feature === 'coverage';
    const program = await compileFixture(
      fixture,
      {
        debug: 'dwarf4',
        optimization: '0',
        ...(coverage ? { coverage: true } : { simd: true })
      },
      'debug'
    );
    entry.program = compactProgram(program);
    const spec = fixture.runs[0],
      directory = path.dirname(program.program.path);
    const profileDirectory = path.join(directory, 'node-profile');
    if (coverage) await fs.mkdir(profileDirectory, { mode: 0o700 });
    const node = success(
      run(
        toolPaths.node,
        ['--no-warnings', runner, program.program.path, ...(spec.args ?? [])],
        output,
        spec.stdin,
        120000,
        coverage ? { DWARF_PROFILE_DIRECTORY: profileDirectory } : {}
      )
    );
    assert.equal(node.stdout, spec.stdout);
    assert.equal(node.stderr, '');
    entry.executions.node = { command: node, profiles: [], analysis: [] };
    browserPrograms.set(fixture.id, program);
    await cdp.send('Debugger.setPauseOnExceptions', { state: 'none' });
    const chromium = await evaluateGuest({
      id: fixture.id,
      stdin: spec.stdin,
      args: spec.args ?? [],
      coverage
    });
    assert.equal(chromium.exitCode, 0);
    assert.equal(chromium.stdout, spec.stdout);
    assert.equal(chromium.stderr, '');
    assert(!chromium.error);
    const { profiles: browserProfiles, ...result } = chromium;
    entry.executions.chromium = { result, profiles: [], analysis: [] };
    assert(Array.isArray(browserProfiles));
    if (coverage) {
      assert.deepEqual((await fs.readdir(profileDirectory)).sort(), ['program.gcda']);
      assert.deepEqual(
        browserProfiles.map((value) => value.name),
        ['program.gcda']
      );
      const nodeProfile = await artifact(path.join(profileDirectory, 'program.gcda'));
      assert(nodeProfile.bytes > 0 && nodeProfile.bytes <= 16 * 1024 * 1024);
      entry.executions.node.profiles.push(nodeProfile);
      const profile = browserProfiles[0];
      assert(profile.contents.length > 0 && profile.contents.length <= 16 * 1024 * 1024);
      assert(
        profile.contents.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
      );
      const browserProfile = await write(
        path.join(directory, 'chromium-profile/program.gcda'),
        Uint8Array.from(profile.contents)
      );
      entry.executions.chromium.profiles.push(browserProfile);
      for (const [host, profile] of [
        ['node', nodeProfile],
        ['chromium', browserProfile]
      ])
        entry.executions[host].analysis.push(
          await analyzeCombinationCoverage(
            fixture,
            program,
            profile,
            path.join(directory, host + '-analysis')
          )
        );
      entry.instrumentation = [];
      for (const unit of program.units) {
        const command = success(run(toolPaths.objdump, ['-d', unit.object.path], directory));
        entry.instrumentation.push({
          object: unit.object,
          command,
          inspection: inspectCoverageObject(
            await fs.readFile(unit.object.path),
            { mode: 'coverage' },
            command.stdout
          )
        });
      }
    } else {
      assert.deepEqual(browserProfiles, []);
      const command = success(run(toolPaths.objdump, ['-d', program.program.path], directory));
      const simdOpcodes = command.stdout.split('\n').flatMap((line) => {
        const match = /\|\s+((?:v128|i8x16|i16x8|i32x4|i64x2|f32x4|f64x2)\.\S+)/.exec(line);
        return match ? [match[1]] : [];
      });
      assert(simdOpcodes.includes('i32x4.add'), 'Combined debug program must execute actual SIMD');
      entry.instructions = { command, simdOpcodes };
    }
    entry.status = 'passed';
    await save('completed-combination-' + fixture.id);
  }
}

try {
  report.tools = Object.fromEntries(
    await Promise.all(
      Object.entries(toolPaths).map(async ([name, file]) => [name, await freeze(file)])
    )
  );
  report.recipes = Object.fromEntries(
    await Promise.all(
      [
        'dwarf-fixtures.mjs',
        'dwarf-fixtures.test.mjs',
        'dwarf-inspect.mjs',
        'test-dwarf.mjs',
        'prepare-source.py',
        'build-native.sh',
        'build-wabt.sh',
        'runtime.lock.json',
        'coverage-fixtures.mjs',
        'coverage-inspect.mjs',
        'symbol-alias-inspect.mjs',
        'inspect-vector-abi.mjs',
        'build-libgcov.sh',
        'build-libgcov.py'
      ].map(async (name) => [name, await freeze(path.join(here, name))])
    )
  );
  report.sourceLock = await freeze(path.join(here, 'sources.lock.json'));
  const lock = JSON.parse(await fs.readFile(report.sourceLock.path));
  assert(
    lock.gcc.patches.length > 20,
    'DWARF qualification requires the newly pinned GCC source profile'
  );
  for (const component of ['gcc', 'wabt'])
    for (const patch of lock[component].patches)
      assert.equal((await freeze(path.join(here, patch.path))).sha256, patch.sha256);
  for (const [component, directory] of [
    ['gcc', options.source ?? path.join(work, 'gcc')],
    ['wabt', options['wabt-source'] ?? path.join(work, 'wabt-source')]
  ]) {
    const command = success(
      run(
        'python3',
        [path.join(here, 'prepare-source.py'), '--component', component, '--source', directory],
        output,
        null,
        600000
      )
    );
    report.sourceChecks.push(command);
    report[component + 'Source'] = JSON.parse(command.stdout);
  }
  report.nativeBuild = await freeze(path.join(work, 'native-build.json'));
  const native = JSON.parse(await fs.readFile(report.nativeBuild.path));
  assert.equal(native.sourceLockSha256, report.sourceLock.sha256);
  assert.deepEqual(native.gccSource, report.gccSource);
  for (const [name, key] of [
    ['cc1', 'gcc'],
    ['cc1plus', 'gccCpp']
  ])
    assert.equal(native.tools[name].sha256, report.tools[key].sha256);
  report.assemblerBuild = await freeze(path.join(work, 'wabt-native/provenance.json'));
  const assembler = JSON.parse(await fs.readFile(report.assemblerBuild.path));
  assert(assembler.inputsUnchanged);
  assert.deepEqual(assembler.source, report.wabtSource);
  for (const [name, key] of [
    ['wat2wasm', 'assembler'],
    ['wasm-objdump', 'objdump'],
    ['wasm-validate', 'validator']
  ])
    assert.deepEqual(assembler.files[name], dwarfIdentity(await fs.readFile(toolPaths[key])));
  report.llvmVersions = {};
  for (const name of ['llvmDwarf', 'symbolizer']) {
    const command = success(run(toolPaths[name], ['--version']));
    assert(command.stdout.includes('22.1.0-wasi-sdk'));
    report.llvmVersions[name] = command;
  }
  const cxx = options['gcc-cxx-sysroot'],
    version = lock.gcc.version,
    library = path.join(sysroot, 'lib/wasm32-wasi');
  includes = {
    c: [
      path.join(compiler, 'include'),
      path.join(sysroot, 'include/wasm32-wasi'),
      path.join(sysroot, 'include')
    ],
    cpp: [
      path.join(cxx, 'include/c++', version),
      path.join(cxx, 'include/c++', version, 'wasm32-wasi'),
      path.join(cxx, 'include/c++', version, 'backward'),
      path.join(compiler, 'include'),
      path.join(sysroot, 'include/wasm32-wasi'),
      path.join(sysroot, 'include')
    ]
  };
  archives = {
    crt: path.join(library, 'crt1-command.o'),
    libc: path.join(library, 'libc.a'),
    libm: path.join(library, 'libm.a'),
    libstdcxx: path.join(cxx, 'lib/wasm32-wasi/libstdc++.a'),
    builtins: path.join(library, 'libclang_rt.builtins-wasm32.a')
  };
  report.runtime = {
    sysroot,
    gnuSysroot: cxx,
    includeRoots: includes,
    headers: {},
    archives: {},
    origin:
      'The actual reused runtime identity and its own build source are recorded separately; this report does not imply those archives were rebuilt by the new debug compiler.'
  };
  for (const [name, directory] of [
    ['gcc', path.join(compiler, 'include')],
    ['target', path.join(sysroot, 'include')],
    ['gnu', path.join(cxx, 'include')]
  ])
    report.runtime.headers[name] = await inventory(directory);
  for (const [name, file] of Object.entries(archives))
    report.runtime.archives[name] = await freeze(file);
  for (const [name, file] of [
    ['importReceipt', path.join(path.dirname(sysroot), 'runtime-build.json')],
    ['gnuBuild', path.join(path.dirname(cxx), 'build.json')],
    ['gnuQualification', path.join(path.dirname(cxx), 'qualification/qualification.json')]
  ]) {
    const receipt = await freeze(file);
    report.runtime[name] = receipt;
  }
  const gnuBuild = JSON.parse(await fs.readFile(report.runtime.gnuBuild.path)),
    gnuQualification = JSON.parse(await fs.readFile(report.runtime.gnuQualification.path));
  report.runtime.gnuCompilerSource = gnuBuild.gccSource;
  assert.equal(gnuQualification.status, 'passed');
  assert.deepEqual(gnuQualification.buildReceipt, {
    bytes: report.runtime.gnuBuild.bytes,
    sha256: report.runtime.gnuBuild.sha256
  });
  report.runtime.currentCompilerBound =
    JSON.stringify(gnuBuild.gccSource) === JSON.stringify(report.gccSource);
  if (!options.cases) {
    assert.deepEqual(
      gnuBuild.gccSource,
      report.gccSource,
      'Full qualification requires fresh source21 GNU runtime, not a source20 smoke-test borrow'
    );
    for (const [name, key] of [
      ['cc1', 'gcc'],
      ['cc1plus', 'gccCpp']
    ])
      assert.equal(
        gnuBuild.nativeCompiler[name],
        report.tools[key].sha256,
        'GNU runtime compiler identity mismatch'
      );
    assert.equal(gnuBuild.rtti, true);
    assert.equal(gnuQualification.rtti, true);
    assert.equal(gnuBuild.exceptions, false);
    const coverageRoot = options.libgcov,
      library = path.join(coverageRoot, 'sysroot/lib/wasm32-wasi');
    archives.libgcov = path.join(library, 'libgcov.a');
    archives.getpid = path.join(library, 'libwasi-emulated-getpid.a');
    report.runtime.coverageRoot = coverageRoot;
    report.runtime.coverageBuild = await freeze(path.join(coverageRoot, 'build.json'));
    const coverageBuild = JSON.parse(await fs.readFile(report.runtime.coverageBuild.path));
    assert.equal(coverageBuild.status, 'built-unverified');
    assert.equal(coverageBuild.inputsUnchanged, true);
    assert.deepEqual(coverageBuild.gccSource, report.gccSource);
    assert.deepEqual(coverageBuild.sourceLock, report.sourceLock);
    assert.deepEqual(coverageBuild.nativeBuild, report.nativeBuild);
    assert.deepEqual(coverageBuild.runtimeImport, report.runtime.importReceipt);
    assert.deepEqual(
      coverageBuild.objects.map((value) => value.selection),
      ['-DL_gcov', '-DL_gcov_merge_add']
    );
    for (const item of coverageBuild.inputs) assert.deepEqual(await freeze(item.path), item);
    for (const [name, key] of [
      ['libgcov.a', 'libgcov'],
      ['libwasi-emulated-getpid.a', 'getpid']
    ]) {
      report.runtime.archives[key] = await freeze(archives[key]);
      assert.deepEqual(coverageBuild.libraries[name], report.runtime.archives[key]);
    }
    for (const [name, key] of [
      ['cc1', 'gcc'],
      ['cc1plus', 'gccCpp']
    ])
      assert.equal(coverageBuild.nativeCompiler[name].sha256, report.tools[key].sha256);
    report.runtime.coverageAnalysis = {
      sources: Object.fromEntries(
        await Promise.all(
          ['gcov.cc', 'gcov-dump.cc', 'gcov-io.cc', 'gcov-io.h', 'gcov-counter.def'].map(
            async (name) => [
              name,
              await freeze(path.join(options.source ?? path.join(work, 'gcc'), 'gcc', name))
            ]
          )
        )
      ),
      buildMakefile: await freeze(path.join(compiler, 'Makefile')),
      gcovVersion: success(run(toolPaths.gcov, ['--version'])),
      gcovDumpVersion: success(run(toolPaths.gcovDump, ['--version'])),
      versionWord: 'B70 ',
      jsonFormatVersion: '2'
    };
    assert(report.runtime.coverageAnalysis.gcovVersion.stdout.includes('17.0.0'));
    assert(report.runtime.coverageAnalysis.gcovDumpVersion.stdout.includes('17.0.0'));
  }
  report.analysisToolDependencies = await Promise.all(
    ['libLLVM.so.22.1-wasi-sdk', 'libedit.so.0'].map((name) => freeze(path.join(sdk, 'lib', name)))
  );
  report.browserDependencies = {
    playwright: await freeze(options.playwright),
    playwrightFiles: await inventory(path.dirname(options.playwright)),
    shim: await inventory(options['wasi-shim'])
  };
  runner = path.join(output, 'run-node.mjs');
  await write(runner, runnerSource);
  await startBrowser();
  for (const fixture of selected) {
    const entry = {
      id: fixture.id,
      fixtureSha256: dwarfIdentity(Buffer.from(JSON.stringify(fixture))).sha256,
      status: 'running'
    };
    report.cases.push(entry);
    await save('compile-' + fixture.id);
    const program = await compileFixture(fixture, { debug: 'dwarf4', optimization: '0' }, 'debug');
    entry.executions = await executeFixture(fixture, program);
    entry.program = compactProgram(program);
    if (fixture.expected.deadFunction) {
      const disassembly = success(
        run(toolPaths.llvmObjdump, ['--disassemble', program.program.path])
      );
      assert(
        !new RegExp('<[^>\\n]*' + fixture.expected.deadFunction).test(disassembly.stdout),
        'Dead function still has live executable instructions'
      );
      entry.deadCode = {
        name: fixture.expected.deadFunction,
        linkerGarbageCollection: true,
        command: disassembly
      };
    }
    entry.status = 'passed';
    if (fixture.family === 'frames') await qualifyControls(fixture, program);
    await save('completed-' + fixture.id);
  }
  if (!options.cases)
    for (const fixture of diagnostics) {
      const directory = path.join(output, 'diagnostics', fixture.id);
      await fs.mkdir(directory, { recursive: true });
      const source = path.join(directory, 'main.' + (fixture.language === 'c' ? 'c' : 'cpp')),
        assembly = path.join(directory, 'program.wat');
      await write(source, fixture.code);
      const argv = [
        '-quiet',
        '-O0',
        '-fdiagnostics-color=never',
        ...fixture.flags,
        source,
        '-o',
        assembly
      ];
      const command = run(
        fixture.language === 'c' ? toolPaths.gcc : toolPaths.gccCpp,
        argv,
        directory
      );
      assert(Number.isSafeInteger(command.status) && command.status > 0);
      assert.equal(command.signal, null);
      assert(!command.error);
      assert.match(
        command.stderr,
        /supports embedded DWARF32\/DWARF4 only|unsupported|not supported|unrecognized/i
      );
      report.diagnostics.push({
        id: fixture.id,
        flags: fixture.flags,
        source: await freeze(source),
        command,
        status: 'passed'
      });
      await save('diagnostic-' + fixture.id);
    }
  if (!options.cases) await qualifyCombinations();
  for (const receipt of inputs.values())
    assert.deepEqual(await identity(receipt.path), receipt, 'Changed qualification input');
  for (const receipt of artifacts.values())
    assert.deepEqual(await identity(receipt.path), receipt, 'Changed qualification artifact');
  report.inputsUnchanged = true;
  report.artifactsUnchanged = true;
  report.counts = {
    cases: report.cases.length,
    sourceUnits: report.cases.reduce((count, item) => count + item.program.units.length, 0),
    normalExecutionsPerHost: report.cases.reduce(
      (count, item) => count + item.executions.filter((value) => value.id === 'normal').length,
      0
    ),
    trappedExecutionsPerHost: report.cases.reduce(
      (count, item) => count + item.executions.filter((value) => value.id === 'trap').length,
      0
    ),
    liveSourceFrames: report.cases.reduce(
      (count, item) => count + item.executions.flatMap((value) => value.live ?? []).length,
      0
    ),
    controls: report.controls.length,
    diagnostics: report.diagnostics.length,
    combinations: report.combinations.length,
    actualLocalIndexBoundaries: report.cases
      .flatMap((item) =>
        item.executions
          .flatMap((value) => value.live ?? [])
          .flatMap((value) => value.measuredLocalIndices ?? [])
      )
      .map((value) => value.index)
  };
  if (!options.cases) {
    assert.equal(report.counts.cases, requiredCounts.cases);
    assert.equal(report.counts.sourceUnits, requiredCounts.translationUnits);
    assert.equal(report.counts.normalExecutionsPerHost, requiredCounts.normalExecutionsPerHost);
    assert.equal(report.counts.trappedExecutionsPerHost, requiredCounts.trappedExecutionsPerHost);
    assert.deepEqual(
      report.counts.actualLocalIndexBoundaries,
      requiredCounts.requiredLiveLocalIndices
    );
    assert.equal(report.counts.diagnostics, diagnostics.length);
    assert.equal(report.counts.combinations, combinations.length);
    assert.equal(
      report.counts.controls,
      requiredCounts.frameCases * requiredCounts.controlsPerFrameCase
    );
  }
  report.status = options.cases ? 'passed-partial' : 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.stack || String(error);
} finally {
  try {
    await browser?.close();
  } catch (error) {
    report.status = 'failed';
    report.browserCleanupError = String(error);
  }
  try {
    if (server) await new Promise((resolve) => server.close(resolve));
  } catch (error) {
    report.status = 'failed';
    report.serverCleanupError = String(error);
  }
  report.finishedAt = new Date().toISOString();
  report.inputs = [...inputs.values()];
  report.artifacts = [...artifacts.values()];
  await save(report.status);
}
console.log(
  JSON.stringify({
    status: report.status,
    counts: report.counts,
    error: report.error?.slice(0, 1800),
    output
  })
);
if (!['passed', 'passed-partial'].includes(report.status)) process.exitCode = 1;

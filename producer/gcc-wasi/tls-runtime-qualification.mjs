import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { identity, runLibatomicValidationCommand as run } from './libatomic-qualification.mjs';
import { assertTlsAssemblyReplay, canonicalTlsAssembly } from './tls-assembly-replay.mjs';
import { inspectTlsObject } from './tls-inspect.mjs';
import { reopenTlsLibcBuild } from './tls-libc-qualification.mjs';
import { tlsRuntimeCases, assertTlsRuntimeOrdinaryResult, assertTlsRuntimeSharedResult } from './tls-runtime-fixtures.mjs';
import { qualifyTlsRuntime, executeTlsRuntimeCase, tlsRuntimeLinkArguments } from './test-tls-runtime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const content = value => ({ bytes: value.bytes, sha256: value.sha256 });
export const tlsRuntimeSources = Object.freeze(['atexit_thread.cc','new_opnt.cc','new_op.cc','new_handler.cc','del_op.cc','del_ops.cc']);
export const tlsRuntimeFiles = Object.freeze([
  'lib/wasm32-wasi-tls/libgcc-wasi-tls.a',
  'lib/wasm32-wasi-threads/libgcc-wasi-tls-shared.a',
  'lib/wasm32-wasi-threads/libc.a',
  'lib/wasm32-wasi-threads/libm.a',
  'lib/wasm32-wasi-threads/libclang_rt.builtins-wasm32.a',
  'lib/wasm32-wasi-tls/libc.a',
  'lib/wasm32-wasi-tls/libm.a',
  'lib/wasm32-wasi-tls/libclang_rt.builtins-wasm32.a',
  'lib/wasm32-wasi-tls/libc-printscan-long-double.a',
  'include/wasm32-wasi-tls/__errno.h',
]);
const identify = async file => ({ path: file, ...identity(await fs.readFile(file)) });
const inventory = records => [...records].map(value => ({ path: value.path, ...content(value) })).sort((a,b) => a.path.localeCompare(b.path));

async function read(record, file) {
  assert(record && typeof record.path === 'string', 'Missing TLS input identity');
  if (file) assert.equal(path.resolve(record.path), await fs.realpath(file), 'Unexpected TLS evidence path');
  const bytes = await fs.readFile(record.path);
  assert.deepEqual(identity(bytes), content(record), 'Changed TLS evidence: ' + record.path);
  return bytes;
}

export function verifyTlsRuntimeBuildMetadata(report, expected) {
  assert.equal(report.schemaVersion,1);
  assert.equal(report.kind,'gcc-wasi-tls-runtime-build');
  assert.equal(report.target,'wasm32-wasi');
  assert.equal(report.status,'built-unverified','A TLS runtime archive build is not execution qualification');
  assert.equal(report.inputsUnchanged,true);
  assert.deepEqual(report.gccSource,expected.gccSource);
  assert.deepEqual(content(report.nativeBuild),content(expected.nativeBuild));
  assert.equal(report.sourceLock.sha256,expected.sourceLockSha256);
  assert.deepEqual(report.files.map(value => value.path).sort(),[...tlsRuntimeFiles].sort());
  assert.deepEqual(report.objects.map(value => value.profile+'/'+value.member).sort(),
    ['ordinary','shared'].flatMap(profile => tlsRuntimeSources.map(name => profile+'/'+name.replace(/\.cc$/u,'.o'))).sort());
  assert.equal(report.profile.registrationLimit,null,'GNU TLS cleanup must retain allocation-backed registration');
  assert.equal(report.profile.executionQualified,false);
  assert.equal(report.profile.allocator,'pinned-sdk-dlmalloc');
  assert.equal(report.profile.pthread,false);
  assert.deepEqual(report.profile.ordinary.linkFlags,['--wrap=exit','--wrap=__wasm_call_dtors']);
  assert.equal(report.profile.ordinary.atomics,false);
  assert.equal(report.profile.ordinary.atomicWaitNotify,false);
  assert.equal(report.profile.ordinary.libc,'wasm32-wasi-tls');
  assert.equal(report.profile.ordinary.memory,'private');
  assert.equal(report.profile.shared.cleanup,'__wasm_call_thread_dtors');
  assert.equal(report.profile.shared.hostReservation,'lld-stack-before-heap');
  assert.equal(report.profile.shared.fixedMemory,true);
  assert.deepEqual(report.profile.shared.imports,['env.memory','wasi_snapshot_preview1.sched_yield']);
}

// Rebuild from caller-known current source/compiler/header roots.  Reopening
// metadata alone cannot prove that a claimed archive came from those sources.
export async function reopenTlsRuntimeBuild(directory, expected) {
  for (const key of ['work','sdk','sysroot','gccCxxSysroot','tlsLibc','gccSource','sourceLockSha256','nativeBuild'])
    assert(expected[key], 'Missing TLS build context '+key);
  directory = path.resolve(directory);
  const work=path.resolve(expected.work), sdk=path.resolve(expected.sdk), sysroot=path.resolve(expected.sysroot);
  const gnu=path.resolve(expected.gccCxxSysroot), source=path.join(work,'gcc');
  const sdkArchive=path.resolve(expected.sdkArchive ?? path.join(path.dirname(sdk),path.basename(sdk)+'.tar.gz'));
  const reportFile=path.join(directory,'build.json'), reportBytes=await fs.readFile(reportFile), report=JSON.parse(reportBytes);
  verifyTlsRuntimeBuildMetadata(report,expected);
  const native=JSON.parse(await read(report.nativeBuild,path.join(work,'native-build.json')));
  assert.deepEqual(native.gccSource,expected.gccSource);
  assert.equal(native.sourceLockSha256,expected.sourceLockSha256);
  assert.equal(path.resolve(expected.nativeBuild.path),path.join(work,'native-build.json'));
  for (const name of ['cc1','cc1plus','xgcc']) {
    await read(report.nativeCompiler[name],path.join(work,'gcc-native/gcc',name));
    assert.equal(report.nativeCompiler[name].sha256,native.tools[name].sha256);
  }
  await read(report.sourceLock,path.join(here,'sources.lock.json'));
  await read(report.runtimeLock,path.join(here,'runtime.lock.json'));
  await read(report.sdkArchive,sdkArchive);
  for (const name of ['build-tls-runtime.py','prepare-source.py']) await read(report.recipes[name],path.join(here,name));
  const privateLibcDirectory=path.resolve(expected.tlsLibc);
  await read(report.privateLibcBuild,path.join(privateLibcDirectory,'build.json'));
  const privateLibc=await reopenTlsLibcBuild(privateLibcDirectory,{work,sdk,sourceArchive:expected.wasiLibcArchive});
  assert.deepEqual(content(privateLibc.build),content(report.privateLibcBuild));
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'gcc-wasi-tls-runtime-reopen-'));
  const freshDirectory=path.join(temporary,'fresh');
  const replay={directory:temporary,commands:[]};
  try {
    replay.commands.push(await run('python3',[path.join(here,'build-tls-runtime.py'),
      '--work',work,'--sdk',sdk,'--sdk-archive',sdkArchive,'--gcc-source',source,
      '--sysroot',sysroot,'--gcc-cxx-sysroot',gnu,'--tls-libc',privateLibcDirectory,'--output',freshDirectory],temporary,'build',1500000));
    const freshFile=path.join(freshDirectory,'build.json'), freshBytes=await fs.readFile(freshFile), fresh=JSON.parse(freshBytes);
    verifyTlsRuntimeBuildMetadata(fresh,expected);
    // These exact inputs are independently enumerated by the current recipe.
    // Reject missing, invented or stale input entries, including extra headers.
    assert.deepEqual(inventory(report.inputs),inventory(fresh.inputs),'TLS build input inventory changed');
    for (const item of report.inputs) await read(item);
    for (const key of ['profile','gccSource','nativeBuild','nativeCompiler','recipes','tools','sourceLock',
      'runtimeLock','runtimeImport','baseRuntimeFiles','gnuBuild','gnuImport','gnuHeaders','resourceHeaders',
      'librarySources','sdkArchive','sdkImports','sdkErrnoHeader','licenseSources','privateLibcBuild','privateLibcArchives'])
      assert.deepEqual(report[key],fresh[key], 'TLS build binding differs: '+key);
    for (const [index, original] of report.objects.entries()) {
      const actual=fresh.objects[index];
      assert.equal(original.profile,actual.profile);assert.equal(original.member,actual.member);
      assert.deepEqual(original.source,actual.source);
      const objectDirectory=path.join(directory,'objects',original.profile);
      const originalAssembly=await read(original.assembly,path.join(objectDirectory,original.member.replace(/\.o$/u,'.wat')));
      const originalObject=await read(original.object,path.join(objectDirectory,original.member));
      const actualAssembly=await read(actual.assembly), actualObject=await read(actual.object);
      assertTlsAssemblyReplay(originalAssembly,actualAssembly);
      const inspection=inspectTlsObject(originalObject), freshInspection=inspectTlsObject(actualObject);
      assert.equal(inspection.hasTls,original.member==='atexit_thread.o');
      assert.equal(freshInspection.hasTls,inspection.hasTls);
      if (inspection.hasTls) {
        assert(inspection.tlsSymbols.some(symbol => symbol.name.includes('wasm_tls_cleanups') && !symbol.undefined));
        assert(inspection.tlsRelocations.length>0);
      }
      const prefix=original.profile+'-'+original.member;
      const assembled=path.join(temporary,prefix+'.original.o');
      replay.commands.push(await run(path.join(work,'wabt-native/wat2wasm'),['--enable-all','-r',original.assembly.path,'-o',assembled],temporary,prefix+'-assemble'));
      assert.deepEqual(await fs.readFile(assembled),originalObject,'Retained TLS object does not match retained GCC assembly');
      const canonical=[];
      for(const [label,assembly] of [['original',originalAssembly],['fresh',actualAssembly]]) {
        const wat=path.join(temporary,prefix+'.'+label+'.wat'),object=path.join(temporary,prefix+'.'+label+'.o');
        await fs.writeFile(wat,canonicalTlsAssembly(assembly));
        replay.commands.push(await run(path.join(work,'wabt-native/wat2wasm'),['--enable-all','-r',wat,'-o',object],temporary,prefix+'-'+label+'-canonical'));
        canonical.push(await fs.readFile(object));
      }
      assert.deepEqual(canonical[0],canonical[1],'Canonical GNU runtime objects differ');
      const archive=path.join(directory,'sysroot',original.profile==='ordinary'?tlsRuntimeFiles[0]:tlsRuntimeFiles[1]);
      const extracted=await run(path.join(sdk,'bin/llvm-ar'),['p',archive,original.member],temporary,prefix+'-extract');
      replay.commands.push(extracted);
      assert.deepEqual(await fs.readFile(extracted.stdout.path),originalObject,'TLS archive contains another object');
      assert.deepEqual(original.inspection,actual.inspection);
      for (const [key,label] of [['compileCommand','compile'],['assembleCommand','assemble'],['validateCommand','validate']]) {
        const claimed=report.commands[original[key]], rebuilt=fresh.commands[actual[key]];
        assert(claimed && rebuilt);
        assert.equal(claimed.command,rebuilt.command);
        assert.deepEqual(claimed.argv,rebuilt.argv.map(value => value.startsWith(freshDirectory+path.sep) ? directory+value.slice(freshDirectory.length) : value), 'Incorrect original TLS '+label+' recipe');
        assert.equal(claimed.status,0);
      }
    }
    for (const profile of ['ordinary','shared']) {
      const archive=path.join(directory,'sysroot',profile==='ordinary'?tlsRuntimeFiles[0]:tlsRuntimeFiles[1]);
      const listed=await run(path.join(sdk,'bin/llvm-ar'),['t',archive],temporary,profile+'-inventory');replay.commands.push(listed);
      assert.deepEqual((await fs.readFile(listed.stdout.path,'utf8')).trim().split('\n'),tlsRuntimeSources.map(name=>name.replace(/\.cc$/u,'.o')));
    }
    for (const item of report.files) {
      const bytes=await fs.readFile(path.join(directory,'sysroot',item.path));
      assert.deepEqual(identity(bytes),content(item),'Changed TLS runtime installation');
      if (item.path!==tlsRuntimeFiles[0]&&item.path!==tlsRuntimeFiles[1])
        assert.deepEqual(bytes,await fs.readFile(path.join(freshDirectory,'sysroot',item.path)),'SDK archive import differs');
    }
    const licenses=[];
    assert.equal(report.licenses.length,fresh.licenses.length);
    for (const [index,item] of report.licenses.entries()) {
      assert.deepEqual(item.source,fresh.licenses[index].source);
      const bytes=await read(item.installed,path.join(directory,'licenses',path.basename(item.source.path)));
      assert.deepEqual(bytes,await read(item.source));
      licenses.push({path:path.basename(item.installed.path),...identity(bytes)});
    }
    replay.status='passed';replay.build={path:freshFile,...identity(freshBytes)};
    const result={status:'built-unverified',gccSource:report.gccSource,nativeBuild:report.nativeBuild,
      build:{path:reportFile,...identity(reportBytes)},files:inventory(report.files),licenses,
      profile:report.profile,directory,privateLibc:{build:privateLibc.build,replay:privateLibc.replay},
      validators:await Promise.all(['tls-runtime-qualification.mjs','tls-libc-qualification.mjs','libatomic-qualification.mjs','tls-assembly-replay.mjs','tls-inspect.mjs','symbol-alias-inspect.mjs'].map(name=>identify(path.join(here,name))))};
    const replayFile=path.join(temporary,'reopen.json');
    await fs.writeFile(replayFile,JSON.stringify({...result,replayDetails:replay},null,2)+'\n');
    return {...result,replay:await identify(replayFile)};
  } catch(error) {
    replay.status='failed';replay.error=String(error.stack||error);
    await fs.writeFile(path.join(temporary,'reopen.json'),JSON.stringify(replay,null,2)+'\n');throw error;
  }
}

export function verifyTlsRuntimeExecutionMetadata(report,expected) {
  assert.equal(report.schemaVersion,1);assert.equal(report.kind,'gcc-wasi-tls-runtime-execution');
  assert.equal(report.status,'passed');assert.equal(report.inputsUnchanged,true);
  assert.deepEqual(report.gccSource,expected.gccSource);
  assert.deepEqual(content(report.nativeBuild),content(expected.nativeBuild));
  assert.deepEqual(content(report.runtimeBuild),content(expected.runtimeBuild));
  assert.equal(report.sourceLock.sha256,expected.sourceLockSha256);
  assert.deepEqual(inventory(report.files),inventory(expected.files));
  assert.deepEqual(report.cases.map(item=>item.id),tlsRuntimeCases.map(item=>item.id));
  assert(report.cases.every(item=>item.status==='passed'));
  assert.deepEqual(report.counts,{ordinary:24,shared:8,workersPerSharedCase:2,expectedAbortTraps:2});
}

export function tlsFixtureDirectoryInventory(fixture) {
  const entries=new Map(),file=name=>entries.set(name,'file');
  file(fixture.request.language==='cpp'?'unit0.cpp':'unit0.c');
  for(const item of fixture.request.files??[])file(item.path);
  const command=label=>{for(const suffix of ['stdout','stderr','command.json'])file(label+'.'+suffix);};
  for(let index=0;index<1+(fixture.request.sources?.length??0);index++) {
    file('unit'+index+'.wat');file('unit'+index+'.o');
    for(const label of ['compile','assemble','inspect'])command(label+'-'+index);
  }
  file('main.wasm');command('link');command('program-inspect');entries.set('execution','directory');
  for(const name of ['stdin.txt','run.json','result.json','execute.stdout','execute.stderr','execute.command.json',
    ...(fixture.request.sharedMemory?['memory.bin']:['guest.stdout','guest.stderr'])])file('execution/'+name);
  return [...entries].map(([path,kind])=>({path,kind})).sort((a,b)=>a.path.localeCompare(b.path));
}

export function verifyTlsFixtureDirectoryInventory(fixture,entries) {
  assert.deepEqual([...entries].sort((a,b)=>a.path.localeCompare(b.path)),tlsFixtureDirectoryInventory(fixture),
    'Retained TLS fixture contains unrecorded include/precompiled-header inputs or unexpected artifacts');
}

async function directoryInventory(root,prefix='') {
  const result=[];
  for(const entry of await fs.readdir(path.join(root,prefix),{withFileTypes:true})) {
    const relative=prefix+entry.name,kind=entry.isFile()?'file':entry.isDirectory()?'directory':'unsupported';
    result.push({path:relative,kind});
    if(kind==='directory')result.push(...await directoryInventory(root,relative+'/'));
  }
  return result;
}

// Recompile the exact independent fixture sources; execute both retained and
// freshly compiled programs. Only complete import declarations may reorder.
// Original WAT/object/program raw chains and canonical fresh/original chains
// are checked separately, with all intermediate files retained.
export async function reopenTlsRuntimeExecutionQualification(report,reportFile,expected) {
  verifyTlsRuntimeExecutionMetadata(report,expected);
  reportFile=path.resolve(reportFile);const reportBytes=await fs.readFile(reportFile);
  assert.deepEqual(JSON.parse(reportBytes),report);
  const context={work:path.resolve(expected.work),sdk:path.resolve(expected.sdk),sysroot:path.resolve(expected.sysroot),
    gccCxxSysroot:path.resolve(expected.gccCxxSysroot),runtime:path.resolve(expected.tlsRuntime),node:process.execPath};
  assert.deepEqual(report.context,context,'Unexpected runtime execution tool/runtime roots');
  await read(report.nativeBuild,path.join(context.work,'native-build.json'));
  await read(report.runtimeBuild,path.join(context.runtime,'build.json'));
  await read(report.sourceLock,path.join(here,'sources.lock.json'));
  for(const input of report.inputs)await read(input);
  // Preserve the original source paths for exact code generation, but exclude
  // unrecorded headers and .gch files that GCC could otherwise discover there.
  for(const fixture of tlsRuntimeCases)
    verifyTlsFixtureDirectoryInventory(fixture,await directoryInventory(path.join(path.dirname(reportFile),fixture.id)));
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'gcc-wasi-tls-runtime-execution-reopen-'));
  const replay={status:'running',directory:temporary,cases:[],commands:[]};
  try {
    const freshDirectory=path.join(temporary,'fresh');
    const fresh=await qualifyTlsRuntime({...context,output:freshDirectory,sourceRoot:path.dirname(reportFile)});
    verifyTlsRuntimeExecutionMetadata(fresh,expected);
    assert.deepEqual(inventory(report.inputs),inventory(fresh.inputs),'Incomplete runtime execution input inventory');
    const assembler=path.join(context.work,'wabt-native/wat2wasm'),linker=path.join(context.sdk,'bin/wasm-ld');
    for(const [index,fixture]of tlsRuntimeCases.entries()) {
      const original=report.cases[index],actual=fresh.cases[index],directory=path.join(temporary,fixture.id);
      await fs.mkdir(directory);assert.deepEqual(original.request,fixture.request);assert.equal(original.kind,fixture.kind);
      assert.deepEqual(original.sources,actual.sources);
      const originalDirectory=path.join(path.dirname(reportFile),fixture.id);
      const mapped=value=>value.startsWith(freshDirectory+path.sep)?path.dirname(reportFile)+value.slice(freshDirectory.length):value;
      assert.equal(original.commands.length,actual.commands.length);
      for(const [commandIndex,command]of original.commands.entries()) {
        assert.equal(command.command,actual.commands[commandIndex].command);
        assert.deepEqual(command.argv,actual.commands[commandIndex].argv.map(mapped));assert.equal(command.status,0);
        await read(command.stdout);await read(command.stderr);
      }
      for(const item of original.sources)await read(item);
      const canonicalOriginal=[],canonicalFresh=[],originalObjects=[];
      assert.equal(original.objects.length,actual.objects.length);
      for(const [unit,item]of original.objects.entries()) {
        const replacement=actual.objects[unit],originalWat=await read(item.assembly,path.join(originalDirectory,'unit'+unit+'.wat')),freshWat=await read(replacement.assembly);
        assert.deepEqual(item.source,replacement.source);assertTlsAssemblyReplay(originalWat,freshWat);
        const object=await read(item.object,path.join(originalDirectory,'unit'+unit+'.o'));originalObjects.push(item.object.path);
        const rebuilt=path.join(directory,'unit'+unit+'.original.o');
        replay.commands.push(await run(assembler,['--enable-all','-r',item.assembly.path,'-o',rebuilt],directory,'original-'+unit));
        assert.deepEqual(await fs.readFile(rebuilt),object,'Retained runtime fixture object does not match its WAT');
        for(const [label,wat,objects]of [['original',originalWat,canonicalOriginal],['fresh',freshWat,canonicalFresh]]) {
          const file=path.join(directory,'unit'+unit+'.canonical-'+label+'.wat'),output=file.replace(/\.wat$/u,'.o');
          await fs.writeFile(file,canonicalTlsAssembly(wat));
          replay.commands.push(await run(assembler,['--enable-all','-r',file,'-o',output],directory,'canonical-'+label+'-'+unit));objects.push(output);
        }
        assert.deepEqual(await fs.readFile(canonicalOriginal[unit]),await fs.readFile(canonicalFresh[unit]),'Canonical fixture objects differ');
        const mapped=actual.objects[unit].compile.argv.map(value=>value.startsWith(freshDirectory+path.sep)?path.dirname(reportFile)+value.slice(freshDirectory.length):value);
        assert.equal(item.compile.command,replacement.compile.command);assert.deepEqual(item.compile.argv,mapped,'Retained compile recipe changed');
        assert.equal(item.compile.status,0);assert.equal(item.assemble.status,0);
      }
      const outputs={};
      for(const [label,objects]of [['original-raw',originalObjects],['original-canonical',canonicalOriginal],['fresh-canonical',canonicalFresh]]) {
        const destination=path.join(directory,label);await fs.mkdir(destination);const program=path.join(destination,'main.wasm');
        replay.commands.push(await run(linker,tlsRuntimeLinkArguments(fixture,objects,program,context),destination,'link'));
        outputs[label]=await identify(program);
      }
      assert.deepEqual(await fs.readFile(outputs['original-raw'].path),await read(original.program,path.join(originalDirectory,'main.wasm')),'Retained program does not match retained objects');
      assert.deepEqual(await fs.readFile(outputs['original-canonical'].path),await fs.readFile(outputs['fresh-canonical'].path),'Canonical final programs differ');
      const oldExecution=JSON.parse(await read(original.execution.result));
      if(fixture.request.sharedMemory) {
        const memory=new Uint8Array(await read(original.execution.memory));
        assert.deepEqual(assertTlsRuntimeSharedResult(fixture,{...oldExecution,memory}),original.execution.oracle);
      }else {
        assert.equal((await read(original.execution.stdout)).toString(),oldExecution.stdout);
        assert.equal((await read(original.execution.stderr)).toString(),oldExecution.stderr);
        assert.deepEqual(assertTlsRuntimeOrdinaryResult(fixture,oldExecution),original.execution.oracle);
      }
      const execution=await executeTlsRuntimeCase(fixture,original.program.path,path.join(directory,'retained-execution'),context);
      replay.cases.push({id:fixture.id,status:'passed',originalChainExact:true,canonicalChainExact:true,
        originalProgram:original.program,freshProgram:actual.program,outputs,execution,freshExecution:actual.execution});
    }
    for(const input of report.inputs)await read(input);
    replay.status='passed';replay.freshQualification=await identify(path.join(freshDirectory,'qualification.json'));
    const result={status:'passed',gccSource:report.gccSource,nativeBuild:report.nativeBuild,runtimeBuild:report.runtimeBuild,
      files:inventory(report.files),qualification:{path:reportFile,...identity(reportBytes)},counts:report.counts};
    const replayFile=path.join(temporary,'reopen.json');
    await fs.writeFile(replayFile,JSON.stringify({...result,replayDetails:replay},null,2)+'\n');
    return {...result,replay:await identify(replayFile)};
  }catch(error){replay.status='failed';replay.error=String(error.stack||error);
    await fs.writeFile(path.join(temporary,'reopen.json'),JSON.stringify(replay,null,2)+'\n');throw error;}
}

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { timezoneCases } from './tzdb-fixtures.mjs';
import { timezonePmfCases } from './tzdb-pmf-fixtures.mjs';
import { runLibatomicValidationCommand as run } from './libatomic-qualification.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const content=record=>({bytes:record.bytes,sha256:record.sha256});
const identity=bytes=>({bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
const identify=async file=>({path:path.resolve(file),...identity(await fs.readFile(file))});
async function read(record,expectedPath) {
  assert(record&&Number.isSafeInteger(record.bytes)&&record.bytes>=0&&/^[a-f0-9]{64}$/u.test(record.sha256));
  assert(path.isAbsolute(record.path));
  if(expectedPath)assert.equal(path.normalize(record.path),path.resolve(expectedPath));
  const bytes=await fs.readFile(record.path);
  assert.deepEqual(identity(bytes),content(record),'Timezone evidence changed: '+record.path);
  return bytes;
}
const indexed=records=>Object.fromEntries(records.map(record=>[record.path,content(record)]));

export async function timezoneSysrootInventory(expected) {
  const lock=JSON.parse(await fs.readFile(path.join(here,'sources.lock.json'),'utf8'));
  const files=new Map();
  async function collect(directory,prefix='') {
    for(const entry of (await fs.readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      const file=path.join(directory,entry.name),relative=prefix+entry.name;
      if(entry.isDirectory())await collect(file,relative+'/');
      else {
        assert(entry.isFile(),'Unexpected timezone sysroot input type: '+file);
        assert(!files.has(relative),'Duplicate timezone sysroot provider: '+relative);
        files.set(relative,{path:relative,source:path.resolve(file),...identity(await fs.readFile(file))});
      }
    }
  }
  await collect(path.resolve(expected.sysroot));
  await collect(path.join(expected.ordinaryRuntime,'sysroot'));
  await collect(path.join(expected.exceptionRuntime,'sysroot'));
  await collect(path.join(expected.work,'gcc-native/gcc/include'),
    `lib/gcc/wasm32-wasi/${lock.gcc.version}/include/`);
  return [...files.values()].sort((a,b)=>a.path.localeCompare(b.path));
}

export function verifyTimezoneQualificationMetadata(report,expected) {
  assert.equal(report.schemaVersion,1);
  assert.equal(report.kind,'gcc-wasi-tzdb-native-qualification');
  assert.equal(report.status,'passed');assert.equal(report.inputsUnchanged,true);
  assert.equal(report.mode,'full-gnu-runtime','Standalone objects cannot qualify a packaged GNU runtime');
  assert.equal(report.fullGnuLibrary,true);assert.equal(report.compilerHost,'native');
  assert.equal(report.target,'wasm32-wasi');assert.equal(report.browserCompilerQualified,false);
  assert.equal(report.noGuestPreopens,true);assert.equal(report.hostTimezoneFilesExposed,false);
  assert.deepEqual(report.gccSource,expected.gccSource);
  assert.deepEqual(content(report.nativeBuild),content(expected.nativeBuild));
  assert.equal(report.sourceLock.sha256,expected.sourceLockSha256);
  assert.deepEqual(report.counts,{total:12,ordinary:10,exceptions:2,families:6});
  assert.deepEqual(report.cases.map(item=>item.id),timezoneCases.map(item=>item.id));
  assert.equal(report.commands.length,60);
  for(const command of report.commands) {
    assert.equal(command.exitCode,0);assert.equal(command.signal,null);
    assert.equal(command.timedOut,false);assert.equal(command.error,undefined);
  }
  assert(!report.standalone);
  for(const [index,fixture] of timezoneCases.entries()) {
    const item=report.cases[index];assert.equal(item.status,'passed');
    assert.deepEqual(item.request,fixture.request);assert.deepEqual(item.run,fixture.run);
    const oracle={stdout:fixture.stdout,stderr:fixture.stderr,exitCode:fixture.exitCode};
    assert.deepEqual(item.expected,oracle);
    assert.equal(item.observations.escapedException,null);
    for(const key of ['stdout','stderr','exitCode'])assert.equal(item.observations[key],oracle[key]);
    assert.deepEqual(item.stages.map(stage=>stage.sdkTool),['cc1plus','as','ld']);
    for(const stage of item.stages) {
      assert.equal(stage.semanticArgumentsIdentical,true);assert.equal(stage.exitCode,0);
    }
    assert(item.stages[0].sdkArgv.includes('-mno-atomics'));
    assert(item.stages[2].sdkArgv.includes('--fatal-warnings'));
    assert(!item.stages[2].sdkArgv.some(arg=>arg.startsWith('/link-inputs/')));
    assert.equal(item.profile.atomicInstructions,0);assert.equal(item.profile.atomicHelpers,0);
    assert.equal(item.profile.sharedMemory,false);
    assert.equal(item.externalObject,undefined);
    assert(item.observations.imports.every(value=>value.module==='wasi_snapshot_preview1'&&value.kind==='function'));
  }
  assert(Array.isArray(report.inputs)&&report.inputs.length>100);
  assert.equal(new Set(report.inputs.map(record=>record.path)).size,report.inputs.length);
  assert.equal(new Set(report.artifacts.map(record=>record.path)).size,report.artifacts.length);
}

export function verifyTimezonePmfMetadata(report,expected) {
  assert.equal(report.kind,'gcc-wasi-member-function-pointer-native-qualification');
  assert.equal(report.schemaVersion,1);assert.equal(report.status,'passed');assert.equal(report.inputsUnchanged,true);
  assert.equal(report.compilerHost,'native');assert.equal(report.target,'wasm32-wasi');
  assert.deepEqual(report.gccSource,expected.gccSource);
  assert.deepEqual(content(report.nativeBuild),content(expected.nativeBuild));
  assert.deepEqual(report.counts,{total:8,families:4,optimizations:['0','2']});
  assert.deepEqual(report.cases.map(item=>item.id),timezonePmfCases.map(item=>item.id));
  for(const [index,fixture] of timezonePmfCases.entries()) {
    const item=report.cases[index];assert.equal(item.status,'passed');
    assert.deepEqual(item.request,fixture.request);assert.deepEqual(item.run,fixture.run);
    assert.deepEqual(item.expected,{stdout:fixture.stdout,stderr:fixture.stderr,exitCode:fixture.exitCode});
    assert.equal(item.observed.escapedException,null);
    for(const name of ['stdout','stderr','exitCode'])assert.equal(item.observed[name],fixture[name]);
    assert.equal(item.commands.length,4);assert(item.commands.every(command=>command.exitCode===0));
  }
}

/** Recompile every fixed case and execute both fresh and retained Wasm bytes. */
export async function reopenTimezoneQualification(report,file,expected) {
  for(const key of ['work','sdk','sysroot','ordinaryRuntime','exceptionRuntime','gccSource','sourceLockSha256','nativeBuild'])
    assert(expected[key],'Missing timezone qualification context '+key);
  const qualification=await identify(file);
  assert.deepEqual(JSON.parse(await read(qualification)),report);
  verifyTimezoneQualificationMetadata(report,expected);
  const currentLock=await fs.readFile(path.join(here,'sources.lock.json'));
  assert.equal(identity(currentLock).sha256,expected.sourceLockSha256);
  await read(report.sourceLock,path.join(here,'sources.lock.json'));
  await read(report.timezoneLock,path.join(here,'tzdb.lock.json'));
  await read(report.fixtures,path.join(here,'tzdb-fixtures.mjs'));
  await read(report.oracle,path.join(here,'tzdb-oracle.json'));
  const config=JSON.parse(await read(report.config));
  for(const [field,required] of [['work',expected.work],['sdk',expected.sdk],
    ['ordinaryRuntime',expected.ordinaryRuntime],['exceptionRuntime',expected.exceptionRuntime]])
    assert.equal(path.resolve(config[field]),path.resolve(required),'Timezone context differs: '+field);
  assert.equal(config.mode,'full-gnu-runtime');assert.equal(config.standalone,undefined);
  const pmf=JSON.parse(await read(report.memberFunctionPointerQualification,config.pmfQualification));
  verifyTimezonePmfMetadata(pmf,expected);
  await read(pmf.fixture,path.join(here,'tzdb-pmf-fixtures.mjs'));
  await read(pmf.plans,pmf.parameters.plans);
  for(const [name,value] of [['work',expected.work],['sdk',expected.sdk],['node',expected.node??process.execPath]])
    assert.equal(path.resolve(pmf.parameters[name]),path.resolve(value));
  assert.equal(path.resolve(config.sysroot),report.sysroot.path);
  assert.equal(path.resolve(pmf.parameters.sysroot),report.sysroot.path,
    'Final PMF qualification must use the current complete GNU runtime sysroot');
  const provided=await timezoneSysrootInventory(expected);
  assert.deepEqual(indexed(report.sysroot.files),indexed(provided),
    'Timezone execution sysroot differs from the current base/GNU/resource provider merge');
  const sysrootNames=new Set(report.sysroot.files.map(record=>record.path));
  async function inspectSysroot(directory,prefix='') {
    for(const entry of await fs.readdir(directory,{withFileTypes:true})) {
      const relative=prefix+entry.name,file=path.join(directory,entry.name);
      if(entry.isDirectory())await inspectSysroot(file,relative+'/');
      else {
        assert(entry.isFile()&&sysrootNames.delete(relative),'Unexpected timezone sysroot input '+relative);
        assert.deepEqual(identity(await fs.readFile(file)),content(provided.find(record=>record.path===relative)));
      }
    }
  }
  await inspectSysroot(report.sysroot.path);assert.equal(sysrootNames.size,0);
  await read(report.nativeBuild,path.join(expected.work,'native-build.json'));
  const native=JSON.parse(await read(expected.nativeBuild,path.join(expected.work,'native-build.json')));
  assert.deepEqual(native.gccSource,expected.gccSource);
  for(const tool of ['cc1','cc1plus']) {
    await read(report.tools[tool],path.join(expected.work,'gcc-native/gcc',tool));
    assert.equal(report.tools[tool].sha256,native.tools[tool].sha256);
  }
  await read(report.tools.as,path.join(expected.work,'wabt-native/wat2wasm'));
  await read(report.tools.objdump,path.join(expected.work,'wabt-native/wasm-objdump'));
  await read(report.tools.ld,path.join(expected.sdk,'bin/wasm-ld'));
  await read(report.tools.node,expected.node??process.execPath);
  const available=indexed(report.sysroot.files);
  // Exact current ordinary and exception providers must be present in the
  // native execution sysroot, even when a larger packaged sysroot is supplied.
  for(const [profile,root,relative] of [['ordinary',expected.ordinaryRuntime,'lib/wasm32-wasi'],
    ['exceptions',expected.exceptionRuntime,'lib/wasm32-wasi-eh']]) {
    const runtime=report.runtimes[profile];assert.equal(runtime.directory,path.resolve(root));
    const build=JSON.parse(await read(runtime.build,path.join(root,'build.json')));
    assert.equal(build.status,'built-unverified');assert.equal(build.timezoneDatabase,true);
    assert.deepEqual(build.gccSource,expected.gccSource);
    for(const name of ['libstdc++.a','libsupc++.a',...(profile==='exceptions'?['libunwind.a']:[])]) {
      const record=runtime.libraries[name];await read(record,path.join(root,'sysroot',relative,name));
      assert.deepEqual(available[relative+'/'+name],content(record));
    }
  }
  const frozen=new Map();
  for(const record of [...report.inputs,...report.artifacts]) {
    await read(record);frozen.set(record.path,record);
  }
  for(const record of pmf.inputs) {await read(record);frozen.set(record.path,record);}
  for(const item of pmf.cases) {
    for(const name of ['program','source','assembly','object','result']) {
      await read(item[name]);frozen.set(item[name].path,item[name]);
    }
    for(const command of item.commands)for(const name of ['stdout','stderr']) {
      await read(command[name]);frozen.set(command[name].path,command[name]);
    }
  }
  // The original report's declared input list is also checked against a newly
  // enumerated run, so an omitted current header/tool cannot hide here.
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'gcc-wasi-tzdb-reopen-'));
  const replay={schemaVersion:1,kind:'gcc-wasi-tzdb-native-replay',status:'running',
    qualification,commands:[],retainedExecutions:[]};
  const replayFile=path.join(temporary,'replay.json');
  try {
    const pmfDirectory=path.join(temporary,'pmf');
    const pmfArgs=Object.entries(pmf.parameters).flatMap(([name,value])=>['--'+name,value]);
    replay.commands.push(await run('python3',[path.join(here,'test-tzdb-pmf.py'),...pmfArgs,
      '--output',pmfDirectory],temporary,'fresh-native-pmf',900000));
    const pmfFile=path.join(pmfDirectory,'qualification.json');
    const pmfFresh=JSON.parse(await fs.readFile(pmfFile,'utf8'));verifyTimezonePmfMetadata(pmfFresh,expected);
    assert.deepEqual(indexed(pmfFresh.inputs),indexed(pmf.inputs));
    for(const [index,item] of pmf.cases.entries())
      assert.deepEqual(content(item.program),content(pmfFresh.cases[index].program),'Fresh PMF program differs');
    replay.memberFunctionPointer=await identify(pmfFile);
    const freshDirectory=path.join(temporary,'fresh');
    replay.commands.push(await run(expected.node??process.execPath,[path.join(here,'test-tzdb.mjs'),
      '--config',report.config.path,'--output',freshDirectory],temporary,'fresh-native-tzdb',1500000));
    const freshFile=path.join(freshDirectory,'qualification.json');
    const fresh=JSON.parse(await fs.readFile(freshFile,'utf8'));
    verifyTimezoneQualificationMetadata(fresh,expected);
    assert.deepEqual(indexed(fresh.inputs),indexed(report.inputs),'Timezone input closure differs on replay');
    assert.deepEqual(fresh.sysroot,report.sysroot);assert.deepEqual(fresh.runtimes,report.runtimes);
    for(const [index,fixture] of timezoneCases.entries()) {
      const original=report.cases[index],current=fresh.cases[index];
      assert.deepEqual(content(original.program),content(current.program),'Fresh timezone code/data differs: '+fixture.id);
      const directory=path.join(temporary,'retained-'+fixture.id);await fs.mkdir(directory);
      await fs.writeFile(path.join(directory,'stdin.txt'),fixture.run.stdin,{flag:'wx'});
      replay.commands.push(await run(expected.node??process.execPath,['--no-warnings',path.join(here,'run-eh-program.mjs'),
        original.program.path,directory,...fixture.run.args],directory,'execute',120000));
      const resultFile=path.join(directory,'result.json');
      const actual=JSON.parse(await fs.readFile(resultFile,'utf8'));
      assert.equal(actual.escapedException,null);
      for(const key of ['stdout','stderr','exitCode'])assert.equal(actual[key],fixture[key]);
      replay.retainedExecutions.push({id:fixture.id,result:await identify(resultFile),status:'passed'});
    }
    for(const record of frozen.values())await read(record);
    replay.status='passed';replay.inputsUnchanged=true;replay.fresh=await identify(freshFile);
    replay.counts={freshNativePrograms:12,retainedProgramExecutions:12,freshMemberFunctionPointerPrograms:8};
    await fs.writeFile(replayFile,JSON.stringify(replay,null,2)+'\n',{flag:'wx'});
    return {status:'passed',qualification,replay:await identify(replayFile)};
  } catch(error) {
    replay.status='failed';replay.error=String(error);
    await fs.writeFile(replayFile,JSON.stringify(replay,null,2)+'\n',{flag:'wx'});
    throw error;
  }
}

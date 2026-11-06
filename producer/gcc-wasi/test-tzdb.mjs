#!/usr/bin/env node
// Execute the production SDK's recorded plans with the real native GCC backend.
// Standalone mode is an implementation preflight, never full-runtime admission.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { timezoneCases } from './tzdb-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const content = value => ({ bytes: value.bytes, sha256: value.sha256 });
const hash = bytes => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
const identity = async file => ({ path: path.resolve(file), ...hash(await fs.readFile(file)) });
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
async function writeJson(file, value) {
  await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

assert.equal(process.argv[2], '--config'); assert.equal(process.argv[4], '--output');
assert.equal(process.argv.length, 6, 'Use --config FILE --output NEW_DIRECTORY');
const configFile = path.resolve(process.argv[3]), output = path.resolve(process.argv[5]);
const config = await readJson(configFile);
const inputs = new Map(), artifacts = new Map();
async function input(file, expected) {
  const actual = await identity(file);
  if (expected) assert.deepEqual(content(actual), content(expected), 'Changed input ' + file);
  inputs.set(actual.path, actual); return actual;
}
async function artifact(file) { const value = await identity(file); artifacts.set(value.path, value); return value; }
async function tree(root, callback) {
  for (const entry of (await fs.readdir(root, { withFileTypes: true })).sort((a,b)=>a.name.localeCompare(b.name))) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) await tree(file, callback);
    else { assert(entry.isFile(), 'Non-regular native sysroot entry ' + file); await callback(file); }
  }
}
const env = { ...process.env, LC_ALL: 'C', PYTHONDONTWRITEBYTECODE: '1' };
for (const name of ['CPATH','C_INCLUDE_PATH','CPLUS_INCLUDE_PATH','OBJC_INCLUDE_PATH',
  'GCC_EXEC_PREFIX','COMPILER_PATH','LIBRARY_PATH','CFLAGS','CXXFLAGS','CPPFLAGS','LDFLAGS','LIBS']) delete env[name];
const report = { schemaVersion: 1, kind: 'gcc-wasi-tzdb-native-qualification', status: 'running',
  mode: config.mode, compilerHost: 'native', target: 'wasm32-wasi',
  fullGnuLibrary: config.mode === 'full-gnu-runtime', browserCompilerQualified: false,
  cases: [], commands: [], inputsUnchanged: false, startedAt: new Date().toISOString() };
await fs.mkdir(output, { mode: 0o700 });
async function progress(current) {
  await fs.writeFile(path.join(output, 'progress.json.tmp'), JSON.stringify({status:report.status,
    completed:report.cases.length,current,error:report.error})+'\n', {mode:0o600});
  await fs.rename(path.join(output,'progress.json.tmp'),path.join(output,'progress.json'));
}
async function run(tool, argv, cwd, label, timeout=180000) {
  const stdout=path.join(cwd,label+'.stdout'),stderr=path.join(cwd,label+'.stderr');
  const out=await fs.open(stdout,'wx',0o600),err=await fs.open(stderr,'wx',0o600);
  let result;
  try {
    result=await new Promise(resolve=>{
      const child=spawn(tool,argv,{cwd,env,stdio:['ignore',out.fd,err.fd]});
      let error,timedOut=false;
      const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},timeout);
      child.once('error',value=>{error=String(value);});
      child.once('close',(exitCode,signal)=>{clearTimeout(timer);resolve({exitCode,signal,error,timedOut});});
    });
  } finally {await out.close();await err.close();}
  const command={tool,argv,cwd,...result,stdout:await artifact(stdout),stderr:await artifact(stderr)};
  report.commands.push(command);
  await writeJson(path.join(cwd,label+'.json'),command);await artifact(path.join(cwd,label+'.json'));
  assert.equal(result.error,undefined);assert.equal(result.signal,null);assert.equal(result.timedOut,false);
  assert.equal(result.exitCode,0,label+': '+(await fs.readFile(stderr,'utf8')).slice(-3000));
  return command;
}
function inspectDisassembly(text, exceptions) {
  const instructions=[...text.matchAll(/\|\s+([A-Za-z0-9_.]+)(?:\s|$)/gm)].map(x=>x[1]);
  assert(instructions.length>0,'No actual Wasm disassembly');
  const atomics=instructions.filter(x=>x.includes('.atomic.')||x==='atomic.fence');
  assert.equal(atomics.length,0,'Timezone profile contains atomic instructions');
  // GNU's single-thread reference-count functions retain names such as
  // __gnu_cxx::__atomic_add despite containing only ordinary instructions.
  // Reject unresolved helper imports, not harmless C++ symbol names.
  assert(!text.split('\n').some(line=>line.includes(' <- ')&&/\b__atomic_\w+/u.test(line)),
    'Timezone program imports atomic helpers');
  assert(!/memory\[\d+\].*shared/u.test(text),'Timezone profile requires private memory');
  assert(!instructions.some(x=>['try','catch','catch_all','rethrow'].includes(x)),'Legacy EH instructions');
  if (!exceptions) assert(!instructions.some(x=>['try_table','throw','throw_ref'].includes(x)),'Ordinary runtime contains EH');
  return {atomicInstructions:0,atomicHelpers:0,sharedMemory:false,
    exceptionInstructions:instructions.filter(x=>['try_table','throw','throw_ref'].includes(x)).length};
}
try {
  assert(['standalone-preflight','full-gnu-runtime'].includes(config.mode));
  for(const file of [configFile,fileURLToPath(import.meta.url),path.join(here,'tzdb-fixtures.mjs'),
    path.join(here,'tzdb-oracle.json'),path.join(here,'tzdb.lock.json'),
    path.join(here,'run-eh-program.mjs'),path.join(here,'sources.lock.json'),process.execPath]) await input(file);
  report.config=await input(configFile);
  report.fixtures=await input(path.join(here,'tzdb-fixtures.mjs'));
  report.oracle=await input(path.join(here,'tzdb-oracle.json'));
  report.timezoneLock=await input(path.join(here,'tzdb.lock.json'));
  report.sourceLock=await input(path.join(here,'sources.lock.json'));
  const work=path.resolve(config.work),sdk=path.resolve(config.sdk),sysroot=path.resolve(config.sysroot);
  const native=await readJson(path.join(work,'native-build.json'));
  report.nativeBuild=await input(path.join(work,'native-build.json'));
  report.gccSource=native.gccSource;
  assert.equal(report.sourceLock.sha256,native.sourceLockSha256);
  if(config.mode==='full-gnu-runtime') {
    assert.equal(typeof config.pmfQualification,'string','Full timezone qualification requires the PMF ABI regression');
    const pmf=await readJson(config.pmfQualification);
    report.memberFunctionPointerQualification=await input(config.pmfQualification);
    assert.equal(pmf.kind,'gcc-wasi-member-function-pointer-native-qualification');
    assert.equal(pmf.status,'passed');assert.equal(pmf.inputsUnchanged,true);
    assert.deepEqual(pmf.gccSource,native.gccSource);
    assert.deepEqual(content(pmf.nativeBuild),content(report.nativeBuild));
    assert.deepEqual(pmf.counts,{total:8,families:4,optimizations:['0','2']});
    for(const record of pmf.inputs)await input(record.path,record);
  }
  const tools={cc1:path.join(work,'gcc-native/gcc/cc1'),cc1plus:path.join(work,'gcc-native/gcc/cc1plus'),
    as:path.join(work,'wabt-native/wat2wasm'),ld:path.join(sdk,'bin/wasm-ld'),
    objdump:path.join(work,'wabt-native/wasm-objdump'),node:process.execPath};
  report.tools={};for(const [name,file] of Object.entries(tools))report.tools[name]=await input(file);
  for(const name of ['cc1','cc1plus'])assert.equal(report.tools[name].sha256,native.tools[name].sha256);
  report.sysroot={path:sysroot,files:[]};
  await tree(sysroot,async file=>report.sysroot.files.push({path:path.relative(sysroot,file),...content(await input(file))}));
  report.runtimes={};
  for(const [profile,root] of [['ordinary',config.ordinaryRuntime],['exceptions',config.exceptionRuntime]]) {
    const buildFile=path.join(root,'build.json'),build=await readJson(buildFile);
    assert.deepEqual(build.gccSource,native.gccSource);assert.equal(build.status,'built-unverified');
    assert.equal(build.exceptions,profile==='exceptions');
    assert.equal(build.timezoneDatabase,config.mode==='full-gnu-runtime');
    const libraryPath=profile==='ordinary'?'lib/wasm32-wasi':'lib/wasm32-wasi-eh';
    const libraries={};
    for(const name of ['libstdc++.a','libsupc++.a',...(profile==='exceptions'?['libunwind.a']:[])]) {
      libraries[name]=await input(path.join(root,'sysroot',libraryPath,name));
      assert.deepEqual(content(await input(path.join(sysroot,libraryPath,name))),content(libraries[name]));
    }
    report.runtimes[profile]={directory:path.resolve(root),build:await input(buildFile),libraries};
  }
  const plans=await readJson(config.plans);report.plans=await input(config.plans);
  assert.equal(plans.kind,'gcc-wasi-tzdb-sdk-plans');assert.equal(plans.schemaVersion,1);
  assert.equal(plans.cases.length,timezoneCases.length);
  for(const record of plans.sdk.files)await input(record.path,record);
  if(plans.manifest?.path)await input(plans.manifest.path,plans.manifest);
  await input(plans.fixtures.path,plans.fixtures);
  assert.deepEqual(content(plans.fixtures),content(report.fixtures));
  report.sdk=plans.sdk;
  let standalone;
  if(config.mode==='standalone-preflight') {
    standalone=await readJson(config.standalone);report.standalone=await input(config.standalone);
    assert.equal(standalone.kind,'gnu-tzdb-standalone-object-build');
    assert.equal(standalone.status,'built-unverified');assert.equal(standalone.inputsUnchanged,true);
    assert.deepEqual(standalone.gccSource,native.gccSource);
    for(const record of standalone.inputs)await input(record.path,record);
    for(const object of standalone.objects)for(const key of ['source','assembly','object'])await input(object[key].path,object[key]);
  } else assert.equal(config.standalone,undefined);
  for(const [index,fixture] of timezoneCases.entries()) {
    const item=plans.cases[index];assert.equal(item.id,fixture.id);
    const {linkInputs,...request}=item.request;assert.deepEqual(request,fixture.request);
    assert.deepEqual(item.run,fixture.run);
    const expected={stdout:fixture.stdout,stderr:fixture.stderr,exitCode:fixture.exitCode};
    assert.deepEqual(item.expected,expected);
    await progress(fixture.id);
    const directory=path.join(output,fixture.id),workspace=path.join(directory,'workspace'),external=path.join(directory,'link-inputs');
    await fs.mkdir(workspace,{recursive:true});await fs.mkdir(external);
    const translate=value=>{
      for(const [virtual,physical] of [['/sysroot',sysroot],['/workspace',workspace],['/link-inputs',external]]) {
        if(value===virtual||value.startsWith(virtual+'/'))return physical+value.slice(virtual.length);
        if(value.startsWith('-L'+virtual+'/'))return '-L'+physical+value.slice(virtual.length+2);
      }
      return value;
    };
    const saved={id:fixture.id,request:fixture.request,run:fixture.run,expected,plan:item.plan,
      sources:[],stages:[],status:'running'};
    for(const file of item.plan.files) {
      if(!file.path.startsWith('/workspace/'))continue;
      assert.equal(file.encoding,'utf8');assert.equal(typeof file.contents,'string');
      const relative=path.posix.relative('/workspace',file.path);assert(relative&&!relative.split('/').includes('..'));
      const target=translate(file.path);await fs.mkdir(path.dirname(target),{recursive:true});
      await fs.writeFile(target,file.contents,{flag:'wx'});saved.sources.push(await artifact(target));
    }
    assert.equal(saved.sources.length,1);assert.equal(await fs.readFile(saved.sources[0].path,'utf8'),fixture.request.code);
    const stages=item.plan.stages;
    assert.deepEqual(stages.map(stage=>stage.tool),['cc1plus','as','ld']);
    if(standalone) {
      const object=standalone.objects.find(value=>value.optimization===fixture.request.optimization&&value.exceptions===(fixture.request.exceptions===true));
      assert(object,'Missing exact-profile standalone GNU object');
      const links=stages[2].argv.filter(arg=>arg.startsWith('/link-inputs/'));
      assert.equal(links.length,1);const target=translate(links[0]);
      await fs.copyFile(object.object.path,target);saved.externalObject=await artifact(target);
      assert.deepEqual(content(saved.externalObject),content(object.object));
    } else assert(!stages[2].argv.some(arg=>arg.startsWith('/link-inputs/')));
    for(const [stageIndex,stage] of stages.entries()) {
      assert.equal(typeof tools[stage.tool],'string');
      assert(stage.output.startsWith('/workspace/'));
      const argv=stage.argv.map(translate);
      const command=await run(tools[stage.tool],argv,workspace,'stage-'+stageIndex);
      saved.stages.push({...command,sdkTool:stage.tool,sdkArgv:stage.argv,semanticArgumentsIdentical:true,
        output:await artifact(translate(stage.output))});
    }
    assert(stages[0].argv.includes('-mno-atomics'));assert(stages[2].argv.includes('--fatal-warnings'));
    const program=translate(stages.at(-1).output);saved.program=await artifact(program);
    saved.inspection=await run(tools.objdump,['-x','-d',program],directory,'inspect');
    saved.profile=inspectDisassembly(await fs.readFile(saved.inspection.stdout.path,'utf8'),fixture.request.exceptions===true);
    await fs.writeFile(path.join(directory,'stdin.txt'),fixture.run.stdin,{flag:'wx'});await artifact(path.join(directory,'stdin.txt'));
    saved.execution=await run(tools.node,['--no-warnings',path.join(here,'run-eh-program.mjs'),program,directory,...fixture.run.args],directory,'execute');
    saved.result=await artifact(path.join(directory,'result.json'));
    saved.observations=await readJson(saved.result.path);
    assert.equal(saved.observations.escapedException,null);
    for(const key of ['stdout','stderr','exitCode'])assert.equal(saved.observations[key],expected[key],fixture.id+': '+key);
    assert(saved.observations.imports.every(value=>value.module==='wasi_snapshot_preview1'&&value.kind==='function'));
    assert(saved.observations.exports.some(value=>value.name==='memory'&&value.kind==='memory'));
    saved.status='passed';report.cases.push(saved);
  }
  report.counts={total:report.cases.length,ordinary:10,exceptions:2,families:6};
  report.noGuestPreopens=true;report.hostTimezoneFilesExposed=false;
  report.status='passed';
} catch(error) {
  report.status='failed';report.error=error.stack??String(error);process.exitCode=1;
} finally {
  report.inputs=[...inputs.values()];report.artifacts=[...artifacts.values()];
  report.inputsUnchanged=true;
  for(const record of report.inputs) {
    try {assert.deepEqual(content(await identity(record.path)),content(record));}
    catch(error){report.inputsUnchanged=false;report.status='failed';report.inputError=String(error);process.exitCode=1;break;}
  }
  report.completedAt=new Date().toISOString();await writeJson(path.join(output,'qualification.json'),report);
  await progress();console.log(JSON.stringify({status:report.status,inputsUnchanged:report.inputsUnchanged,
    passed:report.cases.length,report:path.join(output,'qualification.json')}));
}

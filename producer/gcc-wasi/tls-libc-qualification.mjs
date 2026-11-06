import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { identity, runLibatomicValidationCommand as run } from './libatomic-qualification.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const content=value=>({bytes:value.bytes,sha256:value.sha256});
const identify=async file=>({path:file,...identity(await fs.readFile(file))});
const names=['libc.a','libc-printscan-long-double.a'];
export function verifyTlsLibcBuildMetadata(report) {
  assert.equal(report.schemaVersion,1);assert.equal(report.kind,'gcc-wasi-private-tls-libc-build');
  assert.equal(report.status,'built-unverified');assert.equal(report.inputsUnchanged,true);
  assert.deepEqual(report.profile,{target:'wasm32-wasip1',threads:false,reentrant:false,
    compilerThreadModel:'single',nativeTls:true,allocator:'unmodified-single-thread-dlmalloc',
    atomicWaitNotify:false,sourceModified:false,longDoubleFormatting:true,executionQualified:false});
  assert.deepEqual(Object.keys(report.libraries).sort(),[...names].sort());
  assert.deepEqual(Object.keys(report.memberInventories).sort(),[...names].sort());
  assert.equal(report.memberInventories['libc-printscan-long-double.a'].length,6);
  assert.equal(report.tlsInspection.length,6);
  assert.equal(report.formatterDelegation.length,3);
  assert(report.objects.length>800);
  assert.equal(report.objects.length,Object.values(report.memberInventories).flat().length);
  assert(report.commands.length>report.objects.length&&report.commands.every(command=>command.status===0));
}

async function read(record,file) {
  assert(record&&typeof record.path==='string','Missing private libc identity');
  if(file)assert.equal(path.resolve(record.path),await fs.realpath(file));
  const bytes=await fs.readFile(record.path);
  assert.deepEqual(identity(bytes),content(record),'Changed private libc input: '+record.path);
  return bytes;
}

// A new configure/build from the locked official source is the admission proof;
// supplied disassembly and configuration receipts alone cannot establish it.
export async function reopenTlsLibcBuild(directory,expected) {
  assert(expected.work&&expected.sdk,'Private libc requires caller-known tools');
  directory=path.resolve(directory);
  const work=path.resolve(expected.work),sdk=path.resolve(expected.sdk);
  const reportFile=path.join(directory,'build.json'),reportBytes=await fs.readFile(reportFile),report=JSON.parse(reportBytes);
  verifyTlsLibcBuildMetadata(report);
  await read(report.recipe,path.join(here,'build-tls-libc.py'));
  const lock=JSON.parse(await read(report.runtimeLock,path.join(here,'runtime.lock.json'))).wasiLibc;
  assert.equal(report.commit,lock.commit);assert.equal(report.sourceArchive.sha256,lock.sourceArchiveSha256);
  assert.equal(report.sdkArchive.sha256,lock.sdkArchiveSha256);
  const archive=path.resolve(expected.sourceArchive??report.sourceArchive.path);
  await read(report.sourceArchive,archive);
  await read(report.sdkArchive,path.join(path.dirname(sdk),path.basename(sdk)+'.tar.gz'));
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'gcc-wasi-tls-libc-reopen-'));
  const freshDirectory=path.join(temporary,'fresh'),replay={status:'running',directory:temporary,commands:[]};
  try {
    replay.commands.push(await run('python3',[path.join(here,'build-tls-libc.py'),'--work',work,'--sdk',sdk,
      '--source-archive',archive,'--output',freshDirectory,'--jobs','2','--node',process.execPath],temporary,'build',2400000));
    const fresh=JSON.parse(await fs.readFile(path.join(freshDirectory,'build.json')));
    verifyTlsLibcBuildMetadata(fresh);
    for(const key of ['inputs','tools','builtins','clangHeaders','recipe','runtimeLock','sourceArchive','sdkArchive',
      'commit','profile','inspectors','sourceInputs','generatedSources','configurationChecks','memberInventories'])
      assert.deepEqual(report[key],fresh[key],'Private libc binding differs: '+key);
    for(const input of report.inputs)await read(input);
    const translate=value=>typeof value==='string'&&value.startsWith(freshDirectory+path.sep)?directory+value.slice(freshDirectory.length):value;
    assert.equal(report.commands.length,fresh.commands.length);
    for(const [index,command]of report.commands.entries()) {
      assert.deepEqual(command.argv,fresh.commands[index].argv.map(translate),'Changed private libc build command');
      await read(command.stdout);await read(command.stderr);
    }
    for(const [name,item]of Object.entries(report.sourceInputs))
      assert.deepEqual(identity(await fs.readFile(path.join(directory,'source','wasi-libc-'+lock.commit,name))),item,'Changed upstream private libc source');
    for(const [index,item]of report.objects.entries()) {
      const original=await read(item.object),actual=await read(fresh.objects[index].object);
      assert.equal(item.object.path,translate(fresh.objects[index].object.path));
      assert.deepEqual(original,actual,'Recompiled private libc object differs');
    }
    const files=[];
    for(const name of names) {
      const relative='lib/wasm32-wasi-tls/'+name;
      const original=await read(report.libraries[name],path.join(directory,'sysroot',relative));
      assert.deepEqual(original,await read(fresh.libraries[name]),'Rebuilt private libc archive differs');
      files.push({path:relative,...identity(original)});
    }
    for(const [name,item]of Object.entries(report.configuration))await read(item,path.join(directory,'configuration',name));
    assert.equal(report.licenses.length,fresh.licenses.length);
    const licenses=[];
    for(const [index,item]of report.licenses.entries()) {
      assert.equal(item.source.path,translate(fresh.licenses[index].source.path));
      const original=await read(item.source),installed=await read(item.installed);
      assert.deepEqual(original,installed);assert.deepEqual(original,await read(fresh.licenses[index].source));
      licenses.push({path:path.basename(item.installed.path),...identity(installed)});
    }
    replay.status='passed';replay.build=await identify(path.join(freshDirectory,'build.json'));
    const result={status:'built-unverified',build:{path:reportFile,...identity(reportBytes)},files,licenses,
      sourceArchive:report.sourceArchive,runtimeLock:report.runtimeLock,profile:report.profile};
    const replayFile=path.join(temporary,'reopen.json');
    await fs.writeFile(replayFile,JSON.stringify({...result,replayDetails:replay},null,2)+'\n');
    return {...result,replay:await identify(replayFile)};
  }catch(error){replay.status='failed';replay.error=String(error.stack||error);
    await fs.writeFile(path.join(temporary,'reopen.json'),JSON.stringify(replay,null,2)+'\n');throw error;}
}

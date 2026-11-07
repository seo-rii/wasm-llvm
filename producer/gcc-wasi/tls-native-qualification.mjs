import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeTlsSharedCases, assertNativeTlsSharedResult } from './tls-native-fixtures.mjs';
import { identity, runLibatomicValidationCommand as run } from './libatomic-qualification.mjs';
import { assertTlsAssemblyReplay, canonicalTlsAssembly } from './tls-assembly-replay.mjs';
import { runTlsSharedProgram } from './run-tls-shared.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const content=record=>({bytes:record.bytes,sha256:record.sha256});
export const expectedNativeTlsCounts=Object.freeze({driverCases:40,driverExecutions:22,driverDiagnostics:16,inlineDynamicObjectCases:2,sharedCases:8});

export function verifyNativeTlsMetadata(driver,shared) {
  assert.equal(driver.kind,'gcc-wasi-tls-native-driver');
  assert.equal(shared.kind,'gcc-wasi-tls-native-shared');
  for (const report of [driver,shared]) {
    assert.equal(report.schemaVersion,1); assert.equal(report.status,'passed'); assert.equal(report.inputsUnchanged,true);
    assert(report.cases.every(item=>item.status==='passed'));
    assert.equal(new Set(report.cases.map(item=>item.id)).size,report.cases.length);
  }
  assert.deepEqual(driver.counts,{executions:22,diagnostics:16,inlineDynamicObjectCases:2});
  const ids=[];
  for (const language of ['c','cpp']) for (const optimization of ['0','2']) {
    for (const profile of ['default','enabled','last-enabled','last-disabled','model-attribute']) ids.push(`${profile}-${language}-o${optimization}`);
    for (const profile of ['pic','pie','debug','model']) ids.push(`reject-${profile}-${language}-o${optimization}`);
    if (language==='cpp') for (const profile of ['constant','dynamic']) ids.push(`inline-${profile}-cpp-o${optimization}`);
  }
  assert.deepEqual(driver.cases.map(item=>item.id).sort(),ids.sort());
  assert.deepEqual(shared.counts,{sharedExecutions:8,translationUnits:16,workersPerExecution:2});
  assert.deepEqual(shared.cases.map(item=>item.id).sort(),nativeTlsSharedCases.map(item=>item.id).sort());
  assert(Number.isSafeInteger(shared.reservedBytes)&&shared.reservedBytes>=8192&&shared.reservedBytes%16===0);
  assert(nativeTlsSharedCases.every(fixture=>fixture.request.sharedMemory.reservedBytes===shared.reservedBytes));
}

async function identify(file) { return {path:path.resolve(file),...identity(await fs.readFile(file))}; }
async function read(record,expectedPath) {
  assert(record&&Number.isSafeInteger(record.bytes)&&/^[0-9a-f]{64}$/u.test(record.sha256));
  if (expectedPath) assert.equal(path.resolve(record.path),path.resolve(expectedPath));
  const data=await fs.readFile(record.path);
  assert.deepEqual(identity(data),content(record),`TLS evidence changed: ${record.path}`);
  return data;
}

async function reopenReports(aggregate,expected) {
  for (const key of ['work','sdk','gccSource','sourceLockSha256','nativeBuild']) assert(expected[key],`Missing TLS context ${key}`);
  const work=path.resolve(expected.work),sdk=path.resolve(expected.sdk);
  assert.equal(aggregate.schemaVersion,1); assert.equal(aggregate.kind,'gcc-wasi-native-tls-qualification'); assert.equal(aggregate.status,'passed');
  assert.deepEqual(aggregate.counts,expectedNativeTlsCounts);
  assert.deepEqual(aggregate.gccSource,expected.gccSource);
  assert.equal(aggregate.sourceLock.sha256,expected.sourceLockSha256);
  assert.deepEqual(content(aggregate.nativeBuild),content(expected.nativeBuild));
  await read(aggregate.sourceLock,path.join(here,'sources.lock.json'));
  const native=JSON.parse(await read(aggregate.nativeBuild,path.join(work,'native-build.json')));
  assert.deepEqual(native.gccSource,expected.gccSource); assert.equal(native.sourceLockSha256,expected.sourceLockSha256);
  const driver=JSON.parse(await read(aggregate.driver)),shared=JSON.parse(await read(aggregate.shared));
  verifyNativeTlsMetadata(driver,shared);
  const frozen=new Map();
  for (const report of [driver,shared]) for (const [file,record] of Object.entries(report.inputs)) {
    await read({...record,path:file},file);
    if (frozen.has(file)) assert.deepEqual(frozen.get(file),record,'Conflicting TLS input identities');
    frozen.set(file,record);
  }
  const required=[...['tls-native-check.py','tls-native-probe.c','tls-native-shared-check.py','tls-native-fixtures.mjs',
    'run-tls-shared.mjs','tls-inspect.mjs','symbol-alias-inspect.mjs','sources.lock.json','build-native.sh'].map(name=>path.join(here,name)),
    ...['native-build.json','gcc-source.json','native-driver.specs','wabt-native/provenance.json','gcc-native/gcc/xgcc',
    'gcc-native/gcc/cc1','gcc-native/gcc/cc1plus','wabt-native/wat2wasm'].map(name=>path.join(work,name)),path.join(sdk,'bin/wasm-ld')];
  for (const file of required) assert(frozen.has(await fs.realpath(file)),`TLS evidence omits ${file}`);
  await read(aggregate.gate,path.join(here,'tls-native-qualification.mjs'));
  await read(aggregate.replayHelpers,path.join(here,'libatomic-qualification.mjs'));
  await read(aggregate.assemblyReplay,path.join(here,'tls-assembly-replay.mjs'));
  frozen.set(aggregate.gate.path,content(aggregate.gate));
  frozen.set(aggregate.replayHelpers.path,content(aggregate.replayHelpers));
  frozen.set(aggregate.assemblyReplay.path,content(aggregate.assemblyReplay));
  for (const report of [driver,shared]) for (const item of report.cases) {
    assert.equal(path.basename(item.directory),item.id);
    for (const [file,record] of Object.entries(item.artifacts)) {
      assert.equal(path.dirname(file),item.directory,'TLS artifact escaped its case');
      await read({...record,path:file},file);
    }
    assert(item.commands.length>=1);
    if (item.kind==='diagnostic') assert(item.commands[0].exitCode!==0);
    else assert(item.commands.every(command=>command.exitCode===0));
  }
  for (const item of shared.cases) {
    const execution=JSON.parse(await fs.readFile(path.join(item.directory,'execution.json')));
    assert.deepEqual(execution,item.execution);
    assert.equal(execution.status,'passed'); assert.equal(execution.guardsUnchanged,true);
    assert.equal(execution.fixedMemory,true); assert(execution.overlapMilliseconds>0);
    assert.equal(execution.reservedBytes,shared.reservedBytes);
    assertNativeTlsSharedResult(nativeTlsSharedCases.find(fixture=>fixture.id===item.id),{
      values:execution.values,memory:new Uint8Array(await fs.readFile(path.join(item.directory,'memory.bin'))),tlsRegions:execution.tlsRegions});
  }
  return {driver,shared,frozen,work,sdk};
}

export async function writeNativeTlsQualification(file,proofs,expected) {
  const aggregate={schemaVersion:1,kind:'gcc-wasi-native-tls-qualification',status:'passed',counts:expectedNativeTlsCounts,
    gccSource:expected.gccSource,sourceLock:await identify(path.join(here,'sources.lock.json')),
    nativeBuild:await identify(path.join(expected.work,'native-build.json')),
    driver:await identify(proofs.driver),shared:await identify(proofs.shared),
    gate:await identify(path.join(here,'tls-native-qualification.mjs')),
    replayHelpers:await identify(path.join(here,'libatomic-qualification.mjs')),
    assemblyReplay:await identify(path.join(here,'tls-assembly-replay.mjs'))};
  await reopenReports(aggregate,expected);
  await fs.writeFile(file,JSON.stringify(aggregate,null,2)+'\n');
  return aggregate;
}

export async function reopenNativeTlsQualification(file,expected) {
  const aggregate=JSON.parse(await fs.readFile(file));
  const {driver,shared,frozen,work,sdk}=await reopenReports(aggregate,expected);
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'gcc-tls-replay-'));
  await fs.chmod(directory,0o700);
  const evidence={kind:'gcc-wasi-native-tls-replay',status:'running',commands:[],comparisons:[],directory};
  const save=()=>fs.writeFile(path.join(directory,'reopen.json'),JSON.stringify(evidence,null,2)+'\n');
  try {
    const node=expected.node||process.execPath,python=expected.python||'python3';
    for (const [label,script,stored] of [['driver','tls-native-check.py',driver],['shared','tls-native-shared-check.py',shared]]) {
      const destination=path.join(directory,label);
      const args=[path.join(here,script),'--work',work,'--sdk',sdk,'--node',node,'--output',destination];
      if (label==='shared') args.push('--reserved-bytes',String(shared.reservedBytes));
      evidence.commands.push(await run(python,args,directory,'fresh-'+label,300000));
      const fresh=JSON.parse(await fs.readFile(path.join(destination,'qualification.json')));
      assert.equal(fresh.status,'passed'); assert.equal(fresh.inputsUnchanged,true);
      assert.deepEqual(fresh.inputs,stored.inputs,'TLS replay changed source, tools or recipes');
      assert.deepEqual(fresh.cases.map(item=>item.id),stored.cases.map(item=>item.id));
      for (const old of stored.cases) {
        const next=fresh.cases.find(item=>item.id===old.id);
        assert.equal(next.kind,old.kind); assert.equal(next.status,'passed');
        if (old.kind==='diagnostic') continue;
        const assemblies=Object.keys(old.artifacts).filter(name=>name.endsWith('.s'));
        assert(assemblies.length>0);
        const canonicalRoot=path.join(directory,label+'-'+old.id+'-canonical');
        const canonicalDirectories={original:path.join(canonicalRoot,'original'),fresh:path.join(canonicalRoot,'fresh')};
        for (const value of Object.values(canonicalDirectories)) await fs.mkdir(value,{recursive:true});
        const canonicalObjects=[];
        for (const assembly of assemblies) {
          const name=path.basename(assembly),originalObject=assembly.replace(/\.s$/u,'.o');
          assert(old.artifacts[originalObject]);
          const freshAssembly=path.join(next.directory,name);
          const originalText=await fs.readFile(assembly,'utf8'),freshText=await fs.readFile(freshAssembly,'utf8');
          assertTlsAssemblyReplay(originalText,freshText);
          const object=path.join(directory,label+'-'+old.id+'-'+name+'.o');
          evidence.commands.push(await run(path.join(work,'wabt-native/wat2wasm'),
            ['-r','--enable-annotations','--enable-threads',assembly,'-o',object],directory,label+'-'+old.id+'-'+name+'-assemble'));
          assert.deepEqual(identity(await fs.readFile(object)),old.artifacts[originalObject],'Original TLS WAT no longer reproduces its object');
          const objects={},sources={};
          for (const [origin,text] of [['original',originalText],['fresh',freshText]]) {
            const source=path.join(canonicalDirectories[origin],name);
            sources[origin]=source;
            objects[origin]=source.replace(/\.s$/u,'.o');
            await fs.writeFile(source,canonicalTlsAssembly(text));
            evidence.commands.push(await run(path.join(work,'wabt-native/wat2wasm'),
              ['-r','--enable-annotations','--enable-threads',source,'-o',objects[origin]],directory,
              label+'-'+old.id+'-'+name+'-canonical-'+origin));
          }
          assert.deepEqual(await fs.readFile(objects.fresh),await fs.readFile(objects.original),'Canonical TLS objects differ');
          canonicalObjects.push({originalAssembly:await identify(sources.original),freshAssembly:await identify(sources.fresh),
            originalObject:await identify(objects.original),freshObject:await identify(objects.fresh)});
        }
        const finalName=old.kind==='inline-object-abi'?'combined.o':'program.wasm';
        const originalFinal=path.join(old.directory,finalName),freshFinal=path.join(next.directory,finalName);
        const freshRawEqual=Buffer.compare(await fs.readFile(originalFinal),await fs.readFile(freshFinal))===0;
        const freshLink=next.commands.find(command=>command.argv[0]===path.join(sdk,'bin/wasm-ld'));
        assert(freshLink,'Missing actual TLS linker command');
        // LLD records the output basename in its name custom section.
        // Preserve that original input while isolating each replay file.
        const relinkDirectory=path.join(directory,label+'-'+old.id+'-relink');
        await fs.mkdir(relinkDirectory);
        const relink=path.join(relinkDirectory,finalName);
        const argv=freshLink.argv.slice(1).map((arg,index,all)=>all[index-1]==='-o'?relink:
          arg.startsWith(next.directory+path.sep)?path.join(old.directory,path.relative(next.directory,arg)):arg);
        evidence.commands.push(await run(freshLink.argv[0],argv,directory,label+'-'+old.id+'-relink'));
        assert.deepEqual(identity(await fs.readFile(relink)),old.artifacts[originalFinal],'Original TLS objects no longer reproduce their linked artifact');
        const canonicalFinals={};
        for (const [origin,value] of Object.entries(canonicalDirectories)) {
          const final=path.join(value,finalName);
          const args=freshLink.argv.slice(1).map((arg,index,all)=>all[index-1]==='-o'?final:
            arg.startsWith(next.directory+path.sep)?path.join(value,path.relative(next.directory,arg)):arg);
          evidence.commands.push(await run(freshLink.argv[0],args,directory,label+'-'+old.id+'-canonical-link-'+origin));
          canonicalFinals[origin]=await identify(final);
        }
        assert.deepEqual(content(canonicalFinals.original),content(canonicalFinals.fresh),'Canonical TLS final bytes differ');
        let originalExecution;
        if (finalName==='program.wasm') {
          const bytes=await fs.readFile(originalFinal);
          if (label==='shared') {
            const fixture=nativeTlsSharedCases.find(item=>item.id===old.id); assert(fixture);
            const result=await runTlsSharedProgram(bytes,{...fixture.request.sharedMemory,...fixture.run,reservedBytes:shared.reservedBytes});
            const oracle=assertNativeTlsSharedResult(fixture,result);
            const file=path.join(canonicalRoot,'original-raw-execution.json');
            await fs.writeFile(file,JSON.stringify({oracle,...result.report},null,2)+'\n');
            await fs.writeFile(path.join(canonicalRoot,'original-raw-memory.bin'),result.memory);
            originalExecution=await identify(file);
          } else {
            const module=await WebAssembly.compile(bytes); assert.deepEqual(WebAssembly.Module.imports(module),[]);
            const instance=await WebAssembly.instantiate(module,{}); assert.equal(instance.exports.probe(),0);
            originalExecution={status:'passed',result:0};
          }
        }
        evidence.comparisons.push({id:old.id,assemblies:assemblies.length,originalObjectsExact:true,originalLinkExact:true,
          freshRawEqual,canonicalObjects,canonicalFinals,canonicalFinalExact:true,originalExecution});
      }
    }
    for (const [input,record] of frozen) assert.deepEqual(identity(await fs.readFile(input)),record,`TLS input changed during replay: ${input}`);
    evidence.status='passed'; await save();
    return {schemaVersion:1,kind:'gcc-wasi-native-tls-package-proof',status:'passed',counts:expectedNativeTlsCounts,
      gccSource:aggregate.gccSource,nativeBuild:aggregate.nativeBuild,qualification:await identify(file),replay:await identify(path.join(directory,'reopen.json'))};
  } catch (error) {
    evidence.status='failed'; evidence.error=String(error.stack||error); await save();
    error.message+=`; TLS replay preserved at ${directory}`; throw error;
  }
}

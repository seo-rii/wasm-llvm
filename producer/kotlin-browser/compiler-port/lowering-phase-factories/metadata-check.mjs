import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { prepareLoweringPhaseFactories } from './prepare.mjs';
import { TARGETS } from './transform.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../..'),execute=promisify(execFile);
const output=path.resolve(process.argv[2]);assert(output.startsWith(path.join(REPO,'out')+path.sep));await mkdir(output,{mode:0o700});
const sourceRoot=path.join(REPO,'out/kotlin-compiler-port/sources'),prepared=await prepareLoweringPhaseFactories({sourceRoot,outputRoot:path.join(output,'prepared')});
const bootstrap=await verifyBootstrap(),flags=JSON.parse(await readRegular(path.join(HERE,'../build-flags.json'))),compiler=bootstrap.artifacts.find(x=>x.id==='compiler').path;
const jvm=['-Xmx768m','-cp',bootstrap.classPath,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-jvm-target','17','-language-version',flags.languageVersion,'-api-version',flags.apiVersion,...flags.compilerFlags,'-Xfriend-paths='+compiler,'-Xlambdas=class','-classpath',bootstrap.classPath];
const commands=[],inputs=[],observed={};
async function store(name,bytes){const f=path.join(output,name);await mkdir(path.dirname(f),{recursive:true,mode:0o700});await writeFile(f,bytes,{flag:'wx',mode:0o600});return f;}
for(const name of ['MetadataProbe.kt','metadata-check.mjs','prepare.mjs','transform.mjs','recipes.json','call-sites.json','sources.lock.json','LoweringPassFactory.kt']){const b=await readRegular(path.join(HERE,name));inputs.push({path:name,bytes:b.length,sha256:sha256(b)});}
const probe=await store('MetadataProbe.kt',await readRegular(path.join(HERE,'MetadataProbe.kt')));
async function run(phase,binary,args){console.log('phase: '+phase);try{const r=await execute(binary,args,{cwd:output,timeout:240000,maxBuffer:16*1024*1024});commands.push({phase,command:[binary,...args],exitCode:0});await store(phase+'.stdout',Buffer.from(r.stdout));await store(phase+'.stderr',Buffer.from(r.stderr));return r.stdout;}catch(e){await store(phase+'.stderr',Buffer.from(e.stderr??''));await writeJson(path.join(output,'failure.json'),{phase,exitCode:e.code,stderr:String(e.stderr??'').slice(-18000),commands});throw e;}}
for(const label of ['original','common']){
 const sources=label==='original'?TARGETS.filter(p=>!p.includes('/konan/')).map(p=>path.join(sourceRoot,p)):prepared.commonSources.filter(p=>!p.includes('/konan/'));
 const adapter=await store(label+'/ClassIdentity.kt',Buffer.from('package org.jetbrains.kotlin.portable.phaser.probe\nimport org.jetbrains.kotlin.backend.common.phaser.LoweringPhase\nfun classIdentity(phase: LoweringPhase<*, *, *>): String = phase.loweringClass.'+(label==='original'?'name':'qualifiedName!!')+'\n'));
 await run(label+'-complete-factory-and-common-js-wasm-callers-jvm-build','java',[...jvm,'-d',path.join(output,label+'.jar'),...sources,probe,adapter]);
 observed[label]=await run(label+'-actual-genuine-factory-metadata-jvm-observe','java',['-ea','-cp',[path.join(output,label+'.jar'),bootstrap.classPath].join(path.delimiter),'org.jetbrains.kotlin.portable.phaser.probe.MetadataProbeKt']);
}
assert.equal(observed.original,observed.common);
const records=observed.original.trimEnd().split('\n');assert(records.length>400);
const artifacts=[];async function inventory(root){for(const e of await readdir(root,{withFileTypes:true})){const f=path.join(root,e.name);if(e.isDirectory())await inventory(f);else{const b=await readRegular(f,64*1024*1024);artifacts.push({path:path.relative(output,f),bytes:b.length,sha256:sha256(b)});}}}await inventory(output);
for(const p of inputs){const b=await readRegular(path.join(HERE,p.path));assert.equal(b.length,p.bytes);assert.equal(sha256(b),p.sha256);}
await writeJson(path.join(output,'receipt.json'),{schemaVersion:1,kind:'genuine-phase-factory-all-common-js-wasm-metadata-jvm-proof',result:'pass',preparation:prepared.receipt,inputs,artifacts,commands,records:records.length,rawSha256:sha256(Buffer.from(observed.original)),fullFactorySourceCompiled:true,completeSelectedCallersCompiled:3,completeNativeCallerCompiled:false,factoryExecutionForIntrospection:false,bootstrap:{version:bootstrap.lock.version,sourceCommit:null,artifacts:bootstrap.artifacts.map(({id,bytes,sha256})=>({id,bytes,sha256}))},fullIrLoweringExecuted:false,fullCompilerBuilt:false,languageReadiness:false});
console.log(JSON.stringify({result:'pass',output,records:records.length,rawSha256:sha256(Buffer.from(observed.original))}));

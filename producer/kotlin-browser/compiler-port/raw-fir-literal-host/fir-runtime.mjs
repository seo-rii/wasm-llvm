import assert from 'node:assert/strict';import {execFile} from 'node:child_process';import {mkdir,writeFile} from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';import {promisify} from 'node:util';
import {verifyBootstrap} from '../../build/bootstrap.mjs';import {readRegular,sha256,writeJson} from '../../scripts/source.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../..'),execute=promisify(execFile),output=path.resolve(process.argv[2]);
assert(output.startsWith(path.join(REPO,'out')+path.sep));await mkdir(output,{mode:0o700});
const typeJob=JSON.parse(await readRegular('/tmp/raw-fir-literal-typecheck-job.json')),typeStatus=JSON.parse(await readRegular(typeJob.status));assert.equal(typeStatus.exitCode,0);
const bootstrap=await verifyBootstrap(),flags=JSON.parse(await readRegular(path.join(HERE,'../build-flags.json'))),compiler=bootstrap.artifacts.find(p=>p.id==='compiler').path;
const observer=path.join(HERE,'FirJvmProbe.kt'),observerBytes=await readRegular(observer),commands=[],observed={};
for(const label of ['original','common']) {
 const classJar=path.join(typeJob.output,label+'.jar'),args=['-Xmx768m','-cp',bootstrap.classPath,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-jvm-target','17','-language-version',flags.languageVersion,'-api-version',flags.apiVersion,...flags.compilerFlags,'-classpath',[classJar,bootstrap.classPath].join(path.delimiter),'-Xfriend-paths='+compiler,'-d',path.join(output,label+'.jar'),observer];
 for(const [phase,binary,argv]of [[label+'-genuine-builder-methods-jvm-build','java',args],[label+'-genuine-builder-methods-jvm-observe','java',['-ea','-cp',[path.join(output,label+'.jar'),classJar,bootstrap.classPath].join(path.delimiter),'org.jetbrains.kotlin.portable.rawfir.probe.FirJvmProbeKt']]]) {
  console.log('phase: '+phase);await writeJson(path.join(output,phase+'.arguments.json'),[binary,...argv]);
  try{const r=await execute(binary,argv,{cwd:output,timeout:240000,maxBuffer:16*1024*1024});if(r.stderr)process.stderr.write(r.stderr);commands.push({phase,command:[binary,...argv],exitCode:0});if(phase.endsWith('observe')){observed[label]=r.stdout;await writeFile(path.join(output,label+'-observations.txt'),r.stdout,{flag:'wx',mode:0o600});}}
  catch(error){await writeJson(path.join(output,'failure.json'),{phase,stderr:String(error.stderr??'').slice(-18000),exitCode:error.code,commands});process.stderr.write(String(error.stderr??'').slice(-18000));throw new Error(phase+' failed');}
 }
}
assert.equal(observed.common,observed.original,'Complete genuine raw builder JVM method outputs differ');assert.deepEqual(await readRegular(observer),observerBytes);
await writeJson(path.join(output,'receipt.json'),{schemaVersion:1,kind:'genuine-full-raw-fir-builder-methods-jvm-differential',commands,typecheckReceiptSha256:sha256(await readRegular(path.join(typeJob.output,'receipt.json'))),observer:{path:observer,bytes:observerBytes.length,sha256:sha256(observerBytes)},comparison:{rawSha256:sha256(Buffer.from(observed.original)),records:observed.original.trimEnd().split('\n').length,originalJvmEqualsCommonJvm:true,normalizedText:false},genuineFullBuilderAndFirObjectsExecuted:true,typedNodeAndLightTreeSourceCallbacksOutsideCompilerPackages:true,fullFirPipeline:false,fullRawFirBuilderWasmExecuted:false,fullCompilerBuilt:false,languageReadiness:false});
console.log(JSON.stringify({records:observed.original.trimEnd().split('\n').length}));

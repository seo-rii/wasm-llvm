import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readRegular,sha256,writeJson} from '../../scripts/source.mjs';
import {verifyBootstrap} from '../../build/bootstrap.mjs';
import {verifySerializerOutputBindings,verifySerializerOutputSelection} from './prepare.mjs';
import {verifyEvidence as verifyJsAstEvidence} from '../js-ast/verify.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../..'),execute=promisify(execFile);
const fixtureRoot=path.resolve(process.argv[2]),root=path.resolve(process.argv[3]);assert(root.startsWith(path.join(REPO,'out')+path.sep));await mkdir(root,{mode:0o700});
const fixture=JSON.parse(await readRegular(path.join(fixtureRoot,'fixture.json'),8*1024*1024)),options=fixture.options;
const preparation=await verifySerializerOutputBindings(options),finalSelection=await verifySerializerOutputSelection({sourceRoot:options.sourceRoot,outputRoot:options.outputRoot,retainedSources:fixture.selected});
const bootstrap=await verifyBootstrap(),flagsBytes=await readRegular(path.join(HERE,'../build-flags.json')),flags=JSON.parse(flagsBytes),ast=JSON.parse(await readRegular(path.join(HERE,'../js-ast/evidence/receipt.json')));
const nativeCommand=ast.commands.find(x=>x.phase==='actual-original-jvm-observe').command,nativeAst=nativeCommand[nativeCommand.indexOf('-cp')+1],commonCommand=ast.commands.find(x=>x.phase==='portable-common-jvm-observe').command,commonAst=commonCommand[commonCommand.indexOf('-cp')+1];
const astArtifactRoot=path.dirname(commonAst.split(path.delimiter)[0]);await verifyJsAstEvidence(ast,{artifactRoot:astArtifactRoot});
const artifacts=[],commands=[];
async function store(name,bytes){const filename=path.join(root,name);await mkdir(path.dirname(filename),{recursive:true,mode:0o700});await writeFile(filename,bytes,{flag:'wx',mode:0o600});artifacts.push({path:name,bytes:bytes.length,sha256:sha256(bytes)});return filename;}
async function pin(name){const b=await readRegular(path.join(root,name),32*1024*1024);artifacts.push({path:name,bytes:b.length,sha256:sha256(b)});}
async function run(phase,command,args){console.log('phase:'+phase);const start=performance.now();try{const r=await execute(command,args,{cwd:REPO,timeout:900000,maxBuffer:16*1024*1024});commands.push({phase,command:[command,...args],exitCode:0,elapsedMs:performance.now()-start});if(r.stderr)process.stderr.write(r.stderr);return r.stdout;}catch(e){process.stderr.write(String(e.stderr??'').slice(-18000));throw new Error(phase+' '+JSON.stringify({code:e.code,signal:e.signal,killed:e.killed}));}}
const commonSources=[];
for(const filename of [...fixture.component.commonSources,...options.preparedOutputCodec.commonSources,...options.preparedOutputStream.commonSources,...options.preparedText.commonSources.filter(x=>/CompilerUtf8(?:Algorithm|Api)\.kt$/.test(x))])commonSources.push(await store('common/'+path.basename(filename),await readRegular(filename)));
const constants=await store('Constants.kt',await readRegular(path.join(options.sourceRoot,'compiler/ir/backend.js/src/org/jetbrains/kotlin/ir/backend/js/utils/serialization/Constants.kt')));
const originalSources=[];
for(const row of JSON.parse(await readRegular(path.join(HERE,'inventory.json'))).files){const filename=row.kind==='carrier'?path.join(options.outputRoot,'reference',row.path):path.join(options.sourceRoot,row.path);originalSources.push(await store('original/'+path.basename(filename),await readRegular(filename)));}
const java=['-Xmx768m','-cp',bootstrap.classPath],jvm=[...java,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-language-version',flags.languageVersion,'-api-version',flags.apiVersion,'-jvm-target','17',...flags.compilerFlags];
const commonJar=path.join(root,'common.jar'),originalJar=path.join(root,'original.jar');
await run('full-genuine-common-serializer-fragments-carriers-jvm-build','java',[...jvm,'-classpath',commonAst+path.delimiter+bootstrap.classPath,'-d',commonJar,...commonSources,constants]);await pin('common.jar');
await run('full-genuine-original-serializer-fragments-carriers-jvm-build','java',[...jvm,'-classpath',nativeAst+path.delimiter+bootstrap.classPath,'-d',originalJar,...originalSources,constants]);await pin('original.jar');
const oracle=await store('TransportOracle.java',await readRegular(path.join(HERE,'TransportOracle.java'))),classes=path.join(root,'oracle');await mkdir(classes);
await run('genuine-real-fragment-observer-java-build','javac',['-cp',[commonJar,commonAst,bootstrap.classPath].join(path.delimiter),'-d',classes,oracle]);
const observations={};for(const [variant,jar,astClasspath]of [['original',originalJar,nativeAst],['common',commonJar,commonAst]]){
 observations[variant]=await run('full-genuine-'+variant+'-serializer-real-fragment-observe','java',['-ea','-cp',[classes,jar,astClasspath,bootstrap.classPath,commonJar].join(path.delimiter),'TransportOracle',variant]);await store(variant+'-observations.txt',Buffer.from(observations[variant]));
}
assert.equal(observations.common,observations.original,'Full genuine serializer transport records differ');
for(const name of ['TransportOracle.class','TransportOracle$State.class','TransportOracle$NativeSink.class','TransportOracle$CommonSink.class'])await pin('oracle/'+name);
await writeJson(path.join(root,'jvm-runtime.json'),{schemaVersion:1,kind:'full-genuine-serializer-output-jvm-runtime',sourceLockSha256:sha256(await readRegular(path.join(HERE,'sources.lock.json'))),flagsSha256:sha256(flagsBytes),artifactRoot:path.relative(REPO,root),fixtureRoot:path.relative(REPO,fixtureRoot),preparation,finalSelection,commands,artifacts,
 astReceiptSha256:sha256(await readRegular(path.join(HERE,'../js-ast/evidence/receipt.json'))),astArtifactRoot:path.relative(REPO,astArtifactRoot),
 originalCommonJvmObservations:observations.original.trimEnd().split('\n').length,fullSerializerWasmExecuted:false,qualifiedNameHostClosed:false,fullCompilerBuilt:false,languageReadiness:false});
console.log(JSON.stringify({originalCommonJvmObservations:observations.original.trimEnd().split('\n').length,fullSerializerWasmExecuted:false}));

import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdir,writeFile,readdir} from 'node:fs/promises';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readRegular,sha256,writeJson} from '../../scripts/source.mjs';
import {verifyBootstrap} from '../../build/bootstrap.mjs';
import {commentTypeNameFixture} from './fixture.mjs';
import {prepareSerializerCommentTypeNames,verifySerializerCommentTypeNames,reconstructSerializerCommentTypeNamePredecessorSelection} from './prepare.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../..'),execute=promisify(execFile);
const root=path.resolve(process.argv[2]);assert(root.startsWith(path.join(REPO,'out')+path.sep));await mkdir(root,{mode:0o700});
const options=await commentTypeNameFixture(path.join(root,'profile')),component=await prepareSerializerCommentTypeNames(options);await verifySerializerCommentTypeNames(options);
const after=options.retainedSources.map(pin=>{const output=component.receipt.files.find(x=>x.path===pin.path);return output?{path:pin.path,filename:path.join(component.outputRoot,pin.path),bytes:output.bytes,sha256:output.sha256}:pin;});
const helper=component.receipt.files.at(-1);after.push({path:helper.path,filename:path.join(component.outputRoot,helper.path),bytes:helper.bytes,sha256:helper.sha256});
const final=await reconstructSerializerCommentTypeNamePredecessorSelection({...options,retainedSources:after});
await writeJson(path.join(root,'fixture.json'),{options,component,after,final});
const bootstrap=await verifyBootstrap(),flagsBytes=await readRegular(path.join(HERE,'../build-flags.json')),flags=JSON.parse(flagsBytes);
const ast=JSON.parse(await readRegular(path.join(HERE,'../js-ast/evidence/receipt.json'))),originalCmd=ast.commands.find(x=>x.phase==='actual-original-jvm-observe').command,commonCmd=ast.commands.find(x=>x.phase==='portable-common-jvm-observe').command;
const originalAst=originalCmd[originalCmd.indexOf('-cp')+1],commonAst=commonCmd[commonCmd.indexOf('-cp')+1];
const prior=JSON.parse(await readRegular(path.join(HERE,'../serializer-output-bindings/evidence/runtime.json'))),priorRoot=path.join(REPO,prior.artifactRoot);
const commands=[];
async function put(name,bytes){const f=path.join(root,name);await mkdir(path.dirname(f),{recursive:true,mode:0o700});await writeFile(f,bytes,{flag:'wx',mode:0o600});return f;}
async function run(phase,exe,args){console.log('phase:'+phase);const start=performance.now();try{const r=await execute(exe,args,{cwd:REPO,timeout:900000,maxBuffer:16*1024*1024});commands.push({phase,command:[exe,...args],exitCode:0,elapsedMs:performance.now()-start});await put('commands/'+commands.length+'-stderr.txt',Buffer.from(r.stderr));if(r.stderr)process.stderr.write(r.stderr);return r.stdout;}catch(e){process.stderr.write(String(e.stderr??'').slice(-18000));throw new Error(phase+' '+JSON.stringify({code:e.code,signal:e.signal,killed:e.killed}));}}
const java=['-Xmx768m','-cp',bootstrap.classPath],jvm=[...java,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-jvm-target','17','-language-version',flags.languageVersion,'-api-version',flags.apiVersion,...flags.compilerFlags];
const fixtures=await put('CommentFixtures.kt',await readRegular(path.join(HERE,'CommentFixtures.kt'))),oracle=await put('Oracle.java',await readRegular(path.join(HERE,'Oracle.java')));
const originalFixtureJar=path.join(root,'original-fixtures.jar');await run('genuine-original-ast-extension-receivers-jvm-build','java',[...jvm,'-classpath',originalAst,'-d',originalFixtureJar,fixtures]);
const commonSources=[];for(const filename of [...component.commonSources,...options.serializerOutputOptions.preparedOutputCodec.commonSources,...options.serializerOutputOptions.preparedOutputStream.commonSources,...options.serializerOutputOptions.preparedText.commonSources.filter(x=>/CompilerUtf8(?:Api|Algorithm)\.kt$/.test(x))])commonSources.push(await put('common/'+path.basename(filename),await readRegular(filename)));
const constants=await put('Constants.kt',await readRegular(path.join(priorRoot,'Constants.kt'))),commonJar=path.join(root,'common.jar');
await run('full-genuine-common-serializer-required-reporter-jvm-build','java',[...jvm,'-classpath',commonAst+path.delimiter+bootstrap.classPath,'-d',commonJar,...commonSources,constants,fixtures]);
const classes=path.join(root,'oracle');await mkdir(classes);await run('full-genuine-serializer-comment-observer-java-build','javac',['-cp',[commonJar,commonAst,bootstrap.classPath].join(path.delimiter),'-d',classes,oracle]);
const observations={};
for(const [variant,jar,cp,receiverJar] of [['original',path.join(priorRoot,'original.jar'),originalAst,originalFixtureJar],['common',commonJar,commonAst,commonJar]]){
    const raw=await run('full-genuine-'+variant+'-serializer-comment-observe','java',['-ea','-cp',[classes,jar,receiverJar,cp,bootstrap.classPath,commonJar].join(path.delimiter),'Oracle',variant]);
    await put(variant+'-observations.txt',Buffer.from(raw));observations[variant]=raw;
}
const rows=raw=>raw.trimEnd().split('\n'),core=raw=>rows(raw).filter(x=>x.startsWith('core\t'));
assert.deepEqual(core(observations.common),core(observations.original),'Full original/common comment errors, getter order or partial writer bytes differ');
const failures=await run('full-genuine-common-serializer-reporter-failure-observe','java',['-ea','-cp',[classes,commonJar,commonAst,bootstrap.classPath].join(path.delimiter),'Oracle','common','throws']);await put('reporter-failure-observations.txt',Buffer.from(failures));
for(const row of core(failures)){const p=row.split('\t'),normal=core(observations.common).find(x=>x.split('\t')[1]===p[1]).split('\t');assert.deepEqual(p.slice(4),normal.slice(4),'Reporter failure changed already-written bytes or getter order');if(normal[2]==='java.lang.IllegalStateException'){assert.equal(p[2],'java.lang.IllegalArgumentException');assert.equal(p[3],Buffer.from('reporter Ω','utf16le').swap16().toString('hex'));}else assert.deepEqual(p,normal);}
const artifacts=[];async function collect(prefix=''){for(const item of await readdir(path.join(root,prefix),{withFileTypes:true})){const name=prefix?prefix+'/'+item.name:item.name;if(item.isDirectory())await collect(name);else{const b=await readRegular(path.join(root,name),32*1024*1024);artifacts.push({path:name,bytes:b.length,sha256:sha256(b)});}}}await collect();
await writeJson(path.join(root,'runtime.json'),{schemaVersion:1,kind:'full-genuine-serializer-required-comment-reporter-jvm',sourceLockSha256:sha256(await readRegular(path.join(HERE,'sources.lock.json'))),sourceFlagsSha256:sha256(flagsBytes),artifactRoot:path.relative(REPO,root),commands,artifacts,
    preparation:component.receipt,final,originalCommonCoreRecords:core(observations.original).length,commonReporterRecords:rows(observations.common).filter(x=>x.startsWith('reporter\t')).length,
    reporterFailureRecords:core(failures).length,actualSelectedSourcesBefore:options.retainedSources.length,actualSelectedSourcesAfter:after.length,priorRuntimeSha256:sha256(await readRegular(path.join(HERE,'../serializer-output-bindings/evidence/runtime.json'))),
    originalCommonJvmExact:true,reporterReceiverIdentityAndPartialWriteOrder:true,jvmBinaryNameHost:'actual java.lang.Object.getClass().getName()',shippingDefaultReporter:false,fullSerializerWasmExecuted:false,fullCompilerBuilt:false,languageReadiness:false});
console.log(JSON.stringify({originalCommonCoreRecords:core(observations.original).length,commonReporterRecords:rows(observations.common).filter(x=>x.startsWith('reporter\t')).length,reporterFailureRecords:core(failures).length}));

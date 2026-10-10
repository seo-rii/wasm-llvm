#!/usr/bin/env node
import assert from 'node:assert/strict';import {execFile} from 'node:child_process';import {mkdir,mkdtemp,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';import {promisify} from 'node:util';
import {readRegular,sha256,verifyFile,writeJson} from '../../../scripts/source.mjs';import {verifyBootstrap} from '../../../build/bootstrap.mjs';
import {prepareAstIntegerConsumer} from '../integer/prepare.mjs';import {prepareAstIntegerBounds} from '../integer-bounds/prepare.mjs';
import {prepareJsAstInput} from '../input-codec/prepare.mjs';import {prepareCompilerTextSources} from '../../text/prepare.mjs';
import {verifyEvidence} from '../../js-ast/verify.mjs';import {observeAstInChromium} from '../../js-ast/browser.mjs';
import {prepareJsAstDeserializer,verifyJsAstDeserializer,auditCommentConsumers} from './prepare.mjs';
import {projection,selectedMethods,commentAddExpression} from './transform.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../../..');
const lockBytes=await readRegular(path.join(HERE,'sources.lock.json')),lock=JSON.parse(lockBytes),sourceRoot=path.join(REPO,'out/kotlin-compiler-port/sources');
const parent=path.join(REPO,'out/kotlin-js-ast-deserializer');await mkdir(parent,{recursive:true,mode:0o700});const output=await mkdtemp(path.join(parent,'run-')),local=name=>path.join(output,name);
const preparedInteger=await prepareAstIntegerConsumer({sourceRoot,outputRoot:local('integer')});
const preparedBounds=await prepareAstIntegerBounds({sourceRoot,outputRoot:local('bounds'),preparedInteger});
const preparedInput=await prepareJsAstInput({sourceRoot,outputRoot:local('input')});
const options={sourceRoot,outputRoot:local('binding'),preparedInteger,preparedBounds,preparedInput};
const prepared=await prepareJsAstDeserializer(options);await verifyJsAstDeserializer({...options,receiptPath:prepared.receiptPath});
const text=await prepareCompilerTextSources({sourceRoot,outputRoot:local('text')});const sharedText=text.commonSources.filter(p=>preparedInput.sharedDependencies.some(d=>d.path===path.basename(p)));
assert.equal(sharedText.length,2);
const baseline=path.join(REPO,'out/kotlin-js-ast/differential-WViAyC'),astReceipt=JSON.parse(await readRegular(path.join(HERE,'../../js-ast/evidence/receipt.json')));
await verifyEvidence(astReceipt,{artifactRoot:baseline});
const commonAst=astReceipt.preparation.files.map(pin=>path.join(baseline,'common',pin.path));
for(const name of ['original','common']) {
    const bytes=await readRegular(name==='original'?preparedBounds.commonSources[0]:prepared.commonSources[0]);
    assert.deepEqual(Object.fromEntries(Object.entries(selectedMethods(bytes)).map(([key,text])=>[key,sha256(Buffer.from(text))])),lock.methodProjections[name]);
    await writeFile(local(name+'-SelectedInput.kt'),projection(bytes,name==='common'),{flag:'wx',mode:0o600});
}
const expression=commentAddExpression(await readRegular(path.join(sourceRoot,lock.sources[1].path)));assert.equal(sha256(Buffer.from(expression)),lock.methodProjections.commentAddSha256);
await writeFile(local('CommentMutation.kt'),'package org.jetbrains.kotlin.js.deserializerprobe\nimport org.jetbrains.kotlin.js.backend.ast.*\nfun mutateComments(ref: JsNode) {\n'+expression+'\n}\n',{flag:'wx',mode:0o600});
for(const pin of lock.observers)await writeFile(local(pin.path),verifyFile(await readRegular(path.join(HERE,pin.path)),pin),{flag:'wx',mode:0o600});
const buildRoot=path.join(REPO,'out/kotlin-compiler-port/builds/common-boundaries-whole-1791635510943341799');
const wholeBytes=await readRegular(path.join(buildRoot,'compiler-build-receipt.json')),whole=JSON.parse(wholeBytes),argsBytes=await readRegular(path.join(buildRoot,'compiler-klib.args'));
const args=argsBytes.toString().split('\n').filter(Boolean).map(line=>line.startsWith('"')?JSON.parse(line):line),sourceFiles=args.filter(x=>!x.startsWith('-')&&x.endsWith('.kt'));
assert.equal(sourceFiles.length,whole.compileSources.length);
const retainedSources=whole.compileSources.map(pin=>{const matches=sourceFiles.filter(filename=>filename.endsWith('/'+pin.path));assert.equal(matches.length,1,pin.path);return {path:pin.path,filename:matches[0]};});
const selectedCallerAudit=await auditCommentConsumers(retainedSources);
for(const caller of selectedCallerAudit) {const expected=whole.compileSources.find(pin=>pin.path===caller.path);assert.equal(caller.bytes,expected.bytes);assert.equal(caller.sha256,expected.sha256);}await writeJson(local('selected-callers.json'),selectedCallerAudit);
const bootstrap=await verifyBootstrap(),stdlib=bootstrap.artifacts.find(p=>p.id==='stdlib-jvm').path,flagsBytes=await readRegular(path.join(HERE,'../../build-flags.json')),flags=JSON.parse(flagsBytes);
const run=promisify(execFile),commands=[];
async function execute(phase,bin,args){console.log('phase: '+phase);const r=await run(bin,args,{timeout:240000,maxBuffer:12*1024*1024,encoding:'utf8'});if(r.stderr)process.stderr.write(r.stderr);commands.push({phase,command:[bin,...args],exitCode:0});return r.stdout;}
const java=['-Xmx768m','-cp',bootstrap.classPath];
const jvm=[...java,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-jvm-target','17','-language-version',flags.languageVersion,'-api-version',flags.apiVersion,...flags.compilerFlags];
const originalDependencies=[path.join(baseline,'original-kotlin.jar'),path.join(baseline,'original-java'),stdlib,path.join(baseline,'oracle-dependencies.jar')];
const shared=[local('Probe.kt'),local('CommentMutation.kt')];
await execute('genuine-selected-deserializer-jvm-build','java',[...jvm,'-classpath',originalDependencies.join(path.delimiter),'-d',local('original.jar'),local('original-SelectedInput.kt'),...shared,local('OriginalSupport.kt'),local('JvmEntry.kt')]);
const common=[prepared.commonSources[1],...preparedInput.commonSources,...sharedText,local('common-SelectedInput.kt'),...shared,local('CommonSupport.kt')];
await execute('common-selected-deserializer-jvm-build','java',[...jvm,'-classpath',[path.join(baseline,'portable.jar'),stdlib].join(path.delimiter),'-d',local('portable.jar'),...common,local('JvmEntry.kt')]);
async function observe(kind,deps){return JSON.parse(await execute(kind+'-observe','java',['-ea','-cp',[local(kind==='original'?'original.jar':'portable.jar'),...deps].join(path.delimiter),'org.jetbrains.kotlin.js.deserializerprobe.JvmEntryKt']));}
const original=await observe('original',originalDependencies),portable=await observe('common',[path.join(baseline,'portable.jar'),stdlib]);
await writeJson(local('original-jvm.json'),original);await writeJson(local('portable-jvm.json'),portable);assert.deepEqual(portable.records,original.records);
await mkdir(local('klib'));await mkdir(local('wasm'));
const wasm=[...java,'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler','-Xwasm-target=wasm-js','-language-version',flags.languageVersion,'-api-version',flags.apiVersion,...flags.compilerFlags,'-libraries',bootstrap.wasmJsStdlib];
const commonWasm=[...commonAst,...astReceipt.preparation.commonDependencies.map(pin=>pin.filename),path.join(baseline,'probe-support/JoinToWithBuffer.kt'),...common];
await execute('common-selected-deserializer-wasm-klib','java',[...wasm,'-Xmulti-platform','-Xcommon-sources='+commonWasm.join(','),'-ir-output-dir',local('klib'),'-ir-output-name','deserializer',...commonWasm,local('WasmEntry.kt')]);
await execute('common-selected-deserializer-wasm-module','java',[...wasm,'-Xir-produce-js','-Xinclude='+local('klib/deserializer.klib'),'-ir-output-dir',local('wasm'),'-ir-output-name','js-ast','-main','noCall','-Xwasm-enable-array-range-checks','-Xwasm-enable-asserts']);
const node=JSON.parse(await execute('common-selected-deserializer-node-observe',process.execPath,['--experimental-wasm-exnref','--input-type=module','-e','const m=await import(process.argv[1]);console.log(m.astProbeJson());',pathToFileURL(local('wasm/js-ast.mjs')).href]));
await writeJson(local('portable-wasm.json'),node);assert.deepEqual(node.records,original.records);
const browser=await observeAstInChromium(output,original.records);await writeFile(local('portable-chromium.json'),browser.raw,{flag:'wx',mode:0o600});
assert.notDeepEqual(original.rawFactory,portable.rawFactory);
assert.deepEqual(node.rawFactory,browser.observation.rawFactory);
for(let i=0;i<portable.rawFactory.length;i+=2) {assert.equal(original.rawFactory[i].endsWith('=true'),true);assert.equal(portable.rawFactory[i].endsWith('=false'),true);assert.equal(node.rawFactory[i],portable.rawFactory[i]);}
const outputs=[];async function collect(dir){for(const item of await readdir(local(dir),{withFileTypes:true})){const name=dir?dir+'/'+item.name:item.name;if(item.isDirectory())await collect(name);else{const b=await readRegular(local(name));outputs.push({path:name,bytes:b.length,sha256:sha256(b)});}}}await collect('');
const receipt={schemaVersion:1,kind:'genuine-selected-js-ast-deserializer-jvm-common-profile',source:lock.source,sourceLockSha256:sha256(lockBytes),checkToolSha256:sha256(await readRegular(fileURLToPath(import.meta.url))),
    buildFlagsSha256:sha256(flagsBytes),preparation:prepared.receipt,astEvidenceSourceLockSha256:astReceipt.sourceLockSha256,methodProjections:lock.methodProjections,commands,outputs,
    originalWrapper:'Only genuine selected method bodies/fields projected; stringTable supplied directly to exercise location algorithms. Actual AST classes and metadata compiled from sealed source originals. Full fragment/model methods are not compiled.',
    selectedCallerAudit:{sourceCount:sourceFiles.length,wholeReceiptSha256:sha256(wholeBytes),argsSha256:sha256(argsBytes),callers:selectedCallerAudit,globalEmptySingletonComparisonsFound:0,callerBytesVerifiedAgainstWholeReceipt:true},
    comparison:{observations:original.records.length,originalJvmEqualsCommonJvm:true,originalJvmEqualsNodeWasm:true,originalJvmEqualsOfflineChromium:true,skipped:0,recordsSha256:sha256(Buffer.from(JSON.stringify(original.records)))},
    rawFailures:{originalJvm:original.failures,commonJvm:portable.failures,nodeWasm:node.failures,offlineChromium:browser.observation.failures},
    rawFactoryBoundary:{originalJvm:original.rawFactory,commonJvm:portable.rawFactory,nodeWasm:node.rawFactory,offlineChromium:browser.observation.rawFactory,equal:false,
        contract:'Common canonical empty comment list differs from global stdlib emptyList identity; actual native Array.toList physical mutability differs across hosts. Shipping selected factory enforces original JVM mutation/alias contract. Raw values/messages retained.'},
    failureBoundary:'Index-out-of-bounds category retains raw JVM array/Wasm bounds classes and messages; unsupported mutation category exact, message identity not emulated.',
    browser:browser.receipt,javaFacadeIntroduced:false,fullDeserializerBuilt:false,fullCompilerBuilt:false,languageReadiness:false};
await writeJson(local('receipt.json'),receipt);console.log(JSON.stringify({output,comparison:receipt.comparison,selectedCallers:selectedCallerAudit.length,rawFactoryEqual:false}));

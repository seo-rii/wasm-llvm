#!/usr/bin/env node
import assert from 'node:assert/strict';
import { open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, readRegular, relativePath, sha256, writeJson } from '../../scripts/source.mjs';
import { verifyPreparation } from './build.mjs';
import { probeOutputs } from './probe-build.mjs';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url));
async function native(command,args,destination,cwd) {
  const handle=await open(destination,'wx',0o600);
  try { return await new Promise((resolve,reject)=>{ const child=spawn(command,args,{cwd,stdio:['ignore',handle.fd,'inherit']});child.once('error',reject);child.once('exit',(code,signal)=>code===0?resolve({command,args,exitCode:code}):reject(new Error(`${command} exited ${code??signal}`))); }); }
  finally {await handle.close();}
}
function resultLines(bytes) {
  const results=new Map();for(const line of bytes.toString('utf8').trimEnd().split('\n')) {
    const [id,status,value,...rest]=line.split('\t');if(rest.length||!id||results.has(id)||!['ok','error'].includes(status)||status==='ok'&&!/^(?:[a-f0-9]{2})*$/.test(value)||status==='error'&&!['InvalidProtocolBufferException','UninitializedMessageException'].includes(value))throw new Error('Invalid native codec probe output');
    results.set(id,{status,value});
  }return results;
}
export async function verifySerializationProbe(outputRoot,evidencePath,playwrightFrom=path.resolve(HERE,'../../../../../wasm-idle/package.json')) {
  outputRoot=path.resolve(outputRoot);evidencePath=path.resolve(evidencePath);
  const buildBytes=await readRegular(path.join(outputRoot,'receipt.json'));const build=JSON.parse(buildBytes);
  if(build.kind!=='portable-compiler-protobuf-differential-build'||build.readiness!==false||build.source.commit!=='4d78aae1e337cd40f69baa865aed950fe807a775')throw new Error('Invalid codec probe build receipt');
  await verifyPreparation(build.preparationDirectory);
  assert.deepEqual(await probeOutputs(outputRoot),build.outputs,'Compiled codec output changed');
  const bootstrap=await verifyBootstrap();
  assert.deepEqual(bootstrap.artifacts.map(({id,bytes,sha256,version})=>({id,bytes,sha256,version})),build.bootstrapArtifacts);
  assert.equal(build.referenceClassPath,path.join(outputRoot,'reference')+path.delimiter+bootstrap.artifacts.find(a=>a.id==='compiler').path);
  assert.equal(build.portableClassPath,path.join(outputRoot,'probe.jar')+path.delimiter+path.join(build.codecDirectory,'codec.jar')+path.delimiter+bootstrap.artifacts.find(a=>a.id==='stdlib-jvm').path);
  const codec=await readJson(path.join(build.codecDirectory,'receipt.json'));
  for(const record of codec.outputs){relativePath(record.path);const bytes=await readRegular(path.join(build.codecDirectory,record.path));assert.equal(bytes.length,record.bytes);assert.equal(sha256(bytes),record.sha256);}

  for(const record of build.inputs) {
    relativePath(record.path);const bytes=await readRegular(path.join(HERE,record.path));
    if(bytes.length!==record.bytes||sha256(bytes)!==record.sha256)throw new Error('Compiled probe input changed: '+record.path);
  }
  assert.equal(build.preparationSha256,sha256(await readRegular(path.join(build.preparationDirectory,'receipt.json'))));
  assert.equal(build.codecBuildSha256,sha256(await readRegular(path.join(build.codecDirectory,'receipt.json'))));
  const fixturesBytes=await readRegular(path.join(outputRoot,'fixtures','cases.json'));const fixtures=JSON.parse(fixturesBytes);
  const inputs=[];
  for(const record of fixtures.cases){relativePath(record.path);const bytes=await readRegular(path.join(outputRoot,'fixtures',record.path));assert.equal(bytes.length,record.bytes);assert.equal(sha256(bytes),record.sha256);inputs.push({record,bytes});}
  for(const reference of [true,false]) {
    const expected=fixtures.cases.map(r=>[r.id,reference?r.javaName:r.message,r.path,String(r.partial),String(r.extensions),String(r.recursionLimit)].join('\t')).join('\n')+'\n';
    assert.equal((await readRegular(path.join(outputRoot,'fixtures',reference?'reference.tsv':'portable.tsv'))).toString('utf8'),expected,'Fixture invocation identity changed');
  }
  assert.equal(fixtures.stdlib.sha256,build.stdlib.sha256);assert.equal(sha256(await readRegular(build.stdlib.path)),build.stdlib.sha256);
  const referenceCommand=await native('java',['-Xmx512m','-cp',build.referenceClassPath,'org.jetbrains.kotlin.protobuf.probe.Reference',path.join(outputRoot,'fixtures','reference.tsv')],path.join(outputRoot,'reference-results.tsv'),outputRoot);
  const portableCommand=await native('java',['-Xmx512m','-cp',build.portableClassPath,'org.jetbrains.kotlin.protobuf.probe.ProbeJvmKt',path.join(outputRoot,'fixtures','portable.tsv')],path.join(outputRoot,'portable-results.tsv'),outputRoot);
  const reference=resultLines(await readRegular(path.join(outputRoot,'reference-results.tsv')));const portable=resultLines(await readRegular(path.join(outputRoot,'portable-results.tsv')));
  assert.equal(reference.size,inputs.length);assert.equal(portable.size,inputs.length);
  const differences=[];for(const {record}of inputs){if(JSON.stringify(reference.get(record.id))!==JSON.stringify(portable.get(record.id)))differences.push({id:record.id,reference:reference.get(record.id),portable:portable.get(record.id)});}
  if(differences.length){await writeJson(path.join(outputRoot,'native-differences.json'),differences);throw new Error(`Original/portable Java codec differs in ${differences.length} cases; inspect native-differences.json`);}
  for(const id of ['presence-absent','presence-explicit-default','sint64--9223372036854775808','fixed64--9223372036854775808','utf8-invalid-preserved']){
    const fixture=inputs.find(({record})=>record.id===id);assert(fixture);assert.deepEqual(reference.get(id),{status:'ok',value:fixture.bytes.toString('hex')},'Independent wire expectation: '+id);
  }
  const {chromium}=createRequire(playwrightFrom)('playwright-core');const browser=await chromium.launch({headless:true});
  const assets=new Map();const requestAssets=[];const external=[];const offlineRequests=[];
  for(const record of build.outputs.filter(record=>record.path.startsWith('browser/') && /\.(mjs|wasm)$/.test(record.path))) { const name=record.path.slice('browser/'.length); assets.set(name,await readRegular(path.join(outputRoot,record.path))); }
  const origin='https://kotlin-compiler-codec.invalid';
  const workerSource=`import {codecDecode,codecVerifyGeneratedApi} from '${origin}/assets/codec-probe.mjs';self.onmessage=({data})=>{try{const result=codecDecode(data.message,new Uint8Array(data.bytes),data.partial,data.extensions,data.recursionLimit);self.postMessage({id:data.id,status:'ok',bytes:result.buffer},[result.buffer]);}catch(error){const text=String(error);const kind=text.includes('InvalidProtocolBufferException')?'InvalidProtocolBufferException':text.includes('UninitializedMessageException')?'UninitializedMessageException':null;self.postMessage({id:data.id,status:kind?'error':'fatal',value:kind??text});}};self.postMessage({kind:'ready',api:codecVerifyGeneratedApi()});`;
  const browserResults=[];let version;
  try {
    version=browser.version();const context=await browser.newContext();
    await context.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin===origin&&url.pathname==='/'){await route.fulfill({contentType:'text/html',body:'<!doctype html><title>Official compiler codec</title>'});return;}
      const name=url.pathname.startsWith('/assets/')?url.pathname.slice(8):null;
      if(url.origin===origin&&assets.has(name)){requestAssets.push(name);await route.fulfill({contentType:name.endsWith('.wasm')?'application/wasm':'text/javascript',body:assets.get(name)});return;}external.push(url.href);await route.abort();});
    const page=await context.newPage();await page.goto(origin);
    await page.evaluate(async source=>{window.codecUrl=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));window.codecWorker=new Worker(window.codecUrl,{type:'module'});await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Codec Worker init deadline')),30000);window.codecWorker.onerror=e=>{clearTimeout(timer);reject(new Error(e.message));};window.codecWorker.onmessage=({data})=>{clearTimeout(timer);data.kind==='ready'&&data.api?resolve():reject(new Error('Codec API guard failed'));};});},workerSource);
    await context.setOffline(true);context.on('request',request=>offlineRequests.push(request.url()));
    for(const {record,bytes}of inputs){
      const observed=await page.evaluate(async input=>{const data={...input,bytes:Uint8Array.from(input.bytes).buffer};return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Codec request deadline')),30000);window.codecWorker.onmessage=({data:result})=>{clearTimeout(timer);if(result.status==='fatal')reject(new Error(result.value));else resolve(result.status==='ok'?{id:result.id,status:result.status,bytes:Array.from(new Uint8Array(result.bytes))}:result);};window.codecWorker.postMessage(data,[data.bytes]);});},{id:record.id,message:record.message,bytes:Array.from(bytes),partial:record.partial,extensions:record.extensions,recursionLimit:record.recursionLimit});
      assert.equal(observed.id,record.id);const result=observed.status==='ok'?{status:'ok',value:Buffer.from(observed.bytes).toString('hex')}:{status:observed.status,value:observed.value};
      assert.deepEqual(result,reference.get(record.id),'Browser codec differs for '+record.id);
      browserResults.push({id:record.id,status:result.status,sourceBytes:record.bytes,origin:record.origin,outputSha256:result.status==='ok'?sha256(Buffer.from(result.value,'hex')):null,originalJavaEquivalent:true,portableJvmEquivalent:true});
    }
    await page.evaluate(()=>{window.codecWorker.terminate();URL.revokeObjectURL(window.codecUrl);});
    assert.deepEqual(external,[]);assert.deepEqual(offlineRequests,[]);
  } finally {await browser.close();}
  const evidence={schemaVersion:1,kind:'official-compiler-protobuf-jvm-wasm-differential',gate:'G2-serialization-microprobe',status:'passed',source:build.source,
    buildReceiptSha256:sha256(buildBytes),fixturesSha256:sha256(fixturesBytes),verificationToolSha256:sha256(await readRegular(fileURLToPath(import.meta.url))),stdlib:build.stdlib,
    referenceCommand,portableCommand,environment:{os:os.platform(),architecture:os.arch(),browser:'Chromium',browserVersion:version,headless:true,flags:[]},
    corpus:{required:inputs.length,passed:inputs.length,failed:0,skipped:0,notRun:0},counts:fixtures.counts,cases:browserResults,
    assets:[...assets].map(([name,bytes])=>({path:name,bytes:bytes.length,sha256:sha256(bytes)})),network:{offlineAfterInitialization:true,requestsDuringDecode:offlineRequests,externalRequests:external,preparedAssets:requestAssets},
    fullCompilerBuilt:false,languageReadiness:false,limitations:['Only protobuf metadata/IR decoding and reencoding is established. FIR resolution, linking/inlining, backend and browser Kotlin compilation remain unbuilt.','Original selected generated Java decoders use the verified bootstrap relocated protobuf runtime whose source commit is unknown.','Only the listed schema/stream cases and bounded main/inlinable IR table selections were compared; whole compiler semantic conformance is not established.']};
  await writeJson(evidencePath,evidence);console.log(JSON.stringify({evidence:evidencePath,status:'passed',cases:inputs.length,browser:version}));return evidence;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2).filter(a=>a!=='--');const opts={};for(let i=0;i<args.length;i+=2){if(!['--output','--evidence','--playwright-from'].includes(args[i])||!args[i+1]||opts[args[i]])throw new Error('Invalid verify arguments');opts[args[i]]=args[i+1];}
 if(!opts['--output']||!opts['--evidence'])throw new Error('Usage: verify.mjs --output BUILT_PROBE --evidence NEW_FILE [--playwright-from PACKAGE_JSON]');await verifySerializationProbe(opts['--output'],opts['--evidence'],opts['--playwright-from']);
}

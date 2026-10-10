#!/usr/bin/env node
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { assertNoSymlink, readJson, readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { buildSerialization, verifyPreparation } from './build.mjs';
import { prepareSerialization, run } from './prepare.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
export async function probeOutputs(outputRoot) {
 const records=[];
 async function visit(directory,depth=0) {
  if(depth>12||records.length>5000)throw new Error('Codec artifact tree exceeded limit');
  await assertNoSymlink(path.join(outputRoot,directory));
  for(const entry of (await readdir(path.join(outputRoot,directory),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'en'))) {
   const name=path.posix.join(directory,entry.name);if(entry.isSymbolicLink())throw new Error('Codec artifact symlink');
   if(entry.isDirectory())await visit(name,depth+1);else if(entry.isFile()){const bytes=await readRegular(path.join(outputRoot,name));records.push({path:name,bytes:bytes.length,sha256:sha256(bytes)});}else throw new Error('Nonregular codec artifact');
  }
 }
 for(const name of ['reference','browser','probe-klib'])await visit(name);
 const bytes=await readRegular(path.join(outputRoot,'probe.jar'));records.push({path:'probe.jar',bytes:bytes.length,sha256:sha256(bytes)});
 return records.sort((a,b)=>a.path.localeCompare(b.path,'en'));
}
export async function probeBuild(sourceRoot, outputRoot, stdlib, stdlibSha256, reuseCodecRoot = null) {
  outputRoot=path.resolve(outputRoot);sourceRoot=path.resolve(sourceRoot);stdlib=path.resolve(stdlib);
  await assertNoSymlink(outputRoot,{allowMissing:true});await mkdir(outputRoot,{recursive:false,mode:0o700});
  let preparation, codec;
  if(reuseCodecRoot) {
    reuseCodecRoot=path.resolve(reuseCodecRoot);
    const verified=await verifyPreparation(path.join(reuseCodecRoot,'prepared'));
    preparation={outputRoot:verified.directory};
    codec={outputRoot:path.join(reuseCodecRoot,'codec')};
    const receipt=await readJson(path.join(codec.outputRoot,'receipt.json'));
    if(receipt.kind!=='portable-compiler-protobuf-build'||receipt.stage!=='all'||receipt.preparationSha256!==verified.receiptSha256||receipt.readiness!==false)throw new Error('Invalid reused codec build');
    for(const record of receipt.outputs){const bytes=await readRegular(path.join(codec.outputRoot,record.path));if(bytes.length!==record.bytes||sha256(bytes)!==record.sha256)throw new Error('Reused codec output changed');}
    const lock=await readJson(path.join(HERE,'sources.lock.json'));
    for(const record of lock.files){const bytes=await readRegular(path.join(sourceRoot,record.path));if(bytes.length!==record.bytes||sha256(bytes)!==record.sha256)throw new Error('Original reference source changed');}
  } else {
    preparation=await prepareSerialization(sourceRoot,path.join(outputRoot,'prepared'));
    codec=await buildSerialization(preparation.outputRoot,path.join(outputRoot,'codec'));
  }
  const b=await verifyBootstrap(); const stdJvm=b.artifacts.find(a=>a.id==='stdlib-jvm').path;
  const commands=[];
  const fixtureDir=path.join(outputRoot,'fixtures');
  commands.push(await run('python3',[path.join(HERE,'fixtures.py'),'--prepared-dir',preparation.outputRoot,'--stdlib',stdlib,'--stdlib-sha256',stdlibSha256,'--output',fixtureDir],outputRoot));
  const lock=await readJson(path.join(HERE,'sources.lock.json'));
  const reference=path.join(outputRoot,'reference');await mkdir(reference,{mode:0o700});
  // Every Java reference file was raw-byte/Git-blob checked by preparation.
  commands.push(await run('javac',['-J-Xmx512m','-cp',b.artifacts.find(a=>a.id==='compiler').path,'-d',reference,...lock.referenceJava.map(name=>path.join(sourceRoot,name)),path.join(HERE,'Reference.java')],outputRoot));
  const referenceTsv=path.join(fixtureDir,'reference.tsv');
  const probeJvm=path.join(outputRoot,'probe.jar'); const common=path.join(HERE,'Probe.kt');
  commands.push(await run('java',['-Xmx1g','-cp',b.classPath,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-classpath',stdJvm+path.delimiter+path.join(codec.outputRoot,'codec.jar'),'-Xmulti-platform','-Xcommon-sources='+common,'-d',probeJvm,common,path.join(HERE,'ProbeJvm.kt')],outputRoot));
  const probeKlib=path.join(outputRoot,'probe-klib');await mkdir(probeKlib,{mode:0o700});
  const libraries=[b.wasmJsStdlib,path.join(codec.outputRoot,'wasm','compiler-protobuf.klib')].join(path.delimiter);
  commands.push(await run('java',['-Xmx1g','-cp',b.classPath,'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler','-Xwasm-target=wasm-js','-libraries',libraries,'-Xmulti-platform','-Xcommon-sources='+common,'-ir-output-dir',probeKlib,'-ir-output-name','codec-probe',common,path.join(HERE,'ProbeWasm.kt')],outputRoot));
  const browser=path.join(outputRoot,'browser');await mkdir(browser,{mode:0o700});
  commands.push(await run('java',['-Xmx1g','-cp',b.classPath,'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler','-Xwasm-target=wasm-js','-libraries',libraries,'-Xir-produce-js','-Xinclude='+path.join(probeKlib,'codec-probe.klib'),'-ir-output-dir',browser,'-ir-output-name','codec-probe'],outputRoot));
  const inputs=[];for(const name of ['Probe.kt','ProbeJvm.kt','ProbeWasm.kt','Reference.java','fixtures.py','probe-build.mjs']) {const bytes=await readRegular(path.join(HERE,name));inputs.push({path:name,bytes:bytes.length,sha256:sha256(bytes)});}
  const receipt={schemaVersion:1,kind:'portable-compiler-protobuf-differential-build',source:lock.source,
    preparationDirectory:preparation.outputRoot,codecDirectory:codec.outputRoot,sourceCompilationReused:reuseCodecRoot!==null,
    preparationSha256:sha256(await readRegular(path.join(preparation.outputRoot,'receipt.json'))),codecBuildSha256:sha256(await readRegular(path.join(codec.outputRoot,'receipt.json'))),
    stdlib:{path:stdlib,bytes:(await readRegular(stdlib)).length,sha256:stdlibSha256},inputs,commands,
    referenceClassPath:reference+path.delimiter+b.artifacts.find(a=>a.id==='compiler').path,
    portableClassPath:probeJvm+path.delimiter+path.join(codec.outputRoot,'codec.jar')+path.delimiter+stdJvm,
    browser:{module:'browser/codec-probe.mjs',wasm:'browser/codec-probe.wasm'},
    outputs:await probeOutputs(outputRoot),bootstrapArtifacts:b.artifacts.map(({id,bytes,sha256,version})=>({id,bytes,sha256,version})),
    actualCompilerSourceBuilt:false,readiness:false};
  await writeJson(path.join(outputRoot,'receipt.json'),receipt);return {outputRoot,receipt};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const args=process.argv.slice(2).filter(a=>a!=='--');const opts={};
 for(let i=0;i<args.length;i+=2){if(!['--source-dir','--output','--stdlib','--stdlib-sha256','--reuse-codec'].includes(args[i])||!args[i+1]||opts[args[i]])throw new Error('Invalid probe build arguments');opts[args[i]]=args[i+1];}
 if(!opts['--source-dir']||!opts['--output']||!opts['--stdlib']||!opts['--stdlib-sha256'])throw new Error('Usage: probe-build.mjs --source-dir PINNED_SOURCES --output NEW_DIRECTORY --stdlib REAL_KLIB --stdlib-sha256 SHA256');
 const r=await probeBuild(opts['--source-dir'],opts['--output'],opts['--stdlib'],opts['--stdlib-sha256'],opts['--reuse-codec']);console.log(JSON.stringify({outputRoot:r.outputRoot}));
}

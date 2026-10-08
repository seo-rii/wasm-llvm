#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBootstrap, defaultCache } from '../../build/bootstrap.mjs';
import { assertNoSymlink, readJson, readRegular, relativePath, sha256, writeJson } from '../../scripts/source.mjs';
import { RUNTIME_FILES, run } from './prepare.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
export async function verifyPreparation(directory) {
  directory = path.resolve(directory); await assertNoSymlink(directory);
  const receiptBytes = await readRegular(path.join(directory, 'receipt.json'));
  const receipt = JSON.parse(receiptBytes);
  if (receipt.kind !== 'official-schema-portable-generation' || receipt.source.commit !== '4d78aae1e337cd40f69baa865aed950fe807a775' ||
    receipt.sourceLockSha256 !== sha256(await readRegular(path.join(HERE, 'sources.lock.json'))) ||
    receipt.generatorSha256 !== sha256(await readRegular(path.join(HERE, 'generate.py'))) ||
    receipt.generatorSha256 !== sha256(await readRegular(path.join(directory, 'generate.py'))) ||
    receipt.descriptorSha256 !== sha256(await readRegular(path.join(directory, 'metadata-ir.pb'))) ||
    receipt.readiness !== false || !Array.isArray(receipt.files) || !Array.isArray(receipt.runtime)) throw new Error('Stale or invalid serialization preparation receipt');
  const generation = await readJson(path.join(directory, 'generated', 'generation.json'));
  if (generation.descriptorSha256 !== receipt.descriptorSha256 || JSON.stringify(generation.files) !== JSON.stringify(receipt.files.map(({absolutePath,...rest})=>rest))) throw new Error('Generation index identity mismatch');
  if (JSON.stringify(generation.catalog) !== JSON.stringify(receipt.catalog) || receipt.catalog.path !== 'catalog.json') throw new Error('Generation catalog identity mismatch');
  const catalogBytes = await readRegular(path.join(directory, 'generated', 'catalog.json'));
  if (catalogBytes.length !== receipt.catalog.bytes || sha256(catalogBytes) !== receipt.catalog.sha256) throw new Error('Generated schema catalog changed');
  const sourceFiles = [];
  for (const record of receipt.runtime) {
    if (!RUNTIME_FILES.includes(record.path) || record.absolutePath !== path.join(directory, 'runtime', record.path)) throw new Error('Invalid runtime source path');
    const bytes = await readRegular(record.absolutePath);
    if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256 || sha256(await readRegular(path.join(HERE, record.path))) !== record.sha256) throw new Error('Runtime source changed after preparation');
    sourceFiles.push(record.absolutePath);
  }
  if (receipt.runtime.length !== RUNTIME_FILES.length || new Set(receipt.runtime.map(x=>x.path)).size !== RUNTIME_FILES.length) throw new Error('Incomplete runtime source set');
  for (const record of receipt.files) {
    relativePath(record.path); const expected = path.join(directory, 'generated', record.path);
    if (record.absolutePath !== expected || !record.path.endsWith('.kt')) throw new Error('Invalid generated source path');
    const bytes = await readRegular(expected);
    if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) throw new Error('Generated source changed after preparation');
    sourceFiles.push(expected);
  }
  return { directory, receipt, receiptSha256: sha256(receiptBytes), sourceFiles };
}
export async function buildSerialization(preparedDirectory, outputRoot, stage = 'all', bootstrapCache = defaultCache) {
  if (!['jvm','wasm','all'].includes(stage)) throw new Error('Unsupported serialization build stage');
  const prepared = await verifyPreparation(preparedDirectory);
  const bootstrap = await verifyBootstrap(bootstrapCache);
  outputRoot = path.resolve(outputRoot); await assertNoSymlink(outputRoot, { allowMissing: true }); await mkdir(outputRoot, { recursive: false, mode: 0o700 });
  const common = '-Xcommon-sources=' + prepared.sourceFiles.join(',');
  const commands=[]; const outputs=[];
  if (stage !== 'wasm') {
    const jar=path.join(outputRoot,'codec.jar');
    commands.push(await run('java',['-Xmx1g','-cp',bootstrap.classPath,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-classpath',bootstrap.artifacts.find(a=>a.id==='stdlib-jvm').path,'-Xmulti-platform',common,'-d',jar,...prepared.sourceFiles],outputRoot));
    await verifyPreparation(preparedDirectory);
    const bytes=await readRegular(jar);outputs.push({kind:'jvm-reference-host-codec',path:'codec.jar',bytes:bytes.length,sha256:sha256(bytes)});
  }
  if (stage !== 'jvm') {
    const directory=path.join(outputRoot,'wasm');await mkdir(directory,{mode:0o700});
    commands.push(await run('java',['-Xmx1g','-cp',bootstrap.classPath,'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler','-Xwasm-target=wasm-js','-libraries',bootstrap.wasmJsStdlib,'-Xmulti-platform',common,'-ir-output-dir',directory,'-ir-output-name','compiler-protobuf',...prepared.sourceFiles],outputRoot));
    await verifyPreparation(preparedDirectory);
    const bytes=await readRegular(path.join(directory,'compiler-protobuf.klib'));outputs.push({kind:'portable-compiler-dependency-klib',path:'wasm/compiler-protobuf.klib',bytes:bytes.length,sha256:sha256(bytes)});
  }
  const receipt={schemaVersion:1,kind:'portable-compiler-protobuf-build',source:prepared.receipt.source,preparationSha256:prepared.receiptSha256,
    buildToolSha256:sha256(await readRegular(fileURLToPath(import.meta.url))),bootstrap:{version:bootstrap.lock.version,sourceCommit:null,artifacts:bootstrap.artifacts.map(({id,bytes,sha256,version})=>({id,bytes,sha256,version}))},
    messages:prepared.receipt.messages,fields:prepared.receipt.fields,extensions:prepared.receipt.extensions,stage,commands,outputs,
    fullCompilerBuilt:false,browserCompiler:'not-built',readiness:false};
  await writeJson(path.join(outputRoot,'receipt.json'),receipt);return {outputRoot,receipt};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2).filter(x=>x!=='--'); const opts={};
  for(let i=0;i<args.length;i+=2) { if(!['--prepared-dir','--output','--stage','--bootstrap-cache'].includes(args[i]) || !args[i+1] || opts[args[i]]) throw new Error('Invalid serialization build arguments');opts[args[i]]=args[i+1]; }
  if(!opts['--prepared-dir']||!opts['--output']) throw new Error('Usage: build.mjs --prepared-dir PREPARED --output NEW_DIRECTORY [--stage jvm|wasm|all]');
  const result=await buildSerialization(opts['--prepared-dir'],opts['--output'],opts['--stage']??'all',opts['--bootstrap-cache']??defaultCache);
  console.log(JSON.stringify({outputRoot:result.outputRoot,outputs:result.receipt.outputs}));
}

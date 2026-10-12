import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap } from '../../build/bootstrap.mjs';
import { readRegular, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
import { prepareLoweringPhaseFactories } from './prepare.mjs';
import { TARGETS } from './transform.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../..'),execute=promisify(execFile),output=path.resolve(process.argv[2]);
assert(output.startsWith(path.join(REPO,'out')+path.sep));await mkdir(output,{mode:0o700});
const sourceRoot=path.join(REPO,'out/kotlin-compiler-port/sources'),prepared=await prepareLoweringPhaseFactories({sourceRoot,outputRoot:path.join(output,'prepared')});
const bootstrap=await verifyBootstrap(),flags=JSON.parse(await readRegular(path.join(HERE,'../build-flags.json'))),compiler=bootstrap.artifacts.find(x=>x.id==='compiler').path;
const inputs=[],commands=[],adapters=[],observed={};
async function store(name,bytes){const f=path.join(output,name);await mkdir(path.dirname(f),{recursive:true,mode:0o700});await writeFile(f,bytes,{flag:'wx',mode:0o600});return f;}
async function frozen(name){const f=path.join(HERE,name),b=await readRegular(f);inputs.push({filename:f,bytes:b.length,sha256:sha256(b)});return b;}
const closure=JSON.parse(await readRegular(path.join(HERE,'../closure.lock.json')));
async function genuine(name){const pin=closure.files.find(row=>row.path===name);assert(pin);const b=verifyFile(await readRegular(path.join(sourceRoot,name)),pin);inputs.push({filename:path.join(sourceRoot,name),bytes:b.length,sha256:sha256(b)});return b;}
function isolate(bytes){return bytes.toString()
 .replaceAll('org.jetbrains.kotlin.backend.common.phaser','org.jetbrains.kotlin.portable.phaseproof.factories')
 .replaceAll('org.jetbrains.kotlin.backend.common.FileLoweringPass','org.jetbrains.kotlin.portable.phaseproof.contracts.FileLoweringPass')
 .replaceAll('org.jetbrains.kotlin.backend.common.ModuleLoweringPass','org.jetbrains.kotlin.portable.phaseproof.contracts.ModuleLoweringPass')
 .replaceAll('org.jetbrains.kotlin.backend.common.LoweringContext','org.jetbrains.kotlin.portable.phaseproof.boundary.ProbeContext')
 .replaceAll('LoweringContext','ProbeContext')
 .replaceAll('org.jetbrains.kotlin.config.phaser','org.jetbrains.kotlin.portable.phaseproof.phaser')
 .replaceAll('org.jetbrains.kotlin.config.LoggingContext','org.jetbrains.kotlin.portable.phaseproof.boundary.ProbeContext')
 .replaceAll('LoggingContext','ProbeContext')
 .replaceAll('org.jetbrains.kotlin.ir.IrElement','org.jetbrains.kotlin.portable.phaseproof.boundary.ProbeElement')
 .replaceAll('org.jetbrains.kotlin.ir.declarations.IrFile','org.jetbrains.kotlin.portable.phaseproof.boundary.ProbeFile')
 .replaceAll('org.jetbrains.kotlin.ir.declarations.IrModuleFragment','org.jetbrains.kotlin.portable.phaseproof.boundary.ProbeModule')
 .replaceAll('IrElement','ProbeElement').replaceAll('IrModuleFragment','ProbeModule').replaceAll('IrFile','ProbeFile')
 .replaceAll('kotlin.system.measureTimeMillis','org.jetbrains.kotlin.portable.phaseproof.boundary.measureTimeMillis');}
const primary=TARGETS[0], original=await genuine(primary),common=await readRegular(prepared.commonSources[0]);
const boundary=await store('ExecutionBoundary.kt',await frozen('ExecutionBoundary.kt')),probe=await store('ExecutionProbe.kt',await frozen('ExecutionProbe.kt'));
const asserts=await store('CompilerAssertions.kt',await frozen('../assertions/CompilerAssertions.kt'));
const phaseSources=[];
for(const name of ['CompilerPhase.kt','PhaseConfig.kt','PhaseSet.kt']){
 const b=await genuine('compiler/config/src/org/jetbrains/kotlin/config/phaser/'+name),text=isolate(b).replace(/^package[^\n]+/m,m=>m+'\nimport org.jetbrains.kotlin.portable.assertions.compilerAssert as assert');
 phaseSources.push(await store('genuine/'+name,Buffer.from(text)));adapters.push({source:name,originalSha256:sha256(b),kind:'complete-genuine-phase-body-namespaces-and-clock/assert-import-boundaries'});
}
const lower=await genuine('compiler/ir/backend.common/src/org/jetbrains/kotlin/backend/common/Lower.kt'),lowerText=lower.toString();
const begin=lowerText.indexOf('interface ModuleLoweringPass {'),end=lowerText.indexOf('\ninterface ClassLoweringPass',begin);assert(begin>0&&end>begin);
const contracts=lowerText.slice(begin,end).replaceAll('IrModuleFragment','ProbeModule').replaceAll('IrFile','ProbeFile').replaceAll('CompilationException','ProbeCompilationException').replaceAll('KotlinExceptionWithAttachments','ProbeAttachmentException').replace('wrapWithProbeCompilationException','wrapWithCompilationException');
const contractFile=await store('genuine/LoweringContracts.kt',Buffer.from('package org.jetbrains.kotlin.portable.phaseproof.contracts\nimport org.jetbrains.kotlin.portable.phaseproof.boundary.*\n'+contracts));
adapters.push({source:'Lower.kt',kind:'two-complete-genuine-pass-interface-declaration-projections',byteStart:Buffer.byteLength(lowerText.slice(0,begin)),byteEnd:Buffer.byteLength(lowerText.slice(0,end)),originalSha256:sha256(lower),originalProjectedBodySha256:sha256(Buffer.from(lowerText.slice(begin,end)))});
const ascii=await genuine('core/util.runtime/src/org/jetbrains/kotlin/utils/capitalizeDecapitalize.kt'),asciiText=ascii.toString(),asciiStart=asciiText.indexOf('fun String.toLowerCaseAsciiOnly()'),asciiEnd=asciiText.indexOf('\nfun String.toUpperCaseAsciiOnly()',asciiStart);
const asciiFile=await store('genuine/Ascii.kt',Buffer.from('package org.jetbrains.kotlin.util.capitalizeDecapitalize\n'+asciiText.slice(asciiStart,asciiEnd)));
const actions=await store('ActionBoundary.kt',Buffer.from(`package org.jetbrains.kotlin.portable.phaseproof.factories
import org.jetbrains.kotlin.portable.phaseproof.boundary.*
import org.jetbrains.kotlin.portable.phaseproof.phaser.*
val DEFAULT_IR_ACTIONS: Set<Action<ProbeElement, ProbeContext>> = setOf(
    { state, data, context -> context.events.add("action-one:" + state.beforeOrAfter + ":" + state.phase.name + ":" + state.phaseCount + ":" + data.id) },
    { state, data, context -> context.events.add("action-two:" + state.beforeOrAfter + ":" + data.id) }
)
`));
const helper=await store('LoweringPassFactory.kt',Buffer.from(isolate(await frozen('LoweringPassFactory.kt'))));
for(const name of ['execution-check.mjs','prepare.mjs','transform.mjs','recipes.json','call-sites.json','sources.lock.json'])await frozen(name);
const jvm=['-Xmx768m','-cp',bootstrap.classPath,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-jvm-target','17','-language-version',flags.languageVersion,'-api-version',flags.apiVersion,...flags.compilerFlags,'-Xlambdas=class','-classpath',bootstrap.classPath];
async function run(phase,binary,args){console.log('phase: '+phase);try{const r=await execute(binary,args,{cwd:output,timeout:240000,maxBuffer:16*1024*1024});commands.push({phase,command:[binary,...args],exitCode:0});await store(phase+'.stdout',Buffer.from(r.stdout));await store(phase+'.stderr',Buffer.from(r.stderr));return r.stdout;}catch(e){await store(phase+'.stderr',Buffer.from(e.stderr??''));await writeJson(path.join(output,'failure.json'),{phase,exitCode:e.code,stderr:String(e.stderr??'').slice(-18000),commands});throw e;}}
const variants={};
for(const [label,source]of [['original',original],['common',common]]){
 const target=await store(label+'/PhaseFactories.kt',Buffer.from(isolate(source)));
 const registry=await store(label+'/Registration.kt',Buffer.from(`package org.jetbrains.kotlin.portable.phaseproof.probe
import org.jetbrains.kotlin.portable.phaseproof.boundary.*
${label==='common'?'import org.jetbrains.kotlin.portable.phaser.loweringFactory':''}
`+[['File','FileProbe'],['Module','ModuleProbe'],['Generic','GenericFileProbe<ProbeContext>'],['Failure','FailedFileProbe']].map(([key,type])=>`fun registered${key}(factory: (ProbeContext) -> ${type}): (ProbeContext) -> ${type} = ${label==='common'?`loweringFactory(${type.split('<')[0]}::class, factory)`:'factory'}`).join('\n')+'\n'));
 const entry=await store(label+'/JvmEntry.kt',Buffer.from('package org.jetbrains.kotlin.portable.phaseproof.probe\nfun main() = print(executionSnapshot())\n'));
 const sources=[target,registry,boundary,probe,asserts,contractFile,asciiFile,actions,...phaseSources,...(label==='common'?[helper]:[])];variants[label]=sources;
 await run(label+'-full-factory-and-genuine-phase-config-pass-declarations-jvm-build','java',[...jvm,'-d',path.join(output,label+'.jar'),...sources,entry]);
 observed[label]=await run(label+'-creation-execution-action-disabled-jvm-observe','java',['-ea','-cp',[path.join(output,label+'.jar'),bootstrap.classPath].join(path.delimiter),'org.jetbrains.kotlin.portable.phaseproof.probe.JvmEntryKt']);
}
assert.equal(observed.original,observed.common);
await mkdir(path.join(output,'klib'));await mkdir(path.join(output,'wasm'));
const wasmEntry=await store('WasmEntry.kt',Buffer.from('package org.jetbrains.kotlin.portable.phaseproof.probe\nimport kotlin.js.JsExport\n@JsExport fun phaseProbe(): String = executionSnapshot()\n'));
const wasm=['-Xmx768m','-cp',bootstrap.classPath,'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler','-Xwasm-target=wasm-js','-language-version',flags.languageVersion,'-api-version',flags.apiVersion,...flags.compilerFlags,'-libraries',bootstrap.wasmJsStdlib];
await run('complete-common-factory-phase-config-pass-wasm-klib-build','java',[...wasm,'-Xmulti-platform','-Xcommon-sources='+variants.common.join(','),'-ir-output-dir',path.join(output,'klib'),'-ir-output-name','phase-factories',...variants.common,wasmEntry]);
await run('complete-common-factory-wasm-module-build','java',[...wasm,'-Xir-produce-js','-Xinclude='+path.join(output,'klib/phase-factories.klib'),'-ir-output-dir',path.join(output,'wasm'),'-ir-output-name','phase-factories','-main','noCall','-Xwasm-enable-asserts']);
observed.wasm=await run('complete-common-factory-node-wasm-observe',process.execPath,['--experimental-wasm-exnref','--input-type=module','-e','const m=await import(process.argv[1]);process.stdout.write(m.phaseProbe());',pathToFileURL(path.join(output,'wasm/phase-factories.mjs')).href]);
assert.equal(observed.original,observed.wasm);
const artifacts=[];async function inventory(root){for(const e of await readdir(root,{withFileTypes:true})){const f=path.join(root,e.name);if(e.isDirectory())await inventory(f);else{const b=await readRegular(f,64*1024*1024);artifacts.push({path:path.relative(output,f),bytes:b.length,sha256:sha256(b)});}}}await inventory(output);
for(const p of inputs){const b=await readRegular(p.filename);assert.equal(b.length,p.bytes);assert.equal(sha256(b),p.sha256);}
await writeJson(path.join(output,'receipt.json'),{schemaVersion:1,kind:'full-genuine-phase-factory-execution-jvm-wasm-proof',result:'pass',inputs,artifacts,adapters,commands,
 records:observed.original.trimEnd().split('\n').length,rawSha256:sha256(Buffer.from(observed.original)),fullPhaseFactorySourceCompiled:true,fullCompilerPhaseAndPhaseConfigBodiesCompiled:true,
 typedBoundary:'All proof namespaces are outside compiler packages. Context/data/default-action callbacks/exceptions and deterministic clock are explicit typed fixtures; two full pass interfaces and ASCII method are genuine declaration projections.',
 scope:'Constructor deferral and per-invocation creation; full file/module phase bodies; generic raw class names; null filtering/order; duplicate-name case-insensitive disabling; pre/post action data/state ordering; full genuine CompilerPhase state/lifecycle; disabled passthrough; failure state and unregistered metadata rejection without factory execution.',
 fullIrLoweringExecuted:false,browserExecuted:false,fullCompilerBuilt:false,languageReadiness:false});
console.log(JSON.stringify({result:'pass',output,records:observed.original.trimEnd().split('\n').length,rawSha256:sha256(Buffer.from(observed.original))}));

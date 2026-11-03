import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cases, diagnosticCases } from './symbol-alias-fixtures.mjs';
import { inspectAliasObject, verifyAliasDefinitions } from './symbol-alias-inspect.mjs';

const identity=bytes=>({bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
const content=value=>({bytes:value?.bytes,sha256:value?.sha256});
const contents=values=>Object.fromEntries(Object.entries(values).map(([name,value])=>[name,content(value)]));
const equalContent=(actual,expected,label)=>assert.deepEqual(content(actual),content(expected),label);
const directions=['gcc-gcc','gcc-clang','clang-gcc','clang-clang'];
const matrix=cases.flatMap(fixture=>directions.filter(direction=>fixture.interop||direction==='gcc-gcc'||direction==='clang-clang').filter(direction=>fixture.clang!==false||!direction.includes('clang')).map(direction=>({fixture,direction,id:fixture.id+'-'+direction})));
const diagnosticMatrix=diagnosticCases.flatMap(fixture=>(fixture.clang===false?['gcc']:['gcc','clang']).map(family=>({fixture,family,id:fixture.id+'-'+family})));
const linkIds=['function','data'].flatMap(kind=>['c','cpp'].flatMap(language=>['0','2'].flatMap(optimization=>['gcc','clang'].map(family=>`${kind}-${language}-o${optimization}-${family}`))));

export function verifySymbolAliasQualificationOptions(patches,options){
  if(!patches.some(patch=>patch.path==='patches/0017-symbol-aliases.patch'))return;
  for(const name of ['symbolAliasQualification','nativeLinker','libstdcxx'])assert(options[name],'Symbol aliases require '+name);
}
function command(result,tool,status=0){assert.equal(result.command,tool);assert.equal(result.status,status,result.stderr);assert.equal(result.signal,null);assert(!result.error);}
function compilerProfile(result,request,family,tools,status){
  command(result,tools[family==='gcc'&&request.language==='cpp'?'gccCpp':family].path,status);
  assert.deepEqual(result.argv.filter(arg=>/^-O/.test(arg)),['-O'+request.optimization]);
  assert.deepEqual(result.argv.filter(arg=>arg.startsWith('-std=')),['-std='+request.standard]);
  assert.deepEqual(result.argv.filter(arg=>/^-m(?:no-)?simd128$/.test(arg)),['-mno-simd128']);
  assert(!result.argv.includes('-fsyntax-only'),'Alias diagnostics must reach code generation');
  if(family==='clang')assert(result.argv.includes('-c'));
  assert(result.argv.includes('-Werror=attributes'));
  if(request.language==='cpp')assert(result.argv.includes('-fno-exceptions')&&result.argv.includes('-fno-rtti'));
}

export function verifySymbolAliasQualification(report,expected){
  assert.equal(report.kind,'gcc-wasi-native-symbol-alias-qualification');assert.equal(report.status,'passed');assert.equal(report.inputsUnchanged,true);
  assert.deepEqual(report.counts,{programs:106,diagnostics:40,linkRejections:32});
  for(const key of ['sourceLock','nativeBuild'])equalContent(report[key],expected[key],'Stale alias '+key);
  assert.deepEqual(report.gccSource,expected.gccSource,'Stale alias GCC source');
  for(const key of ['tools','recipes'])assert.deepEqual(contents(report[key]),contents(expected[key]),'Stale alias '+key);
  equalContent(report.gnuRuntime.archive,expected.gnuRuntimeArchive,'Alias runtime differs from packaged GNU archive');
  assert.deepEqual(report.cases.map(entry=>entry.id),matrix.map(entry=>entry.id),'Incomplete alias execution matrix');
  assert.deepEqual(expected.programs.cases.map(entry=>entry.id),matrix.map(entry=>entry.id),'Incomplete alias program proof');
  for(const [index,{fixture,direction,id}]of matrix.entries()){
    const entry=report.cases[index],program=expected.programs.cases[index];
    assert.equal(entry.fixture,fixture.id);assert.equal(entry.direction,direction);assert.equal(entry.stdout,fixture.stdout);
    assert.equal(program.id,id);assert.equal(program.status,'passed');assert.equal(program.stdout,fixture.stdout);
    assert.equal(entry.objects.length,program.units.length);
    for(const [unit,object]of entry.objects.entries()){
      assert.equal(object.compiler,program.units[unit].compiler);assert.deepEqual(object.object,program.units[unit].object);
      if(unit===1)verifyAliasDefinitions(object.metadata,fixture);
    }
  }
  assert.deepEqual(report.diagnostics.map(entry=>entry.id+'-'+entry.family),diagnosticMatrix.map(entry=>entry.id),'Incomplete alias diagnostic matrix');
  for(const [index,{fixture,family}]of diagnosticMatrix.entries()){
    const entry=report.diagnostics[index];equalContent(entry.source,identity(Buffer.from(fixture.request.code)),'Changed alias diagnostic source');
    compilerProfile(entry.command,fixture.request,family,report.tools,1);
    assert.match(entry.command.stderr,new RegExp(fixture.diagnosticPattern,'i'));assert(!entry.object,'Rejected alias produced an object');
  }
  assert.deepEqual(report.negativeLinks.map(entry=>entry.id),linkIds,'Incomplete alias link controls');
  for(const entry of report.negativeLinks){
    const [kind,language,optimization,family]=entry.id.split('-'),request={language,optimization:optimization.slice(1),standard:language==='cpp'?'gnu++17':'gnu11'};
    for(const compiled of [entry.main,...entry.providers]){
      compilerProfile(compiled.command,request,family,report.tools,0);
      if(family==='gcc')command(compiled.assembler,report.tools.assembler.path);
    }
    assert.equal(entry.providers.length,2);
    for(const [index,provider]of entry.providers.entries())verifyAliasDefinitions(provider.metadata,{aliasGroups:[{kind,names:[index===0?'first':'second','shared_alias']}]});
    command(entry.control,report.tools.linker.path);
    const objects=[entry.main.object.path,...entry.providers.map(value=>value.object.path)];
    for(const [name,included]of [['control',objects.slice(0,2)],['duplicate',objects],['undefined',objects.slice(0,1)]]){
      const result=entry[name];assert.equal(result.command,report.tools.linker.path);assert.equal(result.signal,null);assert(!result.error);assert(result.argv.includes('--fatal-warnings'));
      assert.deepEqual(result.argv.filter(arg=>objects.includes(arg)),included);
      if(name!=='control'){assert.notEqual(result.status,0);assert.match(result.stderr,new RegExp(name==='duplicate'?'duplicate symbol: shared_alias':'undefined symbol: shared_alias'));}
    }
  }
  verifyAliasDefinitions(report.gnuRuntime.metadata,{aliasGroups:cases.find(fixture=>fixture.runtimeAliasGroups).runtimeAliasGroups});
}

export async function reopenSymbolAliasQualification(report,expected){
  verifySymbolAliasQualification(report,expected);
  let objects=0;
  async function read(receipt){assert(path.isAbsolute(receipt.path),'Alias artifact requires absolute path');const bytes=await fs.readFile(receipt.path);equalContent(identity(bytes),receipt,'Changed alias artifact '+receipt.path);return bytes;}
  for(const receipt of [...Object.values(report.tools),...Object.values(report.recipes),report.sourceLock,report.nativeBuild])await read(receipt);
  const nested=JSON.parse(await read(report.programs));assert.deepEqual(nested,expected.programs);
  for(const entry of report.cases)for(const object of entry.objects){const metadata=inspectAliasObject(await read(object.object));assert.deepEqual(metadata,object.metadata);objects++;}
  for(const entry of report.diagnostics){
    await read(entry.source);const args=entry.command.argv;assert.equal(args.at(-3),entry.source.path);assert.equal(args.at(-2),'-o');
    const object=entry.family==='clang'?args.at(-1):args.at(-1).replace(/\.wat$/,'.o');
    await assert.rejects(fs.stat(object),error=>error.code==='ENOENT','Rejected alias object unexpectedly exists');
  }
  for(const entry of report.negativeLinks)for(const compiled of [entry.main,...entry.providers]){
    await read(compiled.source);if(compiled.assembly)await read(compiled.assembly);
    const metadata=inspectAliasObject(await read(compiled.object));assert.deepEqual(metadata,compiled.metadata);objects++;
    const args=compiled.command.argv;assert.equal(args.at(-3),compiled.source.path);assert.equal(args.at(-2),'-o');
    assert.equal(args.at(-1),compiled.assembly?.path||compiled.object.path);
  }
  await read(report.gnuRuntime.archive);
  const member=await read(report.gnuRuntime.member),extracted=spawnSync(report.tools.archive.path,['p',report.gnuRuntime.archive.path,'tinfo.o'],{maxBuffer:32*1024*1024});
  assert.ifError(extracted.error);assert.equal(extracted.status,0);assert.equal(extracted.signal,null);assert.deepEqual(extracted.stdout,member);
  assert.deepEqual(inspectAliasObject(member),report.gnuRuntime.metadata);objects++;
  return{objects,programs:report.cases.length,diagnostics:report.diagnostics.length,linkRejections:report.negativeLinks.length*2};
}

import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readRegular,sha256,writeJson} from '../../scripts/source.mjs';
import {auditSerializerOutputHierarchy,verifySerializerOutputSelection} from './prepare.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../..');
const fixtureRoot=path.resolve(process.argv[2]),wholeRoot=path.resolve(process.argv[3]),outputRoot=path.resolve(process.argv[4]);
assert(outputRoot.startsWith(path.join(REPO,'out')+path.sep));await mkdir(outputRoot,{mode:0o700});
const fixture=JSON.parse(await readRegular(path.join(fixtureRoot,'fixture.json'),8*1024*1024)),lockBytes=await readRegular(path.join(HERE,'sources.lock.json')),lock=JSON.parse(lockBytes),inventory=JSON.parse(await readRegular(path.join(HERE,'inventory.json')));
const receiptBytes=await readRegular(path.join(wholeRoot,'compiler-build-receipt.json'),32*1024*1024),receipt=JSON.parse(receiptBytes),argsBytes=await readRegular(path.join(wholeRoot,'compiler-klib.args')),
arguments_=argsBytes.toString().trimEnd().split('\n').map(line=>JSON.parse(line)),filenames=arguments_.filter(x=>!x.startsWith('-')&&x.endsWith('.kt'));
assert.equal(filenames.length,receipt.compileSources.length);assert.equal(receipt.status,'failed');
const selected=filenames.map(filename=>{const matches=receipt.compileSources.filter(pin=>filename.endsWith('/'+pin.path));assert.equal(matches.length,1);return {...matches[0],filename};});
const before=await auditSerializerOutputHierarchy({retainedSources:selected,lock,inventory,phase:'before'}),replacements=selected.map(pin=>{const row=inventory.files.find(x=>x.path===pin.path);return row?{path:row.path,filename:path.join(fixture.options.outputRoot,row.path),bytes:row.output.bytes,sha256:row.output.sha256}:pin;});
const after=await verifySerializerOutputSelection({sourceRoot:fixture.options.sourceRoot,outputRoot:fixture.options.outputRoot,retainedSources:replacements});
await writeJson(path.join(outputRoot,'selection.json'),{schemaVersion:1,kind:'actual-completed-compiler-selected-serializer-output-guard-replay',sourceLockSha256:sha256(lockBytes),artifactRoot:path.relative(REPO,outputRoot),fixtureRoot:path.relative(REPO,fixtureRoot),wholeRoot:path.relative(REPO,wholeRoot),
 wholeReceipt:{path:path.relative(REPO,path.join(wholeRoot,'compiler-build-receipt.json')),bytes:receiptBytes.length,sha256:sha256(receiptBytes)},wholeArguments:{path:path.relative(REPO,path.join(wholeRoot,'compiler-klib.args')),bytes:argsBytes.length,sha256:sha256(argsBytes)},before,after,
 actualCompilerSelectedSources:selected.length,threeSourcesReplacedForGuardOnly:true,newSourceExclusions:false,fullGraphRebuilt:false,fullSerializerWasmExecuted:false,fullCompilerBuilt:false,languageReadiness:false});
console.log(JSON.stringify({actualCompilerSelectedSources:selected.length,knownConsumers:before.consumers.length,threeSourcesReplacedForGuardOnly:true}));

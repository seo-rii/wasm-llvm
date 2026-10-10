import assert from 'node:assert/strict';
import {mkdir,writeFile,copyFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readRegular,sha256,writeJson} from '../../scripts/source.mjs';
import {reconstructModuleRequirePathPredecessorSelection} from './prepare.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../..');
const fixtureRoot=path.resolve(process.argv[2]),root=path.resolve(process.argv[3]);assert(root.startsWith(path.join(REPO,'out')+path.sep));await mkdir(root,{mode:0o700});
const f=JSON.parse(await readRegular(path.join(fixtureRoot,'fixture.json'),32*1024*1024)),lock=JSON.parse(await readRegular(path.join(HERE,'sources.lock.json'))),i=JSON.parse(await readRegular(path.join(HERE,'inventory.json'))),results=[];
async function fresh() {
    const outputRoot=path.join(root,'case-'+results.length);await mkdir(outputRoot,{mode:0o700});
    for(const key of [...f.component.receipt.files.map(x=>x.path),'reference/'+i.path,'module-relative-path-inputs.json']) {
        const destination=path.join(outputRoot,key);await mkdir(path.dirname(destination),{recursive:true,mode:0o700});await copyFile(path.join(f.component.outputRoot,key),destination);
    }
    const retainedSources=f.after.map(pin=>f.component.receipt.files.some(row=>row.path===pin.path)?{...pin,filename:path.join(outputRoot,pin.path)}:pin);
    return {...f.options,outputRoot,retainedSources,receiptSha256:sha256(await readRegular(path.join(outputRoot,'module-relative-path-inputs.json')))};
}
async function guard(o){assert.equal(sha256(await readRegular(path.join(o.outputRoot,'module-relative-path-inputs.json'))),o.receiptSha256,'Root early raw receipt binding differs');return reconstructModuleRequirePathPredecessorSelection(o);}
async function check(name,run){console.log('guard:'+name);await run();results.push({name,passed:true});}
async function update(o,key,bytes){const pin=o.retainedSources.find(x=>x.path===key);await writeFile(pin.filename,bytes);pin.bytes=bytes.length;pin.sha256=sha256(bytes);}
await check('Canonical complete previous selection passes',async()=>{const o=await fresh(),r=await guard(o);assert.equal(r.actualFinalSources,f.after.length);assert.equal(r.commentFinal.actualFinalSources,f.after.length-1);});
await check('Exact recorded late headers pass',async()=>{
    const o=await fresh();for(const key of [i.path,lock.helper.outputPath]){const pin=o.retainedSources.find(x=>x.path===key),text=(await readRegular(pin.filename)).toString(),p=/^package[^\r\n]+/m.exec(text),end=p.index+p[0].length;
        await update(o,key,Buffer.from(text.slice(0,end)+'\nimport org.jetbrains.kotlin.portable.assertions.compilerAssert as assert\n\n'+lock.recordedPropertyImports.map(x=>'import '+x).join('\n')+'\n\nimport kotlin.jvm.*\n'+text.slice(end)));}
    await guard(o);
});
await check('Changed module consumer body rejected',async()=>{const o=await fresh(),pin=o.retainedSources.find(x=>x.path===i.path);await update(o,i.path,Buffer.concat([await readRegular(pin.filename),Buffer.from('\n// changed\n')]));await assert.rejects(guard(o));});
await check('Changed actual helper body rejected',async()=>{const o=await fresh(),pin=o.retainedSources.find(x=>x.path===lock.helper.outputPath);await update(o,lock.helper.outputPath,Buffer.concat([await readRegular(pin.filename),Buffer.from('\n// changed\n')]));await assert.rejects(guard(o));});
await check('Changed authentic predecessor reference rejected',async()=>{const o=await fresh();await writeFile(path.join(o.outputRoot,'reference',i.path),'changed');await assert.rejects(guard(o));});
await check('Raw early metadata binding rejected',async()=>{const o=await fresh(),filename=path.join(o.outputRoot,'module-relative-path-inputs.json'),r=JSON.parse(await readRegular(filename,32*1024*1024));r.observerMetadata=true;await writeFile(filename,JSON.stringify(r)+'\n');await assert.rejects(guard(o),/raw receipt binding/);});
await check('Unrecorded AST class import rejected with body intact',async()=>{const o=await fresh(),pin=o.retainedSources.find(x=>x.path===i.path),t=(await readRegular(pin.filename)).toString();await update(o,i.path,Buffer.from(t.replace(/^(package[^\n]+\n)/m,'$1import org.jetbrains.kotlin.js.backend.ast.JsExport\n')));await assert.rejects(guard(o));});
await check('Unknown helper caller rejected',async()=>{const o=await fresh(),filename=path.join(o.outputRoot,'UnknownConsumer.kt'),bytes=Buffer.from('package unknown\nimport org.jetbrains.kotlin.js.portable.modules.relativeModuleRequirePath as relative\nfun actualCaller()=relative("a/b","c/d")\n');await writeFile(filename,bytes);o.retainedSources.push({path:'probe/UnknownConsumer.kt',filename,bytes:bytes.length,sha256:sha256(bytes)});await assert.rejects(guard(o));});
await check('New wildcard helper consumer rejected',async()=>{const o=await fresh(),filename=path.join(o.outputRoot,'UnknownStar.kt'),bytes=Buffer.from('package unknown\nimport org.jetbrains.kotlin.js.portable.modules.*\n');await writeFile(filename,bytes);o.retainedSources.push({path:'probe/UnknownStar.kt',filename,bytes:bytes.length,sha256:sha256(bytes)});await assert.rejects(guard(o));});
await check('Missing actual module consumer rejected',async()=>{const o=await fresh();o.retainedSources=o.retainedSources.filter(x=>x.path!==i.path);await assert.rejects(guard(o));});
await check('Missing helper rejected',async()=>{const o=await fresh();o.retainedSources=o.retainedSources.filter(x=>x.path!==lock.helper.outputPath);await assert.rejects(guard(o));});
await check('Duplicate selected logical input rejected',async()=>{const o=await fresh();o.retainedSources.push({...o.retainedSources[0]});await assert.rejects(guard(o));});
await check('Equivalent noncanonical selected module filename rejected',async()=>{const o=await fresh(),pin=o.retainedSources.find(x=>x.path===i.path),destination=path.join(o.outputRoot,'Noncanonical.kt');await copyFile(pin.filename,destination);pin.filename=destination;await assert.rejects(guard(o));});
await check('Excluded native IC hierarchy source reintroduction rejected',async()=>{const o=await fresh(),filename=path.join(o.outputRoot,'NativeIC.kt'),bytes=Buffer.from('package excluded\n');await writeFile(filename,bytes);o.retainedSources.push({path:lock.sourceSetExclusions[0],filename,bytes:bytes.length,sha256:sha256(bytes)});await assert.rejects(guard(o));});
const inputBytes=await readRegular(path.join(HERE,'sources.lock.json'));await writeJson(path.join(root,'guards.json'),{schemaVersion:1,kind:'genuine-module-relative-path-selection-guards',sourceLockSha256:sha256(inputBytes),fixtureRoot:path.relative(REPO,fixtureRoot),outputRoot:path.relative(REPO,root),checks:results,composedSourcesEdited:false});console.log(JSON.stringify({guards:results.length,passed:true}));

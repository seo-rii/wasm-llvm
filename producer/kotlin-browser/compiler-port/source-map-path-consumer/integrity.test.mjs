import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {prepareSourceMapPaths,verifySourceMapPaths} from './prepare.mjs';
import {prepareSourceMapBuilder} from '../source-map-builder-kernel/prepare.mjs';
import {verifySourceMapPathFinalSources} from './final.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '../../../..');
const sourceRoot = path.join(REPO, 'out/kotlin-compiler-port/sources'), parent = path.join(REPO, 'out/kotlin-source-map-path-consumer');
await mkdir(parent, { recursive: true, mode: 0o700 }); const root = await mkdtemp(path.join(parent, 'guards-')); let passed = 0;
async function fresh() { const outputRoot = await mkdtemp(path.join(root, 'case-')); const prepared = await prepareSourceMapPaths({ sourceRoot, outputRoot }); return { sourceRoot, outputRoot, receiptPath: prepared.receiptPath, prepared }; }
async function check(name, action) { await action(); passed++; console.log('PASS ' + name); }
await check('Canonical preparation', async () => { await verifySourceMapPaths(await fresh()); });
for (const field of ['differentialValidated','wholeCallerExecuted','generalNativeFileConfiguration','fullCompilerBuilt','languageReadiness','source','tools','sharedDependencies','hostContract','files','primaryClosureSha256','callerSnapshot','references']) {
    await check('Changed receipt ' + field + ' rejected', async () => {
        const options = await fresh(), receipt = JSON.parse(await readFile(options.receiptPath));
        receipt[field] = typeof receipt[field] === 'boolean' ? true : Array.isArray(receipt[field]) ? [] : 'mutation';
        await writeFile(options.receiptPath, JSON.stringify(receipt)); await assert.rejects(verifySourceMapPaths(options));
    });
}
for (const index of [0,1,2,3,4,5,6]) await check('Changed shipping output ' + index + ' rejected', async () => {
    const options = await fresh(); await writeFile(options.prepared.commonSources[index], 'mutation'); await assert.rejects(verifySourceMapPaths(options));
});
for (const index of [0,1]) await check('Changed original ' + index + ' rejected', async () => {
    const inputRoot = await mkdtemp(path.join(root, 'original-'));
    const lock = JSON.parse(await readFile(path.join(HERE, 'sources.lock.json'))), ast = JSON.parse(await readFile(path.join(HERE, '../js-ast/sources.lock.json')));
    const config=JSON.parse(await readFile(path.join(HERE,'../config/sources.lock.json')));const sources = [...lock.sources, ...ast.sources.filter(pin => pin.language === 'kotlin'),...config.sources];
    for (const pin of sources) { const filename = path.join(inputRoot, pin.path); await mkdir(path.dirname(filename), { recursive: true }); await copyFile(path.join(sourceRoot, pin.path), filename); }
    await writeFile(path.join(inputRoot, lock.sources[index].path), 'mutation');
    await assert.rejects(prepareSourceMapPaths({ sourceRoot: inputRoot, outputRoot: await mkdtemp(path.join(root, 'mutated-')) }));
});
await check('Existing preparation rejected without overwriting bytes', async () => {
    const options = await fresh(), before = await readFile(options.prepared.commonSources[0]); await assert.rejects(prepareSourceMapPaths(options)); assert.deepEqual(await readFile(options.prepared.commonSources[0]), before);
});
await check('Symlink output rejected', async () => { const options = await fresh(), alias = options.outputRoot + '-alias'; await symlink(options.outputRoot, alias); await assert.rejects(prepareSourceMapPaths({ sourceRoot, outputRoot: alias })); });
async function finalFixture(){const options=await fresh();const kernelComponent=await prepareSourceMapBuilder({sourceRoot,outputRoot:await mkdtemp(path.join(root,'kernel-'))});const retainedSources=[...options.prepared.receipt.files.map((pin,index)=>({path:pin.path,filename:options.prepared.commonSources[index],compile:true})),...kernelComponent.receipt.files.map((pin,index)=>({path:pin.path,filename:kernelComponent.commonSources[index],compile:true}))];return {...options,kernelComponent,retainedSources};}
await check('Canonical late selection',async()=>{await verifySourceMapPathFinalSources(await finalFixture());});
await check('Allowed assembly import retained',async()=>{const options=await finalFixture(),filename=options.prepared.commonSources[0];const bytes=(await readFile(filename)).toString().replace(/^(package [^\n]+\n)/m,'$1import kotlin.Unit\n');await writeFile(filename,bytes);await verifySourceMapPathFinalSources({...options,allowedAddedImports:['kotlin.Unit']});});
await check('Unknown assembly import rejected',async()=>{const options=await finalFixture(),filename=options.prepared.commonSources[0];await writeFile(filename,(await readFile(filename)).toString().replace(/^(package [^\n]+\n)/m,'$1import kotlin.Unit\n'));await assert.rejects(verifySourceMapPathFinalSources(options));});
for(const index of [0,1,2])await check('Changed late kernel body '+index+' rejected',async()=>{const options=await finalFixture(),filename=options.kernelComponent.commonSources[index];await writeFile(filename,(await readFile(filename)).toString()+'\nfun injectedKernelBehavior()=true\n');await assert.rejects(verifySourceMapPathFinalSources(options));});
await check('Changed late caller body rejected',async()=>{const options=await finalFixture(),filename=options.prepared.commonSources[4];await writeFile(filename,(await readFile(filename)).toString()+'\nfun injectedCallerBehavior()=true\n');await assert.rejects(verifySourceMapPathFinalSources(options));});
await check('Noncanonical equal-byte selected filename rejected',async()=>{const options=await finalFixture(),original=options.retainedSources[0],filename=path.join(options.outputRoot,'Copied.kt');await copyFile(original.filename,filename);options.retainedSources[0]={...original,filename};await assert.rejects(verifySourceMapPathFinalSources(options));});
await check('Unexpected constructor consumer rejected',async()=>{const options=await finalFixture(),filename=path.join(options.outputRoot,'Unknown.kt');await writeFile(filename,'fun unexpected()=SourceMap3Builder(null,{0},"",host)');options.retainedSources.push({path:'Unknown.kt',filename,compile:true});await assert.rejects(verifySourceMapPathFinalSources(options));});
await check('Changed caller snapshot rejected',async()=>{const options=await finalFixture();await writeFile(path.join(options.outputRoot,'caller-snapshot.json'),'[]');await assert.rejects(verifySourceMapPathFinalSources(options));});
console.log(JSON.stringify({ passed, failed: 0, skipped: 0, output: root }));

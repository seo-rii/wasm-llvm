import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,writeFile} from 'node:fs/promises';
import {readRegular,sha256,verifyFile} from '../../scripts/source.mjs';
import {prepareBackendSources} from '../backend/prepare.mjs';
import {prepareBackendProfileSources} from '../backend-profile/prepare.mjs';
import {prepareJsAstOutput} from '../js-ast-consumer-bindings/output-codec/prepare.mjs';
import {prepareJsAstOutputStream} from '../js-ast-consumer-bindings/output-stream/prepare.mjs';
import {prepareCompilerTextSources} from '../text/prepare.mjs';
import {normalizeRecordedImports,HIERARCHY_PATTERN} from './transform.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../..');
export const BASELINE='out/kotlin-compiler-port/builds/fir-profile-whole-1791643995316656397';
export async function createSerializerOutputFixture(outputRoot){
 const sourceRoot=path.join(REPO,'out/kotlin-compiler-port/sources');await mkdir(outputRoot,{recursive:true,mode:0o700});
 const baseline=path.join(REPO,BASELINE),receipt=JSON.parse(await readRegular(path.join(baseline,'compiler-build-receipt.json'),32*1024*1024));
 const argv=(await readRegular(path.join(baseline,'compiler-klib.args'))).toString().trimEnd().split('\n').map(line=>JSON.parse(line));
 const inputs=argv.filter(x=>!x.startsWith('-')&&x.endsWith('.kt'));assert.equal(inputs.length,receipt.compileSources.length);
 const selected=[];
 for(let offset=0;offset<inputs.length;offset+=24){
  const rows=await Promise.allSettled(inputs.slice(offset,offset+24).map(async filename=>{
   const pin=receipt.compileSources.find(row=>filename.endsWith('/'+row.path));assert(pin);
   const bytes=await readRegular(filename);assert.equal(bytes.length,pin.bytes);assert.equal(sha256(bytes),pin.sha256);
   return {...pin,filename};
  }));for(const row of rows){if(row.status!=='fulfilled')throw row.reason;selected.push(row.value);}
 }
 const inventory=JSON.parse(await readRegular(path.join(HERE,'inventory.json')));
 const ast=JSON.parse(await readRegular(path.join(HERE,'../js-ast/evidence/receipt.json')));
 const astRoot=path.join(REPO,'out/kotlin-js-ast/differential-WViAyC/common');
 const preparedJsAst={outputRoot:astRoot,receipt:ast.preparation,receiptPath:path.join(astRoot,'js-ast-inputs.json'),commonSources:ast.preparation.files.map(x=>path.join(astRoot,x.path))};
 const nr=path.join(REPO,'out/kotlin-serializer-nullability-runtime-final-seal-1791644631625307581/profile');
 const nreceipt=JSON.parse(await readRegular(path.join(nr,'serializer-nullability-inputs.json')));
 const preparedSerializerNullability={outputRoot:nr,receipt:nreceipt,receiptPath:path.join(nr,'serializer-nullability-inputs.json'),commonSources:[path.join(nr,nreceipt.consumer.path)]};
 const preparedBackend=await prepareBackendSources({sourceRoot,outputRoot:path.join(outputRoot,'backend')});
 const entry=path.join(outputRoot,'BrowserCompilerPipeline.kt');await writeFile(entry,await readRegular(path.join(HERE,'../entry/BrowserCompilerPipeline.kt')),{flag:'wx',mode:0o600});
 const preparedBackendProfile=await prepareBackendProfileSources({sourceRoot,outputRoot:path.join(outputRoot,'backend-profile'),preparedBackend,browserEntry:entry,retainedSources:selected.map(x=>x.filename)});
 for(const row of selected){
  if(inventory.files.some(x=>x.kind==='serializer'&&x.path===row.path)){row.filename=preparedSerializerNullability.commonSources[0];}
  else if(preparedBackendProfile.commonSources.some(x=>row.path==='compiler-port-backend-profile/'+x.slice(path.join(outputRoot,'backend-profile/compiler-port-backend-profile').length+1))){row.filename=preparedBackendProfile.commonSources.find(x=>x.endsWith('/'+row.path.slice('compiler-port-backend-profile/'.length)));}
  else if(inventory.files.some(x=>x.kind==='fragments'&&x.path===row.path)){row.filename=path.join(sourceRoot,row.path);}
  else {
   const bytes=await readRegular(row.filename);
   if(HIERARCHY_PATTERN.test(bytes.toString())){
    const canonical=normalizeRecordedImports(bytes,receipt.propertyImports.imports);
    const filename=path.join(outputRoot,'canonical-callers',row.path);await mkdir(path.dirname(filename),{recursive:true,mode:0o700});await writeFile(filename,canonical,{flag:'wx',mode:0o600});row.filename=filename;
    const primary=path.join(sourceRoot,row.path);
    if(row.path.startsWith('compiler/'))assert.deepEqual(await readRegular(primary),canonical,'Canonical primary caller reconstruction changed');
    if(row.path.startsWith('compiler-port-js-ast-deserializer/')){
     const d=JSON.parse(await readRegular(path.join(HERE,'../js-ast-consumer-bindings/deserializer/sources.lock.json')));verifyFile(canonical,d.output);
    }
   }
  }
  const bytes=await readRegular(row.filename);row.bytes=bytes.length;row.sha256=sha256(bytes);
 }
 const preparedOutputCodec=await prepareJsAstOutput({sourceRoot,outputRoot:path.join(outputRoot,'codec')});
 const preparedOutputStream=await prepareJsAstOutputStream({sourceRoot,outputRoot:path.join(outputRoot,'stream')});
 const preparedText=await prepareCompilerTextSources({sourceRoot,outputRoot:path.join(outputRoot,'text')});
 return {sourceRoot,outputRoot:path.join(outputRoot,'profile'),preparedSerializerNullability,preparedBackendProfile,preparedJsAst,preparedOutputCodec,preparedOutputStream,preparedText,retainedSources:selected,
  reconstruction:{baseline:BASELINE,baselineSources:inputs.length,canonicalCallerSources:selected.filter(x=>x.filename.includes('/canonical-callers/')).map(x=>x.path),fullGraphRebuilt:false}};
}

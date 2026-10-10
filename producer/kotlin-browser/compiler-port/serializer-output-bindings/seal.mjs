import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readRegular,sha256,writeJson} from '../../scripts/source.mjs';
import {LOCAL_FILES,verifySerializerOutputEvidence} from './verify.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../..');
await mkdir(path.join(HERE,'evidence'),{recursive:true,mode:0o700});
const keys=['runtime','projection','guards','selection'],receiptNames=['jvm-runtime.json','projection-runtime.json','integrity.json','selection.json'];
assert.equal(process.argv.length,6);
for(let index=0;index<keys.length;index++){
 const job=JSON.parse(await readRegular(path.resolve(process.argv[index+2]))),status=await readRegular(job.status),parsed=JSON.parse(status);
 assert.equal(parsed.state,'exited');assert.equal(parsed.exitCode,0);assert.equal(parsed.pid,job.pid);
 const artifactRoot=path.resolve(REPO,job.outputRoot);assert(artifactRoot.startsWith(path.join(REPO,'out')+path.sep));
 const receiptFilename=path.join(artifactRoot,receiptNames[index]),receipt=await readRegular(receiptFilename,32*1024*1024);
 if(keys[index]==='guards'){
  const parsed=JSON.parse(receipt);
  await writeJson(path.join(HERE,'evidence/guards.json'),{schemaVersion:parsed.schemaVersion,kind:parsed.kind,sourceLockSha256:parsed.sourceLockSha256,artifactRoot:parsed.artifactRoot,fixturesSelectedSources:parsed.fixturesSelectedSources,guards:parsed.guards,
   rawGuardReceipt:{path:path.relative(REPO,receiptFilename),bytes:receipt.length,sha256:sha256(receipt)},fullCompilerBuilt:false,languageReadiness:false});
 }else await writeFile(path.join(HERE,'evidence',keys[index]+'.json'),receipt,{mode:0o600});
 await writeFile(path.join(HERE,'evidence',keys[index]+'-status.json'),status,{mode:0o600});
}
const unitFiles=[];for(const name of LOCAL_FILES){const bytes=await readRegular(path.join(HERE,name),32*1024*1024);unitFiles.push({path:name,bytes:bytes.length,sha256:sha256(bytes)});}
await writeJson(path.join(HERE,'evidence/artifacts.json'),{schemaVersion:1,kind:'serializer-output-bindings-evidence-seal',unitFiles,fullSerializerWasmExecuted:false,qualifiedNameHostClosed:false,fullCompilerBuilt:false,languageReadiness:false});
console.log(JSON.stringify(await verifySerializerOutputEvidence()));

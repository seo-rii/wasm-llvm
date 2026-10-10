import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readRegular,sha256,writeJson} from '../../scripts/source.mjs';
import {LOCAL_FILES,verifySerializerCommentTypeNameEvidence} from './verify.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../..');
assert.equal(process.argv.length,5);await mkdir(path.join(HERE,'evidence'),{recursive:true,mode:0o700});
async function put(filename,bytes){let existing;try{existing=await readRegular(filename,32*1024*1024);}catch(error){if(error.code!=='ENOENT')throw error;}
 if(existing)assert.deepEqual(existing,bytes,'A sealed receipt changed');else await writeFile(filename,bytes,{flag:'wx',mode:0o600});}
for(const [index,name] of ['runtime','projection','guards'].entries()){
 const job=JSON.parse(await readRegular(path.resolve(process.argv[index+2]))),statusBytes=await readRegular(job.status),status=JSON.parse(statusBytes);
 assert.equal(status.state,'exited');assert.equal(status.exitCode,0);assert.equal(status.pid,job.pid);assert(status.durationSeconds>0);
 const root=path.resolve(REPO,job.outputRoot);assert(root.startsWith(path.join(REPO,'out')+path.sep));
 const filename=path.join(root,name==='guards'?'integrity.json':name+'.json'),bytes=await readRegular(filename,32*1024*1024);
 if(name==='guards'){const r=JSON.parse(bytes);await put(path.join(HERE,'evidence/guards.json'),Buffer.from(JSON.stringify({schemaVersion:1,kind:r.kind,sourceLockSha256:r.sourceLockSha256,artifactRoot:r.artifactRoot,
  guards:r.guards,selectedBefore:r.selectedBefore,selectedAfter:r.selectedAfter,openExternalCommentAccepted:r.openExternalCommentAccepted,
  lateRecordedImportsAccepted:r.lateRecordedImportsAccepted,earlyMutableSnapshotNotReopened:r.earlyMutableSnapshotNotReopened,
  rawReceipt:{path:path.relative(REPO,filename),bytes:bytes.length,sha256:sha256(bytes)},fullGraphRebuilt:false,fullCompilerBuilt:false,languageReadiness:false},null,2)+'\n'));
 }else await put(path.join(HERE,'evidence',name+'.json'),bytes);
 await put(path.join(HERE,'evidence',name+'-status.json'),statusBytes);
}
const unitFiles=[];for(const name of LOCAL_FILES){const bytes=await readRegular(path.join(HERE,name),32*1024*1024);unitFiles.push({path:name,bytes:bytes.length,sha256:sha256(bytes)});}
await writeJson(path.join(HERE,'evidence/artifacts.json'),{schemaVersion:1,kind:'serializer-comment-type-names-evidence-seal',unitFiles,
 shippingDefaultReporter:false,jvmBinaryNameParity:false,fullSerializerWasmExecuted:false,fullCompilerBuilt:false,languageReadiness:false});
console.log(JSON.stringify(await verifySerializerCommentTypeNameEvidence()));

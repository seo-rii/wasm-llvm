import path from 'node:path';
import { readFile,writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { sha256,gitBlob,verifyFile } from '../../scripts/source.mjs';
import { selectedDeclarations } from '../backend-profile/references.mjs';
import { TARGET,ENTRY,FACADE,MISSING_PROVIDERS } from './references.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../..');
const primaryBytes=await readFile(path.join(HERE,'../closure.lock.json')),primary=JSON.parse(primaryBytes),phaseBytes=await readFile(path.join(HERE,'../lowering-phase-factories/sources.lock.json')),phase=JSON.parse(phaseBytes);
const dependencies=[];
for(const filename of ['prepare.mjs','references.mjs','update-recipe.mjs','../../scripts/source.mjs','../tower-group/transform.mjs','../lowering-phase-factories/prepare.mjs','../lowering-phase-factories/transform.mjs','../lowering-phase-factories/sources.lock.json','../native-js-output-profile/references.mjs','../backend-profile/references.mjs']){const bytes=await readFile(path.join(HERE,filename));const pin={path:filename,bytes:bytes.length,sha256:sha256(bytes),gitBlob:gitBlob(bytes)};verifyFile(bytes,pin);dependencies.push(pin);}
const original=await readFile(path.join(REPO,'out/kotlin-compiler-port/sources',TARGET));
const lock={schemaVersion:1,kind:'unreachable-native-first-phase-source-profile',source:primary.source,primaryClosureSha256:sha256(primaryBytes),target:primary.files.find(row=>row.path===TARGET),phaseOutput:phase.outputs.find(row=>row.path===TARGET),loweringPhaseSourceLockSha256:sha256(phaseBytes),declarations:selectedDeclarations(original.toString()),entry:ENTRY,facade:FACADE,missingProviders:MISSING_PROVIDERS,dependencies,nativeBackendImplemented:false,fullCompilerBuilt:false,languageReadiness:false};
await writeFile(path.join(HERE,'sources.lock.json'),JSON.stringify(lock,null,2)+'\n');
console.log(JSON.stringify({target:TARGET,excluded:1,outputs:0}));

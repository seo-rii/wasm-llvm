import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readRegular,sha256,writeJson } from '../../scripts/source.mjs';
import { verifyFirNavigationFinalSources } from '../fir-navigation/prepare.mjs';
import { prepareFirSyntaxLightTreeProfile,verifyFirSyntaxLightTreeFinalSources } from './prepare.mjs';
import { actualSelection,REPO,BUILD } from './fixture.mjs';
import { NAVIGATION_PATHS,TOKEN_SET_PATH } from '../fir-navigation/transform.mjs';

export async function runSyntaxSelectionProbe(outputRoot){
    outputRoot=path.resolve(outputRoot);await mkdir(outputRoot,{mode:0o700});const current=await actualSelection();
    const prepared=await prepareFirSyntaxLightTreeProfile({sourceRoot:path.join(REPO,'out/kotlin-compiler-port/sources'),outputRoot:path.join(outputRoot,'prepared'),
        retainedSources:current.retainedSources,preparedHost:current.preparedHost,recordedPropertyImports:current.receipt.propertyImports.imports});
    const replacements=new Map();for(const filename of prepared.commonSources){const bytes=await readRegular(filename);const logical=path.relative(prepared.outputRoot,filename);replacements.set(logical,{path:logical,filename,bytes:bytes.length,sha256:sha256(bytes)});}
    const retainedSources=current.retainedSources.filter(r=>!prepared.sourceSetExclusions.includes(r.path)).map(r=>replacements.get(r.path)??r);
    const final=await verifyFirSyntaxLightTreeFinalSources({outputRoot:prepared.outputRoot,retainedSources,expectedReceiptSha256:prepared.receiptSha256});
    assert.deepEqual(final.predecessorRetainedSources,current.retainedSources);
    // The existing navigation verifier publishes final/ artifacts. Give it a
    // private copy and relocate only its five identical-byte owned outputs.
    const oldNavigation=path.join(BUILD,'components/firNavigationReceipt'),privateNavigation=path.join(outputRoot,'navigation');
    await cp(oldNavigation,privateNavigation,{recursive:true,filter:source=>!source.startsWith(path.join(oldNavigation,'final'))});
    const navigationSources=final.predecessorRetainedSources.map(row=>[...NAVIGATION_PATHS,TOKEN_SET_PATH].includes(row.path)?{...row,filename:path.join(privateNavigation,row.path)}:row);
    const navigation=await verifyFirNavigationFinalSources({profileRoot:privateNavigation,retainedSources:navigationSources,
        allowedAddedImports:['kotlin.jvm.*',...current.receipt.propertyImports.imports]});
    await writeJson(path.join(outputRoot,'fixture.json'),{prepared,retainedSources,originalSources:current.retainedSources,preparedHost:current.preparedHost,recordedPropertyImports:current.receipt.propertyImports.imports});
    const result={schemaVersion:1,kind:'actual-fir-syntax-lighttree-selection-proof',input:current.evidence,
        selectedBefore:current.retainedSources.length,selectedAfter:retainedSources.length,originalAudit:prepared.receipt.audit,
        preparationReceipt:{filename:prepared.receiptPath,bytes:(await readRegular(prepared.receiptPath)).length,sha256:prepared.receiptSha256},
        final:final.receipt,originalSelectionRestoredExactly:true,existingNavigationFinal:navigation.receipt,navigationProofPrivateRelocation:[...NAVIGATION_PATHS,TOKEN_SET_PATH],
        fullFirRuntime:false,fullCompilerBuilt:false,kmpLiteralAffixDiagnosticParity:false};
    await writeJson(path.join(outputRoot,'selection.json'),result);console.log(JSON.stringify({outputRoot,before:result.selectedBefore,after:result.selectedAfter,originals:result.originalAudit.inspectedFiles,reverse:true,navigation:'PASS'}));return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await runSyntaxSelectionProbe(process.argv[2]);

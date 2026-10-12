import assert from 'node:assert/strict';
import { selectedDeclarations } from '../backend-profile/references.mjs';
import { lexicalReferenceView } from '../native-js-output-profile/references.mjs';
export const TARGET = 'compiler/ir/ir.inline/src/org/jetbrains/kotlin/ir/inline/konan/NativeFirstPhaseLoweringPhases.kt';
export const ENTRY = 'nativeLoweringsOfTheFirstPhase';
export const FACADE = 'NativeFirstPhaseLoweringPhasesKt';
export const MISSING_PROVIDERS = ['NativeAssertionWrapperLowering', 'NativeExportedBridgeCallDispatchLowering'];
export function phaseReferences(text) {
    const decoded=text.replace(/\\u([0-9a-fA-F]{4})/g,(_,hex)=>String.fromCharCode(parseInt(hex,16)));
    const view=lexicalReferenceView(decoded),joined=(decoded+'\n'+view).replace(/[^A-Za-z0-9_]/g,'');
    return [ENTRY,FACADE].filter(name=>decoded.includes(name)||view.includes(name)||joined.includes(name));
}
export function phaseDeclarations(text,expected) {
    const found=selectedDeclarations(text);assert.deepEqual(found,expected,'Complete native first-phase declaration inventory changed');return found;
}

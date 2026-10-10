import assert from 'node:assert/strict';
import {verifyFile,sha256} from '../../scripts/source.mjs';
export function projectRequireMethod({inventory,source,common,observer}) {
    verifyFile(source,common?inventory.output:inventory.input);
    const text=source.toString(),start=text.indexOf('    private fun relativeRequirePath(moduleHeader: JsIrModuleHeader): String');assert(start>=0);
    const end=common?text.indexOf('\n}',start):text.indexOf('\n    }',start)+'\n    }'.length;
    assert(end>start);const exact=text.slice(start,end);
    if(!common)assert.equal(exact,inventory.originalMethod.text);
    const projected=exact.replace('    private fun relativeRequirePath(moduleHeader: JsIrModuleHeader): String','fun probeRelative(main: String, target: String): String')
        .replaceAll('header.externalModuleName','main').replaceAll('moduleHeader.externalModuleName','target');
    assert(!projected.includes('moduleHeader')&&!projected.includes('header.'));
    const header='package org.jetbrains.kotlin.js.modulepathprobe\n'+(common?'import org.jetbrains.kotlin.js.portable.modules.relativeModuleRequirePath\n':'import java.io.File\n');
    const body=observer.toString().replace(/^package[^\n]+\n/m,'');
    return {bytes:Buffer.from(header+'\n'+projected+'\n'+body),sourceSpan:{start,end,bytes:Buffer.byteLength(exact),sha256:sha256(Buffer.from(exact))},
        propertyAccessProjection:'Two immutable genuine JsIrModuleHeader String property accesses become explicit observer String parameters; no compiler/module model.',common};
}

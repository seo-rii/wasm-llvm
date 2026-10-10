import assert from 'node:assert/strict';
import {verifyFile} from '../../scripts/source.mjs';
export function bindModuleRequirePaths(source, inventory) {
    let text=verifyFile(source,inventory.input).toString();
    assert.equal(inventory.changes.length,2);
    for(const change of [...inventory.changes].sort((a,b)=>b.start-a.start)) {
        assert.equal(text.slice(change.start,change.start+change.before.length),change.before);
        assert.equal(text.split(change.before).length-1,1);
        text=text.slice(0,change.start)+change.after+text.slice(change.start+change.before.length);
    }
    return verifyFile(Buffer.from(text),inventory.output);
}

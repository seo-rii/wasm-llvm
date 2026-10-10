import assert from 'node:assert/strict';
import {applyExact} from '../serializer-output-bindings/transform.mjs';
import {verifyFile} from '../../scripts/source.mjs';

export function transformCommentTypeNames(source,row) {
    verifyFile(source,row.input);
    const output=applyExact(source,row.changes);verifyFile(output,row.output);
    assert.equal(row.changes.length,row.kind==='serializer'?5:row.kind==='carrier'?2:3);
    return output;
}

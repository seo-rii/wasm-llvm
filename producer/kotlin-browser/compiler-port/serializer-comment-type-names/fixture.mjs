import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readRegular} from '../../scripts/source.mjs';
import {verifySerializerOutputEvidence} from '../serializer-output-bindings/verify.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../..');
export async function commentTypeNameFixture(outputRoot) {
    await verifySerializerOutputEvidence();
    const runtime=JSON.parse(await readRegular(path.join(HERE,'../serializer-output-bindings/evidence/runtime.json')));
    const fixture=JSON.parse(await readRegular(path.join(REPO,runtime.fixtureRoot,'fixture.json'),32*1024*1024));
    const selection=JSON.parse(await readRegular(path.join(HERE,'../serializer-output-bindings/evidence/selection.json'),32*1024*1024));
    assert.equal(selection.actualCompilerSelectedSources,3515);
    return {sourceRoot:fixture.options.sourceRoot,outputRoot:path.resolve(outputRoot),
        preparedSerializerOutput:fixture.component,serializerOutputOptions:fixture.options,retainedSources:selection.after.inputs};
}

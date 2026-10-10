import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readRegular} from '../../scripts/source.mjs';
import {verifySerializerCommentTypeNameEvidence} from '../serializer-comment-type-names/verify.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../..');
export async function moduleRequirePathFixture(outputRoot) {
    await verifySerializerCommentTypeNameEvidence();
    const runtime=JSON.parse(await readRegular(path.join(HERE,'../serializer-comment-type-names/evidence/runtime.json')));
    const f=JSON.parse(await readRegular(path.join(REPO,runtime.artifactRoot,'fixture.json'),32*1024*1024));
    return {sourceRoot:f.options.sourceRoot,outputRoot:path.resolve(outputRoot),preparedCommentTypeNames:f.component,
        commentTypeNameOptions:f.options,retainedSources:f.after};
}

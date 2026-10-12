import assert from 'node:assert/strict';
import { selectedDeclarations } from '../backend-profile/references.mjs';
import { lexicalReferenceView } from '../native-js-output-profile/references.mjs';

const ROOT = 'compiler/util/src/org/jetbrains/kotlin/utils/';
const declaration = (name, kind) => ({ packageName: 'org.jetbrains.kotlin.utils', name, kind });
export const DECLARATIONS = {
    [ROOT + 'PathUtil.kt']: [declaration('PathUtil', 'object')],
    [ROOT + 'KotlinPaths.kt']: [declaration('KotlinPaths', 'interface'), declaration('KotlinPathsFromBaseDirectory', 'class')],
    [ROOT + 'KotlinPathsFromHomeDir.kt']: [declaration('KotlinPathsFromHomeDir', 'class')],
};
export const TARGETS = Object.keys(DECLARATIONS);
export const DEFERRED = ROOT + 'KotlinNativePaths.kt';
export const HOMONYM = 'compiler/ir/serialization.common/src/org/jetbrains/kotlin/backend/common/linkage/partial/PartialLinkageErrorMessages.kt';
export const SYMBOLS = Object.values(DECLARATIONS).flat().map(row => row.name);
export const FACADES = ['PathUtilKt', 'KotlinPathsKt', 'KotlinPathsFromHomeDirKt'];

export function distributionDeclarations(logical, text) {
    const found = selectedDeclarations(text);
    assert.deepEqual(found, DECLARATIONS[logical], 'Distribution complete declaration inventory changed: ' + logical);
    return found;
}

// This intentionally keeps identifiers, comments, strings, split literals, aliases,
// backticks and Unicode spellings visible. Only the exact complete pinned consumer
// of com.intellij.util.PathUtil is handled separately by the preparation verifier.
export function distributionReferences(text) {
    const decoded = text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    const view = lexicalReferenceView(decoded), joined = view.replace(/[^A-Za-z0-9_]/g, '');
    return [...SYMBOLS, ...FACADES].flatMap(name => decoded.includes(name)
        ? [{ name, reason: 'identifier, literal or complete name' }]
        : joined.includes(name) ? [{ name, reason: 'conservatively joined name' }] : []);
}

export function distributionDynamicNames(logical, text) {
    return ['Class.forName', 'loadClass(', 'getDeclaredMethod', 'getDeclaredField', 'META-INF/services']
        .filter(token => text.includes(token)).map(token => ({ path: logical, token }));
}

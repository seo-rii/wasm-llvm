import assert from 'node:assert/strict';
import { selectedDeclarations } from '../backend-profile/references.mjs';
import { lexicalReferenceView, nativeOutputReferences } from '../native-js-output-profile/references.mjs';

const io = 'org.jetbrains.kotlin.io';
const declaration = name => ({ packageName: io, name, kind: 'function' });
export const DECLARATIONS = {
    'compiler/util-io/src/org/jetbrains/kotlin/io/PathUtils.kt': [
        'canonicalPathString', 'fileKey', 'deleteOnExit', 'deleteOnExitRecursively',
        'listDirectoryEntriesIfDirectoryExists', 'ensureSymbolicLinkTo',
    ].map(declaration),
};
export const TARGETS = Object.keys(DECLARATIONS);
export const FACADES = ['PathUtilsKt'];
export const REQUIRED = [
    'compiler/fir/raw-fir/mp-parsing2fir/src/org/jetbrains/kotlin/fir/builder/MultiplatformParsing2Fir.kt',
    'compiler/fir/fir2ir/src/org/jetbrains/kotlin/fir/backend/Fir2IrConverter.kt',
    'compiler/ir/backend.wasm/src/org/jetbrains/kotlin/backend/wasm/WasmLoweringPhases.kt',
    'core/descriptors/src/org/jetbrains/kotlin/builtins/BuiltInsLoader.kt',
    'compiler/util/src/org/jetbrains/kotlin/utils/PathUtil.kt',
    'compiler/util/src/org/jetbrains/kotlin/utils/KotlinPaths.kt',
    'compiler/util/src/org/jetbrains/kotlin/utils/KotlinPathsFromHomeDir.kt',
    'compiler/ir/serialization.common/src/org/jetbrains/kotlin/backend/common/linkage/partial/PartialLinkageErrorMessages.kt',
];

export function utilityDeclarations(logical, text) {
    const found = selectedDeclarations(text);
    assert.deepEqual(found, DECLARATIONS[logical], 'Complete target declaration inventory changed: ' + logical);
    return found;
}

export function utilityReferences(text) {
    const decoded = text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    const view = lexicalReferenceView(decoded), joined = view.replace(/[^A-Za-z0-9_]/g, '');
    const references = [];
    for (const [target, declarations] of Object.entries(DECLARATIONS)) {
        for (const declaration of declarations) {
            const reasons = nativeOutputReferences(decoded, declaration, view);
            if (decoded.includes(declaration.name)) reasons.push('literal or identifier');
            else if (joined.includes(declaration.name)) reasons.push('conservatively joined name');
            if (reasons.length) references.push({ target, declaration: declaration.name, reasons: [...new Set(reasons)] });
        }
    }
    for (const name of FACADES) {
        if (decoded.includes(name) || joined.includes(name)) references.push({ facade: name, reasons: ['literal, identifier or conservatively joined facade'] });
    }
    return references;
}

export function dynamicNames(logical, text) {
    return ['Class.forName', 'loadClass(', 'ServiceLoader', 'META-INF/services', 'getDeclaredMethod', 'getDeclaredField']
        .filter(token => text.includes(token)).map(token => ({ path: logical, token }));
}

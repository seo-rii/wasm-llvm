import assert from 'node:assert/strict';
import { selectedDeclarations } from '../backend-profile/references.mjs';
import { lexicalReferenceView, nativeOutputReferences } from '../native-js-output-profile/references.mjs';

const utils = 'org.jetbrains.kotlin.utils';
const declaration = (packageName, name, kind) => ({ packageName, name, kind });
export const DECLARATIONS = {
    'compiler/util/src/org/jetbrains/kotlin/utils/KotlinNativePaths.kt': [declaration(utils, 'KotlinNativePaths', 'object')],
    'compiler/util/src/org/jetbrains/kotlin/type/MapPsiToAsmDesc.kt': [declaration('org.jetbrains.kotlin.type', 'MapPsiToAsmDesc', 'object')],
    'compiler/util/src/org/jetbrains/kotlin/utils/kapt/MemoryLeakDetector.kt': [
        declaration(utils + '.kapt', 'MemoryLeak', 'class'), declaration(utils + '.kapt', 'ClassLoaderData', 'class'),
        declaration(utils + '.kapt', 'MemoryLeakDetector', 'object'), declaration(utils + '.kapt', 'isJavacComponent', 'function'),
        declaration(utils + '.kapt', 'isPrimitiveOrString', 'function'), declaration(utils + '.kapt', 'loadedClasses', 'function'),
    ],
    'compiler/util/src/org/jetbrains/kotlin/utils/LibraryUtils.kt': [declaration(utils, 'LibraryUtils', 'object')],
    'core/util.runtime/src/org/jetbrains/kotlin/utils/reflectionUtils.kt': [
        declaration(utils, 'genericParameterTypesWithoutEnclosingThis', 'val'),
        declaration(utils, 'outerClassForInnerClassConstructor', 'val'),
        declaration(utils, 'genericParameterTypesWithEnclosingThis', 'val'),
    ],
};
export const TARGETS = Object.keys(DECLARATIONS);
export const FACADES = ['MemoryLeakDetectorKt', 'ReflectionUtilsKt'];
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
    // The shared scanner accepts simple extension receivers. These three exact, pinned
    // generic receiver headers are projected only for declaration inventory extraction.
    if (logical === TARGETS[4]) {
        const matches = text.match(/^(?:private )?val Constructor<\*>\./gm) ?? [];
        assert.equal(matches.length, 3, 'Exact reflection extension receiver inventory changed');
        text = text.replace(/^(private )?val Constructor<\*>\./gm, '$1val Constructor.');
    }
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

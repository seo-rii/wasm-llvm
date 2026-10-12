import assert from 'node:assert/strict';
export const SUSPEND_FUNCTIONS = 'core/descriptors/src/org/jetbrains/kotlin/builtins/suspendFunctionTypes.kt';
export const DESERIALIZED_PARAMETER = 'core/deserialization/src/org/jetbrains/kotlin/serialization/deserialization/descriptors/DeserializedTypeParameterDescriptor.kt';
export const LOCAL_IMPORTS = [
    'org.jetbrains.kotlin.portable.lazymutabledescriptors.modality',
    'org.jetbrains.kotlin.portable.lazymutabledescriptors.visibility',
];
const INSERTION = '\n' + LOCAL_IMPORTS.map(name => 'import ' + name).join('\n') + '\n';
export function transformSuspendFunctions(bytes) {
    const text = bytes.toString(), declaration = /^package[^\r\n]+/m.exec(text); assert(declaration);
    for (const name of LOCAL_IMPORTS) assert(!text.includes('import ' + name));
    const end = declaration.index + declaration[0].length;
    const output = Buffer.from(text.slice(0, end) + INSERTION + text.slice(end));
    assert(reverseSuspendFunctions(output).equals(bytes)); return output;
}
export function reverseSuspendFunctions(bytes) {
    const text = bytes.toString(), declaration = /^package[^\r\n]+/m.exec(text); assert(declaration);
    const end = declaration.index + declaration[0].length;
    assert(text.startsWith(INSERTION, end)); assert.equal(text.split(INSERTION).length, 2);
    return Buffer.from(text.slice(0, end) + text.slice(end + INSERTION.length));
}

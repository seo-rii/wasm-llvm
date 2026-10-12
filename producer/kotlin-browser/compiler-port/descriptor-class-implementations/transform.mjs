import assert from 'node:assert/strict';
export const MODULE_AWARE = 'core/descriptors/src/org/jetbrains/kotlin/descriptors/impl/ModuleAwareClassDescriptor.kt';
export const BRIDGE = {
    marker: '    companion object {\n',
    member: `        internal fun ModuleAwareClassDescriptor.getClassPortMemberScopeWithRefiner(
            typeArguments: List<TypeProjection>,
            kotlinTypeRefiner: KotlinTypeRefiner
        ): MemberScope = getMemberScope(typeArguments, kotlinTypeRefiner)

`,
    wrapper: `
/** Retains Java package access to the genuine protected argument-list overload. */
fun ModuleAwareClassDescriptor.getClassPortRefinedMemberScope(
    typeArguments: List<TypeProjection>,
    kotlinTypeRefiner: KotlinTypeRefiner
): MemberScope = with(ModuleAwareClassDescriptor) {
    this@getClassPortRefinedMemberScope.getClassPortMemberScopeWithRefiner(typeArguments, kotlinTypeRefiner)
}
`,
};
export function transformModuleAware(bytes) {
    const original = bytes.toString(); assert.equal(original.split(BRIDGE.marker).length, 2);
    assert(!original.includes('getClassPortMemberScopeWithRefiner')); assert(!original.includes('getClassPortRefinedMemberScope'));
    const prepared = original.replace(BRIDGE.marker, BRIDGE.marker + BRIDGE.member) + BRIDGE.wrapper;
    assert.equal(reverseModuleAware(Buffer.from(prepared)).toString(), original);
    return Buffer.from(prepared);
}
export function reverseModuleAware(bytes) {
    const prepared = bytes.toString(); assert.equal(prepared.split(BRIDGE.marker + BRIDGE.member).length, 2);
    assert.equal(prepared.split(BRIDGE.wrapper).length, 2); assert(prepared.endsWith(BRIDGE.wrapper));
    return Buffer.from(prepared.slice(0, -BRIDGE.wrapper.length).replace(BRIDGE.marker + BRIDGE.member, BRIDGE.marker));
}

export const CONSUMER_IMPORTS = {
    'core/descriptors/src/org/jetbrains/kotlin/types/error/ErrorClassDescriptor.kt': 'org.jetbrains.kotlin.portable.classdescriptors.returnType',
    'core/descriptors/src/org/jetbrains/kotlin/resolve/OverridingStrategy.kt': 'org.jetbrains.kotlin.portable.classdescriptors.overriddenDescriptors',
};
export const CONTRACT_PATHS = [MODULE_AWARE, ...Object.keys(CONSUMER_IMPORTS)];
export function transformClassContract(logical, bytes) {
    if (logical === MODULE_AWARE) return transformModuleAware(bytes);
    const name = CONSUMER_IMPORTS[logical]; assert(name, 'Unknown class consumer contract');
    const original = bytes.toString(), declaration = /^package[^\r\n]+/m.exec(original); assert(declaration);
    assert(!original.includes('import ' + name)); const end = declaration.index + declaration[0].length;
    return Buffer.from(original.slice(0, end) + '\nimport ' + name + '\n' + original.slice(end));
}
export function reverseClassContract(logical, bytes) {
    if (logical === MODULE_AWARE) return reverseModuleAware(bytes);
    const name = CONSUMER_IMPORTS[logical]; assert(name, 'Unknown class consumer contract');
    const prepared = bytes.toString(), declaration = /^package[^\r\n]+/m.exec(prepared); assert(declaration);
    const end = declaration.index + declaration[0].length, insertion = '\nimport ' + name + '\n';
    assert(prepared.startsWith(insertion, end)); assert.equal(prepared.split(insertion).length, 2);
    return Buffer.from(prepared.slice(0, end) + prepared.slice(end + insertion.length));
}

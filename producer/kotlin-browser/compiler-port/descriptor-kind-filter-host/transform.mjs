import assert from 'node:assert/strict';

export const TARGET = 'core/descriptors/src/org/jetbrains/kotlin/resolve/scopes/MemberScope.kt';
export const FILTER_FIELDS = ['ALL', 'CALLABLES', 'NON_SINGLETON_CLASSIFIERS', 'SINGLETON_CLASSIFIERS', 'TYPE_ALIASES', 'CLASSIFIERS', 'PACKAGES', 'FUNCTIONS', 'VARIABLES', 'VALUES'];
const before = `        // Only used in toString
        private val DEBUG_PREDEFINED_FILTERS_MASK_NAMES by lazy {
            staticFields<DescriptorKindFilter>()
                .mapNotNull { field ->
                    val filter = field.get(null) as? DescriptorKindFilter
                    if (filter != null) MaskToName(filter.kindMask, field.name) else null
                }
        }

        private val DEBUG_MASK_BIT_NAMES by lazy {
            staticFields<DescriptorKindFilter>()
                .filter { it.type == Integer.TYPE }
                .mapNotNull { field ->
                    val mask = field.get(null) as Int
                    val isOneBitMask = mask == (mask and (-mask))
                    if (isOneBitMask) MaskToName(mask, field.name) else null
                }
        }

        private inline fun <reified T : Any> staticFields() = T::class.java.fields.filter { Modifier.isStatic(it.modifiers) }`;
const after = `        // The pinned JVM source exposes these ten @JvmField filters, in source order.
        // Its Int masks have private backing fields and are absent from Class.fields.
        private val DEBUG_PREDEFINED_FILTERS_MASK_NAMES by lazy {
            listOf(
${FILTER_FIELDS.map(name => `                MaskToName(${name}.kindMask, "${name}")`).join(',\n')}
            )
        }

        private val DEBUG_MASK_BIT_NAMES: List<MaskToName> by lazy { emptyList() }`;
export const RECIPE = [
    ['import java.lang.reflect.Modifier\n', '', 1],
    ['if (javaClass != other?.javaClass) return false', 'if (other == null || this::class != other::class) return false', 1],
    [before, after, 1],
    ['override fun toString() = this::class.java.simpleName', 'override fun toString() = this::class.simpleName ?: ""', 1],
];
export function transformDescriptorKindFilter(original) {
    let text = original.toString('utf8');
    const fields = [...text.matchAll(/@JvmField val (\w+): DescriptorKindFilter =/g)].map(match => match[1]);
    assert.deepEqual(fields, FILTER_FIELDS, 'Genuine public debug fields changed');
    assert(!/@JvmField\s+val\s+\w+:\s*Int\b/.test(text), 'New public Int mask requires metadata review');
    for (const [old, replacement, count] of RECIPE) {
        assert.equal(text.split(old).length - 1, count, 'Genuine scope host span changed');
        text = text.split(old).join(replacement);
    }
    return Buffer.from(text);
}

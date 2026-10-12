import assert from 'node:assert/strict';

export const TARGET = 'compiler/frontend.common/src/org/jetbrains/kotlin/util/metadataHelpers.kt';
export const RECIPE = [
    ['import java.util.*\n', '', 1],
    ['EnumMap<LanguageVersion, MetadataVersion>(LanguageVersion::class.java)', 'mutableMapOf<LanguageVersion, MetadataVersion>()', 1],
];
export function transformMetadataVersion(original) {
    let text = original.toString('utf8');
    for (const [before, after, count] of RECIPE) {
        assert.equal(text.split(before).length - 1, count, 'Genuine metadata host span changed');
        text = text.split(before).join(after);
    }
    return Buffer.from(text);
}

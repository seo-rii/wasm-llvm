import assert from 'node:assert/strict';

export const ANALYZER = 'compiler/frontend.common/src/org/jetbrains/kotlin/resolve/PlatformDependentAnalyzerServices.kt';
export const MARKER = 'core/util.runtime/src/org/jetbrains/kotlin/container/PlatformSpecificExtension.kt';
export const ANNOTATION = 'core/util.runtime/src/org/jetbrains/kotlin/container/DefaultImplementation.kt';
export const CONFIGURATOR = 'compiler/frontend.common/src/org/jetbrains/kotlin/resolve/PlatformConfigurator.kt';
export const PATHS = [ANALYZER, MARKER, ANNOTATION];
export const CANDIDATES = ['Cache', 'Components', 'Container', 'Descriptors', 'Dsl', 'Registry', 'Resolve', 'Singletons', 'Storage', 'reflectHelpers']
    .map(name => 'compiler/container/src/org/jetbrains/kotlin/container/' + name + '.kt').concat(CONFIGURATOR);
export const PROPERTY = '    @K1Deprecation\n    abstract val platformConfigurator: PlatformConfigurator\n';
export const RESOLVER_START = '/**\n * Allows to specify';
export const COMMENT_LINES = {
    [MARKER]: [
        ' * This is a marker-interface for components which are needed for common resolve\n',
        ' * facilities (like resolve, or deserialization), but are platform-specific.\n',
        ' * rather, we have to carefully resolve clash on case-by-case basis.\n',
        ' * See also [PlatformExtensionsClashResolver].\n',
    ],
    [ANNOTATION]: [' * If you need more fine-grained control of clashes resolution, consider using [PlatformExtensionsClashResolver]\n'],
};

function removeOnce(text, span) {
    assert.equal(text.split(span).length, 2, 'Pinned declaration/comment span changed');
    return text.replace(span, '');
}

/** Only a pinned K1 property, reflection-only resolver and exact pure KDoc lines. */
export function splitK1Declaration(filename, bytes) {
    let text = bytes.toString('utf8'); const removed = [];
    if (filename === ANALYZER) {
        text = removeOnce(text, PROPERTY); removed.push({ kind: 'K1-property', text: PROPERTY });
    } else if (filename === MARKER) {
        assert.equal(text.split(RESOLVER_START).length, 2, 'Pinned resolver boundary changed');
        const end = text.indexOf(RESOLVER_START);
        removed.push({ kind: 'reflection-resolver', text: text.slice(end) }); text = text.slice(0, end);
        for (const line of COMMENT_LINES[MARKER]) {
            text = removeOnce(text, line); removed.push({ kind: 'pure-KDoc', text: line });
        }
    } else if (filename === ANNOTATION) {
        for (const line of COMMENT_LINES[ANNOTATION]) {
            text = removeOnce(text, line); removed.push({ kind: 'pure-KDoc', text: line });
        }
    } else throw new Error('Unselected K1 declaration: ' + filename);
    return { common: Buffer.from(text), removed };
}

/** Root's recorded property imports may be added; declaration/body bytes stay exact. */
export function verifyHostVariant(variant, canonical, approvedImports = ['org.jetbrains.kotlin.portable.common.*', 'org.jetbrains.kotlin.portable.descriptors.*']) {
    const value = variant.toString('utf8'), expected = canonical.toString('utf8');
    if (value === expected) return [];
    const originalImports = [...expected.matchAll(/^import ([^\r\n]+)\n/gm)].map(match => match[1]);
    const actualImports = [...value.matchAll(/^import ([^\r\n]+)\n/gm)].map(match => match[1]);
    assert.equal(new Set(actualImports).size, actualImports.length, 'Repeated host import');
    for (const name of originalImports) assert(actualImports.includes(name), 'Original import removed: ' + name);
    const added = actualImports.filter(name => !originalImports.includes(name));
    assert(added.length > 0, 'Changed selected declaration/body');
    for (const name of added) assert(approvedImports.includes(name), 'Unreviewed host import: ' + name);
    // Global import insertion puts one extra blank line after its contiguous block.
    const stripped = value.replace(/^import [^\r\n]+\n/gm, '').replace(/(^package [^\r\n]+\n)\n+/m, '$1\n');
    const expectedStripped = expected.replace(/^import [^\r\n]+\n/gm, '').replace(/(^package [^\r\n]+\n)\n+/m, '$1\n');
    assert.equal(stripped, expectedStripped, 'Changed selected declaration/body');
    return added;
}

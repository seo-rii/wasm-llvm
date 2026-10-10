import assert from 'node:assert/strict';
import { chooseExclusions } from '../backend-profile/references.mjs';
import { ANALYZER, MARKER, PATHS, CANDIDATES } from './transform.mjs';

/** Comments, strings, import aliases and wildcards remain visible to this lexical guard. */
export function guardK1References({ originals, splitSources, retainedSources, declarations }) {
    assert.deepEqual([...originals.keys()].filter(name => CANDIDATES.includes(name)).sort(), [...CANDIDATES].sort());
    const candidates = new Map(CANDIDATES.map(name => [name, { text: originals.get(name).toString(), declarations: declarations[name] }]));
    const splits = new Map(PATHS.map(name => [name, { text: splitSources.get(name).toString(), removedDeclarations: name === MARKER ?
        [{ packageName: 'org.jetbrains.kotlin.container', name: 'PlatformExtensionsClashResolver', kind: 'class' }] : [] }]));
    const retained = new Map(); const names = new Set();
    for (const { path, source } of retainedSources) {
        assert(!names.has(path), 'Duplicate selected logical source: ' + path); names.add(path);
        if (CANDIDATES.includes(path) || PATHS.includes(path)) continue;
        retained.set(path, { text: source.toString() });
    }
    const result = chooseExclusions({ candidates, splits, retained });
    assert.equal(result.promoted.length, 0, 'Real/possible K1 DI incoming reference: ' + JSON.stringify(result.promoted.slice(0, 3)));
    assert.equal(result.unclosed.length, 0, 'Removed reflection resolver still referenced: ' + JSON.stringify(result.unclosed.slice(0, 3)));
    assert.deepEqual(result.excluded, [...CANDIDATES].sort());
    // A consumer can access this member without naming its PlatformConfigurator return type.
    for (const [caller, item] of result.active) assert(!/\bplatformConfigurator\b/.test(item.text), 'Removed K1 analyzer member referenced in ' + caller);
    assert(!/\bplatformConfigurator\b/.test(splits.get(ANALYZER).text));
    return { inspectedKotlinInputs: retainedSources.length, excludedPaths: result.excluded, promoted: [], unclosed: [],
        removedAnalyzerMemberIncoming: [], rule: 'Qualified/import/alias/wildcard/same-package declaration references plus global removed-member identifier',
        commentsAndStringsRetained: true, semanticCompilerCallGraph: false };
}

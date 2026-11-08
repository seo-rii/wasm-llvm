import assert from 'node:assert/strict';

export const TARGET = 'compiler/fir/resolve/src/org/jetbrains/kotlin/fir/resolve/FirRegularTowerDataContexts.kt';
export const TARGETS = [TARGET];
export const MODES = ['REGULAR', 'NESTED_CLASS', 'COMPANION_BLOCK', 'COMPANION_OBJECT', 'CONSTRUCTOR_HEADER', 'ENUM_ENTRY'];

// Only the private map representation changes. Keep the complete source body.
// Replace constructors before types so the two type-only occurrences stay exact.
export const RECIPE = [
  { before: 'import org.jetbrains.kotlin.fir.scopes.impl.FirLocalScope\nimport java.util.*\n',
    after: 'import org.jetbrains.kotlin.fir.scopes.impl.FirLocalScope\n', occurrences: 1 },
  { before: 'EnumMap<FirTowerDataMode, FirTowerDataContext>(FirTowerDataMode::class.java)',
    after: 'mutableMapOf<FirTowerDataMode, FirTowerDataContext?>()', occurrences: 3 },
  { before: 'EnumMap<FirTowerDataMode, FirTowerDataContext>',
    after: 'MutableMap<FirTowerDataMode, FirTowerDataContext?>', occurrences: 2 },
];

export function transformTowerModeMap(logical, bytes, { reverse = false } = {}) {
  assert.equal(logical, TARGET, 'Only the private FIR tower mode map is selected');
  let text = Buffer.from(bytes).toString('utf8');
  for (const change of reverse ? [...RECIPE].reverse() : RECIPE) {
    const before = reverse ? change.after : change.before, after = reverse ? change.before : change.after;
    assert.equal(text.split(before).length - 1, change.occurrences, 'Exact tower map replacement count changed: ' + before);
    text = text.split(before).join(after);
  }
  return Buffer.from(text);
}

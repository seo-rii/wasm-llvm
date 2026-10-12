import assert from 'node:assert/strict';
import { readRegular } from '../../scripts/source.mjs';
import { fileURLToPath } from 'node:url';
const recipes = JSON.parse(await readRegular(fileURLToPath(new URL('./recipes.json', import.meta.url))));
export const TARGETS = Object.keys(recipes);
export const HELPER = 'compiler-port-lowering-phase-factories/LoweringPassFactory.kt';
export const RECIPE = recipes;
export function transformLoweringPhaseSource(logical, original) {
    assert(recipes[logical], 'Unknown genuine lowering phase source');
    let text = original.toString('utf8');
    for (const [before, after, count] of recipes[logical]) {
        assert.equal(text.split(before).length - 1, count, 'Genuine phase host span changed: ' + logical);
        text = text.split(before).join(after);
    }
    return Buffer.from(text);
}

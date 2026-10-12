import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const OUTPUT_PREFIX = 'compiler-port-jvm-descriptor-signatures/';
export const EXPECTED_SOURCE = {
    repository: 'https://github.com/JetBrains/kotlin.git',
    commit: '4d78aae1e337cd40f69baa865aed950fe807a775',
    rootTreeSha: '2be662d1ae06bfcf435efbe18191ba5e1e3f035e',
    coreTreeSha: 'ae664f12525e21609369d6d5901a8770c70a1f23',
};

/** Replays complete files in both directions; no declaration projection substitutes for a source body. */
export function verifyCompleteSources(facts, originals, common, provenance) {
    assert.deepEqual(facts.source, EXPECTED_SOURCE, 'JVM signature source identity changed');
    assert.equal(facts.originals.length, 17); assert.equal(facts.outputs.length, 18);
    assert.equal(new Set(facts.originals.map(row => row.path)).size, 17);
    assert.equal(new Set(facts.outputs.map(row => row.path)).size, 18);
    assert.equal(provenance.commit.sha, EXPECTED_SOURCE.commit);
    assert.equal(provenance.commit.tree.sha, provenance.root.sha);
    assert.equal(provenance.root.sha, EXPECTED_SOURCE.rootTreeSha);
    assert.equal(provenance.root.tree.find(row => row.path === 'core').sha, provenance.core.sha);
    assert.equal(provenance.core.sha, EXPECTED_SOURCE.coreTreeSha);
    assert.equal(provenance.core.truncated, false);
    const blobs = new Map(provenance.core.tree.filter(row => row.type === 'blob').map(row => ['core/' + row.path, row]));
    for (const pin of facts.originals) {
        assert.equal(blobs.get(pin.path)?.sha, pin.gitBlob, 'Supplemental original Git tree mismatch');
        assert.equal(blobs.get(pin.path)?.size, pin.bytes, 'Supplemental original Git tree size mismatch');
    }
    assert.equal(facts.fullKotlinRoundtrips.length, 11);
    for (const recipe of facts.fullKotlinRoundtrips) {
        const original = originals.get(recipe.path).toString(), output = common.get(recipe.output).toString();
        let previousEnd = 0;
        for (const delta of recipe.deltas) {
            assert(previousEnd <= delta.start && delta.start <= delta.end, 'Overlapping JVM signature recipe');
            assert.equal(original.slice(delta.start, delta.end), delta.before, 'JVM signature original recipe span changed');
            previousEnd = delta.end;
        }
        let forward = original;
        for (const delta of [...recipe.deltas].reverse()) forward = forward.slice(0, delta.start) + delta.after + forward.slice(delta.end);
        assert.equal(forward, output, 'JVM signature full forward recipe changed');
        let reverse = output;
        for (const delta of recipe.deltas) {
            assert.equal(reverse.slice(delta.start, delta.start + delta.after.length), delta.after, 'JVM signature inverse recipe span changed');
            reverse = reverse.slice(0, delta.start) + delta.before + reverse.slice(delta.start + delta.after.length);
        }
        assert.equal(reverse, original, 'JVM signature full reverse recipe changed');
    }
    assert.equal(facts.helperDeclarations.length, 2);
    const helpers = common.get('PortableEnhancedNullability.kt').toString();
    for (const helper of facts.helperDeclarations) {
        const original = originals.get(helper.path).toString();
        assert.equal(original.slice(helper.start, helper.start + helper.body.length), helper.body, 'Enhanced nullability declaration changed');
        assert.equal(original.split(helper.body).length, 2); assert.equal(helpers.split(helper.body).length, 2);
        assert.equal(createHash('sha256').update(helper.body).digest('hex'), helper.sha256);
    }
    const coverage = provenance.coverage, records = provenance.records;
    assert.equal(coverage.targets.length, 33); assert.equal(records.length, 33);
    assert.deepEqual([coverage.classMapDirectTargets, coverage.classMapGenericTargets, coverage.annotationNameTargets], [18, 8, 7]);
    assert.deepEqual(coverage.targets.map(row => row.key), records.map(row => row.key));
    for (const target of coverage.targets) {
        const span = originals.get(target.sourcePath).toString().slice(target.sourceStart, target.sourceEnd);
        assert.equal(span, target.sourceSpan, 'Foreign class original expression changed');
        assert.equal(Buffer.byteLength(span), target.spanBytes);
        assert.equal(createHash('sha256').update(span).digest('hex'), target.spanSha256);
    }
    const originalMap = originals.get(facts.originals.find(row => row.path.endsWith('/JavaToKotlinClassMap.kt')).path).toString();
    assert.equal(originalMap.match(/mutabilityMapping<[^\n]+/g)?.length, 8, 'Unrecorded reified specialization');
    assert.equal(originalMap.split('::class.java').length - 1, 19, 'Unrecorded foreign class literal');
    assert.equal(originalMap.split('T::class.java').length - 1, 1);
    const catalog = common.get('JvmForeignClassCatalog.kt').toString();
    const keys = [...catalog.split('class JvmForeignClassMetadata')[0].matchAll(/^    (\w+),?$/gm)].map(match => match[1]);
    assert.deepEqual(keys, records.map(row => row.key), 'Foreign catalog closed key roster changed');
    const entries = [...catalog.matchAll(/JvmForeignClassKey\.(\w+) to JvmForeignClassMetadata\((.*)\)/g)];
    assert.equal(entries.length, 33);
    for (const [, key, literal] of entries) {
        const record = records.find(row => row.key === key);
        assert.deepEqual(JSON.parse('[' + literal.replaceAll('\\$', '$') + ']'),
            ['name', 'canonicalName', 'simpleName', 'declaringClass', 'isPrimitive', 'isArray'].map(field => record[field]),
            'Foreign catalog record differs from measured JDK metadata');
    }
    assert(records.every(row => !row.isPrimitive && !row.isArray));
    const mapped = common.get('JavaToKotlinClassMap.kt').toString();
    assert.equal(mapped.match(/mutabilityMapping\(JvmForeignClassKey\./g)?.length, 8, 'Foreign specialization keys must be closed');
    const helper = mapped.slice(mapped.indexOf('private fun mutabilityMapping('), mapped.indexOf('\n    val mutabilityMappings'));
    assert(helper.indexOf('val mutableClassId =') < helper.indexOf('JvmForeignClassCatalog.require(javaClassKey)'),
        'Foreign metadata lookup moved before mutableClassId construction');
    assert.equal(mapped.match(/JvmForeignClassCatalog.require\(javaClassKey\)/g)?.length, 1);
}

import assert from 'node:assert/strict';

export const HELPER = String.raw`
// Bind only selected Java flexible getter results at the original expression checks.
private inline fun <T : Any> requiredSerializerAstValue(value: T?, expression: String): T =
    value ?: throw NullPointerException("$expression must not be null")

// Match only the audited null getClass entry; nonnull qualifiedName stays unchanged.
private inline fun requiredSerializerMetadataValue(value: Any?): Any = value ?: throw NullPointerException(
    "Cannot invoke \"Object.getClass()\" because \"value\" is null"
)
`;
export function bindSerializerNullableGetters(original, inventory) {
    let source = original.toString('utf8');
    assert.equal(inventory.bindings.length, 27);
    assert.equal(inventory.bindings.filter(row => row.getter !== null).length, 25);
    assert(!source.includes('requiredSerializerAstValue'));
    const entries = [];
    const metadata = inventory.metadataClassLiteral;
    assert.equal(metadata.before, 'value::class.qualifiedName');
    assert.equal(source.slice(metadata.start,metadata.start+metadata.before.length),metadata.before);
    source = source.slice(0,metadata.start) + 'requiredSerializerMetadataValue(value)::class.qualifiedName' +
        source.slice(metadata.start+metadata.before.length);
    const metadataDelta = 'requiredSerializerMetadataValue(value)::class.qualifiedName'.length - metadata.before.length;
    for (const row of [...inventory.bindings].sort((a,b) => b.start-a.start)) {
        const start = row.start > metadata.start ? row.start + metadataDelta : row.start;
        assert.equal(source.slice(start, start+row.before.length), row.before, 'Selected caller span changed: '+row.owner);
        assert.equal(source.slice(0,start).split('\n').length, row.line);
        assert(row.before.includes(row.expression));
        const property = /^[A-Za-z_][A-Za-z0-9_]*\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(row.expression);assert(property);
        if (row.getter !== null) assert.equal(row.getter, 'get'+property[1][0].toUpperCase()+property[1].slice(1)+'(...)');
        else assert.equal(row.expression,'declarable.name');
        const replacement = row.getter === null ? 'declarable.getName()' :
            'requiredSerializerAstValue('+row.expression+', '+JSON.stringify(row.getter)+')';
        const after = row.before.replace(row.expression, replacement);
        source = source.slice(0,start)+after+source.slice(start+row.before.length);
        entries.push({...row,after});
    }
    return {bytes:Buffer.from(source+HELPER),bindings:entries.reverse()};
}

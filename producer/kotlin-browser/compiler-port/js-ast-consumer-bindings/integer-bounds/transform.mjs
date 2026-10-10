import assert from 'node:assert/strict';
export const LENGTH_GUARD = '        require(length >= 0 && offset >= 0 && offset <= source.size && length <= source.size - offset) { "Invalid JS AST byte length" }\n';
export function boundReadBytes(body) {
    const anchor = '        val offset = buffer.position()\n';
    assert.equal(body.split(anchor).length, 2);
    assert(!body.includes('Invalid JS AST byte length'));
    return body.replace(anchor, anchor + LENGTH_GUARD);
}
export function transformLengthBoundary(bytes, originalBody) {
    const text = bytes.toString(); assert.equal(text.split(originalBody).length, 2);
    return Buffer.from(text.replace(originalBody, boundReadBytes(originalBody)));
}

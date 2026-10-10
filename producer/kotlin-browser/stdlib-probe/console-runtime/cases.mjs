import assert from 'node:assert/strict';

const encode = value => Array.from(new TextEncoder().encode(value));
const lineRecord = value => value.length + ':' + Array.from({ length: value.length }, (_, index) => value.charCodeAt(index).toString(16)).join(',') + '\n';
const eof = 'eof:EOF has already been reached\n';
const complete = (id, stdin, stdout, stderr = '', maxOutputBytes = 65536) => ({
    id, stdin: typeof stdin === 'string' ? encode(stdin) : stdin, maxOutputBytes,
    expected: { stdout, stderr, outputBytes: encode(stdout + stderr).length, outputLimitExceeded: false, status: 'completed', exitCode: 0 },
});
export const cases = [
    complete('empty-eof', 'lines\n', eof),
    complete('empty-lines', 'lines\n\n\r\n', lineRecord('') + lineRecord('') + eof),
    complete('mixed-lines', 'lines\nfirst\r\n한글🙂\nlast', ['first', '한글🙂', 'last'].map(lineRecord).join('') + eof),
    complete('embedded-cr-and-nul', 'lines\na\rb\u0000c\n', lineRecord('a\rb\u0000c') + eof),
    // Preserve the selected stdlib's removal of a trailing CR at EOF as well as CRLF.
    complete('trailing-cr-at-eof', 'lines\ntail\r', lineRecord('tail') + eof),
    ...[31, 32, 33, 63, 64, 65, 4096].map(length => {
        const value = 'a'.repeat(length) + '🙂λ';
        return complete('buffer-' + length, 'lines\n' + value + '\r\n', lineRecord(value) + eof);
    }),
    complete('malformed-utf8', [...encode('lines\n'), 0xe2, 0x28, 0xa1, 10], lineRecord('\uFFFD(\uFFFD') + eof),
    complete('unicode-output', 'unicode\n', '한글🙂λe\u0301\u0000\uFEFF\uFFFD\uFFFD\n'),
    complete('stderr-exception-chain', 'stderr\n', 'stdout-after-stderr\n',
        'kotlin.IllegalStateException: 오류🙂\n    Suppressed: kotlin.IllegalArgumentException: 보조e\u0301\nCaused by: kotlin.IllegalArgumentException: 원인λ\n'),
    complete('caught-exceptions', 'caught\n', 'caught:3\n'),
    { id: 'uncaught-exception', stdin: encode('uncaught\n'), maxOutputBytes: 65536,
        expected: { stdout: 'before-throw\n', stderr: '', outputBytes: 13, outputLimitExceeded: false, status: 'runtime-error', exitCode: null }, errorRequired: true },
    ...[0, 6, 7].map(maxOutputBytes => ({ id: 'output-limit-' + maxOutputBytes, stdin: encode('limits\n'), maxOutputBytes,
        expected: { stdout: maxOutputBytes === 7 ? 'α🙂\n' : '', stderr: '', outputBytes: maxOutputBytes === 7 ? 7 : 0,
            outputLimitExceeded: true, status: 'output-limit', exitCode: null }, errorRequired: true })),
    complete('exact-output-budget', 'limits\n', 'α🙂\nxyz', '', 10),
    complete('fresh-state-one', 'state\n', 'state:1\n'),
    complete('fresh-state-two', 'state\n', 'state:1\n'),
    complete('recovery-after-failures', 'lines\nrecovered\n', lineRecord('recovered') + eof),
];

export function verifyResults(results) {
    assert.equal(results.length, cases.length);
    for (const [index, result] of results.entries()) {
        const test = cases[index]; assert.equal(result.id, test.id);
        const { error, ...actual } = result.result;
        assert.deepEqual(actual, test.expected, test.id);
        if (test.errorRequired) { assert.equal(typeof error, 'string'); assert(error.length > 0); assert(!error.includes('Unsupported program import')); }
        else assert.equal(error, undefined);
    }
}

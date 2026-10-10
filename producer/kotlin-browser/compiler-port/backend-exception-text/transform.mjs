import assert from 'node:assert/strict';

export const BACKEND = 'compiler/ir/backend.common/src/org/jetbrains/kotlin/backend/common/CommonBackendErrors.kt';
export const PREDECESSOR_PATH = 'common/' + BACKEND;
export const COMPONENT_PATH = 'compiler-port-diagnostic-source-dsl/' + PREDECESSOR_PATH;
export const REPLACEMENTS = [
    ['StackOverflowError::class.java.name', '"java.lang.StackOverflowError"'],
    ['NullPointerException::class.java.name', '"java.lang.NullPointerException"'],
];
export const RENDERER_START = 'object BackendDiagnosticRenderers {\n';
export const LAMBDA_START = '    val EVALUATION_ERROR_EXPLANATION = Renderer<String> {\n';
export const LAMBDA_END = '\n    }\n}';

/** Exception names already arrive as Strings; this does not model host exceptions. */
export function transformBackendExceptionText(original) {
    let text = original.toString('utf8');
    for (const [before, after] of REPLACEMENTS) {
        assert.equal(text.split(before).length, 2, 'Selected original exception-name expression changed');
        text = text.replace(before, after);
    }
    return Buffer.from(text);
}

export function rendererLambda(original) {
    const text = original.toString('utf8'); assert.equal(text.split(RENDERER_START).length, 2);
    const object = text.slice(text.indexOf(RENDERER_START));
    assert.equal(object.split(LAMBDA_START).length, 2);
    assert.equal(object.split(LAMBDA_END).length, 2);
    const start = object.indexOf(LAMBDA_START) + LAMBDA_START.length, end = object.indexOf(LAMBDA_END, start);
    assert(end > start); assert.equal(object.slice(end + LAMBDA_END.length).trim(), '');
    return Buffer.from(object.slice(start, end));
}

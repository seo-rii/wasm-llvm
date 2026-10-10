import assert from 'node:assert/strict';
export const UTILS = 'compiler/ir/backend.js/src/org/jetbrains/kotlin/ir/backend/js/transformers/irToJs/jsAstUtils.kt';
export function embeddedSourceFunction(text) {
    const start = text.indexOf('private fun JsLocation.withEmbeddedSource('), end = text.indexOf('\nfun IrElement.getStartSourceLocation', start);
    assert(start >= 0 && end > start); return text.slice(start, end).trimEnd();
}
export function sourceContentBinding(bytes) {
    const original = bytes.toString(), body = embeddedSourceFunction(original);
    const imports = ['import java.io.FileInputStream', 'import java.io.IOException', 'import java.io.InputStreamReader', 'import java.nio.charset.StandardCharsets'];
    let text = original;
    for (const line of imports) { assert.equal(text.split(line).length, 2); text = text.replace(line + '\n', ''); }
    const replacement = `private fun JsLocation.withEmbeddedSource(context: JsGenerationContext): JsLocationWithEmbeddedSource {
    // Capture the current immutable request content; each invocation opens a fresh reader.
    return JsLocationWithEmbeddedSource(this, fileIdentity = null /*context.currentFile.fileEntry*/,
        sourceProvider = requestSourceSupplier(context.staticContext.backendContext.configuration, file))
}`;
    text = text.replace(body, replacement);
    const anchor = 'import org.jetbrains.kotlin.js.backend.ast.';
    const index = text.indexOf(anchor); assert(index >= 0);
    text = text.slice(0, index) + 'import org.jetbrains.kotlin.js.portable.requestSourceSupplier\n' + text.slice(index);
    assert(!/\b(?:FileInputStream|InputStreamReader|IOException|StandardCharsets)\b/.test(text));
    return { bytes: Buffer.from(text), originalBody: body, boundBody: replacement };
}

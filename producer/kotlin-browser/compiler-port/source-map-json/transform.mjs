import assert from 'node:assert/strict';

export const JSON_SOURCE = 'js/js.parser/src/org/jetbrains/kotlin/js/parser/sourcemaps/JSON.kt';
export const ECMA_SOURCE = 'js/js.parser/src/org/jetbrains/kotlin/js/parser/sourcemaps/ECMA426BasedSourceMapParser.kt';
export function bindSourceMapJson(filename, bytes) {
    let text = bytes.toString();
    const changes = [];
    function replace(before, after, count = 1) {
        assert.equal(text.split(before).length - 1, count, 'Changed source-map host span: ' + before);
        text = text.split(before).join(after); changes.push({ before, after, count });
    }
    if (filename === JSON_SOURCE) {
        replace('import java.io.*', 'import org.jetbrains.kotlin.js.util.javaDoubleToString');
        replace('writer: Writer', 'writer: Appendable', 7);
        replace('StringWriter()', 'StringBuilder()');
        replace('writer.append(value.toString())', 'writer.append(javaDoubleToString(value))');
    } else {
        assert.equal(filename, ECMA_SOURCE);
        // The genuine optional annotation is an explicit common-source import.
        replace('import kotlin.contracts.contract', 'import kotlin.contracts.contract\nimport kotlin.jvm.JvmInline');
    }
    return { bytes: Buffer.from(text), changes };
}

/** Keep every original test method and assertion; only the JUnit discovery annotations are unnecessary. */
export function bindTestDiscovery(bytes) {
    let text = bytes.toString();
    const methods = [...text.matchAll(/^    @Test\n    fun (\w+)\(\)/gm)].map(match => match[1]);
    if (methods.length) {
        assert.equal(text.split('import org.junit.jupiter.api.Test\n').length, 2);
        text = text.replace('import org.junit.jupiter.api.Test\n', '').replace(/^    @Test\n/gm, '');
    }
    return { bytes: Buffer.from(text), methods };
}

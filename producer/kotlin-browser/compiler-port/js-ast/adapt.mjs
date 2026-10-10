/** Exact host bindings for the original Kotlin companions; node bodies are retained. */
import assert from 'node:assert/strict';

export function adaptKotlin(path, original) {
    let text = original.toString('utf8');
    const transformations = [];
    function replace(from, to) {
        if (!text.includes(from)) return;
        text = text.split(from).join(to);
        transformations.push({ from, to });
    }
    replace('import java.io.Reader', 'import org.jetbrains.kotlin.js.util.AstSourceReader as Reader');
    replace('import java.math.BigInteger', 'import org.jetbrains.kotlin.js.util.AstInteger as BigInteger');
    replace('import com.intellij.util.SmartList', 'import org.jetbrains.kotlin.utils.SmartList');
    replace('import it.unimi.dsi.fastutil.objects.ObjectOpenHashSet', 'import kotlin.collections.HashSet as ObjectOpenHashSet');
    // JVM export/overload names have no common/Wasm binary-ABI counterpart.
    // These four annotations do not change the selected Kotlin source bodies.
    replace('    @JvmField\n', '');
    replace(' @JvmOverloads constructor(', ' constructor(');
    replace('@file:JvmName("MetadataProperties")\n', '');
    if (path.endsWith('/IdentifierPolicy.kt')) {
        replace('import kotlin.math.abs', 'import kotlin.math.abs\nimport org.jetbrains.kotlin.js.util.AstCharacter as Character');
    }
    // These diagnostics use the genuine value's existing rendering; no class
    // identity or invented FIR/AST symbol is supplied to replace reflection.
    replace('${value.javaClass}', '${value::class.simpleName}');
    replace('${arg.javaClass}', '${arg::class.simpleName}');
    if (/\bassert\(/.test(text)) {
        replace('package org.jetbrains.kotlin.js.backend.ast\n', 'package org.jetbrains.kotlin.js.backend.ast\n\nimport org.jetbrains.kotlin.portable.assertions.compilerAssert as assert\n');
    }
    if (path.endsWith('/JsToStringGenerationVisitor.kt')) {
        replace('import org.jetbrains.kotlin.js.util.TextOutput', 'import org.jetbrains.kotlin.js.util.TextOutput\nimport org.jetbrains.kotlin.js.util.position\nimport org.jetbrains.kotlin.js.util.line\nimport org.jetbrains.kotlin.js.util.column');
        // Java platform values were checked by Kotlin's non-null parameter
        // boundary, or dereferenced immediately, at exactly these sites.
        // Keep the explicit node getters nullable and retain that failure here.
        for (const field of ['arrayExpression', 'testExpression', 'thenExpression', 'elseExpression', 'arg']) {
            replace(`printPair(x, x.${field}`, `printPair(x, x.${field}!!`);
        }
        replace('parenPush(x, x.arg1,', 'parenPush(x, x.arg1!!,');
        replace('parenPopOrSpace(x, x.arg1,', 'parenPopOrSpace(x, x.arg1!!,');
        replace('x.condition.source', 'x.condition!!.source');
        replace('JsConstructExpressionVisitor.exec(x.constructorExpression)', 'JsConstructExpressionVisitor.exec(x.constructorExpression!!)');
        replace('p.print(x.pattern)', 'p.print(x.pattern!!)');
        replace('p.print(nameRef.ident)', 'p.print(nameRef.ident!!)');
        replace('p.print(it.ident)', 'p.print(it.ident!!)');
        replace('nameDef(declarable.name)', 'nameDef(declarable.name!!)');
        replace('nameDef(hasName.name)', 'nameDef(hasName.name!!)');
        replace('val body = x.body', 'val body = x.body!!');
        replace('firstStatement.expression.accept(this)', 'firstStatement.expression!!.accept(this)');
        replace('x.body.source', 'x.body!!.source');
        replace('printJsBlock(x.body,', 'printJsBlock(x.body!!,');
    }
    if (path.endsWith('/JsCatchScope.kt')) {
        replace('return parent.declareName(identifier)', 'return parent!!.declareName(identifier)');
        replace('JsCatchScope(parent, declarable)', 'JsCatchScope(parent!!, declarable)');
    }
    if (path.endsWith('/JsDeclarable.kt')) {
        replace('override fun setName(name: JsName) {\n            this.name = name', 'override fun setName(name: JsName?) {\n            this.name = name!!');
        replace('names.add(declarable.name)', 'names.add(declarable.name!!)');
    }
    if (path.endsWith('/JsIterableLoop.kt')) {
        replace('iterableExpression = visitor.acceptLvalue(iterableExpression)', 'iterableExpression = visitor.acceptLvalue(iterableExpression)!!');
    }
    assert(!/^import (java\.|com\.intellij|it\.unimi)/m.test(text), 'Remaining AST host import: ' + path);
    return { bytes: Buffer.from(text), transformations };
}

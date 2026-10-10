#!/usr/bin/env python3
"""Explicit common properties for genuine Java getter/setter consumer syntax."""
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
AST = HERE / 'portable/org/jetbrains/kotlin/js/backend/ast'


def generate():
    rows = []
    for source in sorted(AST.glob('*.kt')):
        if source.name == 'JavaProperties.kt':
            continue
        receiver = source.stem
        if receiver in ('JsContext', 'JsVisitorWithContext', 'JsVisitorWithContextImpl'):
            continue
        text = source.read_text()
        methods = re.findall(r'\bfun ((?:get|is)[A-Z]\w*)\(\):\s*([^\n={]+)', text)
        # Nested expression argument storage is represented by HasArguments.
        if receiver == 'JsExpression':
            methods = [item for item in methods if item[0] != 'getArguments']
        for method, result in methods:
            result = result.strip()
            stem = method[3:] if method.startswith('get') else method[2:]
            name = stem[0].lower() + stem[1:] if method.startswith('get') else method
            setter = 'set' + stem
            mutable = bool(re.search(r'\bfun ' + setter + r'\(', text))
            setter_value = 'value'
            # getBody really permits an unset body, while the original Java
            # setBody argument is @NotNull. Preserve both explicit boundaries.
            if receiver == 'JsFunction' and setter == 'setBody':
                setter_value = 'value!!'
            if receiver == 'JsFunction':
                result = re.sub(r'\bModifier\b', 'JsFunction.Modifier', result)
            readonly_list = result.startswith('List<')
            readonly_map = result.startswith('Map<')
            property_type = 'Mutable' + result if readonly_list or readonly_map else result
            getter = ('asJavaMutableList(' if readonly_list else 'asJavaMutableMap(') + method + '())' if readonly_list or readonly_map else method + '()'
            rows.append(('var' if mutable else 'val') + ' ' + receiver + '.' + name + ': ' + property_type + '\n'
                        + '    get() = ' + getter + '\n'
                        + ('    set(value) { ' + setter + '(' + setter_value + ') }\n' if mutable else ''))
    output = '''/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.js.backend.ast

import org.jetbrains.kotlin.js.util.asJavaMutableList
import org.jetbrains.kotlin.js.util.asJavaMutableMap

// Java synthetic properties remain separate from explicit source methods.
// Readonly Java-list values keep their actual node getter identity; this view
// exposes their Java mutation boundary without an early common mutable cast.
'''
    output += '\n'.join(rows)
    output += '''
val <T : JsNode> JsContext<T>.currentNode: T? get() = getCurrentNode()

@Suppress("UNCHECKED_CAST")
fun JsContext<*>.replaceMe(node: JsNode?) {
    (this as JsContext<JsNode>).replaceMe(node)
}

@Suppress("UNCHECKED_CAST")
fun JsContext<*>.addPrevious(node: JsNode) {
    (this as JsContext<JsNode>).addPrevious(node)
}
'''
    (AST / 'JavaProperties.kt').write_text(output)
    return len(rows)


if __name__ == '__main__':
    print('Generated', generate(), 'explicit getter/setter properties')

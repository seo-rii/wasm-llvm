#!/usr/bin/env python3
"""Encode the sealed JDK17 BMP character policy without Kotlin escape loss."""
from pathlib import Path
import base64
import json

HERE = Path(__file__).resolve().parent


def generate():
    policy = json.loads((HERE / 'character-policy.json').read_text())
    values = base64.b64decode(policy['categoryBytesBase64'], validate=True)
    assert len(values) == 65536 and all(value <= 30 for value in values)
    pages = [''.join(chr(65 + value) for value in values[i:i + 2048])
             for i in range(0, len(values), 2048)]
    header = '''/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.js.util

/** Exact BMP categories captured from the sealed JDK17 host policy. */
object AstCharacter {
    const val MAX_RADIX: Int = 36
    const val LETTER_NUMBER: Byte = 10
    const val NON_SPACING_MARK: Byte = 6
    const val COMBINING_SPACING_MARK: Byte = 8
    const val DECIMAL_DIGIT_NUMBER: Byte = 9
    const val CONNECTOR_PUNCTUATION: Byte = 23
    private val pages = arrayOf(
'''
    footer = '''    )
    fun getType(c: Char): Int = pages[c.code ushr 11][c.code and 2047].code - 65
    fun isLetter(c: Char): Boolean = getType(c) in 1..5
}
'''
    output = header + ''.join('        ' + json.dumps(page) + ',\n' for page in pages) + footer
    (HERE / 'portable/org/jetbrains/kotlin/js/util/AstCharacter.kt').write_text(output)
    print('Encoded', len(values), 'exact BMP category values')


if __name__ == '__main__':
    generate()

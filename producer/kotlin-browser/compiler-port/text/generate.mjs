/** Mechanical host adaptation of the selected official Wasm stdlib UTF-8 implementation. */
export const UTF8_REPLACEMENTS = [
  { from: 'package kotlin.text', to: 'package org.jetbrains.kotlin.portable.text' },
  { from: 'throw CharacterCodingException("Malformed sequence starting at ${index - 1}")',
    to: 'throw CompilerMalformedUtf8Exception(size + 1, index - 1)' },
  { from: 'private val REPLACEMENT_BYTE_SEQUENCE: ByteArray = byteArrayOf(0xEF.toByte(), 0xBF.toByte(), 0xBD.toByte())',
    to: 'private val REPLACEMENT_BYTE_SEQUENCE: ByteArray = byteArrayOf(0x3F)' },
  { from: '                    bytes[byteIndex++] = REPLACEMENT_BYTE_SEQUENCE[0]\n                    bytes[byteIndex++] = REPLACEMENT_BYTE_SEQUENCE[1]\n                    bytes[byteIndex++] = REPLACEMENT_BYTE_SEQUENCE[2]',
    to: '                    bytes[byteIndex++] = REPLACEMENT_BYTE_SEQUENCE[0]' },
  { from: '    } else if (byte1 and 0xF == 0xD) {\n        if (byte2 and 0xE0 != 0x80) {\n            // Surrogate code point\n            return malformed(0, index, throwOnMalformed)\n        }\n    } else if (byte2 and 0xC0 != 0x80) {',
    to: '    } else if (byte2 and 0xC0 != 0x80) {' },
  { from: '    return (byte1 shl 12) xor (byte2 shl 6) xor byte3 xor -0x1E080',
    to: '    val code = (byte1 shl 12) xor (byte2 shl 6) xor byte3 xor -0x1E080\n    // JVM replaces an encoded surrogate as one three-byte malformed sequence.\n    if (code in 0xD800..0xDFFF) return malformed(2, index, throwOnMalformed)\n    return code' },
];

export function generateCompilerUtf8(original) {
  let text = original.toString('utf8');
  for (const { from, to } of UTF8_REPLACEMENTS) {
    if (text.split(from).length !== 2) throw new Error('Official UTF-8 source boundary is not exact');
    text = text.replace(from, to);
  }
  return Buffer.from(text);
}

@file:OptIn(org.jetbrains.kotlin.config.CompilerConfiguration.Internals::class)
package org.jetbrains.kotlin.js.sourcecontentprobe
import org.jetbrains.kotlin.KtInMemoryTextSourceFile
import org.jetbrains.kotlin.config.CompilerConfiguration
import org.jetbrains.kotlin.js.portable.installRequestSourceContent
import org.jetbrains.kotlin.js.portable.requestSourceSupplier
fun rawTextObservation(): String {
    val configuration = CompilerConfiguration()
    val text = "a\uD800b\uDC00c"
    installRequestSourceContent(configuration, listOf(KtInMemoryTextSourceFile("raw", null, text)))
    return requestSourceSupplier(configuration, "raw")()!!.readText().utf16()
}

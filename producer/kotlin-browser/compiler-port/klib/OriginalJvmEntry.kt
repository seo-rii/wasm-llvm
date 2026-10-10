package org.jetbrains.kotlin.portable.klibprobe

import org.jetbrains.kotlin.library.*
import org.jetbrains.kotlin.library.components.*
import org.jetbrains.kotlin.library.impl.*
import java.nio.file.Path
import java.util.Properties
import kotlin.io.path.readBytes
import kotlin.io.path.writeBytes

fun main(args: Array<String>) {
    val root = Path.of(args[0])
    val manifest = Properties().apply { root.resolve("default/manifest").toFile().bufferedReader().use { load(it) } }
    val metadata = KlibMetadataComponentImpl(KlibLayoutReader.FromDirectory(root, ::KlibMetadataComponentLayout))
    val main = KlibIrComponentImpl(KlibLayoutReader.FromDirectory(root, KlibIrComponentLayout::createForMainIr))
    val inline = KlibIrComponentImpl(KlibLayoutReader.FromDirectory(root, KlibIrComponentLayout::createForInlinableFunctionsIr))
    val mainDebug = IrMultiArrayReader(root.resolve("default/ir/debugInfo.knd").readBytes())
    val inlineDebug = IrMultiArrayReader(root.resolve("default/ir_inlinable_functions/debugInfo.knd").readBytes())
    Path.of(args[1]).writeBytes(librarySnapshot(manifest.stringPropertyNames().associateWith(manifest::getProperty), manifest.readKonanLibraryVersioning(), metadata, main, inline, mainDebug, inlineDebug))
    println(unitSnapshot())
    println(manifestSnapshot { text -> Properties().apply { load(text.reader()) }.let { props -> props.stringPropertyNames().associateWith(props::getProperty) } })
}

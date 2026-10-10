package org.jetbrains.kotlin.portable.linkerprobe

import org.jetbrains.kotlin.library.readKonanLibraryVersioning
import java.nio.file.Files
import java.nio.file.Path
import java.util.Locale
import java.util.Properties
import java.util.jar.Manifest
import kotlin.io.path.readBytes
import kotlin.io.path.writeBytes

fun main(args: Array<String>) {
    Locale.setDefault(Locale.ROOT)
    val root = Path.of(args[0])
    val fixture = Files.walk(root).use { paths -> paths.filter(Files::isRegularFile).toList() }.associate { path ->
        root.relativize(path).toString().replace('\\', '/') to path.readBytes()
    }
    val properties = Properties().apply { load(fixture.getValue("default/manifest").decodeToString().reader()) }
    val versions = properties.readKonanLibraryVersioning()
    val manifest = properties.stringPropertyNames().associateWith { properties.getProperty(it) }
    val destination = Path.of(args[1])
    fixtureWriter(fixture, versions, manifest).writeTo(destination)
    val output = Files.walk(destination).use { paths -> paths.filter(Files::isRegularFile).toList() }.associate { path ->
        destination.relativize(path).toString().replace('\\', '/') to path.readBytes()
    }
    val directories = Files.walk(destination).use { paths -> paths.filter(Files::isDirectory).toList() }.filter { it != destination }
        .map { destination.relativize(it).toString().replace('\\', '/') }
    Path.of(args[2]).writeBytes(outputSnapshot(output, directories))
    Path.of(args[3]).writeBytes(jarObservation { Manifest(it.inputStream()).mainAttributes.getValue("Implementation-Version") }.encodeToByteArray())
    println("writer-files=" + output.size + ",directories=" + directories.size + ",jar-cases=" + jarManifestCases().size)
}

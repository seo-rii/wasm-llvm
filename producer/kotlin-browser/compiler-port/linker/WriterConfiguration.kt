package org.jetbrains.kotlin.portable.linkerprobe

import org.jetbrains.kotlin.library.KotlinLibraryVersioning
import org.jetbrains.kotlin.library.impl.BuiltInsPlatform
import org.jetbrains.kotlin.library.impl.KlibManifestComponentWriterImpl.Companion.NON_CUSTOMIZED_PROPERTY_NAMES
import org.jetbrains.kotlin.library.writer.*

/** Both observers invoke the same unchanged official writer DSL and genuine serialized stdlib table payloads. */
fun fixtureWriter(files: Map<String, ByteArray>, versions: KotlinLibraryVersioning, manifest: Map<String, String>): KlibWriter {
    val [metadata, ir] = writerData(files)
    return KlibWriter {
        manifest {
            moduleName("memory-writer-probe")
            versions(versions)
            platformAndTargets(BuiltInsPlatform.WASM, "wasm-wasi")
            customProperties {
                manifest.filterKeys { it !in NON_CUSTOMIZED_PROPERTY_NAMES }.forEach { (key, value) -> setProperty(key, value) }
                setProperty(" escape=:#!", " leading space\tline\nnext\rreturn\u000Cform\\slash=:#!")
                setProperty("unicode-한글-😀", "한글😀")
                setProperty("empty-value", "")
            }
        }
        includeMetadata(metadata)
        includeIr(ir)
    }
}

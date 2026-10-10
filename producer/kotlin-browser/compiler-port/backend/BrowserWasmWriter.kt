/* The official Wasm IR linker and binary writer produce this artifact. */
package org.jetbrains.kotlin.browser.compiler

import org.jetbrains.kotlin.backend.wasm.WasmIrModuleConfiguration
import org.jetbrains.kotlin.platform.wasm.WasmTarget
import org.jetbrains.kotlin.js.config.sourceMap
import org.jetbrains.kotlin.wasm.config.*
import org.jetbrains.kotlin.wasm.ir.ByteWriterWithOffsetWrite
import org.jetbrains.kotlin.wasm.ir.WasmBinaryData.Companion.toByteArray
import org.jetbrains.kotlin.wasm.ir.WasmModule
import org.jetbrains.kotlin.wasm.ir.convertors.WasmIrToBinary

class BrowserProgramBinary(val bytes: ByteArray, val module: WasmModule)

/** The initial console profile emits raw WASI Wasm; debug side assets are separate. */
internal fun writeBrowserProgramBinary(
    moduleConfiguration: WasmIrModuleConfiguration,
    maximumArtifactBytes: Int,
): BrowserProgramBinary {
    val configuration = moduleConfiguration.configuration
    require(configuration.get(WasmConfigurationKeys.WASM_TARGET) == WasmTarget.WASI)
    require(!configuration.getBoolean(WasmConfigurationKeys.WASM_USE_TRAPS_INSTEAD_OF_EXCEPTIONS))
    require(!configuration.wasmGenerateDwarf && !configuration.sourceMap && !configuration.wasmGenerateWat)
    require(moduleConfiguration.multimoduleOptions == null)
    require(maximumArtifactBytes > 0)

    val linkedModule = linkWasmIr(moduleConfiguration)
    val writer = ByteWriterWithOffsetWrite(maximumArtifactBytes)
    val converter = WasmIrToBinary(
        writer,
        linkedModule,
        moduleConfiguration.moduleName,
        configuration.wasmDebug,
        debugInformationGenerator = null,
    )
    converter.appendWasmModule()
    return BrowserProgramBinary(writer.getBinaryData().toByteArray(), linkedModule)
}

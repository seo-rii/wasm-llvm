package org.jetbrains.kotlin.portable.backendtext.probe

import org.jetbrains.kotlin.backend.common.BackendDiagnosticRenderers
import org.jetbrains.kotlin.backend.common.CommonBackendErrors

fun main(args: Array<String>) {
    when (args.singleOrNull()) {
        "--names" -> {
            println(StackOverflowError::class.java.name)
            println(NullPointerException::class.java.name)
        }
        "--factories" -> for (factory in CommonBackendErrors.getRendererFactory().MAP.factories.sortedBy { it.name }) println("${factory.name}:${factory.severity}")
        else -> print(observeBackendText { BackendDiagnosticRenderers.EVALUATION_ERROR_EXPLANATION.render(it) })
    }
}

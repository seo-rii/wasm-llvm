package org.jetbrains.kotlin.portable.k1profile.probe

import org.jetbrains.kotlin.analyzer.ModuleInfo
import org.jetbrains.kotlin.container.DefaultImplementation
import org.jetbrains.kotlin.resolve.PlatformDependentAnalyzerServices
import org.jetbrains.kotlin.resolve.DefaultImportsProvider
import org.jetbrains.kotlin.resolve.ImportPath

fun main() {
    val annotation = DefaultImplementation::class.java
    println("annotation-retention:" + annotation.getAnnotation(java.lang.annotation.Retention::class.java)?.value)
    println("annotation-java-target:" + annotation.getAnnotation(java.lang.annotation.Target::class.java)?.value?.joinToString { it.name })
    println("annotation-parameter:" + annotation.getMethod("impl").returnType.name)
    val analyzer = PlatformDependentAnalyzerServices::class.java
    for (name in listOf("getDefaultImportsProvider", "dependencyOnBuiltIns")) {
        val method = analyzer.getDeclaredMethod(name)
        println("analyzer-method:$name:${method.returnType.name}:${method.modifiers}:${method.parameterCount}")
    }
    println("module-policy:" + ModuleInfo.DependencyOnBuiltIns.entries.joinToString { it.name })
    println("module-delegation:" + ModuleInfo::class.java.getDeclaredMethod("dependencyOnBuiltIns").returnType.name)
    println("module-capability:" + ModuleInfo.Capability.name)
    val provider = object : DefaultImportsProvider() {
        override val platformSpecificDefaultImports = listOf(ImportPath.fromString("selected.platform.*"))
        override val defaultLowPriorityImports = listOf(ImportPath.fromString("selected.low.*"))
    }
    println("default-imports:" + provider.getDefaultImports(false).joinToString())
    println("low-priority-imports:" + provider.getDefaultImports(true).joinToString())
}

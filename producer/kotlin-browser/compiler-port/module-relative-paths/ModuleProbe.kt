/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.js.modulepathprobe

import org.jetbrains.kotlin.ir.backend.js.transformers.irToJs.*
import org.jetbrains.kotlin.js.backend.ast.getRequireName
import org.jetbrains.kotlin.js.config.ModuleKind

fun main() {
    val values=pathCorpus()
    for([i,base]in values.withIndex())for([j,target]in values.withIndex())for(kind in ModuleKind.entries) {
        val main=JsIrModuleHeader("main",base,emptySet(),mapOf("shared" to "binding"),emptySet(),null,null,null)
        val imported=JsIrModuleHeader("target",target,setOf("shared"),mapOf("shared" to "binding"),emptySet(),null,null,null)
        print("$i\t$j\t${kind.name}\t")
        try {
            val resolved=CrossModuleDependenciesResolver(kind,listOf(main,imported)).resolveCrossModuleDependencies()
            val r=resolved.getValue(main)
            val importedAs=r.imports.getValue("shared")
            println("value\t"+hex(importedAs.moduleExporter.getRequireName(true))+"\t"+hex(importedAs.exportedAs)+"\t"+r.importedModules.size+"\t"+r.transitiveExportFrom.size+"\t"+r.importsWithEffect.size+"\t"+resolved.getValue(imported).exports.size)
        }catch(t:Throwable){println(t::class.simpleName+"\t"+hex(t.message))}
    }
    // Genuine complete resolver paths involving transitive reexports and effects.
    for(kind in ModuleKind.entries)for(effect in listOf(false,true)) {
        val main=JsIrModuleHeader("main","dir/main",emptySet(),mapOf("shared" to "binding"),emptySet(),null,null,null)
        val imported=JsIrModuleHeader("target","other/module",setOf("shared"),mapOf("shared" to "binding"),emptySet(),"main",if(effect)"main" else null,null)
        print("reexport\t${kind.name}\t$effect\t")
        try {
            val r=CrossModuleDependenciesResolver(kind,listOf(main,imported)).resolveCrossModuleDependencies().getValue(main)
            println("value\t"+r.transitiveExportFrom.joinToString("|"){hex(it.externalName)}+"\t"+r.importsWithEffect.joinToString("|"){hex(it.moduleExporter.getRequireName(true))}+"\t"+r.jsImportsWithEffect.size)
        }catch(t:Throwable){println(t::class.simpleName+"\t"+hex(t.message))}
    }
}

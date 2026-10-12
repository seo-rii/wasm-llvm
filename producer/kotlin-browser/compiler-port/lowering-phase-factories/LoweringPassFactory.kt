/* Compiler host metadata adapter; factories are never invoked for introspection. */
package org.jetbrains.kotlin.portable.phaser

import kotlin.reflect.KClass
import org.jetbrains.kotlin.backend.common.ModuleLoweringPass

class LoweringPassFactory<in Context, out Pass : ModuleLoweringPass>(
    val loweringClass: KClass<out ModuleLoweringPass>,
    private val createLoweringPass: (Context) -> Pass,
) : (Context) -> Pass {
    override fun invoke(context: Context): Pass = createLoweringPass(context)
}

fun <Context, Pass : ModuleLoweringPass> loweringFactory(
    loweringClass: KClass<out ModuleLoweringPass>,
    createLoweringPass: (Context) -> Pass,
): (Context) -> Pass = LoweringPassFactory(loweringClass, createLoweringPass)

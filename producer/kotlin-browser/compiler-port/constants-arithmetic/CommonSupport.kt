package org.jetbrains.kotlin.constantsprobe
import org.jetbrains.kotlin.portable.constants.CompilerInteger
import org.jetbrains.kotlin.resolve.constants.evaluate.*
typealias Integer = CompilerInteger
fun checked(name:String,leftType:CompileTimeType,left:Integer,rightType:CompileTimeType,right:Integer):Integer? = checkBinaryOp(name,leftType,left,rightType,right)

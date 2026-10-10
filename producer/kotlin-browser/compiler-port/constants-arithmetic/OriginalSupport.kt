package org.jetbrains.kotlin.constantsprobe
import java.math.BigInteger
import org.jetbrains.kotlin.resolve.constants.evaluate.*
typealias Integer = BigInteger
fun checked(name:String,leftType:CompileTimeType,left:Integer,rightType:CompileTimeType,right:Integer):Integer? = checkBinaryOp(name,leftType,left,rightType,right)

package org.jetbrains.kotlin.constantsprobe

import org.jetbrains.kotlin.resolve.constants.evaluate.CompileTimeType

private fun quote(s:String):String = "\""+s.replace("\\","\\\\").replace("\"","\\\"").replace("\n","\\n")+"\""
private fun ByteArray.hex():String = joinToString("") { (it.toInt() and 255).toString(16).padStart(2,'0') }
private fun Integer.valueText():String = "$this/${toByteArray().hex()}/${hashCode()}/${compareTo(Integer.ZERO)}"
private fun operation(name:String,left:Integer,right:Integer):Integer = when(name) {
    "plus" -> left.add(right); "minus" -> left.subtract(right); "times" -> left.multiply(right); "div" -> left.divide(right)
    "rem" -> left.rem(right); "and" -> left.and(right); "or" -> left.or(right); else -> left.xor(right)
}
fun observation():String {
    val records=ArrayList<String>();val failures=ArrayList<String>();val identity=ArrayList<String>()
    val names=listOf("plus","minus","times","div","rem","and","or","xor")
    fun record(name:String,value:Any?) {records.add("$name=$value")}
    fun attempt(name:String,body:()->Integer?) {
        try {record(name,body()?.valueText())} catch(e:Throwable) {record(name,e::class.simpleName);failures.add("$name:${e::class.simpleName}:${e.message}")}
    }
    for(leftType in CompileTimeType.entries) for(rightType in CompileTimeType.entries) for(name in names+"unsupported") {
        attempt("dispatch.$leftType.$rightType.$name") {checked(name,leftType,Integer.valueOf(-257),rightType,Integer.valueOf(17))}
        attempt("zeroDispatch.$leftType.$rightType.$name") {checked(name,leftType,Integer.valueOf(-257),rightType,Integer.ZERO)}
    }
    for(left in -16L..16L) for(right in -16L..16L) for(name in names) {
        attempt("small.$left.$right.$name") {operation(name,Integer.valueOf(left),Integer.valueOf(right))}
    }
    val endpoints=listOf(Long.MIN_VALUE,Long.MAX_VALUE,-1L,0L,1L,2L,-2L,127L,-127L,128L,-128L,129L,-129L,255L,-255L,256L,-256L,257L,-257L,65535L,-65535L,2147483647L,-2147483648L)
    for(item in endpoints.withIndex()) {
        val value=Integer.valueOf(item.value);record("valueOf.${item.index}",value.valueText())
        record("valueOf.${item.index}.roundtripEquals",value==Integer(value.toByteArray()))
        for(other in endpoints.withIndex()) for(name in names) {
            attempt("endpoint.${item.index}.${other.index}.$name") {checked(name,CompileTimeType.LONG,value,CompileTimeType.LONG,Integer.valueOf(other.value))}
        }
    }
    var state=0x43251842
    fun bytes(size:Int):ByteArray = ByteArray(size) { state=state xor(state shl 13);state=state xor(state ushr 17);state=state xor(state shl 5);state.toByte() }
    for(size in listOf(1,2,3,7,8,9,15,16,31,32,63,64,127,128)) repeat(8) { sample ->
        val left=Integer(bytes(size));val right=Integer(bytes(if(sample%2==0)size else maxOf(1,size/2)))
        record("random.$size.$sample.inputLeft",left.valueText());record("random.$size.$sample.inputRight",right.valueText())
        for(name in names) attempt("random.$size.$sample.$name") {checked(name,CompileTimeType.INT,left,CompileTimeType.INT,right)}
        if(right!=Integer.ZERO) {
            val quotient=left.divide(right);val remainder=left.rem(right)
            record("random.$size.$sample.divisionIdentity",quotient.multiply(right).add(remainder)==left)
            val absoluteRem=if(remainder<Integer.ZERO)Integer.ZERO.subtract(remainder)else remainder
            val absoluteDivisor=if(right<Integer.ZERO)Integer.ZERO.subtract(right)else right
            record("random.$size.$sample.remainderBound",absoluteRem<absoluteDivisor)
            record("random.$size.$sample.remainderSign",remainder==Integer.ZERO||remainder.compareTo(Integer.ZERO)==left.compareTo(Integer.ZERO))
        }
        record("random.$size.$sample.equality",left==Integer(left.toByteArray()))
        record("random.$size.$sample.compareSelf",left.compareTo(Integer(left.toByteArray())))
        record("random.$size.$sample.xorSelf",left.xor(left).valueText())
        record("random.$size.$sample.andMinusOne",left.and(Integer.valueOf(-1))==left)
        record("random.$size.$sample.orMinusOne",left.or(Integer.valueOf(-1)).valueText())
        record("random.$size.$sample.inputStable",left==Integer(left.toByteArray())&&right==Integer(right.toByteArray()))
    }
    for(vector in listOf(byteArrayOf(0),byteArrayOf(0,0),byteArrayOf(-1),byteArrayOf(-1,-1),byteArrayOf(0,-1),byteArrayOf(-1,0),byteArrayOf(0,-128),byteArrayOf(-1,127))) {
        val original=vector.copyOf();val value=Integer(vector);val snapshot=value.valueText();vector.fill(33);record("bytes.${original.hex()}.inputDefensive",snapshot==value.valueText())
        val output=value.toByteArray();output.fill(77);record("bytes.${original.hex()}.outputDefensive",snapshot==value.valueText());record("bytes.${original.hex()}.value",snapshot)
        record("bytes.${original.hex()}.equalsSymmetric",value==Integer(original)&&Integer(original)==value)
    }
    try { Integer(byteArrayOf());record("bytes.empty","NO_EXCEPTION") } catch(e:Throwable){record("bytes.empty",e::class.simpleName);failures.add("bytes.empty:${e::class.simpleName}:${e.message}")}
    identity.add("valueOf.oneCached=${Integer.valueOf(1) === Integer.valueOf(1)}")
    identity.add("valueOf.zeroIsZERO=${Integer.valueOf(0) === Integer.ZERO}")
    val one=Integer.valueOf(1);identity.add("add.zeroReturnsOperand=${one.add(Integer.ZERO) === one}")
    identity.add("multiply.oneReturnsOperand=${one.multiply(Integer.valueOf(1)) === one}")
    return "{\"records\":["+records.joinToString(","){quote(it)}+"],\"failures\":["+failures.joinToString(","){quote(it)}+"],\"rawIdentity\":["+identity.joinToString(","){quote(it)}+"]}"
}

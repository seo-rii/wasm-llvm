import assert from 'node:assert/strict';
export const OPERATIONS='compiler/frontend.common/src/org/jetbrains/kotlin/resolve/constants/evaluate/OperationsMapGenerated.kt';
export const ENUM='compiler/frontend.common/src/org/jetbrains/kotlin/resolve/constants/evaluate/CompileTimeType.kt';
export const INTEGER_IMPORT='import org.jetbrains.kotlin.portable.constants.CompilerInteger as BigInteger';
export function bindOperations(bytes) { const text=bytes.toString();assert.equal(text.split('import java.math.BigInteger').length,2);return Buffer.from(text.replace('import java.math.BigInteger',INTEGER_IMPORT)); }
export function checkerBody(bytes) {const text=bytes.toString(),start=text.indexOf('fun checkBinaryOp('),end=text.indexOf('\nprivate val knownOps',start);assert(start>0&&end>start);return text.slice(start,end).trimEnd();}
export function checkerProjection(bytes,common) {return 'package org.jetbrains.kotlin.resolve.constants.evaluate\nimport org.jetbrains.kotlin.resolve.constants.evaluate.CompileTimeType.*\n'+(common?INTEGER_IMPORT:'import java.math.BigInteger')+'\n'+checkerBody(bytes)+'\n';}

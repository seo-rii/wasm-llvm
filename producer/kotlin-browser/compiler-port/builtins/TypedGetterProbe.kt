package org.jetbrains.kotlin.portable.builtins.probe

import org.jetbrains.kotlin.builtins.BuiltInsLoader
import org.jetbrains.kotlin.builtins.DefaultBuiltIns
import org.jetbrains.kotlin.serialization.deserialization.builtins.BuiltInsLoaderImpl

fun main() {
    BuiltInsLoader.registerFactory { BuiltInsLoaderImpl() }
    val value = DefaultBuiltIns()
    check(value.any === value.getAny())
    check(value.intType === value.getIntType())
    check(value.nullableAnyType == value.getNullableAnyType())
    check(value.kClass === value.getKClass())
    check(value.kMutableProperty2 === value.getKMutableProperty2())
    check(value.builtInsPackageScope === value.getBuiltInsPackageScope())
    check(value.builtInPackagesImportedByDefault === value.getBuiltInPackagesImportedByDefault())
    val external = DefaultBuiltIns(false)
    external.builtInsModule = value.builtInsModule
    check(external.string === value.string)
    var failed = false
    try { BuiltInsLoader.registerFactory { BuiltInsLoaderImpl() } } catch (_: IllegalStateException) { failed = true }
    check(failed)
    println("actual builtins typed getter and explicit factory: pass")
}

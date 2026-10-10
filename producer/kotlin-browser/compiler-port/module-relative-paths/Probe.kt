/* Copyright 2026 wasm-llvm contributors. Apache-2.0. */
package org.jetbrains.kotlin.js.modulepathprobe

fun hex(value: String?): String = value?.let { s -> buildString { for(c in s) append(c.code.toString(16).padStart(4,'0')) } } ?: "-"

fun pathCorpus(): List<String> {
    val edge=listOf("", ".", "..", "main", "main/", "./main", "../main", "/", "//", "///", "/main", "/main/", "dir/main", "dir//main///", "./dir/main", "../dir/main", "../../main", "dir/../main", "/dir/../../main", "dir/./main", "dir/..", "/dir/../C:", "C:", "C:/", "C:/main", "C:main", "D:/main", "drive:/main", "dir:C/main", "http://host/main", "//host/home/main", "dir\\main", "dir/\\main", "dir/a b", "dir/λ", "dir/한글", "dir/\u0000", "dir/\ud800", "dir/\udfff", "dir/./../main", "../..", "../../", ":/x", "a:/../x")
    val generated=ArrayList<String>()
    val segments=listOf("a", "b", ".", "..", "", "C:", "λ")
    for(a in segments)for(b in segments) {
        generated.add("$a/$b/file")
        generated.add("/$a/$b/file")
    }
    return (edge+generated).distinct()
}

fun pathRaw(): String = buildString {
    val values=pathCorpus()
    for([i,main] in values.withIndex())for([j,target] in values.withIndex()) {
        append(i).append('\t').append(j).append('\t')
        try {append("value\t").append(hex(probeRelative(main,target)))}
        catch(t:Throwable) {append(t::class.simpleName).append('\t').append(hex(t.message))}
        append('\n')
    }
}

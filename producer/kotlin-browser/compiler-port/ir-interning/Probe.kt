package org.jetbrains.kotlin.portable.interning.probe

import org.jetbrains.kotlin.backend.common.serialization.IrInterningService
import org.jetbrains.kotlin.ir.AbstractIrFileEntry
import org.jetbrains.kotlin.ir.IrFileEntry
import org.jetbrains.kotlin.ir.util.NaiveSourceBasedFileEntryImpl
import org.jetbrains.kotlin.name.Name
import org.jetbrains.kotlin.portable.interning.Hash
import org.jetbrains.kotlin.portable.interning.ObjectOpenCustomHashSet
import org.jetbrains.kotlin.portable.interning.ObjectOpenHashSet

private class CollisionFile(
    override val name: String,
    override val lineStartOffsets: IntArray = intArrayOf(0, 10, 100),
    override val maxOffset: Int = 200,
    override val firstRelevantLineIndex: Int = 0,
) : AbstractIrFileEntry() {
    override fun hashCode(): Int = 7
    override fun equals(other: Any?): Boolean = other is CollisionFile && name == other.name
}

private class IdentityFile(override val name: String) : AbstractIrFileEntry() {
    override val lineStartOffsets = intArrayOf(0)
    override val maxOffset = 20
    override val firstRelevantLineIndex = 0
    override fun hashCode(): Int = 7
    override fun equals(other: Any?): Boolean = this === other
}

private class Key(val id: Int) {
    override fun hashCode(): Int = 13
    override fun equals(other: Any?): Boolean = other is Key && id == other.id
}

fun observation(): String {
    val result = StringBuilder()
    var record = 0
    fun observe(label: String, value: Boolean) {
        check(value) { label }
        result.append(record++).append('|').append(label).append('|').append(value).append('\n')
    }
    val service = IrInterningService()
    service.reset() // Genuine reset also forces all three untouched lazy caches.
    val coordinates = NaiveSourceBasedFileEntryImpl("coordinates", intArrayOf(0, 10, 100), 200, 3)
    val offsets = intArrayOf(-2, -1, 0, 9, 10, 99, 100, 101, 200)
    val lines = intArrayOf(0, -1, 3, 3, 4, 4, 5, 5, 5)
    val columns = intArrayOf(0, -1, 0, 9, 0, 89, 0, 1, 100)
    for (index in offsets.indices) {
        observe("genuine-file-line", coordinates.getLineNumber(offsets[index]) == lines[index])
        observe("genuine-file-column", coordinates.getColumnNumber(offsets[index]) == columns[index])
        val position = coordinates.getLineAndColumnNumbers(offsets[index])
        observe("genuine-file-coordinate", position.line == lines[index] && position.column == columns[index])
    }
    val partial = NaiveSourceBasedFileEntryImpl("partial", intArrayOf(20, 30), 50, 4)
    observe("genuine-partial-coordinate", partial.getLineNumber(0) == 4 && partial.getColumnNumber(0) == -1)
    val empty = NaiveSourceBasedFileEntryImpl("empty")
    observe("genuine-empty-coordinate", empty.getLineNumber(0) == -1 && empty.getColumnNumber(0) == -1)
    val strings = Array(4096) { ("κotlin-" + it + "-\uD83D\uDE00").toCharArray().concatToString() }
    for (index in strings.indices) observe("string-insert", service.string(strings[index]) === strings[index])
    for (index in strings.indices.reversed()) {
        val duplicate = strings[index].toCharArray().concatToString()
        observe("string-canonical", service.string(duplicate) === strings[index])
    }
    val names = Array(2048) { Name.identifier("name-" + it) }
    for (index in names.indices) observe("name-insert", service.name(names[index]) === names[index])
    for (index in names.indices.reversed()) observe("name-canonical", service.name(Name.identifier(names[index].asString())) === names[index])
    val ordinary = Name.identifier("<same>")
    val special = Name.special("<same>")
    observe("name-special-distinct", service.name(ordinary) === ordinary && service.name(special) === special)
    observe("name-special-canonical", service.name(Name.special("<same>")) === special)
    val files = Array(1024) { NaiveSourceBasedFileEntryImpl("file-" + (it % 29), intArrayOf(0, it, it + 3), it + 10, it % 5) }
    for (file in files) observe("naive-insert", service.fileEntry(file) === file)
    for (file in files.reversed()) {
        val duplicate = NaiveSourceBasedFileEntryImpl(file.name, file.lineStartOffsets.copyOf(), file.maxOffset, file.firstRelevantLineIndex)
        observe("naive-structural", service.fileEntry(duplicate) === file)
        val changedMax = NaiveSourceBasedFileEntryImpl(file.name, file.lineStartOffsets.copyOf(), file.maxOffset + 1, file.firstRelevantLineIndex)
        observe("naive-max-distinct", service.fileEntry(changedMax) === changedMax)
        val changedFirst = NaiveSourceBasedFileEntryImpl(file.name, file.lineStartOffsets.copyOf(), file.maxOffset, file.firstRelevantLineIndex + 1)
        observe("naive-first-distinct", service.fileEntry(changedFirst) === changedFirst)
        val changedName = NaiveSourceBasedFileEntryImpl(file.name + ".other", file.lineStartOffsets.copyOf(), file.maxOffset, file.firstRelevantLineIndex)
        observe("naive-name-distinct", service.fileEntry(changedName) === changedName)
        val changedLines = NaiveSourceBasedFileEntryImpl(file.name, intArrayOf(-1, file.maxOffset), file.maxOffset, file.firstRelevantLineIndex)
        observe("naive-lines-distinct", service.fileEntry(changedLines) === changedLines)
    }
    val collisions = Array(512) { CollisionFile("collision-" + it) }
    for (file in collisions) observe("polymorphic-collision-insert", service.fileEntry(file) === file)
    for (file in collisions.reversed()) observe("polymorphic-equality", service.fileEntry(CollisionFile(file.name, maxOffset = -10)) === file)
    val identities = Array(64) { IdentityFile("identity-" + it) }
    for (file in identities) {
        observe("identity-file-insert", service.fileEntry(file) === file)
        observe("identity-file-reuse", service.fileEntry(file) === file)
        val distinct = IdentityFile(file.name)
        observe("identity-file-distinct", service.fileEntry(distinct) === distinct)
    }
    service.reset()
    for (index in strings.indices.reversed()) {
        val fresh = strings[index].toCharArray().concatToString()
        observe("reset-string", service.string(fresh) === fresh)
        observe("reset-string-repeat", service.string(strings[index]) === fresh)
    }
    for (name in names) {
        val fresh = Name.identifier(name.asString())
        observe("reset-name", service.name(fresh) === fresh)
        observe("reset-name-repeat", service.name(name) === fresh)
    }
    for (file in files) {
        val fresh = NaiveSourceBasedFileEntryImpl(file.name, file.lineStartOffsets.copyOf(), file.maxOffset, file.firstRelevantLineIndex)
        observe("reset-file", service.fileEntry(fresh) === fresh)
        observe("reset-file-repeat", service.fileEntry(file) === fresh)
    }
    val simple = ObjectOpenHashSet<Key?>()
    observe("simple-null", simple.addOrGet(null) == null && simple.addOrGet(null) == null)
    val keys = Array(512) { Key(it) }
    for (key in keys) observe("simple-collision-insert", simple.addOrGet(key) === key)
    for (key in keys.reversed()) observe("simple-collision-canonical", simple.addOrGet(Key(key.id)) === key)
    simple.clear()
    for (key in keys) { val fresh = Key(key.id); observe("simple-clear", simple.addOrGet(fresh) === fresh) }
    var hashCalls = 0
    val strategy = object : Hash.Strategy<Key> {
        override fun hashCode(value: Key?): Int { hashCalls++; return -13 }
        override fun equals(first: Key?, second: Key?): Boolean = (first?.id ?: 0) == (second?.id ?: 0)
    }
    val custom = ObjectOpenCustomHashSet(strategy)
    val zero = Key(0)
    observe("custom-null-equivalent", custom.addOrGet(zero) === zero && custom.addOrGet(Key(0)) === zero)
    for (key in keys.drop(1)) observe("custom-collision-insert", custom.addOrGet(key) === key)
    for (key in keys.drop(1).reversed()) observe("custom-collision-canonical", custom.addOrGet(Key(key.id)) === key)
    observe("custom-hash-rehash", hashCalls > 2 * (keys.size - 1))
    custom.clear()
    observe("custom-null-equivalent-clear", custom.addOrGet(Key(0)) !== zero)
    val nullable = ObjectOpenCustomHashSet(object : Hash.Strategy<Key?> {
        override fun hashCode(value: Key?): Int = 1
        override fun equals(first: Key?, second: Key?): Boolean = (first?.id ?: 0) == (second?.id ?: 0)
    })
    observe("custom-null-first", nullable.addOrGet(null) == null && nullable.addOrGet(Key(0)) == null)
    nullable.clear()
    val sentinel = Key(0)
    observe("custom-sentinel-first", nullable.addOrGet(sentinel) === sentinel && nullable.addOrGet(null) === sentinel)
    service.reset()
    service.reset()
    val finalName = Name.identifier("final")
    observe("repeated-reset", service.name(finalName) === finalName)
    return result.toString()
}

/*
 * Copyright 2010-2016 JetBrains s.r.o.
 * Use of this source code is governed by the Apache 2.0 license that can be found in the license/LICENSE.txt file.
 */
package org.jetbrains.kotlin.utils

import kotlin.jvm.JvmName

/** Official zero/singleton/array storage algorithm, on the common MutableList contract. */
@Suppress("UNCHECKED_CAST")
open class SmartList<E>() : AbstractMutableList<E>(), RandomAccess {
    private var mySize = 0
    private var myElem: Any? = null

    constructor(element: E) : this() { add(element) }

    constructor(elements: Collection<E>) : this() {
        val size = elements.size
        if (size == 1) {
            add(if (elements is List) elements[0] else elements.iterator().next())
        } else if (size > 0) {
            mySize = size
            myElem = elements.toTypedArrayErased()
        }
    }

    constructor(vararg elements: E) : this() {
        if (elements.size == 1) add(elements[0])
        else if (elements.isNotEmpty()) { mySize = elements.size; myElem = elements.copyOf() }
    }

    private fun Collection<E>.toTypedArrayErased(): Array<Any?> {
        val result = arrayOfNulls<Any?>(size)
        var index = 0
        for (element in this) result[index++] = element
        return result
    }

    private fun array(): Array<Any?> = myElem as Array<Any?>

    private fun checkIndex(index: Int) {
        if (index < 0 || index >= mySize) throw IndexOutOfBoundsException("Index: $index, Size: $mySize")
    }

    override val size: Int get() = mySize

    override fun get(index: Int): E {
        checkIndex(index)
        return (if (mySize == 1) myElem else array()[index]) as E
    }

    override fun add(element: E): Boolean {
        when (mySize) {
            0 -> myElem = element
            1 -> myElem = arrayOf(myElem, element)
            else -> {
                var array = array()
                val oldCapacity = array.size
                if (mySize >= oldCapacity) {
                    var newCapacity = oldCapacity * 3 / 2 + 1
                    val minCapacity = mySize + 1
                    if (newCapacity < minCapacity) newCapacity = minCapacity
                    val oldArray = array
                    array = arrayOfNulls(newCapacity)
                    oldArray.copyInto(array, 0, 0, oldCapacity)
                    myElem = array
                }
                array[mySize] = element
            }
        }
        mySize++
        modCount++
        return true
    }

    override fun add(index: Int, element: E) {
        if (index < 0 || index > mySize) throw IndexOutOfBoundsException("Index: $index, Size: $mySize")
        if (mySize == 0) myElem = element
        else if (mySize == 1 && index == 0) myElem = arrayOf(element, myElem)
        else {
            val array = arrayOfNulls<Any?>(mySize + 1)
            if (mySize == 1) array[0] = myElem
            else {
                val oldArray = array()
                oldArray.copyInto(array, 0, 0, index)
                oldArray.copyInto(array, index + 1, index, mySize)
            }
            array[index] = element
            myElem = array
        }
        mySize++
        modCount++
    }

    override fun clear() { myElem = null; mySize = 0; modCount++ }

    override fun set(index: Int, element: E): E {
        checkIndex(index)
        val oldValue: E
        if (mySize == 1) { oldValue = myElem as E; myElem = element }
        else { val array = array(); oldValue = array[index] as E; array[index] = element }
        return oldValue
    }

    override fun removeAt(index: Int): E {
        checkIndex(index)
        val oldValue: E
        if (mySize == 1) { oldValue = myElem as E; myElem = null }
        else {
            val array = array()
            oldValue = array[index] as E
            if (mySize == 2) myElem = array[1 - index]
            else {
                val numMoved = mySize - index - 1
                if (numMoved > 0) array.copyInto(array, index, index + 1, mySize)
                array[mySize - 1] = null
            }
        }
        mySize--
        modCount++
        return oldValue
    }

    override fun indexOf(element: E): Int {
        val iterator = listIterator()
        while (iterator.hasNext()) if (element == iterator.next()) return iterator.previousIndex()
        return -1
    }

    override fun lastIndexOf(element: E): Int {
        val iterator = listIterator(size)
        while (iterator.hasPrevious()) if (element == iterator.previous()) return iterator.nextIndex()
        return -1
    }

    override fun remove(element: E): Boolean {
        val iterator = iterator()
        while (iterator.hasNext()) if (element == iterator.next()) { iterator.remove(); return true }
        return false
    }

    override fun addAll(elements: Collection<E>): Boolean {
        var modified = false
        for (element in elements) if (add(element)) modified = true
        return modified
    }

    override fun addAll(index: Int, elements: Collection<E>): Boolean {
        if (index < 0 || index > size) throw IndexOutOfBoundsException("Index: $index, Size: $size")
        var cursor = index
        var modified = false
        for (element in elements) { add(cursor++, element); modified = true }
        return modified
    }

    override fun removeAll(elements: Collection<E>): Boolean {
        var modified = false
        val iterator = iterator()
        while (iterator.hasNext()) if (elements.contains(iterator.next())) { iterator.remove(); modified = true }
        return modified
    }

    override fun retainAll(elements: Collection<E>): Boolean {
        var modified = false
        val iterator = iterator()
        while (iterator.hasNext()) if (!elements.contains(iterator.next())) { iterator.remove(); modified = true }
        return modified
    }

    override fun iterator(): MutableIterator<E> = when (mySize) {
        0 -> EmptyIterator as MutableIterator<E>
        1 -> SingletonIterator()
        else -> IteratorImpl()
    }

    private object EmptyIterator : MutableIterator<Nothing> {
        override fun hasNext(): Boolean = false
        override fun next(): Nothing = throw NoSuchElementException()
        override fun remove(): Unit = throw IllegalStateException()
    }

    private inner class SingletonIterator : MutableIterator<E> {
        private var visited = false
        private val initialModCount = modCount
        override fun hasNext(): Boolean = !visited
        override fun next(): E {
            if (visited) throw NoSuchElementException()
            visited = true
            checkCoModification()
            return myElem as E
        }
        private fun checkCoModification() {
            if (modCount != initialModCount) throw ConcurrentModificationException("ModCount: $modCount; expected: $initialModCount")
        }
        override fun remove() { checkCoModification(); clear() }
    }

    private open inner class IteratorImpl : MutableIterator<E> {
        protected var cursor = 0
        protected var lastRet = -1
        protected var expectedModCount = modCount
        protected fun checkCoModification() {
            if (modCount != expectedModCount) throw ConcurrentModificationException()
        }
        override fun hasNext(): Boolean = cursor != size
        override fun next(): E {
            checkCoModification()
            val index = cursor
            if (index >= size) throw NoSuchElementException()
            return try { get(index).also { cursor = index + 1; lastRet = index } }
            catch (error: IndexOutOfBoundsException) { checkCoModification(); throw NoSuchElementException() }
        }
        override fun remove() {
            if (lastRet < 0) throw IllegalStateException()
            checkCoModification()
            try { removeAt(lastRet); cursor = lastRet; lastRet = -1; expectedModCount = modCount }
            catch (error: IndexOutOfBoundsException) { throw ConcurrentModificationException() }
        }
    }

    override fun listIterator(): MutableListIterator<E> = listIterator(0)
    override fun listIterator(index: Int): MutableListIterator<E> {
        if (index < 0 || index > size) throw IndexOutOfBoundsException("Index: $index, Size: $size")
        return ListIteratorImpl(index)
    }

    private inner class ListIteratorImpl(index: Int) : IteratorImpl(), MutableListIterator<E> {
        init { cursor = index }
        override fun hasPrevious(): Boolean = cursor != 0
        override fun nextIndex(): Int = cursor
        override fun previousIndex(): Int = cursor - 1
        override fun previous(): E {
            checkCoModification()
            val index = cursor - 1
            if (index < 0) throw NoSuchElementException()
            return try { get(index).also { cursor = index; lastRet = index } }
            catch (error: IndexOutOfBoundsException) { checkCoModification(); throw NoSuchElementException() }
        }
        override fun set(element: E) {
            if (lastRet < 0) throw IllegalStateException()
            checkCoModification()
            try { this@SmartList.set(lastRet, element) }
            catch (error: IndexOutOfBoundsException) { throw ConcurrentModificationException() }
        }
        override fun add(element: E) {
            checkCoModification()
            try { val index = cursor; this@SmartList.add(index, element); cursor = index + 1; lastRet = -1; expectedModCount = modCount }
            catch (error: IndexOutOfBoundsException) { throw ConcurrentModificationException() }
        }
    }

    @JvmName("sortPortable")
    fun sort(comparator: Comparator<in E>?) = sortElements(comparator)

    // Kotlin's Java collection mapping hides sort; this host name exposes the same algorithm.
    internal fun sortElements(comparator: Comparator<in E>?) {
        if (mySize >= 2) {
            val effective: Comparator<in E> = comparator ?: Comparator<E> { first, second -> (first as Comparable<Any?>).compareTo(second) }
            array().sortWith(Comparator { first, second -> effective.compare(first as E, second as E) }, 0, mySize)
        }
    }

    fun getModificationCount(): Int = modCount
    @get:JvmName("modificationCountProperty")
    val modificationCount: Int get() = getModificationCount()

    public override fun toArray(): Array<Any?> = arrayOfNulls<Any?>(mySize).also { target -> for (index in 0 until mySize) target[index] = get(index) }

    public override fun <T> toArray(a: Array<T>): Array<T> {
        val aLength = a.size
        if (mySize == 1) {
            if (aLength != 0) a[0] = myElem as T
            else return (a.copyOf(1) as Array<T>).also { it[0] = myElem as T }
        } else if (aLength < mySize) {
            val result = a.copyOf(mySize) as Array<T>
            for (index in 0 until mySize) result[index] = array()[index] as T
            return result
        } else if (mySize != 0) {
            for (index in 0 until mySize) a[index] = array()[index] as T
        }
        if (aLength > mySize) a[mySize] = null as T
        return a
    }

    fun trimToSize() {
        if (mySize < 2) return
        val array = array()
        if (mySize < array.size) { modCount++; myElem = array.copyOf(mySize) }
    }
}

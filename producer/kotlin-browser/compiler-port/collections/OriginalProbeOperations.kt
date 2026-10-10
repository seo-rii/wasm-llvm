package org.jetbrains.kotlin.portable.collectionsprobe

import org.jetbrains.kotlin.utils.SmartList

fun <E> probeSort(list: SmartList<E>, comparator: Comparator<in E>?) = OriginalCollectionsBridge.sort(list, comparator)

package org.jetbrains.kotlin.portable.collectionsprobe;

import java.util.Comparator;
import org.jetbrains.kotlin.utils.SmartList;

/** JVM observer access to the real member hidden by Kotlin's Java collection mapping. */
public final class OriginalCollectionsBridge {
    private OriginalCollectionsBridge() {}
    public static <E> void sort(SmartList<E> list, Comparator<? super E> comparator) {
        list.sort(comparator);
    }
}

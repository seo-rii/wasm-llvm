    abstract class FlagField<E> protected constructor(val offset: Int, val bitWidth: Int) {
        abstract fun get(flags: Int): E?
        abstract fun toFlags(value: E): Int

        companion object {
            fun <E : Internal.EnumLite> after(previousField: FlagField<*>, values: Array<E>): FlagField<E> =
                EnumLiteFlagField(previousField.offset + previousField.bitWidth, values)

            fun <E : Internal.EnumLite> first(values: Array<E>): FlagField<E> = EnumLiteFlagField(0, values)
            fun booleanFirst(): BooleanFlagField = BooleanFlagField(0)
            fun booleanAfter(previousField: FlagField<*>): BooleanFlagField =
                BooleanFlagField(previousField.offset + previousField.bitWidth)
        }
    }

    class BooleanFlagField(offset: Int) : FlagField<Boolean>(offset, 1) {
        override fun get(flags: Int): Boolean = (flags and (1 shl offset)) != 0
        override fun toFlags(value: Boolean): Int = if (value) 1 shl offset else 0
        fun invert(flags: Int): Int = flags xor (1 shl offset)
    }

    private class EnumLiteFlagField<E : Internal.EnumLite>(offset: Int, private val values: Array<E>) :
        FlagField<E>(offset, bitWidth(values)) {

        override fun get(flags: Int): E? {
            val maskUnshifted = (1 shl bitWidth) - 1
            val mask = maskUnshifted shl offset
            val value = (flags and mask) shr offset
            for (entry in values) if (entry.getNumber() == value) return entry
            return null
        }

        override fun toFlags(value: E): Int = value.getNumber() shl offset

        companion object {
            private fun <E> bitWidth(enumEntries: Array<E>): Int {
                val length = enumEntries.size - 1
                if (length == 0) return 1
                for (i in 31 downTo 0) if ((length and (1 shl i)) != 0) return i + 1
                error("Empty enum")
            }
        }
    }

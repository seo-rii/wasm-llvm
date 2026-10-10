        @JvmStatic
        fun <D : DeclarationDescriptor> getParentOfType(descriptor: DeclarationDescriptor?, aClass: java.lang.Class<D>): D? =
            getParentOfType(descriptor, aClass, true)

        @JvmStatic
        @Suppress("UNCHECKED_CAST")
        fun <D : DeclarationDescriptor> getParentOfType(descriptor: DeclarationDescriptor?, aClass: java.lang.Class<D>, strict: Boolean): D? {
            if (descriptor == null) return null
            var current = if (strict) descriptor.containingDeclaration else descriptor
            while (current != null) {
                if (aClass.isInstance(current)) return current as D
                current = current.containingDeclaration
            }
            return null
        }

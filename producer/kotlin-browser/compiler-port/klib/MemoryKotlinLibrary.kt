package org.jetbrains.kotlin.library.impl

import org.jetbrains.kotlin.library.*
import org.jetbrains.kotlin.library.components.*
import org.jetbrains.kotlin.portable.klib.KlibByteLimits
import org.jetbrains.kotlin.portable.klib.ManifestProperties
import org.jetbrains.kotlin.portable.klib.klibSha256
import org.jetbrains.kotlin.portable.source.LibraryPath

/** A logical KLIB entry, with the expected digest supplied by the approved asset index. */
class KlibFileEntry(val path: String, val bytes: ByteArray, val sha256: String)

/** Immutable, bounded file index. Digests are checked by the trusted host before any compiler reader sees bytes. */
class VerifiedKlibFileSet private constructor(
    private val files: Map<String, ByteArray>,
    private val directories: Set<String>,
) {
    val filePaths: Set<String> get() = files.keys.toSet()
    val directoryPaths: Set<String> get() = directories.toSet()
    fun read(path: String): ByteArray = borrow(path).copyOf()
    fun contains(path: String): Boolean = path in files
    internal fun borrow(path: String): ByteArray = files[path] ?: error("Missing KLIB file: $path")

    internal fun children(directory: String): List<String> {
        val prefix = "$directory/"
        return (files.keys.asSequence() + directories.asSequence())
            .filter { it.startsWith(prefix) }
            .map { it.removePrefix(prefix).substringBefore('/') }
            .filter { it.isNotEmpty() }.distinct().sorted().toList()
    }

    internal fun hasDirectory(path: String): Boolean = path in directories

    companion object {
        const val MAX_FILES: Int = 16384
        const val MAX_DECODED_BYTES: Long = 128L * 1024 * 1024

        /** Each digest must come from the approved host index. The default verifier calculates SHA-256 from the owned bytes. */
        fun verify(
            entries: List<KlibFileEntry>,
            explicitDirectories: List<String> = emptyList(),
            hashMatches: (ByteArray, String) -> Boolean = { bytes, expected -> klibSha256(bytes) == expected },
        ): VerifiedKlibFileSet {
            require(entries.size <= MAX_FILES && explicitDirectories.size <= MAX_FILES) { "Too many KLIB entries" }
            val files = linkedMapOf<String, ByteArray>()
            val directories = linkedSetOf<String>()
            var totalBytes = 0L
            fun validate(path: String) {
                require(path.length <= 4096 && !LibraryPath(path).isAbsolute && path.count { it == '/' } < 32) {
                    "Invalid relative KLIB path"
                }
            }
            fun addParents(path: String) {
                var parent = path.substringBeforeLast('/', "")
                while (parent.isNotEmpty()) {
                    directories.add(parent)
                    parent = parent.substringBeforeLast('/', "")
                }
            }
            val seenDirectories = mutableSetOf<String>()
            for (directory in explicitDirectories) {
                validate(directory)
                require(seenDirectories.add(directory)) { "Duplicate KLIB directory" }
                directories.add(directory)
                addParents(directory)
            }
            for (entry in entries) {
                validate(entry.path)
                require(entry.path !in files) { "Duplicate KLIB file" }
                require(entry.sha256.length == 64 && entry.sha256.all { it in '0'..'9' || it in 'a'..'f' }) { "Invalid KLIB digest" }
                require(entry.bytes.size <= KlibByteLimits.MAX_BUFFER_BYTES) { "KLIB file exceeds the byte limit" }
                totalBytes += entry.bytes.size
                require(totalBytes <= MAX_DECODED_BYTES) { "KLIB bundle exceeds the decoded byte limit" }
                val ownedBytes = entry.bytes.copyOf()
                require(hashMatches(ownedBytes, entry.sha256)) { "KLIB file digest mismatch: ${entry.path}" }
                files[entry.path] = ownedBytes
                addParents(entry.path)
            }
            require(files.keys.none { it in directories }) { "KLIB file shadows a directory" }
            return VerifiedKlibFileSet(files, directories)
        }
    }
}

/** Real official KLIB interfaces over an immutable verified file index; no filesystem or dynamic library discovery. */
class MemoryKotlinLibrary(
    override val path: LibraryPath,
    private val files: VerifiedKlibFileSet,
) : KotlinLibrary {
    override val canonicalPath: LibraryPath = path.toAbsolutePath()
    override val attributes: KlibAttributes = KlibAttributes()
    override val manifestProperties: ManifestProperties =
        ManifestProperties.fromUtf8(files.borrow("default/manifest")).freeze()
    override val versions: KotlinLibraryVersioning = manifestProperties.readKonanLibraryVersioning()
    private val metadataComponent: KlibMetadataComponent = MemoryMetadataComponent(files)
    private val mainIr: KlibIrComponent? = MemoryIrComponent.createIfPresent(files, "ir")
    private val inlinableIr: KlibIrComponent? = MemoryIrComponent.createIfPresent(files, "ir_inlinable_functions")

    init {
        require(!manifestProperties.getProperty(KLIB_PROPERTY_UNIQUE_NAME).isNullOrEmpty()) { "KLIB manifest has no unique_name" }
    }

    override fun <KC : KlibComponent> getComponent(kind: KlibComponent.Kind<KC, *>): KC? {
        val component = when (kind) {
            KlibMetadataComponent.Kind -> metadataComponent
            KlibIrComponent.Kind.Main -> mainIr
            KlibIrComponent.Kind.InlinableFunctions -> inlinableIr
            else -> null // The official component contract returns null for an absent component kind.
        }
        @Suppress("UNCHECKED_CAST")
        return component as KC?
    }

    override fun toString(): String = "KotlinLibrary($path)"
}

private class MemoryMetadataComponent(private val files: VerifiedKlibFileSet) : KlibMetadataComponent {
    private val layout = KlibMetadataComponentLayout(LibraryPath("/"))
    private fun relative(path: LibraryPath): String = path.value.removePrefix("/")
    private val headerPath = relative(layout.moduleHeaderFile)

    init { require(files.contains(headerPath)) { "KLIB has no metadata module header" } }

    override val moduleHeaderData: ByteArray get() = files.read(headerPath)

    override fun getPackageFragmentNames(packageFqName: String): Set<String> {
        val names = files.children(relative(layout.getPackageFragmentsDir(packageFqName))).mapNotNull { filename ->
            filename.substringBeforeLast(KlibMetadataConstants.KLIB_METADATA_FILE_EXTENSION_WITH_DOT, "").takeIf { it.isNotEmpty() }
        }
        check(names.distinct().size == names.size) { "Duplicated KLIB package fragment names" }
        return names.sorted().toSet()
    }

    override fun getPackageFragment(packageFqName: String, fragmentName: String): ByteArray =
        files.read(relative(layout.getPackageFragmentFile(packageFqName, fragmentName)))

    override fun getPackageNames(): Set<String> = files.children(relative(layout.metadataDir)).mapNotNullTo(linkedSetOf()) {
        when {
            it.startsWith(KlibMetadataConstants.KLIB_ROOT_PACKAGE_FRAGMENT_FOLDER_NAME) -> ""
            it.startsWith(KlibMetadataConstants.KLIB_NONROOT_PACKAGE_FRAGMENT_FOLDER_PREFIX) ->
                it.removePrefix(KlibMetadataConstants.KLIB_NONROOT_PACKAGE_FRAGMENT_FOLDER_PREFIX).trimEnd('/')
            else -> null
        }
    }
}

private class MemoryIrComponent(private val files: VerifiedKlibFileSet, private val folder: String) : AbstractKlibIrComponentImpl() {
    private fun file(name: String): String = "default/$folder/$name"
    private fun array(name: String): IrArrayReader = IrArrayReader { files.borrow(file(name)) }
    private fun multi(name: String): IrMultiArrayReader = IrMultiArrayReader { files.borrow(file(name)) }
    private fun optionalMulti(name: String): IrMultiArrayReader? = if (files.contains(file(name))) multi(name) else null

    override val irFiles: IrArrayReader = array(KlibIrConstants.KLIB_IR_FILES_FILE_NAME)
    override val irFileEntries: IrMultiArrayReader? = optionalMulti(KlibIrConstants.KLIB_IR_FILE_ENTRIES_FILE_NAME)
    override val combinedDeclarations: DeclarationIdMultiTableReader = DeclarationIdMultiTableReader { files.borrow(file(KlibIrConstants.KLIB_IR_DECLARATIONS_FILE_NAME)) }
    override val bodies: IrMultiArrayReader = multi(KlibIrConstants.KLIB_IR_BODIES_FILE_NAME)
    override val types: IrMultiArrayReader = multi(KlibIrConstants.KLIB_IR_TYPES_FILE_NAME)
    override val signatures: IrMultiArrayReader = multi(KlibIrConstants.KLIB_IR_SIGNATURES_FILE_NAME)
    override val signatureDebugInfos: IrMultiArrayReader? = optionalMulti(KlibIrConstants.KLIB_IR_DEBUG_INFO_FILE_NAME)
    override val stringLiterals: IrMultiArrayReader = multi(KlibIrConstants.KLIB_IR_STRINGS_FILE_NAME)

    init {
        val rows = irFiles.entryCount()
        require(listOfNotNull(irFileEntries, bodies, types, signatures, signatureDebugInfos, stringLiterals).all { it.rowCount() == rows }) {
            "KLIB IR component tables have inconsistent file counts"
        }
        require(IrArrayReader { files.borrow(file(KlibIrConstants.KLIB_IR_DECLARATIONS_FILE_NAME)) }.entryCount() == rows) {
            "KLIB declaration table has an inconsistent file count"
        }
    }

    companion object {
        fun createIfPresent(files: VerifiedKlibFileSet, folder: String): KlibIrComponent? {
            if (!files.hasDirectory("default/$folder")) return null
            val required = listOf(KlibIrConstants.KLIB_IR_FILES_FILE_NAME, KlibIrConstants.KLIB_IR_DECLARATIONS_FILE_NAME,
                KlibIrConstants.KLIB_IR_BODIES_FILE_NAME, KlibIrConstants.KLIB_IR_TYPES_FILE_NAME,
                KlibIrConstants.KLIB_IR_SIGNATURES_FILE_NAME, KlibIrConstants.KLIB_IR_STRINGS_FILE_NAME)
            require(required.all { files.contains("default/$folder/$it") }) { "Incomplete KLIB IR component: $folder" }
            return MemoryIrComponent(files, folder)
        }
    }
}

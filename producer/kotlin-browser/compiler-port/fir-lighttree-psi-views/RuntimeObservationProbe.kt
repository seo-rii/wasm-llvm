/* Runs the extracted method bodies with explicit payload inputs, not a compiler pipeline. */
package org.jetbrains.kotlin.portable.psiviews.probe

import org.jetbrains.kotlin.KtSourceFileLinesMappingFromLineStartOffsets
import org.jetbrains.kotlin.toSourceLinesMapping
import org.jetbrains.kotlin.lexer.KtTokens
import org.jetbrains.kotlin.ir.util.NaiveSourceBasedFileEntryImpl

private fun offsets(value: OffsetPayload): String = value.startOffset.toString() + ":" + value.endOffset

fun psiViewsSnapshot(): String {
    val output = StringBuilder()
    fun record(id: String, value: Any?) { output.append(id).append('\t').append(value).append('\n') }
    val kinds = listOf(SourceKindPayload.Real, SourceKindPayload.OrdinaryFake,
        SourceKindPayload.DataClassGeneratedMembers.Member, SourceKindPayload.ImplicitThisReceiverExpression,
        SourceKindPayload.ImplicitContextParameterArgument, SourceKindPayload.DefaultAccessor.Getter)
    for ([index, source] in (listOf<SourcePayload?>(null) + kinds.map { sourceFixture(it) }).withIndex()) {
        val element = ElementPayload(source)
        record("psi/$index", element.psi)
        record("psi/$index/reads", element.sourceReads)
        record("realPsi/$index", element.realPsi)
        record("realPsi/$index/reads", element.sourceReads)
        var calls = 0
        record("offset/$index/plain", offsets(source.convertWithOffsets(null) { start, end ->
            calls++; OffsetPayload(start, end)
        }))
        record("offset/$index/calls", calls)
        record("offset/$index/keyword", offsets(source.convertWithOffsets(KtTokens.VAL_VAR, ::OffsetPayload)))
        record("offset/$index/element", offsets(element.convertWithOffsets(::OffsetPayload)))
        val statement = StatementPayload(source)
        record("offset/$index/selector", offsets(statement.convertWithOffsets(ReferencePayload(source), ::OffsetPayload)))
        record("offset/$index/selector-source-reads", statement.sourceReads)
        val marker = IllegalStateException("callback-marker")
        var identical = false
        try {
            source.convertWithOffsets<Nothing>(null) { _, _ -> throw marker }
        } catch (failure: Throwable) { identical = failure === marker }
        record("offset/$index/throw-identity", identical)
    }
    for (getter in listOf("psi", "realPsi")) {
        val marker = IllegalStateException("source-marker")
        val element = ElementPayload(sourceFixture(), marker)
        var identical = false
        try { if (getter == "psi") element.psi else element.realPsi }
        catch (failure: Throwable) { identical = failure === marker }
        record("source-failure/$getter", identical)
        record("source-failure/$getter/reads", element.sourceReads)
    }
    for ([index, value] in listOf(null, sourceFixture()).withIndex()) {
        var evaluations = 0
        fun receiver(): SourcePayload? { evaluations++; return value }
        record("nullable-receiver/$index/offset", offsets(receiver().convertWithOffsets(null, ::OffsetPayload)))
        record("nullable-receiver/$index/evaluations", evaluations)
    }
    for ([index, referenceSource] in listOf(null, sourceFixture(),
        sourceFixture(SourceKindPayload.ImplicitContextParameterArgument)).withIndex()) {
        val statement = StatementPayload(sourceFixture())
        val reference = ReferencePayload(referenceSource)
        val order = mutableListOf<String>()
        statement.onSourceRead = { order.add("statement") }
        reference.onSourceRead = { order.add("reference") }
        record("selector-order/$index/offset", offsets(statement.convertWithOffsets(reference, ::OffsetPayload)))
        record("selector-order/$index/evaluations", order.joinToString(","))
    }
    for (receiver in listOf("statement", "reference")) {
        val marker = IllegalStateException("selector-source-marker")
        val statement = StatementPayload(sourceFixture())
        val reference = ReferencePayload(sourceFixture())
        if (receiver == "statement") statement.sourceFailure = marker else reference.sourceFailure = marker
        var identical = false
        var callbacks = 0
        try { statement.convertWithOffsets(reference) { start, end -> callbacks++; OffsetPayload(start, end) } }
        catch (failure: Throwable) { identical = failure === marker }
        record("selector-failure/$receiver/identity", identical)
        record("selector-failure/$receiver/statement-reads", statement.sourceReads)
        record("selector-failure/$receiver/reference-reads", reference.sourceReads)
        record("selector-failure/$receiver/callbacks", callbacks)
    }
    record("comment/relative", sourceFixture().startOffsetSkippingComments())
    record("comment/keyword", sourceFixture().startOffsetSkippingComments(KtTokens.VAL_VAR))
    record("comment/missing-keyword", sourceFixture(keyword = false).startOffsetSkippingComments(KtTokens.VAL_VAR))
    record("comment/null", (null as SourcePayload?).startOffsetSkippingComments())
    for ([index, declaration] in listOf(
        NamedFunctionPayload(sourceFixture(keywordToken = KtTokens.FUN_KEYWORD)),
        ConstructorPayload(sourceFixture(keywordToken = KtTokens.CONSTRUCTOR_KEYWORD)),
        VariablePayload(sourceFixture()), RegularClassPayload(sourceFixture()), DeclarationPayload(null),
    ).withIndex()) {
        record("element-dispatch/$index/offset", offsets(declaration.convertWithOffsets(::OffsetPayload)))
        record("metadata-dispatch/$index/name", metadataName(declaration))
    }
    for ([index, property] in listOf(
        PropertyPayload(sourceFixture(), null),
        sourceFixture().let { PropertyPayload(it, initializerFor(it)) },
        sourceFixture(keyword = false).let { PropertyPayload(it, initializerFor(it)) },
        PropertyPayload(null, null),
        sourceFixture().let { PropertyPayload(it, initializerFor(it), propertySymbol = SymbolPayload()) },
    ).withIndex()) {
        val accessor = AccessorPayload(sourceFixture(SourceKindPayload.DefaultAccessor.Getter), PropertySymbolPayload(property))
        record("accessor/$index", offsets(accessor.convertWithOffsets(501, 502, ::OffsetPayload)))
    }
    record("accessor/null", offsets((null as AccessorPayload?).convertWithOffsets(501, 502, ::OffsetPayload)))
    record("accessor/ordinary", offsets(AccessorPayload(sourceFixture(), PropertySymbolPayload(PropertyPayload(null, null)))
        .convertWithOffsets(501, 502, ::OffsetPayload)))
    val allFiller = NodeFixture("property", KtNodeTypesForProbe.property, 0, 20,
        NodeFixture("comment", KtTokens.BLOCK_COMMENT, 0, 5),
        NodeFixture("space", KtTokens.WHITE_SPACE, 5, 8))
    val fillerSource = SourcePayload(allFiller, TreeFixture(allFiller), 50, 70)
    record("comment/all-filler", fillerSource.startOffsetSkippingComments())

    for (kind in listOf("property", "field")) for (constant in listOf(false, true)) {
        val declaration = if (kind == "property") PropertyPayload(sourceFixture(), null, constant)
            else FieldPayload(sourceFixture(), constant)
        val metadata: MetadataBoundary = if (declaration is PropertyPayload) PropertyMetadataPayload(declaration)
            else FieldMetadataPayload(declaration as FieldPayload)
        record("metadata/$kind/$constant/psi", metadata.psi)
        record("metadata/$kind/$constant/const", metadata.isConst)
        record("metadata/$kind/$constant/reads", declaration.sourceReads)
        record("metadata/$kind/$constant/source-identity", metadataSource(declaration) === declaration.source)
        record("metadata/$kind/$constant/symbol-identity", metadataSymbol(declaration) === declaration.symbol)
        record("metadata/$kind/$constant/name", metadataName(declaration))
        val marker = IllegalStateException("metadata-marker")
        declaration.sourceFailure = marker
        var identical = false
        try { metadata.psi } catch (failure: Throwable) { identical = failure === marker }
        record("metadata/$kind/$constant/throw-identity", identical)
    }
    for (constant in listOf(false, true)) {
        val descriptor = DescriptorPayload(constant)
        val rows: List<MetadataBoundary> = listOf(DescriptorPropertyMetadataPayload(descriptor), DescriptorLocalMetadataPayload(descriptor))
        for ([index, metadata] in rows.withIndex()) {
            record("descriptor/$constant/$index/psi", metadata.psi)
            record("descriptor/$constant/$index/const", metadata.isConst)
        }
    }
    for ([textIndex, text] in listOf("", "alpha", "a\r\nb\n", "한글😀\ncombining\u0301\n").withIndex()) {
        val mapping = text.toSourceLinesMapping() as KtSourceFileLinesMappingFromLineStartOffsets
        val sourceFiles = listOf(SourceFilePayload("source.kt", "/virtual/source.kt"),
            SourceFilePayload("source.kt", null), null)
        for ([fileIndex, sourceFile] in sourceFiles.withIndex()) for (mapped in listOf(false, true)) {
            val file = FilePayload(sourceFixture(), OriginPayload.Source, sourceFile, if (mapped) mapping else null)
            val entry = fileEntry(file)
            record("file/$textIndex/$fileIndex/$mapped/name", entry.name)
            record("file/$textIndex/$fileIndex/$mapped/max", entry.maxOffset)
            record("file/$textIndex/$fileIndex/$mapped/starts", entry.lineStartOffsets.joinToString(","))
            record("file/$textIndex/$fileIndex/$mapped/source-reads", file.sourceReads)
            record("file/$textIndex/$fileIndex/$mapped/file-reads", file.sourceFileReads)
            record("file/$textIndex/$fileIndex/$mapped/mapping-reads", file.mappingReads)
            record("file/$textIndex/$fileIndex/$mapped/order", file.evaluations.joinToString(","))
            if (mapped) {
                record("file/$textIndex/$fileIndex/$mapped/array-identity", entry.lineStartOffsets === mapping.lineStartOffsets)
                for (offset in listOf(-2, -1, 0, 1, text.length, text.length + 1))
                    record("file/$textIndex/$fileIndex/$mapped/position/$offset", entry.getLineAndColumnNumbers(offset))
            }
        }
    }
    val starts = intArrayOf(0, 4, 4, 8)
    val mapping = KtSourceFileLinesMappingFromLineStartOffsets(starts, 12)
    val live = fileEntry(FilePayload(null, OriginPayload.Source, null, mapping))
    for (offset in listOf(0, 3, 4, 7, 8, 12)) record("live/before/$offset", live.getLineAndColumnNumbers(offset))
    starts[1] = 2
    for (offset in listOf(0, 2, 3, 4, 8, 12)) record("live/after/$offset", live.getLineAndColumnNumbers(offset))
    val synthetic = FilePayload(sourceFixture(), OriginPayload.Synthetic(), SourceFilePayload("ignored", "/ignored"), mapping)
    val syntheticEntry = fileEntry(synthetic)
    record("synthetic/name", syntheticEntry.name)
    record("synthetic/starts", syntheticEntry.lineStartOffsets.size)
    record("synthetic/source-reads", synthetic.sourceReads)
    record("synthetic/file-reads", synthetic.sourceFileReads)
    record("synthetic/mapping-reads", synthetic.mappingReads)
    val unsupported = FilePayload(null, OriginPayload.Unsupported, null, null)
    var unsupportedFailed = false
    try { fileEntry(unsupported) } catch (failure: IllegalStateException) {
        unsupportedFailed = failure.message?.contains("Unsupported file origin") == true
    }
    record("unsupported/error-preserved", unsupportedFailed)
    val marker = IllegalArgumentException("file-source-marker")
    val badFile = FilePayload(sourceFixture(), OriginPayload.Source, null, mapping)
    badFile.sourceFailure = marker
    var fileIdentity = false
    try { fileEntry(badFile) } catch (failure: Throwable) { fileIdentity = failure === marker }
    record("file/throw-identity", fileIdentity)
    record("file/throw-no-path-read", badFile.sourceFileReads)
    record("file/throw-no-mapping-read", badFile.mappingReads)
    for (field in listOf("mapping", "sourceFile")) {
        val file = FilePayload(sourceFixture(), OriginPayload.Source, null, mapping)
        if (field == "mapping") file.mappingFailure = marker else file.sourceFileFailure = marker
        var identical = false
        try { fileEntry(file) } catch (failure: Throwable) { identical = failure === marker }
        record("file/$field/throw-identity", identical)
        record("file/$field/throw-order", file.evaluations.joinToString(","))
    }
    check(syntheticEntry is NaiveSourceBasedFileEntryImpl)
    return output.toString()
}

private object KtNodeTypesForProbe {
    val property = org.jetbrains.kotlin.KtNodeTypes.PROPERTY
}

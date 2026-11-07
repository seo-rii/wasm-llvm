/* Genuine compiler objects establish agreement with the explicitly bounded payload projection. */
package org.jetbrains.kotlin.portable.psiviews.probe

import org.jetbrains.kotlin.*
import org.jetbrains.kotlin.com.intellij.psi.tree.TokenSet
import org.jetbrains.kotlin.descriptors.Modality
import org.jetbrains.kotlin.descriptors.Visibilities
import org.jetbrains.kotlin.fir.FirBinaryDependenciesModuleData
import org.jetbrains.kotlin.fir.backend.FirMetadataSource
import org.jetbrains.kotlin.fir.backend.utils.convertWithOffsets as genuineOffsets
import org.jetbrains.kotlin.fir.backend.utils.startOffsetSkippingComments as genuineStart
import org.jetbrains.kotlin.fir.builder.buildPackageDirective
import org.jetbrains.kotlin.fir.declarations.*
import org.jetbrains.kotlin.fir.declarations.builder.*
import org.jetbrains.kotlin.fir.declarations.impl.FirDeclarationStatusImpl
import org.jetbrains.kotlin.fir.declarations.impl.FirDefaultPropertyGetter
import org.jetbrains.kotlin.fir.expressions.builder.buildLiteralExpression
import org.jetbrains.kotlin.fir.psi as genuinePsi
import org.jetbrains.kotlin.fir.realPsi as genuineRealPsi
import org.jetbrains.kotlin.fir.references.builder.buildSimpleNamedReference
import org.jetbrains.kotlin.fir.symbols.impl.*
import org.jetbrains.kotlin.fir.types.impl.FirImplicitTypeRefImplWithoutSource
import org.jetbrains.kotlin.ir.declarations.MetadataSource
import org.jetbrains.kotlin.lexer.KtTokens
import org.jetbrains.kotlin.name.*
import org.jetbrains.kotlin.types.ConstantValueKind

private val module = FirBinaryDependenciesModuleData(Name.special("<psi-view-observer>"))
private fun SourcePayload.genuine(): KtLightSourceElement = KtLightSourceElement(
    lighterASTNode, startOffset, endOffset, treeStructure, when (kind) {
        SourceKindPayload.Real -> KtRealSourceElementKind
        SourceKindPayload.OrdinaryFake -> KtFakeSourceElementKind.ErrorExpression
        SourceKindPayload.DataClassGeneratedMembers.Member -> KtFakeSourceElementKind.DataClassGeneratedMembers.ComponentFunction
        SourceKindPayload.ImplicitThisReceiverExpression -> KtFakeSourceElementKind.ImplicitThisReceiverExpression
        SourceKindPayload.ImplicitContextParameterArgument -> KtFakeSourceElementKind.ImplicitContextParameterArgument
        SourceKindPayload.DefaultAccessor.Getter -> KtFakeSourceElementKind.DefaultAccessor.Getter
    }
)

private fun realProperty(payload: PropertyPayload): FirProperty = buildProperty {
    source = payload.source?.genuine()
    moduleData = module
    // Genuine FIR rejects Source declarations without a source. The null-source
    // property models a library declaration; the measured offset body ignores origin.
    origin = if (source == null) FirDeclarationOrigin.Library else FirDeclarationOrigin.Source
    status = FirDeclarationStatusImpl(Visibilities.Public, Modality.FINAL).also { it.isConst = payload.isConst }
    isLocal = payload.propertySymbol !is RegularPropertySymbolPayload
    returnTypeRef = FirImplicitTypeRefImplWithoutSource
    name = Name.identifier(payload.name)
    isVar = false
    symbol = if (isLocal) FirLocalPropertySymbol() else FirRegularPropertySymbol(CallableId(FqName.ROOT, name))
    initializer = payload.initializer?.source?.let {
        buildLiteralExpression(it.genuine(), ConstantValueKind.String, "initializer", setType = false)
    }
}

private fun realField(payload: FieldPayload): FirField = buildField {
    source = payload.source?.genuine()
    moduleData = module
    origin = FirDeclarationOrigin.Source
    status = FirDeclarationStatusImpl(Visibilities.Public, Modality.FINAL).also { it.isConst = payload.isConst }
    isLocal = false
    returnTypeRef = FirImplicitTypeRefImplWithoutSource
    name = Name.identifier(payload.name)
    isVar = false
    symbol = FirFieldSymbol(CallableId(FqName.ROOT, name))
}

// The generic callback returns Nothing, a real subtype of IrElement, by throwing
// an identity-checked marker. No observer-created IR implementation is involved.
private fun genuinePair(action: ((Int, Int) -> Nothing) -> Unit): String {
    val marker = IllegalStateException("offset-callback-marker")
    var value: String? = null
    var calls = 0
    try { action { start, end -> calls++; value = start.toString() + ":" + end; throw marker } }
    catch (failure: Throwable) { check(failure === marker) }
    check(calls == 1)
    return checkNotNull(value)
}
private fun OffsetPayload.pair(): String = startOffset.toString() + ":" + endOffset

fun main() {
    val output = StringBuilder()
    fun same(id: String, actual: Any?, projected: Any?) {
        check(actual == projected) { id + ": genuine=" + actual + ", projected=" + projected }
        output.append(id).append('\t').append(actual).append('\n')
    }
    val kinds = listOf(SourceKindPayload.Real, SourceKindPayload.OrdinaryFake,
        SourceKindPayload.DataClassGeneratedMembers.Member, SourceKindPayload.ImplicitThisReceiverExpression,
        SourceKindPayload.ImplicitContextParameterArgument, SourceKindPayload.DefaultAccessor.Getter)
    for ([index, payload] in (listOf<SourcePayload?>(null) + kinds.map { sourceFixture(it) }).withIndex()) {
        val source = payload?.genuine()
        val element = buildImport { this.source = source; isAllUnder = false }
        same("genuine/psi/$index", element.genuinePsi, ElementPayload(payload).psi)
        same("genuine/realPsi/$index", element.genuineRealPsi, ElementPayload(payload).realPsi)
        same("genuine/offset/$index", genuinePair { emit -> source.genuineOffsets<Nothing>(null, emit) },
            payload.convertWithOffsets(null, ::OffsetPayload).pair())
        same("genuine/keyword/$index", genuinePair { emit -> source.genuineOffsets<Nothing>(KtTokens.VAL_VAR, emit) },
            payload.convertWithOffsets(KtTokens.VAL_VAR, ::OffsetPayload).pair())
        same("genuine/comment/$index", source.genuineStart(), payload.startOffsetSkippingComments())
    }
    for ([index, referenceSource] in listOf(null, sourceFixture(),
        sourceFixture(SourceKindPayload.ImplicitContextParameterArgument)).withIndex()) {
        val statementSource = sourceFixture()
        val statement = buildLiteralExpression(statementSource.genuine(), ConstantValueKind.String, "statement", setType = false)
        val reference = buildSimpleNamedReference {
            source = referenceSource?.genuine()
            name = Name.identifier("selector")
        }
        same("genuine/selector/$index", genuinePair { emit -> statement.genuineOffsets<Nothing>(reference, emit) },
            StatementPayload(statementSource).convertWithOffsets(ReferencePayload(referenceSource), ::OffsetPayload).pair())
    }
    for ([index, payload] in listOf(
        PropertyPayload(sourceFixture(), null),
        sourceFixture().let { PropertyPayload(it, initializerFor(it)) },
        sourceFixture(keyword = false).let { PropertyPayload(it, initializerFor(it)) },
        PropertyPayload(null, null),
        sourceFixture().let { PropertyPayload(it, initializerFor(it), propertySymbol = SymbolPayload()) },
    ).withIndex()) {
        val property = realProperty(payload)
        val source = sourceFixture(SourceKindPayload.DefaultAccessor.Getter)
        val accessor = FirDefaultPropertyGetter(source.genuine(), module, FirDeclarationOrigin.Source,
            FirImplicitTypeRefImplWithoutSource, property.symbol, FirDeclarationStatusImpl(Visibilities.Public, Modality.FINAL))
        same("genuine/accessor/$index", genuinePair { emit -> accessor.genuineOffsets<Nothing>(501, 502, emit) },
            AccessorPayload(source, PropertySymbolPayload(payload)).convertWithOffsets(501, 502, ::OffsetPayload).pair())
    }
    same("genuine/accessor/null", genuinePair { emit -> (null as FirPropertyAccessor?).genuineOffsets<Nothing>(501, 502, emit) },
        (null as AccessorPayload?).convertWithOffsets(501, 502, ::OffsetPayload).pair())
    for (constant in listOf(false, true)) {
        val property = realProperty(PropertyPayload(sourceFixture(), null, constant))
        val field = realField(FieldPayload(sourceFixture(), constant))
        for ([kind, firMetadata] in listOf("property" to FirMetadataSource.Property(property), "field" to FirMetadataSource.Field(field))) {
            val metadata = firMetadata as MetadataSource.Property
            val payload = if (kind == "property") PropertyPayload(sourceFixture(), null, constant) else FieldPayload(sourceFixture(), constant)
            val projected: MetadataBoundary = if (payload is PropertyPayload) PropertyMetadataPayload(payload) else FieldMetadataPayload(payload as FieldPayload)
            same("genuine/metadata/$kind/$constant/psi", metadata.psi, projected.psi)
            same("genuine/metadata/$kind/$constant/const", metadata.isConst, projected.isConst)
            same("genuine/metadata/$kind/$constant/name", firMetadata.name?.asString(), metadataName(payload))
            same("genuine/metadata/$kind/$constant/source", firMetadata.source === firMetadata.fir.source,
                metadataSource(payload) === payload.source)
            same("genuine/metadata/$kind/$constant/symbol", firMetadata.symbol === firMetadata.fir.symbol,
                metadataSymbol(payload) === payload.symbol)
        }
    }
    for ([textIndex, text] in listOf("", "a\r\nb\n", "한글😀\ncombining\u0301\n").withIndex()) {
        val mapping = text.toSourceLinesMapping()
        for ([fileIndex, sourceFile] in listOf(SourceFilePayload("source.kt", "/virtual/source.kt"),
            SourceFilePayload("source.kt", null), null).withIndex()) for (mapped in listOf(false, true)) {
            val payload = FilePayload(sourceFixture(), OriginPayload.Source, sourceFile, if (mapped) mapping else null)
            val file = buildFile {
                source = payload.source?.genuine()
                moduleData = module
                origin = FirDeclarationOrigin.Source
                packageDirective = buildPackageDirective { packageFqName = FqName.ROOT }
                name = payload.name
                this.sourceFile = sourceFile?.let { KtInMemoryTextSourceFile(it.name, it.path, text) }
                sourceFileLinesMapping = if (mapped) mapping else null
            }
            val actual = genuineFileEntry(file)
            val projected = fileEntry(payload)
            same("genuine/file/$textIndex/$fileIndex/$mapped/name", actual.name, projected.name)
            same("genuine/file/$textIndex/$fileIndex/$mapped/max", actual.maxOffset, projected.maxOffset)
            same("genuine/file/$textIndex/$fileIndex/$mapped/starts", actual.lineStartOffsets.joinToString(","), projected.lineStartOffsets.joinToString(","))
            for (offset in listOf(-2, -1, 0, 1, text.length, text.length + 1))
                same("genuine/file/$textIndex/$fileIndex/$mapped/position/$offset",
                    actual.getLineAndColumnNumbers(offset), projected.getLineAndColumnNumbers(offset))
        }
    }
    print(output)
}

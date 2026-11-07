/** Exact source-span extraction for non-shipping, explicitly typed observation boundaries. */
import assert from 'node:assert/strict';
import { balancedSpan } from '../fir-navigation/transform.mjs';
import { sha256 } from '../../scripts/source.mjs';
import { UTILS, FIR_METADATA, METADATA, OFFSETS, CONVERTER, HOST, RECIPE } from './transform.mjs';

export const bindings = {
  FirElement: 'ElementPayload', FirStatement: 'StatementPayload',
  FirNamedFunction: 'NamedFunctionPayload', FirConstructor: 'ConstructorPayload',
  FirVariable: 'VariablePayload', FirPropertyAccessor: 'AccessorPayload',
  FirProperty: 'PropertyPayload', FirField: 'FieldPayload', FirReference: 'ReferencePayload',
  FirRegularPropertySymbol: 'RegularPropertySymbolPayload',
  KtFakeSourceElementKind: 'SourceKindPayload', KtLightSourceElement: 'SourcePayload',
  KtSourceElement: 'SourcePayload', AbstractKtSourceElement: 'SourcePayload',
  FirDeclarationOrigin: 'OriginPayload', IrElement: 'OffsetPayload',
  FirRegularClass: 'RegularClassPayload',
};
export function bind(text) {
  for (const [before, after] of Object.entries(bindings))
    text = text.replaceAll(new RegExp('\\b' + before + '\\b', 'g'), after);
  return text;
}
const block = (text, anchor) => balancedSpan(text, anchor).text;
function once(text, anchor) {
  assert.equal(text.split(anchor).length, 2, 'Observer anchor changed: ' + anchor);
  return anchor;
}
export function converterExpression(text) {
  return block(text, 'val fileEntry = when (file.origin)').replace(/^val fileEntry = /, '');
}
export function projectPsiViews(inputs, portable) {
  const spans = [];
  const take = (logical, anchor) => {
    const text = block(inputs.get(logical), anchor);
    spans.push({ logical, anchor, sha256: sha256(Buffer.from(text)), bytes: Buffer.byteLength(text) });
    return text;
  };
  const utils = inputs.get(UTILS);
  const views = RECIPE[UTILS].slice(1).map(row => {
    const text = portable ? row.after : row.before;
    once(utils, text);
    spans.push({ logical: UTILS, anchor: row.before, sha256: sha256(Buffer.from(text)), bytes: Buffer.byteLength(text) });
    return text;
  }).join('\n');
  const offsets = inputs.get(OFFSETS);
  const anchors = [
    'fun AbstractKtSourceElement?.startOffsetSkippingComments(',
    'internal inline fun <T : IrElement> FirElement.convertWithOffsets(',
    'internal fun <T : IrElement> FirPropertyAccessor?.convertWithOffsets(',
    'internal inline fun <T : IrElement> KtSourceElement?.convertWithOffsets(',
    'internal inline fun <T : IrElement> FirStatement.convertWithOffsets(',
    'private fun isCompiledElement(',
    'private fun FirProperty.computeOffsetsWithoutInitializer(',
  ];
  let offsetBodies = anchors.map(anchor => take(OFFSETS, anchor)).join('\n');
  const exclusions = [];
  if (!portable) {
    // SourcePayload deliberately represents only the LightTree domain. The whole
    // original file is separately compiled and its real LightTree overload runs.
    const psiBranch = '        is KtPsiSourceElement -> this.psi.startOffsetSkippingComments\n';
    once(offsetBodies, psiBranch);
    offsetBodies = offsetBodies.replace(psiBranch, '');
    exclusions.push({ logical: OFFSETS, exactSpan: psiBranch, reason: 'LightTree-only payload; checked against genuine original objects' });
  }
  const originalSourcePsi = 'val AbstractKtSourceElement?.psi: PsiElement? get() = (this as? KtPsiSourceElement)?.psi';
  const sourcePsi = portable ? take(OFFSETS, 'private val KtSourceElement?.psi: Nothing?')
    : 'private ' + once(inputs.get(HOST), originalSourcePsi);
  if (!portable) spans.push({ logical: HOST, anchor: originalSourcePsi,
    bytes: Buffer.byteLength(originalSourcePsi), sha256: sha256(Buffer.from(originalSourcePsi)) });
  const tokenEnd = offsets.slice(offsets.indexOf('private val CONSTRUCTOR_KEYWORD_TOKENS'));
  assert(tokenEnd.startsWith('private val CONSTRUCTOR_KEYWORD_TOKENS'));
  spans.push({ logical: OFFSETS, anchor: 'private val CONSTRUCTOR_KEYWORD_TOKENS', bytes: Buffer.byteLength(tokenEnd), sha256: sha256(Buffer.from(tokenEnd)) });

  const metadata = inputs.get(METADATA), firMetadata = inputs.get(FIR_METADATA);
  const contract = take(METADATA, 'interface Property : MetadataSource {')
    .replace('interface Property : MetadataSource', 'interface MetadataBoundary');
  const projectClass = (logical, anchor, declaration) => {
    const text = take(logical, anchor), body = text.slice(text.indexOf('{'));
    return declaration + ' ' + body;
  };
  const metadataBodies = [
    contract,
    projectClass(FIR_METADATA, 'class Property(override val fir:', 'class PropertyMetadataPayload(val fir: PropertyPayload) : MetadataBoundary'),
    projectClass(FIR_METADATA, 'class Field(override val fir:', 'class FieldMetadataPayload(val fir: FieldPayload) : MetadataBoundary'),
    projectClass(METADATA, 'class Property(override val descriptor:', 'class DescriptorPropertyMetadataPayload(val descriptor: DescriptorPayload) : MetadataBoundary'),
    projectClass(METADATA, 'class LocalDelegatedProperty(override val descriptor:', 'class DescriptorLocalMetadataPayload(val descriptor: DescriptorPayload) : MetadataBoundary'),
    'class DescriptorPayload(val isConst: Boolean)',
  ].join('\n');
  const sourceForward = once(firMetadata, 'get() = fir.source');
  const symbolForward = once(firMetadata, 'get() = fir.symbol');
  for (const text of [sourceForward, symbolForward]) spans.push({ logical: FIR_METADATA, anchor: text,
    bytes: Buffer.byteLength(text), sha256: sha256(Buffer.from(text)) });
  const name = take(FIR_METADATA, 'get() = when (val fir = fir) {').replace(/^get\(\) = /, '')
    .replace('SpecialNames.INIT', '"<init>"');
  const forwarding = 'fun metadataSource(fir: DeclarationPayload): SourcePayload? ' + sourceForward.replace('get() ', '') + '\n' +
    'fun metadataSymbol(fir: DeclarationPayload): Any ' + symbolForward.replace('get() ', '') + '\n' +
    'fun metadataName(fir: DeclarationPayload): String? = ' + name;
  const expression = converterExpression(inputs.get(CONVERTER));
  spans.push({ logical: CONVERTER, anchor: 'val fileEntry = when (file.origin)', bytes: Buffer.byteLength(expression), sha256: sha256(Buffer.from(expression)) });
  const carriers = portable ? 'import org.jetbrains.kotlin.portable.source.*\n' : [
    'import org.jetbrains.kotlin.com.intellij.lang.LighterASTNode',
    'import org.jetbrains.kotlin.com.intellij.psi.PsiElement',
    'import org.jetbrains.kotlin.com.intellij.psi.PsiCompiledElement',
    'import org.jetbrains.kotlin.com.intellij.psi.tree.TokenSet',
    'import org.jetbrains.kotlin.KtPsiSourceElement',
    'import org.jetbrains.kotlin.KtRealPsiSourceElement',
    'import org.jetbrains.kotlin.KtPsiSourceFileLinesMapping',
    'import org.jetbrains.kotlin.psi.KtFile',
    'import org.jetbrains.kotlin.ir.PsiIrFileEntry',
  ].join('\n') + '\n';
  const common = 'package org.jetbrains.kotlin.portable.psiviews.probe\n' + carriers +
    'import org.jetbrains.kotlin.KtSourceFileLinesMappingFromLineStartOffsets\n' +
    'import org.jetbrains.kotlin.ir.IrFileEntry\nimport org.jetbrains.kotlin.ir.UNDEFINED_OFFSET\n' +
    'import org.jetbrains.kotlin.ir.util.NaiveSourceBasedFileEntryImpl\n' +
    'import org.jetbrains.kotlin.lexer.KtTokens\nimport org.jetbrains.kotlin.lexer.KtTokens.VAL_VAR\n' +
    'import org.jetbrains.kotlin.util.getChildren\n';
  const bytes = Buffer.from(common + bind([views, sourcePsi, offsetBodies, tokenEnd, metadataBodies, forwarding,
    'fun fileEntry(file: FilePayload): IrFileEntry = ' + expression].join('\n')));
  return { bytes, spans, bindings, exclusions,
    fieldBoundary: 'SourcePayload carries LightTree node/tree/offset/kind; ElementPayload instruments source evaluation; metadata and file payloads carry only accessed fields.',
    retainedHelpers: 'Real source-lines mapping, IrFileEntry, NaiveSourceBasedFileEntryImpl, token declarations and getChildren algorithms.' };
}

export function genuineConverterKernel(original) {
  return Buffer.from('package org.jetbrains.kotlin.portable.psiviews.probe\n' +
    'import org.jetbrains.kotlin.*\nimport org.jetbrains.kotlin.fir.psi\n' +
    'import org.jetbrains.kotlin.fir.declarations.*\nimport org.jetbrains.kotlin.ir.*\n' +
    'import org.jetbrains.kotlin.ir.util.NaiveSourceBasedFileEntryImpl\nimport org.jetbrains.kotlin.psi.KtFile\n' +
    'fun genuineFileEntry(file: FirFile): IrFileEntry = ' + converterExpression(original));
}

export function commentHelpers(source, portable) {
  // setOf has parentheses rather than braces. Bound it by the next declaration.
  const begin = source.indexOf('private val FILLER_TOKENS = setOf(');
  const end = source.indexOf('\n\n', begin);
  assert(begin >= 0 && end > begin);
  const tokens = source.slice(begin, end);
  const predicate = 'fun LighterASTNode.isFiller(): Boolean = tokenType in FILLER_TOKENS';
  once(source, predicate);
  const property = block(source, 'val KtLightSourceElement.startOffsetSkippingComments: Int');
  const imports = portable ? 'import org.jetbrains.kotlin.portable.source.*\n' :
    'import org.jetbrains.kotlin.com.intellij.lang.LighterASTNode\n';
  return {
    bytes: Buffer.from('package org.jetbrains.kotlin.portable.psiviews.probe\n' + imports +
      'import org.jetbrains.kotlin.lexer.KtTokens\nimport org.jetbrains.kotlin.util.getChildren\n' +
      bind(tokens + '\n' + predicate + '\n' + property)),
    spans: [tokens, predicate, property].map(text => ({ bytes: Buffer.byteLength(text), sha256: sha256(Buffer.from(text)) })),
  };
}

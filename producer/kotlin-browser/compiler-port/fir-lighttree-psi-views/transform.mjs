import assert from 'node:assert/strict';

export const UTILS = 'compiler/fir/tree/src/org/jetbrains/kotlin/fir/Utils.kt';
export const FIR_METADATA = 'compiler/fir/fir2ir/src/org/jetbrains/kotlin/fir/backend/FirMetadataSource.kt';
export const METADATA = 'compiler/ir/ir.tree/src/org/jetbrains/kotlin/ir/declarations/MetadataSource.kt';
export const OFFSETS = 'compiler/fir/fir2ir/src/org/jetbrains/kotlin/fir/backend/utils/OffsetUtils.kt';
export const CONVERTER = 'compiler/fir/fir2ir/src/org/jetbrains/kotlin/fir/backend/Fir2IrConverter.kt';
export const TARGETS = [UTILS, FIR_METADATA, METADATA, OFFSETS, CONVERTER];
export const HOST = 'compiler/frontend.common/src/org/jetbrains/kotlin/KtSourceElement.kt';
export const LINES = 'compiler/frontend.common/src/org/jetbrains/kotlin/KtSourceFileLinesMapping.kt';
export const ELEMENT = 'compiler/fir/tree/gen/org/jetbrains/kotlin/fir/FirElement.kt';

const change = (before, after, occurrences = 1) => ({ before, after, occurrences });
const removeImport = (name, label) => change('import ' + name + '\n', '/* LightTree PSI view: ' + label + ' */\n');

export const RECIPE = {
  [UTILS]: [
    removeImport('com.intellij.psi.PsiElement', 'no PSI return carrier'),
    change('val FirElement.psi: PsiElement? get() = (source as? KtPsiSourceElement)?.psi',
      'val FirElement.psi: Nothing?\n    get() = when (source) {\n        null, is KtLightSourceElement -> null\n    }'),
    change('val FirElement.realPsi: PsiElement? get() = (source as? KtRealPsiSourceElement)?.psi',
      'val FirElement.realPsi: Nothing?\n    get() = when (source) {\n        null, is KtLightSourceElement -> null\n    }'),
  ],
  [FIR_METADATA]: [
    removeImport('com.intellij.psi.PsiElement', 'nullable-only metadata view'),
    change('override val psi: PsiElement? get() = fir.psi', 'override val psi: Nothing? get() = fir.psi', 2),
  ],
  [METADATA]: [
    removeImport('com.intellij.psi.PsiElement', 'nullable-only metadata contract'),
    change('val psi: PsiElement?', 'val psi: Nothing?', 3),
  ],
  [OFFSETS]: [
    change('import com.intellij.lang.LighterASTNode\n', 'import org.jetbrains.kotlin.portable.source.LighterASTNode\n'),
    change('import com.intellij.psi.tree.TokenSet\n', 'import org.jetbrains.kotlin.portable.source.TokenSet\n'),
    removeImport('com.intellij.psi.PsiCompiledElement', 'no compiled PSI source'),
    removeImport('com.intellij.psi.PsiElement', 'closed null predicate input'),
    removeImport('org.jetbrains.kotlin.psi.KtFile', 'no PSI containing file'),
    removeImport('org.jetbrains.kotlin.psi.psiUtil.startOffsetSkippingComments', 'retain the existing LightTree offset overload'),
    change('        is KtPsiSourceElement -> this.psi.startOffsetSkippingComments\n',
      '        /* LightTree PSI view: unavailable PSI offset branch */\n'),
    change(`private fun isCompiledElement(element: PsiElement?): Boolean {
    if (element == null) {
        return false
    }

    if (element is PsiCompiledElement) {
        return true
    }

    val containingFile = element.containingFile
    return containingFile !is KtFile || containingFile.isCompiled
}`, `private val KtSourceElement?.psi: Nothing?
    get() = when (this) {
        null, is KtLightSourceElement -> null
    }

private fun isCompiledElement(element: Nothing?): Boolean = when (element) {
    null -> false
}`),
  ],
  [CONVERTER]: [
    removeImport('org.jetbrains.kotlin.KtPsiSourceFileLinesMapping', 'no PSI line mapping provider'),
    removeImport('org.jetbrains.kotlin.ir.PsiIrFileEntry', 'retain the genuine source-based file entry'),
    removeImport('org.jetbrains.kotlin.psi.KtFile', 'no PSI file entry input'),
    change(`            FirDeclarationOrigin.Source ->
                file.psi?.let { PsiIrFileEntry(it as KtFile) }
                    ?: when (val linesMapping = file.sourceFileLinesMapping) {
                        is KtSourceFileLinesMappingFromLineStartOffsets ->
                            NaiveSourceBasedFileEntryImpl(
                                file.sourceFile?.path ?: file.sourceFile?.name ?: file.name,
                                linesMapping.lineStartOffsets,
                                linesMapping.lastOffset
                            )
                        is KtPsiSourceFileLinesMapping -> PsiIrFileEntry(linesMapping.psiFile)
                        else ->
                            NaiveSourceBasedFileEntryImpl(file.sourceFile?.path ?: file.sourceFile?.name ?: file.name)
                    }`, `            FirDeclarationOrigin.Source -> when (file.psi) {
                null -> when (val linesMapping = file.sourceFileLinesMapping) {
                    is KtSourceFileLinesMappingFromLineStartOffsets ->
                        NaiveSourceBasedFileEntryImpl(
                            file.sourceFile?.path ?: file.sourceFile?.name ?: file.name,
                            linesMapping.lineStartOffsets,
                            linesMapping.lastOffset
                        )
                    else ->
                        NaiveSourceBasedFileEntryImpl(file.sourceFile?.path ?: file.sourceFile?.name ?: file.name)
                }
            }`),
  ],
};

export function transformPsiViews(logical, bytes, { reverse = false } = {}) {
  assert(TARGETS.includes(logical), 'Unknown LightTree PSI view target: ' + logical);
  let text = bytes.toString();
  for (const row of reverse ? RECIPE[logical].slice().reverse() : RECIPE[logical]) {
    const before = reverse ? row.after : row.before, after = reverse ? row.before : row.after;
    assert(before.length && after.length);
    assert.equal(text.split(before).length - 1, row.occurrences,
      'Exact LightTree PSI view span changed: ' + logical + ': ' + before.slice(0, 120));
    text = text.split(before).join(after);
  }
  return Buffer.from(text);
}

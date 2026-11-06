import assert from 'node:assert/strict';
import {normalizeImports} from '../klib-signature-index/transform.mjs';
import {balancedSpan} from '../fir-navigation/transform.mjs';
import {lexicalReferenceView} from '../native-js-output-profile/references.mjs';

export const ENTRY = 'compiler-port-entry/BrowserCompilerPipeline.kt';
export const TARGETS = [
 'compiler/frontend.common/src/org/jetbrains/kotlin/util/AnalysisExceptions.kt',
 'compiler/util/src/org/jetbrains/kotlin/utils/KotlinExceptionWithAttachments.kt',
 'compiler/util/src/org/jetbrains/kotlin/utils/exceptions/KotlinExceptionWithAttachments.kt',
 'compiler/util/src/org/jetbrains/kotlin/utils/exceptions/platformExceptionUtils.kt',
 'compiler/fir/tree/src/org/jetbrains/kotlin/fir/Utils.kt',
 ENTRY,
];
export const EXCLUSIONS = ['compiler/util/src/org/jetbrains/kotlin/utils/psiUtils.kt', 'compiler/util/src/org/jetbrains/kotlin/utils/exceptions/exceptionAttachementBuilderUtils.kt'];
export const HELPERS = ['compiler-port-exceptions/CompilerExceptionAttachments.kt', 'compiler-port-exceptions/CompilerExceptionHost.kt'];
export const HOST = 'compiler/frontend.common/src/org/jetbrains/kotlin/KtSourceElement.kt';
export const BOUNDARIES = [HOST,'compiler-port-host/PortableLightTree.kt','compiler/fir/raw-fir/mp-parsing2fir/src/org/jetbrains/kotlin/fir/builder/MultiplatformParsing2Fir.kt','compiler-port-entry/BrowserCompiler.kt','compiler-port-entry/BrowserCompilerPipeline.kt','compiler/fir/checkers/src/org/jetbrains/kotlin/fir/analysis/checkers/FirKeywordUtils.kt','compiler/fir/raw-fir/raw-fir.common/src/org/jetbrains/kotlin/fir/builder/AbstractRawFirBuilder.kt','compiler/util/src/org/jetbrains/kotlin/utils/exceptions/ExceptionAttachmentBuilder.kt','compiler/fir/entrypoint/src/org/jetbrains/kotlin/fir/session/KlibIcData.kt'];
export const PSI = ['withPsiAttachment','withPsiEntry','getElementTextWithContext','withVirtualFileEntry','withClassEntry','PsiUtilsKt','ExceptionAttachementBuilderUtilsKt'];
export const PORTABLE = ['CompilerExceptionAttachment','CompilerExceptionWithAttachments','CompilerStringExceptionAttachment','newCompilerStringAttachment','decodeCompilerAttachmentUtf8','CompilerExceptionHost','installCompilerExceptionHost','withCompilerExceptionHost','compilerExceptionHostInstalled','CompilerExceptionHostRequired','requiredCompilerExceptionHost','javaStringAttachmentUtf8'];
export const EDGES = ['withAttachment','mutableAttachments','getAttachments','ExceptionWithAttachments','Attachment'];

export function references(text,names){const decoded=text.replace(/\\u([0-9a-fA-F]{4})/g,(_,hex)=>String.fromCharCode(parseInt(hex,16))),joined=decoded.replace(/"\s*\+\s*"/g,''),all=decoded+'\n'+lexicalReferenceView(decoded)+'\n'+joined;return names.filter(name=>new RegExp('\\b'+name+'\\b').test(all));}
export function transform(bytes,changes,reverse=false){let text=bytes.toString();for(const row of reverse?changes.slice().reverse():changes){const from=reverse?row.after:row.before,to=reverse?row.before:row.after;assert(from.length&&text.split(from).length===row.occurrences+1,'Exact exception transform span changed: '+row.reason);text=text.split(from).join(to);}return Buffer.from(text);}

export function exceptionChanges(logical, bytes) {
 assert(TARGETS.includes(logical)); const pin={path:logical}; let text=bytes.toString(); const original=text,rows=[];
 function replace(before,after,reason,occurrences=1){assert(before.length);assert.equal(text.split(before).length,occurrences+1,'Exact private exception span '+pin.path+':'+reason);rows.push({before,after,reason,occurrences});text=text.split(before).join(after);}
 function removeImport(name){replace('import '+name+'\n','/* private exception profile: unavailable import '+rows.length+' */\n','unavailable-import-'+name);}
 function addImport(name){const pkg=/^package[^\n]+/m.exec(text)[0];replace(pkg,pkg+'\nimport '+name,'new-explicit-binding-'+name);}
 if(pin.path===ENTRY){
  addImport('org.jetbrains.kotlin.portable.exceptions.CompilerExceptionHost');
  addImport('org.jetbrains.kotlin.portable.exceptions.withCompilerExceptionHost');
  replace('    private val performanceManagerHost: PerformanceManagerHost,\n',
   '    private val performanceManagerHost: PerformanceManagerHost,\n    private val compilerExceptionHost: CompilerExceptionHost,\n','required-request-exception-host');
  const compile=balancedSpan(text,'    fun compile(sources:').text;
  // Preserve the complete existing request body, including the other host scopes.
  // The outer scope also covers failures while those hosts are being installed.
  const marker='        withDescriptorDebugHost(descriptorDebugHost) {';
  assert(compile.includes(marker));
  const scoped=compile.replace(marker,'        withCompilerExceptionHost(compilerExceptionHost) {\n'+marker)+'\n        }';
  replace(compile,scoped,'scoped-exception-host-for-complete-request');
 }else if(pin.path.endsWith('/AnalysisExceptions.kt')){
  removeImport('org.jetbrains.kotlin.psi');
  const helper=balancedSpan(text,'private fun KtSourceElement.isDefinitelyNotInsideFile(').text,begin=helper.indexOf('{');
  replace(helper,helper.slice(0,begin+1)+'\n    return !lighterASTNode.isInside(fileSource.lighterASTNode, treeStructure)\n}','sealed-null-psi-membership-fold');
  replace('    val thisPsi = source.psi\n    val otherPsi = fileSource.psi\n','/* private exception profile: sealed source host has no PSI fields */\n','sealed-null-psi-mismatch-fields');
  const before=String.raw`    val expectedFileMessage = if (thisPsi != null && otherPsi != null) {
        val actualPath = thisPsi.containingFile.virtualFile.path
        val expectedPath = otherPsi.containingFile.virtualFile.path
        "$expectedPath, but rather in $actualPath"
    } else {
        "...${'${fileSource.text.asQuote}'}"
    }`;
  replace(before,'    val expectedFileMessage = "...${fileSource.text.asQuote}"','sealed-null-psi-file-message-fold');
  for(const [from,to] of [['com.intellij.lang.LighterASTNode','org.jetbrains.kotlin.portable.source.LighterASTNode'],['com.intellij.util.diff.FlyweightCapableTreeStructure','org.jetbrains.kotlin.portable.source.FlyweightCapableTreeStructure']])replace('import '+from+'\n','import '+to+'\n','existing-portable-carrier-'+to.split('.').at(-1));
  replace('this is VirtualMachineError','isVirtualMachineError(this)','required-host-fatal-classification-two-occurrences',2);
  addImport('org.jetbrains.kotlin.portable.exceptions.isVirtualMachineError');
 }else if(pin.path.includes('/utils/exceptions/KotlinExceptionWithAttachments.kt')){
  replace('import com.intellij.openapi.diagnostic.Attachment\n','import org.jetbrains.kotlin.portable.exceptions.CompilerExceptionAttachment as Attachment\n','typed-portable-attachment-contract');
  replace('import com.intellij.openapi.diagnostic.ExceptionWithAttachments\n','import org.jetbrains.kotlin.portable.exceptions.CompilerExceptionWithAttachments as ExceptionWithAttachments\n','typed-portable-array-contract');
  removeImport('java.nio.charset.StandardCharsets');addImport('org.jetbrains.kotlin.portable.exceptions.newCompilerStringAttachment');addImport('org.jetbrains.kotlin.portable.exceptions.decodeCompilerAttachmentUtf8');
  replace('Attachment(name, content?.toString() ?: "<null>")','newCompilerStringAttachment(name, content?.toString() ?: "<null>")','selected-string-attachment-constructor');
  replace('String(bytes, StandardCharsets.UTF_8)','decodeCompilerAttachmentUtf8(this)','proven-string-or-required-external-utf8-copy');
  replace('return Attachment(newName, content)','return newCompilerStringAttachment(newName, content)','copied-string-attachment-constructor');
 }else if(pin.path.endsWith('/utils/KotlinExceptionWithAttachments.kt')){
  replace(balancedSpan(text,'    fun withPsiAttachment(').text,'/* private exception profile: no selected PSI attachment callers */','proven-unused-psi-method');
  for(const name of ['com.intellij.openapi.application.ApplicationManager','com.intellij.psi.PsiElement'])removeImport(name);
  replace('import com.intellij.openapi.diagnostic.Attachment\n','import org.jetbrains.kotlin.portable.exceptions.CompilerExceptionAttachment as Attachment\n','typed-portable-attachment-contract');
 }else if(pin.path.endsWith('/platformExceptionUtils.kt')){
  removeImport('com.intellij.openapi.diagnostic.ControlFlowException');removeImport('com.intellij.openapi.project.IndexNotReadyException');
  replace('import com.intellij.openapi.progress.ProcessCanceledException\n','/* Its upstream ProcessCanceledException mention is documentation only; classification remains an explicit host. */\n','unused-documentation-only-progress-import');
  replace('import java.util.concurrent.CancellationException\n','import kotlin.coroutines.cancellation.CancellationException\n','genuine-common-cancellation-jvm-alias');
  replace('when (exception) {','when {','preserve-taxonomy-arm-order');
  replace('    is CancellationException -> true','    exception is CancellationException -> true','same-standard-cancellation-guard');
  replace('    is ControlFlowException -> true','    isControlFlowException(exception) -> true','required-control-flow-classification');
  replace('    is IndexNotReadyException -> true','    isIndexNotReadyException(exception) -> true','required-index-not-ready-classification');
  addImport('org.jetbrains.kotlin.portable.exceptions.isControlFlowException');addImport('org.jetbrains.kotlin.portable.exceptions.isIndexNotReadyException');
 }else{
  replace('throwable is VirtualMachineError','isVirtualMachineError(throwable)','required-fatal-wrapper-classification-two-occurrences',2);
  addImport('org.jetbrains.kotlin.portable.exceptions.isVirtualMachineError');
 }
 assert.deepEqual(transform(transform(bytes,rows),rows,true),bytes,'Complete exception body must reverse exactly');
 return rows;
}

export function transformAssembled(bytes,changes,recordedPropertyImports,reverse=false){
 const canonical=normalizeImports(bytes,recordedPropertyImports),text=bytes.toString(),pkg=/^package[^\r\n]+/m.exec(text);assert(pkg,'Missing exception package boundary');const end=pkg.index+pkg[0].length,prefix=text.slice(end,end+bytes.length-canonical.length);
 assert.deepEqual(Buffer.from(text.slice(0,end)+text.slice(end+prefix.length)),canonical,'Exception assembly imports must be one exact recorded package prefix');
 const result=transform(canonical,changes,reverse).toString();assert(result.startsWith(text.slice(0,end)),'Exception canonical package changed');
 return Buffer.from(result.slice(0,end)+prefix+result.slice(end));
}

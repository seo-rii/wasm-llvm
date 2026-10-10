/* Real compiler configuration, light source and FIR import objects. Carrier fixtures implement the actual IntelliJ interfaces. */
@file:OptIn(org.jetbrains.kotlin.config.CompilerConfiguration.Internals::class)
package org.jetbrains.kotlin.portable.storageprofile.probe

import org.jetbrains.kotlin.KtLightSourceElement
import org.jetbrains.kotlin.KtFakeSourceElementKind
import org.jetbrains.kotlin.com.intellij.lang.LighterASTNode
import org.jetbrains.kotlin.com.intellij.openapi.util.Ref
import org.jetbrains.kotlin.com.intellij.psi.tree.IElementType
import org.jetbrains.kotlin.com.intellij.util.diff.FlyweightCapableTreeStructure
import org.jetbrains.kotlin.config.*
import org.jetbrains.kotlin.diagnostics.impl.BaseDiagnosticsCollector
import org.jetbrains.kotlin.fir.backend.Fir2IrConfiguration
import org.jetbrains.kotlin.fir.declarations.builder.buildImport
import org.jetbrains.kotlin.fir.psi
import org.jetbrains.kotlin.lexer.KtTokens

private class Node(private val offset: Int) : LighterASTNode {
    override fun getTokenType(): IElementType = KtTokens.IDENTIFIER
    override fun getStartOffset(): Int = offset
    override fun getEndOffset(): Int = offset + 1
}
private class Tree(private val node: LighterASTNode) : FlyweightCapableTreeStructure<LighterASTNode> {
    override fun getRoot(): LighterASTNode = node
    override fun getParent(node: LighterASTNode): LighterASTNode? = null
    override fun getChildren(parent: LighterASTNode, into: Ref<Array<LighterASTNode?>>): Int { into.set(emptyArray()); return 0 }
    override fun disposeChildren(nodes: Array<out LighterASTNode>?, count: Int) {}
    override fun toString(node: LighterASTNode): CharSequence = "x"
    override fun getStartOffset(node: LighterASTNode): Int = node.startOffset
    override fun getEndOffset(node: LighterASTNode): Int = node.endOffset
}

fun main() = print(buildString {
    repeat(128) { index ->
        val configuration = CompilerConfiguration()
        configuration.put(CommonConfigurationKeys.LANGUAGE_VERSION_SETTINGS, LanguageVersionSettingsImpl.DEFAULT)
        configuration.put(JVMConfigurationKeys.SKIP_BODIES, index % 2 == 0)
        val selected = Fir2IrConfiguration.forKlibCompilation(configuration, BaseDiagnosticsCollector.DoNothing)
        check(!selected.allowNonCachedDeclarations); check(!selected.skipBodies)
        append("klib/noncached/").append(index).append('\t').append(selected.allowNonCachedDeclarations).append('\n')
        append("klib/skip-bodies/").append(index).append('\t').append(selected.skipBodies).append('\n')
        append("klib/serialization/").append(index).append('\t').append(selected.irVerificationSettings.validateForKlibSerialization).append('\n')
        val node = Node(index); val tree = Tree(node)
        val real = KtLightSourceElement(node, index, index + 1, tree)
        val fake = KtLightSourceElement(node, index, index + 1, tree, KtFakeSourceElementKind.DelegatedPropertyAccessor.Getter)
        for ([id, source] in listOf("real" to real, "fake" to fake, "null" to null)) {
            val element = buildImport { this.source = source; isAllUnder = false }
            check(element.psi == null)
            append("source/psi-null/").append(id).append('/').append(index).append('\t').append(element.psi == null).append('\n')
        }
    }
})

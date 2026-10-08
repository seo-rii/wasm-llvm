/** Exact declaration extraction for the selected whole-program Wasm profile. */
const JS = 'compiler/ir/backend.js/src/org/jetbrains/kotlin/ir/backend/js/';
const WASM = 'compiler/ir/backend.wasm/src/org/jetbrains/kotlin/backend/wasm/';

export const SPLITS = [
  { path: WASM + 'ic/IrFactoryImplForWasmIC.kt', start: 'class IrFactoryImplForWasmIC(stageController: StageController)', end: null,
    imports: ['org.jetbrains.kotlin.backend.common.compilationException', 'org.jetbrains.kotlin.backend.wasm.WasmBackendContext',
      'org.jetbrains.kotlin.backend.wasm.ir2wasm.Synthetics.Functions.createStringBuiltIn',
      'org.jetbrains.kotlin.backend.wasm.ir2wasm.Synthetics.Functions.jsToKotlinAnyAdapterBuiltIn',
      'org.jetbrains.kotlin.backend.wasm.ir2wasm.Synthetics.Functions.jsToKotlinStringAdapterBuiltIn',
      'org.jetbrains.kotlin.backend.wasm.ir2wasm.Synthetics.Functions.registerModuleDescriptorBuiltIn',
      'org.jetbrains.kotlin.backend.wasm.ir2wasm.Synthetics.Functions.runRootSuitesBuiltIn',
      'org.jetbrains.kotlin.backend.wasm.ir2wasm.Synthetics.Functions.tryGetAssociatedObjectBuiltIn',
      'org.jetbrains.kotlin.backend.wasm.ir2wasm.Synthetics.Functions.unitGetInstanceBuiltIn',
      'org.jetbrains.kotlin.backend.wasm.ir2wasm.Synthetics.HeapTypes.anyBuiltInType',
      'org.jetbrains.kotlin.backend.wasm.ir2wasm.Synthetics.HeapTypes.throwableBuiltInType',
      'org.jetbrains.kotlin.ir.backend.js.utils.findUnitGetInstanceFunction', 'org.jetbrains.kotlin.ir.declarations.*',
      'org.jetbrains.kotlin.ir.irAttribute', 'org.jetbrains.kotlin.ir.util.IdSignature', 'org.jetbrains.kotlin.ir.util.fileOrNull'],
    retainedDeclarations: ['IrFactoryImplForWasmIC', 'signatureForWasmIC', 'overrideBuiltInsSignatures'] },
  { path: JS + 'ic/CacheUpdater.kt', start: 'abstract class IrICModule<TFragment : IrICProgramFragment>', end: 'enum class DirtyFileState',
    imports: ['org.jetbrains.kotlin.ir.declarations.IrFile', 'org.jetbrains.kotlin.ir.declarations.IrModuleFragment', 'java.io.OutputStream'],
    retainedDeclarations: ['IrICModule', 'IrICProgramFragment', 'IrICProgramFragments', 'IrCompilerICInterface'] },
  { path: JS + 'ic/JsModuleArtifact.kt', start: 'abstract class SrcFileArtifact', end: '/**\n * This class encapsulates the JS AST for a specific kt file, which can be either dirty or not.',
    imports: [], retainedDeclarations: ['SrcFileArtifact', 'ModuleArtifact'] },
  { path: JS + 'transformers/irToJs/IrModuleToJsTransformer.kt',
    fragments: [
      { start: 'val IrModuleFragment.safeName: String', end: 'private typealias JsIrModules' },
      { start: 'enum class TranslationMode(', end: 'class IrModuleToJsTransformer(' },
      { start: 'val WebArtifactConfiguration.translationMode: TranslationMode', end: null },
    ],
    imports: ['org.jetbrains.kotlin.ir.declarations.*', 'org.jetbrains.kotlin.js.common.safeModuleName', 'org.jetbrains.kotlin.js.config.*'],
    retainedDeclarations: ['safeName', 'TranslationMode', 'translationMode'] },
];

// Each file is separately pinned and reference-checked. This is not a directory rule.
export const CANDIDATE_FILES = [
  JS + 'compilerWithIC.kt',
  ...['IncrementalCache.kt', 'IdSignatureSource.kt', 'JsPerFileCache.kt', 'KotlinLibraryHeader.kt', 'ICUtils.kt',
    'IdSignatureHashCalculator.kt', 'KotlinSourceFileMetadata.kt', 'JsPerModuleCache.kt', 'IncrementalCacheArtifact.kt',
    'JsMultiArtifactCache.kt', 'IncrementalCacheGuard.kt', 'HashCalculatorForIC.kt', 'JsIrLinkerLoader.kt',
    'IdSignatureSerialization.kt', 'JsExecutableProducer.kt'].map(name => JS + 'ic/' + name),
  WASM + 'compilerWithIC.kt', WASM + 'ic/WasmModuleArtifact.kt', WASM + 'ic/WasmModuleFragments.kt',
  WASM + 'serialization/WasmSerializer.kt', WASM + 'serialization/WasmDeserializer.kt',
];

export function generateBackendSplit(bytes, rule) {
  const text = bytes.toString('utf8');
  const header = text.slice(0, text.indexOf('package ')); const packageName = /^package ([\w.]+)$/m.exec(text)?.[1];
  if (!packageName) throw new Error('Missing selected backend package');
  for (const imported of rule.imports) if (!text.includes('\nimport ' + imported + '\n')) throw new Error('Invented backend source import');
  const fragments = (rule.fragments ?? [rule]).map(fragment => {
    if (text.split(fragment.start).length !== 2) throw new Error('Backend extraction start changed');
    const start = text.indexOf(fragment.start);
    const end = fragment.end === null ? text.length : text.indexOf(fragment.end, start + fragment.start.length);
    if (end <= start || fragment.end !== null && text.split(fragment.end).length !== 2) throw new Error('Backend extraction end changed');
    return Buffer.from(text.slice(start, end));
  });
  const body = Buffer.concat(fragments);
  return { body, fragments, bytes: Buffer.concat([Buffer.from(header + 'package ' + packageName + '\n\n' + rule.imports.map(name => 'import ' + name + '\n').join('') + '\n'), body]), packageName };
}

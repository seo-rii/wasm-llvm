import assert from 'node:assert/strict';

export const TARGET = 'compiler-port-entry/BrowserCompilerPipeline.kt';
export const TARGETS = [TARGET];

// Nonempty retained anchors make each deletion exactly reversible. This does
// not select an entry or implement a wrapper; the official phases own both.
const importAnchor = 'import org.jetbrains.kotlin.ir.backend.js.serializeModuleIntoMemoryKlib\n';
const declarationAnchor = '/**\n * Caller-owned approved configuration, output sink and immutable library indexes.\n';
const loweringAnchor = '        configuration.wasmDisableCrossFileOptimisations = false // official whole-program mode\n';
export const RECIPE = [
  { before: importAnchor + 'import org.jetbrains.kotlin.ir.backend.js.utils.JsMainFunctionDetector\n',
    after: importAnchor, occurrences: 1 },
  { before: '/** A console-profile user error, distinct from an internal compiler failure. */\n' +
      'class KotlinEntryRejected(val reasonCode: String, message: String) : Exception(message)\n\n' + declarationAnchor,
    after: declarationAnchor, occurrences: 1 },
  { before: '        // Use the official detector on analyzed IR. The first console profile\n' +
      '        // requires one ordinary no-argument main and rejects ambiguous entries.\n' +
      '        val detector = JsMainFunctionDetector(context)\n' +
      '        val entries = loadedIr.module.files.mapNotNull { detector.getMainFunctionOrNull(it) }\n' +
      '        if (entries.size != 1) throw KotlinEntryRejected("CONSOLE_ENTRY_COUNT", "Exactly one Kotlin main entry is required")\n' +
      '        if (entries.single().parameters.isNotEmpty() || entries.single().isSuspend) {\n' +
      '            throw KotlinEntryRejected("CONSOLE_ENTRY_SIGNATURE", "The console entry must be fun main()")\n' +
      '        }\n\n' + loweringAnchor,
    after: loweringAnchor, occurrences: 1 },
];

export const OFFICIAL_LINKAGE = `        // Preserve the upstream WasmIrLinkingPipelinePhase order and invariants.
        ExternalDependenciesGenerator(loadedIr.symbolTable, listOf(linker)).generateUnboundSymbolsAsDependencies()
        val dependencies = linker.moduleDependencyTracker.reverseTopoOrder(loadedIr.dependencies)
        val modules = dependencies.allDependencies
        modules.forEach { it.patchDeclarationParents() }
        linker.postProcess(loadedIr.bultins, inOrAfterLinkageStep = true)
        linker.checkNoUnboundSymbols(loadedIr.symbolTable, "at the end of IR linkage process")
        linker.clear()

`;
export const OFFICIAL_PHASE_TAIL = loweringAnchor + `        val lowered = compileToLoweredIr(configuration, linker, modules, context)
        if (configuration.dce) eliminateDeadDeclarations(lowered.loweredIr, context, DceDumpNameCache())
        if (diagnostics.hasErrors) throw SourceCompilationFailed(diagnostics)
        val wasmIr = compileWholeProgramModeToWasmIr(configuration, factory, lowered)
        val artifact = writeBrowserProgramBinary(wasmIr, maximumArtifactBytes)
        if (diagnostics.hasErrors) throw SourceCompilationFailed(diagnostics)
        return artifact
    }
}
`;

function officialPhases(text) {
  for (const span of [OFFICIAL_LINKAGE, OFFICIAL_PHASE_TAIL]) {
    assert.equal(text.split(span).length, 2, 'Complete official linkage/lowering/DCE/link/export span changed');
  }
  assert(text.indexOf(OFFICIAL_LINKAGE) < text.indexOf(OFFICIAL_PHASE_TAIL), 'Official phase order changed');
  assert(text.endsWith(OFFICIAL_PHASE_TAIL), 'Official phase tail changed');
}

export function transformOfficialMainEntry(logical, bytes, { reverse = false } = {}) {
  assert.equal(logical, TARGET, 'Official main profile changes only the complete production entry');
  let text = bytes.toString(); officialPhases(text);
  for (const row of reverse ? RECIPE.slice().reverse() : RECIPE) {
    const from = reverse ? row.after : row.before, to = reverse ? row.before : row.after;
    assert(from.length && text.split(from).length === row.occurrences + 1, 'Exact official-main transform span changed');
    text = text.split(from).join(to);
  }
  officialPhases(text);
  if (!reverse) {
    for (const removed of ['JsMainFunctionDetector', 'KotlinEntryRejected', 'CONSOLE_ENTRY_COUNT', 'CONSOLE_ENTRY_SIGNATURE']) {
      assert(!text.includes(removed), 'Private pre-lowering entry restriction remains: ' + removed);
    }
  }
  return Buffer.from(text);
}

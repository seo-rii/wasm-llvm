#!/usr/bin/env node
/** Builds the official compiler sources for the Wasm host; never runs a native user-code compiler. */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertNoSymlink, readJson, readRegular, relativePath, sha256, verifyFile, writeJson } from '../scripts/source.mjs';
import { verifyBootstrap, defaultCache } from '../build/bootstrap.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../..');
const execute = promisify(execFile);

export async function buildCompiler({ input = path.join(repository, 'out/kotlin-compiler-port'), output,
  sourceHost = 'portable', cacheRoot = defaultCache, maximumHeap = '3g', timeoutMs = 600000,
  protobufBuild = path.join(repository, 'out/kotlin-compiler-serialization/probe-8/codec') } = {}) {
  // Verification and compiler subprocesses use different working directories.
  // Bind CLI paths once before either operation so they select identical bytes.
  input = path.resolve(input);
  cacheRoot = path.resolve(cacheRoot);
  protobufBuild = path.resolve(protobufBuild);
  assert(['original', 'portable'].includes(sourceHost), 'Unknown source host mode');
  assert(['2g', '3g', '4g'].includes(maximumHeap), 'Unsupported compiler build heap');
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 1200000, 'Invalid build deadline');
  const lockBytes = await readRegular(path.join(here, 'closure.lock.json'), 8 * 1024 * 1024);
  const lock = JSON.parse(lockBytes);
  const prepared = await readJson(path.join(input, 'inputs.json'));
  assert.equal(lock.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
  assert.equal(prepared.lockSha256, sha256(lockBytes), 'Prepared compiler source lock changed');
  assert.equal(prepared.sourceBytesVerified, true);
  assert.equal(prepared.source.commit, lock.source.commit);
  assert(Array.isArray(lock.files) && lock.files.length <= 12000, 'Invalid compiler source closure');
  const bootstrap = await verifyBootstrap(cacheRoot);
  assert.equal(bootstrap.lock.version, lock.bootstrapVersion);
  if (output) {
    output = path.resolve(output);
    assert(output.startsWith(path.join(repository, 'out') + path.sep), 'Compiler builds must stay under repository out/');
    await assertNoSymlink(output);
    await mkdir(path.dirname(output), { recursive: true });
    await mkdir(output);
  } else {
    const parent = path.join(repository, 'out/kotlin-compiler-port/builds');
    await assertNoSymlink(parent);
    await mkdir(parent, { recursive: true });
    output = await mkdtemp(path.join(parent, 'run-'));
  }
  const sourceRoot = path.join(output, 'sources');
  const files = new Map();
  for (const pin of lock.files) {
    relativePath(pin.path);
    assert(!files.has(pin.path), 'Duplicate compiler source path');
    const bytes = verifyFile(await readRegular(path.join(prepared.sourceRoot, pin.path), pin.bytes), pin);
    const filename = path.join(sourceRoot, pin.path);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
    files.set(pin.path, { filename, bytes: bytes.length, sha256: pin.sha256, compile: pin.compile });
  }
  await execute('git', ['init', '--quiet', sourceRoot], { timeout: 10000, maxBuffer: 65536 });
  const receipt = {
    schemaVersion: 1, kind: 'official-kotlin-compiler-wasmjs-build', source: lock.source,
    lockSha256: sha256(lockBytes), buildToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
    compilerHost: 'wasmJs', programTarget: 'wasmWasi', sourceHost,
    bootstrap: { version: bootstrap.lock.version, sourceCommit: null,
      artifacts: bootstrap.artifacts.map(({ id, file, bytes, sha256 }) => ({ id, file, bytes, sha256 })) },
    commands: [], status: 'building', browserCompiler: 'not-built', publicLanguageSupport: false,
  };
  const hostFlags = new Set();
  const propertyAliasImports = new Set();
  let assertionImport;
  async function bindCompilerJvmAnnotations(sourcePaths) {
    const imported = [];
    for (const sourcePath of sourcePaths) {
      const pin = files.get(sourcePath);
      assert(pin, 'Missing compiler annotation source: ' + sourcePath);
      if (!pin.compile || !sourcePath.endsWith('.kt')) continue;
      const original = await readRegular(pin.filename, pin.bytes);
      const code = original.toString('utf8');
      if (!/@(?:\w+:)?(?:Jvm[A-Za-z]+|Volatile|Transient|Synchronized)\b/.test(code)) continue;
      if (/^import kotlin\.jvm\.\*\s*$/m.test(code)) continue;
      const declaration = /^package[ \t]+[^\r\n]+/m.exec(code);
      assert(declaration, 'Missing compiler source package: ' + sourcePath);
      const end = declaration.index + declaration[0].length;
      const bytes = Buffer.from(code.slice(0, end) + '\nimport kotlin.jvm.*\n' + code.slice(end));
      await writeFile(pin.filename, bytes, { mode: 0o600 });
      imported.push({ path: sourcePath, originalSha256: pin.sha256, bytes: bytes.length, sha256: sha256(bytes) });
      files.set(sourcePath, { ...pin, bytes: bytes.length, sha256: sha256(bytes) });
    }
    return imported;
  }
  try {
    if (sourceHost === 'portable') {
      const preparedComponents = new Map();
      const preparations = [
        ['sourceHostReceipt', (await import('./host/prepare.mjs')).prepareHostSources],
        ['positioningReceipt', async ({ sourceRoot, outputRoot }) => {
          const cache = await (await import('./positioning/fetch.mjs')).preparePositioningSourceCache();
          const component = await (await import('./positioning/prepare.mjs')).preparePositioningSources({
            sourceRoot, outputRoot, positioningSourceRoot: cache.positioningSourceRoot,
          });
          assert(component.sourceSetExclusions.every((entry) => typeof entry.path === 'string' && typeof entry.reason === 'string'));
          return { ...component, sourceSetExclusions: component.sourceSetExclusions.map((entry) => relativePath(entry.path)) };
        }],
        ['diagnosticFactoriesReceipt', (await import('./diagnostic-factories/prepare.mjs')).prepareDiagnosticFactories],
        ['sourceClosureReceipt', async ({ outputRoot }) => {
          const sources = await import('./source-closure/prepare.mjs');
          const reference = await sources.prepareSourceClosureReferences();
          const component = await sources.prepareSourceClosure({ sourceRoot: reference.sourceRoot, outputRoot });
          const additional = new Set(component.additionalOriginalPaths);
          assert.equal(additional.size, component.additionalOriginalPaths.length, 'Duplicate supplemental source input');
          const originals = component.sourceFiles.filter(pin => additional.has(pin.path));
          assert.equal(originals.length, additional.size, 'Unpinned supplemental source input');
          for (const pin of originals) {
            const sourcePath = relativePath(pin.path);
            assert(!files.has(sourcePath), 'Supplemental source conflicts with primary inventory: ' + sourcePath);
            const filename = path.join(component.originalSourceRoot, sourcePath);
            verifyFile(await readRegular(filename, pin.bytes), pin);
            // Register verified original identity for replacement checks. Only
            // the component's selected common outputs enter compilation.
            files.set(sourcePath, { filename, bytes: pin.bytes, sha256: pin.sha256, compile: false });
          }
          const deferred = 'compiler/fir/checkers/checkers.web.common/src/org/jetbrains/kotlin/fir/analysis/diagnostics/web/common/FirWebCommonErrorsDefaultMessages.kt';
          assert(additional.has(deferred), 'Missing supplemental web diagnostic renderer');
          const renderingSources = component.commonSources.filter(filename => filename.endsWith('/' + deferred));
          assert.equal(renderingSources.length, 1);
          receipt.sourceClosureSupplementalOriginals = originals;
          receipt.sourceClosureRenderingComposition = { originalPath: deferred, deferredSources: renderingSources,
            rule: 'The diagnostic-rendering component supplies this original table exactly once', checkerFilesExcluded: false };
          return { ...component, commonSources: component.commonSources.filter(filename => !renderingSources.includes(filename)) };
        }],
        ['diagnosticCommonReceipt', async ({ outputRoot }) => {
          const renderers = await import('./diagnostic-common/prepare.mjs');
          const reference = await renderers.prepareDiagnosticCommonReferences();
          const component = await renderers.prepareDiagnosticCommon({ sourceRoot: reference.sourceRoot, outputRoot });
          await renderers.verifyDiagnosticCommon(path.dirname(component.receiptPath));
          for (const pin of component.receipt.originalInputs) {
            assert(!files.has(pin.path), 'Supplemental renderer conflicts with primary source: ' + pin.path);
          }
          return component;
        }],
        ['diagnosticDslReceipt', async ({ outputRoot }) => {
          const dsl = await import('./diagnostic-dsl/prepare.mjs');
          const reference = await dsl.prepareDiagnosticDslReferences();
          const component = await dsl.prepareDiagnosticDsl({ sourceRoot: reference.sourceRoot, outputRoot });
          await dsl.verifyDiagnosticDsl(path.dirname(component.receiptPath));
          assert.deepEqual(component.sourceFiles.map(pin => pin.path), component.additionalOriginalPaths);
          for (const pin of component.sourceFiles) {
            const sourcePath = relativePath(pin.path);
            assert(!files.has(sourcePath), 'Supplemental diagnostic DSL conflicts with primary source: ' + sourcePath);
            const filename = path.join(component.originalSourceRoot, sourcePath);
            verifyFile(await readRegular(filename, pin.bytes), pin);
            files.set(sourcePath, { filename, bytes: pin.bytes, sha256: pin.sha256, compile: false });
          }
          return component;
        }],
        ['diagnosticRenderingReceipt', async ({ sourceRoot, outputRoot }) => {
          assert(preparedComponents.has('sourceClosureReceipt'), 'Supplemental web checkers must be prepared first');
          const rendering = await import('./diagnostic-rendering/prepare.mjs');
          await rendering.prepareDiagnosticRenderingReferences();
          const component = await rendering.prepareDiagnosticRendering({ sourceRoot, outputRoot,
            additionalSourceRoot: preparedComponents.get('sourceClosureReceipt').originalSourceRoot });
          for (const pin of component.supplementalOriginals) {
            assert(files.has(relativePath(pin.path)), 'Missing registered supplemental diagnostic source');
            assert.equal(files.get(pin.path).sha256, pin.sha256, 'Supplemental diagnostic original identity changed');
          }
          receipt.requiredDiagnosticProfile = component.requiredDiagnosticProfile;
          return component;
        }],
        ['parserProfileReceipt', (await import('./parser-profile/prepare.mjs')).prepareParserProfileSources],
        ['coreReceipt', (await import('./core/prepare.mjs')).prepareCoreSources],
        ['configurationReceipt', (await import('./config/prepare.mjs')).prepareConfigurationSources],
        ['messagesReceipt', (await import('./messages/prepare.mjs')).prepareCompilerMessageSources],
        ['versionsReceipt', async ({ sourceRoot, outputRoot }) => {
          const component = await (await import('./versions/prepare.mjs')).prepareVersionSources({
            sourceRoot, outputRoot,
            buildVersionInput: path.join(here, 'compiler-version-input.json'),
            buildVersionInputSha256: '422a2027b62a7de286c5dc75e84f565bf0a2dd3867f98ea56225ce6444ae6d16',
          });
          // These two original inputs belong to the same pinned source tree,
          // outside the primary inventory. They are verified by this component,
          // rather than silently accepting a missing primary replacement.
          const additional = component.receipt.sourceFiles.filter((pin) => pin.location === 'additional');
          assert.deepEqual(additional.map((pin) => pin.path).sort(), [
            'compiler/compiler.version/src/org/jetbrains/kotlin/config/KotlinCompilerVersion.java',
            'libraries/tools/kotlin-tooling-core/src/main/kotlin/org/jetbrains/kotlin/tooling/core/KotlinToolingVersion.kt',
          ]);
          const supplementalPaths = new Set(additional.map((pin) => pin.path));
          const absent = component.replacedOriginalPaths.filter((sourcePath) => !files.has(sourcePath));
          assert(absent.every((sourcePath) => supplementalPaths.has(sourcePath)), 'Missing primary version input');
          receipt.versionsSupplementalOriginals = additional;
          return { ...component, replacedOriginalPaths: component.replacedOriginalPaths.filter((sourcePath) => files.has(sourcePath)) };
        }],
        ['commonJavaReceipt', (await import('./common-java/prepare.mjs')).prepareCommonJavaSources],
        ['descriptorReceipt', async ({ sourceRoot, outputRoot }) => {
          const component = await (await import('./descriptors/prepare.mjs')).prepareDescriptorContracts(
            sourceRoot, path.join(outputRoot, 'compiler-port-descriptors'));
          return { ...component, commonSources: component.sourceFiles };
        }],
        ['typeContractReceipt', async ({ sourceRoot, outputRoot }) => {
          const component = await (await import('./type-contracts/prepare.mjs')).prepareTypeContracts(
            sourceRoot, path.join(outputRoot, 'compiler-port-type-contracts'));
          return { ...component, commonSources: component.sourceFiles };
        }],
        ['typeImplementationReceipt', async ({ sourceRoot, outputRoot }) => {
          const component = await (await import('./type-implementation/prepare.mjs')).prepareTypeImplementations(
            sourceRoot, path.join(outputRoot, 'compiler-port-type-implementation'));
          return { ...component, commonSources: component.sourceFiles };
        }],
        ['typeUtilitiesReceipt', async ({ sourceRoot, outputRoot }) => {
          const component = await (await import('./type-utilities/prepare.mjs')).prepareTypeUtilities(
            sourceRoot, path.join(outputRoot, 'compiler-port-type-utilities'));
          return { ...component, commonSources: component.sourceFiles };
        }],
        ['visibilityReceipt', (await import('./visibility/prepare.mjs')).prepareVisibilitySources],
        ['builtInsReceipt', (await import('./builtins/prepare.mjs')).prepareBuiltInsSources],
        ['descriptorUtilsReceipt', (await import('./descriptor-utils/prepare.mjs')).prepareDescriptorUtilsSources],
        ['assertionReceipt', (await import('./assertions/prepare.mjs')).prepareAssertionSources],
        ['storageReceipt', (await import('./storage/prepare.mjs')).prepareStorageSources],
        ['collectionsReceipt', (await import('./collections/prepare.mjs')).prepareCollectionsSources],
        ['smartSetReceipt', (await import('./smart-set/prepare.mjs')).prepareSmartSetSources],
        ['identityReceipt', (await import('./identity/prepare.mjs')).prepareIdentitySources],
        ['coneClassIdentityReceipt', async ({ sourceRoot, outputRoot }) => {
          const cone = await import('./cone-class-identity/prepare.mjs');
          const component = await cone.prepareConeClassIdentitySources({ sourceRoot, outputRoot,
            preparedIdentity: preparedComponents.get('identityReceipt') });
          await cone.verifyConeClassIdentity(outputRoot);
          return component;
        }],
        ['firStorageReceipt', (await import('./fir-storage/prepare.mjs')).prepareFirStorageSources],
        ['registryReceipt', (await import('./registry/prepare.mjs')).prepareRegistrySources],
        ['sessionProfileReceipt', (await import('./session-profile/prepare.mjs')).prepareSessionProfile],
        ['serialResolveReceipt', (await import('./serial-resolve/prepare.mjs')).prepareSerialResolveSources],
        ['flagsReceipt', (await import('./flags/prepare.mjs')).prepareFlagsSources],
        ['bitSetReceipt', async ({ sourceRoot, outputRoot }) => {
          const bitSet = await import('./bit-set/prepare.mjs');
          await bitSet.prepareBitSetReferences();
          return bitSet.prepareBitSetSources({ sourceRoot, outputRoot });
        }],
        ['textReceipt', (await import('./text/prepare.mjs')).prepareCompilerTextSources],
        ['wasmCollectionsReceipt', async ({ sourceRoot, outputRoot }) => {
          const collections = await import('./wasm-collections/prepare.mjs');
          return collections.prepareWasmCollectionsSources({ sourceRoot, outputRoot,
            preparedIdentity: preparedComponents.get('identityReceipt'),
            preparedText: preparedComponents.get('textReceipt') });
        }],
        ['klibReceipt', (await import('./klib/prepare.mjs')).prepareKlibSources],
        ['linkerReceipt', (await import('./linker/prepare.mjs')).prepareLinkerSources],
        ['backendReceipt', (await import('./backend/prepare.mjs')).prepareBackendSources],
        ['jsAstReceipt', async ({ sourceRoot, outputRoot }) => {
          const ast = await import('./js-ast/prepare.mjs');
          const component = await ast.prepareJsAstSources({ sourceRoot, outputRoot });
          await ast.verifyJsAstPreparation(outputRoot, { sourceRoot });
          const sharedDependencies = [];
          for (const dependency of component.receipt.commonDependencies) {
            const owner = { '../collections/SmartList.kt': 'collectionsReceipt',
              '../assertions/CompilerAssertions.kt': 'assertionReceipt' }[dependency.path];
            assert(owner && preparedComponents.has(owner), 'Missing genuine shared AST dependency');
            const candidates = preparedComponents.get(owner).commonSources;
            const matches = [...files].filter(([, pin]) => pin.compile && candidates.includes(pin.filename)
              && pin.bytes === dependency.bytes && pin.sha256 === dependency.sha256);
            assert.equal(matches.length, 1, 'AST dependency must bind one existing compiler source');
            const [sourcePath, pin] = matches[0];
            verifyFile(await readRegular(pin.filename, pin.bytes), dependency);
            sharedDependencies.push({ path: sourcePath, component: owner, bytes: pin.bytes, sha256: pin.sha256 });
          }
          receipt.jsAstSharedDependencies = sharedDependencies;
          return component;
        }],
        ['jsAstIntegerConsumerReceipt', async ({ sourceRoot, outputRoot }) => {
          const integer = await import('./js-ast-consumer-bindings/integer/prepare.mjs');
          const verifier = await import('./js-ast-consumer-bindings/integer/verify.mjs');
          const retainedSources = [...files].filter(([, pin]) => pin.compile && pin.filename.endsWith('.kt'))
            .map(([sourcePath, pin]) => ({ path: sourcePath, ...pin }));
          const component = await integer.prepareAstIntegerConsumer({ sourceRoot, outputRoot, retainedSources });
          await verifier.verifyAstIntegerConsumerPreparation({ sourceRoot, outputRoot,
            receiptPath: component.receiptPath, retainedSources });
          const astSources = preparedComponents.get('jsAstReceipt').commonSources;
          receipt.jsAstIntegerSharedDependencies = [];
          for (const dependency of component.astDependencies) {
            const matches = [...files].filter(([, pin]) => pin.compile && astSources.includes(pin.filename)
              && pin.bytes === dependency.bytes && pin.sha256 === dependency.sha256);
            assert.equal(matches.length, 1, 'Integer consumer must bind one genuine AST integer source');
            const [sourcePath, pin] = matches[0];
            verifyFile(await readRegular(pin.filename), dependency);
            receipt.jsAstIntegerSharedDependencies.push({ path: sourcePath, bytes: pin.bytes, sha256: pin.sha256 });
          }
          return component;
        }],
        ['backendProfileReceipt', async ({ sourceRoot, outputRoot }) => {
          assert(preparedComponents.has('backendReceipt'), 'Whole-program backend must be prepared first');
          return (await import('./backend-profile/prepare.mjs')).prepareBackendProfileSources({
            sourceRoot, outputRoot,
            preparedBackend: preparedComponents.get('backendReceipt'),
            browserEntry: path.join(here, 'entry/BrowserCompilerPipeline.kt'),
            retainedSources: [...files.values()].filter((pin) => pin.compile && pin.filename.endsWith('.kt'))
              .map((pin) => pin.filename),
          });
        }],
      ];
      const replacements = new Map();
      for (const [key, prepare] of preparations) {
        // Each patch family is checked against its own original snapshot. A
        // shared source (e.g. LEB128) is bound once only when both portable
        // versions are identical; patch ordering cannot hide a conflict.
        const componentRoot = path.join(output, 'components', key);
        await mkdir(componentRoot, { recursive: true });
        await execute('git', ['init', '--quiet', componentRoot], { timeout: 10000, maxBuffer: 65536 });
        const component = await prepare({ sourceRoot: prepared.sourceRoot, outputRoot: componentRoot });
        preparedComponents.set(key, component);
        receipt[key] = component.receipt;
        for (const binding of component.predecessorBindings ?? []) {
          assert(preparedComponents.has(binding.component), 'Missing predecessor component');
          const sourcePath = relativePath(binding.componentRelativePath);
          const previous = replacements.get(sourcePath);
          assert(previous && files.has(sourcePath), 'Missing predecessor source binding: ' + sourcePath);
          assert.equal(previous.filename, binding.filename);
          assert.equal(previous.bytes, binding.bytes); assert.equal(previous.sha256, binding.sha256);
          assert.equal(files.get(sourcePath), previous, 'Predecessor source was replaced before the audited layer');
          const bytes = await readRegular(previous.filename, previous.bytes);
          assert.equal(bytes.length, binding.bytes); assert.equal(sha256(bytes), binding.sha256);
          files.set(sourcePath, { ...previous, compile: false });
          replacements.delete(sourcePath);
        }
        if (component.assertionImport) {
          assert.equal(component.assertionImport, 'org.jetbrains.kotlin.portable.assertions.compilerAssert as assert');
          assert(!assertionImport, 'Duplicate compiler assertion adapter');
          assertionImport = component.assertionImport;
        }
        if (component.propertyAliasImport) {
          assert(/^[a-zA-Z0-9_.]+\.\*$/.test(component.propertyAliasImport), 'Invalid compiler property alias import');
          propertyAliasImports.add(component.propertyAliasImport);
        }
        if (component.propertyAliasImports) {
          assert(Array.isArray(component.propertyAliasImports)
            && new Set(component.propertyAliasImports).size === component.propertyAliasImports.length);
          for (const name of component.propertyAliasImports) {
            assert(typeof name === 'string' && /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(name),
              'Invalid explicit compiler property alias import');
            propertyAliasImports.add(name);
          }
        }
        for (const flag of component.requiredFlags ?? []) {
          assert(typeof flag === 'string' && flag.startsWith('-'), 'Invalid compiler host flag');
          hostFlags.add(flag);
        }
        for (const excluded of component.replacedOriginalPaths ?? []) {
          const sourcePath = relativePath(excluded);
          assert(files.has(sourcePath), 'Missing replaced original: ' + sourcePath);
          files.set(sourcePath, { ...files.get(sourcePath), compile: false });
        }
        const absentExclusions = [];
        for (const excluded of component.sourceSetExclusions ?? []) {
          const sourcePath = relativePath(excluded);
          if (files.has(sourcePath)) files.set(sourcePath, { ...files.get(sourcePath), compile: false });
          else absentExclusions.push(sourcePath);
        }
        if (absentExclusions.length) receipt[key + 'AbsentExclusions'] = absentExclusions;
        for (const filename of component.commonSources) {
          assert(filename.startsWith(componentRoot + path.sep));
          const sourcePath = relativePath(path.relative(componentRoot, filename));
          const bytes = await readRegular(filename);
          const digest = sha256(bytes);
          if (replacements.has(sourcePath)) {
            assert.equal(digest, replacements.get(sourcePath).sha256, 'Conflicting portable source: ' + sourcePath);
            continue;
          }
          const pin = { filename, bytes: bytes.length, sha256: digest, compile: true };
          replacements.set(sourcePath, pin);
          files.set(sourcePath, pin);
        }
      }
      receipt.portableSourceBindings = [...replacements].map(([sourcePath, pin]) => ({ path: sourcePath, sha256: pin.sha256 }));
      // Original Java static imports bind to the actual Kotlin companion after
      // source porting. Object wildcard imports require explicit members. This
      // changes only compiler-host import spelling; it never touches user text.
      const staticOwners = new Map([
        ['org.jetbrains.kotlin.name.Name', ['special', 'identifier']],
        ['org.jetbrains.kotlin.resolve.DescriptorUtils', ['getContainingClass', 'isCompanionObject', 'getFqName']],
        ['org.jetbrains.kotlin.builtins.KotlinBuiltIns', ['isAny']],
        ['org.jetbrains.kotlin.types.TypeUtils', ['makeStarProjection', 'CANNOT_INFER_FUNCTION_PARAM_TYPE']],
        ['org.jetbrains.kotlin.descriptors.DescriptorVisibilities', ['isPrivate', 'INTERNAL', 'PRIVATE', 'INVISIBLE_FAKE']],
      ]);
      const objectOwners = new Map([
        ['org.jetbrains.kotlin.lexer.KtTokens', receipt.positioningReceipt.declarations.tokenFields],
        ['org.jetbrains.kotlin.KtNodeTypes', receipt.positioningReceipt.declarations.nodeFields],
      ]);
      const importBindings = [];
      for (const [sourcePath, pin] of files) {
        if (!pin.compile || !sourcePath.endsWith('.kt')) continue;
        const original = await readRegular(pin.filename, pin.bytes);
        let code = original.toString('utf8');
        for (const [owner, members] of staticOwners) {
          for (const member of members) {
            const pattern = new RegExp('^import ' + (owner + '.' + member).replaceAll('.', '\\.') + '(?=[ \\t]*$|[ \\t]+as\\b)', 'gm');
            code = code.replace(pattern, 'import ' + owner + '.Companion.' + member);
          }
        }
        for (const [owner, members] of objectOwners) {
          assert(Array.isArray(members) && new Set(members).size === members.length && members.every((name) => /^\w+$/.test(name)));
          const pattern = new RegExp('^import ' + owner.replaceAll('.', '\\.') + '\\.\\*[ \\t]*$', 'gm');
          code = code.replace(pattern, members.map((member) => 'import ' + owner + '.' + member).join('\n'));
        }
        if (code === original.toString('utf8')) continue;
        const bytes = Buffer.from(code);
        await writeFile(pin.filename, bytes, { mode: 0o600 });
        importBindings.push({ path: sourcePath, originalSha256: pin.sha256, bytes: bytes.length, sha256: sha256(bytes) });
        files.set(sourcePath, { ...pin, bytes: bytes.length, sha256: sha256(bytes) });
      }
      receipt.staticImportBindings = { rule: 'actual common companion methods and explicit verified legacy token members',
        staticOwners: Object.fromEntries(staticOwners), objectOwners: Object.fromEntries(objectOwners), sources: importBindings };
      // JVM compiler tasks import kotlin.jvm annotations by default. These are
      // official optional common annotations; import them explicitly for C's
      // Wasm host. User source text never passes through this transformation.
      receipt.annotationImports = { rule: 'explicit-kotlin-jvm-optional-annotation-import',
        sources: await bindCompilerJvmAnnotations([...files.keys()]) };
      const propertyImports = [];
      for (const [sourcePath, pin] of files) {
        if (!pin.compile || !sourcePath.endsWith('.kt')) continue;
        const original = await readRegular(pin.filename, pin.bytes);
        const code = original.toString('utf8');
        const imports = [...propertyAliasImports].filter((name) => !code.includes('import ' + name));
        if (!imports.length) continue;
        const declaration = /^package[ \t]+[^\r\n]+/m.exec(code);
        assert(declaration, 'Missing compiler source package: ' + sourcePath);
        const end = declaration.index + declaration[0].length;
        const bytes = Buffer.from(code.slice(0, end) + '\n' + imports.map((name) => 'import ' + name).join('\n') + '\n' + code.slice(end));
        await writeFile(pin.filename, bytes, { mode: 0o600 });
        propertyImports.push({ path: sourcePath, originalSha256: pin.sha256, bytes: bytes.length, sha256: sha256(bytes) });
        files.set(sourcePath, { ...pin, bytes: bytes.length, sha256: sha256(bytes) });
      }
      receipt.propertyImports = { rule: 'Java-property-spelling-through-typed-common-getter-aliases', imports: [...propertyAliasImports], sources: propertyImports };
      const assertionBindings = [];
      assert(assertionImport, 'Enabled compiler assertion host is required');
      for (const [sourcePath, pin] of files) {
        if (!pin.compile || !sourcePath.endsWith('.kt')) continue;
        const original = await readRegular(pin.filename, pin.bytes);
        const code = original.toString('utf8');
        if (sourcePath.startsWith('compiler-port-assertions/')) continue;
        if (!/\bassert\s*\(/.test(code) && !/^import kotlin\.assert\s*$/m.test(code)) continue;
        const declaration = /^package[ \t]+[^\r\n]+/m.exec(code);
        assert(declaration, 'Missing compiler source package: ' + sourcePath);
        // Only verified compiler source inputs enter this mechanical host
        // binding. User text remains immutable and never enters this loop.
        assert(!/\bkotlin\.assert\s*\(/.test(code), 'Qualified compiler assert requires a reviewed binding: ' + sourcePath);
        const rebound = code.replace(/^import kotlin\.assert[ \t]*\r?\n/gm, '');
        const packageLine = /^package[ \t]+[^\r\n]+/m.exec(rebound);
        const end = packageLine.index + packageLine[0].length;
        const bytes = Buffer.from(rebound.slice(0, end) + '\nimport ' + assertionImport + '\n' + rebound.slice(end));
        await writeFile(pin.filename, bytes, { mode: 0o600 });
        assertionBindings.push({ path: sourcePath, originalSha256: pin.sha256, bytes: bytes.length, sha256: sha256(bytes) });
        files.set(sourcePath, { ...pin, bytes: bytes.length, sha256: sha256(bytes) });
      }
      receipt.assertionBindings = { rule: 'enabled compiler invariant checks with exact official Wasm assertion bodies', import: assertionImport, sources: assertionBindings };
      // The browser entry uses official FIR2IR. The legacy PSI -> IR frontend
      // is a separate, unsupported source-entry path, not a Wasm lowering.
      const legacyPrefix = 'compiler/ir/ir.psi2ir/';
      const sharedLegacyNames = ['TypeParametersResolver', 'ScopedTypeParametersResolver', 'createIrClassFromDescriptor',
        'declareSimpleFunctionWithOverrides', 'generateOverriddenFunctionSymbols'];
      for (const [sourcePath, pin] of files) {
        if (!pin.compile || !sourcePath.endsWith('.kt') || sourcePath.startsWith(legacyPrefix)) continue;
        const text = (await readRegular(pin.filename, pin.bytes)).toString('utf8');
        assert(!text.includes('import org.jetbrains.kotlin.psi2ir.'), 'Retained source depends on legacy PSI2IR: ' + sourcePath);
        for (const name of sharedLegacyNames) {
          assert(!new RegExp('\\b' + name + '\\b').test(text), 'Retained source requires shared PSI2IR declaration ' + name + ': ' + sourcePath);
        }
      }
      const legacySources = [];
      for (const [sourcePath, pin] of files) {
        if (!pin.compile || !sourcePath.startsWith(legacyPrefix)) continue;
        legacySources.push({ path: sourcePath, bytes: pin.bytes, sha256: pin.sha256 });
        files.set(sourcePath, { ...pin, compile: false });
      }
      assert(legacySources.length > 0, 'Legacy frontend exclusion must bind actual source inputs');
      receipt.sourceProfile = {
        frontend: 'MultiplatformParsing2Fir + official FIR2IR',
        excludedFrontend: 'legacy PSI2IR',
        sharedLegacyNamesChecked: sharedLegacyNames,
        excludedSources: legacySources,
        selectedFirOrWasmPhasesRemoved: false,
        symbolClosureProved: false,
      };
    }
    const entryRoot = path.join(sourceRoot, 'compiler-port-entry');
    await mkdir(entryRoot);
    for (const name of ['BrowserCompiler.kt', 'BrowserCompilerPipeline.kt']) {
      const entryBytes = await readRegular(path.join(here, 'entry', name));
      const entryFile = path.join(entryRoot, name);
      await writeFile(entryFile, entryBytes, { flag: 'wx', mode: 0o600 });
      files.set('compiler-port-entry/' + name, { filename: entryFile, bytes: entryBytes.length,
        sha256: sha256(entryBytes), compile: true });
    }
    if (sourceHost === 'portable') {
      const dsl = await import('./diagnostic-source-dsl/prepare.mjs');
      const reference = await dsl.prepareDiagnosticSourceDslReferences();
      const componentRoot = path.join(output, 'components', 'diagnosticSourceDslReceipt');
      const component = await dsl.prepareDiagnosticSourceDsl({ sourceRoot: prepared.sourceRoot,
        referenceRoot: reference.sourceRoot, outputRoot: componentRoot,
        retainedSources: [...files].filter(([, pin]) => pin.compile && pin.filename.endsWith('.kt'))
          .map(([sourcePath, pin]) => ({ path: sourcePath, ...pin })) });
      await dsl.verifyDiagnosticSourceDsl(path.dirname(component.receiptPath));
      receipt.diagnosticSourceDslReceipt = component.receipt;
      for (const excluded of component.replacedOriginalPaths) {
        const sourcePath = relativePath(excluded); assert(files.get(sourcePath)?.compile);
        files.set(sourcePath, { ...files.get(sourcePath), compile: false });
      }
      const addedPaths = [];
      for (const filename of component.commonSources) {
        assert(filename.startsWith(componentRoot + path.sep));
        const sourcePath = relativePath(path.relative(componentRoot, filename));
        assert(!files.has(sourcePath), 'Duplicate sourced diagnostic input: ' + sourcePath);
        const bytes = await readRegular(filename); const digest = sha256(bytes);
        files.set(sourcePath, { filename, bytes: bytes.length, sha256: digest, compile: true });
        receipt.portableSourceBindings.push({ path: sourcePath, sha256: digest });
        addedPaths.push(sourcePath);
      }
      receipt.annotationImports.sources.push(...await bindCompilerJvmAnnotations(addedPaths));
    }
    if (sourceHost === 'portable') {
      // The disk-only fingerprint overload can be split only after the final
      // source selection and entry are known. Verify every actual reader.
      const fingerprints = await import('./fingerprints/prepare.mjs');
      const componentRoot = path.join(output, 'components', 'fingerprintsReceipt');
      const component = await fingerprints.prepareCompilerFingerprints({ sourceRoot: prepared.sourceRoot, outputRoot: componentRoot,
        retainedSources: [...files].filter(([, pin]) => pin.compile && pin.filename.endsWith('.kt'))
          .map(([sourcePath, pin]) => ({ path: sourcePath, ...pin })) });
      await fingerprints.verifyCompilerFingerprints(path.dirname(component.receiptPath));
      receipt.fingerprintsReceipt = component.receipt;
      for (const excluded of component.replacedOriginalPaths) {
        const sourcePath = relativePath(excluded); assert(files.has(sourcePath));
        files.set(sourcePath, { ...files.get(sourcePath), compile: false });
      }
      for (const filename of component.commonSources) {
        assert(filename.startsWith(componentRoot + path.sep));
        const sourcePath = relativePath(path.relative(componentRoot, filename));
        assert(!files.has(sourcePath), 'Duplicate fingerprint source: ' + sourcePath);
        const bytes = await readRegular(filename); const digest = sha256(bytes);
        files.set(sourcePath, { filename, bytes: bytes.length, sha256: digest, compile: true });
        receipt.portableSourceBindings.push({ path: sourcePath, sha256: digest });
      }
    }
    if (sourceHost === 'portable') {
      const readerProfile = await import('./binary-reader-profile/prepare.mjs');
      const component = await readerProfile.prepareBinaryReaderProfile({ sourceRoot: prepared.sourceRoot,
        outputRoot: path.join(output, 'components', 'binaryReaderProfileReceipt'),
        retainedSources: [...files].filter(([, pin]) => pin.compile && pin.filename.endsWith('.kt'))
          .map(([sourcePath, pin]) => ({ path: sourcePath, ...pin })) });
      await readerProfile.verifyBinaryReaderProfile(path.dirname(component.receiptPath));
      receipt.binaryReaderProfileReceipt = component.receipt;
      for (const excluded of component.sourceSetExclusions) {
        const sourcePath = relativePath(excluded); assert(files.has(sourcePath));
        files.set(sourcePath, { ...files.get(sourcePath), compile: false });
      }
    }
    if (sourceHost === 'portable') {
      const profile = await import('./k1-container-profile/prepare.mjs');
      const componentRoot = path.join(output, 'components', 'k1ContainerProfileReceipt');
      const component = await profile.prepareK1ContainerProfile({ sourceRoot: prepared.sourceRoot,
        outputRoot: componentRoot,
        retainedSources: [...files].filter(([, pin]) => pin.compile && pin.filename.endsWith('.kt'))
          .map(([sourcePath, pin]) => ({ path: sourcePath, ...pin })) });
      await profile.verifyK1ContainerProfile(componentRoot);
      receipt.k1ContainerProfileReceipt = component.receipt;
      const replaced = new Set(component.replacedOriginalPaths.map(relativePath));
      assert.equal(replaced.size, component.replacedOriginalPaths.length);
      for (const sourcePath of replaced) {
        assert(files.get(sourcePath)?.compile, 'Missing selected K1 contract: ' + sourcePath);
        files.set(sourcePath, { ...files.get(sourcePath), compile: false });
      }
      for (const filename of component.commonSources) {
        assert(filename.startsWith(componentRoot + path.sep));
        const sourcePath = relativePath(path.relative(componentRoot, filename));
        assert(replaced.has(sourcePath) && files.get(sourcePath)?.compile === false,
          'Unexpected K1 contract replacement: ' + sourcePath);
        const bytes = await readRegular(filename); const digest = sha256(bytes);
        files.set(sourcePath, { filename, bytes: bytes.length, sha256: digest, compile: true });
        receipt.portableSourceBindings.push({ path: sourcePath, sha256: digest });
        replaced.delete(sourcePath);
      }
      assert.equal(replaced.size, 0, 'Missing prepared K1 contract');
      for (const excluded of component.sourceSetExclusions) {
        const sourcePath = relativePath(excluded); assert(files.get(sourcePath)?.compile);
        files.set(sourcePath, { ...files.get(sourcePath), compile: false });
      }
      const final = await profile.verifyK1ContainerProfileComposition({ profileRoot: componentRoot,
        retainedSources: [...files].filter(([, pin]) => pin.compile && pin.filename.endsWith('.kt'))
          .map(([sourcePath, pin]) => ({ path: sourcePath, ...pin })) });
      receipt.k1ContainerFinalReceipt = final.receipt;
    }
    const parserRecipe = await readJson(path.join(here, '..', 'parser-probe/recipe.json'));
    const libraries = [bootstrap.wasmJsStdlib];
    receipt.hostLibraries = [{ role: 'compiler-host-stdlib', file: path.basename(bootstrap.wasmJsStdlib),
      sha256: bootstrap.artifacts.find((artifact) => artifact.id === 'stdlib-js').sha256 }];
    for (const pin of parserRecipe.artifacts.filter((artifact) => artifact.name.endsWith('.klib'))) {
      const filename = path.join(repository, 'out/kotlin-parser-probe/artifacts', pin.name);
      const bytes = await readRegular(filename, pin.bytes);
      assert.equal(bytes.length, pin.bytes);
      assert.equal(sha256(bytes), pin.sha256);
      libraries.push(filename);
      receipt.hostLibraries.push({ role: 'official-parser-dependency', file: pin.name, sha256: pin.sha256 });
    }
    if (sourceHost === 'portable') {
      const immutable = await import('./source-closure/immutable.mjs');
      const dependency = await immutable.prepareImmutableDependency({ outputRoot: path.join(output, 'dependencies') });
      const checked = await immutable.verifyImmutableDependency(path.dirname(dependency.receiptPath));
      assert.equal(checked.libraryPath, dependency.libraryPath);
      assert.equal(checked.receipt.source.commit, lock.source.commit);
      libraries.push(checked.libraryPath);
      receipt.immutableDependencyReceipt = checked.receipt;
      const libraryPin = checked.receipt.files.find(pin => pin.path === checked.receipt.library);
      assert(libraryPin, 'Missing immutable compiler-host dependency pin');
      receipt.hostLibraries.push({ role: 'official-persistent-collections-compiler-host', ...libraryPin });
      const codec = await readJson(path.join(protobufBuild, 'receipt.json'));
      assert.equal(codec.kind, 'portable-compiler-protobuf-build');
      assert.equal(codec.source.commit, lock.source.commit);
      assert.equal(codec.bootstrap.version, bootstrap.lock.version);
      assert(codec.commands.every((command) => command.exitCode === 0));
      const pin = codec.outputs.find((output) => output.kind === 'portable-compiler-dependency-klib');
      assert(pin);
      const filename = path.join(protobufBuild, relativePath(pin.path));
      const bytes = await readRegular(filename, pin.bytes);
      assert.equal(bytes.length, pin.bytes);
      assert.equal(sha256(bytes), pin.sha256);
      libraries.push(filename);
      receipt.protobufBuildReceipt = codec;
      receipt.hostLibraries.push({ role: 'portable-official-metadata-ir-protobuf', ...pin });
    }
    const sources = [...files.entries()].filter(([, pin]) => pin.compile && pin.filename.endsWith('.kt'));
    receipt.compileSources = sources.map(([filename, pin]) => ({ path: filename, bytes: pin.bytes, sha256: pin.sha256 }));
    receipt.originalJavaInventoryCount = lock.files.filter((pin) => pin.language === 'java').length;
    const klibDirectory = path.join(output, 'klib');
    await mkdir(klibDirectory);
    const flagsFile = path.join(here, 'build-flags.json');
    const flagsBytes = await readRegular(flagsFile);
    const flags = JSON.parse(flagsBytes);
    assert.equal(flags.source.commit, lock.source.commit);
    assert(Array.isArray(flags.compilerFlags) && flags.compilerFlags.every((flag) => typeof flag === 'string' && flag.startsWith('-')));
    receipt.sourceBuildFlags = { sha256: sha256(flagsBytes), ...flags };
    receipt.requiredHostFlags = [...hostFlags];
    const args = ['-Xwasm-target=wasm-js', '-language-version', '2.5', '-api-version', '2.5', ...flags.compilerFlags, ...hostFlags,
      '-Xmulti-platform', '-Xexpect-actual-classes', '-Xallow-kotlin-package',
      '-Xcommon-sources=' + sources.map(([, pin]) => pin.filename).join(','),
      '-libraries', libraries.join(path.delimiter), '-ir-output-dir', klibDirectory,
      '-ir-output-name', 'kotlin-browser-compiler', ...sources.map(([, pin]) => pin.filename)];
    assert(libraries.every((filename) => path.isAbsolute(filename)), 'Compiler library inputs must match verified absolute paths');
    const argumentBytes = Buffer.from(args.map((value) => JSON.stringify(value)).join('\n') + '\n');
    const argumentFile = path.join(output, 'compiler-klib.args');
    await writeFile(argumentFile, argumentBytes, { flag: 'wx', mode: 0o600 });
    const argv = ['-Xmx' + maximumHeap, '-cp', bootstrap.classPath,
      'org.jetbrains.kotlin.cli.js.KotlinWasmCompiler', '@' + argumentFile];
    const started = performance.now();
    const result = await new Promise((resolve, reject) => {
      const child = spawn('java', argv, { cwd: output, stdio: ['ignore', 'inherit', 'inherit'] });
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (exitCode, signal) => {
        clearTimeout(timer); resolve({ exitCode, signal, pid: child.pid });
      });
    });
    receipt.commands.push({ phase: 'official-compiler-source-to-wasmjs-klib', command: ['java', ...argv],
      argumentFileSha256: sha256(argumentBytes), timeoutMs, maximumHeap,
      ...result, elapsedMs: performance.now() - started });
    if (result.exitCode !== 0) throw new Error('Official compiler source cannot yet build for wasmJs');
    const klibFile = path.join(klibDirectory, 'kotlin-browser-compiler.klib');
    const klib = await readRegular(klibFile, 256 * 1024 * 1024);
    receipt.klib = { path: 'klib/kotlin-browser-compiler.klib', bytes: klib.length, sha256: sha256(klib) };
    receipt.status = 'klib-built';
    // A compiler KLIB is not a browser compiler: module codegen/export/loader and
    // actual compilation of fresh source still have to complete before acceptance.
    await writeJson(path.join(output, 'compiler-build-receipt.json'), receipt);
    return { output, receipt };
  } catch (error) {
    receipt.status = 'failed';
    receipt.failure = error.message;
    await writeJson(path.join(output, 'compiler-build-receipt.json'), receipt);
    throw new Error(error.message + '; output=' + output);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const argumentsList = process.argv.slice(2);
    const options = {};
    while (argumentsList.length) {
      const flag = argumentsList.shift();
      const key = { '--input': 'input', '--output': 'output', '--source-host': 'sourceHost', '--cache-root': 'cacheRoot', '--protobuf-build': 'protobufBuild' }[flag];
      assert(key && argumentsList[0] && !options[key], 'Invalid compiler build option');
      options[key] = argumentsList.shift();
    }
    const result = await buildCompiler(options);
    console.log(JSON.stringify({ output: result.output, status: result.receipt.status }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

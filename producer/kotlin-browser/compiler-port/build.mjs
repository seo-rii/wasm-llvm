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
        ['registryReceipt', (await import('./registry/prepare.mjs')).prepareRegistrySources],
        ['sessionProfileReceipt', (await import('./session-profile/prepare.mjs')).prepareSessionProfile],
        ['serialResolveReceipt', (await import('./serial-resolve/prepare.mjs')).prepareSerialResolveSources],
        ['flagsReceipt', (await import('./flags/prepare.mjs')).prepareFlagsSources],
        ['textReceipt', (await import('./text/prepare.mjs')).prepareCompilerTextSources],
        ['klibReceipt', (await import('./klib/prepare.mjs')).prepareKlibSources],
        ['linkerReceipt', (await import('./linker/prepare.mjs')).prepareLinkerSources],
        ['backendReceipt', (await import('./backend/prepare.mjs')).prepareBackendSources],
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
        if (component.assertionImport) {
          assert.equal(component.assertionImport, 'org.jetbrains.kotlin.portable.assertions.compilerAssert as assert');
          assert(!assertionImport, 'Duplicate compiler assertion adapter');
          assertionImport = component.assertionImport;
        }
        if (component.propertyAliasImport) {
          assert(/^[a-zA-Z0-9_.]+\.\*$/.test(component.propertyAliasImport), 'Invalid compiler property alias import');
          propertyAliasImports.add(component.propertyAliasImport);
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
      const imported = [];
      for (const [sourcePath, pin] of files) {
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
      receipt.annotationImports = { rule: 'explicit-kotlin-jvm-optional-annotation-import', sources: imported };
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

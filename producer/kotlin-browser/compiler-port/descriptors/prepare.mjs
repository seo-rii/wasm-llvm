#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertNoSymlink, readRegular, relativePath, sha256, writeJson } from '../../scripts/source.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const execute = promisify(execFile);
export const PROPERTY_ALIAS_IMPORT = 'org.jetbrains.kotlin.portable.descriptors.*';
const TOOLS = ['DescriptorAst.java', 'generate.py'];

export async function loadDescriptorSources(sourceRoot) {
  sourceRoot = path.resolve(sourceRoot); await assertNoSymlink(sourceRoot);
  const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json'));
  const lock = JSON.parse(lockBytes);
  if (lock.schemaVersion !== 1 || lock.source.commit !== '4d78aae1e337cd40f69baa865aed950fe807a775' ||
      lock.source.repository !== 'https://github.com/JetBrains/kotlin.git' || !Array.isArray(lock.javaInterfaces) ||
      !Array.isArray(lock.commonAncestorSources) || !Array.isArray(lock.files)) throw new Error('Descriptor source identity mismatch');
  const seen = new Set(); const sources = [];
  for (const pin of lock.files) {
    relativePath(pin.path);
    if (seen.has(pin.path) || !/^[a-f0-9]{40}$/.test(pin.gitBlob) || !/^[a-f0-9]{64}$/.test(pin.sha256) ||
        !Number.isSafeInteger(pin.bytes) || pin.bytes <= 0) throw new Error('Invalid descriptor source pin');
    seen.add(pin.path);
    const bytes = await readRegular(path.join(sourceRoot, pin.path));
    const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (bytes.length !== pin.bytes || sha256(bytes) !== pin.sha256 || blob !== pin.gitBlob) throw new Error('Descriptor source mismatch: ' + pin.path);
    sources.push({ pin, bytes });
  }
  const selected = [...lock.javaInterfaces, ...lock.commonAncestorSources, ...lock.validationSources];
  if (new Set(selected).size !== selected.length || selected.length !== seen.size || selected.some(name => !seen.has(name)) ||
      lock.javaInterfaces.some(name => !name.endsWith('.java')) || [...lock.commonAncestorSources, ...lock.validationSources].some(name => !name.endsWith('.kt'))) throw new Error('Incomplete descriptor contract source set');
  for (const ancestor of lock.commonAncestorTypes) {
    const original = sources.find(record => record.pin.path === ancestor.path);
    if (!original || !lock.commonAncestorSources.includes(ancestor.path) || original.bytes.toString('utf8').split(ancestor.declarationText).length !== 2 ||
        !ancestor.name.startsWith('org.jetbrains.kotlin.descriptors.') || !Array.isArray(ancestor.parents) || !ancestor.parents.length ||
        ancestor.parents.some(name => !name.startsWith('org.jetbrains.kotlin.descriptors.'))) throw new Error('Invalid pinned Kotlin ancestor edge');
  }
  return { sourceRoot, lock, lockBytes, sources };
}

export async function prepareDescriptorContracts(sourceRoot, outputRoot) {
  const input = await loadDescriptorSources(sourceRoot);
  outputRoot = path.resolve(outputRoot); await assertNoSymlink(outputRoot, { allowMissing: true });
  await mkdir(outputRoot, { recursive: false, mode: 0o700 });
  const frozenSources = path.join(outputRoot, 'sources');
  for (const { pin, bytes } of input.sources) {
    const target = path.join(frozenSources, pin.path); await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
  }
  const tools = [];
  await writeFile(path.join(outputRoot, 'sources.lock.json'), input.lockBytes, { flag: 'wx', mode: 0o600 });
  for (const name of TOOLS) {
    const bytes = await readRegular(path.join(HERE, name));
    await writeFile(path.join(outputRoot, name), bytes, { flag: 'wx', mode: 0o600 });
    tools.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const javaPath = await realpath('/usr/bin/java');
  const javaVersion = await execute(javaPath, ['-version'], { timeout: 10000, maxBuffer: 65536 });
  const javaArgs = ['-Xmx512m', path.join(outputRoot, 'DescriptorAst.java'), ...input.lock.javaInterfaces];
  const parsed = await execute(javaPath, javaArgs, { cwd: frozenSources, timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  const ast = JSON.parse(parsed.stdout);
  if (!Array.isArray(ast) || ast.length !== input.lock.javaInterfaces.length) throw new Error('Incomplete Java AST source set');
  for (const unit of ast) {
    unit.path = path.relative(frozenSources, unit.path).split(path.sep).join('/'); relativePath(unit.path);
    if (!input.lock.javaInterfaces.includes(unit.path) || unit.declarations.length !== 1 || unit.declarations[0].kind !== 'INTERFACE') throw new Error('Unexpected original descriptor declaration');
  }
  if (new Set(ast.map(unit => unit.path)).size !== ast.length) throw new Error('Duplicate Java AST source');
  const astBytes = Buffer.from(JSON.stringify(ast, null, 2) + '\n');
  await writeFile(path.join(outputRoot, 'ast.json'), astBytes, { flag: 'wx', mode: 0o600 });
  const pythonArgs = ['-B', path.join(outputRoot, 'generate.py'), '--ast', path.join(outputRoot, 'ast.json'), '--source-lock', path.join(outputRoot, 'sources.lock.json'), '--output', path.join(outputRoot, 'generated')];
  await execute('python3', pythonArgs, { timeout: 60000, maxBuffer: 65536 });
  const generationBytes = await readRegular(path.join(outputRoot, 'generated', 'generation.json'));
  const generation = JSON.parse(generationBytes);
  if (generation.astSha256 !== sha256(astBytes) || generation.sourceLockSha256 !== sha256(input.lockBytes) || generation.javaUnits !== input.lock.javaInterfaces.length ||
      generation.concreteImplementationsPorted !== false || generation.languageReadiness !== false) throw new Error('Invalid descriptor generation result');
  const substitutionsPath = 'core/descriptors/src/org/jetbrains/kotlin/descriptors/Substitutable.kt';
  const substitutions = input.sources.find(record => record.pin.path === substitutionsPath);
  const originalSubstitutable = substitutions.bytes.toString('utf8');
  const signature = 'fun substitute(substitutor: TypeSubstitutor): T';
  if (originalSubstitutable.split(signature).length !== 2 || originalSubstitutable.includes(signature + '?')) throw new Error('Changed upstream substitution signature');
  const commonSubstitutable = Buffer.from(originalSubstitutable.replace(signature, signature + '?'));
  await writeFile(path.join(outputRoot, 'generated', 'Substitutable.kt'), commonSubstitutable, { flag: 'wx', mode: 0o600 });
  generation.files.push({ path: 'Substitutable.kt', bytes: commonSubstitutable.length, sha256: sha256(commonSubstitutable), originalPath: substitutionsPath });
  generation.commonContractBoundaries.push({ owner: 'org.jetbrains.kotlin.descriptors.Substitutable', method: 'substitute', strategy: 'T? retains the explicit nullable Java overrides used by FunctionDescriptor and ReceiverParameterDescriptor; unchanged Kotlin implementation bodies remain outside this contract unit' });
  const finalGenerationBytes = Buffer.from(JSON.stringify(generation, null, 2) + '\n');
  await writeFile(path.join(outputRoot, 'generation-combined.json'), finalGenerationBytes, { flag: 'wx', mode: 0o600 });
  const files = []; const names = new Set();
  for (const record of generation.files) {
    relativePath(record.path);
    if (!record.path.endsWith('.kt') || record.path.includes('/') || names.has(record.path) ||
        record.originalPath !== null && ![...input.lock.javaInterfaces, substitutionsPath].includes(record.originalPath)) throw new Error('Invalid generated descriptor path');
    names.add(record.path);
    const bytes = await readRegular(path.join(outputRoot, 'generated', record.path));
    if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) throw new Error('Descriptor generated byte mismatch');
    files.push({ ...record, absolutePath: path.join(outputRoot, 'generated', record.path) });
  }
  if (files.length !== input.lock.javaInterfaces.length + 2 || !names.has('DescriptorProperties.kt') || !names.has('Substitutable.kt')) throw new Error('Incomplete generated descriptor contracts');
  const jdkRoot = path.dirname(path.dirname(javaPath));
  const receipt = { schemaVersion: 1, kind: 'official-descriptor-common-generation', source: input.lock.source,
    sourceLockSha256: sha256(input.lockBytes), preparationToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))), sourceFiles: input.lock.files, tools,
    jdk: { executable: javaPath, executableSha256: sha256(await readRegular(javaPath)),
      modulesSha256: sha256(await readRegular(path.join(jdkRoot, 'lib', 'modules'), 256 * 1024 * 1024)),
      releaseSha256: sha256(await readRegular(path.join(jdkRoot, 'release'))), version: (javaVersion.stdout + javaVersion.stderr).trim() },
    astSha256: sha256(astBytes), generationSha256: sha256(generationBytes), combinedGenerationSha256: sha256(finalGenerationBytes),
    javaUnits: generation.javaUnits, interfaces: generation.interfaces, enums: generation.enums, methods: generation.methods,
    aliases: generation.aliases, propertyAliasImport: PROPERTY_ALIAS_IMPORT, auditRequired: generation.auditRequired,
    commonContractBoundaries: generation.commonContractBoundaries, files,
    replacedOriginalPaths: [...input.lock.javaInterfaces, substitutionsPath],
    commands: [{ command: javaPath, args: javaArgs, cwd: frozenSources, exitCode: 0 }, { command: 'python3', args: pythonArgs, exitCode: 0 }],
    concreteImplementationsPorted: false, wasmCompilerBuilt: false, readiness: false };
  await writeJson(path.join(outputRoot, 'receipt.json'), receipt);
  return { outputRoot, receipt, sourceFiles: files.map(record => record.absolutePath), propertyAliasImport: PROPERTY_ALIAS_IMPORT, replacedOriginalPaths: receipt.replacedOriginalPaths };
}

export async function verifyDescriptorPreparation(directory) {
  directory = path.resolve(directory); await assertNoSymlink(directory);
  const bytes = await readRegular(path.join(directory, 'receipt.json')); const receipt = JSON.parse(bytes);
  if (receipt.schemaVersion !== 1 || receipt.kind !== 'official-descriptor-common-generation' || receipt.readiness !== false ||
      receipt.concreteImplementationsPorted !== false || receipt.wasmCompilerBuilt !== false || receipt.propertyAliasImport !== PROPERTY_ALIAS_IMPORT ||
      receipt.preparationToolSha256 !== sha256(await readRegular(fileURLToPath(import.meta.url))) ||
      receipt.sourceLockSha256 !== sha256(await readRegular(path.join(HERE, 'sources.lock.json'))) ||
      receipt.sourceLockSha256 !== sha256(await readRegular(path.join(directory, 'sources.lock.json'))) ||
      receipt.astSha256 !== sha256(await readRegular(path.join(directory, 'ast.json'))) ||
      receipt.generationSha256 !== sha256(await readRegular(path.join(directory, 'generated', 'generation.json'))) ||
      receipt.combinedGenerationSha256 !== sha256(await readRegular(path.join(directory, 'generation-combined.json')))) throw new Error('Stale descriptor preparation');
  const current = JSON.parse(await readRegular(path.join(HERE, 'sources.lock.json')));
  if (JSON.stringify(receipt.source) !== JSON.stringify(current.source) || JSON.stringify(receipt.sourceFiles) !== JSON.stringify(current.files)) throw new Error('Descriptor source identity mismatch');
  if (JSON.stringify(receipt.replacedOriginalPaths) !== JSON.stringify([...current.javaInterfaces, 'core/descriptors/src/org/jetbrains/kotlin/descriptors/Substitutable.kt'])) throw new Error('Descriptor replaced-source index mismatch');
  if (receipt.tools.length !== TOOLS.length || new Set(receipt.tools.map(record => record.path)).size !== TOOLS.length) throw new Error('Incomplete descriptor generator tools');
  for (const record of receipt.tools) {
    if (!TOOLS.includes(record.path) || record.sha256 !== sha256(await readRegular(path.join(HERE, record.path))) ||
        record.sha256 !== sha256(await readRegular(path.join(directory, record.path)))) throw new Error('Descriptor generator changed after preparation');
  }
  const generation = JSON.parse(await readRegular(path.join(directory, 'generation-combined.json')));
  if (JSON.stringify(generation.files) !== JSON.stringify(receipt.files.map(({ absolutePath, ...rest }) => rest)) ||
      generation.astSha256 !== receipt.astSha256 || generation.javaUnits !== current.javaInterfaces.length) throw new Error('Descriptor generated index changed');
  for (const key of ['javaUnits', 'interfaces', 'enums', 'methods', 'aliases', 'auditRequired', 'commonContractBoundaries']) {
    if (JSON.stringify(generation[key]) !== JSON.stringify(receipt[key])) throw new Error('Descriptor generation summary changed');
  }
  const sourceFiles = []; const seen = new Set();
  for (const record of receipt.files) {
    relativePath(record.path);
    const expected = path.join(directory, 'generated', record.path);
    if (record.absolutePath !== expected || !record.path.endsWith('.kt') || record.path.includes('/') || seen.has(record.path)) throw new Error('Invalid generated descriptor path');
    seen.add(record.path); const generated = await readRegular(expected);
    if (record.bytes !== generated.length || record.sha256 !== sha256(generated)) throw new Error('Descriptor generated source changed');
    sourceFiles.push(expected);
  }
  if (sourceFiles.length !== current.javaInterfaces.length + 2 || !seen.has('DescriptorProperties.kt') || !seen.has('Substitutable.kt')) throw new Error('Incomplete descriptor generated set');
  const original = await loadDescriptorSources(path.join(directory, 'sources'));
  if (original.lockBytes.toString() !== (await readRegular(path.join(HERE, 'sources.lock.json'))).toString()) throw new Error('Descriptor source lock changed');
  return { directory, receipt, receiptSha256: sha256(bytes), sourceFiles, propertyAliasImport: PROPERTY_ALIAS_IMPORT, replacedOriginalPaths: receipt.replacedOriginalPaths };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter(value => value !== '--');
  if (args.length !== 4 || args[0] !== '--source-dir' || args[2] !== '--output') throw new Error('Usage: prepare.mjs --source-dir PINNED_SOURCES --output NEW_DIRECTORY');
  const result = await prepareDescriptorContracts(args[1], args[3]);
  console.log(JSON.stringify({ outputRoot: result.outputRoot, interfaces: result.receipt.interfaces, methods: result.receipt.methods, propertyAliasImport: result.propertyAliasImport }));
}

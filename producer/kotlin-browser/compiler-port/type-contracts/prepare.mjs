#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verifyBootstrap, defaultCache } from '../../build/bootstrap.mjs';
import { assertNoSymlink, readRegular, relativePath, sha256, writeJson } from '../../scripts/source.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)); const execute = promisify(execFile);
const BASE = path.resolve(HERE, '../descriptors'); const TOOLS = ['TypeContractAst.java', 'generate.py'];
export const PROPERTY_ALIAS_IMPORT = 'org.jetbrains.kotlin.portable.descriptors.*';
export const DEFAULT_REFERENCE_ANNOTATIONS = path.resolve(HERE, '../../../../out/kotlin-compiler-descriptors/reference-artifacts/kotlin-annotations-jvm-2.5.0-dev-10106.jar');

async function inputs(sourceRoot) {
  sourceRoot = path.resolve(sourceRoot); await assertNoSymlink(sourceRoot);
  const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')); const lock = JSON.parse(lockBytes);
  if (lock.schemaVersion !== 1 || lock.source.commit !== '4d78aae1e337cd40f69baa865aed950fe807a775' ||
      lock.source.repository !== 'https://github.com/JetBrains/kotlin.git' || lock.javaInterfaces.length !== 9) throw new Error('Type contract source identity mismatch');
  const selected = [...lock.javaInterfaces, ...lock.semanticReferenceSources]; const seen = new Set(); const sources = [];
  for (const pin of lock.files) {
    relativePath(pin.path);
    if (seen.has(pin.path) || !selected.includes(pin.path) || !/^[a-f0-9]{40}$/.test(pin.gitBlob) || !/^[a-f0-9]{64}$/.test(pin.sha256) ||
        !Number.isSafeInteger(pin.bytes) || pin.bytes <= 0) throw new Error('Invalid type contract source pin');
    seen.add(pin.path); const bytes = await readRegular(path.join(sourceRoot, pin.path));
    const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (pin.bytes !== bytes.length || pin.sha256 !== sha256(bytes) || pin.gitBlob !== blob) throw new Error('Type contract source mismatch: ' + pin.path);
    sources.push({ pin, bytes });
  }
  if (seen.size !== selected.length || new Set(selected).size !== selected.length) throw new Error('Incomplete type contract source set');
  const baseTools = [];
  for (const record of lock.baseTools) {
    if (!['DescriptorAst.java', 'generate.py'].includes(record.path)) throw new Error('Invalid base generator tool path');
    const bytes = await readRegular(path.join(BASE, record.path));
    if (record.bytes !== bytes.length || record.sha256 !== sha256(bytes)) throw new Error('Sealed descriptor tool changed');
    baseTools.push({ record, bytes });
  }
  if (baseTools.length !== 2 || new Set(baseTools.map(item => item.record.path)).size !== 2) throw new Error('Incomplete base tools');
  return { sourceRoot, lock, lockBytes, sources, baseTools };
}
export async function prepareTypeContracts(sourceRoot, outputRoot, { bootstrapCache = defaultCache, referenceAnnotations = DEFAULT_REFERENCE_ANNOTATIONS } = {}) {
  const input = await inputs(sourceRoot); const bootstrap = await verifyBootstrap(bootstrapCache);
  const referenceBytes = await readRegular(path.join(BASE, 'reference.lock.json')); const reference = JSON.parse(referenceBytes);
  const annotationBytes = await readRegular(referenceAnnotations, 1024 * 1024);
  if (input.lock.referenceArtifactLockSha256 !== sha256(referenceBytes) || reference.artifact.sha256 !== sha256(annotationBytes) || reference.artifact.bytes !== annotationBytes.length) throw new Error('Original ReadOnly reference artifact mismatch');
  outputRoot = path.resolve(outputRoot); await assertNoSymlink(outputRoot, { allowMissing: true }); await mkdir(outputRoot, { recursive: false, mode: 0o700 });
  const sourceDirectory = path.join(outputRoot, 'sources');
  for (const { pin, bytes } of input.sources) {
    const target = path.join(sourceDirectory, pin.path); await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
  }
  const tools = [];
  for (const name of TOOLS) {
    const bytes = await readRegular(path.join(HERE, name)); await writeFile(path.join(outputRoot, name), bytes, { flag: 'wx', mode: 0o600 });
    tools.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const baseDirectory = path.join(outputRoot, 'base'); await mkdir(baseDirectory, { mode: 0o700 });
  for (const { record, bytes } of input.baseTools) await writeFile(path.join(baseDirectory, record.path), bytes, { flag: 'wx', mode: 0o600 });
  const toolClasses = path.join(outputRoot, 'tool-classes'); await mkdir(toolClasses, { mode: 0o700 }); const commands = [];
  async function run(command, args, cwd) {
    const result = await execute(command, args, { cwd, timeout: 120000, maxBuffer: 4 * 1024 * 1024 }); commands.push({ command, args, cwd, exitCode: 0 }); return result.stdout;
  }
  await run('javac', ['-J-Xmx512m', '-d', toolClasses, path.join(baseDirectory, 'DescriptorAst.java'), path.join(outputRoot, 'TypeContractAst.java')], outputRoot);
  const resolutionArtifacts = bootstrap.artifacts.filter(record => ['compiler', 'stdlib-jvm', 'annotations'].includes(record.id));
  const classPath = [...resolutionArtifacts.map(record => record.path), path.resolve(referenceAnnotations)].join(path.delimiter);
  const parsed = await run('java', ['-Xmx512m', '-cp', toolClasses, 'TypeContractAst', classPath, ...input.lock.javaInterfaces], sourceDirectory);
  const ast = JSON.parse(parsed);
  if (ast.length !== input.lock.javaInterfaces.length) throw new Error('Incomplete resolved Java source set');
  for (const unit of ast) {
    unit.path = path.relative(sourceDirectory, unit.path).split(path.sep).join('/'); relativePath(unit.path);
    if (!input.lock.javaInterfaces.includes(unit.path) || unit.declarations.length !== 1 || unit.declarations[0].kind !== 'INTERFACE') throw new Error('Unexpected actual Java contract declaration');
  }
  if (new Set(ast.map(unit => unit.path)).size !== ast.length) throw new Error('Duplicate resolved Java source');
  const astBytes = Buffer.from(JSON.stringify(ast, null, 2) + '\n'); await writeFile(path.join(outputRoot, 'ast.json'), astBytes, { flag: 'wx', mode: 0o600 });
  await run('python3', ['-B', path.join(outputRoot, 'generate.py'), '--base-generator', path.join(baseDirectory, 'generate.py'), '--ast', path.join(outputRoot, 'ast.json'), '--output', path.join(outputRoot, 'generated')], outputRoot);
  const generationBytes = await readRegular(path.join(outputRoot, 'generated/generation.json')); const generation = JSON.parse(generationBytes);
  if (generation.astSha256 !== sha256(astBytes) || generation.javaUnits !== 9 || generation.baseGeneratorSha256 !== input.baseTools.find(item => item.record.path === 'generate.py').record.sha256 || generation.readiness !== false) throw new Error('Invalid type generation result');
  const files = [];
  for (const record of generation.files) {
    relativePath(record.path); const bytes = await readRegular(path.join(outputRoot, 'generated', record.path));
    if (record.path.includes('/') || !record.path.endsWith('.kt') || record.bytes !== bytes.length || record.sha256 !== sha256(bytes)) throw new Error('Invalid generated type source');
    files.push({ ...record, absolutePath: path.join(outputRoot, 'generated', record.path) });
  }
  if (files.length !== 10 || new Set(files.map(record => record.path)).size !== 10 || !files.some(record => record.path === 'TypeProperties.kt')) throw new Error('Incomplete generated type contracts');
  const java = await realpath('/usr/bin/java'); const jdkRoot = path.dirname(path.dirname(java)); const version = await execute(java, ['-version'], { timeout: 10000, maxBuffer: 65536 });
  const receipt = { schemaVersion: 1, kind: 'official-type-contract-generation', source: input.lock.source,
    sourceLockSha256: sha256(input.lockBytes), preparationToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
    sourceFiles: input.lock.files, tools, baseTools: input.lock.baseTools, astSha256: sha256(astBytes), generationSha256: sha256(generationBytes),
    symbolResolution: { host: 'real JDK javac', sourceCommit: null, bootstrapVersion: bootstrap.lock.version,
      artifacts: [...resolutionArtifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })), reference.artifact], referenceArtifactLockSha256: sha256(referenceBytes) },
    jdk: { version: (version.stdout + version.stderr).trim(), executableSha256: sha256(await readRegular(java)), modulesSha256: sha256(await readRegular(path.join(jdkRoot, 'lib/modules'), 256 * 1024 * 1024)) },
    javaUnits: generation.javaUnits, interfaces: generation.interfaces, enums: generation.enums, methods: generation.methods, aliases: generation.aliases,
    auditRequired: generation.auditRequired, preservedBodies: generation.preservedBodies, preservedFields: generation.preservedFields, preservedAnnotations: generation.preservedAnnotations,
    propertyAliasImport: PROPERTY_ALIAS_IMPORT, replacedOriginalPaths: input.lock.javaInterfaces, files, commands,
    typeCheckingAlgorithmsPorted: false, browserCompilerBuilt: false, readiness: false };
  await writeJson(path.join(outputRoot, 'receipt.json'), receipt); return { outputRoot, receipt, sourceFiles: files.map(record => record.absolutePath), propertyAliasImport: PROPERTY_ALIAS_IMPORT, replacedOriginalPaths: input.lock.javaInterfaces };
}

export async function verifyTypePreparation(directory) {
  directory = path.resolve(directory); await assertNoSymlink(directory);
  const receiptBytes = await readRegular(path.join(directory, 'receipt.json')); const receipt = JSON.parse(receiptBytes);
  const input = await inputs(path.join(directory, 'sources'));
  if (receipt.kind !== 'official-type-contract-generation' || receipt.sourceLockSha256 !== sha256(input.lockBytes) ||
      receipt.preparationToolSha256 !== sha256(await readRegular(fileURLToPath(import.meta.url))) || receipt.astSha256 !== sha256(await readRegular(path.join(directory, 'ast.json'))) ||
      receipt.generationSha256 !== sha256(await readRegular(path.join(directory, 'generated/generation.json'))) || receipt.typeCheckingAlgorithmsPorted !== false ||
      receipt.browserCompilerBuilt !== false || receipt.readiness !== false || receipt.propertyAliasImport !== PROPERTY_ALIAS_IMPORT ||
      JSON.stringify(receipt.source) !== JSON.stringify(input.lock.source) || JSON.stringify(receipt.sourceFiles) !== JSON.stringify(input.lock.files) ||
      JSON.stringify(receipt.replacedOriginalPaths) !== JSON.stringify(input.lock.javaInterfaces)) throw new Error('Stale type contract preparation');
  if (receipt.tools.length !== TOOLS.length || new Set(receipt.tools.map(record => record.path)).size !== TOOLS.length) throw new Error('Incomplete type contract tools');
  for (const record of receipt.tools) {
    if (!TOOLS.includes(record.path) || record.sha256 !== sha256(await readRegular(path.join(HERE, record.path))) || record.sha256 !== sha256(await readRegular(path.join(directory, record.path)))) throw new Error('Type contract tool changed');
  }
  if (JSON.stringify(receipt.baseTools) !== JSON.stringify(input.lock.baseTools)) throw new Error('Sealed descriptor tool changed');
  for (const record of receipt.baseTools) if (record.sha256 !== sha256(await readRegular(path.join(directory, 'base', record.path)))) throw new Error('Frozen base tool changed');
  const generation = JSON.parse(await readRegular(path.join(directory, 'generated/generation.json')));
  if (generation.astSha256 !== receipt.astSha256 || JSON.stringify(generation.files) !== JSON.stringify(receipt.files.map(({ absolutePath, ...rest }) => rest))) throw new Error('Type contract generation index changed');
  for (const key of ['javaUnits', 'interfaces', 'enums', 'methods', 'aliases', 'auditRequired', 'preservedBodies', 'preservedFields', 'preservedAnnotations']) if (JSON.stringify(generation[key]) !== JSON.stringify(receipt[key])) throw new Error('Type contract summary changed');
  const sourceFiles = []; const seen = new Set();
  for (const record of receipt.files) {
    relativePath(record.path); const expected = path.join(directory, 'generated', record.path);
    if (record.absolutePath !== expected || record.path.includes('/') || !record.path.endsWith('.kt') || seen.has(record.path)) throw new Error('Invalid generated type path');
    seen.add(record.path); const bytes = await readRegular(expected);
    if (record.bytes !== bytes.length || record.sha256 !== sha256(bytes)) throw new Error('Generated type contract changed');
    sourceFiles.push(expected);
  }
  if (sourceFiles.length !== 10 || !seen.has('TypeProperties.kt')) throw new Error('Incomplete generated type set');
  return { directory, receipt, receiptSha256: sha256(receiptBytes), sourceFiles, propertyAliasImport: PROPERTY_ALIAS_IMPORT, replacedOriginalPaths: receipt.replacedOriginalPaths };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter(value => value !== '--');
  if (args.length !== 4 || args[0] !== '--source-dir' || args[2] !== '--output') throw new Error('Usage: prepare.mjs --source-dir PINNED_SOURCES --output NEW_DIRECTORY');
  const result = await prepareTypeContracts(args[1], args[3]); console.log(JSON.stringify({ outputRoot: result.outputRoot, interfaces: result.receipt.interfaces, methods: result.receipt.methods }));
}

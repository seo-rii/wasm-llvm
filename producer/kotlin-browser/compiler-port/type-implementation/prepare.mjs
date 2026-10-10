#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, writeJson } from '../../scripts/source.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXPECTED = ['TypeSubstitutor.kt', 'TypeProjectionImpl.kt', 'TypeProjectionBase.kt', 'TypeImplementationProperties.kt'];
const HOST = ['assertions/CompilerAssertions.kt', 'storage/exceptionUtils.kt', 'storage/ProcessCanceledException.kt'];
const ALGORITHMS = ['TypeSubstitutor', 'TypeProjectionImpl', 'TypeProjectionBase'].map(name => 'core/descriptors/src/org/jetbrains/kotlin/types/' + name + '.java');
const PRESERVATION = ['all original algorithm branches and overloads', 'reference identity of flexible bounds and unchanged type argument lists',
  'projection presence, variance, captured/star/nullability/annotations/abbreviation handling', 'recursion limit 100 and cancellation propagation',
  'original enabled JVM assertion expression including operator precedence'];
const FIELD_RENAMES = { 'TypeProjectionImpl.projection': 'projectionValue', 'TypeProjectionImpl.type': 'typeValue', 'TypeSubstitutor.substitution': 'substitutionValue' };
export const PROPERTY_ALIAS_IMPORT = 'org.jetbrains.kotlin.portable.descriptors.*';

async function inputs(sourceRoot) {
  sourceRoot = path.resolve(sourceRoot); await assertNoSymlink(sourceRoot);
  const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')); const lock = JSON.parse(lockBytes);
  if (lock.schemaVersion !== 1 || lock.source.commit !== '4d78aae1e337cd40f69baa865aed950fe807a775' ||
      lock.source.repository !== 'https://github.com/JetBrains/kotlin.git' || lock.source.treeSha !== '2be662d1ae06bfcf435efbe18191ba5e1e3f035e' ||
      JSON.stringify(lock.algorithms) !== JSON.stringify(ALGORITHMS) ||
      lock.portableFiles.length !== EXPECTED.length || lock.hostDependencies.length !== HOST.length) throw new Error('Type implementation identity mismatch');
  const selected = [...lock.algorithms, ...lock.semanticReferenceSources]; const seen = new Set(); const sources = [];
  for (const pin of lock.files) {
    relativePath(pin.path);
    if (seen.has(pin.path) || !selected.includes(pin.path) || !/^[a-f0-9]{40}$/.test(pin.gitBlob) || !/^[a-f0-9]{64}$/.test(pin.sha256) ||
        !Number.isSafeInteger(pin.bytes) || pin.bytes <= 0) throw new Error('Invalid type implementation source pin');
    seen.add(pin.path); const bytes = await readRegular(path.join(sourceRoot, pin.path));
    const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (pin.bytes !== bytes.length || pin.sha256 !== sha256(bytes) || pin.gitBlob !== blob) throw new Error('Type implementation source mismatch: ' + pin.path);
    sources.push({ pin, bytes });
  }
  if (seen.size !== selected.length || new Set(selected).size !== selected.length) throw new Error('Incomplete type implementation sources');
  const portable = []; const portableSeen = new Set();
  for (const pin of lock.portableFiles) {
    if (!EXPECTED.includes(pin.path) || portableSeen.has(pin.path) || (pin.originalPath !== null && !lock.algorithms.includes(pin.originalPath))) throw new Error('Invalid portable type source');
    portableSeen.add(pin.path); const bytes = await readRegular(path.join(HERE, pin.path));
    if (pin.bytes !== bytes.length || pin.sha256 !== sha256(bytes)) throw new Error('Portable type implementation changed: ' + pin.path);
    portable.push({ pin, bytes });
  }
  if (new Set(portable.filter(item => item.pin.originalPath !== null).map(item => item.pin.originalPath)).size !== 3) throw new Error('Incomplete original-to-port mapping');
  const host = []; const hostSeen = new Set();
  for (const pin of lock.hostDependencies) {
    if (!HOST.includes(pin.path) || hostSeen.has(pin.path)) throw new Error('Invalid type implementation host dependency');
    hostSeen.add(pin.path); const bytes = await readRegular(path.resolve(HERE, '..', pin.path));
    if (pin.bytes !== bytes.length || pin.sha256 !== sha256(bytes)) throw new Error('Frozen host dependency changed: ' + pin.path);
    host.push({ pin, bytes });
  }
  return { sourceRoot, lock, lockBytes, sources, portable, host };
}

export async function prepareTypeImplementations(sourceRoot, outputRoot) {
  const input = await inputs(sourceRoot);
  outputRoot = path.resolve(outputRoot); await assertNoSymlink(outputRoot, { allowMissing: true }); await mkdir(outputRoot, { recursive: false, mode: 0o700 });
  for (const { pin, bytes } of input.sources) {
    const target = path.join(outputRoot, 'sources', pin.path); await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
  }
  const generated = path.join(outputRoot, 'common'); await mkdir(generated, { mode: 0o700 }); const files = [];
  for (const { pin, bytes } of input.portable) {
    const target = path.join(generated, pin.path); await writeFile(target, bytes, { flag: 'wx', mode: 0o600 }); files.push({ ...pin, absolutePath: target });
  }
  const hostFiles = [];
  for (const { pin, bytes } of input.host) {
    const target = path.join(outputRoot, 'host', pin.path); await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { flag: 'wx', mode: 0o600 }); hostFiles.push({ ...pin, absolutePath: target });
  }
  const receipt = { schemaVersion: 1, kind: 'official-type-implementation-port', source: input.lock.source,
    sourceLockSha256: sha256(input.lockBytes), preparationToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
    originals: input.lock.files, algorithms: input.lock.algorithms, files, hostFiles,
    propertyAliasImport: PROPERTY_ALIAS_IMPORT, replacedOriginalPaths: input.lock.algorithms,
    preservation: PRESERVATION, privateFieldRenames: FIELD_RENAMES,
    requiredConcreteDependencies: input.lock.requiredConcreteDependencies,
    compilerBuild: 'not-run; concrete type-system and builtins closure required', browserCompilerBuilt: false, readiness: false };
  await writeJson(path.join(outputRoot, 'receipt.json'), receipt);
  return { outputRoot, receipt, sourceFiles: files.map(item => item.absolutePath), hostDependencyFiles: hostFiles.map(item => item.absolutePath),
    propertyAliasImport: PROPERTY_ALIAS_IMPORT, replacedOriginalPaths: input.lock.algorithms };
}

export async function verifyTypeImplementationPreparation(directory) {
  directory = path.resolve(directory); await assertNoSymlink(directory);
  const receiptBytes = await readRegular(path.join(directory, 'receipt.json')); const receipt = JSON.parse(receiptBytes);
  const input = await inputs(path.join(directory, 'sources'));
  if (receipt.kind !== 'official-type-implementation-port' || receipt.sourceLockSha256 !== sha256(input.lockBytes) ||
      receipt.preparationToolSha256 !== sha256(await readRegular(fileURLToPath(import.meta.url))) || receipt.browserCompilerBuilt !== false || receipt.readiness !== false ||
      receipt.propertyAliasImport !== PROPERTY_ALIAS_IMPORT || JSON.stringify(receipt.source) !== JSON.stringify(input.lock.source) ||
      JSON.stringify(receipt.preservation) !== JSON.stringify(PRESERVATION) || JSON.stringify(receipt.privateFieldRenames) !== JSON.stringify(FIELD_RENAMES) ||
      receipt.compilerBuild !== 'not-run; concrete type-system and builtins closure required' ||
      JSON.stringify(receipt.originals) !== JSON.stringify(input.lock.files) || JSON.stringify(receipt.algorithms) !== JSON.stringify(input.lock.algorithms) ||
      JSON.stringify(receipt.replacedOriginalPaths) !== JSON.stringify(input.lock.algorithms) ||
      JSON.stringify(receipt.requiredConcreteDependencies) !== JSON.stringify(input.lock.requiredConcreteDependencies)) throw new Error('Stale type implementation preparation');
  const sourceFiles = []; const hostDependencyFiles = [];
  for (const [records, expected, folder, output] of [[receipt.files, input.lock.portableFiles, 'common', sourceFiles], [receipt.hostFiles, input.lock.hostDependencies, 'host', hostDependencyFiles]]) {
    if (!Array.isArray(records) || records.length !== expected.length) throw new Error('Incomplete type implementation preparation');
    for (let i = 0; i < expected.length; ++i) {
      const record = records[i]; const pin = expected[i]; const target = path.join(directory, folder, pin.path);
      if (JSON.stringify(record) !== JSON.stringify({ ...pin, absolutePath: target })) throw new Error('Type implementation preparation index changed');
      const bytes = await readRegular(target);
      if (pin.bytes !== bytes.length || pin.sha256 !== sha256(bytes)) throw new Error('Prepared type implementation changed: ' + pin.path);
      output.push(target);
    }
  }
  return { directory, receipt, receiptSha256: sha256(receiptBytes), sourceFiles, hostDependencyFiles,
    propertyAliasImport: PROPERTY_ALIAS_IMPORT, replacedOriginalPaths: receipt.replacedOriginalPaths };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter(value => value !== '--');
  if (args.length !== 4 || args[0] !== '--source-dir' || args[2] !== '--output') throw new Error('Usage: prepare.mjs --source-dir PINNED_SOURCES --output NEW_DIRECTORY');
  const result = await prepareTypeImplementations(args[1], args[3]); console.log(JSON.stringify({ outputRoot: result.outputRoot, algorithms: result.receipt.algorithms.length }));
}

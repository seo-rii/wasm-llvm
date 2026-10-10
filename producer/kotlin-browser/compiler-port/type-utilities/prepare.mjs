#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const NAMES = ['TypeUtils.kt', 'TypeCheckingProcedure.kt', 'TypeCheckerProcedureCallbacksImpl.kt'];
const ALGORITHMS = ['core/descriptors/src/org/jetbrains/kotlin/types/TypeUtils.java',
  'core/descriptors/src/org/jetbrains/kotlin/types/checker/TypeCheckingProcedure.java',
  'core/descriptors/src/org/jetbrains/kotlin/types/checker/TypeCheckerProcedureCallbacksImpl.java'];
export const PROPERTY_ALIAS_IMPORT = 'org.jetbrains.kotlin.portable.descriptors.*';

async function inputs(sourceRoot) {
  sourceRoot = path.resolve(sourceRoot); await assertNoSymlink(sourceRoot);
  const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')); const lock = JSON.parse(lockBytes);
  if (lock.schemaVersion !== 1 || lock.source.commit !== '4d78aae1e337cd40f69baa865aed950fe807a775' ||
      lock.source.repository !== 'https://github.com/JetBrains/kotlin.git' || lock.source.treeSha !== '2be662d1ae06bfcf435efbe18191ba5e1e3f035e' ||
      JSON.stringify(lock.algorithms) !== JSON.stringify(ALGORITHMS) || lock.portableFiles.length !== 3 || lock.hostDependencies.length !== 1 ||
      lock.previousSourceLockSha256 !== sha256(await readRegular(path.resolve(HERE, '../type-implementation/sources.lock.json')))) throw new Error('Type utilities source identity mismatch');
  const expected = [...lock.algorithms, ...lock.semanticReferenceSources]; const seen = new Set(); const sources = [];
  for (const pin of lock.files) {
    relativePath(pin.path); if (seen.has(pin.path) || !expected.includes(pin.path)) throw new Error('Invalid type utilities original source'); seen.add(pin.path);
    const bytes = verifyFile(await readRegular(path.join(sourceRoot, pin.path)), pin); sources.push({ pin, bytes });
  }
  if (seen.size !== expected.length || new Set(expected).size !== expected.length) throw new Error('Incomplete type utilities original source');
  const portable = [];
  for (let i = 0; i < NAMES.length; ++i) {
    const pin = lock.portableFiles[i]; if (pin.path !== NAMES[i] || pin.originalPath !== ALGORITHMS[i]) throw new Error('Invalid type utilities source mapping');
    const bytes = await readRegular(path.join(HERE, pin.path)); if (bytes.length !== pin.bytes || sha256(bytes) !== pin.sha256) throw new Error('Type utilities port changed');
    portable.push({ pin, bytes });
  }
  const pin = lock.hostDependencies[0]; if (pin.path !== 'assertions/CompilerAssertions.kt') throw new Error('Invalid type utilities assertion dependency');
  const bytes = await readRegular(path.resolve(HERE, '..', pin.path)); if (bytes.length !== pin.bytes || sha256(bytes) !== pin.sha256) throw new Error('Frozen compiler assertion changed');
  return { sourceRoot, lock, lockBytes, sources, portable, assertion: { pin, bytes } };
}

export async function prepareTypeUtilities(sourceRoot, outputRoot) {
  const input = await inputs(sourceRoot); outputRoot = path.resolve(outputRoot); await assertNoSymlink(outputRoot); await mkdir(outputRoot, { recursive: false, mode: 0o700 });
  for (const { pin, bytes } of input.sources) {
    const filename = path.join(outputRoot, 'sources', pin.path); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
  }
  const files = []; await mkdir(path.join(outputRoot, 'common'), { mode: 0o700 });
  for (const { pin, bytes } of input.portable) { const filename = path.join(outputRoot, 'common', pin.path); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); files.push({ ...pin, absolutePath: filename }); }
  const assertionPath = path.join(outputRoot, 'host', input.assertion.pin.path); await mkdir(path.dirname(assertionPath), { recursive: true, mode: 0o700 });
  await writeFile(assertionPath, input.assertion.bytes, { flag: 'wx', mode: 0o600 });
  const receipt = { schemaVersion: 1, kind: 'official-type-utilities-port', source: input.lock.source,
    sourceLockSha256: sha256(input.lockBytes), preparationToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
    originals: input.lock.files, files, hostFiles: [{ ...input.assertion.pin, absolutePath: assertionPath }],
    previousSourceLockSha256: input.lock.previousSourceLockSha256, sourceApiAdjustments: input.lock.sourceApiAdjustments,
    propertyAliasImport: PROPERTY_ALIAS_IMPORT, replacedOriginalPaths: input.lock.algorithms, requiredConcreteDependencies: input.lock.requiredConcreteDependencies,
    algorithms: 'real selected type utilities, equality/subtyping and original callback implementation bodies',
    compilerBuild: 'not-run: concrete builtins, descriptor and classic type-system closure required', browserCompilerBuilt: false, readiness: false };
  await writeJson(path.join(outputRoot, 'receipt.json'), receipt);
  return { outputRoot, receipt, sourceFiles: files.map(item => item.absolutePath), hostDependencyFiles: [assertionPath], propertyAliasImport: PROPERTY_ALIAS_IMPORT, replacedOriginalPaths: input.lock.algorithms };
}

export async function verifyTypeUtilitiesPreparation(directory) {
  directory = path.resolve(directory); await assertNoSymlink(directory); const receiptBytes = await readRegular(path.join(directory, 'receipt.json')); const receipt = JSON.parse(receiptBytes);
  const input = await inputs(path.join(directory, 'sources'));
  if (receipt.kind !== 'official-type-utilities-port' || receipt.sourceLockSha256 !== sha256(input.lockBytes) || receipt.preparationToolSha256 !== sha256(await readRegular(fileURLToPath(import.meta.url))) ||
      JSON.stringify(receipt.source) !== JSON.stringify(input.lock.source) || JSON.stringify(receipt.originals) !== JSON.stringify(input.lock.files) ||
      JSON.stringify(receipt.replacedOriginalPaths) !== JSON.stringify(input.lock.algorithms) || JSON.stringify(receipt.sourceApiAdjustments) !== JSON.stringify(input.lock.sourceApiAdjustments) ||
      JSON.stringify(receipt.requiredConcreteDependencies) !== JSON.stringify(input.lock.requiredConcreteDependencies) || receipt.previousSourceLockSha256 !== input.lock.previousSourceLockSha256 ||
      receipt.propertyAliasImport !== PROPERTY_ALIAS_IMPORT || receipt.compilerBuild !== 'not-run: concrete builtins, descriptor and classic type-system closure required' ||
      receipt.browserCompilerBuilt !== false || receipt.readiness !== false) throw new Error('Stale type utilities preparation');
  const sourceFiles = []; const hostDependencyFiles = [];
  for (const [records, pins, folder, output] of [[receipt.files, input.lock.portableFiles, 'common', sourceFiles], [receipt.hostFiles, input.lock.hostDependencies, 'host', hostDependencyFiles]]) {
    if (!Array.isArray(records) || records.length !== pins.length) throw new Error('Incomplete type utilities prepared index');
    for (let i = 0; i < pins.length; ++i) {
      const pin = pins[i]; const filename = path.join(directory, folder, pin.path); if (JSON.stringify(records[i]) !== JSON.stringify({ ...pin, absolutePath: filename })) throw new Error('Type utilities prepared index changed');
      const bytes = await readRegular(filename); if (bytes.length !== pin.bytes || sha256(bytes) !== pin.sha256) throw new Error('Type utilities prepared source changed'); output.push(filename);
    }
  }
  return { directory, receipt, receiptSha256: sha256(receiptBytes), sourceFiles, hostDependencyFiles, propertyAliasImport: PROPERTY_ALIAS_IMPORT, replacedOriginalPaths: receipt.replacedOriginalPaths };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter(value => value !== '--'); if (args.length !== 4 || args[0] !== '--source-dir' || args[2] !== '--output') throw new Error('Usage: prepare.mjs --source-dir PINNED_SOURCES --output NEW_DIRECTORY');
  const result = await prepareTypeUtilities(args[1], args[3]); console.log(JSON.stringify({ outputRoot: result.outputRoot, sourceFiles: result.sourceFiles.length }));
}

#!/usr/bin/env node
/** Exact official SmartSet bodies with a bounded JVM empty-iterator host boundary. */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORIGINAL = 'core/util.runtime/src/org/jetbrains/kotlin/utils/SmartSet.kt';
const REPLACEMENTS = [
  { from: 'import java.util.*', to: 'import kotlin.jvm.JvmStatic' },
  { from: 'Collections.emptySet<T>().iterator()', to: 'emptySmartSetIterator<T>()' },
];

async function inputs(sourceRoot) {
  sourceRoot = path.resolve(sourceRoot); await assertNoSymlink(sourceRoot);
  const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json')); const lock = JSON.parse(lockBytes);
  if (lock.schemaVersion !== 1 || lock.source.repository !== 'https://github.com/JetBrains/kotlin.git' ||
      lock.source.commit !== '4d78aae1e337cd40f69baa865aed950fe807a775' || lock.source.treeSha !== '2be662d1ae06bfcf435efbe18191ba5e1e3f035e' ||
      lock.original.path !== ORIGINAL || JSON.stringify(lock.replacements) !== JSON.stringify(REPLACEMENTS) ||
      lock.host.path !== 'SmartSetHost.kt' || lock.portable.path !== 'SmartSet.kt') throw new Error('SmartSet source identity mismatch');
  relativePath(lock.original.path);
  const original = verifyFile(await readRegular(path.join(sourceRoot, ORIGINAL)), lock.original);
  let text = original.toString('utf8');
  for (const replacement of REPLACEMENTS) {
    if (text.split(replacement.from).length !== 2) throw new Error('SmartSet source boundary no longer exact');
    text = text.replace(replacement.from, replacement.to);
  }
  const portable = Buffer.from(text);
  if (portable.length !== lock.portable.bytes || sha256(portable) !== lock.portable.sha256) throw new Error('SmartSet transformed source changed');
  const host = await readRegular(path.join(HERE, lock.host.path));
  if (host.length !== lock.host.bytes || sha256(host) !== lock.host.sha256) throw new Error('SmartSet empty iterator changed');
  return { sourceRoot, lock, lockBytes, original, portable, host };
}

export async function prepareSmartSetSources({ sourceRoot, outputRoot }) {
  const input = await inputs(sourceRoot); outputRoot = path.resolve(outputRoot); await assertNoSymlink(outputRoot);
  if (outputRoot === input.sourceRoot || outputRoot.startsWith(input.sourceRoot + path.sep) || input.sourceRoot.startsWith(outputRoot + path.sep)) throw new Error('SmartSet output overlaps original source');
  const root = path.join(outputRoot, 'compiler-port-smart-set'); await assertNoSymlink(root);
  await mkdir(outputRoot, { recursive: true, mode: 0o700 }); await mkdir(root, { recursive: false, mode: 0o700 });
  const originalPath = path.join(root, 'original', ORIGINAL); await mkdir(path.dirname(originalPath), { recursive: true, mode: 0o700 });
  await writeFile(originalPath, input.original, { flag: 'wx', mode: 0o600 });
  const commonSources = [];
  for (const [pin, bytes] of [[input.lock.portable, input.portable], [input.lock.host, input.host]]) {
    const filename = path.join(root, pin.path); await assertNoSymlink(filename); await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); commonSources.push(filename);
  }
  const receipt = { schemaVersion: 1, kind: 'official-smart-set-host-preparation', source: input.lock.source,
    sourceLockSha256: sha256(input.lockBytes), preparationToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
    original: input.lock.original, portable: input.lock.portable, host: input.lock.host, replacements: REPLACEMENTS,
    sourceBody: 'unchanged apart from explicit optional JVM annotation import and JVM empty-iterator host binding',
    stdlibSourceProvenance: input.lock.stdlibSourceProvenance, upstreamTestDiscovery: input.lock.upstreamTestDiscovery,
    commonSources, replacedOriginalPaths: [ORIGINAL], originalSourceUnmodified: true,
    browserCompilerBuilt: false, languageReadiness: false };
  const receiptPath = path.join(root, 'receipt.json'); await writeJson(receiptPath, receipt);
  return { commonSources, replacedOriginalPaths: [ORIGINAL], receipt, receiptPath };
}

export async function verifySmartSetPreparation(root) {
  root = path.resolve(root); await assertNoSymlink(root); const receiptBytes = await readRegular(path.join(root, 'receipt.json')); const receipt = JSON.parse(receiptBytes);
  const input = await inputs(path.join(root, 'original'));
  const expected = { schemaVersion: 1, kind: 'official-smart-set-host-preparation', source: input.lock.source,
    sourceLockSha256: sha256(input.lockBytes), preparationToolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
    original: input.lock.original, portable: input.lock.portable, host: input.lock.host, replacements: REPLACEMENTS,
    sourceBody: 'unchanged apart from explicit optional JVM annotation import and JVM empty-iterator host binding',
    stdlibSourceProvenance: input.lock.stdlibSourceProvenance, upstreamTestDiscovery: input.lock.upstreamTestDiscovery,
    commonSources: [path.join(root, 'SmartSet.kt'), path.join(root, 'SmartSetHost.kt')], replacedOriginalPaths: [ORIGINAL], originalSourceUnmodified: true,
    browserCompilerBuilt: false, languageReadiness: false };
  if (JSON.stringify(receipt) !== JSON.stringify(expected)) throw new Error('Stale SmartSet preparation');
  for (const pin of [input.lock.portable, input.lock.host]) {
    const bytes = await readRegular(path.join(root, pin.path));
    if (bytes.length !== pin.bytes || sha256(bytes) !== pin.sha256) throw new Error('Prepared SmartSet input changed');
  }
  return { root, receipt, receiptSha256: sha256(receiptBytes), commonSources: expected.commonSources, replacedOriginalPaths: expected.replacedOriginalPaths };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter(value => value !== '--');
  if (args.length !== 4 || args[0] !== '--source-root' || args[2] !== '--output') throw new Error('Usage: prepare.mjs --source-root PINNED_SOURCES --output NEW_DIRECTORY');
  const result = await prepareSmartSetSources({ sourceRoot: args[1], outputRoot: args[3] }); console.log(JSON.stringify({ receiptPath: result.receiptPath, commonSources: result.commonSources.length }));
}

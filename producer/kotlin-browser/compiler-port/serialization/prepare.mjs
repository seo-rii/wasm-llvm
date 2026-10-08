#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readJson, readRegular, relativePath, sha256, writeJson } from '../../scripts/source.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RUNTIME_FILES = ['Runtime.kt', 'Wire.kt', 'Streams.kt'];
export async function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve({ command, args, exitCode: code }) : reject(new Error(`${command} exited ${code ?? signal}`)));
  });
}
export async function prepareSerialization(sourceRoot, outputRoot) {
  sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
  await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot, { allowMissing: true });
  const lockBytes = await readRegular(path.join(HERE, 'sources.lock.json'));
  const lock = JSON.parse(lockBytes);
  if (lock.schemaVersion !== 1 || lock.source.commit !== '4d78aae1e337cd40f69baa865aed950fe807a775' || lock.source.repository !== 'https://github.com/JetBrains/kotlin.git') throw new Error('Serialization source identity mismatch');
  const seen = new Set();
  for (const pin of lock.files) {
    relativePath(pin.path);
    if (seen.has(pin.path) || !/^[a-f0-9]{40}$/.test(pin.gitBlob) || !/^[a-f0-9]{64}$/.test(pin.sha256) || !Number.isSafeInteger(pin.bytes) || pin.bytes <= 0) throw new Error('Invalid serialization source pin');
    seen.add(pin.path);
    const bytes = await readRegular(path.join(sourceRoot, pin.path));
    const gitBlob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (bytes.length !== pin.bytes || sha256(bytes) !== pin.sha256 || gitBlob !== pin.gitBlob) throw new Error('Serialization source mismatch: ' + pin.path);
  }
  for (const name of lock.schemaInputs) if (!seen.has(name) || !name.endsWith('.proto')) throw new Error('Unpinned schema input');
  const protoc = '/usr/bin/protoc';
  if (sha256(await readRegular(protoc)) !== lock.protoc.binarySha256) throw new Error('protoc binary differs from the recorded generator tool');
  await mkdir(outputRoot, { recursive: false, mode: 0o700 });
  const descriptor = path.join(outputRoot, 'metadata-ir.pb');
  const args = [`--proto_path=${sourceRoot}`, `--proto_path=${path.join(sourceRoot, 'core/metadata/src')}`, '--include_imports', `--descriptor_set_out=${descriptor}`,
    ...lock.schemaInputs.filter((name) => !name.endsWith('/descriptor.proto') && !name.endsWith('/ext_options.proto'))];
  const commands = [await run(protoc, args, sourceRoot)];
  const generated = path.join(outputRoot, 'generated');
  const generatorBytes = await readRegular(path.join(HERE, 'generate.py'));
  const frozenGenerator = path.join(outputRoot, 'generate.py');
  await writeFile(frozenGenerator, generatorBytes, {flag: 'wx', mode: 0o600});
  commands.push(await run('python3', [frozenGenerator, '--descriptor', descriptor, '--output', generated], sourceRoot));
  const generation = await readJson(path.join(generated, 'generation.json'));
  const catalogBytes = await readRegular(path.join(generated, 'catalog.json'));
  if (generation.catalog.bytes !== catalogBytes.length || generation.catalog.sha256 !== sha256(catalogBytes)) throw new Error('Generated schema catalog mismatch');
  const files = [];
  for (const record of generation.files) {
    relativePath(record.path); const bytes = await readRegular(path.join(generated, record.path));
    if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) throw new Error('Generated source identity mismatch');
    files.push({ ...record, absolutePath: path.join(generated, record.path) });
  }
  const runtime = [];
  await mkdir(path.join(outputRoot, 'runtime'), {mode: 0o700});
  for (const name of RUNTIME_FILES) {
    const bytes = await readRegular(path.join(HERE, name));
    const absolutePath = path.join(outputRoot, 'runtime', name);
    await writeFile(absolutePath, bytes, {flag: 'wx', mode: 0o600});
    runtime.push({path: name, absolutePath, bytes: bytes.length, sha256: sha256(bytes)});
  }
  const receipt = { schemaVersion: 1, kind: 'official-schema-portable-generation', source: lock.source, sourceLockSha256: sha256(lockBytes),
    protoc: lock.protoc, generatorSha256: sha256(generatorBytes), descriptorSha256: sha256(await readRegular(descriptor)),
    messages: generation.messages, fields: generation.fields, enums: generation.enums, extensions: generation.extensions, catalog: generation.catalog, files, runtime, commands,
    compilerSourceBuilt: false, browserCompiler: 'not-built', readiness: false };
  await writeJson(path.join(outputRoot, 'receipt.json'), receipt);
  return { outputRoot, receipt, sourceFiles: [...runtime, ...files].map((file) => file.absolutePath) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter((value) => value !== '--');
  if (args.length !== 4 || args[0] !== '--source-dir' || args[2] !== '--output') throw new Error('Usage: prepare.mjs --source-dir PINNED_SOURCES --output NEW_DIRECTORY');
  const result = await prepareSerialization(args[1], args[3]);
  console.log(JSON.stringify({ outputRoot: result.outputRoot, messages: result.receipt.messages, fields: result.receipt.fields, extensions: result.receipt.extensions }));
}

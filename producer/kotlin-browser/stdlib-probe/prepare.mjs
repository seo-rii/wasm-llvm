#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readJson, readRegular, relativePath, responseBytes, sha256,
  validateFilePin, verifyFile, writeJson } from '../scripts/source.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRODUCER = path.resolve(HERE, '..');
export const defaultInput = path.resolve(PRODUCER, '..', '..', 'out', 'kotlin-stdlib-probe');

export async function loadRecipe(directory = HERE) {
  const recipe = await readJson(path.join(directory, 'recipe.json'));
  const manifest = await readJson(path.join(PRODUCER, 'manifest.json'));
  const originalLock = await readJson(path.join(PRODUCER, 'sources.lock.json'));
  if (recipe.schemaVersion !== 1 || recipe.source?.repository !== manifest.source.repository ||
      recipe.source.commit !== manifest.source.commit || recipe.bootstrapVersion !== '2.5.0-dev-10106' ||
      recipe.source.treeSha !== originalLock.source.treeSha ||
      recipe.moduleName !== 'kotlin' || recipe.kotlinVersion !== '2.5.255-SNAPSHOT' ||
      recipe.languageVersion !== '2.5' || recipe.apiVersion !== '2.5' ||
      !Array.isArray(recipe.files) || recipe.files.length !== 507) throw new Error('Unsupported stdlib source recipe');
  const names = recipe.fragments?.map((fragment) => fragment.name);
  if (JSON.stringify(names) !== JSON.stringify(['commonMain', 'commonNonJvmMain', 'nativeWasmMain',
    'nativeWasmWasiMain', 'wasmCommonMain', 'wasmWasiMain'])) throw new Error('Unexpected stdlib fragment hierarchy');
  const expectedParents = [[], ['commonMain'], ['commonNonJvmMain'], ['nativeWasmMain'],
    ['nativeWasmMain'], ['wasmCommonMain', 'nativeWasmWasiMain']];
  const expectedRoots = [['common/src', 'src', 'unsigned/src'], ['common-non-jvm/src'], ['native-wasm/src'],
    ['native-wasm/wasi'], ['wasm/builtins', 'wasm/internal', 'wasm/runtime', 'wasm/src', 'wasm/stubs'],
    ['wasm/wasi/builtins', 'wasm/wasi/internal', 'wasm/wasi/src']];
  recipe.fragments.forEach((fragment, index) => {
    if (JSON.stringify(fragment.refines) !== JSON.stringify(expectedParents[index])) throw new Error('Changed stdlib fragment parents');
    if (JSON.stringify(fragment.roots) !== JSON.stringify(expectedRoots[index])) throw new Error('Changed stdlib fragment roots');
    fragment.roots.forEach(relativePath);
  });
  const paths = new Set();
  let compile = 0;
  let copied = 0;
  let total = 0;
  for (const pin of recipe.files) {
    relativePath(pin.path);
    validateFilePin(pin);
    if (paths.has(pin.path)) throw new Error('Duplicate stdlib input path');
    paths.add(pin.path);
    total += pin.bytes;
    if (pin.kind === 'compile') {
      const fragment = recipe.fragments.find((entry) => entry.name === pin.sourceSet);
      if (!fragment || !pin.path.endsWith('.kt') || !fragment.roots.some((root) => pin.path.startsWith('libraries/stdlib/' + root + '/'))) {
        throw new Error('Source is outside its declared stdlib fragment');
      }
      compile++;
    } else if (pin.kind === 'builtin-copy') {
      relativePath(pin.generatedPath);
      if (pin.sourceSet !== 'wasmCommonMain' || !pin.path.startsWith('libraries/stdlib/jvm/builtins/') ||
          pin.generatedPath !== 'generated/wasm-builtin-sources/kotlin/' + pin.path.slice('libraries/stdlib/jvm/builtins/'.length)) {
        throw new Error('Invalid generated builtin mapping');
      }
      copied++;
    } else if (!['build-input', 'generator-input'].includes(pin.kind)) throw new Error('Unknown stdlib input role');
  }
  if (compile !== 496 || copied !== 5 || total !== 5172788) throw new Error('Incomplete stdlib source closure');
  if (!Array.isArray(recipe.flags) || recipe.flags.some((flag) => typeof flag !== 'string' ||
      /skip-metadata|suppress-missing-builtins|disable.*check|traps-instead|ignore-errors/.test(flag)) ||
      !['-Xmulti-platform', '-Xstdlib-compilation', '-Xexplicit-api=strict', '-Xallow-kotlin-package',
        '-Xexpect-actual-classes', '-Xreturn-value-checker=full', '-Xcompanion-blocks', '-Xir-module-name=kotlin',
        '-Werror'].every((flag) => recipe.flags.includes(flag))) {
    throw new Error('Unsupported semantic bypass in stdlib flags');
  }
  const patchBytes = await readRegular(path.join(PRODUCER, recipe.patch.metadataPath));
  if (sha256(patchBytes) !== recipe.patch.metadataSha256) throw new Error('WASI patch metadata changed');
  return recipe;
}

export async function prepare({ input = defaultInput, sourceCache, fetcher = fetch } = {}) {
  const recipe = await loadRecipe();
  input = path.resolve(input);
  await assertNoSymlink(input);
  await mkdir(input, { recursive: true });
  let next = 0;
  let downloaded = 0;
  const readOrFetch = async (pin, filename, url, cached) => {
    try { return verifyFile(await readRegular(filename, pin.bytes), pin); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let bytes;
    if (cached) {
      try { bytes = verifyFile(await readRegular(cached, pin.bytes), pin); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!bytes) { bytes = verifyFile(await responseBytes(url, pin.bytes, fetcher), pin); downloaded++; }
    await assertNoSymlink(filename);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
    return bytes;
  };
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < recipe.files.length) {
      const pin = recipe.files[next++];
      await readOrFetch(pin, path.join(input, 'sources', pin.path),
        'https://raw.githubusercontent.com/JetBrains/kotlin/' + recipe.source.commit + '/' + pin.path,
        sourceCache && path.join(sourceCache, pin.path));
    }
  }));
  const metadata = await readJson(path.join(PRODUCER, recipe.patch.metadataPath));
  const abiHeader = path.join(input, 'abi', 'wasip1.h');
  await readOrFetch(metadata.abi.header, abiHeader,
    'https://raw.githubusercontent.com/WebAssembly/wasi-libc/' + metadata.abi.commit + '/' + metadata.abi.header.path);
  const receipt = { schemaVersion: 1, kind: 'pinned-kotlin-wasi-stdlib-source-preparation', source: recipe.source,
    recipeSha256: sha256(await readRegular(path.join(HERE, 'recipe.json'))), files: recipe.files.length,
    bytes: recipe.files.reduce((sum, pin) => sum + pin.bytes, 0), sourceIdentityVerification: 'Git blob SHA-1 and SHA-256 for every input',
    abi: metadata.abi, gradleSourceSetResolution: 'not-run', stdlibBuild: 'not-run', publicLanguageSupport: false };
  const filename = path.join(input, 'inputs.json');
  try { await writeJson(filename, receipt); }
  catch (error) {
    if (error.code !== 'EEXIST' || JSON.stringify(await readJson(filename)) !== JSON.stringify(receipt)) throw error;
  }
  return { input, recipe, abiHeader, receipt, downloaded };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2).filter((argument) => argument !== '--');
    if (args.includes('--help')) console.log('Usage: node producer/kotlin-browser/stdlib-probe/prepare.mjs [--input DIR] [--source-cache DIR]');
    else {
      const options = {};
      while (args.length) {
        const flag = args.shift();
        const key = { '--input': 'input', '--source-cache': 'sourceCache' }[flag];
        if (!key || !args[0] || args[0].startsWith('--') || options[key]) throw new Error('Invalid stdlib prepare option');
        options[key] = path.resolve(args.shift());
      }
      const result = await prepare(options);
      console.log(JSON.stringify({ input: result.input, files: result.recipe.files.length, downloaded: result.downloaded, status: 'verified' }));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

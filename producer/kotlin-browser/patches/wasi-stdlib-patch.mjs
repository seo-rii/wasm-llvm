import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { assertNoSymlink, json, readJson, readRegular, relativePath, sha256,
  validateFilePin, verifyFile, writeJson } from '../scripts/source.mjs';

const execute = promisify(execFile);
const directory = path.dirname(fileURLToPath(import.meta.url));
const ioPath = 'libraries/stdlib/wasm/wasi/src/kotlin/io.kt';
const allocatorPath = 'libraries/stdlib/wasm/src/kotlin/wasm/unsafe/MemoryAllocation.kt';
const kotlinCommit = '4d78aae1e337cd40f69baa865aed950fe807a775';

function editedBytes(bytes, metadata, reverse = false) {
  let text = bytes.toString('utf8');
  for (const edit of metadata.edits) {
    const before = reverse ? edit.after : edit.before;
    const after = reverse ? edit.before : edit.after;
    if (text.split(before).length !== 2) throw new Error('Expected exactly one pinned edit anchor');
    text = text.replace(before, after);
  }
  const result = Buffer.from(text);
  verifyFile(result, reverse ? metadata.original : metadata.patched);
  return result;
}

async function metadataAndPatch() {
  const metadataFilename = path.join(directory, 'wasi-preview1-io.json');
  const metadataBytes = await readRegular(metadataFilename);
  const metadata = JSON.parse(metadataBytes.toString('utf8'));
  if (metadata.schemaVersion !== 1 || metadata.source?.commit !== kotlinCommit ||
      metadata.original?.path !== ioPath || metadata.patched?.path !== ioPath ||
      metadata.patch?.path !== 'wasi-preview1-io.patch' ||
      metadata.sourceDependencies?.length !== 2 || metadata.edits?.length !== 2 ||
      metadata.edits[0].before !== '    val subscriptionPtr = allocator.allocate(20)' ||
      metadata.edits[0].after !== '    val subscriptionPtr = allocator.allocate(48)' ||
      metadata.edits[1].before !== '    val eventSize = 26' ||
      metadata.edits[1].after !== '    val eventSize = 32') {
    throw new Error('Unsupported WASI patch identity or edit scope');
  }
  for (const pin of [metadata.patch, metadata.original, metadata.patched,
    ...metadata.sourceDependencies, metadata.abi.header]) {
    relativePath(pin.path);
    validateFilePin(pin);
  }
  if (metadata.sourceDependencies[0].path !== allocatorPath ||
      metadata.sourceDependencies[1].path !== 'libraries/stdlib/build.gradle.kts') {
    throw new Error('Unexpected WASI patch source dependency');
  }
  const manifest = await readJson(path.join(directory, '../manifest.json'));
  if (manifest.source?.commit !== metadata.source.commit || manifest.source?.repository !== metadata.source.repository) {
    throw new Error('WASI patch and producer candidate source identities differ');
  }
  const patchFilename = path.join(directory, metadata.patch.path);
  verifyFile(await readRegular(patchFilename), metadata.patch);
  return { metadata, metadataSha256: sha256(metadataBytes), patchFilename };
}

async function exercisePatch(original, patched, patchFilename) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'kotlin-wasi-patch-check-'));
  try {
    const ioFilename = path.join(scratch, ioPath);
    await mkdir(path.dirname(ioFilename), { recursive: true });
    await writeFile(ioFilename, original, { mode: 0o600 });
    const git = async (args) => (await execute('git', args, { cwd: scratch, maxBuffer: 1024 * 1024 })).stdout;
    const numstat = (await git(['apply', '--numstat', '--', patchFilename])).trim();
    if (numstat !== '2\t2\t' + ioPath) throw new Error('WASI patch must change exactly two lines in io.kt');
    await git(['apply', '--check', '--', patchFilename]);
    await git(['apply', '--', patchFilename]);
    if (!(await readRegular(ioFilename)).equals(patched)) throw new Error('Git-applied patch differs from pinned output');
    await git(['apply', '--reverse', '--check', '--', patchFilename]);
    await git(['apply', '--reverse', '--', patchFilename]);
    if (!(await readRegular(ioFilename)).equals(original)) throw new Error('Patch reverse did not restore exact source bytes');
    return { apply: 'pass', reverse: 'pass', changedPaths: [ioPath], addedLines: 2, removedLines: 2 };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

/** The source hashes remain the trust root. These assertions identify the inspected boundaries. */
function inspectAllocator(bytes) {
  const text = bytes.toString('utf8');
  for (const required of [
    'private val alignment = 8u',
    'private val globalFirstValidAddress = alignment',
    'val alignedSize =  (size + (alignment - 1u)) and (alignment - 1u).inv()',
    'val alignedSize = realAllocationSize(size)',
    'val reinsertedSlot = MemorySlot(slot.ptr + alignedSize, slot.size - alignedSize)',
    'override fun allocate(size: Int): Pointer = delegatingAllocator.allocate(size)'
  ]) {
    if (!text.includes(required)) throw new Error('Pinned allocator inspection boundary changed');
  }
  return {
    kind: 'source-inspection', pointerAlignment: 8, roundingMultiple: 8,
    originalRequestedBytes: { subscription: 20, event: 26 },
    originalPhysicalBytes: { subscription: 24, event: 32 },
    patchedRequestedBytes: { subscription: 48, event: 32 },
    patchedPhysicalBytes: { subscription: 48, event: 32 },
    observation: 'The current allocator already rounds event26 to32; subscription20 rounds24, below48.',
    wasmExecution: 'not-run', actualMemoryCorruption: 'not-reproduced'
  };
}

function inspectAbi(bytes) {
  const text = bytes.toString('utf8');
  for (const required of [
    'sizeof(__wasi_subscription_t) == 48', '_Alignof(__wasi_subscription_t) == 8',
    'sizeof(__wasi_event_t) == 32', '_Alignof(__wasi_event_t) == 8',
    'offsetof(__wasi_subscription_t, userdata) == 0', 'offsetof(__wasi_subscription_t, u) == 8',
    'offsetof(__wasi_event_t, error) == 8', 'offsetof(__wasi_event_t, type) == 10',
    'offsetof(__wasi_event_t, fd_readwrite) == 16'
  ]) {
    if (!text.includes(required)) throw new Error('Pinned Preview 1 structure boundary changed');
  }
  return { kind: 'source-inspection', subscriptionBytes: 48, eventBytes: 32, alignment: 8 };
}

export async function verifyWasiStdlibPatch({ sourceDir, abiHeader, action = 'verify' }) {
  if (!['verify', 'apply', 'check'].includes(action)) throw new Error('Expected verify, apply, or check action');
  if (!sourceDir || !abiHeader) throw new Error('--source-dir and --abi-header are required');
  await assertNoSymlink(sourceDir);
  const { metadata, metadataSha256, patchFilename } = await metadataAndPatch();
  const pins = [action === 'check' ? metadata.patched : metadata.original, ...metadata.sourceDependencies];
  const sources = await Promise.all(pins.map(async (pin) => {
    const filename = path.join(sourceDir, pin.path);
    return verifyFile(await readRegular(filename, pin.bytes), pin);
  }));
  const abi = verifyFile(await readRegular(abiHeader, metadata.abi.header.bytes), metadata.abi.header);
  const original = action === 'check' ? editedBytes(sources[0], metadata, true) : sources[0];
  const patched = editedBytes(original, metadata);
  const patchVerification = await exercisePatch(original, patched, patchFilename);
  const allocator = inspectAllocator(sources[1]);
  const structures = inspectAbi(abi);
  const buildText = sources[2].toString('utf8');
  if (!buildText.includes('val wasmWasiMain = getByName("wasmWasiMain")') ||
      !buildText.includes('srcDir("wasm/wasi/src")') ||
      !buildText.includes('prepareWasmBuiltinSources') ||
      !buildText.includes('writeStdlibVersion')) throw new Error('Pinned stdlib build boundary changed');
  if (action === 'apply') {
    // Verification runs in scratch first. Only this explicitly selected io.kt is changed.
    await execute('git', ['apply', '--check', '--', patchFilename], { cwd: sourceDir, maxBuffer: 1024 * 1024 });
    await execute('git', ['apply', '--', patchFilename], { cwd: sourceDir, maxBuffer: 1024 * 1024 });
    verifyFile(await readRegular(path.join(sourceDir, ioPath), metadata.patched.bytes), metadata.patched);
  }
  return {
    schemaVersion: 1, kind: 'kotlin-wasi-stdlib-source-patch-verification',
    patchId: metadata.patchId, source: metadata.source, metadataSha256,
    patch: metadata.patch, original: metadata.original, patched: metadata.patched,
    sourceDependencies: metadata.sourceDependencies, abi: metadata.abi,
    action, selectedSourceBytesVerified: true, entireSourceTreeVerified: false,
    sourceState: action === 'verify' ? 'unmodified' : 'patched', patchVerification,
    allocator, structures, build: metadata.build,
    execution: { stdlibRebuild: 'not-run', kotlinAllocatorCanary: 'not-run', kotlinBrowserRun: 'not-run' },
    readiness: { ready: false, sourcePatchVerification: 'pass', G5: 'not-run' },
    limits: [
      'This verifies selected source bytes and exact patch application, not a complete stdlib/compiler build set.',
      'The current source allocator alignment and rounding are inspected, not executed in Kotlin Wasm.',
      'Changing source does not change a precompiled KLIB: rebuild and hash the wasmWasi target stdlib.',
      'Do not compile io.kt alone as an override library or mix patched candidate source with an unrelated stdlib.',
      'Linear-memory bounds cannot identify smaller logical allocator objects in an unpatched program.'
    ]
  };
}

async function main() {
  const args = process.argv.slice(2);
  const action = args.shift();
  const options = { action };
  let output;
  while (args.length) {
    const flag = args.shift();
    const value = args.shift();
    if (!value || value.startsWith('--')) throw new Error('Missing option value');
    if (flag === '--source-dir') options.sourceDir = value;
    else if (flag === '--abi-header') options.abiHeader = value;
    else if (flag === '--output') output = value;
    else throw new Error('Unknown option: ' + flag);
  }
  if (output) {
    await assertNoSymlink(output);
    try {
      await lstat(output);
      throw new Error('Refusing to overwrite an existing verification receipt');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const receipt = await verifyWasiStdlibPatch(options);
  receipt.tools = { node: process.versions.node, git: (await execute('git', ['--version'])).stdout.trim() };
  receipt.command = ['node', 'producer/kotlin-browser/patches/wasi-stdlib-patch.mjs', ...process.argv.slice(2)];
  if (output) await writeJson(output, receipt);
  else process.stdout.write(json(receipt));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}

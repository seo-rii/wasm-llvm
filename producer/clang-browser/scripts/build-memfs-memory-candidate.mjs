import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { buildMemfs, verifyMemfsModule } from './build-memfs.mjs';
import { patchId, patchMemfsMemorySource, instrumentMemfsZeroFill } from './memfs-memory-patch.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const describe = (bytes) => ({ bytes: bytes.length, sha256: hash(bytes) });

export async function buildMemfsMemoryCandidate({ wasiSdkPath, outDir }) {
  if (!wasiSdkPath || !outDir) throw new Error('wasiSdkPath and outDir are required');
  wasiSdkPath = path.resolve(wasiSdkPath);
  outDir = path.resolve(outDir);
  const baselineWork = path.join(outDir, 'work-baseline');
  const baseline = await buildMemfs({ wasiSdkPath, workDir: baselineWork, outDir: path.join(outDir, 'baseline') });
  const original = await fs.readFile(path.join(baselineWork, 'build/memfs.c'), 'utf8');
  const candidateSource = patchMemfsMemorySource(original);
  const variants = {
    candidate: candidateSource,
    'baseline-instrumented': instrumentMemfsZeroFill(original),
    'candidate-instrumented': instrumentMemfsZeroFill(candidateSource)
  };
  const outputs = {};
  for (const [name, source] of Object.entries(variants)) {
    const directory = path.join(outDir, name);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'memfs.c'), source);
    await fs.copyFile(path.join(baselineWork, 'build/stb_sprintf.h'), path.join(directory, 'stb_sprintf.h'));
    for (const argv of baseline.receipt.commands) {
      const [command, ...args] = argv.map((arg) => arg.replaceAll('${WASI_SDK_PATH}', wasiSdkPath));
      execFileSync(command, args, { cwd: directory, stdio: 'inherit' });
    }
    const wasm = await fs.readFile(path.join(directory, 'memfs.wasm'));
    const gzip = gzipSync(wasm, { level: 9 });
    await fs.writeFile(path.join(directory, 'memfs.wasm.gz'), gzip);
    const abi = name === 'candidate' ? await verifyMemfsModule(wasm) : null;
    outputs[name] = { source: describe(Buffer.from(source)), wasm: describe(wasm), gzip: describe(gzip), abi,
      testInstrumentation: name.endsWith('-instrumented') };
  }
  await fs.copyFile(path.join(outDir, 'baseline/LICENSE.llvm.txt'), path.join(outDir, 'LICENSE.llvm.txt'));
  await fs.copyFile(path.join(outDir, 'baseline/LICENSE.stb_sprintf.txt'), path.join(outDir, 'LICENSE.stb_sprintf.txt'));
  const receipt = {
    format: 'wasm-llvm-memfs-memory-candidate-v1', patchId,
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    baseline: baseline.receipt,
    modernizedInput: describe(Buffer.from(original)),
    builderSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))),
    patcherSha256: hash(await fs.readFile(new URL('./memfs-memory-patch.mjs', import.meta.url))),
    commands: baseline.receipt.commands, outputs,
    promoted: false,
    limitations: ['No consumer release pins changed', 'No full Clang/LLD rebuild or speed claim',
      'Instrumented binaries are test-only and have an additional import']
  };
  await fs.writeFile(path.join(outDir, 'candidate-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log('MEMFS_CANDIDATE_RECEIPT ' + JSON.stringify(receipt));
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw new Error('Usage: node build-memfs-memory-candidate.mjs WASI_SDK_DIR OUT_DIR');
  await buildMemfsMemoryCandidate({ wasiSdkPath: process.argv[2], outDir: process.argv[3] });
}

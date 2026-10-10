#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBootstrap, defaultCache } from '../../build/bootstrap.mjs';
import { assertNoSymlink, readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { verifyTypePreparation } from './prepare.mjs';
export async function buildTypeContracts(preparedDirectory, outputRoot, bootstrapCache = defaultCache) {
  const prepared = await verifyTypePreparation(preparedDirectory); const bootstrap = await verifyBootstrap(bootstrapCache);
  outputRoot = path.resolve(outputRoot); await assertNoSymlink(outputRoot, { allowMissing: true }); await mkdir(outputRoot, { recursive: false, mode: 0o700 });
  const jar = path.join(outputRoot, 'type-contracts.jar');
  const classPath = bootstrap.artifacts.filter(record => ['compiler', 'stdlib-jvm'].includes(record.id)).map(record => record.path).join(path.delimiter);
  const args = ['-Xmx1g', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-classpath', classPath,
    '-Xmulti-platform', '-Xcommon-sources=' + prepared.sourceFiles.join(','), '-d', jar, ...prepared.sourceFiles];
  await new Promise((resolve, reject) => { const child = spawn('java', args, { cwd: outputRoot, stdio: 'inherit' }); child.once('error', reject); child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error('Type contract compiler exited ' + (code ?? signal)))); });
  await verifyTypePreparation(preparedDirectory); const bytes = await readRegular(jar);
  const receipt = { schemaVersion: 1, kind: 'official-type-jvm-contract-build', source: prepared.receipt.source,
    preparationSha256: prepared.receiptSha256, toolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
    compiler: { version: bootstrap.lock.version, sourceCommit: null, artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
    externalTypes: 'genuine verified bootstrap compiler classes', commands: [{ command: 'java', args, exitCode: 0 }],
    outputs: [{ path: 'type-contracts.jar', bytes: bytes.length, sha256: sha256(bytes) }],
    interfaces: prepared.receipt.interfaces, enums: prepared.receipt.enums, methods: prepared.receipt.methods,
    wasmBuild: 'not-run: real descriptor and type-system closure required', typeCheckingAlgorithmsPorted: false, readiness: false };
  await writeJson(path.join(outputRoot, 'receipt.json'), receipt); return { outputRoot, receipt };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter(value => value !== '--');
  if (args.length !== 4 || args[0] !== '--prepared-dir' || args[2] !== '--output') throw new Error('Usage: build.mjs --prepared-dir PREPARED --output NEW_DIRECTORY');
  const result = await buildTypeContracts(args[1], args[3]); console.log(JSON.stringify({ outputRoot: result.outputRoot, outputs: result.receipt.outputs }));
}

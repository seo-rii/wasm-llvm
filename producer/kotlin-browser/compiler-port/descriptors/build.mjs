#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBootstrap, defaultCache } from '../../build/bootstrap.mjs';
import { assertNoSymlink, readRegular, sha256, writeJson } from '../../scripts/source.mjs';
import { verifyDescriptorPreparation } from './prepare.mjs';

async function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve({ command, args, exitCode: code }) : reject(new Error(`${command} exited ${code ?? signal}`)));
  });
}

export async function buildDescriptorContracts(preparedDirectory, outputRoot, bootstrapCache = defaultCache) {
  const prepared = await verifyDescriptorPreparation(preparedDirectory); const bootstrap = await verifyBootstrap(bootstrapCache);
  outputRoot = path.resolve(outputRoot); await assertNoSymlink(outputRoot, { allowMissing: true }); await mkdir(outputRoot, { recursive: false, mode: 0o700 });
  const compiler = bootstrap.artifacts.find(record => record.id === 'compiler'); const stdlib = bootstrap.artifacts.find(record => record.id === 'stdlib-jvm');
  const jar = path.join(outputRoot, 'descriptor-contracts.jar');
  const command = await run('java', ['-Xmx1g', '-cp', bootstrap.classPath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect',
    '-classpath', [stdlib.path, compiler.path].join(path.delimiter), '-Xmulti-platform', '-Xcommon-sources=' + prepared.sourceFiles.join(','),
    '-d', jar, ...prepared.sourceFiles], outputRoot);
  await verifyDescriptorPreparation(preparedDirectory);
  const bytes = await readRegular(jar);
  const receipt = { schemaVersion: 1, kind: 'official-descriptor-jvm-contract-build', source: prepared.receipt.source,
    preparationSha256: prepared.receiptSha256, toolSha256: sha256(await readRegular(fileURLToPath(import.meta.url))),
    compiler: { version: bootstrap.lock.version, sourceCommit: null, artifacts: bootstrap.artifacts.map(({ id, bytes, sha256 }) => ({ id, bytes, sha256 })) },
    externalTypes: 'verified bootstrap compiler JVM classes, not fabricated types', commands: [command],
    outputs: [{ path: 'descriptor-contracts.jar', bytes: bytes.length, sha256: sha256(bytes) }],
    interfaces: prepared.receipt.interfaces, methods: prepared.receipt.methods, aliases: prepared.receipt.aliases,
    concreteImplementationsPorted: false, wasmBuild: 'not-run: requires actual portable descriptor type closure', readiness: false };
  await writeJson(path.join(outputRoot, 'receipt.json'), receipt); return { outputRoot, receipt };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter(value => value !== '--'); const opts = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--prepared-dir', '--output', '--bootstrap-cache'].includes(args[i]) || !args[i + 1] || opts[args[i]]) throw new Error('Invalid descriptor build arguments');
    opts[args[i]] = args[i + 1];
  }
  if (!opts['--prepared-dir'] || !opts['--output']) throw new Error('Usage: build.mjs --prepared-dir PREPARED --output NEW_DIRECTORY');
  const result = await buildDescriptorContracts(opts['--prepared-dir'], opts['--output'], opts['--bootstrap-cache'] ?? defaultCache);
  console.log(JSON.stringify({ outputRoot: result.outputRoot, outputs: result.receipt.outputs }));
}

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { inventory, json, sha256 } from './prepare-elf-linker-experiment.mjs';

export async function probeBrowser({ plan, variantName, outputOverride, manifestOverride, reportOverride }) {
  const variant = plan.variants[variantName];
  if (!variant) throw new Error('variant must be baseline or candidate');
  const output = outputOverride || variant.out;
  const manifestPath = manifestOverride || path.join(variant.root, 'manifest.json');
  const manifestBytes = await fs.readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  const snapshot = path.join(plan.out, 'consumer');
  const consumer = path.join(plan.out, variantName, outputOverride ? 'preflight-consumer' : 'consumer');
  const files = await inventory(snapshot);
  assert.equal(sha256(json(files)), plan.consumer.sha256, 'Consumer snapshot changed');
  assert.equal(sha256(json(await inventory(plan.consumer.engine.root))), plan.consumer.engine.sha256, 'Pinned Chromium changed');
  await fs.cp(snapshot, consumer, { recursive: true });
  const lock = JSON.parse(await fs.readFile(path.join(consumer, 'producer-lock.json'), 'utf8'));
  Object.assign(lock, {
    producerId: manifest.producerId, manifestSha256: sha256(manifestBytes), sourceDateEpoch: manifest.sourceDateEpoch,
    environment: manifest.environment, hostTools: manifest.hostTools, sources: manifest.sources,
    runtimeVersion: `${lock.runtimeVersion}-elf-experiment-${sha256(manifestBytes).slice(0, 12)}`
  });
  await fs.writeFile(path.join(consumer, 'producer-lock.json'), json(lock));
  const importFile = (file) => import(pathToFileURL(path.join(consumer, file)).href);
  // Use the actual importer verification and pack/memory helpers, preserving the snapshotted vendor
  // graph instead of regenerating it from installed JCO versions with a different package layout.
  const { verifyProducerOutput } = await importFile('scripts/prepare-producer-runtime.mjs');
  const receipt = await verifyProducerOutput(output, lock);
  const { buildRuntimePackReference, maybePrecompressRuntimeAsset, patchRustcMemoryMaximum } = await importFile('scripts/prepare-runtime.mjs');
  const runtimeRoot = path.join(consumer, 'dist/runtime');
  await fs.rm(runtimeRoot, { recursive: true, force: true }); // Only this invocation's private copy.
  const rustc = path.join(runtimeRoot, 'rustc/rustc.wasm');
  await fs.mkdir(path.dirname(rustc), { recursive: true });
  await fs.copyFile(path.join(output, 'rust/bin/rustc.wasm'), rustc);
  await patchRustcMemoryMaximum(rustc);
  const template = JSON.parse(await fs.readFile(path.join(consumer, 'runtime-template.json'), 'utf8'));
  template.version = lock.runtimeVersion;
  template.producer = { id: receipt.producerId, manifestSha256: receipt.manifestSha256,
    runner: receipt.runner, sourceDateEpoch: receipt.sourceDateEpoch };
  template.compiler.rustcWasm = await maybePrecompressRuntimeAsset(rustc, 'rustc');
  for (const target of ['wasm32-wasip1', 'wasm32-wasip2', 'wasm32-wasip3']) {
    const root = path.join(output, 'rust/lib/rustlib', target, 'lib');
    const sources = await inventory(root);
    template.targets[target].sysrootPack = await buildRuntimePackReference({
      packAsset: `packs/sysroot/${target}.pack`, indexAsset: `packs/sysroot/${target}.index.json`,
      entries: sources.map((file) => ({ sourcePath: path.join(root, file.path), runtimePath: `/lib/rustlib/${target}/lib/${file.path}` }))
    });
  }
  template.assetReceipts = Object.fromEntries(Object.entries(template.assetReceipts).filter(([name]) => name.startsWith('wasm-rust/vendor/')));
  for (const file of await inventory(runtimeRoot)) {
    const encoded = await fs.readFile(path.join(runtimeRoot, file.path));
    const decoded = file.path.endsWith('.gz') ? gunzipSync(encoded) : null;
    template.assetReceipts[`wasm-rust/runtime/${file.path}`] = {
      bytes: encoded.length, sha256: sha256(encoded),
      ...(decoded ? { uncompressedBytes: decoded.length, uncompressedSha256: sha256(decoded) } : {})
    };
  }
  await fs.writeFile(path.join(runtimeRoot, 'runtime-manifest.v3.json'), json(template));
  await fs.mkdir(path.join(consumer, 'browser-harness'), { recursive: true });
  await fs.writeFile(path.join(consumer, 'browser-harness', 'index.html'), '<!doctype html><title>Rust ELF experiment</title>');
  const { startBrowserHarnessServer } = await importFile('scripts/browser-harness-server.mjs');
  const require = createRequire(path.join(consumer, 'package.json'));
  const { chromium } = require('playwright-core');
  const runtimeManifest = await fs.readFile(path.join(consumer, 'dist/runtime/runtime-manifest.v3.json'));
  const digest = sha256(runtimeManifest);
  const runtimeProfile = {
    profileId: `rust-elf-experiment-${digest}`, protocolVersion: 1,
    manifestPath: 'runtime/runtime-manifest.v3.json', manifestFingerprint: digest,
    manifestReceipt: { bytes: runtimeManifest.length, sha256: digest }
  };
  const server = await startBrowserHarnessServer();
  let browser;
  try {
    browser = await chromium.launch({ executablePath: plan.consumer.engine.executable, headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(server.origin);
    const source = `use std::io::{self, Read};
use std::collections::BTreeSet;
fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let values: Vec<u32> = input.split_whitespace().map(|n| n.parse().unwrap()).collect();
    let unique: BTreeSet<u32> = values.iter().copied().collect();
    println!("rust-elf-ok:{}:{}", values.iter().sum::<u32>(), unique.len());
}`;
    const browserResult = await page.evaluate(async ({ runtimeProfile, source }) => {
      const api = await import('/dist/index.js');
      const readyStart = performance.now();
      const compiler = await api.createRustCompiler({ dependencies: { runtimeProfile } });
      const factoryMs = performance.now() - readyStart;
      const rows = [];
      for (const targetTriple of ['wasm32-wasip1', 'wasm32-wasip2', 'wasm32-wasip3']) {
        let started = performance.now();
        const check = await compiler.check({ code: source, targetTriple });
        const checkMs = performance.now() - started;
        started = performance.now();
        const compiled = await compiler.compile({ code: source, targetTriple, optimizationProfile: 'interactive' });
        const compileMs = performance.now() - started;
        if (!compiled.success || !compiled.artifact) throw new Error(JSON.stringify(compiled));
        let input = '20 2 20';
        started = performance.now();
        const executed = await api.executeBrowserRustArtifact(compiled.artifact, {
          stdin() { const next = input; input = null; return next; }
        });
        rows.push({ targetTriple, check, checkMs, compileMs, executeMs: performance.now() - started,
          wasmBytes: compiled.artifact.wasm.byteLength, executed });
      }
      const invalid = await compiler.check({ code: 'fn main() { let n: u32 = "wrong"; }' });
      const unresolved = 'unsafe extern "C" { fn missing_elf_experiment_symbol(); } fn main() { unsafe { missing_elf_experiment_symbol(); } }';
      const linkCheck = await compiler.check({ code: unresolved });
      const linkRun = await compiler.compile({ code: unresolved });
      const debug = await compiler.compile({ code: source, targetTriple: 'wasm32-wasip1', debugMode: 'lldb' });
      if (!debug.success || !debug.artifact) throw new Error(JSON.stringify(debug));
      const module = await WebAssembly.compile(debug.artifact.wasm);
      const debugInfoBytes = WebAssembly.Module.customSections(module, '.debug_info').reduce((sum, bytes) => sum + bytes.byteLength, 0);
      return { isolated: crossOriginIsolated, factoryMs, rows, invalid, linkCheck,
        linkRun: { success: linkRun.success, hasArtifact: Boolean(linkRun.artifact) }, debugInfoBytes };
    }, { runtimeProfile: { ...runtimeProfile, moduleUrl: `${server.origin}/dist/index.js` }, source });
    assert.equal(browserResult.isolated, true);
    for (const row of browserResult.rows) {
      assert.equal(row.check.success, true, `${row.targetTriple} check`);
      assert.equal('artifact' in row.check, false);
      assert.equal(row.executed.exitCode, 0);
      assert.equal(row.executed.stdout, 'rust-elf-ok:42:2\n');
    }
    assert.equal(browserResult.invalid.success, false);
    assert.ok(browserResult.invalid.diagnostics.some((item) => item.lineNumber === 1 && item.message === 'mismatched types'));
    assert.equal(browserResult.linkCheck.success, true);
    assert.deepEqual(browserResult.linkRun, { success: false, hasArtifact: false });
    assert.ok(browserResult.debugInfoBytes > 0, 'LLDB compilation retains embedded DWARF');
    const report = {
      schemaVersion: 1, passed: true, variant: variantName, producerManifestSha256: sha256(manifestBytes),
      runtimeManifestSha256: digest, consumerSha256: plan.consumer.sha256,
      engineSha256: plan.consumer.engine.sha256,
      sourceSha256: sha256(source), sourceBytes: Buffer.byteLength(source), browserVersion: browser.version(),
      ...browserResult
    };
    const reportPath = reportOverride || path.join(plan.out, variantName, 'browser-report.json');
    await fs.writeFile(reportPath, json(report), { mode: 0o600 });
    console.log(json({ passed: true, reportPath, sourceSha256: report.sourceSha256,
      rows: report.rows.map(({ targetTriple, checkMs, compileMs, executeMs, wasmBytes }) =>
        ({ targetTriple, checkMs, compileMs, executeMs, wasmBytes })), debugInfoBytes: report.debugInfoBytes }));
    return report;
  } finally {
    await browser?.close();
    await server.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  try {
    const plan = JSON.parse(await fs.readFile(option('--plan'), 'utf8'));
    await probeBrowser({ plan, variantName: option('--variant'), outputOverride: option('--output'),
      manifestOverride: option('--manifest'), reportOverride: option('--report') });
  } catch (error) { console.error(error.stack); process.exitCode = 1; }
}

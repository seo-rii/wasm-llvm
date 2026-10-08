#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare, readJson, readRegular, relativePath, validateFilePin, validateLock, verifyFile, writeJson } from './source.mjs';

const HERE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(HERE), '..');

export async function fixtureLedger(lock, { root = ROOT } = {}) {
  validateLock(lock);
  if (!Array.isArray(lock.fixtures) || !lock.fixtures.length) throw new Error('Source lock must include a fixture corpus');
  const pins = new Map(lock.files.map((file) => [file.path, file]));
  const ids = new Set();
  const cases = [];
  for (const fixture of [...lock.fixtures].sort((a, b) => compare(a.id, b.id))) {
    if (typeof fixture.id !== 'string' || !/^[A-Z0-9-]+$/.test(fixture.id) || ids.has(fixture.id)) {
      throw new Error('Duplicate or invalid fixture ID');
    }
    ids.add(fixture.id);
    const file = relativePath(fixture.file);
    if (!file.startsWith('fixtures/') || !file.endsWith('.kt')) throw new Error('Fixture must be a Kotlin corpus file');
    if (!['upstream-parser', 'product-console'].includes(fixture.origin)) throw new Error('Invalid fixture provenance');
    const pin = fixture.origin === 'upstream-parser' ? pins.get(fixture.upstreamPath) : fixture;
    if (!pin) throw new Error('Fixture upstream source must be locked: ' + fixture.upstreamPath);
    validateFilePin(pin);
    const bytes = await readRegular(path.join(root, file), pin.bytes);
    verifyFile(bytes, { ...pin, path: file });
    cases.push({
      id: fixture.id,
      category: fixture.category,
      origin: fixture.origin,
      input: { path: file, bytes: pin.bytes, sha256: pin.sha256 },
      upstream: fixture.origin === 'upstream-parser' ? { repository: lock.source.repository, commit: lock.source.commit,
        path: fixture.upstreamPath, gitBlob: pin.gitBlob, sha256: pin.sha256 } : null,
      profile: 'kotlin-wasm-wasi-p1-candidate',
      harness: fixture.origin === 'upstream-parser' ? 'parser-and-raw-fir; no console entry is claimed' : 'single-file fun main(); compiler and run harness not built',
      intendedAssertions: fixture.assertions ?? [],
      observedBaseline: null,
      executions: Object.fromEntries([
        ['R0', 'JVM host, upstream existing parser'],
        ['R1', 'JVM host, upstream multiplatform parser explicitly selected'],
        ['R2', 'JVM host, portable compiler source'],
        ['R3', 'browser Wasm host, portable compiler source']
      ].map(([name, configuration]) => [name, { status: 'not-run', configuration, result: null }])),
      exclusion: null
    });
  }
  return { schemaVersion: 1, kind: 'kotlin-browser-baseline-ledger', source: lock.source,
    target: 'wasmWasi / WASI Preview 1 (candidate, not executed)', cases,
    totals: { required: cases.length, passed: 0, failed: 0, notRun: cases.length, skipped: 0, excluded: 0 },
    readiness: { ready: false, baselineExecuted: false, browserCompiler: 'not-built' } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === HERE) {
  try {
    const args = process.argv.slice(2).filter((argument) => argument !== '--');
    if (args.includes('--help')) console.log('Usage: node producer/kotlin-browser/scripts/fixtures.mjs --output FILE');
    else {
      if (args.length !== 2 || args[0] !== '--output' || args[1].startsWith('--')) throw new Error('--output FILE is required');
      const manifest = await readJson(path.join(ROOT, 'manifest.json'));
      const lock = await readJson(path.join(ROOT, 'sources.lock.json'));
      validateLock(lock, manifest);
      const ledger = await fixtureLedger(lock);
      await writeJson(path.resolve(args[1]), ledger);
      console.log(JSON.stringify({ output: path.resolve(args[1]), ...ledger.totals }));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

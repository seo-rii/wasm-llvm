#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { declarations, projectDirectories, stronglyConnectedComponents } from './gradle.mjs';
import { compare, json, readJson, readVerifiedSources, sha256, validateLock, verifyFile, writeJson } from './source.mjs';
import { fixtureLedger } from './fixtures.mjs';
import { verifyPublishedMetadata, verifyToolDeclarations } from './tools.mjs';

const HERE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(HERE), '..');

export function inventory(lock, verifiedFiles) {
  validateLock(lock);
  const pins = new Map(lock.files.map((file) => [file.path, file]));
  for (const pin of lock.files) {
    if (!verifiedFiles.has(pin.path)) throw new Error('Missing verified source file: ' + pin.path);
    verifyFile(verifiedFiles.get(pin.path), pin);
  }
  verifyToolDeclarations(lock, verifiedFiles);
  const settings = projectDirectories(verifiedFiles.get('settings.gradle.kts').toString('utf8'));
  const queue = [...new Set(lock.roots)].sort(compare);
  const modules = new Map();
  const unresolved = settings.unresolved.map((item) => ({ path: 'settings.gradle.kts', ...item }));
  while (queue.length) {
    const id = queue.shift();
    if (modules.has(id)) continue;
    const directory = settings.projects.get(id);
    const candidates = directory ? [directory + '/build.gradle.kts', directory + '/build.gradle'] : [];
    const file = candidates.find((candidate) => verifiedFiles.has(candidate));
    if (!file) {
      modules.set(id, { project: id, directory: directory ?? null, source: null, status: 'blocked', dependencies: [] });
      unresolved.push({ kind: directory ? 'module-build-source-not-locked' : 'project-directory-unresolved', project: id,
        candidates });
      continue;
    }
    const result = declarations(verifiedFiles.get(file).toString('utf8'));
    const dependencies = [...new Set(result.projects.map((dependency) => dependency.project))].sort(compare);
    modules.set(id, { project: id, directory, source: pins.get(file), status: 'source-verified', dependencies,
      declarations: result.projects, ignoredTestDeclarations: result.ignoredTestProjects,
      sourceSets: { declared: result.sourceSets, resolved: null },
      variants: { declaredTargets: result.declaredTargets, selectedWasmVariant: null, resolution: 'not-run' },
      plugins: result.plugins });
    unresolved.push(...result.unresolved.map((item) => ({ project: id, path: file, ...item })));
    for (const plugin of result.plugins) {
      if (!plugin.startsWith('kotlin:')) unresolved.push({ kind: 'convention-plugin-not-evaluated', project: id, plugin, path: file });
    }
    for (const target of dependencies) if (!modules.has(target)) queue.push(target);
    queue.sort(compare);
  }
  const graph = new Map([...modules].map(([id, module]) => [id, module.dependencies]));
  const components = stronglyConnectedComponents(graph);
  const blockers = [
    { id: 'G0-GRADLE', status: 'not-run', reason: 'Gradle configuration, selected variants, conventions, conditional declarations, and external dependency resolution have not been executed.' },
    { id: 'G0-SYMBOLS', status: 'not-run', reason: 'Compiler entry symbol closure and production source/generated-code reachability have not been audited.' },
    { id: 'G0-TOOLS', status: 'not-verified', reason: 'Bootstrap compiler, JDK, generators, and all external artifact bytes have not been acquired and hash-verified as a complete build set.' },
    { id: 'G0-BASELINE', status: 'not-run', reason: 'R0/R1 JVM-hosted compiler baselines and explicit parser selection have not been executed.' }
  ];
  return {
    schemaVersion: 1,
    kind: 'kotlin-browser-source-inventory',
    source: lock.source,
    sourceLockSha256: sha256(Buffer.from(json(lock))),
    scope: 'selected source-verified files and statically declared production project dependencies; not a resolved build graph or compiler symbol closure',
    roots: [...new Set(lock.roots)].sort(compare),
    verifiedFiles: [...lock.files].sort((a, b) => compare(a.path, b.path)),
    modules: [...modules.values()].sort((a, b) => compare(a.project, b.project)),
    components,
    unresolved: unresolved.sort((a, b) => compare(json(a), json(b))),
    toolAndArtifactDeclarations: lock.toolAndArtifactDeclarations ?? [],
    generatedSourceDeclarations: lock.generatedSourceDeclarations ?? [],
    gates: { G0: { status: 'blocked', passed: false, blockers }, G1: 'not-run', G2: 'not-run', G3: 'not-run',
      G4: 'not-run', G5: 'not-run', G6: 'not-run', G7: 'not-run', G8: 'not-run' },
    readiness: { ready: false, browserCompiler: 'not-built', consumerAcceptance: 'not-run' },
    summary: { lockedFiles: lock.files.length, projects: modules.size,
      sourceVerifiedProjects: [...modules.values()].filter((module) => module.status === 'source-verified').length,
      productionProjectEdges: [...modules.values()].reduce((sum, module) => sum + module.dependencies.length, 0),
      ignoredTestDeclarations: [...modules.values()].reduce((sum, module) => sum + (module.ignoredTestDeclarations?.length ?? 0), 0),
      unresolvedDeclarations: unresolved.length,
      cyclicComponents: components.filter((component) => component.length > 1 || graph.get(component[0]).includes(component[0])).length }
  };
}

export async function audit({ output, sourceDir, root = ROOT, fetcher } = {}) {
  if (!output) throw new Error('--output DIR is required');
  const manifest = await readJson(path.join(root, 'manifest.json'));
  const lock = await readJson(path.join(root, 'sources.lock.json'));
  validateLock(lock, manifest);
  const files = await readVerifiedSources(lock, { sourceDir, fetcher });
  const report = inventory(lock, files);
  report.publishedMetadataVerification = sourceDir ? { status: 'not-run',
    reason: 'Checkout mode only verifies the locked upstream source files; published metadata is not fetched.', evidence: [] } :
    { status: 'pass', evidence: await verifyPublishedMetadata(lock, { fetcher }) };
  const fixtures = await fixtureLedger(lock, { root });
  await writeJson(path.join(output, 'dependency-audit.json'), report);
  await writeJson(path.join(output, 'fixture-ledger.json'), fixtures);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === HERE) {
  try {
    const args = process.argv.slice(2).filter((argument) => argument !== '--');
    if (args.includes('--help')) {
      console.log('Usage: node producer/kotlin-browser/scripts/audit.mjs --output DIR [--source-dir PINNED_CHECKOUT]');
    } else {
      const options = {};
      while (args.length) {
        const option = args.shift();
        if (!['--output', '--source-dir'].includes(option) || !args[0] || args[0].startsWith('--')) throw new Error('Invalid audit option: ' + option);
        const key = option === '--output' ? 'output' : 'sourceDir';
        if (options[key]) throw new Error('Duplicate audit option: ' + option);
        options[key] = path.resolve(args.shift());
      }
      const report = await audit(options);
      console.log(JSON.stringify({ status: report.gates.G0.status, ...report.summary, output: options.output }));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

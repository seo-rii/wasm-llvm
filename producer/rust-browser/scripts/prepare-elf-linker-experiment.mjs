import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const producerRoot = fileURLToPath(new URL('..', import.meta.url));
export const bridgePath = 'compiler/rustc_llvm/llvm-wrapper/LLD.cpp';
export const buildRsPath = 'compiler/rustc_llvm/build.rs';
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Expected one pinned input: ${before}`);
  return source.replace(before, after);
}

export function candidateSources(buildRs, bridge) {
  buildRs = replaceOnce(buildRs,
    '    rerun_if_changed_anything_in_dir(Path::new("llvm-wrapper"));',
    '    let browser_wasm_only_lld = target == "wasm32-wasip1-threads";\n' +
    '    if browser_wasm_only_lld {\n' +
    '        cfg.define("RUST_BROWSER_WASM_ONLY_LLD", None);\n' +
    '    }\n\n' +
    '    rerun_if_changed_anything_in_dir(Path::new("llvm-wrapper"));');
  buildRs = replaceOnce(buildRs,
    '    println!("cargo:rustc-link-lib=static=lldELF");',
    '    if !browser_wasm_only_lld {\n' +
    '        println!("cargo:rustc-link-lib=static=lldELF");\n' +
    '    }');
  bridge = replaceOnce(bridge, 'LLD_HAS_DRIVER(elf)',
    '#ifndef RUST_BROWSER_WASM_ONLY_LLD\nLLD_HAS_DRIVER(elf)\n#endif');
  bridge = replaceOnce(bridge,
    '      {{lld::Gnu, &lld::elf::link}, {lld::Wasm, &lld::wasm::link}});',
    '      {\n#ifndef RUST_BROWSER_WASM_ONLY_LLD\n' +
    '          {lld::Gnu, &lld::elf::link},\n#endif\n' +
    '          {lld::Wasm, &lld::wasm::link}});');
  return { [buildRsPath]: buildRs, [bridgePath]: bridge };
}

export function experimentBuildScript(source, candidate) {
  // Bootstrap has its own job count; NINJA_JOBS alone does not constrain x.py.
  let output = replaceOnce(source, './x.py build \\\n', './x.py build -j "$JOBS" \\\n');
  if (candidate) output = replaceOnce(output,
    'local targets=(lldCommon lldELF lldWasm LLVMOption)',
    'local targets=(lldCommon lldWasm LLVMOption)');
  return output;
}

export function commonBuildFingerprint(manifest, buildScript) {
  return sha256(json({
    sources: Object.fromEntries(Object.entries(manifest.sources).filter(([name]) => name !== 'rust')),
    configurations: manifest.configurationFiles.filter((file) => file.path !== 'scripts/build.sh'),
    hostTools: manifest.hostTools, sourceDateEpoch: manifest.sourceDateEpoch,
    bootstrapScript: buildScript.split('build_cross_llvm() {')[0]
  }));
}

export function git(repo, args, options = {}) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options
  }).trimEnd();
}

export async function deriveCandidate({ source, manifest, scratch }) {
  // Write only into a private object database; the retained cache is read-only here.
  await fs.mkdir(scratch);
  git(scratch, ['init', '--bare', '--quiet']);
  const objectDir = git(source, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']);
  await fs.mkdir(path.join(scratch, 'objects', 'info'), { recursive: true });
  await fs.writeFile(path.join(scratch, 'objects', 'info', 'alternates'), `${objectDir}\n`);
  git(scratch, ['read-tree', manifest.patchedTree]);
  const original = Object.fromEntries([buildRsPath, bridgePath].map((name) =>
    [name, `${git(scratch, ['show', `${manifest.patchedTree}:${name}`])}\n`]));
  const changed = candidateSources(original[buildRsPath], original[bridgePath]);
  for (const [name, bytes] of Object.entries(changed)) {
    const object = git(scratch, ['hash-object', '-w', '--stdin'], { input: bytes });
    git(scratch, ['update-index', '--cacheinfo', `100644,${object},${name}`]);
  }
  const tree = git(scratch, ['write-tree']);
  const patch = `${git(scratch, ['diff', '--cached', '--binary', '--full-index', manifest.commit, '--'])}\n`;
  const overlay = `${git(scratch, ['diff', '--cached', '--binary', '--full-index', manifest.patchedTree, '--'])}\n`;
  return {
    tree, patch, overlay,
    before: Object.fromEntries(Object.entries(original).map(([name, bytes]) => [name, sha256(bytes)])),
    after: Object.fromEntries(Object.entries(changed).map(([name, bytes]) => [name, sha256(bytes)]))
  };
}

export async function inventory(root, current = root) {
  const rows = [];
  for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) rows.push(...await inventory(root, absolute));
    else if (entry.isFile()) {
      const bytes = await fs.readFile(absolute);
      rows.push({ path: path.relative(root, absolute), bytes: bytes.length, sha256: sha256(bytes) });
    } else throw new Error(`Unexpected non-regular snapshot input: ${absolute}`);
  }
  return rows;
}

async function snapshotConsumer(source, destination) {
  await fs.mkdir(destination);
  for (const name of ['package.json', 'scripts', 'producer-lock.json']) {
    await fs.cp(path.join(source, name), path.join(destination, name), { recursive: true });
  }
  await fs.mkdir(path.join(destination, 'dist'));
  for (const entry of await fs.readdir(path.join(source, 'dist'), { withFileTypes: true })) {
    if (entry.isFile() && /\.(?:js|ts|map)$/.test(entry.name)) {
      await fs.copyFile(path.join(source, 'dist', entry.name), path.join(destination, 'dist', entry.name));
    }
  }
  await fs.cp(path.join(source, 'dist/vendor'), path.join(destination, 'dist/vendor'), { recursive: true, dereference: true });
  await fs.access(path.join(destination, 'dist', 'index.js'));
  await fs.copyFile(path.join(source, 'pnpm-lock.yaml'), path.join(destination, 'pnpm-lock.yaml'));
  await fs.copyFile(path.join(source, 'dist/runtime/runtime-manifest.v3.json'), path.join(destination, 'runtime-template.json'));
  // Browser vendor bytes are already prepared and pinned; do not regenerate them from moving deps.
  // Playwright is self-contained. A private copy avoids a shared node_modules dependency between arms.
  await fs.cp(await fs.realpath(path.join(source, 'node_modules/playwright-core')),
    path.join(destination, 'node_modules/playwright-core'), { recursive: true, dereference: true });
  const { resolveChromiumExecutable } = await import(pathToFileURL(path.join(destination, 'scripts/browser-harness-runtime.mjs')).href);
  const executable = await fs.realpath(await resolveChromiumExecutable());
  const engineFiles = await inventory(path.dirname(executable));
  const files = await inventory(destination);
  return { source: await fs.realpath(source), sha256: sha256(json(files)), files,
    engine: { executable, root: path.dirname(executable), sha256: sha256(json(engineFiles)), files: engineFiles } };
}

export async function prepareExperiment({ sources, out, consumer, jobs = 1 }) {
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 2) throw new Error('jobs must be 1 or 2');
  sources = await fs.realpath(sources);
  out = path.resolve(out);
  if (out.startsWith(`${sources}${path.sep}`) || out.startsWith(`${producerRoot}${path.sep}`)) {
    throw new Error('Experiment output must be outside producer and source inputs');
  }
  const manifest = JSON.parse(await fs.readFile(path.join(producerRoot, 'manifest.json'), 'utf8'));
  // Do not start downloads or builds as part of preparation.
  execFileSync(process.execPath, [path.join(producerRoot, 'scripts/producer.mjs'), 'verify'], { stdio: 'pipe' });
  for (const [name, input] of Object.entries(manifest.sources)) {
    const root = path.join(sources, name);
    if (git(root, ['status', '--porcelain']) || git(root, ['rev-parse', 'HEAD']) !== input.commit ||
        git(root, ['rev-parse', 'HEAD^{tree}']) !== input.tree) throw new Error(`Source cache differs: ${name}`);
  }
  await fs.mkdir(out, { mode: 0o700 }); // Refuse an existing directory.
  const work = path.join(out, 'work');
  await fs.mkdir(path.join(work, 'sources'), { recursive: true });
  for (const name of Object.keys(manifest.sources)) {
    // New patched worktrees are registered in each source Git database. Existing files stay intact.
    await fs.symlink(path.join(sources, name), path.join(work, 'sources', name));
  }
  const derived = await deriveCandidate({ source: path.join(sources, 'rust'), manifest: manifest.sources.rust,
    scratch: path.join(out, 'candidate-objects.git') });
  await fs.writeFile(path.join(out, 'candidate-overlay.patch'), derived.overlay);
  const variants = {};
  for (const name of ['baseline', 'candidate']) {
    const root = path.join(out, name, 'producer');
    await fs.mkdir(path.dirname(root));
    await fs.cp(producerRoot, root, { recursive: true });
    const current = structuredClone(manifest);
    const build = experimentBuildScript(await fs.readFile(path.join(root, 'scripts/build.sh'), 'utf8'), name === 'candidate');
    await fs.writeFile(path.join(root, 'scripts/build.sh'), build);
    current.configurationFiles.find((file) => file.path === 'scripts/build.sh').sha256 = sha256(build);
    if (name === 'candidate') {
      await fs.writeFile(path.join(root, current.sources.rust.patch), derived.patch);
      current.sources.rust.patchSha256 = sha256(derived.patch);
      current.sources.rust.patchedTree = derived.tree;
    }
    const manifestBytes = json(current);
    await fs.writeFile(path.join(root, 'manifest.json'), manifestBytes);
    execFileSync(process.execPath, [path.join(root, 'scripts/producer.mjs'), 'verify'], { stdio: 'pipe' });
    variants[name] = { root, out: path.join(out, name, 'output'), manifestSha256: sha256(manifestBytes),
      sourceTree: current.sources.rust.patchedTree, commonFingerprint: commonBuildFingerprint(current, build) };
  }
  if (variants.baseline.commonFingerprint !== variants.candidate.commonFingerprint) throw new Error('Common bootstrap inputs differ');
  const consumerSnapshot = await snapshotConsumer(path.resolve(consumer), path.join(out, 'consumer'));
  const runnerRoot = path.join(out, 'runner');
  await fs.mkdir(runnerRoot);
  for (const name of ['prepare-elf-linker-experiment.mjs', 'run-elf-linker-experiment.mjs', 'probe-elf-linker-browser.mjs']) {
    await fs.copyFile(path.join(producerRoot, 'scripts', name), path.join(runnerRoot, name));
  }
  const runnerFiles = await inventory(runnerRoot);
  const plan = {
    schemaVersion: 1, kind: 'rust-browser-elf-linker-experiment', out, work, jobs,
    sourceCache: sources, originalManifestSha256: sha256(await fs.readFile(path.join(producerRoot, 'manifest.json'))),
    node: process.execPath, variants, consumer: consumerSnapshot,
    runner: { root: runnerRoot, script: path.join(runnerRoot, 'run-elf-linker-experiment.mjs'), sha256: sha256(json(runnerFiles)) },
    overlaySha256: sha256(derived.overlay), sourceFiles: { before: derived.before, after: derived.after },
    gates: { initialDiskGiB: 60, phaseDiskGiB: 12, availableMemoryGiB: 12, emergencyDiskGiB: 4 },
    browserLock: '/tmp/wasm-perf-browser-20261023.lock',
    promotion: 'experiment-only-no-publish'
  };
  await fs.writeFile(path.join(out, 'plan.json'), json(plan), { mode: 0o600 });
  return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  try {
    const plan = await prepareExperiment({ sources: option('--sources'), out: option('--out'),
      consumer: option('--consumer'), jobs: Number(option('--jobs', 1)) });
    console.log(json({ plan: path.join(plan.out, 'plan.json'), variants: plan.variants, gates: plan.gates }));
  } catch (error) { console.error(error.stack); process.exitCode = 1; }
}

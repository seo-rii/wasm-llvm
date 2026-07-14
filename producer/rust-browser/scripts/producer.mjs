#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const producerRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(producerRoot, "..", "..");
const args = process.argv.slice(2);
const command = args.shift() || "verify";

function option(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (!args[index + 1]) throw new Error(`${name} requires a value`);
  return args[index + 1];
}

const manifestPath = path.resolve(
  option("--manifest", path.join(producerRoot, "manifest.json")),
);

const workDir = path.resolve(
  option(
    "--work-dir",
    process.env.WASM_LLVM_RUST_BROWSER_WORK_DIR ||
      path.join(repoRoot, "artifacts", "rust-browser-producer"),
  ),
);
const outDir = path.resolve(
  option(
    "--out-dir",
    process.env.WASM_LLVM_RUST_BROWSER_OUT_DIR || path.join(workDir, "output"),
  ),
);

function run(program, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, commandArgs, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (options.capture) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
    }
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new Error(
            `${program} ${commandArgs.join(" ")} failed with code ${code}${stderr ? `\n${stderr}` : ""}`,
          ),
        );
    });
  });
}

async function sha256(file) {
  const hash = createHash("sha256");
  hash.update(await fs.readFile(file));
  return hash.digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readManifest() {
  return JSON.parse(await fs.readFile(manifestPath, "utf8"));
}

async function verifyManifest(manifest) {
  if (manifest.schemaVersion !== 1)
    throw new Error(`Unsupported manifest schema ${manifest.schemaVersion}`);
  if (!/^[0-9a-f]{40}$/.test(manifest.upstreamPatchOrigin.commit)) {
    throw new Error("upstreamPatchOrigin.commit must be a full Git commit");
  }
  if (
    manifest.environment?.platform !== "linux/amd64" ||
    !/@sha256:[0-9a-f]{64}$/.test(manifest.environment?.baseImage || "") ||
    !/^[0-9]{8}T[0-9]{6}Z$/.test(manifest.environment?.debianSnapshot || "")
  ) {
    throw new Error(
      "environment must pin the linux/amd64 image digest and Debian snapshot",
    );
  }
  for (const tool of ["cmake", "node"]) {
    if (!/^[0-9a-f]{64}$/.test(manifest.environment?.[tool]?.sha256 || "")) {
      throw new Error(`environment.${tool}.sha256 is invalid`);
    }
  }

  for (const [name, source] of Object.entries(manifest.sources)) {
    for (const field of ["repository", "commit", "tree", "patchedTree"]) {
      if (!source[field])
        throw new Error(`sources.${name}.${field} is required`);
    }
    if (
      !/^[0-9a-f]{40}$/.test(source.commit) ||
      !/^[0-9a-f]{40}$/.test(source.tree) ||
      !/^[0-9a-f]{40}$/.test(source.patchedTree)
    ) {
      throw new Error(`sources.${name} must use full commit and tree hashes`);
    }
    if (source.patch) {
      const patchPath = path.join(producerRoot, source.patch);
      const actual = await sha256(patchPath);
      if (actual !== source.patchSha256) {
        throw new Error(
          `${source.patch} hash mismatch: expected ${source.patchSha256}, got ${actual}`,
        );
      }
      const patch = await fs.readFile(patchPath, "utf8");
      if (!patch.startsWith("diff --git "))
        throw new Error(`${source.patch} is not a Git patch`);
      for (const requiredPath of source.requiredNewFiles || []) {
        if (
          typeof requiredPath !== "string" ||
          !requiredPath ||
          path.posix.isAbsolute(requiredPath) ||
          requiredPath.split("/").includes("..")
        ) {
          throw new Error(
            `sources.${name}.requiredNewFiles contains an invalid path`,
          );
        }
        const header = `diff --git a/${requiredPath} b/${requiredPath}\n`;
        const sectionStart = patch.indexOf(header);
        const sectionEnd = patch.indexOf("\ndiff --git ", sectionStart + 1);
        const section = patch.slice(
          sectionStart,
          sectionEnd === -1 ? undefined : sectionEnd,
        );
        if (sectionStart === -1 || !section.includes("\nnew file mode ")) {
          throw new Error(
            `${source.patch} does not create required file ${requiredPath}`,
          );
        }
      }
    }
    for (const submodule of source.submodules || []) {
      if (
        typeof submodule.path !== "string" ||
        path.posix.isAbsolute(submodule.path) ||
        submodule.path.split("/").includes("..") ||
        !submodule.repository ||
        !/^[0-9a-f]{40}$/.test(submodule.commit) ||
        !/^[0-9a-f]{40}$/.test(submodule.tree)
      ) {
        throw new Error(
          `sources.${name}.submodules contains an invalid pinned submodule`,
        );
      }
    }
  }

  for (const [name, download] of Object.entries(manifest.downloads)) {
    if (!/^https:\/\//.test(download.url))
      throw new Error(`downloads.${name}.url must use HTTPS`);
    if (!/^[0-9a-f]{64}$/.test(download.sha256))
      throw new Error(`downloads.${name}.sha256 is invalid`);
    if (!Number.isSafeInteger(download.size) || download.size <= 0)
      throw new Error(`downloads.${name}.size is invalid`);
    if (!download.archiveOnly) {
      if (
        typeof download.archiveEntry !== "string" ||
        !download.archiveEntry ||
        path.posix.isAbsolute(download.archiveEntry) ||
        download.archiveEntry.split("/").includes("..")
      ) {
        throw new Error(`downloads.${name}.archiveEntry is invalid`);
      }
      if (!/^[0-9a-f]{64}$/.test(download.entrySha256)) {
        throw new Error(`downloads.${name}.entrySha256 is invalid`);
      }
      if (!Number.isSafeInteger(download.entrySize) || download.entrySize <= 0) {
        throw new Error(`downloads.${name}.entrySize is invalid`);
      }
    }
  }

  for (const input of manifest.configurationFiles || []) {
    const inputPath = path.join(producerRoot, input.path);
    const actual = await sha256(inputPath);
    if (actual !== input.sha256) {
      throw new Error(
        `${input.path} hash mismatch: expected ${input.sha256}, got ${actual}`,
      );
    }
  }

  return manifest;
}

async function captured(program, commandArgs, cwd, env) {
  return (
    await run(program, commandArgs, { cwd, env, capture: true })
  ).stdout.trim();
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function computeWorktreeTree(name, sourceDir) {
  const indexDir = path.join(workDir, "verification-indexes");
  const indexPath = path.join(indexDir, `${name}-${process.pid}`);
  await fs.mkdir(indexDir, { recursive: true });
  await fs.rm(indexPath, { force: true });
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    await run("git", ["read-tree", "HEAD"], {
      cwd: sourceDir,
      env,
      capture: true,
    });
    await run("git", ["add", "--all"], { cwd: sourceDir, env, capture: true });
    return await captured("git", ["write-tree"], sourceDir, env);
  } finally {
    await fs.rm(indexPath, { force: true });
  }
}

async function ensureSubmodule(parentName, parentDir, submodule) {
  const configuredPaths = await captured(
    "git",
    [
      "config",
      "--file",
      ".gitmodules",
      "--get-regexp",
      "^submodule\\..*\\.path$",
    ],
    parentDir,
  );
  const matchingEntry = configuredPaths
    .split(/\r?\n/)
    .map((line) => line.match(/^(submodule\.(.+)\.path)\s+(.+)$/))
    .find((match) => match?.[3] === submodule.path);
  if (!matchingEntry) {
    throw new Error(
      `${parentName} does not declare submodule path ${submodule.path}`,
    );
  }
  const configuredRepository = await captured(
    "git",
    [
      "config",
      "--file",
      ".gitmodules",
      "--get",
      `submodule.${matchingEntry[2]}.url`,
    ],
    parentDir,
  );
  if (configuredRepository !== submodule.repository) {
    throw new Error(
      `${parentName} submodule repository mismatch for ${submodule.path}: expected ${submodule.repository}, got ${configuredRepository}`,
    );
  }
  const gitlink = await captured(
    "git",
    ["ls-tree", "HEAD", "--", submodule.path],
    parentDir,
  );
  if (!gitlink.startsWith(`160000 commit ${submodule.commit}\t`)) {
    throw new Error(
      `${parentName} submodule gitlink mismatch for ${submodule.path}`,
    );
  }

  const submoduleDir = path.join(parentDir, ...submodule.path.split("/"));
  if (!(await exists(path.join(submoduleDir, ".git")))) {
    await run(
      "git",
      ["submodule", "update", "--init", "--depth=1", "--", submodule.path],
      { cwd: parentDir },
    );
  }
  const status = await captured("git", ["status", "--porcelain"], submoduleDir);
  const commit = await captured("git", ["rev-parse", "HEAD"], submoduleDir);
  const tree = await captured(
    "git",
    ["rev-parse", "HEAD^{tree}"],
    submoduleDir,
  );
  if (status || commit !== submodule.commit || tree !== submodule.tree) {
    throw new Error(
      `${parentName} submodule mismatch for ${submodule.path}: expected ${submodule.commit}/${submodule.tree}, got ${commit}/${tree}`,
    );
  }
  return {
    path: submodule.path,
    repository: configuredRepository,
    commit,
    tree,
  };
}

async function ensureSource(name, source) {
  const sourceDir = path.join(workDir, "sources", name);
  if (!(await exists(path.join(sourceDir, ".git")))) {
    if (await exists(sourceDir))
      throw new Error(
        `Refusing to replace non-Git source directory ${sourceDir}`,
      );
    await fs.mkdir(path.dirname(sourceDir), { recursive: true });
    await run("git", ["init", "--initial-branch=main", sourceDir]);
    await run("git", [
      "-C",
      sourceDir,
      "remote",
      "add",
      "origin",
      source.repository,
    ]);
    await run("git", [
      "-C",
      sourceDir,
      "fetch",
      "--depth=1",
      "--filter=blob:none",
      "origin",
      source.commit,
    ]);
    await run("git", ["-C", sourceDir, "checkout", "--detach", source.commit]);
  }

  const status = await captured("git", ["status", "--porcelain"], sourceDir);
  if (status)
    throw new Error(`Immutable source checkout is dirty: ${sourceDir}`);
  const commit = await captured("git", ["rev-parse", "HEAD"], sourceDir);
  const tree = await captured("git", ["rev-parse", "HEAD^{tree}"], sourceDir);
  if (commit !== source.commit || tree !== source.tree) {
    throw new Error(
      `${name} checkout mismatch: expected ${source.commit}/${source.tree}, got ${commit}/${tree}`,
    );
  }

  const patchedDir = path.join(workDir, "patched", name);
  if (!(await exists(path.join(patchedDir, ".git")))) {
    if (await exists(patchedDir))
      throw new Error(`Refusing to replace non-worktree path ${patchedDir}`);
    await fs.mkdir(path.dirname(patchedDir), { recursive: true });
    await run("git", [
      "-C",
      sourceDir,
      "worktree",
      "add",
      "--detach",
      patchedDir,
      source.commit,
    ]);
    if (source.patch) {
      const patchPath = path.join(producerRoot, source.patch);
      await run("git", ["-C", patchedDir, "apply", "--check", patchPath]);
      await run("git", [
        "-C",
        patchedDir,
        "apply",
        "--whitespace=error-all",
        patchPath,
      ]);
    }
  }

  const patchedCommit = await captured(
    "git",
    ["rev-parse", "HEAD"],
    patchedDir,
  );
  if (patchedCommit !== source.commit)
    throw new Error(`Patched ${name} worktree has the wrong base commit`);
  if (source.patch) {
    const patchPath = path.join(producerRoot, source.patch);
    const patchedStatus = await captured(
      "git",
      ["status", "--porcelain"],
      patchedDir,
    );
    if (!patchedStatus) {
      await run("git", ["-C", patchedDir, "apply", "--check", patchPath]);
      await run("git", [
        "-C",
        patchedDir,
        "apply",
        "--whitespace=error-all",
        patchPath,
      ]);
    }
    await run("git", [
      "-C",
      patchedDir,
      "apply",
      "--reverse",
      "--check",
      patchPath,
    ]);
  } else {
    const patchedStatus = await captured(
      "git",
      ["status", "--porcelain"],
      patchedDir,
    );
    if (patchedStatus) throw new Error(`Unpatched ${name} worktree is dirty`);
  }
  const ignoredFiles = await captured(
    "git",
    ["ls-files", "--others", "--ignored", "--exclude-standard"],
    patchedDir,
  );
  if (ignoredFiles)
    throw new Error(
      `Patched ${name} worktree contains ignored files:\n${ignoredFiles}`,
    );
  const patchedTree = await computeWorktreeTree(name, patchedDir);
  if (patchedTree !== source.patchedTree) {
    throw new Error(
      `${name} patched tree mismatch: expected ${source.patchedTree}, got ${patchedTree}`,
    );
  }
  const submodules = [];
  for (const submodule of source.submodules || []) {
    submodules.push(await ensureSubmodule(name, patchedDir, submodule));
  }

  return {
    name,
    repository: source.repository,
    commit,
    tree,
    patchedTree,
    sourceDir,
    patchedDir,
    patchSha256: source.patchSha256 || null,
    submodules,
  };
}

async function ensureDownload(name, download) {
  const archive = path.join(
    workDir,
    "downloads",
    path.basename(new URL(download.url).pathname),
  );
  await fs.mkdir(path.dirname(archive), { recursive: true });
  if (!(await exists(archive)))
    await run("curl", ["-fL", "--retry", "3", download.url, "-o", archive]);
  const stat = await fs.stat(archive);
  const actual = await sha256(archive);
  if (stat.size !== download.size || actual !== download.sha256) {
    throw new Error(
      `${name} download mismatch: expected ${download.size}/${download.sha256}, got ${stat.size}/${actual}`,
    );
  }

  if (download.archiveOnly) {
    return {
      name,
      archive,
      sha256: actual,
      size: stat.size,
    };
  }

  const destination = path.join(workDir, "downloads", name);
  const entryPath = path.join(destination, download.archiveEntry);
  if (!(await exists(entryPath))) {
    await fs.mkdir(destination, { recursive: true });
    await run("tar", ["-xzf", archive, "-C", destination]);
  }
  const entryStat = await fs.stat(entryPath);
  const entrySha256 = await sha256(entryPath);
  if (
    !entryStat.isFile() ||
    entryStat.size !== download.entrySize ||
    entrySha256 !== download.entrySha256
  ) {
    throw new Error(
      `${name} extracted entry mismatch: expected ${download.entrySize}/${download.entrySha256}, got ${entryStat.size}/${entrySha256}`,
    );
  }
  return {
    name,
    archive,
    sha256: actual,
    size: stat.size,
    entryPath,
    entrySha256,
    entrySize: entryStat.size,
  };
}

async function verifyHostTools(manifest) {
  const tools = [];
  for (const expected of manifest.hostTools || []) {
    const result = await run(expected.command, expected.args || [], {
      capture: true,
    });
    const firstLine = `${result.stdout}${result.stderr}`
      .trim()
      .split(/\r?\n/, 1)[0];
    if (firstLine !== expected.firstLine) {
      throw new Error(
        `${expected.command} version mismatch: expected "${expected.firstLine}", got "${firstLine}"`,
      );
    }
    tools.push({
      command: expected.command,
      args: expected.args || [],
      firstLine,
    });
  }
  return tools;
}

async function renderConfigurations() {
  const buildRoot = path.join(workDir, "build");
  const wrappers = path.join(buildRoot, "wrappers");
  await fs.mkdir(wrappers, { recursive: true });
  const files = [
    [
      "config/rust-config.toml.in",
      path.join(buildRoot, "rust-config.toml"),
      false,
    ],
    ["config/wasi-clang++.sh.in", path.join(wrappers, "wasi-clang++.sh"), true],
    ["config/wasi-ld.sh.in", path.join(wrappers, "wasi-ld.sh"), true],
    [
      "config/wasm-llvm-config.sh.in",
      path.join(wrappers, "wasm-llvm-config.sh"),
      true,
    ],
  ];
  const rendered = [];
  for (const [template, destination, executable] of files) {
    const contents = (
      await fs.readFile(path.join(producerRoot, template), "utf8")
    ).replaceAll("@BUILD_ROOT@", buildRoot);
    await fs.writeFile(destination, contents, {
      mode: executable ? 0o755 : 0o644,
    });
    if (executable) await fs.chmod(destination, 0o755);
    rendered.push({ template, destination, sha256: sha256Text(contents) });
  }
  return rendered;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(stable(value), null, 2)}\n`);
}

async function prepare(manifest) {
  const hostTools = await verifyHostTools(manifest);
  const sources = [];
  for (const [name, source] of Object.entries(manifest.sources))
    sources.push(await ensureSource(name, source));
  const downloads = [];
  for (const [name, download] of Object.entries(manifest.downloads))
    downloads.push(await ensureDownload(name, download));
  const configurations = await renderConfigurations();
  const receipt = {
    schemaVersion: 1,
    producerId: manifest.producerId,
    manifestSha256: await sha256(manifestPath),
    sourceDateEpoch: manifest.sourceDateEpoch,
    runner: process.env.WASM_LLVM_RUST_BROWSER_RUNNER || "host",
    hostTools,
    sources,
    downloads,
    configurations,
  };
  await writeJson(path.join(workDir, "prepare-receipt.json"), receipt);
  console.log(`Prepared pinned sources in ${workDir}`);
}

async function listFiles(root, current = root) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const entryPath = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, entryPath)));
    else if (entry.isFile())
      files.push(path.relative(root, entryPath).split(path.sep).join("/"));
    else
      throw new Error(
        `Producer output must contain only regular files and directories: ${entryPath}`,
      );
  }
  return files;
}

async function attest(manifest) {
  const prepareReceipt = path.join(workDir, "prepare-receipt.json");
  if (!(await exists(prepareReceipt)))
    throw new Error(`Missing prepare receipt: ${prepareReceipt}`);
  const prepared = JSON.parse(await fs.readFile(prepareReceipt, "utf8"));
  const manifestSha256 = await sha256(manifestPath);
  if (
    prepared.schemaVersion !== 1 ||
    prepared.producerId !== manifest.producerId ||
    prepared.manifestSha256 !== manifestSha256 ||
    prepared.sourceDateEpoch !== manifest.sourceDateEpoch
  ) {
    throw new Error(
      "Prepare receipt does not match the current producer manifest",
    );
  }
  const hostTools = await verifyHostTools(manifest);
  if (
    JSON.stringify(stable(prepared.hostTools)) !==
    JSON.stringify(stable(hostTools))
  ) {
    throw new Error(
      "Prepare receipt host tools do not match the current producer manifest",
    );
  }
  const sources = [];
  for (const [name, source] of Object.entries(manifest.sources)) {
    sources.push(await ensureSource(name, source));
  }
  const preparedSources = Object.fromEntries(
    (prepared.sources || []).map((source) => [source.name, source]),
  );
  for (const source of sources) {
    const actual = preparedSources[source.name];
    if (
      !actual ||
      actual.commit !== source.commit ||
      actual.tree !== source.tree ||
      actual.patchedTree !== source.patchedTree ||
      actual.patchSha256 !== source.patchSha256
    ) {
      throw new Error(`Prepare receipt source mismatch: ${source.name}`);
    }
    if (
      JSON.stringify(stable(actual.submodules || [])) !==
      JSON.stringify(stable(source.submodules))
    ) {
      throw new Error(`Prepare receipt submodule mismatch: ${source.name}`);
    }
  }
  const downloads = [];
  for (const [name, download] of Object.entries(manifest.downloads)) {
    downloads.push(await ensureDownload(name, download));
  }
  if (
    JSON.stringify(stable(prepared.downloads)) !==
    JSON.stringify(stable(downloads))
  ) {
    throw new Error(
      "Prepare receipt downloads do not match the verified producer inputs",
    );
  }
  const configurations = await renderConfigurations();
  if (
    JSON.stringify(stable(prepared.configurations)) !==
    JSON.stringify(stable(configurations))
  ) {
    throw new Error(
      "Prepare receipt configurations do not match the rendered build inputs",
    );
  }
  for (const required of manifest.outputs.filter(
    (item) => item !== "producer-receipt.json",
  )) {
    const requiredPath = path.join(outDir, required);
    if (!(await exists(requiredPath)))
      throw new Error(`Missing required producer output: ${required}`);
    const stat = await fs.stat(requiredPath);
    if (stat.isDirectory() && (await listFiles(requiredPath)).length === 0) {
      throw new Error(
        `Required producer output directory is empty: ${required}`,
      );
    }
  }
  const assets = [];
  for (const relative of await listFiles(outDir)) {
    if (relative === "producer-receipt.json") continue;
    const file = path.join(outDir, relative);
    assets.push({
      path: relative,
      size: (await fs.stat(file)).size,
      sha256: await sha256(file),
    });
  }
  const receipt = {
    schemaVersion: 1,
    producerId: manifest.producerId,
    manifestSha256,
    sourceDateEpoch: manifest.sourceDateEpoch,
    environment: manifest.environment,
    runner: prepared.runner,
    hostTools: manifest.hostTools,
    sources: Object.fromEntries(
      Object.entries(manifest.sources).map(([name, source]) => [
        name,
        {
          commit: source.commit,
          tree: source.tree,
          patchedTree: source.patchedTree,
          patchSha256: source.patchSha256 || null,
          submodules: source.submodules || [],
        },
      ]),
    ),
    assets,
  };
  await writeJson(path.join(outDir, "producer-receipt.json"), receipt);
  console.log(`Wrote ${path.join(outDir, "producer-receipt.json")}`);
}

async function verifyOutput(manifest) {
  const receiptPath = path.join(outDir, "producer-receipt.json");
  const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  if (
    receipt.schemaVersion !== 1 ||
    receipt.producerId !== manifest.producerId ||
    receipt.manifestSha256 !== (await sha256(manifestPath)) ||
    receipt.sourceDateEpoch !== manifest.sourceDateEpoch
  ) {
    throw new Error("Output receipt was produced by a different manifest");
  }
  if (
    (receipt.runner !== "host" && receipt.runner !== "container") ||
    JSON.stringify(stable(receipt.environment)) !==
      JSON.stringify(stable(manifest.environment))
  ) {
    throw new Error(
      "Output receipt build environment does not match the producer manifest",
    );
  }
  if (
    JSON.stringify(stable(receipt.hostTools)) !==
    JSON.stringify(stable(manifest.hostTools))
  ) {
    throw new Error(
      "Output receipt host tools do not match the producer manifest",
    );
  }
  const expectedSources = Object.fromEntries(
    Object.entries(manifest.sources).map(([name, source]) => [
      name,
      {
        commit: source.commit,
        tree: source.tree,
        patchedTree: source.patchedTree,
        patchSha256: source.patchSha256 || null,
        submodules: source.submodules || [],
      },
    ]),
  );
  if (
    JSON.stringify(stable(receipt.sources)) !==
    JSON.stringify(stable(expectedSources))
  ) {
    throw new Error(
      "Output receipt sources do not match the producer manifest",
    );
  }
  const receiptPaths = [];
  const seenPaths = new Set();
  for (const asset of receipt.assets) {
    if (
      typeof asset.path !== "string" ||
      path.posix.isAbsolute(asset.path) ||
      asset.path.split("/").includes("..") ||
      seenPaths.has(asset.path)
    ) {
      throw new Error(
        `Invalid output receipt asset path: ${String(asset.path)}`,
      );
    }
    seenPaths.add(asset.path);
    receiptPaths.push(asset.path);
    const file = path.join(outDir, asset.path);
    const stat = await fs.stat(file);
    const actual = await sha256(file);
    if (stat.size !== asset.size || actual !== asset.sha256)
      throw new Error(`Output asset mismatch: ${asset.path}`);
  }
  const actualPaths = (await listFiles(outDir)).filter(
    (file) => file !== "producer-receipt.json",
  );
  if (JSON.stringify(receiptPaths) !== JSON.stringify(actualPaths)) {
    throw new Error(
      "Output receipt asset list does not exactly match the output directory",
    );
  }
  for (const required of manifest.outputs) {
    if (!(await exists(path.join(outDir, required))))
      throw new Error(`Missing required producer output: ${required}`);
  }
  console.log(`Verified ${receipt.assets.length} producer assets in ${outDir}`);
}

const manifest = await verifyManifest(await readManifest());
if (command === "verify") {
  console.log(`Verified ${manifest.producerId} manifest and pinned inputs`);
} else if (command === "prepare") {
  await prepare(manifest);
} else if (command === "attest") {
  await attest(manifest);
} else if (command === "verify-output") {
  await verifyOutput(manifest);
} else {
  throw new Error(
    `Unknown command ${command}; expected verify, prepare, attest, or verify-output`,
  );
}

#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { REQUIRED_ASSETS } from "./contracts.mjs";
import { verifyArtifactDirectory } from "./verify.mjs";

export function assertReproducibleBuilds(first, second) {
  const { assets: firstAssets, ...firstReceipt } = first.receipt;
  const { assets: secondAssets, ...secondReceipt } = second.receipt;
  if (!isDeepStrictEqual(firstReceipt, secondReceipt)) {
    throw new Error("LLDB browser build receipt provenance differs");
  }
  for (const asset of REQUIRED_ASSETS) {
    if (!isDeepStrictEqual(firstAssets?.[asset], secondAssets?.[asset])) {
      throw new Error(`${asset} metadata differs between clean builds`);
    }
  }
  if (!isDeepStrictEqual(first.artifactManifest, second.artifactManifest)) {
    throw new Error(
      "LLDB browser debug manifests differ between clean builds",
    );
  }
}

export async function verifyReproducibleArtifactDirectories(
  firstDirectory,
  secondDirectory,
) {
  const firstPath = path.resolve(firstDirectory);
  const secondPath = path.resolve(secondDirectory);
  if (firstPath === secondPath) {
    throw new Error("reproducibility comparison requires two directories");
  }
  const [first, second] = await Promise.all([
    verifyArtifactDirectory(firstPath),
    verifyArtifactDirectory(secondPath),
  ]);
  assertReproducibleBuilds(first, second);
  return first;
}

async function main() {
  const argumentsList = process.argv
    .slice(2)
    .filter((argument) => argument !== "--");
  if (argumentsList.includes("--help") || argumentsList.includes("-h")) {
    console.log(
      "Usage: node producer/lldb-browser/scripts/verify-reproducibility.mjs FIRST_ARTIFACT_DIR SECOND_ARTIFACT_DIR",
    );
    return;
  }
  if (argumentsList.length !== 2) {
    throw new Error(
      "verify-reproducibility.mjs requires two artifact directories",
    );
  }
  const result = await verifyReproducibleArtifactDirectories(
    argumentsList[0],
    argumentsList[1],
  );
  const hashes = Object.fromEntries(
    REQUIRED_ASSETS.map((asset) => [
      asset,
      result.receipt.assets[asset].sha256,
    ]),
  );
  console.log(
    `Verified reproducible LLDB browser artifacts: ${JSON.stringify(hashes)}`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

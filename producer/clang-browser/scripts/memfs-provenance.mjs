import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from "@zip.js/zip.js";

const producer = JSON.parse(
  await fs.readFile(new URL("../manifest.json", import.meta.url), "utf8"),
);
const digest = (bytes) => ({
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});
const receiptName = "memfs-build-receipt.json";
// Notices from the pinned 2019 LLVM source and the MIT section of stb_sprintf.h.
// These pins leave the original build receipt and builder unchanged.
const licenses = {
  "LICENSE.memfs-llvm.txt": {
    source: "LICENSE.llvm.txt",
    bytes: 3192,
    sha256: "24b67da19b1422a819395738cb83ea34eee3fdce52870b0d1758524ba1615069",
  },
  "LICENSE.memfs-stb_sprintf.txt": {
    source: "LICENSE.stb_sprintf.txt",
    bytes: 1133,
    sha256: "88420bf461670fb7b9d6c3d3dd4a50f9a653361ee1e0eafc079ba715b1944e72",
  },
};
const fileNames = [receiptName, ...Object.keys(licenses)];

function verifyBytes(bytes, expected, label) {
  const actual = digest(bytes);
  if (actual.bytes !== expected?.bytes || actual.sha256 !== expected?.sha256) {
    throw new Error(`MemFS ${label} SHA-256/size mismatch`);
  }
}

function verifyReceipt(receipt, wasmBytes) {
  const source = producer.sources.memfs;
  if (
    receipt?.format !== "wasm-llvm-memfs-build-v1" ||
    receipt.maxNodes !== source.maxNodes ||
    receipt.abi?.maxNodes !== source.maxNodes ||
    receipt.abi?.usableNodes !== source.maxNodes - 4 ||
    receipt.source?.repository !== source.repository ||
    receipt.source?.commit !== source.commit ||
    receipt.patch?.originalSha256 !== source.files["memfs.c"].sha256 ||
    !isDeepStrictEqual(receipt.license, source.license)
  ) {
    throw new Error(
      "MemFS build receipt does not match the pinned source/capacity contract",
    );
  }
  for (const [name, pin] of Object.entries(source.files)) {
    const actual = receipt.source.files?.[name];
    if (actual?.bytes !== pin.bytes || actual?.sha256 !== pin.sha256) {
      throw new Error(
        `MemFS build receipt has an invalid source pin for ${name}`,
      );
    }
  }
  for (const key of ["patchedSha256", "builderSha256"]) {
    if (!/^[a-f0-9]{64}$/.test(receipt.patch[key] || ""))
      throw new Error(`MemFS receipt is missing ${key}`);
  }
  verifyBytes(wasmBytes, receipt.outputs?.["memfs.wasm"], "raw module");
}

export async function loadMemfsBuildMetadata(receiptPath, wasmBytes) {
  const receiptBytes = await fs.readFile(receiptPath);
  const buildReceipt = JSON.parse(receiptBytes.toString("utf8"));
  verifyReceipt(buildReceipt, wasmBytes);
  const files = new Map([[receiptName, receiptBytes]]);
  for (const [name, pin] of Object.entries(licenses)) {
    const bytes = await fs.readFile(
      path.join(path.dirname(receiptPath), pin.source),
    );
    verifyBytes(bytes, pin, pin.source);
    files.set(name, bytes);
  }
  return {
    metadata: {
      buildReceipt,
      files: Object.fromEntries(
        [...files].map(([name, bytes]) => [name, digest(bytes)]),
      ),
    },
    files,
  };
}

export async function loadMemfsReleaseFiles(sourceDir, metadata, zipBytes) {
  if (
    !metadata ||
    !isDeepStrictEqual(
      Object.keys(metadata.files || {}).sort(),
      [...fileNames].sort(),
    )
  ) {
    throw new Error("MemFS package metadata has an invalid sidecar list");
  }
  const files = new Map();
  for (const name of fileNames) {
    const bytes = await fs.readFile(path.join(sourceDir, name));
    verifyBytes(bytes, metadata.files[name], name);
    if (licenses[name]) verifyBytes(bytes, licenses[name], name);
    files.set(name, bytes);
  }
  const buildReceipt = JSON.parse(files.get(receiptName).toString("utf8"));
  if (!isDeepStrictEqual(buildReceipt, metadata.buildReceipt)) {
    throw new Error("MemFS receipt sidecar disagrees with toolchain metadata");
  }
  const reader = new ZipReader(new Uint8ArrayReader(zipBytes), {
    useWebWorkers: false,
  });
  try {
    const entries = (await reader.getEntries()).filter(
      (entry) => !entry.directory,
    );
    if (entries.length !== 1 || entries[0].filename !== "memfs")
      throw new Error("Invalid MemFS package archive");
    verifyReceipt(
      buildReceipt,
      await entries[0].getData(new Uint8ArrayWriter()),
    );
  } finally {
    await reader.close();
  }
  return files;
}

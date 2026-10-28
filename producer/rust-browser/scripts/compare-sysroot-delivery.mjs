#!/usr/bin/env node
// Measure actual pinned packs, and prove every reconstructed file matches the producer output.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  inventorySysroot,
  selectSysrootDelivery,
} from "./package-sysroot-profiles.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const identity = (bytes) => ({ bytes: bytes.length, sha256: sha(bytes) });
const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

export async function compareSysrootDelivery({
  consumer,
  runtime,
  producerSysroot,
  output,
}) {
  const helper = path.resolve(
    consumer,
    "scripts/build-layered-runtime-assets.mjs",
  );
  const { decodeCopyLiteralDelta } = await import(pathToFileURL(helper).href);
  const manifestBytes = await readFile(
    path.join(runtime, "runtime-manifest.v3.json"),
  );
  const manifest = JSON.parse(manifestBytes);
  const report = {
    schemaVersion: 1,
    measurementKind: "verified-packaging-and-node-decode",
    generatedAt: new Date().toISOString(),
    node: process.version,
    manifest: identity(manifestBytes),
    decoderSource: identity(await readFile(helper)),
    samples: [],
    limitations: [
      "Node decode timings are not browser latency.",
      "No hot-file corpus is inferred from filename or file size.",
      "Full file equivalence is checked; no runtime delivery default is changed.",
      "Logical decoded byte totals are not RSS or measured peak memory.",
    ],
  };
  const loaded = new Map();
  async function asset(name) {
    if (loaded.has(name)) return loaded.get(name);
    assert(
      /^[A-Za-z0-9._/-]+$/.test(name) &&
        !name.startsWith("/") &&
        !name.split("/").includes(".."),
    );
    const expected = manifest.assetReceipts["wasm-rust/runtime/" + name];
    assert(expected, `Missing receipt: ${name}`);
    const encoded = await readFile(path.join(runtime, name));
    assert.deepEqual(identity(encoded), {
      bytes: expected.bytes,
      sha256: expected.sha256,
    });
    const raw = gunzipSync(encoded, { maxOutputLength: 128 * 1024 ** 2 });
    assert.deepEqual(identity(raw), {
      bytes: expected.uncompressedBytes,
      sha256: expected.uncompressedSha256,
    });
    const result = { encoded, raw, expected };
    loaded.set(name, result);
    return result;
  }
  function decode(pack, index, base) {
    const files = new Map();
    for (const entry of index.entries) {
      assert(!files.has(entry.runtimePath));
      assert(
        Number.isSafeInteger(entry.offset) &&
          Number.isSafeInteger(entry.length) &&
          entry.offset >= 0 &&
          entry.length >= 0 &&
          entry.offset + entry.length <= pack.length,
      );
      let bytes = pack.subarray(entry.offset, entry.offset + entry.length);
      if (base) {
        if (entry.baseRuntimePath) assert(base.has(entry.baseRuntimePath));
        bytes = decodeCopyLiteralDelta(
          entry.baseRuntimePath
            ? base.get(entry.baseRuntimePath)
            : Buffer.alloc(0),
          bytes,
        );
        assert.equal(bytes.length, entry.decodedLength);
      }
      files.set(entry.runtimePath, bytes);
    }
    return files;
  }
  const baseSpec = manifest.targets["wasm32-wasip1"].sysrootPack;
  const basePack = await asset(baseSpec.asset),
    baseIndex = await asset(baseSpec.index);
  const baseFiles = decode(basePack.raw, JSON.parse(baseIndex.raw));
  for (const target of ["wasm32-wasip1", "wasm32-wasip2", "wasm32-wasip3"]) {
    const spec = manifest.targets[target].sysrootPack,
      pack = await asset(spec.asset),
      index = await asset(spec.index);
    const files = decode(
      pack.raw,
      JSON.parse(index.raw),
      spec.delta ? baseFiles : undefined,
    );
    const inventory = await inventorySysroot(
      path.join(producerSysroot, target, "lib"),
      target,
    );
    assert.equal(files.size, inventory.entries.length, `${target} file count`);
    for (const entry of inventory.entries) {
      const decoded = files.get(`/lib/rustlib/${target}/lib/${entry.path}`);
      assert(decoded, `Missing ${entry.path}`);
      assert.equal(sha(decoded), entry.sha256, `${target}/${entry.path}`);
    }
    const ordered = [...files].sort(([a], [b]) => a.localeCompare(b));
    let offset = 0;
    const directIndex = {
      format: "wasm-rust-runtime-pack-index-v1",
      fileCount: files.size,
      totalBytes: 0,
      entries: ordered.map(([runtimePath, bytes]) => {
        const item = { runtimePath, offset, length: bytes.length };
        offset += bytes.length;
        return item;
      }),
    };
    directIndex.totalBytes = offset;
    const directRaw = Buffer.concat(ordered.map(([, bytes]) => bytes));
    const directPack = gzipSync(directRaw, { level: 9 }),
      directIndexGz = gzipSync(
        Buffer.from(JSON.stringify(directIndex, null, 2) + "\n"),
        { level: 9 },
      );
    assert.deepEqual(gunzipSync(directPack), directRaw);
    const directBytes = directPack.length + directIndexGz.length;
    const deltaBytes = pack.encoded.length + index.encoded.length;
    const baseBytes = basePack.encoded.length + baseIndex.encoded.length;
    const direct = { bytes: directBytes, sha256: sha(directPack) };
    const delta = spec.delta
      ? {
          bytes: deltaBytes,
          sha256: sha(pack.encoded),
          base: { bytes: baseBytes, sha256: sha(basePack.encoded) },
        }
      : undefined;
    const decodeSamples = [];
    for (let repeat = 0; repeat < 5; repeat++) {
      // Alternating order reduces one-directional warmup bias. All results are consumed.
      const results = {};
      for (const variant of repeat % 2
        ? ["currentCold", "directCold", "currentWarmBase"]
        : ["directCold", "currentWarmBase", "currentCold"]) {
        const started = performance.now();
        const base = spec.delta
          ? variant === "currentCold"
            ? decode(
                gunzipSync(basePack.encoded),
                JSON.parse(gunzipSync(baseIndex.encoded)),
              )
            : baseFiles
          : undefined;
        const result =
          variant === "directCold"
            ? decode(
                gunzipSync(directPack),
                JSON.parse(gunzipSync(directIndexGz)),
              )
            : decode(
                gunzipSync(pack.encoded),
                JSON.parse(gunzipSync(index.encoded)),
                base,
              );
        results[variant] = performance.now() - started;
        assert.equal(result.size, files.size);
        for (const [name, bytes] of result)
          assert.equal(sha(bytes), sha(files.get(name)));
      }
      decodeSamples.push(results);
    }
    report.samples.push({
      target,
      files: files.size,
      producerInventorySha256: inventory.inventorySha256,
      allFilesMatchProducer: true,
      current: {
        pack: pack.expected,
        index: index.expected,
        coldTransferBytes: deltaBytes + (spec.delta ? baseBytes : 0),
        warmBaseTransferBytes: deltaBytes,
        decodedPackBytes:
          pack.raw.length + (spec.delta ? basePack.raw.length : 0),
        reconstructedBytes: directRaw.length,
      },
      direct: {
        pack: identity(directPack),
        index: identity(directIndexGz),
        raw: identity(directRaw),
        transferBytes: directBytes,
      },
      selection: {
        cold: selectSysrootDelivery({ direct, delta }),
        warmBase: selectSysrootDelivery({
          direct,
          delta,
          cachedBaseSha256: [sha(basePack.encoded)],
        }),
      },
      decodeNodeMs: {
        samples: decodeSamples,
        median: Object.fromEntries(
          ["directCold", "currentCold", "currentWarmBase"].map((k) => [
            k,
            median(decodeSamples.map((s) => s[k])),
          ]),
        ),
      },
      largestFiles: [...inventory.files]
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 5),
    });
  }
  await mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  return report;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [consumer, runtime, producerSysroot, output] = process.argv.slice(2);
  assert(
    consumer && runtime && producerSysroot && output,
    "Usage: compare-sysroot-delivery.mjs CONSUMER_ROOT RUNTIME_DIR PRODUCER_LIB_RUSTLIB OUTPUT_JSON",
  );
  await compareSysrootDelivery({ consumer, runtime, producerSysroot, output });
}

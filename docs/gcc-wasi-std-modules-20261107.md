# GCC/WASI standard module qualification — 2026-11-07

Issue 87 adds optional prebuilt GNU `std` and `std.compat` modules. The producer
uses the complete original GNU interfaces and the real GCC frontend/RTL backend;
no compiler rebuild, replacement declarations, empty-interface fallback, or
compatibility-check suppression was needed. The implementation and reproduction
commands are documented in [STD-MODULES.md](../producer/gcc-wasi/STD-MODULES.md).

The producer base is `bde09782a09ff96ef39abefe44a3d0d80d14ab78`. GCC remains
`ac20dcd5f8c5ae858f9b2d9cdf4140c0738e5e27` with the existing 29 ordered patches
and source diff SHA-256
`ecc42c806a08d113fa150bca2e9fbb3d0f4099dd9e4eccf691a4539212cf0ce8`.
The native `cc1plus` SHA-256 is
`10489868ad46a848b227a4b06a037dac86d8fbaccb30a74164093d678c5ad46c`;
the Wasm `cc1plus.wasm` SHA-256 is
`26f98f415c88b625abd067fa2a60218effa67f603038f43e391ba80e7282cecd`.
The unchanged packaged sysroot SHA-256 is
`ddeeccce8798da7ae912ba8c9f6658ede3d059f17b3514140f98afd58e26c6c0`.

## Actual native and Wasm-host execution

The final reusable producer first passed four native-host execution cases and
seven compiler negatives, then four Wasm-host cases and eight compiler negatives.
Every generated object was a relocatable Wasm object assembled from actual GCC
WAT. Both complete runs linked with the real GNU runtime and executed under WASI.

| Case | Actual input | Expected and observed output |
| --- | --- | --- |
| Four TUs: imported vector/string, header TU, imported helper, `std.compat` C APIs | `4 9 1 5 3\n` | `18 1 9 gcc-wasi:18 7\n` |
| Imported iostream | `44\n` | `45\n` |
| Original signal emulation archive | empty | `signal 0\n` |
| Calls to the actual GCC module initializer symbols | empty | `initializers\n` |

Negatives cover dialect, RTTI, C++ exceptions, mapper, BMI, `std.compat`, and its
`std` dependency. The Wasm frontend additionally rejects the native BMI with
both real host identities in its diagnostic. Native negative tests use relative
mapper filenames inside each isolated working directory so an embedded absolute
dependency filename cannot accidentally find an earlier BMI.

The initializer omission test explicitly references GCC's real generated symbols
and fails with unresolved `initializer for module std` and `std.compat`.
Ordinary optimized imports need not retain those references; the ordinary
multi-TU case is separate. The original interfaces produce real, empty initializer
functions for this profile, not hand-written placeholder implementations.

The exact profile uses GNU C++23, O2, the new string ABI, private scalar memory,
`-fno-exceptions`, and `-fno-rtti`. Actual `-mexception-handling` is enabled for
the original WASI header declarations. It does not implement SJLJ: the real
`<csetjmp>` plus import test compiles but the linker rejects unresolved `setjmp`
and `longjmp`. These APIs remain unsupported. Real signal emulation is explicitly
enabled and its archive is delivered with the modules.

The final local receipt is `out/issue87/qualification-v2/qualification.json`,
228,753 bytes, SHA-256
`0086abb898e19482e1e8932ddee157ce8f42187c4f2a0c18f53737f2bf2a3a73`.
The producer verified 60 frozen inputs. An independent review rehashed those
inputs and 77 source, BMI, object, program, and diagnostic artifacts without a
mismatch. The strict packager subsequently reopened the evidence and real archive
members and exited successfully. An independent package audit verified all 186
asset/provenance hashes and the two private candidate status changes. Nineteen
focused manifest tests passed. The full GCC producer regression suite passed
508 tests with zero failures and five existing external-evidence fixture skips;
all 312 recorded source inputs were unchanged across that run.

## Exact deployment assets and loading cost

These are Wasm-host BMIs, not the distinct native proof BMIs.

| Optional asset | Raw bytes | SHA-256 |
| --- | ---: | --- |
| `std.gcm` | 28,706,960 | `d30d743cbaffbaa36c1dedb7b435cbdfa207f3971bce8e9e2cb6a3f596a4f810` |
| `std.compat.gcm` | 51,792 | `3e9973cd6c0f23ffe033d033a079448df2fb69ae5f4a7c2fbdbda6d44fd0d971` |
| `libstdc++modules.a` | 616 | `2596f68b936da57bd0de66051f6a09c5d99b239ff897a7b0a97bf0cf635a28b5` |
| `libwasi-emulated-signal.a` | 12,208 | `1585f6106f5ae7234a90fbf7a61fb6a5923dea326ac31b63ad78f5d4ee00057d` |

The optional total is 28,771,576 raw bytes, 8,293,537 gzip bytes at level 9, or
6,279,641 Brotli bytes at quality 6. None is added to the eager asset map.
Base compiler/runtime payload bytes remain unchanged. The unverified manifest
adds 15,315 raw bytes; the complete initial payload is 91,523,304 raw,
29,096,644 gzip, or 23,351,227 Brotli bytes, excluding SDK Worker code.

Actual Wasm-host `std` production took 6.876 seconds and reached 334,102,528
linear-memory bytes; `std.compat` took 0.695 seconds. The largest importer
linear memory was 161,742,848 bytes. The Node process high-water RSS across the
whole Wasm-host qualification was 958,728 KiB; this is a process measure, not a
Chromium heap claim.

## Actual Chromium SDK Worker qualification

The strict package is `out/issue87/bundle-v2`. Its raw manifest remains
unverified, with SHA-256
`ddc10440e230ea5c5323b5e51957adf09081505a3fca51432c4133dbb514530d`.
The separately recorded private Chromium qualification candidate has SHA-256
`a9dde0b2a43ab6ebddf91f00a63cf9be1a00d9051740f47f04ce55f9b63ef36a`.
Only its outer and module qualification status fields change; the raw package and
base assets remain untouched. Actual Chromium 156.0.8078.4 SDK Workers then
passed all 37 checks against this exact candidate. All 174 recorded input hashes
remained unchanged. The consumer report is
`out/gcc87-sdk/chromium-v2/report.json` in the SDK task worktree, 117,394 bytes,
SHA-256 `18cbaae133e2288765f7645714646176a5b69cdaf76f145c798ac0528142d554`.
The producer sidecar `out/issue87/browser-qualified.json` binds that report to the
native/Wasm receipt, raw manifest, exact candidate, and all four optional assets.
Nothing was published or deployed.

Actual browser execution reproduced every output in the table above. Initialization
and ordinary header compilation fetched zero module assets. The four optional
assets were fetched once in total across the four module cases and a repeated
multi-TU compile, while each frontend received its own BMI files and mapper.
The browser also checked actual native-BMI rejection, invalid host/profile/source/
manifest identity, unverified module metadata, corrupt/missing assets, successful
retry after fetch failure, cache reuse, and the unsupported setjmp link error.

Single observations were 1.417580 seconds for initialization, 3.710435 seconds for
the first multi-TU compile and execution, and 2.580780 seconds for the cached
compile and execution. The largest
reported compiler stage linear memory was 161,546,240 bytes; the other three
module cases used 134,217,728 bytes. These figures exclude Worker JavaScript and
MEMFS allocations and are not whole-browser peak memory measurements.
The browser independently measured the same 28,771,576 raw and 8,293,537 gzip-9
optional bytes. Its Brotli quality-5 total was 6,355,223 bytes; the producer's
quality-6 figure above uses a different compression setting.

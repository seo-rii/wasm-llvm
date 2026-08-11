# TinyGo compile protocol v2 `go:embed` audit

Date: 2026-08-01

## Result

Compile protocol v2 passes end to end with a real upstream TinyGo 0.40.1 compiler. The adapter
publishes the main relocatable object plus every exact TinyGo-generated `go:embed` object returned
by upstream builder jobs. Raw WASI LLD consumes the ordered object set, Binaryen 129 performs the
declared asyncify/O1 pass, and the result executes successfully in the producer, the wasm-idle Node
WASI shim, and headless Chromium 149.

This closes the generated embed-object part of `ARCH-002`. Public TinyGo remains disabled because
workspace CGo/C/C++/assembly object handoff, offline external dependency availability, and hard
interruption/resource budgets remain incomplete. Assembly selected inside the pinned GOROOT is
accepted because upstream TinyGo supplies the corresponding standard-package intrinsics and
semantics; assembly selected from a workspace package still fails closed.

## Locked inputs and artifacts

- TinyGo commit: `db9f1182f5f2a64ea496752899626578d2b313a7`
- go-llvm commit: `b8f170971e747fec20a03b25a4490f627140709a`
- TinyGo LLVM 20.1.1 commit: `670759811adc85df52f410d7306788fabfc6242d`
- adapter patch SHA-256: `034234189da49313d28776e3e46ef6cf696f16baa0749f0fd493b5db5268eb6c`
- source receipt SHA-256: `b99de04e391eb4b45d0567fa649455fd5d41e0d94fb9e86b5345c9d054a5abb8`
- LLVM/WASI receipt SHA-256: `259ca23e3b6ba99f99341c7aa4ac0dcd4348a2c196fe0640fadee31c0d34cb5e`
- compiler build receipt SHA-256: `ad783c88e4f35a342ac71326938e20c021b0d000b26d1ba9089e055d127806aa`
- strict producer receipt SHA-256: `a50c5079aa48cd3f788d3db3d22d04c0feb616fb66ad1e7b7241e80a7e4797ed`

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `tinygo-compiler.wasm` | 61,599,053 | `be186c1d3ab42d31337a0c91b0cfdb101dac5371695dfa25eab1c1731bc0f9b8` |
| `tinygoroot.tar.gz` | 23,579,376 | `b0db89f2eba14e3bfcf408e93be2a2915e3f58ccee864f8fad4db58bf0e013aa` |

The build also restores the official TinyGo release-layout input
`lib/compiler-rt-builtins` from the same receipt-pinned LLVM source tree. Its 431 files total
914,259 bytes and have aggregate SHA-256
`ef4725c95d2a0e301b666bf4950f9d4b2ed1203c085c2a63e8e38ff0de80b39a`; the staged copy matches
exactly.

## Producer acceptance

The locked 44-package fixture embeds `greeting.txt`, uses maps, slices, a struct, a method, an
interface, and stdin, then prints `hello Ada count=2 total=3\n` with exit status 0 and empty
stderr.

| Output | Bytes | SHA-256 |
| --- | ---: | --- |
| `objects/0000-program.o` | 263,775 | `e801ead59b6cc6c7875aca5099174ca74386e5698ab0839f716124f51d12f09a` |
| `objects/0001-embed.o` | 1,142 | `980f52a81ad5522457ad57519cda9220c41ae267f381ecc788f045bbd547e527` |
| `link-plan.json` | 3,663 | `81b77d0ff7b38990ddcfbeb5de7ea3b52c4dabc3faa8418dd630aad1d1c9b9df` |
| `program.unoptimized.wasm` | 160,483 | `31b32b7a3a907ae664a77941c6c9ec90ff0dfdf70d111ae5b84246a529e7636d` |
| `program.wasm` | 249,611 | `9a2f3cdc0da183b29c3ba59017a8d7d908ba9374bfd1bf7e0681825d27895af5` |

The v2 link plan binds compiler SHA-256, capability, object count/order/path/kind/size/hash,
embed import path, embed source path and hash, TinyGo's embedded-file hash, runtime closure, linker
arguments, and optimizer arguments. Duplicate source contents are preserved as distinct objects.

## wasm-idle Node and Chromium evidence

The independent package provider derived a 43-package local module graph with build tags and
`go:embed`. Node and Chromium produced byte-identical evidence:

| Output | Bytes | SHA-256 |
| --- | ---: | --- |
| `objects/0000-program.o` | 228,995 | `0a230b87c638bee772e9c3ea6ed88db6de47fa9c4224de6e596fea17dfc15975` |
| `objects/0001-embed.o` | 1,059 | `3bf37775ff919e4d4621b212316adc4d2899dcb2d2d74b66b98f02d041088e38` |
| `program.unoptimized.wasm` | 135,005 | `f49bef9ad2fa66cbdfd4c2ef80dc5f649091ae08200ba7b674e714c7928d8f8a` |
| `program.wasm` | 208,069 | `6d665de26b0968135954d58571d302bf3c811d2ce8dade1515b95d9a64778c51` |

Both executions exited 0 with empty stderr and exact stdout `hello tinygo-wasm\n`. The Node
acceptance receipt SHA-256 is
`4b375c7d9160023135d9c4a63162cccad1bcf24140aa59787502d0bb6860cdc8`; the Chromium receipt
SHA-256 is `afea13430274734d3bc4872a64146e5f207634f4b47b502175c8f473f5a70713`.

## Review note

The requested high-compute second review was started through the `gpt-pro-consult` workflow, but
the browser page crashed while waiting: `Page.wait_for_timeout: Page crashed`. No consultation
result was available, so the migration was completed from source inspection, focused producer and
consumer audits, fail-closed tests, and the end-to-end evidence above.

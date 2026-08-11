# Upstream package-graph provider audit — 2026-08-01

> Follow-up: the later
> [compile protocol v2 audit](./2026-08-01-compile-protocol-v2.md) closes the `go:embed`
> object-publication blocker described in this point-in-time protocol-v1 audit.

## Result

The browser package graph is no longer caller-authored or reconstructed by the legacy scanner.
The producer builds the pinned Go 1.24.6 `cmd/go` entrypoint as a WASI Preview 1 module, and the
wasm-idle upstream consumer runs it before invoking TinyGo.

This closes package selection for an in-memory local module workspace. It does not make TinyGo a
public wasm-idle language yet: protocol v1 still rejects target CGo/C/C++ and `go:embed` packages,
module downloads are disabled, and compiler/LLD phases lack hard interruption and resource limits.

## Source and protocol identity

- Source archive: `golang.org/toolchain` `v0.0.1-go1.24.6.linux-amd64.zip`, 82,904,480 bytes,
  SHA-256 `e7f0fd16d1b06c716162a0938744bb7ebf7edbc3248d42432271a1b5c1fde1ce`.
- Entrypoint: upstream `cmd/go`, including receipt-bound `go/build`, `go/build/constraint`,
  `cmd/go/internal/list`, `cmd/go/internal/load`, and `cmd/go/internal/modload` sources.
- Patch: `go-toolchain-wasip1-lockedfile.patch`, SHA-256
  `4497603167ec8fdf40e1c7dbfad312b4f2ae72d0292df6413f0cf5247e1063d0`. It disables advisory
  file locking only on `wasip1`; execution remains single-process and uses `-mod=readonly`.
- Network/toolchain escape hatches are disabled with `GOTOOLCHAIN=local`, `GOPROXY=off`,
  `GOSUMDB=off`, `GOVCS=off`, and `GOENV=off`.
- The receipt fixes the selected JSON fields and TinyGo `wasip1` tags. The provider imports only
  `wasi_snapshot_preview1`.

## Producer acceptance

The local-module fixture contains a nested package, mutually exclusive TinyGo build-tag files, and
a `go:embed` input. The WASI graph contains 43 packages and exactly matches the JSON produced by
the same pinned native `cmd/go` after canonicalizing host mount prefixes.

- Provider: 25,870,831 bytes, SHA-256
  `b7b28719bf97d5c5e140c3ec6f8f40a40fc7d02216e0160e460a34b79f61cb14`.
- Provider receipt: SHA-256
  `704104d55ddfdab09cd3f1ea15ae0b4ae58d94c089815d458bf61ff4b27fd7b2`.
- Acceptance package JSON: 15,274 bytes, SHA-256
  `8f87e64a8f2a54660832f37eb3a88e2141888e2ebe49c94a9c5ae74416968811`.
- Comparison: `same-pinned-native-cmd-go-exact-json`.

## Consumer acceptance

wasm-idle's upstream compile request now contains only workspace files; there is no caller-supplied
package JSON. A second fixture with `go.mod`, a local package, TinyGo build tags, maps, slices, a
struct, a method, an interface, and stdin produced 44 packages and completed the provider →
compiler → raw LLD → Binaryen → WASI execution chain in both Node and Chromium 149.

Both hosts emitted identical outputs:

- `program.o`: 263,396 bytes, SHA-256
  `887e271f79b95392ab83a0162acf89fd949b827b3e91d6df903e4dbcf8ce9fb2`.
- Unoptimized Wasm: 160,211 bytes, SHA-256
  `1ead315ab52369fe29b70b55154680c036bda3d5b187d4993702f1dfc46b8594`.
- Final Wasm: 247,672 bytes, SHA-256
  `5850d05d73be82e4be619b848d5e3bd5cc3af57e9c58771821d3e0c7da643b54`.
- Stdout: `hello Ada count=2 total=3\n`, SHA-256
  `3a084b28c6d96b47e55a839990945ad3107dd754b8d01620dca337e84f196a8d`.
- Node acceptance receipt: SHA-256
  `0c6fae78c50a8b5dce39e4c7c53d96d320367869048d7bd45d5edc5c5a391a37`.
- Chromium acceptance receipt: SHA-256
  `ffd67ba8fa93489744614187d10f7efb39e88828276ec38f968208b35ad094e0`.

## Fail-closed boundary

The graph fixture proves that upstream `cmd/go` finds `go:embed` files correctly. The current
TinyGo adapter, however, publishes only `program.o`; TinyGo emits additional deterministic embed
objects that protocol v1 does not place in the link plan. The consumer therefore rejects any
selected `EmbedFiles`, just as it rejects selected target `CgoFiles`, `CFiles`, and `CXXFiles`.
Protocol v2 must publish and receipt-bind the complete object set before these cases are accepted.

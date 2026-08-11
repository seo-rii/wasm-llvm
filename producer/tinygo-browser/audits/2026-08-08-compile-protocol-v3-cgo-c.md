# TinyGo compile protocol v3 CGo/C audit

Date: 2026-08-08

## Conclusion

The browser compiler is a patched build of upstream TinyGo 0.40.1, not a wasm-idle-authored
language subset. Compile protocol v3 extends the v2 `go:embed` handoff with real upstream
`CgoFiles` processing and target `CFiles` compiled by the packaged Clang driver as ThinLTO
bitcode. C++, workspace assembly, and custom `#cgo LDFLAGS` remain fail-closed.

The separate legacy `wasm-idle` `runtime.js` entry is still an AST-to-C subset. Only the independent
`upstream.js` entry consumes these receipt-bound compiler artifacts.

## Locked identity

- TinyGo: `0.40.1`, commit `db9f1182f5f2a64ea496752899626578d2b313a7`
- go-llvm: commit `b8f170971e747fec20a03b25a4490f627140709a`
- TinyGo LLVM: commit `670759811adc85df52f410d7306788fabfc6242d`
- manifest SHA-256: `6478a0c278b107f4a68e74c750b9bdfc8ea902376d4470c4d5ae7c19e2f91fbb`
- sources lock SHA-256: `e17411b4fe063a9a5e227c12b853dd9f6eda2732fbf4ce57af73848987926b80`
- source receipt SHA-256: `51f9da667fd6b982cd7ecae22c02199186910f3e9eee099902844da10a088e8a`
- adapter patch SHA-256: `c091bc98426f728b0b3f8c94e8feb5b0323abcf76e47dd8014e67c0f3be50e38`
- LLVM WASI patch SHA-256: `ebc6a405f6459bd141904cf488d1ac606bdfd2d75a41a5ccd3f6127e883f7d01`

## Producer artifacts and acceptance

- `tinygo-compiler.wasm`: 70,273,271 bytes, SHA-256
  `7347fe2ed9f4c458599088d0c622a7d19c8af054834b9a410bc78033210889c1`
- `tinygoroot.tar.gz`: 24,266,518 bytes, SHA-256
  `8e124ff78729d2a98d663ae9a85430b42b82ee2569f82816b0c31d02c33e5df5`
- strict producer receipt SHA-256:
  `bbe5f28d059ca5848a5141518abff6a98aebdaac6a0063ebf5db39ffa59cae93`
- compile protocol: version 3, capabilities `go-embed-objects` and `target-cgo-c`
- package count: 45
- program object: 264,042 bytes, SHA-256
  `b328804878b1c6c4cdca823c392fdb7ef1d5d678c160b2149852e6de458d7f36`
- target-C bitcode: 3,044 bytes, SHA-256
  `a014cc4363836be617d421efc426119267549d3d98dca2e9afe20e3f2f5d353e`
- embed object: 1,142 bytes, SHA-256
  `980f52a81ad5522457ad57519cda9220c41ae267f381ecc788f045bbd547e527`
- link plan: 4,737 bytes, SHA-256
  `9e3ba60a43ac43e1d17e9844db471322969522f26003be7064069caccdaefa7a`
- exact stdout: `hello Ada count=2 total=3 cgo=5/20\n`

The root contains the receipt-bound Clang resource directory and generated wasi-libc include
closure used by CGo/C. The LLVM host patch resolves that resource directory from the mounted
`TINYGOROOT` without attempting unavailable WASI process execution. The strict verifier passed
after the readiness-only manifest text was rebound; compiler and root bytes did not change.

## Independent wasm-idle acceptance

The independent consumer used a distinct multi-package workspace fixture, so its object hashes are
not expected to equal the producer fixture. Node and Chromium do match one another exactly:

- package count: 45
- program object: 263,717 bytes, SHA-256
  `e7d89fbc748651227e88614096190a00ea485d6a70ca916ae66dee2e6b7a2b7c`
- target-C bitcode: 2,808 bytes, SHA-256
  `17b9d78d8d17178e85e92bbb7830e9fe96f3fe78e8a365d26a09ec797c77c5e1`
- unoptimized Wasm: 160,342 bytes, SHA-256
  `ad08ac3fc842bf109a6653b2819ecb674e3e0d680010c2efe6498f2036c8b345`
- final Wasm: 247,809 bytes, SHA-256
  `e8f586671b09e49580930d4508f319a8cef2ffc0a39f85e09fea2976902e5e08`
- Node acceptance receipt SHA-256:
  `67bc497274575c757635d4e28c77967df11535661995aa194020b267553f7b0d`
- Chromium acceptance receipt SHA-256:
  `04d6bdf3e265df72f7433f7573dcf2e3c0e882df8fbd96de17b878aba0c4db8a`
- browser: HeadlessChrome `147.0.7727.15`
- exact stdout: `hello Ada count=2 total=3 cgo=5/20\n`

The acceptance receipt envelope names remain `*-acceptance-v2`; their explicit
`compileProtocolVersion` is 3.

## Remaining release gates

- define and implement C++ and workspace-assembly semantics supported by the selected upstream
  TinyGo version
- define a safe policy for custom CGo linker flags
- supply external modules through an explicit offline cache/vendor contract
- isolate synchronous compiler and linker phases with hard time and memory limits
- add broader differential fixtures before setting `readiness.ready` or registering `TINYGO`

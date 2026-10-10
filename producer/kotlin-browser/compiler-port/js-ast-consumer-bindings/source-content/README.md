# Request source content for embedded JS locations

This component replaces the genuine `jsAstUtils.kt` filesystem supplier with a
request-owned immutable content snapshot. Its shipping method reads the real
`context.staticContext.backendContext.configuration`. It preserves the location,
`fileIdentity = null`, raw text, exact `source.path ?: source.name` key spelling,
fresh reader ownership and missing-source null. It performs no path/URI rewrite
or charset normalization, and keeps no global content registry.

The entry must call
`org.jetbrains.kotlin.js.portable.installRequestSourceContent(configuration,
sources: Iterable<KtSourceFile>)` after snapshotting input files, then pass that
same snapshot to the frontend. The private real `CompilerConfigurationKey`
stores one immutable request value. `requestSourceSupplier(configuration,path)`
captures that value when the AST location is created; every later callback
opens a fresh `AstSourceReader`. Reinstalling configuration cannot change an
already retained location. Configuration copies safely share the immutable
value. Duplicate paths and failed input reads leave the prior value intact.

`prepareSourceContentBindings({sourceRoot,outputRoot})` produces the genuine
adapted `jsAstUtils.kt` and the new provider under
`compiler-port-js-ast-source-content/`, replacing only the original utils path.
`verifySourceContentBindings` takes the same roots plus `receiptPath`. Both bind
seven genuine source files, their context/configuration APIs, the existing host
source contract, configuration host and AST reader to exact pins.

The final profile has 41 exact observations across genuine original JVM
configuration/source types, common JVM, Node Wasm and an offline Chromium
module Worker. It covers raw CRLF/BOM/Unicode, empty/NUL/exact path keys, fresh
reader identity and independent cursors, close, missing content, copied and
independent configurations, delayed suppliers after reinstall, mutable input
snapshots, one source read, source failure, duplicate atomicity and read-only
configuration rejection. Eight integrity guards passed without skips.

There is an explicit UTF16 host boundary: the genuine original source's UTF8
stream replaces isolated surrogates with U+003F, while the request's already
captured raw String retains them. JVM common, Node Wasm and offline Chromium
all preserve the raw String. Both results remain in
`evidence/raw-source-text-boundary.json`; this negative is not counted as host
parity. Closed-reader failure class differences are also retained as raw data;
the profile checks their shared `Stream closed` boundary contract.

The JVM observer uses genuine upstream source-interface/in-memory-source
sections and configuration bodies, with only IntelliJ package relocation and
a UTF8 source-stream adapter. The embedded-location observer projects the new
shipping body with its context configuration expression supplied as a real
`CompilerConfiguration` parameter. This validates the request binding, not the
old OS filesystem behavior or the full surrounding compiler context.

Source pins, actual commands and retained artifacts are in `evidence/receipt.json`.
Run `check.mjs` and `integrity.test.mjs` to reproduce the component checks. Entry
installation, full `jsAstUtils` compilation, SourceMap3Builder/JSON/VLQ/path
closure and complete browser compiler acceptance remain separate gates.

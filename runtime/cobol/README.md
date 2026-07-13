# GnuCOBOL browser runtime

This runtime translates real COBOL with GnuCOBOL 3.2, compiles the generated C with wasm-llvm,
and links a WASI Preview 1 executable against `libcob` and GMP. It supports free and fixed source
formats, copybooks, standard input through `ACCEPT`, and standard output through `DISPLAY`.

The versioned bundle contains the GnuCOBOL frontend, its runtime filesystem, and a C-only clang
sysroot. Removing the unused C++ standard library keeps the legacy browser memfs within its
addressable range while preserving the complete generated-C toolchain.

WASI has no subprocess or dynamic loader. Dynamic `CALL`, `CALL SYSTEM`, `fork`, SCREEN SECTION,
indexed I/O, and other host-specific facilities are intentionally unavailable. Static code in a
single compile unit using the bundled default GnuCOBOL dialect profile remains supported.

The compiler frontend is GPL-3.0-or-later. `libcob` and GMP retain their upstream LGPL/GPL terms.
Pinned source checksums and the clean rebuild recipe live in `producer/cobol-browser`.

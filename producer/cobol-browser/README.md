# COBOL browser producer

This producer builds the real GnuCOBOL 3.2 frontend, `libcob`, and GMP 6.3.0 for WASI Preview 1.
Downloads are checksum pinned in `manifest.json`. The output is the `cobc.zip` frontend plus a
deterministic root filesystem containing compiler configuration, copybooks, headers, static
libraries, WASI signal/getpid emulation, `libdl`, and the WASI SJLJ runtime. It also emits a
C-only clang sysroot with unused libc++ files removed for the browser memfs.

```bash
WASI_SDK_PATH=/opt/wasi-sdk-33.0-x86_64-linux \
  bash producer/cobol-browser/scripts/build.sh
```

GnuCOBOL's compiler is GPL-3.0-or-later. Its runtime is LGPL-3.0-or-later. GMP is dual licensed
under LGPL-3.0-or-later and GPL-2.0-or-later. The producer downloads unmodified upstream release
archives and adds only the small WASI compatibility source in `compat/`.

Subprocesses, dynamic loading, indexed file handlers, and terminal screen I/O do not exist in the
browser contract. Their compatibility functions return `ENOSYS`; they are not language emulation.

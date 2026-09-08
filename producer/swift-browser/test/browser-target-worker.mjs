// Acceptance harness only. Product Workers and runtime APIs belong to wasm-idle.
import { WASI, Fd, ConsoleStdout, wasi } from '/shim/index.js';

self.onmessage = async ({ data }) => {
  let stdout = '';
  let stderr = '';
  try {
    const input = new TextEncoder().encode(data.stdin);
    class Stdin extends Fd {
      offset = 0;
      fd_read(length) {
        const end = Math.min(input.length, this.offset + Math.min(length, 3));
        const bytes = input.slice(this.offset, end);
        this.offset = end;
        return { ret: wasi.ERRNO_SUCCESS, data: bytes };
      }
      fd_fdstat_get() {
        const fdstat = new wasi.Fdstat(wasi.FILETYPE_CHARACTER_DEVICE, 0);
        fdstat.fs_rights_base = BigInt(wasi.RIGHTS_FD_READ);
        return { ret: wasi.ERRNO_SUCCESS, fdstat };
      }
    }
    const stdoutDecoder = new TextDecoder();
    const stderrDecoder = new TextDecoder();
    const host = new WASI(['browser-stdin.wasm'], [], [new Stdin(),
      new ConsoleStdout((bytes) => { stdout += stdoutDecoder.decode(bytes, { stream: true }); }),
      new ConsoleStdout((bytes) => { stderr += stderrDecoder.decode(bytes, { stream: true }); })]);
    const module = await WebAssembly.compile(data.bytes);
    const imports = WebAssembly.Module.imports(module);
    if (imports.some((entry) => entry.module !== 'wasi_snapshot_preview1')) {
      throw new Error('Swift target requires imports outside the Preview 1 acceptance host');
    }
    const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: host.wasiImport });
    const exitCode = host.start(instance);
    stdout += stdoutDecoder.decode();
    stderr += stderrDecoder.decode();
    self.postMessage({ exitCode, stdout, stderr, imports });
  } catch (error) {
    self.postMessage({ exitCode: null, stdout, stderr, error: String(error) });
  }
};

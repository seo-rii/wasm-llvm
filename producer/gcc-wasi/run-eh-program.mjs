// Capture genuine WASI process completion separately from an escaping host
// exception or a Wasm trap. Neither can satisfy a successful GNU EH oracle.
import fs from 'node:fs/promises';
import path from 'node:path';
import { WASI } from 'node:wasi';

const [program, directory, ...guestArgs] = process.argv.slice(2);
const input = await fs.open(path.join(directory, 'stdin.txt'), 'r');
const stdout = await fs.open(path.join(directory, 'guest.stdout'), 'wx');
const stderr = await fs.open(path.join(directory, 'guest.stderr'), 'wx');
const result = { host: `Node ${process.versions.node}`, exitCode: null, escapedException: null };
try {
  const bytes = await fs.readFile(program);
  const module = await WebAssembly.compile(bytes);
  result.imports = WebAssembly.Module.imports(module);
  result.exports = WebAssembly.Module.exports(module);
  const wasi = new WASI({ version: 'preview1', args: ['eh-program', ...guestArgs], env: {}, preopens: {},
    stdin: input.fd, stdout: stdout.fd, stderr: stderr.fd, returnOnExit: true });
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi.wasiImport });
  result.exitCode = wasi.start(instance);
} catch (error) {
  result.escapedException = {
    name: error?.constructor?.name ?? typeof error,
    message: String(error), stack: error?.stack ?? null,
    nativeException: typeof WebAssembly.Exception === 'function' && error instanceof WebAssembly.Exception,
  };
} finally {
  await input.close(); await stdout.close(); await stderr.close();
}
result.stdout = await fs.readFile(path.join(directory, 'guest.stdout'), 'utf8');
result.stderr = await fs.readFile(path.join(directory, 'guest.stderr'), 'utf8');
await fs.writeFile(path.join(directory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });

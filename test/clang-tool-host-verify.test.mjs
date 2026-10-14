import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const verifier = fileURLToPath(new URL('../producer/clang-browser/tool-host/verify.mjs', import.meta.url));
const u32 = (value) => {
  const bytes = [];
  do { const part = value & 127; value >>>= 7; bytes.push(part | (value ? 128 : 0)); } while (value);
  return bytes;
};
const name = (value) => { const bytes = [...new TextEncoder().encode(value)]; return [...u32(bytes.length), ...bytes]; };
const section = (id, bytes) => [id, ...u32(bytes.length), ...bytes];

// Actual core Wasm modules exercise the verifier's import and signature boundary.
// These are ABI fixtures, not evidence of compiler execution.
function fixture({ parameters = Array(7).fill(0x7f), bridge = 'exec_v1', cwd = true, extra = false } = {}) {
  const entries = [];
  if (bridge) entries.push([...name('wasm_idle_tool_host'), ...name(bridge), 0, 0]);
  if (cwd) entries.push([...name('wasm_idle_process_v1'), ...name('initial_cwd'), 0, 1]);
  if (extra) entries.push([...name('unexpected_host'), ...name('fetch'), 0, 0]);
  return Uint8Array.from([
    0, 97, 115, 109, 1, 0, 0, 0,
    ...section(1, [3, 0x60, parameters.length, ...parameters, 1, 0x7f, 0x60, 2, 0x7f, 0x7f, 1, 0x7f, 0x60, 0, 0]),
    ...(entries.length ? section(2, [entries.length, ...entries.flat()]) : []),
    ...section(3, [1, 2]), ...section(5, [1, 0, 1]),
    ...section(7, [2, ...name('memory'), 2, 0, ...name('_start'), 0, entries.length]),
    ...section(10, [1, 2, 0, 0x0b])
  ]);
}

function withFixture(bytes, fn) {
  const root = mkdtempSync(path.join(tmpdir(), 'llvm-verify-'));
  const wasm = path.join(root, 'tool.wasm'), receipt = path.join(root, 'module.json');
  writeFileSync(wasm, bytes);
  const run = (...flags) => execFileSync(process.execPath, [verifier, wasm, receipt, ...flags], { stdio: 'pipe', timeout: 10000 });
  try { fn(run, () => JSON.parse(readFileSync(receipt, 'utf8'))); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

for (const kind of ['clang', 'lld']) {
  test(`${kind} requires exact exec_v1 and cwd signatures and records child policy`, () => {
    withFixture(fixture(), (run, receipt) => {
      run('--initial-cwd', `--kind=${kind}`);
      assert.deepEqual(receipt().bridgeSignature, { parameters: Array(7).fill('i32'), results: ['i32'] });
      assert.equal(receipt().childDispatch, kind === 'clang' ? 'pinned linker only' : 'deny');
    });
  });
  test(`${kind} rejects missing/unknown ABI, wrong signature and unrelated host import`, () => {
    for (const config of [{ bridge: null }, { bridge: 'exec_v2' }, { parameters: Array(6).fill(0x7f) }, { extra: true }, { cwd: false }]) {
      withFixture(fixture(config), (run) => assert.throws(() => run('--initial-cwd', `--kind=${kind}`)));
    }
  });
}
test('conflicting tool kinds fail before verification', () => {
  withFixture(fixture(), (run) => assert.throws(() => run('--kind=clang', '--kind=lld')));
});

// Execute precompiled WASI guests in real Chromium module Workers. This helper
// never builds a compiler, changes an artifact, or replaces the GNU control ABI.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const debuggerControlSymbol = '_ZN9__gnu_cxx30debugger_signal_for_breakpointE';
export const debuggerRegistrationModes = Object.freeze([
  'detached', 'attached', 'registered', 'clear-before-detach'
]);
const debuggerProbeEntryFunctions = Object.freeze([
  'debugger_probe_conditional', 'debugger_probe_breakpoint'
]);

// The browser's debugger cannot infer this GNU flag from an arbitrary open
// DevTools window. Registration is an explicit CDP write after Debugger.enable
// has succeeded; no guest import or guessed debugger-presence hook is involved.
const controlExpression = (value) => `(() => {
  const instance = globalThis.__gccDebugger.instance;
  const control = instance.exports[${JSON.stringify(debuggerControlSymbol)}];
  if (!(control instanceof WebAssembly.Global)) throw Error('GNU debugger control is not an exported WebAssembly.Global');
  const memory = instance.exports.memory, address = control.value;
  if (!(memory instanceof WebAssembly.Memory) || !Number.isInteger(address) || address < 0 || address + 4 > memory.buffer.byteLength)
    throw Error('Invalid GNU debugger control address');
  const view = new DataView(memory.buffer), before = view.getInt32(address, true);
  ${value === undefined ? '' : `view.setInt32(address, ${value}, true);`}
  return { exportName: ${JSON.stringify(debuggerControlSymbol)}, address, memoryBytes: memory.buffer.byteLength,
    before, value: view.getInt32(address, true), bytes: Array.from(new Uint8Array(memory.buffer, address, 4)),
    present: typeof instance.exports.debugger_probe_present === 'function' ? instance.exports.debugger_probe_present() : null };
})()`;

export const debuggerWorkerSource = `import { WASI, File, OpenFile, ConsoleStdout } from '/shim/index.js';
globalThis.__gccDebugger = { instance: null };
const control = () => {
  const instance = globalThis.__gccDebugger.instance;
  const address = instance.exports[${JSON.stringify(debuggerControlSymbol)}];
  if (!(address instanceof WebAssembly.Global)) throw Error('GNU debugger control is not an exported WebAssembly.Global');
  const memory = instance.exports.memory, offset = address.value;
  if (!(memory instanceof WebAssembly.Memory) || !Number.isInteger(offset) || offset < 0 || offset + 4 > memory.buffer.byteLength)
    throw Error('Invalid GNU debugger control address');
  return { exportName: ${JSON.stringify(debuggerControlSymbol)}, address: offset, memoryBytes: memory.buffer.byteLength,
    value: new DataView(memory.buffer).getInt32(offset, true), bytes: Array.from(new Uint8Array(memory.buffer, offset, 4)),
    present: typeof instance.exports.debugger_probe_present === 'function' ? instance.exports.debugger_probe_present() : null };
};
const errorRecord = error => ({ name: error.name, message: error.message, stack: String(error.stack || '').slice(0, 16384),
  isWasmTrap: error instanceof WebAssembly.RuntimeError });
let wasi, streams;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'prepare') {
      streams = [[], []];
      const lengths = [0, 0], out = index => new ConsoleStdout(bytes => {
        lengths[index] += bytes.length;
        if (lengths[index] > data.maxOutputBytes) throw Error('Guest output exceeds capture limit');
        streams[index].push(bytes.slice());
      });
      const fds = [new OpenFile(new File(new TextEncoder().encode(data.stdin), { readonly: true })), out(0), out(1)];
      wasi = new WASI(['program', ...data.args], [], fds, { debug: false });
      const { instance } = await WebAssembly.instantiateStreaming(fetch(data.wasmURL), { wasi_snapshot_preview1: wasi.wasiImport });
      globalThis.__gccDebugger.instance = instance;
      self.postMessage({ type: 'ready', control: control() });
    } else if (data.type === 'start') {
      let exitCode = null, error = null;
      try {
        const instance = globalThis.__gccDebugger.instance;
        if (data.entryFunction === undefined) exitCode = wasi.start(instance);
        else {
          if (!${JSON.stringify(debuggerProbeEntryFunctions)}.includes(data.entryFunction))
            throw Error('Unknown debugger probe entry function');
          const entry = instance.exports[data.entryFunction];
          if (typeof entry !== 'function') throw Error('Debugger probe entry function is not exported');
          entry();
          exitCode = 0;
        }
      }
      catch (value) { error = errorRecord(value); }
      const decode = chunks => {
        const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        return new TextDecoder().decode(bytes);
      };
      self.postMessage({ type: 'done', exitCode, error, stdout: decode(streams[0]), stderr: decode(streams[1]), control: control() });
    } else throw Error('Unknown guest command');
  } catch (error) { self.postMessage({ type: 'failed', error: errorRecord(error) }); }
};
`;

const pageSource = `globalThis.__gccDebuggerGuests = new Map();
globalThis.__gccDebuggerPrepare = (id, config) => {
  const worker = new Worker('/worker.mjs?id=' + encodeURIComponent(id), { type: 'module', name: id });
  let readyResolve, readyReject, doneResolve, doneReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const done = new Promise((resolve, reject) => { doneResolve = resolve; doneReject = reject; });
  ready.catch(() => {}); done.catch(() => {});
  const reject = error => { readyReject(error); doneReject(error); };
  worker.onmessage = ({ data }) => {
    if (data.type === 'ready') readyResolve(data);
    else if (data.type === 'done') doneResolve(data);
    else reject(Error(JSON.stringify(data)));
  };
  worker.onerror = event => { event.preventDefault(); reject(Error(event.message)); };
  globalThis.__gccDebuggerGuests.set(id, { worker, ready, done });
  worker.postMessage({ type: 'prepare', ...config });
  return ready;
};
globalThis.__gccDebuggerStart = (id, options = {}) => {
  const guest = globalThis.__gccDebuggerGuests.get(id);
  guest.worker.postMessage({ type: 'start', ...options });
  return guest.done;
};
globalThis.__gccDebuggerDispose = id => {
  globalThis.__gccDebuggerGuests.get(id)?.worker.terminate();
  globalThis.__gccDebuggerGuests.delete(id);
};
`;

// A flattened session puts sessionId on every command and event. In particular,
// Worker commands do not go through a Page-only Playwright CDPSession or the
// deprecated Target.sendMessageToTarget transport.
// https://chromedevtools.github.io/devtools-protocol/tot/Target/#method-attachToTarget
class CdpConnection {
  constructor(socket, timeoutMs) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(Error(`${pending.method}: ${JSON.stringify(message.error)}`));
        else pending.resolve(message.result);
      } else for (const listener of this.listeners) listener(message);
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(Error('Chromium CDP connection closed'));
      }
      this.pending.clear();
    });
  }

  static async open(url, timeoutMs) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(Error('Chromium CDP connection timed out')); }, timeoutMs);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(Error('Chromium CDP connection failed')); }, { once: true });
    });
    return new CdpConnection(socket, timeoutMs);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error(`CDP command timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  on(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
}

async function evaluated(cdp, sessionId, expression, awaitPromise = false, silent = true) {
  const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, silent }, sessionId);
  if (response.exceptionDetails) throw Error(`CDP evaluation failed: ${JSON.stringify(response.exceptionDetails)}`);
  return response.result.value;
}

/**
 * @param {{ executablePath: string, shim: string, timeoutMs?: number, temporaryRoot?: string }} options
 * @returns {Promise<{browserVersion: string, workerSource: string, close: Function, run: Function}>}
 *
 * run({ bytes, stdin, args, registration, sourceURL, maxOutputBytes, entryFunction }) accepts
 * already linked Wasm bytes. sourceURL is a display filename in the loopback
 * artifact URL; the supplied bytes are always served unchanged. A fresh Worker
 * and GNU control cell are used for every run. Run calls must be sequential.
 * entryFunction optionally calls debugger_probe_conditional or debugger_probe_breakpoint
 * directly; omission retains the WASI command entry point.
 *
 * detached: no Worker debugger session; attached: Debugger enabled, flag untouched;
 * registered: enable succeeds, then CDP writes -1 until execution completes;
 * clear-before-detach: register -1, clear 0, detach, then execute.
 *
 * GNU std::breakpoint() uses a non-resumable Wasm trap. A captured paused event
 * is resumed only to let that same RuntimeError propagate into the result.
 */
export async function openDebuggerGuest({ executablePath, shim, timeoutMs = 30000, temporaryRoot = os.tmpdir() }) {
  assert(executablePath && shim, 'Chromium executablePath and WASI shim directory are required');
  assert(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000, 'Invalid debugger timeout');
  assert(typeof WebSocket === 'function', 'A Node version with global WebSocket is required');
  const shimRoot = await fs.realpath(shim), artifacts = new Map();
  let server, child, childExit, cdp, pageSession, privateDirectory, active = false, closed = false, sequence = 0;
  let diagnostics = '';

  async function close() {
    if (closed) return;
    closed = true;
    try {
      if (cdp?.socket.readyState === WebSocket.OPEN) {
        await Promise.race([cdp.send('Browser.close').catch(() => {}), delay(1000)]);
        cdp.socket.close();
      }
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await Promise.race([childExit, delay(3000)]);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
      if (childExit) await childExit;
    } finally {
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      if (privateDirectory) await fs.rm(privateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }

  try {
    server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url || '/', 'http://localhost');
        response.setHeader('Cache-Control', 'no-store');
        if (url.pathname === '/probe') {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><title>GNU debugger Worker qualification</title>');
        } else if (url.pathname === '/worker.mjs') {
          response.setHeader('Content-Type', 'text/javascript');
          response.end(debuggerWorkerSource);
        } else if (artifacts.has(url.pathname)) {
          response.setHeader('Content-Type', 'application/wasm');
          response.end(artifacts.get(url.pathname));
        } else if (url.pathname.startsWith('/shim/')) {
          const file = await fs.realpath(path.resolve(shimRoot, decodeURIComponent(url.pathname.slice(6))));
          assert(file.startsWith(shimRoot + path.sep), 'WASI shim path escapes configured directory');
          response.setHeader('Content-Type', 'text/javascript');
          response.end(await fs.readFile(file));
        } else response.writeHead(404).end();
      } catch (error) { response.writeHead(500).end(String(error)); }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    privateDirectory = await fs.mkdtemp(path.join(temporaryRoot, 'gcc-debugger-cdp-'));
    await fs.chmod(privateDirectory, 0o700);
    child = spawn(executablePath, [
      '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-extensions', '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${privateDirectory}`, 'about:blank'
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    childExit = new Promise((resolve) => {
      child.once('error', (error) => { diagnostics += String(error); resolve(); });
      child.once('exit', resolve);
    });
    child.stderr.on('data', (bytes) => { diagnostics = (diagnostics + bytes.toString()).slice(-32768); });
    const deadline = Date.now() + timeoutMs;
    let endpoint;
    while (!endpoint) {
      try {
        const [port, pathname] = (await fs.readFile(path.join(privateDirectory, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
        assert(/^\d+$/.test(port) && pathname.startsWith('/devtools/browser/'), 'Invalid Chromium DevTools endpoint');
        endpoint = `ws://127.0.0.1:${port}${pathname}`;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) throw Error(`Chromium exited before CDP startup: ${diagnostics}`);
        if (Date.now() >= deadline) throw Error(`Chromium CDP startup timed out: ${diagnostics}`);
        await delay(50);
      }
    }
    cdp = await CdpConnection.open(endpoint, timeoutMs);
    const version = await cdp.send('Browser.getVersion');
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    const { targetId } = await cdp.send('Target.createTarget', { url: origin + '/probe' });
    ({ sessionId: pageSession } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
    await cdp.send('Runtime.enable', {}, pageSession);
    const pageDeadline = Date.now() + timeoutMs;
    while (!await evaluated(cdp, pageSession, `location.href === ${JSON.stringify(origin + '/probe')} && document.readyState === 'complete'`).catch(() => false)) {
      assert(Date.now() < pageDeadline, 'Chromium guest page startup timed out');
      await delay(50);
    }
    await evaluated(cdp, pageSession, pageSource);

    return {
      browserVersion: version.product,
      workerSource: debuggerWorkerSource,
      close,
      async run({ bytes, stdin = '', args = [], registration = 'detached', sourceURL = 'program.wasm', maxOutputBytes = 65536, entryFunction }) {
        assert(!closed && !active, 'Debugger guest runner is closed or already running');
        assert(debuggerRegistrationModes.includes(registration), 'Unknown debugger registration mode');
        assert(entryFunction === undefined || debuggerProbeEntryFunctions.includes(entryFunction), 'Unknown debugger probe entry function');
        assert(bytes instanceof Uint8Array && bytes.byteLength > 0, 'Precompiled Wasm bytes are required');
        assert(typeof stdin === 'string' && Array.isArray(args) && args.every((arg) => typeof arg === 'string'));
        assert(typeof sourceURL === 'string' && sourceURL.length > 0 && sourceURL.length <= 1024);
        assert(Number.isInteger(maxOutputBytes) && maxOutputBytes > 0 && maxOutputBytes <= 524288);
        active = true;
        const id = `gcc-debugger-${++sequence}`;
        const wasmPath = `/wasm/${id}/${encodeURIComponent(sourceURL)}`;
        const workerURL = `${origin}/worker.mjs?id=${encodeURIComponent(id)}`;
        const frozenBytes = Buffer.from(bytes);
        artifacts.set(wasmPath, frozenBytes);
        const result = {
          registration, entryFunction: entryFunction ?? null, workerURL, wasmURL: origin + wasmPath,
          artifact: { bytes: frozenBytes.length, sha256: createHash('sha256').update(frozenBytes).digest('hex') },
          commands: [], controls: [], pauses: [], scripts: [], debuggerEnabled: false, detachedBeforeExecution: registration === 'detached'
        };
        const scripts = new Map(), failures = [];
        let workerSession, registered = false, debuggerEnabled = false, unsubscribe, unsubscribeAttach, pauseWork = Promise.resolve();
        async function command(method, params = {}, sessionId = workerSession) {
          assert(result.commands.length < 256, 'CDP command capture limit exceeded');
          const entry = { method, params, sessionId: sessionId || null, completed: false };
          result.commands.push(entry);
          const response = await cdp.send(method, params, sessionId);
          entry.completed = true;
          return response;
        }
        async function inspectControl(stage, value) {
          const expression = controlExpression(value);
          const response = await command('Runtime.evaluate', { expression, returnByValue: true, silent: true });
          assert(!response.exceptionDetails, `Control memory evaluation failed: ${JSON.stringify(response.exceptionDetails)}`);
          const snapshot = response.result.value;
          assert(snapshot && snapshot.bytes?.length === 4, 'Control memory was not returned by value');
          result.controls.push({ stage, ...snapshot });
          if (value !== undefined) assert.equal(snapshot.value, value, 'GNU control memory write failed');
          return snapshot;
        }
        async function detach() {
          if (!workerSession) return;
          if (registered) { await inspectControl('clear-before-detach', 0); registered = false; }
          if (debuggerEnabled) { await command('Debugger.disable'); debuggerEnabled = false; }
          await command('Target.detachFromTarget', { sessionId: workerSession }, pageSession);
          workerSession = undefined;
        }
        try {
          if (registration !== 'detached') {
            // Dedicated Workers are child targets of the Page. Chromium's
            // browser-level discovery can expose an empty, nonfunctional
            // Worker target until its Page enables child auto-attachment.
            unsubscribeAttach = cdp.on((message) => {
              if (message.sessionId === pageSession && message.method === 'Target.attachedToTarget' && message.params.targetInfo.type === 'worker') {
                assert(!workerSession, 'Unexpected second Chromium Worker attachment');
                workerSession = message.params.sessionId;
                result.targetId = message.params.targetInfo.targetId;
              }
            });
            await command('Target.setAutoAttach', {
              autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
              filter: [{ type: 'worker', exclude: false }, { exclude: true }]
            }, pageSession);
          }
          const ready = await evaluated(cdp, pageSession,
            `globalThis.__gccDebuggerPrepare(${JSON.stringify(id)}, ${JSON.stringify({ wasmURL: origin + wasmPath, stdin, args, maxOutputBytes })})`, true);
          result.controls.push({ stage: 'prepared', ...ready.control });
          if (registration !== 'detached') {
            assert(workerSession, 'Actual Chromium Worker child session was not attached');
            unsubscribeAttach();
            unsubscribeAttach = undefined;
            unsubscribe = cdp.on((message) => {
              if (message.sessionId !== workerSession) return;
              if (message.method === 'Debugger.scriptParsed' && message.params.scriptLanguage === 'WebAssembly') {
                const script = message.params;
                scripts.set(script.scriptId, script);
              }
              if (message.method === 'Debugger.paused') {
                pauseWork = pauseWork.then(async () => {
                  try {
                    assert(result.pauses.length < 16, 'Guest pause capture limit exceeded');
                    const event = message.params;
                    const frames = event.callFrames.slice(0, 128).map((frame) => ({
                      functionName: frame.functionName, location: frame.location,
                      url: scripts.get(frame.location.scriptId)?.url || frame.url,
                      wasm: scripts.has(frame.location.scriptId)
                    }));
                    result.pauses.push({ reason: event.reason, data: event.data ? {
                      type: event.data.type, subtype: event.data.subtype, description: event.data.description?.slice(0, 16384)
                    } : null, frames, wasmFrames: frames.filter((frame) => frame.wasm) });
                    await inspectControl('paused');
                  } catch (error) { failures.push(String(error.stack || error)); }
                  finally { await command('Debugger.resume').catch((error) => failures.push(String(error))); }
                });
              }
            });
            await command('Runtime.enable');
            const location = await command('Runtime.evaluate', { expression: 'self.location.href', returnByValue: true, silent: true });
            assert.equal(location.result.value, workerURL, 'Debugger attached to the wrong Worker');
            // The acknowledgement is the registration precondition, per CDP.
            await command('Debugger.enable');
            result.debuggerEnabled = debuggerEnabled = true;
            await command('Debugger.setPauseOnExceptions', { state: 'all' });
            await inspectControl('attached-unregistered');
            if (registration === 'registered' || registration === 'clear-before-detach') {
              registered = true;
              await inspectControl('registered', -1);
            }
            if (registration === 'clear-before-detach') {
              await detach();
              await command('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }, pageSession);
              result.detachedBeforeExecution = true;
            }
          }
          // The Page command must not suppress exceptions globally: only the
          // Worker's actual wasm exception pause is evidence of std::breakpoint.
          const execution = await evaluated(cdp, pageSession,
            `globalThis.__gccDebuggerStart(${JSON.stringify(id)}, ${JSON.stringify({ entryFunction })})`, true, false);
          await pauseWork;
          assert.deepEqual(failures, [], 'Actual Worker pause handling failed');
          for (const key of ['exitCode', 'error', 'stdout', 'stderr']) result[key] = execution[key];
          result.controls.push({ stage: 'execution-complete', ...execution.control });
          result.scripts = [...scripts.values()].map(({ scriptId, url, scriptLanguage, codeOffset, length, hash, debugSymbols }) =>
            ({ scriptId, url, scriptLanguage, codeOffset, length, hash, debugSymbols }));
          await detach();
          assert(Buffer.byteLength(JSON.stringify(result)) < 5 * 1024 * 1024, 'Debugger evidence exceeds capture limit');
          return result;
        } finally {
          await pauseWork;
          try { await detach(); }
          finally {
            unsubscribe?.();
            unsubscribeAttach?.();
            await evaluated(cdp, pageSession, `globalThis.__gccDebuggerDispose(${JSON.stringify(id)})`).catch(() => {});
            if (registration !== 'detached') await cdp.send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }, pageSession).catch(() => {});
            artifacts.delete(wasmPath);
            active = false;
          }
        }
      }
    };
  } catch (error) { await close(); throw error; }
}

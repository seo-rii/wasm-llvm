// Chromium acceptance Worker: one fresh ECL module instance per message.
import { runEcl } from './harness.mjs';

self.onmessage = async ({ data }) => {
	try {
		const [{ default: createModule }, wasm] = await Promise.all([
			import('./ecl.mjs'),
			fetch('./ecl.wasm').then((response) => response.arrayBuffer())
		]);
		const result = await runEcl({ createModule, wasmBinary: new Uint8Array(wasm), source: data.source, stdin: data.stdin });
		self.postMessage({ result });
	} catch (error) {
		self.postMessage({ error: String(error?.stack || error) });
	}
};

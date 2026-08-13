const textDecoder = new TextDecoder();

export async function assertClangdStdinBridge(jsBytes, wasmBytes) {
	const jsSource = typeof jsBytes === 'string' ? jsBytes : textDecoder.decode(jsBytes);
	if (!jsSource.includes('Module.stdinReady')) {
		throw new Error('clangd.js is missing the browser stdin readiness callback');
	}

	const wasmModule = await WebAssembly.compile(wasmBytes);
	const hasStdinImport = WebAssembly.Module.imports(wasmModule).some(
		(entry) => entry.kind === 'function' && entry.name === '__asyncjs__waitForStdin'
	);
	if (!hasStdinImport) {
		throw new Error('clangd.wasm is missing the Asyncify stdin import');
	}
}

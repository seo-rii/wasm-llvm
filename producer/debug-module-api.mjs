export const MODULE_INSTANTIATION_CONTRACT = 'emscripten-instantiate-wasm-v1';

export function validateModuleInstantiation(value, label) {
	if (value !== undefined && value !== MODULE_INSTANTIATION_CONTRACT) {
		throw new Error(`${label} has an unsupported moduleInstantiation contract`);
	}
}

// Lexical generated-source marker only, not proof of execution. A legacy
// assertion is insufficient; the candidate Chromium probe separately observes
// the actual factory callback for these exact asset digests.
export function assertModuleInstantiationHook(bytes, label) {
	const source =
		typeof bytes === 'string' ? bytes : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	if (!/Module\s*\[\s*(["'])instantiateWasm\1\s*\]\s*\(/u.test(source)) {
		throw new Error(`${label} does not call the producer instantiateWasm hook`);
	}
}

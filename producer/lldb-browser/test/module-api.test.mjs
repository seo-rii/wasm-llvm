import assert from 'node:assert/strict';
import test from 'node:test';
import {
	MODULE_INSTANTIATION_CONTRACT,
	assertModuleInstantiationHook,
	validateModuleInstantiation
} from '../../debug-module-api.mjs';
import { EMSCRIPTEN_LINK_FLAGS } from '../scripts/build.mjs';
import { EMSCRIPTEN_LINK_OPTIONS } from '../../wamr-browser/scripts/build.mjs';

test('both producer recipes opt into the same Emscripten incoming API', () => {
	for (const flags of [EMSCRIPTEN_LINK_FLAGS, EMSCRIPTEN_LINK_OPTIONS]) {
		const api = flags.find((flag) => flag.startsWith('-sINCOMING_MODULE_JS_API='));
		assert.match(api, /'instantiateWasm'/u);
		assert.ok(flags.includes('-pthread'));
		assert.ok(flags.includes('-sEXIT_RUNTIME=1'));
	}
});
test('capability validation accepts the legacy path and rejects unknown contracts', () => {
	validateModuleInstantiation(undefined, 'legacy');
	validateModuleInstantiation(MODULE_INSTANTIATION_CONTRACT, 'candidate');
	for (const value of [null, false, '', 'instantiateWasm'])
		assert.throws(() => validateModuleInstantiation(value, 'candidate'), /unsupported/u);
});
test('packaging requires a generated hook-call lexical marker, not a legacy assertion', () => {
	assertModuleInstantiationHook(
		'Module["instantiateWasm"](imports, receiveInstance)',
		'candidate'
	);
	assertModuleInstantiationHook(
		Buffer.from("Module['instantiateWasm'] (imports, receiveInstance)"),
		'candidate'
	);
	assert.throws(
		() =>
			assertModuleInstantiationHook(
				'assert(!Module["instantiateWasm"], "unsupported option")',
				'legacy'
			),
		/does not call/u
	);
	assert.throws(
		() => assertModuleInstantiationHook('var instantiateWasm = null', 'legacy'),
		/does not call/u
	);
});

test('post-link evidence binds input manifest, flags and exact output bytes', async () => {
	const { createHash } = await import('node:crypto');
	const { validatePostLinkExperiment } = await import('../scripts/post-link-experiment.mjs');
	const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
	const jsBytes = Buffer.from('generated-js'),
		wasmBytes = Buffer.from('generated-wasm');
	const manifest = JSON.stringify({ debugger: { lldb: { wasmSha256: 'b'.repeat(64) } } });
	const proof = {
		format: 'wasm-llvm-lldb-post-link-experiment-v1',
		fullSourceBuild: false,
		emsdkRevision: 'sdk',
		input: { manifest, manifestSha256: sha(manifest), wasmSha256: 'b'.repeat(64) },
		recoveredInputSha256: 'c'.repeat(64),
		commands: {
			featureRecovery: ['--emit-target-features'],
			postLink: ['--post-link', ...EMSCRIPTEN_LINK_FLAGS]
		},
		output: {
			js: { bytes: jsBytes.length, sha256: sha(jsBytes) },
			wasm: { bytes: wasmBytes.length, sha256: sha(wasmBytes) }
		}
	};
	const validate = (value) =>
		validatePostLinkExperiment(Buffer.from(JSON.stringify(value)), {
			jsBytes,
			wasmBytes,
			buildFlags: EMSCRIPTEN_LINK_FLAGS,
			emsdkRevision: 'sdk'
		});
	validate(proof);
	for (const mutate of [
		(value) => (value.fullSourceBuild = true),
		(value) => (value.input.manifest += ' '),
		(value) => value.commands.postLink.pop(),
		(value) => (value.output.wasm.sha256 = '0'.repeat(64)),
		(value) => (value.emsdkRevision = 'wrong')
	]) {
		const changed = structuredClone(proof);
		mutate(changed);
		assert.throws(() => validate(changed));
	}
});

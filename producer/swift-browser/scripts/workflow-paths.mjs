import { appendFileSync } from 'node:fs';
import path from 'node:path';

// Inputs arrive as data via the job environment, never interpolated shell text.
const temp = process.env.RUNNER_TEMP;
if (!temp || !process.env.GITHUB_ENV) throw new Error('GitHub workflow environment is required');
const build = path.join(temp, 'wasm-swift-build');
const values = {
	WASM_SWIFT_SOURCE_ROOT: process.env.SWIFT_INPUT_CHECKOUT_ROOT || path.join(temp, 'wasm-swift-source'),
	WASM_SWIFT_BUILD_DIR: build,
	WASM_SWIFT_RAW_RUNTIME_DIR: path.join(temp, 'wasm-swift-raw-runtime'),
	WASM_SWIFT_BUILD_PLAN: path.join(temp, 'wasm-idle-swift-browser-build-plan.json'),
	WASM_SWIFT_WORKFLOW_PREFLIGHT_RECEIPT: path.join(temp, 'wasm-swift-workflow-preflight.json'),
	WASM_SWIFT_BROWSER_BUILD_LOG: path.join(temp, 'wasm-swift-browser-build.log'),
	WASM_SWIFT_RUNNER_WORKER: path.join(build, 'runner-worker.js'),
	WASM_SWIFT_SWIFTC_WASM: path.join(build, 'swiftc.wasm'),
	WASM_SWIFT_SWIFTPM_WASM: path.join(build, 'swiftpm.wasm'),
	WASM_SWIFT_SDK_ARCHIVE: path.join(build, 'sdk.tar.gz'),
	WASM_SWIFT_BOOTSTRAP_RECEIPT: process.env.SWIFT_INPUT_SOURCE_BOOTSTRAP_RECEIPT || path.join(temp, 'wasm-swift-source-bootstrap-receipt.json')
};
for (const [name, value] of Object.entries(values)) {
	if (/[\r\n\0]/u.test(value)) throw new Error(`Invalid workflow path: ${name}`);
}
appendFileSync(process.env.GITHUB_ENV, Object.entries(values).map(([name, value]) => `${name}=${value}\n`).join(''));

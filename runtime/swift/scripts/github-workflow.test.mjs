import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

const REPO_ROOT = path.resolve(new URL('../../..', import.meta.url).pathname);
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'wasm-swift-runtime.yml');

function workflowInputBlock(workflow, name) {
	const match = new RegExp(`^ {12}${name}:\\n(?<body>(?:^ {16}[^\\n]+\\n?)+)`, 'mu').exec(workflow);
	assert.ok(match, `workflow_dispatch input ${name} should exist`);
	return match.groups.body;
}

function assertWorkflowInput(workflow, name, properties) {
	const block = workflowInputBlock(workflow, name);
	for (const [property, value] of Object.entries(properties)) {
		assert.match(block, new RegExp(`^ {16}${property}: ${value}$`, 'mu'), `${name}.${property}`);
	}
}

test('Swift runtime export workflow is manual and preserves verification gates', async () => {
	const workflow = await readFile(WORKFLOW_PATH, 'utf8');

	assert.match(workflow, /^on:\n\s+workflow_dispatch:/mu);
	assert.doesNotMatch(workflow, /pull_request:/u);
	assert.doesNotMatch(workflow, /push:/u);
	assert.match(workflow, /timeout-minutes:\s+720/u);
	assert.match(workflow, /swift_clone_depth:/u);
	assert.match(workflow, /Optional shallow clone depth for the initial swift\.git clone/u);
	assert.match(workflow, /swift_clone_filter:/u);
	assert.match(workflow, /Optional partial clone filter for the initial swift\.git clone/u);
	assert.match(workflow, /checkout_root:/u);
	assert.match(workflow, /source_bootstrap_receipt:/u);
	assert.match(workflow, /Passed source bootstrap receipt for checkout_root when bootstrap_source is false/u);
	assert.match(workflow, /browser_build_command:/u);
	assert.match(
		workflow,
		/Required shell command that produces runner-worker\.js, swiftc\.wasm, and swiftpm\.wasm before verification/u
	);
	assert.match(workflow, /min_free_gib:/u);
	assert.match(workflow, /Minimum free GiB required for large Swift checkout and build steps/u);
	assert.match(workflow, /default:\s+"80"/u);
	assert.match(workflow, /Prepare workflow paths/u);
	assert.match(workflow, /BOOTSTRAP_RECEIPT="\$\{\{\s*inputs\.source_bootstrap_receipt\s*\}\}"/u);
	assert.match(workflow, /BOOTSTRAP_RECEIPT="\$RUNNER_TEMP\/wasm-swift-source-bootstrap-receipt\.json"/u);
	assert.match(workflow, /WASM_SWIFT_BUILD_DIR/u);
	assert.match(workflow, /WASM_SWIFT_BUILD_PLAN/u);
	assert.match(workflow, /WASM_SWIFT_WORKFLOW_PREFLIGHT_RECEIPT=\$RUNNER_TEMP\/wasm-swift-workflow-preflight\.json/u);
	assert.match(workflow, /WASM_SWIFT_BROWSER_BUILD_LOG=\$RUNNER_TEMP\/wasm-swift-browser-build\.log/u);
	assert.match(workflow, /WASM_SWIFT_RUNNER_WORKER=\$RUNNER_TEMP\/wasm-swift-build\/runner-worker\.js/u);
	assert.match(workflow, /WASM_SWIFT_SWIFTC_WASM=\$RUNNER_TEMP\/wasm-swift-build\/swiftc\.wasm/u);
	assert.match(workflow, /WASM_SWIFT_SWIFTPM_WASM=\$RUNNER_TEMP\/wasm-swift-build\/swiftpm\.wasm/u);
	assert.match(workflow, /WASM_SWIFT_SDK_ARCHIVE=\$RUNNER_TEMP\/wasm-swift-build\/sdk\.tar\.gz/u);
	assert.match(
		workflow,
		/WASM_SWIFT_BOOTSTRAP_RECEIPT=\$BOOTSTRAP_RECEIPT/u
	);
	assert.match(workflow, /pnpm --dir runtime\/swift run workflow:preflight/u);
	assert.match(workflow, /--bootstrap-source/u);
	assert.match(workflow, /--source-root "\$WASM_SWIFT_SOURCE_ROOT"/u);
	assert.match(workflow, /--source-bootstrap-receipt "\$WASM_SWIFT_BOOTSTRAP_RECEIPT"/u);
	assert.match(workflow, /--build-dir "\$WASM_SWIFT_BUILD_DIR"/u);
	assert.match(workflow, /--min-free-gib "\$\{\{\s*inputs\.min_free_gib\s*\}\}"/u);
	assert.match(workflow, /--swift-clone-depth "\$\{\{\s*inputs\.swift_clone_depth\s*\}\}"/u);
	assert.match(workflow, /--swift-clone-filter "\$\{\{\s*inputs\.swift_clone_filter\s*\}\}"/u);
	assert.match(workflow, /--browser-build-command/u);
	assert.match(workflow, /--receipt "\$WASM_SWIFT_WORKFLOW_PREFLIGHT_RECEIPT"/u);
	assert.match(workflow, /ARGS\+=\(--browser-build-command/u);
	assert.match(workflow, /Probe native Swift\/Wasm baseline/u);
	assert.match(workflow, /pnpm --dir runtime\/swift run probe:toolchain/u);
	assert.match(workflow, /--run-wasm/u);
	assert.match(workflow, /--receipt "\$RUNNER_TEMP\/wasm-swift-toolchain-probe\.json"/u);
	assert.match(workflow, /pnpm --dir runtime\/swift run bootstrap:source/u);
	assert.match(workflow, /--source-root "\$WASM_SWIFT_SOURCE_ROOT"[\s\S]*--min-free-gib "\$\{\{\s*inputs\.min_free_gib\s*\}\}"[\s\S]*--execute/u);
	assert.match(workflow, /--receipt "\$WASM_SWIFT_BOOTSTRAP_RECEIPT"/u);
	assert.match(workflow, /inputs\.swift_clone_depth/u);
	assert.match(workflow, /ARGS\+=\(--swift-clone-depth "\$\{\{\s*inputs\.swift_clone_depth\s*\}\}"\)/u);
	assert.match(workflow, /inputs\.swift_clone_filter/u);
	assert.match(workflow, /ARGS\+=\(--swift-clone-filter "\$\{\{\s*inputs\.swift_clone_filter\s*\}\}"\)/u);
	assert.match(workflow, /pnpm --dir runtime\/swift run build:browser-compiler/u);
	assert.match(workflow, /--browser-build-log "\$WASM_SWIFT_BROWSER_BUILD_LOG"/u);
	assert.match(workflow, /ARGS\+=\(--execute-browser-build-command\)/u);
	assert.match(workflow, /ARGS\+=\(--discover-build-outputs\)/u);
	assert.match(workflow, /if \[ -f "\$WASM_SWIFT_BOOTSTRAP_RECEIPT" \]; then/u);
	assert.match(workflow, /ARGS\+=\(--source-bootstrap-receipt "\$WASM_SWIFT_BOOTSTRAP_RECEIPT"\)/u);
	assert.match(workflow, /Print browser compiler output contract/u);
	assert.match(workflow, /browser_build_command must produce the browser-hosted Swift runtime outputs/u);
	assert.match(workflow, /runner-worker\.js: \$\{WASM_SWIFT_RUNNER_WORKER\}/u);
	assert.match(workflow, /swiftc\.wasm: \$\{WASM_SWIFT_SWIFTC_WASM\}/u);
	assert.match(workflow, /swiftpm\.wasm: \$\{WASM_SWIFT_SWIFTPM_WASM\}/u);
	assert.match(workflow, /sdk\.tar\.gz: \$\{WASM_SWIFT_SDK_ARCHIVE\}/u);
	assert.match(workflow, /wasm-swift-output-contract\.txt/u);
	assert.doesNotMatch(workflow, /Run browser compiler build command/u);
	assert.match(workflow, /Summarize browser compiler outputs/u);
	assert.match(workflow, /runner-worker\.js:\$\{WASM_SWIFT_RUNNER_WORKER\}/u);
	assert.match(workflow, /swiftc\.wasm:\$\{WASM_SWIFT_SWIFTC_WASM\}/u);
	assert.match(workflow, /swiftpm\.wasm:\$\{WASM_SWIFT_SWIFTPM_WASM\}/u);
	assert.match(workflow, /sdk\.tar\.gz:\$\{WASM_SWIFT_SDK_ARCHIVE\}/u);
	assert.match(workflow, /present \(\$\{bytes\} bytes\) at/u);
	assert.match(workflow, /missing at \$\{file\}/u);
	assert.match(workflow, /wasm-swift-output-summary\.txt/u);
	assert.match(workflow, /Discover browser compiler outputs/u);
	assert.match(workflow, /inputs\.runner_worker == '' && inputs\.swiftc_wasm == '' && inputs\.swiftpm_wasm == '' && inputs\.sdk_archive == ''/u);
	assert.match(workflow, /pnpm --dir runtime\/swift run discover:build-outputs/u);
	assert.match(workflow, /--build-dir "\$WASM_SWIFT_BUILD_DIR"/u);
	assert.match(workflow, /--plan "\$WASM_SWIFT_BUILD_PLAN"/u);
	assert.match(workflow, /--allow-official-sdk-placeholder/u);
	assert.match(workflow, /--write-plan/u);
	assert.match(workflow, /pnpm --dir runtime\/swift run run:upstream-baseline/u);
	assert.match(workflow, /--plan "\$WASM_SWIFT_BUILD_PLAN"[\s\S]*--min-free-gib "\$\{\{\s*inputs\.min_free_gib\s*\}\}"[\s\S]*--preset buildbot_linux_crosscompile_wasm/u);
	assert.match(workflow, /pnpm --dir runtime\/swift run verify:build-outputs/u);
	assert.match(workflow, /--require-browser-compiler-contracts/u);
	assert.match(workflow, /--require-browser-build-command/u);
	assert.match(workflow, /--require-browser-build-execution/u);
	assert.match(workflow, /--require-browser-build-log/u);
	assert.match(workflow, /--require-source-bootstrap-provenance/u);
	assert.match(workflow, /--require-upstream-baseline-receipt/u);
	assert.match(workflow, /--workflow-preflight-receipt "\$WASM_SWIFT_WORKFLOW_PREFLIGHT_RECEIPT"/u);
	assert.match(workflow, /pnpm --dir runtime\/swift run package:from-plan/u);
	assert.match(workflow, /pnpm --dir runtime\/swift run export:runtime/u);
	assert.match(workflow, /EXPORT_ARGS\+=\(--url/u);
	assert.doesNotMatch(workflow, /pnpm run export:wasm-swift --/u);
	assert.match(workflow, /Write consumer integration guide/u);
	assert.match(workflow, /runtime\/swift\/out\/PROMOTE\.md/u);
	assert.match(workflow, /Consume the exported descriptor from wasm-idle/u);
	assert.match(workflow, /actions\/upload-artifact@v4/u);
	assert.match(workflow, /runtime\/swift\/out\/\*\.tar\.gz/u);
	assert.match(workflow, /runtime\/swift\/out\/\*\.sha256/u);
	assert.match(workflow, /runtime\/swift\/out\/\*\.json/u);
	assert.match(workflow, /runtime\/swift\/out\/PROMOTE\.md/u);
	assert.match(workflow, /if-no-files-found:\s+error/u);
	assert.match(workflow, /name:\s+wasm-swift-runtime-diagnostics/u);
	assert.match(workflow, /if:\s+\$\{\{\s*always\(\)\s*\}\}/u);
	assert.match(workflow, /\$\{\{\s*runner\.temp\s*\}\}\/wasm-swift-output-contract\.txt/u);
	assert.match(workflow, /\$\{\{\s*runner\.temp\s*\}\}\/wasm-swift-output-summary\.txt/u);
	assert.match(workflow, /\$\{\{\s*env\.WASM_SWIFT_WORKFLOW_PREFLIGHT_RECEIPT\s*\}\}/u);
	assert.match(workflow, /\$\{\{\s*runner\.temp\s*\}\}\/wasm-swift-toolchain-probe\.json/u);
	assert.match(workflow, /\$\{\{\s*env\.WASM_SWIFT_BROWSER_BUILD_LOG\s*\}\}/u);
	assert.match(workflow, /\$\{\{\s*env\.WASM_SWIFT_BOOTSTRAP_RECEIPT\s*\}\}/u);
	assert.match(workflow, /\$\{\{\s*env\.WASM_SWIFT_BUILD_PLAN\s*\}\}/u);
	assert.match(workflow, /runtime\/swift\/dist\/runtime-build\.json/u);
	assert.match(workflow, /runtime\/swift\/dist\/runtime-manifest\.v1\.json/u);
	assert.match(workflow, /if-no-files-found:\s+ignore/u);
});

test('Swift runtime export workflow keeps dispatch inputs explicit', async () => {
	const workflow = await readFile(WORKFLOW_PATH, 'utf8');

	assertWorkflowInput(workflow, 'swift_ref', {
		required: 'false',
		default: 'main',
	});
	assertWorkflowInput(workflow, 'swift_clone_depth', {
		required: 'false',
	});
	assertWorkflowInput(workflow, 'swift_clone_filter', {
		required: 'false',
	});
	assertWorkflowInput(workflow, 'dependency_scheme', {
		required: 'false',
		default: 'main',
	});
	assertWorkflowInput(workflow, 'bootstrap_source', {
		required: 'true',
		type: 'boolean',
		default: 'false',
	});
	assertWorkflowInput(workflow, 'allow_existing_checkout', {
		required: 'true',
		type: 'boolean',
		default: 'true',
	});
	assertWorkflowInput(workflow, 'min_free_gib', {
		required: 'true',
		default: '"80"',
	});
	assertWorkflowInput(workflow, 'checkout_root', {
		required: 'false',
	});
	assertWorkflowInput(workflow, 'source_bootstrap_receipt', {
		required: 'false',
	});
	assertWorkflowInput(workflow, 'browser_build_command', {
		required: 'true',
	});
	assertWorkflowInput(workflow, 'runner_worker', {
		required: 'false',
	});
	assertWorkflowInput(workflow, 'swiftc_wasm', {
		required: 'false',
	});
	assertWorkflowInput(workflow, 'swiftpm_wasm', {
		required: 'false',
	});
	assertWorkflowInput(workflow, 'sdk_archive', {
		required: 'false',
	});
	assertWorkflowInput(workflow, 'swift_version', {
		required: 'true',
		default: '6.3.3',
	});
	assertWorkflowInput(workflow, 'wasm_sdk_id', {
		required: 'true',
		default: 'swift-6.3.3-RELEASE_wasm',
	});
	assertWorkflowInput(workflow, 'published_url', {
		required: 'false',
	});
});

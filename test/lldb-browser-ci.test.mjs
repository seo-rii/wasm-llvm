import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('CI gates pinned LLDB and WAMR browser producer contracts', async () => {
	const workflow = await fs.readFile('.github/workflows/lldb-browser.yml', 'utf8');

	assert.match(workflow, /pull_request:/);
	assert.match(workflow, /branches: \[main\]/);
	assert.match(
		workflow,
		/node --test producer\/lldb-browser\/test\/producer\.test\.mjs producer\/wamr-browser\/test\/\*\.test\.mjs test\/debug-release\.test\.mjs test\/lldb-browser-ci\.test\.mjs/
	);
	assert.doesNotMatch(workflow, /continue-on-error:\s*true/);
});

test('native feature gates use rebuilt patched Clang and LLDB for real DAP hit conditions', async () => {
	const workflow = await fs.readFile('.github/workflows/lldb-browser.yml', 'utf8');
	assert.match(workflow, /HIT_COUNT_PROGRAM_PATH: \/tmp\/wasm-native-debug\/hit-count\.wasm/u);
	const native = workflow.match(/^    native-baseline:[\s\S]*$/mu)?.[0];
	assert.ok(native);
	assert.match(native, /timeout-minutes: 180/u);
	const hostDependencies = native.match(/- name: Install native baseline host dependencies[\s\S]*?(?=            - uses:)/u)?.[0];
	assert.ok(hostDependencies);
	assert.match(hostDependencies, /(?:^|\s)python3(?:\s|$)/u,
		'LLVM CMake requires the Python interpreter even with LLDB_ENABLE_PYTHON=OFF');
	assert.match(native, /test ! -e "\$NATIVE_FEATURE_ROOT"/u);
	assert.match(native, /test ! -e "\$NATIVE_FEATURE_BUILD"/u);
	assert.match(native, /fetch --depth 1 origin ca7933e47d3a3451d81e72ac174dcb5aa28b59d1/u);
	assert.match(native, /await verifyLockedInputs\(lock\)/u);
	assert.match(native, /digest\(await fs\.readFile\(file\)\), patch\.sha256/u);
	assert.match(native, /clang\.sources\.wasmFunctionEndPatch/u);
	for (const patch of ['0007-wasm-recursive-frame-cfa', '0010-wasm-caller-pc-cache',
		'0011-libcxx-container-adaptors', '0012-lldb-dap-clear-hit-condition']) {
		assert.ok(native.includes(`${patch}.patch`));
	}
	assert.match(native, /--target clang lldb lldb-dap --parallel 2/u);
	assert.match(native, /-DLLVM_PARALLEL_LINK_JOBS=1/u);
	assert.match(native, /-DLLDB_ENABLE_PYTHON=OFF/u);
	assert.match(native, /--lldb "\$NATIVE_FEATURE_BUILD\/bin\/lldb"[\s\S]*?--program "\$FUNCTION_END_PROGRAM_PATH" --kind function-end/u);
	assert.match(native, /--lldb "\$NATIVE_FEATURE_BUILD\/bin\/lldb"[\s\S]*?--program "\$CONTAINER_ADAPTORS_PROGRAM_PATH" --kind container-adaptors/u);
	assert.match(native, /run-native-hit-condition-baseline\.mjs[\s\S]*?--lldb-dap "\$NATIVE_FEATURE_BUILD\/bin\/lldb-dap"[\s\S]*?--program "\$HIT_COUNT_PROGRAM_PATH" --case all/u);
	const compile = native.match(/- name: Compile and verify debugger feature fixtures with patched Clang[\s\S]*?(?=            - name:)/u)?.[0];
	assert.ok(compile);
	assert.equal((compile.match(/"\$NATIVE_FEATURE_BUILD\/bin\/clang"/gu) ?? []).length, 3);
	assert.equal((compile.match(/-fuse-ld="\$LLVM_ROOT\/bin\/wasm-ld"/gu) ?? []).length, 3);
	assert.match(compile, /include\/wasm32-wasip1\/noeh\/c\+\+\/v1/u);
	assert.match(compile, /lib\/wasm32-wasip1\/noeh/u);
	assert.equal((compile.match(/-stdlib=libc\+\+ -fno-exceptions -nostdinc\+\+/gu) ?? []).length, 2);
	assert.equal((compile.match(/-isystem "\$FEATURE_CPP_HEADERS" -L"\$FEATURE_CPP_LIBS"/gu) ?? []).length, 2);
	assert.doesNotMatch(compile, /"\$LLVM_ROOT\/bin\/clang"/u);
	assert.match(native, /sha256sum --check "\$NATIVE_FEATURE_ROOT\/built-binaries\.sha256"/u);
	assert.match(native, /"\$NATIVE_FEATURE_BUILD\/lib\/liblldb\.so"/u);
	assert.doesNotMatch(workflow, /--kind skip-library/u);
	assert.match(workflow, /llvm-dwarfdump" --verify "\$HIT_COUNT_PROGRAM_PATH"/u);
	const runner = await fs.readFile('test/native-wasm-debug/run-native-cpp-baseline.mjs', 'utf8');
	assert.match(runner, /step-avoid-regexp \^\$/u);
	assert.match(runner, /stop reason = breakpoint 3/u);
});

test('current artifact provenance stays mandatory and independent of source regeneration', async () => {
	const workflow = await fs.readFile('.github/workflows/lldb-browser.yml', 'utf8');
	const producerContracts = workflow.match(
		/^    producer-contracts:[\s\S]*?(?=^    [\w-]+:|(?![\s\S]))/mu
	)?.[0];
	const runtimeSourceProvenance = workflow.match(
		/^    runtime-source-provenance:[\s\S]*?(?=^    [\w-]+:|(?![\s\S]))/mu
	)?.[0];
	const clangArtifactProvenance = workflow.match(
		/^    clang-artifact-provenance:[\s\S]*?(?=^    [\w-]+:|(?![\s\S]))/mu
	)?.[0];
	const buildProduct = workflow.match(
		/^    build-product:[\s\S]*?(?=^    [\w-]+:|(?![\s\S]))/mu
	)?.[0];

	assert.ok(producerContracts, 'producer-contracts job must exist');
	assert.ok(runtimeSourceProvenance, 'runtime-source-provenance job must exist');
	assert.ok(clangArtifactProvenance, 'clang-artifact-provenance job must exist');
	assert.ok(buildProduct, 'build-product job must exist');
	assert.doesNotMatch(producerContracts, /debug-runtime-source\.test\.mjs/u);
	assert.doesNotMatch(producerContracts, /pnpm (?:verify|smoke):clang-artifacts/u);
	assert.match(clangArtifactProvenance, /uses: actions\/checkout@v4/u);
	assert.match(clangArtifactProvenance, /uses: actions\/setup-node@v4/u);
	assert.match(clangArtifactProvenance, /node-version: 24/u);
	assert.match(clangArtifactProvenance, /uses: pnpm\/action-setup@v4/u);
	assert.match(clangArtifactProvenance, /pnpm install --frozen-lockfile/u);
	assert.match(clangArtifactProvenance, /run: pnpm verify:clang-artifacts/u);
	assert.match(clangArtifactProvenance, /run: pnpm smoke:clang-artifacts/u);
	assert.doesNotMatch(clangArtifactProvenance, /continue-on-error|^        (?:needs|if):/mu);
	assert.match(
		runtimeSourceProvenance,
		/node --test test\/debug-runtime-source\.test\.mjs/u
	);
	assert.doesNotMatch(runtimeSourceProvenance, /continue-on-error:\s*true/u);
	assert.doesNotMatch(runtimeSourceProvenance, /^\s+needs:/mu);
	assert.match(buildProduct, /^        needs: producer-contracts$/mu);
	assert.doesNotMatch(buildProduct, /runtime-source-provenance/u);
	assert.doesNotMatch(buildProduct, /clang-artifact-provenance/u);
});

test('documents the two-phase producer regeneration gate', async () => {
	const readme = await fs.readFile('producer/lldb-browser/README.md', 'utf8');

	assert.match(readme, /source and patch contracts gate the product build/u);
	assert.match(readme, /runtime-source provenance runs independently/u);
	assert.match(readme, /clang-artifact-provenance/u);
	assert.match(readme.replace(/\s+/gu, ' '), /All three gates must be green before merge, release, or promotion/u);
});

test('scheduled and manual CI rebuild and upload the pinned LLDB and WAMR browser products', async () => {
	const workflow = await fs.readFile('.github/workflows/lldb-browser.yml', 'utf8');

	assert.match(workflow, /build_product:/);
	assert.match(
		workflow,
		/build-product:\s+needs: producer-contracts\s+if: github\.event_name == 'schedule' \|\| \(github\.event_name == 'workflow_dispatch' && inputs\.build_product\)/su
	);
	assert.match(workflow, /node producer\/lldb-browser\/scripts\/prepare\.mjs/);
	assert.match(
		workflow,
		/LLDB_PRODUCT_WORK: artifacts\/lldb-browser-build-a/u
	);
	assert.match(
		workflow,
		/LLDB_REPRO_WORK: artifacts\/lldb-browser-build-b/u
	);
	assert.match(
		workflow,
		/LLDB_PRODUCT_OUTPUT: artifacts\/lldb-browser/u
	);
	assert.match(
		workflow,
		/LLDB_REPRO_OUTPUT: artifacts\/lldb-browser-repro/u
	);
	assert.match(
		workflow,
		/node producer\/lldb-browser\/scripts\/prepare\.mjs \\\s+--work-dir "\$LLDB_PRODUCT_WORK" \\\s+--emsdk-dir "\$LLDB_EMSDK"/su
	);
	assert.match(
		workflow,
		/node producer\/lldb-browser\/scripts\/build\.mjs \\\s+--work-dir "\$LLDB_PRODUCT_WORK" \\\s+--emsdk-dir "\$LLDB_EMSDK" \\\s+--out-dir "\$LLDB_PRODUCT_OUTPUT"/su
	);
	assert.match(
		workflow,
		/node producer\/lldb-browser\/scripts\/verify\.mjs "\$LLDB_PRODUCT_OUTPUT"/u
	);
	assert.match(
		workflow,
		/node producer\/lldb-browser\/scripts\/prepare\.mjs \\\s+--work-dir "\$LLDB_REPRO_WORK" \\\s+--emsdk-dir "\$LLDB_EMSDK" \\\s+--skip-emsdk-install/su
	);
	assert.match(
		workflow,
		/node producer\/lldb-browser\/scripts\/build\.mjs \\\s+--work-dir "\$LLDB_REPRO_WORK" \\\s+--emsdk-dir "\$LLDB_EMSDK" \\\s+--out-dir "\$LLDB_REPRO_OUTPUT"/su
	);
	assert.match(
		workflow,
		/node producer\/lldb-browser\/scripts\/verify-reproducibility\.mjs \\\s+"\$LLDB_PRODUCT_OUTPUT" \\\s+"\$LLDB_REPRO_OUTPUT"/su
	);
	assert.match(
		workflow,
		/WAMR_PRODUCT_COMMIT: 25bd7eb63e828e4bd242cc9b38d260b4b31c6605/
	);
	assert.match(
		workflow,
		/node producer\/wamr-browser\/scripts\/prepare\.mjs --source "\$WAMR_PRODUCT_SOURCE"/
	);
	assert.match(
		workflow,
		/WAMR_REPRO_SOURCE: artifacts\/wamr-browser-repro-build\/wasm-micro-runtime/
	);
	assert.match(
		workflow,
		/node producer\/wamr-browser\/scripts\/prepare\.mjs --source "\$WAMR_REPRO_SOURCE"/
	);
	assert.match(
		workflow,
		/node producer\/wamr-browser\/scripts\/build\.mjs[\s\S]*?--emsdk "\$LLDB_EMSDK"/su
	);
	assert.match(
		workflow,
		/node producer\/wamr-browser\/scripts\/package\.mjs[\s\S]*?--output artifacts\/wamr-browser/su
	);
	assert.match(
		workflow,
		/node producer\/wamr-browser\/scripts\/verify\.mjs --artifacts artifacts\/wamr-browser/
	);
	assert.match(
		workflow,
		/node producer\/wamr-browser\/scripts\/build\.mjs[\s\S]*?--source "\$WAMR_REPRO_SOURCE"[\s\S]*?--build "\$WAMR_REPRO_BUILD"/su
	);
	assert.match(
		workflow,
		/node producer\/wamr-browser\/scripts\/package\.mjs[\s\S]*?--output artifacts\/wamr-browser-repro/su
	);
	assert.match(
		workflow,
		/node producer\/wamr-browser\/scripts\/verify-reproducibility\.mjs \\\s+artifacts\/wamr-browser \\\s+artifacts\/wamr-browser-repro/su
	);
	assert.match(workflow, /uses: actions\/upload-artifact@v4/);
	assert.match(
		workflow,
		/path: \|\s+artifacts\/lldb-browser\s+artifacts\/wamr-browser/su
	);
});

test('contract pushes cannot cancel an in-flight manual LLDB product build', async () => {
	const workflow = await fs.readFile('.github/workflows/lldb-browser.yml', 'utf8');

	assert.match(
		workflow,
		/build-product:\s+needs: producer-contracts\s+if:.*?\s+concurrency:\s+group: lldb-browser-product-\$\{\{ github\.ref \}\}\s+cancel-in-progress: false/su
	);
	assert.match(
		workflow,
		/producer-contracts:\s+concurrency:\s+group: lldb-browser-contracts-\$\{\{ github\.ref \}\}\s+cancel-in-progress: true/su
	);
});

test('full Clang regeneration is manual, isolated, and bounded independently of stale delivery assets', async () => {
	const workflow = await fs.readFile('.github/workflows/lldb-browser.yml', 'utf8');
	assert.match(workflow, /build_clang:[\s\S]*?type: boolean\s+default: false/u);
	const job = workflow.match(/^    build-clang:[\s\S]*?(?=^    [\w-]+:|(?![\s\S]))/mu)?.[0];
	assert.ok(job);
	assert.match(job, /^        needs: producer-contracts$/mu);
	assert.match(job, /^        if: github\.event_name == 'workflow_dispatch' && inputs\.build_clang$/mu);
	assert.match(job, /group: clang-browser-product-\$\{\{ github\.ref \}\}\s+cancel-in-progress: false/u);
	assert.match(job, /timeout-minutes: 360/u);
	assert.match(job, /NINJA_JOBS: '2'/u);
	assert.doesNotMatch(job.split('        steps:')[0], /runner\./u,
		'the runner context is unavailable in job-level env');
	assert.match(job, /(?:^|\s)python3(?:\s|$)/u);
	assert.match(job, /availableDisk >= 20 \* 1024 \*\* 3/u);
	assert.match(job, /availableMemory >= 12 \* 1024 \*\* 3/u);
	assert.match(job, /assert\.rejects\(fs\.stat\(directory\), \{ code: 'ENOENT' \}\)/u);
	assert.match(job, /^                    node producer\/clang-browser\/scripts\/build-toolchain\.mjs$/mu);
	assert.doesNotMatch(job, /--compiler-only|actions\/cache@|continue-on-error|contents: write|gh release/u);
});

test('Clang outputs upload only after current-receipt verification while failed builds retain private evidence', async () => {
	const workflow = await fs.readFile('.github/workflows/lldb-browser.yml', 'utf8');
	const job = workflow.match(/^    build-clang:[\s\S]*?(?=^    [\w-]+:|(?![\s\S]))/mu)?.[0];
	assert.ok(job);
	const output = job.match(/printf 'WASM_LLVM_TOOLCHAIN_OUT_DIR=%s([^']+)'/u)?.[1];
	assert.ok(output);
	assert.equal(job.match(/printf 'WASM_LLVM_CLANG_ARTIFACT_DIR=%s([^']+)'/u)?.[1], output);
	assert.match(job, /umask 077/u);
	assert.match(job, /\) > "\$clang_log" 2>&1 &/u);
	assert.match(job, /build\.pid/u);
	assert.match(job, /build\.status\.json/u);
	assert(job.indexOf('wait "$clang_pid"') < job.indexOf('tail -n 80 "$clang_log"'));
	assert.match(job, /loadVerifiedClangArtifacts\(process\.env\.WASM_LLVM_CLANG_ARTIFACT_DIR, \{ requireBuildReceipt: true \}\)/u);
	assert.match(job, /pnpm smoke:clang-artifacts/u);
	assert.match(job, /if: steps\.clang-verify\.conclusion == 'success'\s+with:\s+name: clang-browser-/u);
	assert.match(job, /if: always\(\)\s+with:\s+name: clang-browser-evidence-/u);
	assert.match(job, /source-commit\.txt/u);
});

test('the background Clang build preserves a producer failure and its final private log', async () => {
	const workflow = await fs.readFile('.github/workflows/lldb-browser.yml', 'utf8');
	const block = workflow.match(/- name: Build all pinned Clang producer outputs[\s\S]*?run: \|\n([\s\S]*?)(?=            - name:)/u)?.[1];
	assert.ok(block);
	const directory = await fs.mkdtemp(path.join(tmpdir(), 'clang-ci-failure-'));
	try {
		const script = block.replace(/^ {18}/gmu, '')
			.replaceAll('$HOME/logs', '${CLANG_TEST_LOG_DIR}')
			.replace('node producer/clang-browser/scripts/build-toolchain.mjs',
				`node -e 'console.log("compiler failure"); process.exit(7)'`);
		const evidence = path.join(directory, 'evidence');
		const logDirectory = path.join(directory, 'logs');
		const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
			encoding: 'utf8', timeout: 10_000,
			env: { ...process.env, CLANG_BUILD_EVIDENCE: evidence, CLANG_TEST_LOG_DIR: logDirectory,
				GITHUB_OUTPUT: path.join(directory, 'outputs'), GITHUB_RUN_ID: 'fixture', GITHUB_RUN_ATTEMPT: '1' }
		});
		assert.equal(result.status, 7, result.stderr);
		assert.deepEqual(JSON.parse(await fs.readFile(path.join(evidence, 'build.status.json'), 'utf8')), { exitCode: 7 });
		assert.match(await fs.readFile(path.join(evidence, 'build.pid'), 'utf8'), /^\d+\n$/u);
		const log = path.join(logDirectory, 'clang-browser-fixture-1.log');
		assert.equal(await fs.readFile(log, 'utf8'), 'compiler failure\n');
		assert.equal((await fs.stat(log)).mode & 0o777, 0o600);
		assert.equal((await fs.stat(logDirectory)).mode & 0o777, 0o700);
		assert.match(result.stdout, /compiler failure/u);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test('scheduled and manual CI run the pinned native C and DAP baselines', async () => {
	const workflow = await fs.readFile('.github/workflows/lldb-browser.yml', 'utf8');

	assert.match(workflow, /schedule:\s+- cron: '17 4 \* \* 1'/u);
	assert.match(workflow, /native_baseline:/u);
	assert.match(
		workflow,
		/native-baseline:\s+if: github\.event_name == 'schedule' \|\| \(github\.event_name == 'workflow_dispatch' && inputs\.native_baseline\)/su
	);
	assert.match(
		workflow,
		/LLVM_ARCHIVE_SHA256: df0e1ecf16caf3489a272a5eea4eec9b0d82878f6477fa309504f918a0006384/u
	);
	assert.match(
		workflow,
		/WASI_SDK_SHA256: 0ba8b5bfaeb2adf3f29bab5841d76cf5318ab8e1642ea195f88baba1abd47bce/u
	);
	assert.match(
		workflow,
		/WAMR_COMMIT: 25bd7eb63e828e4bd242cc9b38d260b4b31c6605/u
	);
	assert.match(
		workflow,
		/C_FIXTURE_SHA256: 226c0c142d2430d107927fef8aadd672bb8ed6b3ae1744c539e792bb8475bec3/u
	);
	assert.match(
		workflow,
		/TRAP_FIXTURE_SHA256: 6ed12195841585bcbc57ba561f8a2be273cf95ce1f6e564eeb11d2e29e5db126/u
	);
	assert.match(
		workflow,
		/INTERRUPT_FIXTURE_SHA256: daa689fe7f83b39bfae4d7e9c0a06943eec05350b72fe95694bf74c135ca9876/u
	);
	assert.match(workflow, /NATIVE_ROOT: \/tmp\/wasm-native-debug/u);
	assert.match(workflow, /TRAP_PROGRAM_PATH: \/tmp\/wasm-native-debug\/trap\.wasm/u);
	assert.match(
		workflow,
		/INTERRUPT_PROGRAM_PATH: \/tmp\/wasm-native-debug\/interrupt\.wasm/u
	);
	assert.doesNotMatch(
		workflow,
		/(?:NATIVE_ROOT|LLVM_ROOT|WASI_ROOT|WAMR_ROOT|PROGRAM_PATH|TRAP_PROGRAM_PATH|INTERRUPT_PROGRAM_PATH): \$\{\{ runner\.temp \}\}/u
	);
	assert.match(workflow, /actions\/cache@v4/u);
	assert.match(workflow, /path: \/tmp\/wasm-native-debug\/downloads/u);
	assert.match(workflow, /bin\/lldb" --version.*22\.1\.8/su);
	assert.match(workflow, /-fdebug-compilation-dir=\/workspace/u);
	assert.match(workflow, /-ffile-prefix-map=.*=\/workspace/u);
	assert.match(workflow, /llvm-dwarfdump" --verify/u);
	assert.match(
		workflow,
		/llvm-dwarfdump" --debug-info.*grep --fixed-strings "\/workspace\/main\.c"/su
	);
	assert.match(
		workflow,
		/echo "\$C_FIXTURE_SHA256  \$PROGRAM_PATH" \| sha256sum --check/u
	);
	assert.match(
		workflow,
		/echo "\$TRAP_FIXTURE_SHA256  \$TRAP_PROGRAM_PATH" \| sha256sum --check/u
	);
	assert.match(
		workflow,
		/echo "\$INTERRUPT_FIXTURE_SHA256  \$INTERRUPT_PROGRAM_PATH" \| sha256sum --check/u
	);
	assert.match(workflow, /run-native-baseline\.mjs/u);
	assert.match(workflow, /run-native-dap-baseline\.mjs/u);
	assert.match(
		workflow,
		/run-native-dap-baseline\.mjs[\s\S]*?--repeat 10/u
	);
	assert.match(
		workflow,
		/run-native-dap-baseline\.mjs[\s\S]*?--program "\$TRAP_PROGRAM_PATH"[\s\S]*?--scenario trap/u
	);
	assert.match(
		workflow,
		/run-native-dap-baseline\.mjs[\s\S]*?--program "\$INTERRUPT_PROGRAM_PATH"[\s\S]*?--scenario interrupt/u
	);
	assert.doesNotMatch(
		workflow,
		/native-baseline:[\s\S]*?continue-on-error:\s*true/u
	);
});

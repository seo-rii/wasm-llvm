import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const producerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adapterPath = path.join(
	producerDir,
	'adapter',
	'cmd',
	'tinygo-browser-adapter',
	'main.go'
);
const patchPath = path.join(producerDir, 'patches', 'tinygo-wasi-adapter.patch');

function addedFile(patch, relativePath) {
	const marker = `diff --git a/${relativePath} b/${relativePath}\n`;
	const start = patch.indexOf(marker);
	assert.notEqual(start, -1, `patch must add ${relativePath}`);
	const next = patch.indexOf('\ndiff --git ', start + marker.length);
	const section = patch.slice(start, next === -1 ? patch.length : next);
	assert.match(section, /\nnew file mode \d+\n/);
	const hunk = section.indexOf('\n@@ ');
	assert.notEqual(hunk, -1, `${relativePath} must have a patch hunk`);
	const hunkHeaderEnd = section.indexOf('\n', hunk + 1);
	const hunkHeader = section.slice(hunk + 1, hunkHeaderEnd);
	const countMatch = /^@@ -0,0 \+1,(\d+) @@$/u.exec(hunkHeader);
	assert.ok(countMatch, `${relativePath} must use one exact new-file hunk`);
	const addedLines = section
		.slice(hunkHeaderEnd + 1)
		.split('\n')
		.filter((line) => line.startsWith('+') && !line.startsWith('+++'))
		.map((line) => line.slice(1));
	assert.equal(
		addedLines.length,
		Number(countMatch[1]),
		`${relativePath} hunk count must cover the complete added file`
	);
	return `${addedLines.join('\n')}\n`;
}

test('the adapter delegates Go semantics to the upstream TinyGo builder', async () => {
	const source = await readFile(adapterPath, 'utf8');

	assert.match(source, /"github\.com\/tinygo-org\/tinygo\/builder"/);
	assert.match(source, /"github\.com\/tinygo-org\/tinygo\/compileopts"/);
	assert.match(source, /"github\.com\/tinygo-org\/tinygo\/cgo"/);
	assert.match(source, /libclang/);
	assert.match(source, /builder\.NewConfig\(/);
	assert.match(source, /builder\.Build\([^;]*temporaryObject/s);
	assert.doesNotMatch(source, /"go\/(?:ast|parser|scanner|token)"/);
	assert.doesNotMatch(source, /\b(?:parseGo|lower|emitWasm|emitLLVM)\b/i);
});

test('the adapter emits a verified object set and an executable external finalization plan', async () => {
	const [source, patch] = await Promise.all([
		readFile(adapterPath, 'utf8'),
		readFile(patchPath, 'utf8')
	]);

	assert.match(source, /objects\/0000-program\.o/);
	assert.match(source, /objects\/%04d-embed\.o/);
	assert.match(source, /"target-c\.bc"/);
	assert.match(source, /"target-cxx\.bc"/);
	assert.match(source, /"target-assembly\.o"/);
	assert.match(source, /buildResult\.AuxiliaryObjects/);
	assert.match(source, /sourceSha256/);
	assert.match(source, /embeddedFileHash/);
	assert.match(source, /EmbeddedFileHash != object\.SourceSHA256\[:sha256\.Size\]/);
	assert.match(source, /sha256\.Sum256/);
	assert.match(source, /SchemaVersion:\s+5/);
	assert.match(source, /go-embed-objects/);
	assert.match(source, /target-cgo-c/);
	assert.match(source, /target-cxx-hosted-noeh/);
	assert.match(source, /target-clang-assembly/);
	assert.match(source, /LibCxx\s+string\s+`json:"libCxx"`/);
	assert.match(source, /LibCxxAbi\s+string\s+`json:"libCxxAbi"`/);
	assert.match(patch, /"-stdlib=libc\+\+"/);
	assert.doesNotMatch(patch, /"-ffreestanding"|"-nostdinc\+\+"/);
	assert.match(source, /runtime\.LibCxx/);
	assert.match(source, /runtime\.LibCxxAbi/);
	assert.match(source, /validateLLVMObject/);
	assert.match(source, /hasWasmRelocatableFraming/);
	assert.match(source, /builder\.ValidateWasmObject/);
	assert.match(source, /"linking"/);
	assert.match(source, /collectCGoInputs/);
	assert.match(source, /collectDependencies/);
	assert.match(source, /link-plan\.json/);
	assert.match(source, /program\.unoptimized\.wasm/);
	assert.match(source, /program\.wasm/);
	assert.match(source, /config\.LDFlags\(\)/);
	assert.match(source, /config\.CPU\(\)/);
	assert.match(source, /config\.Features\(\)/);
	assert.match(source, /config\.ExtraFiles\(\)/);
	assert.match(source, /--asyncify/);
	assert.doesNotMatch(source, /thinlto-cache-dir/);
	assert.doesNotMatch(source, /"os\/exec"|exec\.Command/);
});

test('target-native objects cross pinned LLVM validators before publication evidence', async () => {
	const [source, patch] = await Promise.all([
		readFile(adapterPath, 'utf8'),
		readFile(patchPath, 'utf8')
	]);

	assert.match(source, /compiler\.NewTargetMachine/);
	assert.match(source, /context\.ParseBitcodeFile/);
	assert.match(source, /llvm\.VerifyModule\(module, llvm\.ReturnStatusAction\)/);
	assert.match(source, /wasm32-unknown-wasi/);
	assert.match(
		source,
		/e-m:e-p:32:32-p10:8:8-p20:8:8-i64:64-i128:128-n32:64-S128-ni:1:10:20/
	);
	assert.match(source, /ThreadLocalGlobals/);
	assert.match(source, /GlobalConstructors/);
	assert.match(source, /GlobalDestructors/);
	assert.match(source, /ForbiddenABISymbols/);
	assert.match(source, /\+bulk-memory/);
	assert.match(source, /\+bulk-memory-opt/);
	assert.match(source, /\+call-indirect-overlong/);
	assert.match(source, /\+mutable-globals/);
	assert.match(source, /\+nontrapping-fptoint/);
	assert.match(source, /\+sign-ext/);
	assert.match(source, /-multivalue/);
	assert.match(source, /-reference-types/);
	assert.match(source, /strict allowlist/);
	assert.match(source, /module-level inline assembly is forbidden/);
	assert.match(source, /function-level inline assembly is forbidden/);
	assert.match(source, /global aliases and indirect functions are forbidden/);
	assert.match(source, /\.preinit_array/);
	assert.match(source, /func readULEB32/);
	assert.match(source, /index < 5/);
	assert.match(source, /current&0xf0 != 0/);
	assert.match(source, /wasm-relocatable-object-v1/);
	assert.doesNotMatch(source, /func isLLVMBitcode/);

	assert.match(patch, /diff --git a\/builder\/lld\.cpp/);
	assert.match(patch, /ObjectFile::createObjectFile/);
	assert.match(patch, /dyn_cast<llvm::object::WasmObjectFile>/);
	assert.match(patch, /isRelocatableObject\(\)/);
	assert.match(patch, /linkingData\(\)\.InitFunctions\.empty\(\)/);
	assert.match(patch, /WASM_FEATURE_PREFIX_DISALLOWED/);
	assert.match(patch, /allowedLimitsFlags = llvm::wasm::WASM_LIMITS_FLAG_HAS_MAX/);
	assert.match(patch, /memory\.Flags & ~allowedLimitsFlags/);
	assert.match(patch, /table\.Type\.Limits\.Flags/);
	assert.match(patch, /import\.Table\.Limits\.Flags/);
	assert.match(patch, /memoryCount > 1 \|\| tableCount > 1/);
	assert.match(patch, /segment\.Data\.Name\.starts_with\("\.preinit_array"\)/);
	assert.match(patch, /WASM_SYMBOL_TLS/);
	assert.match(patch, /R_WASM_MEMORY_ADDR_LEB64/);
	assert.match(patch, /R_WASM_TABLE_INDEX_REL_SLEB64/);
	assert.match(patch, /R_WASM_MEMORY_ADDR_TLS_SLEB64/);
	assert.match(patch, /nativeCFlags = append\(nativeCFlags, "-Werror=date-time"\)/);
	assert.equal(patch.match(/-Werror=date-time/g)?.length, 1);
});

test('the request uses an explicit go-list graph and prebuilt runtime artifacts', async () => {
	const source = await readFile(adapterPath, 'utf8');

	assert.match(source, /PackageJSON\s+string\s+`json:"packageJSON"`/);
	assert.match(source, /CompilerRT\s+string\s+`json:"compilerRT"`/);
	assert.match(source, /WasiLibc\s+string\s+`json:"wasiLibc"`/);
	assert.match(source, /ExtraFiles\s+map\[string\]string\s+`json:"extraFiles"`/);
	assert.match(source, /TINYGO_BROWSER_PACKAGE_JSON/);
	assert.match(source, /CgoFiles/);
	assert.match(source, /CFiles/);
	assert.match(source, /CXXFiles/);
	assert.match(source, /SFiles/);
	assert.match(source, /EmbedFiles/);
	assert.match(source, /pkg\.Goroot/);
	assert.match(source, /filepath\.Rel\(goRoot, packageDirectory\)/);
	assert.match(source, /Clang WebAssembly \.S files/);
});

test('the upstream patch adapts only WASI host services and the wasm32 libclang ABI', async () => {
	const patch = await readFile(patchPath, 'utf8');

	assert.match(patch, /TINYGO_BROWSER_PACKAGE_JSON/);
	assert.match(patch, /TINYGO_BROWSER_COMPILER_BUILD_ID/);
	assert.match(patch, /runtime\.GOOS == "wasip1"/);
	assert.match(patch, /-.*github\.com\/gofrs\/flock/);
	assert.match(patch, /-#cgo CXXFLAGS: -fno-rtti/);
	assert.match(patch, /diff --git a\/builder\/lock_default\.go/);
	assert.match(patch, /diff --git a\/builder\/lock_wasip1\.go/);
	assert.match(patch, /diff --git a\/cgo\/libclang\.go/);
	assert.match(patch, /diff --git a\/cgo\/libclang_stubs\.c/);
	assert.match(patch, /tinygo_wasm_clang_getArgType/);
	assert.match(patch, /tinygo_clang_globals_visitor_bridge_ptr/);
	assert.match(patch, /diff --git a\/builder\/jobs\.go/);
	assert.match(patch, /type BuildAuxiliaryObject struct/);
	assert.match(patch, /type BuildCGoInput struct/);
	assert.match(patch, /CGoInputs \[\]BuildCGoInput/);
	assert.match(patch, /AuxiliaryObjects \[\]BuildAuxiliaryObject/);
	assert.match(patch, /compileAndCacheCFileWithDependencies/);
	assert.match(patch, /runtime\.GOOS == "wasip1"/);
	assert.match(patch, /RunTool\("clang"/);
	assert.match(patch, /ValidateWasmObject/);
	assert.match(patch, /sort\.Strings\(embedFileNames\)/);
	assert.match(patch, /SourceSHA256/);
	assert.match(patch, /EmbeddedFileHash/);
	assert.match(patch, /A WASI-hosted browser compiler has no process or thread service/);
	assert.match(patch, /diff --git a\/src\/runtime\/arch_tinygowasm_malloc\.go/);
	assert.match(patch, /\/\/export aligned_alloc/);
	assert.match(patch, /\/\/export __libc_malloc/);
	assert.match(patch, /InterpTimeout:\s+3 \* time\.Minute/);
	assert.doesNotMatch(patch, /diff --git a\/(?:compiler|interp|transform)\//);
	assert.doesNotMatch(patch, /process_wasip1|cgo is not supported/i);
	assert.doesNotMatch(patch, /\+"go\/(?:ast|parser|scanner|token)"/);
	assert.doesNotMatch(patch, /ReadDir\(|WalkDir\(/);
});

test('the checked-in adapter is exactly the command added to upstream TinyGo', async () => {
	const [source, patch] = await Promise.all([
		readFile(adapterPath, 'utf8'),
		readFile(patchPath, 'utf8')
	]);

	assert.equal(
		addedFile(patch, 'cmd/tinygo-browser-adapter/main.go'),
		source.endsWith('\n') ? source : `${source}\n`
	);
});

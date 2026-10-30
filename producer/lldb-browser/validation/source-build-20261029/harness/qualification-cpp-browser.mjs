#!/usr/bin/env node
// Task-owned browser evidence for the exact producer C++ fixtures.
import { build, transform } from 'esbuild';
import { chromium } from 'playwright-core';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { resolveChromiumExecutable } from './rust-browser-probe-lib.mjs';
import { addBrowserTestCookies } from './browser-test-cookies.mjs';
import { createCoreSourceAliasMap } from './core-source-aliases.mjs';

const root = path.resolve(import.meta.dirname, '..');
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const tsModule = async (name) => {
	const { code } = await transform(await readFile(path.join(root, name), 'utf8'), {
		loader: 'ts',
		format: 'esm'
	});
	return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
};
const {
	BUNDLED_CLANG_ASSET_INTEGRITY: receipts,
	BUNDLED_CLANG_LANGUAGE_SYSROOT_PROFILES: profiles
} = await tsModule('src/lib/playground/clangAssetIntegrity.ts');
const files = new Map();
for (const [name, receipt] of Object.entries(receipts)) {
	const bytes = await readFile(path.join(root, 'static/clang', name));
	if (bytes.length !== receipt.bytes || digest(bytes) !== receipt.sha256)
		throw new Error(`Clang receipt mismatch: ${name}`);
	files.set(`/clang/${name}`, bytes);
}
const manifest = JSON.parse(files.get('/clang/runtime-manifest.v1.json'));
manifest.compiler.sysroot.profiles = profiles;
const debugRoot = path.join(root, 'static/wasm-debug');
const debugBytes = await readFile(path.join(debugRoot, 'runtime-manifest.v2.json'));
if (digest(debugBytes) !== args.get('--debug-manifest-sha256'))
	throw new Error('Exact debugger manifest digest is required');
const debugManifest = JSON.parse(debugBytes);
const manifestReceipt = { bytes: debugBytes.length, sha256: digest(debugBytes) };
files.set('/wasm-debug/runtime-manifest.v2.json', debugBytes);
for (const group of [debugManifest.debugger.lldb, debugManifest.debugger.targetRuntime]) {
	for (const kind of ['js', 'wasm', 'worker']) {
		const bytes = await readFile(path.join(debugRoot, group[kind]));
		if (digest(bytes) !== group[`${kind}Sha256`])
			throw new Error(`Debugger receipt mismatch: ${group[kind]}`);
		files.set(`/wasm-debug/${group[kind]}`, bytes);
	}
}
const bundle = async (entry, input) => {
	const result = await build({
		...(input
			? { stdin: { contents: input, resolveDir: root, sourcefile: entry, loader: 'ts' } }
			: { entryPoints: [path.join(root, entry)] }),
		bundle: true,
		write: false,
		format: 'esm',
		platform: 'browser',
		target: 'es2022',
		logLevel: 'silent',
		tsconfig: path.join(root, 'packages/llvm-core/tsconfig.json'),
		alias: {
			$lib: path.join(root, 'src/lib'),
			'@wasm-idle/llvm-core/debug': path.join(
				root,
				'packages/llvm-core/runtime/debug/src/index.ts'
			),
			...createCoreSourceAliasMap(root)
		}
	});
	return Buffer.from(result.outputFiles[0].contents);
};
files.set('/controller.js', await bundle('src/lib/playground/lldbSession.ts'));
for (const worker of ['lldb', 'target'])
	files.set(
		`/worker/${worker}-worker.js`,
		await bundle(`packages/llvm-core/runtime/debug/src/worker/${worker}-worker.ts`)
	);
files.set(
	'/compiler.js',
	await bundle(
		'qualification-compiler.ts',
		`
import Runtime from './packages/llvm-core/runtime/clang/src/artifact-runtime.ts';
self.onmessage = async ({data:{manifest,source,filename}}) => {
 try {
  let diagnostics='';
  const runtime=new Runtime({runtimeBaseUrl:location.origin+'/clang/',manifest,stdout:text=>{diagnostics+=text;},persistentCache:{enabled:false}});
  const artifact=await runtime.compileArtifact(source,{language:'CPP',activePath:filename,debugMode:'lldb'});
  postMessage({bytes:artifact.bytes,descriptor:artifact.debug,diagnostics});
 }catch(error){postMessage({error:String(error)});}
};`
	)
);
files.set('/', Buffer.from('<!doctype html><title>C++ debugger qualification</title>'));
const fixtures = {};
for (const filename of ['container-adaptors.cpp', 'function-end.cpp'])
	fixtures[filename] = await readFile(
		path.join(root, '../producer/test/native-wasm-debug', filename),
		'utf8'
	);
const csp =
	"default-src 'none'; script-src 'self' blob: 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' blob:; style-src 'self'; img-src 'self';";
const server = http.createServer((request, response) => {
	const pathname = new URL(request.url, 'http://localhost').pathname;
	const bytes = files.get(pathname);
	response.writeHead(bytes ? 200 : 404, {
		'Content-Type': /\.(?:m?js)$/.test(pathname)
			? 'text/javascript'
			: pathname.endsWith('.wasm')
				? 'application/wasm'
				: pathname.endsWith('.gz')
					? 'application/gzip'
					: pathname === '/'
						? 'text/html'
						: 'application/json',
		'Cross-Origin-Opener-Policy': 'same-origin',
		'Cross-Origin-Embedder-Policy': 'require-corp',
		'Content-Security-Policy': csp,
		'Cache-Control': 'no-store'
	});
	response.end(bytes);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
	const origin = `http://127.0.0.1:${server.address().port}`;
	browser = await chromium.launch({
		headless: true,
		executablePath: await resolveChromiumExecutable(
			process.env.WASM_IDLE_CHROMIUM_EXECUTABLE || ''
		),
		args: ['--no-sandbox']
	});
	const context = await browser.newContext();
	await addBrowserTestCookies(context, origin);
	const page = await context.newPage();
	page.on('pageerror', (error) => process.stderr.write(`${error.message}\n`));
	await page.goto(origin);
	const report = await page.evaluate(
		async ({ manifest, manifestReceipt, fixtures }) => {
			const assert = (value, message) => {
				if (!value) throw new Error(message);
			};
			assert(
				crossOriginIsolated && typeof SharedArrayBuffer === 'function',
				'C++ probe requires browser isolation'
			);
			const violations = [];
			document.addEventListener('securitypolicyviolation', (event) =>
				violations.push(event.violatedDirective)
			);
			const { LldbSandboxSession } = await import('/controller.js');
			const timeout = async (promise, label) => {
				let timer;
				try {
					return await Promise.race([
						promise,
						new Promise((_, reject) => {
							timer = setTimeout(() => reject(new Error(`${label} timeout`)), 120000);
						})
					]);
				} finally {
					clearTimeout(timer);
				}
			};
			const results = [];
			for (const [filename, source] of Object.entries(fixtures)) {
				const marker = (text) => {
					const lines = source
						.split('\n')
						.flatMap((line, index) => (line.endsWith(`// ${text}`) ? [index + 1] : []));
					assert(lines.length === 1, `Expected one marker: ${text}`);
					return lines[0];
				};
				const artifact = await timeout(
					new Promise((resolve, reject) => {
						const worker = new Worker('/compiler.js', { type: 'module' });
						worker.onerror = (error) => {
							worker.terminate();
							reject(new Error(error.message));
						};
						worker.onmessage = ({ data }) => {
							worker.terminate();
							data.error ? reject(new Error(data.error)) : resolve(data);
						};
						worker.postMessage({ manifest, source, filename });
					}),
					`compile ${filename}`
				);
				const adaptor = filename === 'container-adaptors.cpp';
				const dequeBoundaryCoverage =
					adaptor && source.includes('block_deque') && source.includes('large_deque');
				const markers = adaptor
					? ['adaptors first stop', 'adaptors second stop']
					: [
							'simple return',
							'early return',
							'recursive return',
							'cleanup return',
							'implicit last'
						];
				const queued = [],
					waiting = [],
					stops = [];
				let output = '';
				const sourcePath = `/workspace/${filename}`;
				const session = new LldbSandboxSession({
					compiledModuleCache: true,
					workerFactory: (kind) =>
						new Worker(`/worker/${kind}-worker.js`, { type: 'module' }),
					manifestUrl: location.origin + '/wasm-debug/runtime-manifest.v2.json',
					manifestReceipt,
					runtimeBaseUrl: location.origin + '/wasm-debug/',
					persistentCache: { enabled: false },
					artifact: { ...artifact, sources: [{ path: sourcePath, content: source }] },
					sourcePath,
					breakpoints: markers.map(marker),
					pauseOnEntry: false,
					onOutput: (text) => {
						output += text;
					},
					onDebugEvent: (event) => {
						if (event.type !== 'pause') return;
						if (waiting.length) waiting.shift()(event);
						else queued.push(event);
					}
				});
				const completion = session.start();
				void completion.catch(() => undefined);
				const nextPause = async (expected) => {
					const pause = await timeout(
						Promise.race([
							queued.length
								? Promise.resolve(queued.shift())
								: new Promise((resolve) => waiting.push(resolve)),
							completion.then(() => {
								throw new Error(`Exited before ${expected}`);
							})
						]),
						expected
					);
					assert(
						pause.line === marker(expected) && pause.sourcePath === sourcePath,
						`Wrong ${expected} stop: ${JSON.stringify(pause)}`
					);
					stops.push({ marker: expected, line: pause.line, frame: pause.callStack[0] });
					return pause;
				};
				const locals = async (pause) => {
					const scopes = await session.frameScopes(pause.callStack[0].id);
					const local = scopes.find((scope) => scope.name === 'Locals');
					assert(local?.variablesReference, 'Missing Locals');
					return session.variables(local.variablesReference);
				};
				const stepTo = async (command, expected) => {
					await session.debugCommand(command);
					return nextPause(expected);
				};
				try {
					if (adaptor) {
						const values = [
							{
								deque_stack: [1, 2, 3],
								vector_stack: [4, 5, 6],
								max_heap: [4, 1, 2],
								min_heap: [1, 4, 2],
								deque_heap: [1, 4, 2]
							},
							{
								deque_stack: [1, 2],
								vector_stack: [4, 5, 6, 9],
								max_heap: [2, 1],
								min_heap: [0, 1, 2, 4],
								deque_heap: [1, 4, 2]
							}
						];
						for (let index = 0; index < 2; index++) {
							const pause = await nextPause(markers[index]);
							const variables = await locals(pause);
							const children = async (name, size) => {
								const variable = variables.find((entry) => entry.name === name);
								assert(
									variable &&
										new RegExp(`size=${size}(?:\\s|$)`).test(variable.value),
									`${name}: expected synthetic size ${size}, got ${JSON.stringify(variable)}`
								);
								const entries = variable.variablesReference
									? await session.variables(variable.variablesReference)
									: [];
								return entries
									.filter((entry) => /^\[\d+\]$/.test(entry.name))
									.sort(
										(a, b) =>
											Number(a.name.slice(1, -1)) -
											Number(b.name.slice(1, -1))
									);
							};
							assert(
								(await children('empty_stack', 0)).length === 0,
								'Nonempty empty_stack'
							);
							assert(
								(await children('empty_heap', 0)).length === 0,
								'Nonempty empty_heap'
							);
							const observed = {};
							for (const [name, expected] of Object.entries(values[index])) {
								const actual = (await children(name, expected.length)).map(
									(entry) => Number(entry.value)
								);
								observed[name] = actual;
								assert(
									actual.length === expected.length &&
										actual.every(Number.isFinite),
									`Invalid ${name} synthetic children`
								);
								if (name.endsWith('_heap')) {
									assert(
										actual[0] === expected[0],
										`Wrong comparator top for ${name}`
									);
									assert(
										JSON.stringify([...actual].sort((a, b) => a - b)) ===
											JSON.stringify([...expected].sort((a, b) => a - b)),
										`Wrong heap storage for ${name}`
									);
								} else
									assert(
										JSON.stringify(actual) === JSON.stringify(expected),
										`Wrong stack order for ${name}`
									);
							}
							for (const [name, size, expected] of [
								['nested_stack', 1, [7, 8]],
								['nested_heap', 2, [3, 4]]
							]) {
								const outer = await children(name, size);
								assert(
									outer.length === size && outer[0].variablesReference,
									`Missing nested ${name}`
								);
								const inner = await session.variables(outer[0].variablesReference);
								const actual = inner
									.filter((entry) => /^\[\d+\]$/.test(entry.name))
									.map((entry) => Number(entry.value));
								assert(
									JSON.stringify(actual) === JSON.stringify(expected),
									`Incorrect nested ${name}: ${JSON.stringify(inner)}`
								);
								observed[name] = actual;
							}
							if (dequeBoundaryCoverage) {
								for (const [name, size, indices, expected] of [
									[
										'block_deque',
										1025,
										[0, 1018, 1019, 1024],
										index === 0 ? [5, 1023, 1024, 1029] : [6, 1024, 1025, 1030]
									],
									[
										'large_deque',
										17,
										[0, 14, 15, 16],
										index === 0 ? [10, 150, 160, 170] : [20, 160, 170, 180]
									]
								]) {
									const variable = variables.find((entry) => entry.name === name);
									assert(
										variable?.variablesReference &&
											new RegExp(`size=${size}(?:\\s|$)`).test(
												variable.value
											),
										`Missing ${name} synthetic size ${size}`
									);
									const actual = [];
									for (const offset of indices) {
										const page = await session.variables(
											variable.variablesReference,
											offset,
											1
										);
										const entry = page.find(
											(child) => child.name === `[${offset}]`
										);
										assert(entry, `Missing paged ${name}[${offset}]`);
										if (name === 'large_deque') {
											assert(
												entry.variablesReference,
												`Missing LargeElement[${offset}] fields`
											);
											const fields = await session.variables(
												entry.variablesReference
											);
											const value = fields.find(
												(field) => field.name === 'value'
											);
											assert(value, `Missing LargeElement[${offset}].value`);
											actual.push(Number(value.value));
										} else actual.push(Number(entry.value));
									}
									assert(
										JSON.stringify(actual) === JSON.stringify(expected),
										`Incorrect deque boundary values for ${name}: ${actual}`
									);
									observed[name] = { indices, values: actual, size };
								}
							}
							stops.at(-1).values = observed;
							await session.debugCommand('continue');
						}
					} else {
						for (const [name, answer] of [
							['simple', 12],
							['early', 22]
						]) {
							await nextPause(`${name} return`);
							const end = await stepTo('nextLine', `${name} end`);
							const variables = await locals(end);
							assert(
								variables.some(
									(entry) =>
										entry.name === 'answer' && Number(entry.value) === answer
								),
								`Wrong ${name} end locals`
							);
							stops.at(-1).variables = variables;
							await stepTo('nextLine', `${name} caller`);
							await session.debugCommand('continue');
						}
						for (const [n, answer] of [
							[0, 30],
							[1, 61],
							[2, 93]
						]) {
							await nextPause('recursive return');
							const end = await stepTo('nextLine', 'recursive end');
							const variables = await locals(end);
							assert(
								variables.some(
									(entry) => entry.name === 'n' && Number(entry.value) === n
								) &&
									variables.some(
										(entry) =>
											entry.name === 'answer' &&
											Number(entry.value) === answer
									),
								`Wrong recursive ${n} end locals`
							);
							stops.at(-1).variables = variables;
							await stepTo(
								'stepOut',
								n === 2 ? 'recursive caller' : 'recursive call'
							);
							await session.debugCommand('continue');
						}
						await nextPause('cleanup return');
						await stepTo('nextLine', 'cleanup end');
						await session.debugCommand('continue');
						await nextPause('implicit last');
						const end = await stepTo('nextLine', 'implicit end');
						const variables = await locals(end);
						assert(
							variables.some(
								(entry) => entry.name === 'answer' && Number(entry.value) === 52
							),
							'Wrong implicit end locals'
						);
						stops.at(-1).variables = variables;
						await session.debugCommand('continue');
					}
					const completed = await timeout(completion, `complete ${filename}`);
					assert(completed === true, `Unexpected ${filename} completion: ${completed}`);
					results.push({
						filename,
						stops,
						output,
						completed,
						dequeBoundaryCoverage,
						compiler: artifact.descriptor?.compiler
					});
				} finally {
					await session.disconnect();
				}
			}
			assert(violations.length === 0, `CSP violations: ${violations}`);
			return { crossOriginIsolated, violations, results };
		},
		{ manifest, manifestReceipt, fixtures }
	);
	const result = {
		chromium: browser.version(),
		manifestReceipt,
		fixtureSha256: Object.fromEntries(
			Object.entries(fixtures).map(([name, source]) => [name, digest(source)])
		),
		...report
	};
	await writeFile(args.get('--json'), JSON.stringify(result, null, 2) + '\n');
} finally {
	await browser?.close();
	await new Promise((resolve) => server.close(resolve));
}

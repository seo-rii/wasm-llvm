#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { parse } from 'acorn';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(THIS_FILE), '..');
const IGNORED_DIRECTORIES = new Set([
	'.git',
	'node_modules',
	'out',
	'dist',
	'artifacts',
	'browser-compiler-build',
	'raw-runtime',
	'source-checkout'
]);
// These files are inputs to Emscripten, not standalone Node modules.
const EMSCRIPTEN_LIBRARIES = new Set([
	'producer/wamr-browser/src/wasm-debug-transport.js',
	'producer/wamr-browser/src/wasm-debug-stdin.js',
	'producer/lldb-browser/overlays/lldb/tools/lldb-web-dap/library_lldb_shared_ring.js'
]);
const FORBIDDEN_PACKAGE_FIELDS = [
	'bin',
	'exports',
	'files',
	'main',
	'module',
	'publishConfig',
	'types'
];
const FORBIDDEN_LIFECYCLE_SCRIPTS = [
	'prepack',
	'prepare',
	'prepublish',
	'prepublishOnly',
	'publish',
	'postpublish'
];
const REQUIRED_PRODUCERS = [
	'c3-browser',
	'clang-browser',
	'cobol-browser',
	'crystal-browser',
	'd-browser',
	'ecl-browser',
	'emscripten-lld-browser',
	'kotlin-browser',
	'lean-browser',
	'lfortran-browser',
	'lldb-browser',
	'nim-browser',
	'objective-c-browser',
	'odin-browser',
	'rust-browser',
	'swift-browser',
	'tinygo-browser',
	'v-browser',
	'wamr-browser'
];

async function exists(filePath) {
	return !!(await stat(filePath).catch(() => null));
}

async function collectFiles(directory, files = []) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) await collectFiles(entryPath, files);
		else if (entry.isFile()) files.push(entryPath);
	}
	return files;
}

function checkSyntax(filePath) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ['--check', filePath], {
			cwd: REPO_ROOT,
			stdio: ['ignore', 'ignore', 'pipe']
		});
		let stderr = '';
		child.stderr.on('data', (chunk) => {
			stderr += chunk;
		});
		child.on('error', (error) => resolve(error.message));
		child.on('close', (code) => resolve(code === 0 ? null : stderr.trim()));
	});
}

export async function inspectProducerRepository(repoRoot = REPO_ROOT) {
	const errors = [];
	const rootPackage = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));

	if (rootPackage.private !== true) errors.push('root package.json must set private: true');
	if (rootPackage.name === '@seo-rii/wasm-llvm') {
		errors.push('root package must not retain the former published runtime package name');
	}
	if (rootPackage.dependencies && Object.keys(rootPackage.dependencies).length > 0) {
		errors.push('build-only dependencies must be listed in devDependencies');
	}
	for (const field of FORBIDDEN_PACKAGE_FIELDS) {
		if (field in rootPackage) errors.push(`root package.json must not define ${field}`);
	}
	for (const script of FORBIDDEN_LIFECYCLE_SCRIPTS) {
		if (rootPackage.scripts?.[script]) {
			errors.push(`root package.json must not define the npm lifecycle script ${script}`);
		}
	}
	for (const dependencyGroup of ['dependencies', 'devDependencies', 'optionalDependencies']) {
		if (rootPackage[dependencyGroup]?.['@seo-rii/wasm-llvm']) {
			errors.push(`root package.json must not depend on itself through ${dependencyGroup}`);
		}
	}
	if (await exists(path.join(repoRoot, 'runtime'))) {
		errors.push('the browser runtime/ directory must not exist in this producer repository');
	}

	for (const producerName of REQUIRED_PRODUCERS) {
		const producerRoot = path.join(repoRoot, 'producer', producerName);
		const manifestPath = path.join(producerRoot, 'manifest.json');
		if (!(await exists(manifestPath))) {
			errors.push(`producer manifest is missing: producer/${producerName}/manifest.json`);
			continue;
		}
		const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
		if (manifest.schemaVersion !== 1) {
			errors.push(`producer/${producerName}/manifest.json must use schemaVersion 1`);
		}
		if (typeof manifest.producerId !== 'string' || manifest.producerId.length === 0) {
			errors.push(`producer/${producerName}/manifest.json must define producerId`);
		}
		const pendingPins = [[manifest, '']];
		while (pendingPins.length > 0) {
			const [value, pointer] = pendingPins.pop();
			if (!value || typeof value !== 'object') continue;
			if (
				typeof value.repository === 'string' &&
				(typeof value.commit !== 'string' || !/^\p{ASCII_Hex_Digit}{40}$/u.test(value.commit))
			) {
				errors.push(
					`producer/${producerName}/manifest.json ${pointer || '<root>'} must pin its repository with a 40-character commit`
				);
			}
			for (const [key, child] of Object.entries(value)) {
				pendingPins.push([child, pointer ? `${pointer}.${key}` : key]);
			}
		}
	}

	const files = await collectFiles(repoRoot);
	const implementationTypescript = files.filter((filePath) => /\.(?:ts|tsx|mts|cts)$/u.test(filePath));
	for (const filePath of implementationTypescript) {
		errors.push(`browser/runtime TypeScript remains: ${path.relative(repoRoot, filePath)}`);
	}

	const moduleFiles = files.filter((filePath) =>
		/\.(?:mjs|cjs|js)$/u.test(filePath) &&
		!EMSCRIPTEN_LIBRARIES.has(path.relative(repoRoot, filePath).split(path.sep).join('/'))
	);
	// Bound subprocess concurrency while preserving deterministic diagnostics.
	const diagnostics = new Array(moduleFiles.length);
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(8, moduleFiles.length) }, async () => {
		while (next < moduleFiles.length) {
			const index = next++;
			const filePath = moduleFiles[index];
			const relative = path.relative(repoRoot, filePath);
			const source = await readFile(filePath, 'utf8');
			const issues = [];
			try {
				const ast = parse(source, {
					ecmaVersion: 'latest', sourceType: filePath.endsWith('.cjs') ? 'script' : 'module',
					allowReturnOutsideFunction: filePath.endsWith('.cjs')
				});
				const pending = [ast];
				while (pending.length) {
					const node = pending.pop();
					if (!node || typeof node !== 'object') continue;
					let specifier;
					if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(node.type)) {
						specifier = node.source;
					} else if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'require') {
						specifier = node.arguments[0];
					}
					const name = specifier?.type === 'Literal' ? specifier.value :
						specifier?.type === 'TemplateLiteral' && specifier.expressions.length === 0 ? specifier.quasis[0].value.cooked : null;
					if (typeof name === 'string' && (name === '@seo-rii/wasm-llvm' || name.startsWith('@seo-rii/wasm-llvm/'))) {
						issues.push(`self runtime import remains: ${relative}`);
						break;
					}
					for (const value of Object.values(node)) {
						if (Array.isArray(value)) pending.push(...value);
						else if (value && typeof value === 'object') pending.push(value);
					}
				}
			} catch (error) {
				issues.push(`invalid JavaScript: ${relative}\n${error.message}`);
			}
			if (!issues.some((issue) => issue.startsWith('invalid JavaScript:'))) {
				const syntaxError = await checkSyntax(filePath);
				if (syntaxError) issues.push(`invalid JavaScript: ${relative}\n${syntaxError}`);
			}
			diagnostics[index] = issues;
		}
	}));
	errors.push(...diagnostics.flat());

	return {
		errors,
		filesChecked: files.length,
		modulesChecked: moduleFiles.length,
		producersChecked: REQUIRED_PRODUCERS.length
	};
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
	const report = await inspectProducerRepository();
	for (const error of report.errors) console.error(`error: ${error}`);
	if (report.errors.length > 0) process.exitCode = 1;
	else {
		console.log(
			`Checked ${report.producersChecked} producers and ${report.modulesChecked} Node modules; repository is producer-only.`
		);
	}
}

#!/usr/bin/env node

import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	isMain,
	parseArguments,
	producerRoot,
	readSourceLock,
	run,
	verifyGitRevision
} from './shared.mjs';

export const WAMR_PATCH_PATHS = Object.freeze([
	'patches/wamr-browser-debug-transport.patch',
	'patches/wamr-browser-wasm32-wasi-native-return.patch',
	'patches/wamr-browser-wasi-i64-argument-dispatch.patch'
]);

export async function prepareWamrSource({ source }) {
	if (!source) throw new Error('--source is required');
	source = path.resolve(source);
	const lock = await readSourceLock();
	await verifyGitRevision(source, lock.wamr.commit, 'WAMR');

	const patchStateRoot = await mkdtemp(path.join(tmpdir(), 'wamr-browser-patch-state-'));
	let patchState;
	const patchStateFailures = [];
	try {
		for (const reverse of [false, true]) {
			const patchPaths = reverse ? [...WAMR_PATCH_PATHS].reverse() : WAMR_PATCH_PATHS;
			const env = {
				...process.env,
				GIT_INDEX_FILE: path.join(
					patchStateRoot,
					reverse ? 'reverse-index' : 'forward-index'
				)
			};
			await run('git', ['read-tree', 'HEAD'], {
				cwd: source,
				env,
				capture: true
			});
			await run('git', ['add', '-u'], {
				cwd: source,
				env,
				capture: true
			});
			let applicable = true;
			for (const patchPath of patchPaths) {
				const patch = path.join(producerRoot, patchPath);
				const applyArguments = ['apply', '--cached'];
				if (reverse) applyArguments.push('--reverse');
				try {
					await run('git', [...applyArguments, '--check', patch], {
						cwd: source,
						env,
						capture: true
					});
					await run('git', [...applyArguments, patch], {
						cwd: source,
						env,
						capture: true
					});
				} catch (error) {
					applicable = false;
					patchStateFailures.push(
						`${reverse ? 'already-applied' : 'clean'} check: ${error.message}`
					);
					break;
				}
			}
			if (applicable) {
				patchState = reverse ? 'applied' : 'clean';
				break;
			}
		}
	} finally {
		await rm(patchStateRoot, { recursive: true, force: true });
	}

	if (patchState === 'clean') {
		for (const patchPath of WAMR_PATCH_PATHS) {
			const patch = path.join(producerRoot, patchPath);
			await run('git', ['apply', '--check', patch], {
				cwd: source,
				capture: true
			});
			await run('git', ['apply', patch], { cwd: source });
		}
	} else if (patchState !== 'applied') {
		throw new Error(
			`WAMR browser patch set is neither cleanly applicable nor already applied:\n${patchStateFailures.join(
				'\n'
			)}`
		);
	}

	const destination = path.join(source, 'core', 'iwasm', 'libraries', 'debug-engine');
	await copyFile(
		path.join(producerRoot, 'src', 'wasm_debug_transport.c'),
		path.join(destination, 'wasm_debug_transport.c')
	);
	await copyFile(
		path.join(producerRoot, 'src', 'wasm_debug_transport.h'),
		path.join(destination, 'wasm_debug_transport.h')
	);
	await copyFile(
		path.join(producerRoot, 'src', 'wasm_debug_emscripten_compat.h'),
		path.join(destination, 'wasm_debug_emscripten_compat.h')
	);
	console.log(`Prepared pinned WAMR browser source at ${source}`);
}

if (isMain(import.meta.url)) {
	await prepareWamrSource(parseArguments(process.argv.slice(2)));
}

#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PRODUCER_ROOT = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(PRODUCER_ROOT, '..', '..');
const OUTPUT_DIR = path.resolve(
	process.env.WASM_LLVM_OBJECTIVE_C_OUTPUT_DIR ||
		process.argv[2] ||
		path.join(REPO_ROOT, 'out', 'objective-c-browser')
);
const EXPECTED_ASSETS = [
	'libobjc.a',
	'headers.json',
	'libgnustep-base.a',
	'libgnustep-base.o',
	'foundation-headers.json',
	'libffi.a'
];

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

const manifestBytes = await readFile(path.join(PRODUCER_ROOT, 'manifest.json'));
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const receipt = JSON.parse(
	await readFile(path.join(OUTPUT_DIR, 'producer-receipt.json'), 'utf8')
);

assert(receipt.producer?.id === manifest.producerId, 'Objective-C producer id does not match');
assert(
	receipt.producer?.manifestSha256 === sha256(manifestBytes),
	'Objective-C producer manifest hash does not match'
);
for (const sourceName of ['libobjc2', 'robinMap', 'gnustepBase', 'libffi']) {
	assert(
		receipt[sourceName]?.commit === manifest.sources[sourceName].commit,
		`Objective-C ${sourceName} commit does not match`
	);
}
assert(receipt.target === 'wasm32-wasi', 'Objective-C target must be wasm32-wasi');
assert(
	receipt.toolchain?.wasiSdkVersion === manifest.toolchain.wasiSdkVersion,
	'Objective-C WASI SDK version does not match'
);
assert(
	typeof receipt.toolchain?.clangVersion === 'string' && receipt.toolchain.clangVersion.length > 0,
	'Objective-C Clang version is missing'
);
assert(!receipt.toolchain.clangVersion.includes('\n'), 'Objective-C Clang version must be one line');
assert(!('clang' in receipt.toolchain), 'Objective-C receipt must not contain a host Clang path');
assert(!('sysroot' in receipt.toolchain), 'Objective-C receipt must not contain a host sysroot path');
assert(receipt.foundation?.usesLibffi === true, 'Objective-C Foundation must include libffi');
assert(
	Number.isInteger(receipt.foundation?.sourceCount) && receipt.foundation.sourceCount > 0,
	'Objective-C Foundation source count is invalid'
);
assert(
	JSON.stringify(Object.keys(receipt.assets || {}).sort()) ===
		JSON.stringify([...EXPECTED_ASSETS].sort()),
	'Objective-C receipt does not describe the complete asset set'
);

const assetBytes = {};
for (const assetName of EXPECTED_ASSETS) {
	const bytes = await readFile(path.join(OUTPUT_DIR, assetName));
	const metadata = receipt.assets[assetName];
	assert(metadata.bytes === bytes.length, `${assetName} byte length does not match receipt`);
	assert(metadata.sha256 === sha256(bytes), `${assetName} hash does not match receipt`);
	assetBytes[assetName] = bytes;
}
for (const archiveName of ['libobjc.a', 'libgnustep-base.a', 'libffi.a']) {
	assert(
		assetBytes[archiveName].subarray(0, 8).toString('ascii') === '!<arch>\n',
		`${archiveName} is not an ar archive`
	);
}
assert(
	assetBytes['libgnustep-base.o'].subarray(0, 4).equals(Buffer.from([0, 97, 115, 109])),
	'libgnustep-base.o is not a WebAssembly object'
);

const objcHeaders = JSON.parse(assetBytes['headers.json'].toString('utf8'));
const foundationHeaders = JSON.parse(assetBytes['foundation-headers.json'].toString('utf8'));
assert(typeof objcHeaders['objc/runtime.h'] === 'string', 'objc/runtime.h is missing');
for (const headerName of [
	'Foundation/Foundation.h',
	'Foundation/NSObject.h',
	'Foundation/NSString.h'
]) {
	assert(typeof foundationHeaders[headerName] === 'string', `${headerName} is missing`);
}

console.log(`Verified Objective-C producer artifacts in ${OUTPUT_DIR}`);

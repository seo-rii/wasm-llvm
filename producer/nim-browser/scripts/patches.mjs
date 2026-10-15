// Pinned transformations migrated from wasm-idle's Nim asset producer.
const NOTICES_FILE = 'THIRD_PARTY_NOTICES.md';

const CLANG_MODIFICATION_NOTICE = `/*
 * wasm-idle modification notice:
 * This file was modified to consume an exact host-verified compiler asset map,
 * remove embedded-worker network fetches, and return the linked Wasm artifact
 * without executing it in the compiler worker. See THIRD_PARTY_NOTICES.md.
 */
`;

/** @param {string} source */
export function patchNimLicense(source) {
	const projectNeedle = 'binji/clang.js project';
	const urlNeedle = 'https://github.com/binji/clang.js';
	if (
		source.split(projectNeedle).length !== 2 ||
		source.split(urlNeedle).length !== 2 ||
		source.includes(NOTICES_FILE)
	) {
		throw new Error('Nim source license did not match the expected legacy notice');
	}
	return `${source
		.replace(projectNeedle, 'binji/wasm-clang project')
		.replace(urlNeedle, 'https://github.com/binji/wasm-clang')
		.trimEnd()}\n\nFull upstream license texts and the wasm-idle modification notice are provided in\n${NOTICES_FILE}.\n`;
}

/** @param {string} source */
export function patchClangJs(source) {
	const match = source.match(/a="([A-Za-z0-9+/=]+)"/);
	if (!match) throw new Error('clang.js did not contain the embedded worker payload');
	let workerSource = Buffer.from(match[1], 'base64').toString('utf8');
	const fetchNeedle =
		'readBuffer:async t=>(await fetch(`${a}/${t}`)).arrayBuffer(),async compileStreaming(t){const e=await fetch(`${a}/${t}`,{cache:"no-store"});return WebAssembly.compile(await e.arrayBuffer())}';
	const fetchReplacement =
		'readBuffer:async t=>readAsset(a,t),async compileStreaming(t){return h.modules?h.modules[t]:WebAssembly.compile(readAsset(a,t))}';
	if (!workerSource.includes(fetchNeedle)) {
		throw new Error('clang.js embedded worker fetch path did not match the expected source');
	}
	workerSource = workerSource.replace(fetchNeedle, fetchReplacement);
	const helperNeedle = 'let s,i;let r=null;const n=async t=>{';
	const helper =
		'function validateAssets(a){const e=["clang.wasm","lld.wasm","memfs.wasm","sysroot.tar"];if(!a||typeof a!=="object"||JSON.stringify(Object.keys(a).sort())!==JSON.stringify(e))throw new Error("invalid compiler asset map");for(const t of e)if(!(a[t] instanceof ArrayBuffer))throw new Error(`invalid compiler asset: ${t}`);return a}function validateModules(a){if(a===undefined)return a;const e=["clang.wasm","lld.wasm","memfs.wasm"];if(!a||typeof a!=="object"||JSON.stringify(Object.keys(a).sort())!==JSON.stringify(e))throw new Error("invalid compiler module map");for(const t of e)if(!(a[t] instanceof WebAssembly.Module))throw new Error(`invalid compiler module: ${t}`);return a}function readAsset(a,t){if(!Object.prototype.hasOwnProperty.call(a,t))throw new Error(`undeclared compiler asset: ${t}`);return a[t]}';
	if (!workerSource.includes(helperNeedle)) {
		throw new Error('clang.js embedded worker init block did not match the expected source');
	}
	workerSource = workerSource.replace(helperNeedle, `${helper}${helperNeedle}`);
	const constructorNeedle = 'a=h.path,{readBuffer:';
	if (!workerSource.includes(constructorNeedle)) {
		throw new Error('clang.js embedded worker constructor did not match the expected source');
	}
	workerSource = workerSource.replace(
		constructorNeedle,
		'a=validateAssets(h.assets),h.modules=validateModules(h.modules),{readBuffer:'
	);
	const compileEachNeedle = 'case"compile-each-link":{const files=h.files;';
	if (!workerSource.includes(compileEachNeedle)) {
		throw new Error('clang.js embedded worker compile-each-link case did not match');
	}
	workerSource = workerSource.replace(
		compileEachNeedle,
		'case"compile-each-link":{try{const files=h.files;'
	);
	const runNeedle =
		'const o=s.memfs.getFileContents(h.out);const inst=await s.hostLogAsync(`Compiling ${h.out}`,WebAssembly.compile(o));const finalResult=await s.run(inst,h.out);i.postMessage({id:"compile-each-link-done",data:finalResult?{ok:true}:{ok:false}});';
	if (!workerSource.includes(runNeedle)) {
		throw new Error('clang.js embedded worker compile-each-link block did not match');
	}
	workerSource = workerSource.replace(
		runNeedle,
		'i.postMessage({id:"compile-each-link-done",data:{ok:true}});}catch(err){i.postMessage({id:"compile-each-link-done",data:{ok:false,error:String(err&&err.message||err)}});}'
	);
	let patched = source.replace(match[1], Buffer.from(workerSource, 'utf8').toString('base64'));
	const outerConstructorNeedle =
		'this.worker.postMessage({id:"constructor",payload:{port:c,path:l}},[c])';
	const outerConstructorReplacement =
		'const v=Object.values(l.assets);this.worker.postMessage({id:"constructor",payload:{port:c,assets:l.assets,modules:l.modules}},[c,...v])';
	if (!patched.includes(outerConstructorNeedle)) {
		throw new Error('clang.js outer worker constructor did not match the expected source');
	}
	patched = patched.replace(outerConstructorNeedle, outerConstructorReplacement);
	const outerInitNeedle =
		'async function p({path:l}){m||(y=new o(l||location.origin),await y.onReady,m=!0)}';
	const outerInitReplacement =
		'async function p({assets:l,modules:c}){m||(y=new o({assets:l,modules:c}),await y.onReady,m=!0)}';
	if (!patched.includes(outerInitNeedle)) {
		throw new Error('clang.js outer init did not match the expected source');
	}
	return `${CLANG_MODIFICATION_NOTICE}${patched.replace(outerInitNeedle, outerInitReplacement)}`;
}

// Upgrade only the content-locked loader published before the compiled-module bridge.
// The caller verifies the old logical receipt before this deliberately narrow transformation.
export function upgradeLegacyClangJs(source) {
	const match = source.match(/a="([A-Za-z0-9+/=]+)"/);
	if (!match) throw new Error('Legacy clang.js has no embedded worker payload');
	const replaceOnce = (text, before, after) => {
		if (text.split(before).length !== 2) throw new Error('Legacy clang.js does not match its upgrade contract');
		return text.replace(before, after);
	};
	let worker = Buffer.from(match[1], 'base64').toString('utf8');
	worker = replaceOnce(worker,
		'async compileStreaming(t){return WebAssembly.compile(readAsset(a,t))}',
		'async compileStreaming(t){return h.modules?h.modules[t]:WebAssembly.compile(readAsset(a,t))}');
	worker = replaceOnce(worker, 'function readAsset(a,t){',
		'function validateModules(a){if(a===undefined)return a;const e=["clang.wasm","lld.wasm","memfs.wasm"];if(!a||typeof a!=="object"||JSON.stringify(Object.keys(a).sort())!==JSON.stringify(e))throw new Error("invalid compiler module map");for(const t of e)if(!(a[t] instanceof WebAssembly.Module))throw new Error(`invalid compiler module: ${t}`);return a}function readAsset(a,t){');
	worker = replaceOnce(worker, 'a=validateAssets(h.assets),{readBuffer:',
		'a=validateAssets(h.assets),h.modules=validateModules(h.modules),{readBuffer:');
	let patched = source.replace(match[1], Buffer.from(worker, 'utf8').toString('base64'));
	patched = replaceOnce(patched,
		'const v=Object.values(l);this.worker.postMessage({id:"constructor",payload:{port:c,assets:l}},[c,...v])',
		'const v=Object.values(l.assets);this.worker.postMessage({id:"constructor",payload:{port:c,assets:l.assets,modules:l.modules}},[c,...v])');
	return replaceOnce(patched,
		'async function p({assets:l}){m||(y=new o(l),await y.onReady,m=!0)}',
		'async function p({assets:l,modules:c}){m||(y=new o({assets:l,modules:c}),await y.onReady,m=!0)}');
}

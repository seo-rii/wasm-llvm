// Default compiler commands require only the Preview 1 host. Experimental tool
// execution, cwd and pthread imports belong to separately qualified profiles.
const preview1Functions = new Set([
	'args_get', 'args_sizes_get', 'environ_get', 'environ_sizes_get', 'clock_res_get', 'clock_time_get',
	'fd_advise', 'fd_allocate', 'fd_close', 'fd_datasync', 'fd_fdstat_get', 'fd_fdstat_set_flags',
	'fd_fdstat_set_rights', 'fd_filestat_get', 'fd_filestat_set_size', 'fd_filestat_set_times',
	'fd_pread', 'fd_prestat_get', 'fd_prestat_dir_name', 'fd_pwrite', 'fd_read', 'fd_readdir',
	'fd_renumber', 'fd_seek', 'fd_sync', 'fd_tell', 'fd_write', 'path_create_directory',
	'path_filestat_get', 'path_filestat_set_times', 'path_link', 'path_open', 'path_readlink',
	'path_remove_directory', 'path_rename', 'path_symlink', 'path_unlink_file', 'poll_oneoff',
	'proc_exit', 'proc_raise', 'random_get', 'sched_yield', 'sock_accept', 'sock_recv', 'sock_send', 'sock_shutdown'
]);

export function assertClangWasiContract(label, bytes, module) {
	const fail = (message) => { throw new Error(`${label} default WASI command ABI: ${message}`); };
	for (const item of WebAssembly.Module.imports(module)) {
		if (item.module !== 'wasi_snapshot_preview1' || item.kind !== 'function' || !preview1Functions.has(item.name))
			fail(`unsupported import ${item.module}.${item.name} (${item.kind})`);
	}
	const exports = WebAssembly.Module.exports(module);
	for (const [name, kind] of [['memory', 'memory'], ['_start', 'function']]) {
		if (!exports.some((item) => item.name === name && item.kind === kind))
			fail(`missing ${kind} export ${name}`);
	}

	// Compilation already validates the complete binary. Read the standard section
	// metadata needed for the command signature and memory model without running it.
	class Cursor {
		constructor(data) { this.data = data; this.offset = 0; }
		byte() {
			if (this.offset >= this.data.length) fail('truncated section');
			return this.data[this.offset++];
		}
		u32() {
			let value = 0;
			for (let shift = 0; shift < 35; shift += 7) {
				const byte = this.byte();
				if (shift === 28 && byte >= 16) fail('u32 overflow');
				value += (byte & 127) * 2 ** shift;
				if (!(byte & 128)) return value;
			}
			fail('invalid u32');
		}
		slice(length) {
			if (length > this.data.length - this.offset) fail('truncated section');
			const result = this.data.subarray(this.offset, this.offset + length);
			this.offset += length;
			return result;
		}
		name() { return new TextDecoder('utf-8', { fatal: true }).decode(this.slice(this.u32())); }
	}
	const reader = new Cursor(bytes.subarray(8));
	const types = [];
	const functions = [];
	let start;
	let memoryCount = 0;
	while (reader.offset < reader.data.length) {
		const id = reader.byte();
		const section = new Cursor(reader.slice(reader.u32()));
		if (id === 1) {
			for (let count = section.u32(); count > 0; count--) {
				if (section.byte() !== 0x60) fail('unsupported function type');
				const parameters = section.slice(section.u32());
				const results = section.slice(section.u32());
				types.push({ parameters: parameters.length, results: results.length });
			}
		} else if (id === 2) {
			for (let count = section.u32(); count > 0; count--) {
				section.name(); section.name();
				if (section.byte() !== 0) fail('only function imports are supported');
				functions.push(section.u32());
			}
		} else if (id === 3) {
			for (let count = section.u32(); count > 0; count--) functions.push(section.u32());
		} else if (id === 5) {
			memoryCount = section.u32();
			if (memoryCount !== 1) fail('requires exactly one defined memory');
			const flags = section.u32();
			if (flags !== 0 && flags !== 1) fail('requires unshared wasm32 memory');
			if (section.u32() === 0) fail('memory must have at least one page');
			if (flags === 1) section.u32();
		} else if (id === 7) {
			for (let count = section.u32(); count > 0; count--) {
				const name = section.name();
				const kind = section.byte();
				const index = section.u32();
				if (name === '_start' && kind === 0) start = index;
			}
		} else if (id === 8) fail('startup must be invoked through the _start export');
	}
	if (memoryCount !== 1) fail('requires exactly one defined memory');
	const signature = types[functions[start]];
	if (!signature || signature.parameters !== 0 || signature.results !== 0)
		fail('_start must have no parameters or results');
}

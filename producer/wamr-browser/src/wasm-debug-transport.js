// shared-ring-v1 transport for WAMR's source-debug control pthread.
//
// Emscripten 6.0.0 does not copy arbitrary incoming Module properties into
// pthread realms. The main module therefore normalizes the host descriptors
// and sends them to each pthread after PThread.loadWasmModuleToWorker()
// resolves. That postMessage happens before the pool-ready promise resolves,
// so the subsequent pthread run message is ordered after the transport data.
//
// The imports intentionally execute in the calling debug-control pthread.
// They must never be annotated with __proxy because a blocking ring read
// proxied to the application worker can deadlock while that worker runs WAMR.

var LibraryWasmIdleDebugTransportV1 = {
	$WasmIdleDebugTransportV1__deps: ['$PThread'],
	$WasmIdleDebugTransportV1__postset: 'WasmIdleDebugTransportV1.install();',
	$WasmIdleDebugTransportV1: {
		READ: 0,
		WRITE: 1,
		STATE: 2,
		EPOCH: 3,
		CAPACITY: 4,
		INTERRUPT: 5,
		GENERATION: 6,
		MINIMUM_CONTROL_CELLS: 6,
		MINIMUM_CAPACITY: 4096,
		MAXIMUM_CAPACITY: 16 * 1024 * 1024,
		MESSAGE_PROPERTY: 'wasmIdleDebugTransportV1',

		installed: false,
		payload: null,
		rspInput: null,
		rspOutput: null,

		descriptor: function (queue) {
			var descriptor = queue && (queue.descriptor || queue);
			if (
				!descriptor ||
				!(descriptor.control instanceof SharedArrayBuffer) ||
				!(descriptor.data instanceof SharedArrayBuffer)
			)
				return null;
			if (!Number.isSafeInteger(descriptor.generation) || descriptor.generation <= 0)
				return null;
			return {
				control: descriptor.control,
				data: descriptor.data,
				generation: descriptor.generation
			};
		},

		ring: function (descriptor) {
			if (!descriptor) return null;
			var control = new Int32Array(descriptor.control);
			var data = new Uint8Array(descriptor.data);
			if (control.length < WasmIdleDebugTransportV1.MINIMUM_CONTROL_CELLS) return null;
			var capacity = Atomics.load(control, WasmIdleDebugTransportV1.CAPACITY) >>> 0;
			if (
				capacity !== data.byteLength ||
				capacity < WasmIdleDebugTransportV1.MINIMUM_CAPACITY ||
				capacity > WasmIdleDebugTransportV1.MAXIMUM_CAPACITY ||
				(capacity & (capacity - 1)) !== 0
			)
				return null;
			if (
				control.length > WasmIdleDebugTransportV1.GENERATION &&
				Atomics.load(control, WasmIdleDebugTransportV1.GENERATION) >>> 0 !==
					descriptor.generation
			)
				return null;
			return {
				control: control,
				data: data,
				capacity: capacity,
				generation: descriptor.generation,
				interruptGeneration:
					Atomics.load(control, WasmIdleDebugTransportV1.INTERRUPT) >>> 0
			};
		},

		normalize: function (transport) {
			if (!transport) return null;
			var rspInput = WasmIdleDebugTransportV1.descriptor(transport.rspInput);
			var rspOutput = WasmIdleDebugTransportV1.descriptor(transport.rspOutput);
			if (!rspInput || !rspOutput) return null;
			return {
				protocol: 'shared-ring-v1',
				rspInput: rspInput,
				rspOutput: rspOutput
			};
		},

		setTransport: function (transport) {
			var payload = WasmIdleDebugTransportV1.normalize(transport);
			if (!payload || payload.protocol !== 'shared-ring-v1') return false;
			var rspInput = WasmIdleDebugTransportV1.ring(payload.rspInput);
			var rspOutput = WasmIdleDebugTransportV1.ring(payload.rspOutput);
			if (!rspInput || !rspOutput) return false;
			WasmIdleDebugTransportV1.payload = payload;
			WasmIdleDebugTransportV1.rspInput = rspInput;
			WasmIdleDebugTransportV1.rspOutput = rspOutput;
			return true;
		},

		install: function () {
			if (WasmIdleDebugTransportV1.installed) return;
			WasmIdleDebugTransportV1.installed = true;

			if (ENVIRONMENT_IS_PTHREAD) {
				globalThis.addEventListener('message', function (event) {
					var data = event.data;
					if (
						!data ||
						!Object.prototype.hasOwnProperty.call(
							data,
							WasmIdleDebugTransportV1.MESSAGE_PROPERTY
						)
					)
						return;
					WasmIdleDebugTransportV1.setTransport(
						data[WasmIdleDebugTransportV1.MESSAGE_PROPERTY]
					);
				});
				return;
			}

			WasmIdleDebugTransportV1.setTransport(Module['wasmIdleDebugTransport']);
			var loadWorker = PThread.loadWasmModuleToWorker;
			PThread.loadWasmModuleToWorker = function (worker) {
				return loadWorker(worker).then(function (loadedWorker) {
					if (!WasmIdleDebugTransportV1.payload)
						throw new Error('Module.wasmIdleDebugTransport is missing or invalid');
					var message = {};
					message[WasmIdleDebugTransportV1.MESSAGE_PROPERTY] =
						WasmIdleDebugTransportV1.payload;
					// This message deliberately has no `cmd` member, so Emscripten's
					// pthread dispatcher ignores it while our addEventListener handles it.
					worker.postMessage(message);
					return loadedWorker;
				});
			};
		},

		validGeneration: function (ring) {
			return (
				ring.control.length <= WasmIdleDebugTransportV1.GENERATION ||
				Atomics.load(ring.control, WasmIdleDebugTransportV1.GENERATION) >>> 0 ===
					ring.generation
			);
		},

		notify: function (ring) {
			Atomics.add(ring.control, WasmIdleDebugTransportV1.EPOCH, 1);
			Atomics.notify(ring.control, WasmIdleDebugTransportV1.EPOCH);
		},

		close: function (ring) {
			if (!ring) return;
			Atomics.store(ring.control, WasmIdleDebugTransportV1.STATE, 1);
			WasmIdleDebugTransportV1.notify(ring);
		},

		read: function (ring, destination, length, timeoutMs) {
			if (!ring) return -1;
			var deadline = timeoutMs < 0 ? Infinity : Date.now() + timeoutMs;
			while (true) {
				// Observe EPOCH before checking cursor/state values. A concurrent
				// producer then either changes EPOCH before wait or wakes this wait.
				var epoch = Atomics.load(ring.control, WasmIdleDebugTransportV1.EPOCH);
				if (!WasmIdleDebugTransportV1.validGeneration(ring)) return -1;
				var read = Atomics.load(ring.control, WasmIdleDebugTransportV1.READ) >>> 0;
				var write = Atomics.load(ring.control, WasmIdleDebugTransportV1.WRITE) >>> 0;
				var available = (write - read) >>> 0;
				if (available > ring.capacity) return -1;
				if (available > 0) {
					var count = Math.min(available, length);
					var offset = read & (ring.capacity - 1);
					var first = Math.min(count, ring.capacity - offset);
					HEAPU8.set(ring.data.subarray(offset, offset + first), destination);
					if (first < count)
						HEAPU8.set(ring.data.subarray(0, count - first), destination + first);
					Atomics.store(ring.control, WasmIdleDebugTransportV1.READ, (read + count) | 0);
					WasmIdleDebugTransportV1.notify(ring);
					return count;
				}

				var state = Atomics.load(ring.control, WasmIdleDebugTransportV1.STATE);
				if (state === 1) return -2;
				if (state !== 0) return -1;
				// Keep this generation across read calls: a stop can arrive after
				// the control loop checks its state but before entering this read.
				var interruptGeneration =
					Atomics.load(ring.control, WasmIdleDebugTransportV1.INTERRUPT) >>> 0;
				if (interruptGeneration !== ring.interruptGeneration) {
					ring.interruptGeneration = interruptGeneration;
					return -3;
				}
				var remaining =
					deadline === Infinity ? undefined : Math.max(0, deadline - Date.now());
				if (remaining === 0) return 0;
				try {
					if (
						Atomics.wait(
							ring.control,
							WasmIdleDebugTransportV1.EPOCH,
							epoch,
							remaining
						) === 'timed-out'
					)
						return 0;
				} catch (_) {
					return -1;
				}
			}
		},

		write: function (ring, source, length, timeoutMs) {
			if (!ring) return -1;
			var deadline = timeoutMs < 0 ? Infinity : Date.now() + timeoutMs;
			while (true) {
				var epoch = Atomics.load(ring.control, WasmIdleDebugTransportV1.EPOCH);
				if (!WasmIdleDebugTransportV1.validGeneration(ring)) return -1;
				var read = Atomics.load(ring.control, WasmIdleDebugTransportV1.READ) >>> 0;
				var write = Atomics.load(ring.control, WasmIdleDebugTransportV1.WRITE) >>> 0;
				var available = (write - read) >>> 0;
				if (available > ring.capacity) return -1;
				var state = Atomics.load(ring.control, WasmIdleDebugTransportV1.STATE);
				if (state === 1) return -2;
				if (state !== 0) return -1;
				var space = ring.capacity - available;
				if (space > 0) {
					var count = Math.min(space, length);
					var offset = write & (ring.capacity - 1);
					var first = Math.min(count, ring.capacity - offset);
					ring.data.set(HEAPU8.subarray(source, source + first), offset);
					if (first < count)
						ring.data.set(HEAPU8.subarray(source + first, source + count), 0);
					Atomics.store(
						ring.control,
						WasmIdleDebugTransportV1.WRITE,
						(write + count) | 0
					);
					WasmIdleDebugTransportV1.notify(ring);
					return count;
				}

				var remaining =
					deadline === Infinity ? undefined : Math.max(0, deadline - Date.now());
				if (remaining === 0) return 0;
				try {
					if (
						Atomics.wait(
							ring.control,
							WasmIdleDebugTransportV1.EPOCH,
							epoch,
							remaining
						) === 'timed-out'
					)
						return 0;
				} catch (_) {
					return -1;
				}
			}
		}
	},

	wasm_idle_rsp_read__deps: ['$WasmIdleDebugTransportV1'],
	wasm_idle_rsp_read: function (destination, length, timeoutMs) {
		if (length === 0) return 0;
		return WasmIdleDebugTransportV1.read(
			WasmIdleDebugTransportV1.rspInput,
			destination,
			length,
			timeoutMs
		);
	},

	wasm_idle_rsp_write__deps: ['$WasmIdleDebugTransportV1'],
	wasm_idle_rsp_write: function (source, length, timeoutMs) {
		if (length === 0) return 0;
		return WasmIdleDebugTransportV1.write(
			WasmIdleDebugTransportV1.rspOutput,
			source,
			length,
			timeoutMs
		);
	},

	wasm_idle_rsp_close__deps: ['$WasmIdleDebugTransportV1'],
	wasm_idle_rsp_close: function () {
		WasmIdleDebugTransportV1.close(WasmIdleDebugTransportV1.rspInput);
		WasmIdleDebugTransportV1.close(WasmIdleDebugTransportV1.rspOutput);
	},

	wasm_idle_rsp_interrupt__deps: ['$WasmIdleDebugTransportV1'],
	wasm_idle_rsp_interrupt: function () {
		var ring = WasmIdleDebugTransportV1.rspInput;
		if (!ring || !WasmIdleDebugTransportV1.validGeneration(ring)) return;
		Atomics.add(ring.control, WasmIdleDebugTransportV1.INTERRUPT, 1);
		WasmIdleDebugTransportV1.notify(ring);
	}
};

mergeInto(LibraryManager.library, LibraryWasmIdleDebugTransportV1);

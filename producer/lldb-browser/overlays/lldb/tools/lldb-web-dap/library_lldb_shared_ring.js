// shared-ring-v1 Emscripten import library.
//
// The host installs Module.wasmLldbSharedRingV1 before module initialization.
// Emscripten 6.0.0 starts modularized pthread workers with an empty moduleArg,
// so the companion lldb-web-dap.pthread.mjs bootstrap copies this registry to
// the pthread realm before importing the generated module. Each channel
// descriptor has a stable positive connectionId so every realm resolves the
// same endpoint without relying on a realm-local id allocator.

var LibraryWasmLldbSharedRingV1 = {
	$WasmLldbSharedRingV1__deps: ['$PThread'],
	$WasmLldbSharedRingV1__postset: 'WasmLldbSharedRingV1.installPthreadBootstrap();',
	$WasmLldbSharedRingV1: {
		RESULT_ERROR: -1,
		RESULT_TIMED_OUT: -2,
		RESULT_INTERRUPTED: -3,
		RESULT_CLOSED: -4,

		READ: 0,
		WRITE: 1,
		STATE: 2,
		EPOCH: 3,
		CAPACITY: 4,
		INTERRUPT: 5,
		CONTROL_CELLS: 6,

		CHANNEL_DAP: 0,
		CHANNEL_RSP: 1,
		PTHREAD_BOOTSTRAP_TYPE: 'wasm-lldb-shared-ring-v1-bootstrap',

		localConnections: new Map(),
		bootstrappedWorkers: new WeakSet(),

		registry: function () {
			var registry = Module['wasmLldbSharedRingV1'] || globalThis['wasmLldbSharedRingV1'];
			if (!registry || registry.protocol !== 'shared-ring-v1') return null;
			return registry;
		},

		bootstrapPthreadWorker: function (worker) {
			if (!worker || WasmLldbSharedRingV1.bootstrappedWorkers.has(worker)) return;
			var registry = WasmLldbSharedRingV1.registry();
			if (!registry)
				throw new Error('shared-ring-v1 registry is missing during pthread bootstrap');
			worker.postMessage({
				type: WasmLldbSharedRingV1.PTHREAD_BOOTSTRAP_TYPE,
				registry: registry
			});
			WasmLldbSharedRingV1.bootstrappedWorkers.add(worker);
		},

		installPthreadBootstrap: function () {
			if (typeof ENVIRONMENT_IS_PTHREAD !== 'undefined' && ENVIRONMENT_IS_PTHREAD) return;
			if (typeof PThread === 'undefined')
				throw new Error('shared-ring-v1 requires an Emscripten pthread build');
			if (!Module['mainScriptUrlOrBlob'])
				throw new Error(
					'shared-ring-v1 requires mainScriptUrlOrBlob to reference ' +
						'lldb-web-dap.pthread.mjs'
				);

			for (var worker of PThread.unusedWorkers)
				WasmLldbSharedRingV1.bootstrapPthreadWorker(worker);

			var allocateUnusedWorker = PThread.allocateUnusedWorker;
			PThread.allocateUnusedWorker = function () {
				var worker = allocateUnusedWorker.apply(PThread, arguments);
				WasmLldbSharedRingV1.bootstrapPthreadWorker(worker);
				return worker;
			};
		},

		makeRing: function (spec) {
			if (!spec || typeof SharedArrayBuffer === 'undefined') return null;
			if (
				!(spec.control instanceof SharedArrayBuffer) ||
				!(spec.data instanceof SharedArrayBuffer)
			)
				return null;

			var control = new Int32Array(spec.control);
			var data = new Uint8Array(spec.data);
			if (control.length < WasmLldbSharedRingV1.CONTROL_CELLS) return null;

			var capacity = Atomics.load(control, WasmLldbSharedRingV1.CAPACITY) >>> 0;
			if (
				capacity !== data.byteLength ||
				capacity < 4096 ||
				capacity > 16 * 1024 * 1024 ||
				(capacity & (capacity - 1)) !== 0
			)
				return null;

			return { control: control, data: data, capacity: capacity };
		},

		makeConnection: function (endpoint) {
			if (
				!endpoint ||
				!Number.isSafeInteger(endpoint.connectionId) ||
				endpoint.connectionId <= 0
			)
				return null;

			var rx = WasmLldbSharedRingV1.makeRing(endpoint.rx);
			var tx = WasmLldbSharedRingV1.makeRing(endpoint.tx);
			if (!rx || !tx) return null;

			return {
				id: endpoint.connectionId,
				rx: rx,
				tx: tx,
				interruptGeneration: Atomics.load(rx.control, WasmLldbSharedRingV1.INTERRUPT) >>> 0
			};
		},

		remember: function (endpoint) {
			var connection = WasmLldbSharedRingV1.makeConnection(endpoint);
			if (!connection) return null;
			WasmLldbSharedRingV1.localConnections.set(connection.id, connection);
			return connection;
		},

		findById: function (connectionId) {
			var cached = WasmLldbSharedRingV1.localConnections.get(connectionId);
			if (cached) return cached;

			var registry = WasmLldbSharedRingV1.registry();
			if (!registry || !registry.sessions) return null;

			var sessions =
				registry.sessions instanceof Map
					? Array.from(registry.sessions.values())
					: Object.values(registry.sessions);
			for (var index = 0; index < sessions.length; ++index) {
				var session = sessions[index];
				for (var channel of ['dap', 'rsp']) {
					var endpoint = session && session[channel];
					if (endpoint && endpoint.connectionId === connectionId)
						return WasmLldbSharedRingV1.remember(endpoint);
				}
			}
			return null;
		},

		endpoint: function (sessionId, channel) {
			var registry = WasmLldbSharedRingV1.registry();
			if (!registry || !registry.sessions) return null;
			var session =
				registry.sessions instanceof Map
					? registry.sessions.get(sessionId)
					: registry.sessions[sessionId];
			if (!session) return null;
			if (channel === WasmLldbSharedRingV1.CHANNEL_DAP) return session.dap;
			if (channel === WasmLldbSharedRingV1.CHANNEL_RSP) return session.rsp;
			return null;
		},

		notify: function (ring) {
			Atomics.add(ring.control, WasmLldbSharedRingV1.EPOCH, 1);
			Atomics.notify(ring.control, WasmLldbSharedRingV1.EPOCH);
		},

		state: function (ring) {
			return Atomics.load(ring.control, WasmLldbSharedRingV1.STATE);
		},

		wait: function (ring, observedEpoch, timeoutMilliseconds) {
			try {
				return Atomics.wait(
					ring.control,
					WasmLldbSharedRingV1.EPOCH,
					observedEpoch,
					timeoutMilliseconds
				);
			} catch (_) {
				return 'error';
			}
		},

		copyFromRing: function (ring, destination, length) {
			var read = Atomics.load(ring.control, WasmLldbSharedRingV1.READ) >>> 0;
			var write = Atomics.load(ring.control, WasmLldbSharedRingV1.WRITE) >>> 0;
			var available = (write - read) >>> 0;
			if (available > ring.capacity) return WasmLldbSharedRingV1.RESULT_ERROR;
			if (available === 0) return 0;

			var count = Math.min(available, length);
			var offset = read & (ring.capacity - 1);
			var first = Math.min(count, ring.capacity - offset);
			HEAPU8.set(ring.data.subarray(offset, offset + first), destination);
			if (first < count)
				HEAPU8.set(ring.data.subarray(0, count - first), destination + first);

			Atomics.store(ring.control, WasmLldbSharedRingV1.READ, (read + count) | 0);
			WasmLldbSharedRingV1.notify(ring);
			return count;
		},

		copyToRing: function (ring, source, length) {
			var read = Atomics.load(ring.control, WasmLldbSharedRingV1.READ) >>> 0;
			var write = Atomics.load(ring.control, WasmLldbSharedRingV1.WRITE) >>> 0;
			var available = (write - read) >>> 0;
			if (available > ring.capacity) return WasmLldbSharedRingV1.RESULT_ERROR;

			var space = ring.capacity - available;
			if (space === 0) return 0;

			var count = Math.min(space, length);
			var offset = write & (ring.capacity - 1);
			var first = Math.min(count, ring.capacity - offset);
			ring.data.set(HEAPU8.subarray(source, source + first), offset);
			if (first < count) ring.data.set(HEAPU8.subarray(source + first, source + count), 0);

			Atomics.store(ring.control, WasmLldbSharedRingV1.WRITE, (write + count) | 0);
			WasmLldbSharedRingV1.notify(ring);
			return count;
		},

		closeRing: function (ring) {
			Atomics.store(ring.control, WasmLldbSharedRingV1.STATE, 1);
			WasmLldbSharedRingV1.notify(ring);
		}
	},

	wasm_lldb_shared_ring_open__deps: ['$WasmLldbSharedRingV1', '$UTF8ToString'],
	wasm_lldb_shared_ring_open: function (sessionPointer, sessionLength, channel) {
		var sessionId = UTF8ToString(sessionPointer, sessionLength);
		if (!sessionId) return WasmLldbSharedRingV1.RESULT_ERROR;
		var endpoint = WasmLldbSharedRingV1.endpoint(sessionId, channel);
		var connection = WasmLldbSharedRingV1.remember(endpoint);
		return connection ? connection.id : WasmLldbSharedRingV1.RESULT_ERROR;
	},

	wasm_lldb_shared_ring_read__deps: ['$WasmLldbSharedRingV1'],
	wasm_lldb_shared_ring_read: function (connectionId, destination, length, timeoutMicroseconds) {
		if (length === 0) return 0;
		var connection = WasmLldbSharedRingV1.findById(connectionId);
		if (!connection) return WasmLldbSharedRingV1.RESULT_ERROR;

		var timeout = Number(timeoutMicroseconds);
		var deadline = timeout < 0 ? Infinity : performance.now() + timeout / 1000;

		while (true) {
			// Observe EPOCH before checking the ring so a producer update between
			// the check and Atomics.wait() makes the wait return "not-equal".
			var epoch = Atomics.load(connection.rx.control, WasmLldbSharedRingV1.EPOCH);
			var copied = WasmLldbSharedRingV1.copyFromRing(connection.rx, destination, length);
			// Match lldb_private::Connection's contract: pending bytes win over an
			// interrupt, which remains observable by the following Read().
			if (copied !== 0) return copied;

			var interruptGeneration =
				Atomics.load(connection.rx.control, WasmLldbSharedRingV1.INTERRUPT) >>> 0;
			if (interruptGeneration !== connection.interruptGeneration) {
				connection.interruptGeneration = interruptGeneration;
				return WasmLldbSharedRingV1.RESULT_INTERRUPTED;
			}

			var state = WasmLldbSharedRingV1.state(connection.rx);
			if (state === 1) return WasmLldbSharedRingV1.RESULT_CLOSED;
			if (state === 2) return WasmLldbSharedRingV1.RESULT_ERROR;

			var remaining =
				deadline === Infinity ? undefined : Math.max(0, deadline - performance.now());
			if (remaining === 0) return WasmLldbSharedRingV1.RESULT_TIMED_OUT;
			var waitResult = WasmLldbSharedRingV1.wait(connection.rx, epoch, remaining);
			if (waitResult === 'timed-out') return WasmLldbSharedRingV1.RESULT_TIMED_OUT;
			if (waitResult === 'error') return WasmLldbSharedRingV1.RESULT_ERROR;
		}
	},

	wasm_lldb_shared_ring_write__deps: ['$WasmLldbSharedRingV1'],
	wasm_lldb_shared_ring_write: function (connectionId, source, length) {
		if (length === 0) return 0;
		var connection = WasmLldbSharedRingV1.findById(connectionId);
		if (!connection) return WasmLldbSharedRingV1.RESULT_ERROR;

		while (true) {
			// As in read(), load EPOCH before observing ring state to avoid losing a
			// consumer notification between a full-ring check and Atomics.wait().
			var epoch = Atomics.load(connection.tx.control, WasmLldbSharedRingV1.EPOCH);
			var state = WasmLldbSharedRingV1.state(connection.tx);
			if (state === 1) return WasmLldbSharedRingV1.RESULT_CLOSED;
			if (state === 2) return WasmLldbSharedRingV1.RESULT_ERROR;
			var copied = WasmLldbSharedRingV1.copyToRing(connection.tx, source, length);
			if (copied !== 0) return copied;
			var waitResult = WasmLldbSharedRingV1.wait(connection.tx, epoch, undefined);
			if (waitResult === 'error') return WasmLldbSharedRingV1.RESULT_ERROR;
		}
	},

	wasm_lldb_shared_ring_interrupt__deps: ['$WasmLldbSharedRingV1'],
	wasm_lldb_shared_ring_interrupt: function (connectionId) {
		var connection = WasmLldbSharedRingV1.findById(connectionId);
		if (!connection) return WasmLldbSharedRingV1.RESULT_ERROR;
		Atomics.add(connection.rx.control, WasmLldbSharedRingV1.INTERRUPT, 1);
		WasmLldbSharedRingV1.notify(connection.rx);
		return 0;
	},

	wasm_lldb_shared_ring_close__deps: ['$WasmLldbSharedRingV1'],
	wasm_lldb_shared_ring_close: function (connectionId) {
		var connection = WasmLldbSharedRingV1.findById(connectionId);
		if (!connection) return WasmLldbSharedRingV1.RESULT_ERROR;
		WasmLldbSharedRingV1.closeRing(connection.rx);
		WasmLldbSharedRingV1.closeRing(connection.tx);
		WasmLldbSharedRingV1.localConnections.delete(connectionId);
		return 0;
	}
};

mergeInto(LibraryManager.library, LibraryWasmLldbSharedRingV1);

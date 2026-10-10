/* A controlled host observer of actual Kotlin allocations and the actual stdlib poll call. */
export async function observeAllocatorCanary(wasm) {
    function check(value, message) { if (!value) throw new Error(message); }
    const module = await WebAssembly.compile(wasm);
    const imports = WebAssembly.Module.imports(module);
    const allowed = new Set(['allocator_canary.boundary', 'allocator_canary.observed',
        'wasi_snapshot_preview1.fd_write', 'wasi_snapshot_preview1.poll_oneoff', 'wasi_snapshot_preview1.random_get', 'wasi_snapshot_preview1.proc_exit',
        'wasi_snapshot_preview1.args_sizes_get', 'wasi_snapshot_preview1.args_get']);
    check(imports.every(item => item.kind === 'function' && allowed.has(item.module + '.' + item.name)), 'Unexpected Wasm import');
    let instance, pending, again = true;
    const normalExit = {};
    const allocations = [], polls = [], stdout = [], writes = [], randomRequests = [];
    const memory = () => instance.exports.memory;
    const bytes = () => new Uint8Array(memory().buffer);
    const view = () => new DataView(memory().buffer);
    const range = (pointer, size) => {
        check(Number.isInteger(pointer) && pointer >= 0 && Number.isInteger(size) && size >= 0 && pointer + size <= bytes().length, 'Host memory range');
    };
    const host = {
        allocator_canary: {
            boundary(request, pointer, guard, abiBytes, mode) {
                check(!pending, 'Unpaired allocator callback');
                range(pointer, Math.max(request, abiBytes)); range(guard, 64);
                check(pointer % 8 === 0 && guard % 8 === 0, 'Unaligned genuine Kotlin allocation');
                check(guard >= pointer + request, 'Requested objects overlap');
                check(bytes().slice(guard, guard + 64).every(byte => byte === 0x6A), 'Missing initial canary');
                const overlap = Math.max(0, Math.min(pointer + abiBytes, guard + 64) - Math.max(pointer, guard));
                const initialAbiSpan = mode === 1 ? Array.from(bytes().slice(pointer, pointer + abiBytes)) : null;
                if (mode === 2) bytes().fill(0, pointer, pointer + abiBytes);
                else check(mode === 0 || mode === 1, 'Unknown allocator observation');
                pending = { request, pointer, guard, abiBytes, mode, distance: guard - pointer, overlap,
                    // Only bounded ABI cases retain bytes. Large general allocations retain their measured bounds.
                    inputBytes: mode === 1 ? initialAbiSpan : null };
            },
            observed(request, pointer, guard, abiBytes, mode, damaged) {
                check(pending && [request, pointer, guard, abiBytes, mode].every((value, index) =>
                    value === [pending.request, pending.pointer, pending.guard, pending.abiBytes, pending.mode][index]), 'Changed observer arguments');
                check(damaged === 0 && bytes().slice(guard, guard + 64).every(byte => byte === 0x6A), 'Kotlin allocator guard damaged');
                allocations.push({ ...pending, kotlinObservedDamagedBytes: damaged }); pending = null;
            },
        },
        wasi_snapshot_preview1: {
            random_get(pointer, size) {
                range(pointer, size);
                for (let offset = 0; offset < size; offset += 65536)
                    globalThis.crypto.getRandomValues(bytes().subarray(pointer + offset, pointer + Math.min(size, offset + 65536)));
                randomRequests.push({ pointer, size }); return 0;
            },
            args_sizes_get(argc, size) { range(argc, 4); range(size, 4); view().setUint32(argc, 0, true); view().setUint32(size, 0, true); return 0; },
            args_get() { return 0; },
            proc_exit(code) { check(code === 0, 'Program exit ' + code); throw normalExit; },
            fd_write(fd, vector, count, result) {
                check(fd === 1 && count === 1, 'Unexpected output operation'); range(vector, 8); range(result, 4);
                const pointer = view().getUint32(vector, true), size = view().getUint32(vector + 4, true); range(pointer, size);
                if (again) { again = false; writes.push({ errno: 6, requested: size, written: 0 }); return 6; }
                const written = Math.min(size, 3); stdout.push(...bytes().slice(pointer, pointer + written));
                view().setUint32(result, written, true); writes.push({ errno: 0, requested: size, written }); return 0;
            },
            poll_oneoff(subscription, event, count, result) {
                check(count === 1, 'Unexpected poll count'); range(subscription, 48); range(event, 32); range(result, 4);
                check([subscription, event, result].every(pointer => pointer % 8 === 0), 'Unaligned actual stdlib poll');
                const spans = [[subscription, subscription + 48], [event, event + 32], [result, result + 4]];
                for (let i = 0; i < spans.length; i++) for (let j = i + 1; j < spans.length; j++)
                    check(spans[i][1] <= spans[j][0] || spans[j][1] <= spans[i][0], 'Actual patched poll allocations overlap');
                const userdata = view().getBigUint64(subscription, true), type = view().getUint8(subscription + 8), fd = view().getUint32(subscription + 16, true);
                check(userdata === 0n && type === 2 && fd === 1, 'Unexpected actual stdlib subscription');
                const before = bytes().slice(subscription, subscription + 48);
                bytes().fill(0, event, event + 32);
                view().setBigUint64(event, userdata, true); view().setUint16(event + 8, 0, true);
                view().setUint8(event + 10, type); view().setBigUint64(event + 16, 1024n, true);
                view().setUint16(event + 24, 0, true); view().setUint32(result, 1, true);
                check(before.every((byte, index) => bytes()[subscription + index] === byte), 'Event output changed subscription input');
                polls.push({ subscription, event, result, count, subscriptionBytes: 48, eventBytes: 32,
                    userdata: userdata.toString(), type, fd, subscriptionUnchanged: true });
                return 0;
            },
        },
    };
    instance = await WebAssembly.instantiate(module, host);
    check(instance.exports.memory instanceof WebAssembly.Memory && typeof instance.exports._start === 'function', 'Missing WASI exports');
    try { instance.exports._start(); } catch (error) { if (error !== normalExit) throw error; }
    check(!pending && allocations.length === 81 && polls.length === 1, 'Incomplete allocator/poll execution');
    const originalSubscription = allocations.find(row => row.mode === 1 && row.request === 20);
    const patchedSubscription = allocations.find(row => row.mode === 1 && row.request === 48);
    check(originalSubscription.distance === 24 && originalSubscription.overlap === 24, 'Original-size subscription extent differs');
    check(patchedSubscription.distance === 48 && patchedSubscription.overlap === 0, 'Patched subscription extent differs');
    for (const row of allocations.filter(row => row.mode === 2)) check(row.distance === 32 && row.overlap === 0, 'Event allocation extent differs');
    const output = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(stdout));
    check(output === 'poll-canary-λ\n', 'Actual stdlib partial-write output differs');
    return { allocations, polls, writes, randomRequests, stdout: output, imports, memoryBytes: memory().buffer.byteLength,
        originalSizeProbeIsPatchedAllocator: true, unpatchedStdlibExecuted: false, actualUnpatchedCorruptionClaimed: false,
        fullWasiAcceptance: false, browserKotlinCompilation: false };
}

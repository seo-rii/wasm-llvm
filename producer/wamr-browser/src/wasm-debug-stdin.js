// Emscripten 6.0.0's doReadv performs a separate FS.read for every iovec.
// A blocking stdin device must read once per syscall: if the available input
// exactly fills one vector, reading the next vector would wait for more input.
// Retain the pinned implementation for files, pread, and single-vector reads.
mergeInto(LibraryManager.library, {
	$WasmIdleOriginalDoReadv__deps: ['$FS'].concat(
		LibraryManager.library.$doReadv__deps || []
	),
	$WasmIdleOriginalDoReadv: LibraryManager.library.$doReadv,
	$doReadv__deps: ['$FS', '$WasmIdleOriginalDoReadv'],
	$doReadv: function (stream, iov, iovcnt, offset) {
		if (stream.fd !== 0 || iovcnt <= 1 || offset !== undefined) {
			return WasmIdleOriginalDoReadv(stream, iov, iovcnt, offset);
		}
		if (iov < 0 || iov > HEAPU8.length || iovcnt > (HEAPU8.length - iov) / 8) {
			throw new FS.ErrnoError({{{ cDefs.EFAULT }}});
		}

		// A short read is valid even when the caller supplied a larger buffer.
		// Bound the scratch allocation independently of guest-provided lengths.
		var limit = 64 * 1024;
		var vectors = [];
		var total = 0;
		for (var i = 0; i < iovcnt && total < limit; i++, iov += 8) {
			var pointer = HEAPU32[iov >> 2];
			var length = HEAPU32[(iov + 4) >> 2];
			if (length === 0) continue;
			if (pointer > HEAPU8.length || length > HEAPU8.length - pointer) {
				throw new FS.ErrnoError({{{ cDefs.EFAULT }}});
			}
			length = Math.min(length, limit - total);
			vectors.push([pointer, length]);
			total += length;
		}
		if (total === 0) return 0;

		var buffer = new Uint8Array(total);
		var bytesRead = FS.read(stream, buffer, 0, total);
		if (bytesRead < 0) return -1;
		var copied = 0;
		for (var vector of vectors) {
			var count = Math.min(vector[1], bytesRead - copied);
			if (count === 0) break;
			HEAPU8.set(buffer.subarray(copied, copied + count), vector[0]);
			copied += count;
		}
		return bytesRead;
	}
});

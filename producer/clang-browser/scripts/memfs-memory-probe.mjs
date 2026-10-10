// Self-contained so the same probe can execute in Node and a real browser Worker.
// The host implements memory copies only; all filesystem operations call compiled C.
export async function runMemfsMemoryProbe({ bytes, mode = 'candidate' }) {
  const module = await WebAssembly.compile(new Uint8Array(bytes));
  const results = [];
  const metrics = {};
  const equal = (actual, expected, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
    }
  };
  function createFs() {
    const guest = new Uint8Array(1024 * 1024);
    const view = new DataView(guest.buffer);
    let exports;
    let zeroed = 0;
    let copiedOut = 0;
    const memory = () => new Uint8Array(exports.memory.buffer);
    function range(array, start, count) {
      start >>>= 0;
      count >>>= 0;
      if (start > array.length || count > array.length - start) throw new Error('Host copy out of range');
      return array.subarray(start, start + count);
    }
    const instance = new WebAssembly.Instance(module, { env: {
      copy_in(destination, source, count) {
        range(memory(), destination, count).set(range(guest, source, count));
      },
      copy_out(destination, source, count) {
        range(guest, destination, count).set(range(memory(), source, count));
        copiedOut += count >>> 0;
      },
      host_read() { throw new Error('Unexpected host stdin'); },
      host_write() { throw new Error('Unexpected host stdout'); },
      memfs_log() {},
      memfs_test_zeroed(count) { zeroed += count >>> 0; }
    } });
    exports = instance.exports;
    exports.init();
    function open(name, data = []) {
      const encoded = new TextEncoder().encode(name);
      memory().set(encoded, exports.GetPathBuf());
      const inode = exports.AddFileNode(encoded.length, data.length);
      memory().set(data, exports.GetFileNodeAddress(inode));
      guest.set(encoded, 128);
      equal(exports.path_open(3, 0, 128, encoded.length, 0, 0n, 0n, 0, 64), 0, 'path_open');
      return { fd: view.getUint32(64, true), inode };
    }
    function vectors(lengths) {
      const starts = lengths.map((length, index) => 4096 + index * 256);
      for (let i = 0; i < lengths.length; i++) {
        view.setUint32(256 + i * 8, starts[i], true);
        view.setUint32(260 + i * 8, lengths[i], true);
      }
      return starts;
    }
    function pread(fd, lengths, offset) {
      guest.fill(0xa5, 4096, 8192);
      const starts = vectors(lengths);
      const errno = exports.fd_pread(fd, 256, lengths.length, BigInt(offset), 64);
      return { errno, count: view.getUint32(64, true), starts };
    }
    function write(fd, data) {
      guest.set(data, 16384);
      view.setUint32(256, 16384, true);
      view.setUint32(260, data.length, true);
      const errno = exports.fd_write(fd, 256, 1, 64);
      return { errno, count: view.getUint32(64, true) };
    }
    function contents(inode) {
      const size = exports.GetFileNodeSize(inode);
      return Array.from(range(memory(), exports.GetFileNodeAddress(inode), size));
    }
    return { guest, view, exports, open, vectors, pread, write, contents,
      resetCounters() { zeroed = 0; copiedOut = 0; },
      counters() { return { zeroed, copiedOut }; } };
  }
  function test(name, fn) {
    try { fn(createFs()); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, error: String(error?.stack || error) }); }
  }
  if (mode !== 'counters') {
    test('short-read-canary', (fs) => {
      const { fd } = fs.open('short.bin', [10, 20, 30, 40, 50, 60]);
      fs.resetCounters();
      const result = fs.pread(fd, [1], 0);
      equal(result.errno, 0, 'pread errno');
      equal(result.count, 1, 'requested read count');
      equal(Array.from(fs.guest.slice(4096, 4099)), [10, 0xa5, 0xa5], 'read canary');
      // Four additional bytes are the nread result, not file payload.
      equal(fs.counters().copiedOut, 5, 'host copied bytes');
    });
    if (mode === 'baseline') return { mode, results, metrics };
    test('vectors-stop-at-eof', (fs) => {
      const { fd } = fs.open('vectors.bin', [1, 2, 3, 4, 5, 6]);
      const result = fs.pread(fd, [2, 8], 1);
      equal(result.errno, 0, 'errno'); equal(result.count, 5, 'read count');
      equal(Array.from(fs.guest.slice(result.starts[0], result.starts[0] + 3)), [2, 3, 0xa5], 'first vector');
      equal(Array.from(fs.guest.slice(result.starts[1], result.starts[1] + 4)), [4, 5, 6, 0xa5], 'last vector');
    });
    test('eof-and-huge-offset-do-not-copy', (fs) => {
      const { fd } = fs.open('eof.bin', [1, 2]);
      for (const offset of [2n, 3n, 0xffffffffffffffffn]) {
        const result = fs.pread(fd, [4], offset);
        equal(result.errno, 0, 'errno'); equal(result.count, 0, 'EOF count');
        equal(fs.guest[4096], 0xa5, 'EOF canary');
      }
    });
    test('zero-length-vector-keeps-next-position', (fs) => {
      const { fd } = fs.open('zero.bin', [7, 8]);
      const result = fs.pread(fd, [0, 1], 0);
      equal(result.errno, 0, 'errno'); equal(result.count, 1, 'count');
      equal(fs.guest[result.starts[0]], 0xa5, 'empty vector');
      equal(fs.guest[result.starts[1]], 7, 'second vector');
    });
    test('pread-preserves-fd-read-cursor', (fs) => {
      const { fd } = fs.open('cursor.bin', [11, 22, 33]);
      fs.pread(fd, [1], 2);
      fs.vectors([1]);
      equal(fs.exports.fd_read(fd, 256, 1, 64), 0, 'read errno');
      equal(fs.guest[4096], 11, 'first sequential byte');
      equal(fs.exports.fd_read(fd, 256, 1, 64), 0, 'second read errno');
      equal(fs.guest[4096], 22, 'second sequential byte');
    });
    test('truncate-gap-is-zero-and-empty-write-does-not-grow', (fs) => {
      const { fd, inode } = fs.open('gap.bin');
      equal(fs.write(fd, [1, 2, 3, 4, 5, 6, 7, 8]), { errno: 0, count: 8 }, 'initial write');
      equal(fs.exports.fd_filestat_set_size(fd, 2n), 0, 'truncate');
      equal(fs.write(fd, []), { errno: 0, count: 0 }, 'empty write');
      equal(fs.contents(inode), [1, 2], 'unchanged size');
      equal(fs.write(fd, [9, 10]), { errno: 0, count: 2 }, 'gap write');
      equal(fs.contents(inode), [1, 2, 0, 0, 0, 0, 0, 0, 9, 10], 'gap bytes');
    });
    test('truncate-expansion-and-allocate-retain-zero-fill', (fs) => {
      const { fd, inode } = fs.open('expand.bin', [1, 2]);
      equal(fs.exports.fd_filestat_set_size(fd, 6n), 0, 'expand');
      equal(fs.contents(inode), [1, 2, 0, 0, 0, 0], 'expanded bytes');
      equal(fs.exports.fd_allocate(fd, 6n, 2n), 0, 'allocate');
      equal(fs.contents(inode), [1, 2, 0, 0, 0, 0, 0, 0], 'allocated bytes');
    });
    test('write-overflow-rejected-before-copy-or-growth', (fs) => {
      const { fd, inode } = fs.open('overflow.bin');
      fs.vectors([0xffffffff, 1]);
      equal(fs.exports.fd_write(fd, 256, 2, 64), 61, 'WASI overflow');
      equal(fs.contents(inode), [], 'no growth');
    });
    test('descriptor-upper-bound-is-invalid', (fs) => {
      equal(fs.exports.fd_close(4096), 8, 'MAX_FDS is invalid');
      equal(fs.exports.fd_close(0xffffffff), 8, 'large fd is invalid');
    });
    test('binary-unicode-round-trip', (fs) => {
      const input = Array.from(new TextEncoder().encode('한글🙂\u0000é\r\n'));
      const { fd } = fs.open('unicode.bin');
      equal(fs.write(fd, input), { errno: 0, count: input.length }, 'write');
      const result = fs.pread(fd, [input.length + 2], 0);
      equal(result.count, input.length, 'read count');
      equal(Array.from(fs.guest.slice(4096, 4096 + input.length)), input, 'raw bytes');
      equal(fs.guest[4096 + input.length], 0xa5, 'tail canary');
    });
  } else {
    test('zero-fill-operation-counts', (fs) => {
      const { fd, inode } = fs.open('counts.bin');
      const data = Array.from({ length: 65536 }, (_, i) => i & 255);
      fs.resetCounters();
      equal(fs.write(fd, data), { errno: 0, count: data.length }, 'large write');
      metrics.freshWriteZeroedBytes = fs.counters().zeroed;
      equal(fs.contents(inode), data, 'large write contents');
      equal(fs.exports.fd_filestat_set_size(fd, 2n), 0, 'truncate');
      // Cursor remains 65536; exactly that unwritten gap must be zero-filled.
      fs.resetCounters();
      equal(fs.write(fd, [99]), { errno: 0, count: 1 }, 'gap write');
      metrics.gapWriteZeroedBytes = fs.counters().zeroed;
      const output = fs.contents(inode);
      equal(output.length, 65537, 'gap size');
      equal(output.slice(0, 2), [0, 1], 'prefix');
      equal(output.slice(2, -1).every((byte) => byte === 0), true, 'gap zeroes');
      equal(output.at(-1), 99, 'last byte');
    });
  }
  return { mode, results, metrics };
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { patchMemfsMemorySource, instrumentMemfsZeroFill, replaceOnce } from '../producer/clang-browser/scripts/memfs-memory-patch.mjs';

// A patch-contract fixture, not a C execution test. The pinned real-source build
// and actual Wasm/Chromium probe are required separately by the candidate job.
const fixture = `#include <wasi/api.h>
static size_t ReadIovec(Node *node, __wasi_iovec_t *iovs, size_t iovs_len,
                        __wasi_filesize_t offset) {
  if (offset + len < node->file.size) {}
  copy_out(buf, data + offset + total_len, len);
}
return fd <= MAX_FDS && valid;
    total_len += iovs_copy[i].buf_len;
  __wasi_filesize_t offset = fdesc->offset;
  __wasi_filesize_t end = offset + total_len;
  EnsureFileSize(node, end);
    copy_in((char *)node->file.data + offset, iov->buf, len);
static void EnsureFileSize(Node *node) {}
`;

test('bounds reads by remaining bytes and advances the position per vector', () => {
  const result = patchMemfsMemorySource(fixture);
  assert.match(result, /if \(offset >= node->file.size\) break;/);
  assert.match(result, /if \(len > remaining\) len = \(size_t\)remaining;/);
  assert.match(result, /offset \+= len;/);
  assert.doesNotMatch(result, /data \+ offset \+ total_len/);
});
test('keeps zero-fill for gaps but not bytes about to be overwritten', () => {
  const result = patchMemfsMemorySource(fixture);
  assert.match(result, /if \(total_len != 0 && end > node->file.size\)/);
  assert.match(result, /offset - old_size/);
  assert.match(result, /__WASI_ERRNO_OVERFLOW/);
  assert.match(result, /__WASI_ERRNO_NOMEM/);
  assert.match(result, /fd < MAX_FDS/);
});
test('rejects non-modernized, duplicate and drifted source', () => {
  assert.throws(() => patchMemfsMemorySource(''), /modernized/);
  assert.throws(() => patchMemfsMemorySource(fixture + fixture), /Unexpected/);
  assert.throws(() => patchMemfsMemorySource(fixture.replace('offset + len <', 'offset + len >')), /Unexpected/);
  assert.throws(() => patchMemfsMemorySource(patchMemfsMemorySource(fixture)), /already applied/);
});
test('replacement contexts must be unique', () => {
  assert.throws(() => replaceOnce('a a', 'a', 'b'), /ambiguous/);
  assert.throws(() => replaceOnce('c', 'a', 'b'), /missing/);
});
test('instrumentation is an explicit extra test-only import', () => {
  const plain = patchMemfsMemorySource(fixture);
  assert.doesNotMatch(plain, /memfs_test_zeroed/);
  assert.match(instrumentMemfsZeroFill(plain), /extern void memfs_test_zeroed/);
});

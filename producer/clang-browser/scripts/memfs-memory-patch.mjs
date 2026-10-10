// This patch operates on the hash-verified upstream source after the existing
// WASI compatibility patch. It is deliberately not a general C source rewriter.
export const patchId = 'bounded-memory-io-v1';

export function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('MemFS patch context is missing or ambiguous');
  return source.replace(before, after);
}

export function patchMemfsMemorySource(source) {
  if (typeof source !== 'string' || !source.includes('#include <wasi/api.h>')) {
    throw new Error('Expected modernized MemFS source');
  }
  if (source.includes(patchId)) throw new Error('MemFS memory patch already applied');
  const readers = source.match(/static size_t ReadIovec\([\s\S]*?\n\}/g);
  if (readers?.length !== 1 ||
      !readers[0].includes('if (offset + len < node->file.size)') ||
      !readers[0].includes('offset + total_len')) {
    throw new Error('Unexpected upstream ReadIovec implementation');
  }
  source = replaceOnce(source, readers[0], `/* wasm-llvm ${patchId} */
static size_t ReadIovec(Node *node, __wasi_iovec_t *iovs, size_t iovs_len,
                        __wasi_filesize_t offset) {
  size_t total_len = 0;
  for (size_t i = 0; i < iovs_len; ++i) {
    if (offset >= node->file.size) break;
    __wasi_filesize_t remaining = node->file.size - offset;
    size_t len = iovs[i].buf_len;
    if (len > remaining) len = (size_t)remaining;
    if (len == 0) continue;
    copy_out(iovs[i].buf, (char *)node->file.data + offset, len);
    offset += len;
    total_len += len;
  }
  return total_len;
}`);
  source = replaceOnce(source, 'return fd <= MAX_FDS &&', 'return fd < MAX_FDS &&');
  source = replaceOnce(source, '    total_len += iovs_copy[i].buf_len;', `    if (iovs_copy[i].buf_len > SIZE_MAX - total_len)
      return TRACE_ERRNO(__WASI_ERRNO_OVERFLOW);
    total_len += iovs_copy[i].buf_len;`);
  source = replaceOnce(source, `  __wasi_filesize_t offset = fdesc->offset;
  __wasi_filesize_t end = offset + total_len;
  EnsureFileSize(node, end);`, `  __wasi_filesize_t offset = fdesc->offset;
  if (offset > SIZE_MAX || total_len > SIZE_MAX - (size_t)offset)
    return TRACE_ERRNO(__WASI_ERRNO_FBIG);
  __wasi_filesize_t end = offset + total_len;
  // Every non-gap byte is overwritten by the validated contiguous iovec stream.
  // Keep EnsureFileSize's full zero-fill for allocate/truncate expansion.
  if (total_len != 0 && end > node->file.size) {
    __wasi_filesize_t old_size = node->file.size;
    void *new_data = realloc(node->file.data, (size_t)end);
    if (new_data == NULL) return TRACE_ERRNO(__WASI_ERRNO_NOMEM);
    if (offset > old_size)
      memset((char *)new_data + old_size, 0, (size_t)(offset - old_size));
    node->file.data = new_data;
    node->file.size = end;
    node->stat.size = end;
  }`);
  source = replaceOnce(source,
    '    copy_in((char *)node->file.data + offset, iov->buf, len);',
    '    if (len != 0) copy_in((char *)node->file.data + offset, iov->buf, len);');
  return source;
}

// Test builds only: count explicit zero-fill requested by the C source. This
// does not count allocator-internal initialization and is not elapsed-time data.
export function instrumentMemfsZeroFill(source) {
  return replaceOnce(source, 'static void EnsureFileSize(', `extern void memfs_test_zeroed(size_t size);
static void *memfs_test_memset(void *destination, int value, size_t size) {
  if (value == 0) memfs_test_zeroed(size);
  return memset(destination, value, size);
}
#define memset memfs_test_memset

static void EnsureFileSize(`);
}

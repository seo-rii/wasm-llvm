//===-- ConnectionMessagePort.cpp ------------------------------*- C++ -*-===//
//
// Part of the wasm-llvm browser LLDB overlay.
//
//===----------------------------------------------------------------------===//

#include "ConnectionMessagePort.h"

#include "lldb/Utility/Status.h"
#include "lldb/Utility/Timeout.h"

#include <algorithm>
#include <cstdint>
#include <limits>

using namespace lldb;
using namespace lldb_private;
using namespace lldb_private::process_gdb_remote;

extern "C" {
int32_t wasm_lldb_shared_ring_open(const char *session,
                                   uint32_t session_length, uint32_t channel);
int32_t wasm_lldb_shared_ring_read(int32_t connection, uint8_t *destination,
                                   uint32_t length,
                                   int64_t timeout_microseconds);
int32_t wasm_lldb_shared_ring_write(int32_t connection, const uint8_t *source,
                                    uint32_t length);
int32_t wasm_lldb_shared_ring_interrupt(int32_t connection);
int32_t wasm_lldb_shared_ring_close(int32_t connection);
}

namespace {
enum TransportResult : int32_t {
  TransportError = -1,
  TransportTimedOut = -2,
  TransportInterrupted = -3,
  TransportClosed = -4,
};

void ClearError(Status *error_ptr) {
  if (error_ptr)
    error_ptr->Clear();
}

void SetError(Status *error_ptr, const char *message) {
  if (error_ptr)
    *error_ptr = Status::FromErrorString(message);
}

uint32_t ClampLength(size_t length) {
  return static_cast<uint32_t>(
      std::min(length, static_cast<size_t>(std::numeric_limits<uint32_t>::max())));
}

size_t MapResult(int32_t result, ConnectionStatus &status,
                 Status *error_ptr) {
  if (result >= 0) {
    status = eConnectionStatusSuccess;
    ClearError(error_ptr);
    return static_cast<size_t>(result);
  }

  switch (result) {
  case TransportTimedOut:
    status = eConnectionStatusTimedOut;
    ClearError(error_ptr);
    break;
  case TransportInterrupted:
    status = eConnectionStatusInterrupted;
    ClearError(error_ptr);
    break;
  case TransportClosed:
    status = eConnectionStatusEndOfFile;
    ClearError(error_ptr);
    break;
  case TransportError:
  default:
    status = eConnectionStatusError;
    SetError(error_ptr, "shared-ring-v1 transport error");
    break;
  }
  return 0;
}
} // namespace

ConnectionMessagePort::~ConnectionMessagePort() { Disconnect(nullptr); }

ConnectionStatus ConnectionMessagePort::Connect(llvm::StringRef url,
                                                Status *error_ptr) {
  if (!Supports(url)) {
    SetError(error_ptr, "expected wasm-messageport://<session-id>");
    return eConnectionStatusError;
  }

  llvm::StringRef session = url.drop_front(Scheme.size());
  if (session.empty()) {
    SetError(error_ptr, "wasm-messageport URL has an empty session id");
    return eConnectionStatusError;
  }
  if (session.size() > std::numeric_limits<uint32_t>::max()) {
    SetError(error_ptr, "wasm-messageport session id is too long");
    return eConnectionStatusError;
  }

  Disconnect(nullptr);
  const int32_t connection = wasm_lldb_shared_ring_open(
      session.data(), static_cast<uint32_t>(session.size()), RspChannel);
  if (connection <= 0) {
    SetError(error_ptr, "shared-ring-v1 host rejected the RSP session");
    return eConnectionStatusError;
  }

  {
    std::lock_guard<std::mutex> lock(m_uri_mutex);
    m_uri = url.str();
  }
  m_connection.store(connection, std::memory_order_release);
  ClearError(error_ptr);
  return eConnectionStatusSuccess;
}

ConnectionStatus ConnectionMessagePort::Disconnect(Status *error_ptr) {
  const int32_t connection =
      m_connection.exchange(-1, std::memory_order_acq_rel);
  {
    std::lock_guard<std::mutex> lock(m_uri_mutex);
    m_uri.clear();
  }
  if (connection <= 0) {
    ClearError(error_ptr);
    return eConnectionStatusSuccess;
  }

  if (wasm_lldb_shared_ring_close(connection) < 0) {
    SetError(error_ptr, "failed to close shared-ring-v1 connection");
    return eConnectionStatusError;
  }
  ClearError(error_ptr);
  return eConnectionStatusSuccess;
}

bool ConnectionMessagePort::IsConnected() const {
  return m_connection.load(std::memory_order_acquire) > 0;
}

size_t ConnectionMessagePort::Read(void *dst, size_t dst_len,
                                   const Timeout<std::micro> &timeout,
                                   ConnectionStatus &status,
                                   Status *error_ptr) {
  const int32_t connection = m_connection.load(std::memory_order_acquire);
  if (connection <= 0) {
    status = eConnectionStatusNoConnection;
    SetError(error_ptr, "shared-ring-v1 connection is not open");
    return 0;
  }
  if (dst_len == 0) {
    status = eConnectionStatusSuccess;
    ClearError(error_ptr);
    return 0;
  }

  const int64_t timeout_microseconds = timeout ? timeout->count() : -1;
  return MapResult(
      wasm_lldb_shared_ring_read(connection, static_cast<uint8_t *>(dst),
                                 ClampLength(dst_len), timeout_microseconds),
      status, error_ptr);
}

size_t ConnectionMessagePort::Write(const void *src, size_t src_len,
                                    ConnectionStatus &status,
                                    Status *error_ptr) {
  const int32_t connection = m_connection.load(std::memory_order_acquire);
  if (connection <= 0) {
    status = eConnectionStatusNoConnection;
    SetError(error_ptr, "shared-ring-v1 connection is not open");
    return 0;
  }
  if (src_len == 0) {
    status = eConnectionStatusSuccess;
    ClearError(error_ptr);
    return 0;
  }

  return MapResult(
      wasm_lldb_shared_ring_write(connection,
                                  static_cast<const uint8_t *>(src),
                                  ClampLength(src_len)),
      status, error_ptr);
}

std::string ConnectionMessagePort::GetURI() {
  std::lock_guard<std::mutex> lock(m_uri_mutex);
  return m_uri;
}

bool ConnectionMessagePort::InterruptRead() {
  const int32_t connection = m_connection.load(std::memory_order_acquire);
  return connection > 0 &&
         wasm_lldb_shared_ring_interrupt(connection) >= 0;
}

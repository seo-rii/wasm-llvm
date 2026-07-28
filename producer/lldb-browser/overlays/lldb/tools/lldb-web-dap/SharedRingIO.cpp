//===-- SharedRingIO.cpp -----------------------------------------------===//
//
// Part of the wasm-llvm browser LLDB overlay.
//
//===----------------------------------------------------------------------===//

#include "SharedRingIO.h"

#include "lldb/Utility/Status.h"

#include <algorithm>
#include <cerrno>
#include <cstring>
#include <limits>
#include <unistd.h>

using namespace lldb_private;

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
constexpr int32_t TransportError = -1;
constexpr int32_t TransportTimedOut = -2;
constexpr int32_t TransportInterrupted = -3;
constexpr int32_t TransportClosed = -4;
constexpr size_t PumpBufferSize = 4096;

uint32_t ClampLength(size_t length) {
  return static_cast<uint32_t>(
      std::min(length, static_cast<size_t>(std::numeric_limits<uint32_t>::max())));
}
} // namespace

namespace lldb_web_dap {

SharedRingIO::SharedRingIO(std::string session_id)
    : IOObject(eFDTypeFile), m_session_id(std::move(session_id)) {
  if (m_session_id.empty() ||
      m_session_id.size() > std::numeric_limits<uint32_t>::max()) {
    m_failure = "invalid shared-ring-v1 DAP session id";
    return;
  }
  if (::pipe(m_signal_pipe) != 0) {
    m_failure = std::strerror(errno);
    return;
  }

  const int32_t connection = wasm_lldb_shared_ring_open(
      m_session_id.data(), static_cast<uint32_t>(m_session_id.size()),
      DapChannel);
  if (connection <= 0) {
    m_failure = "shared-ring-v1 host rejected the DAP session";
    ::close(m_signal_pipe[0]);
    ::close(m_signal_pipe[1]);
    m_signal_pipe[0] = m_signal_pipe[1] = -1;
    return;
  }

  m_connection.store(connection, std::memory_order_release);
  m_pump = std::thread(&SharedRingIO::Pump, this);
}

SharedRingIO::~SharedRingIO() { llvm::consumeError(Close().takeError()); }

void SharedRingIO::Signal() {
  if (m_signal_pipe[1] < 0)
    return;
  const uint8_t signal = 1;
  ssize_t result;
  do {
    result = ::write(m_signal_pipe[1], &signal, sizeof(signal));
  } while (result < 0 && errno == EINTR);
}

void SharedRingIO::Pump() {
  uint8_t buffer[PumpBufferSize];
  const int32_t connection = m_connection.load(std::memory_order_acquire);
  while (!m_stopping.load(std::memory_order_acquire)) {
    const int32_t result = wasm_lldb_shared_ring_read(
        connection, buffer, sizeof(buffer), -1);
    if (result > 0) {
      bool should_signal = false;
      {
        std::lock_guard<std::mutex> lock(m_mutex);
        should_signal = m_pending.empty();
        m_pending.insert(m_pending.end(), buffer, buffer + result);
      }
      if (should_signal)
        Signal();
      continue;
    }
    if (result == TransportTimedOut || result == TransportInterrupted) {
      if (!m_stopping.load(std::memory_order_acquire))
        continue;
    }

    {
      std::lock_guard<std::mutex> lock(m_mutex);
      m_eof = true;
      if (result == TransportError)
        m_failure = "shared-ring-v1 DAP read failed";
      else if (result != TransportClosed &&
               !m_stopping.load(std::memory_order_acquire))
        m_failure = "shared-ring-v1 DAP read returned an invalid status";
    }
    Signal();
    return;
  }
}

Status SharedRingIO::Read(void *buffer, size_t &num_bytes) {
  const size_t requested = num_bytes;
  num_bytes = 0;
  if (requested == 0)
    return Status();
  if (m_signal_pipe[0] < 0)
    return Status::FromErrorString("shared-ring-v1 DAP signal pipe is closed");

  uint8_t signal;
  ssize_t result;
  do {
    result = ::read(m_signal_pipe[0], &signal, sizeof(signal));
  } while (result < 0 && errno == EINTR);
  if (result <= 0)
    return result == 0 ? Status()
                       : Status::FromErrorString(std::strerror(errno));

  bool signal_again = false;
  std::string failure;
  {
    std::lock_guard<std::mutex> lock(m_mutex);
    const size_t count = std::min(requested, m_pending.size());
    auto *destination = static_cast<uint8_t *>(buffer);
    for (size_t index = 0; index < count; ++index) {
      destination[index] = m_pending.front();
      m_pending.pop_front();
    }
    num_bytes = count;
    signal_again = !m_pending.empty() || (m_eof && count > 0);
    if (count == 0)
      failure = m_failure;
  }
  if (signal_again)
    Signal();
  if (!failure.empty())
    return Status::FromErrorString(failure.c_str());
  return Status();
}

Status SharedRingIO::Write(const void *buffer, size_t &num_bytes) {
  const size_t requested = num_bytes;
  num_bytes = 0;
  if (requested == 0)
    return Status();

  const int32_t connection = m_connection.load(std::memory_order_acquire);
  if (connection <= 0)
    return Status::FromErrorString("shared-ring-v1 DAP connection is closed");

  const auto *source = static_cast<const uint8_t *>(buffer);
  while (num_bytes < requested) {
    const int32_t result = wasm_lldb_shared_ring_write(
        connection, source + num_bytes, ClampLength(requested - num_bytes));
    if (result > 0) {
      num_bytes += static_cast<size_t>(result);
      continue;
    }
    if (result == TransportInterrupted &&
        !m_stopping.load(std::memory_order_acquire))
      continue;
    if (result == TransportClosed)
      return Status::FromErrorString("shared-ring-v1 DAP peer closed");
    return Status::FromErrorString("shared-ring-v1 DAP write failed");
  }
  return Status();
}

bool SharedRingIO::IsValid() const {
  return m_connection.load(std::memory_order_acquire) > 0 &&
         m_signal_pipe[0] >= 0;
}

Status SharedRingIO::Close() {
  if (m_stopping.exchange(true, std::memory_order_acq_rel))
    return Status();

  const int32_t connection = m_connection.load(std::memory_order_acquire);
  if (connection > 0)
    wasm_lldb_shared_ring_interrupt(connection);
  if (m_pump.joinable())
    m_pump.join();

  Status status;
  if (connection > 0 && wasm_lldb_shared_ring_close(connection) < 0)
    status = Status::FromErrorString(
        "failed to close shared-ring-v1 DAP connection");
  m_connection.store(-1, std::memory_order_release);

  if (m_signal_pipe[0] >= 0)
    ::close(m_signal_pipe[0]);
  if (m_signal_pipe[1] >= 0)
    ::close(m_signal_pipe[1]);
  m_signal_pipe[0] = m_signal_pipe[1] = -1;
  return status;
}

SharedRingIO::WaitableHandle SharedRingIO::GetWaitableHandle() {
  return m_signal_pipe[0];
}

} // namespace lldb_web_dap

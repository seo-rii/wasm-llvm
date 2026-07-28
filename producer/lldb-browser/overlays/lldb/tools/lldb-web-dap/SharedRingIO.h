//===-- SharedRingIO.h -----------------------------------------*- C++ -*-===//
//
// Part of the wasm-llvm browser LLDB overlay.
//
//===----------------------------------------------------------------------===//

#ifndef LLDB_TOOLS_LLDB_WEB_DAP_SHAREDRINGIO_H
#define LLDB_TOOLS_LLDB_WEB_DAP_SHAREDRINGIO_H

#include "lldb/Utility/IOObject.h"

#include <atomic>
#include <cstdint>
#include <deque>
#include <mutex>
#include <string>
#include <thread>

namespace lldb_web_dap {

/// Adapts the blocking shared-ring-v1 DAP channel to LLDB's MainLoop.
///
/// A pump pthread waits on the inbound ring and signals a POSIX pipe. The pipe
/// is only a local readiness primitive; DAP payload bytes never pass through
/// stdin/stdout or mix with the target RSP stream.
class SharedRingIO final : public lldb_private::IOObject {
public:
  explicit SharedRingIO(std::string session_id);
  ~SharedRingIO() override;

  lldb_private::Status Read(void *buffer, size_t &num_bytes) override;
  lldb_private::Status Write(const void *buffer, size_t &num_bytes) override;
  bool IsValid() const override;
  lldb_private::Status Close() override;
  WaitableHandle GetWaitableHandle() override;

private:
  static constexpr uint32_t DapChannel = 0;

  void Pump();
  void Signal();

  std::string m_session_id;
  std::atomic<int32_t> m_connection{-1};
  std::atomic<bool> m_stopping{false};
  int m_signal_pipe[2]{-1, -1};
  std::thread m_pump;

  mutable std::mutex m_mutex;
  std::deque<uint8_t> m_pending;
  bool m_eof = false;
  std::string m_failure;
};

} // namespace lldb_web_dap

#endif

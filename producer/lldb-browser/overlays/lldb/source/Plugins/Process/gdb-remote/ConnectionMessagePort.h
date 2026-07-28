//===-- ConnectionMessagePort.h --------------------------------*- C++ -*-===//
//
// Part of the wasm-llvm browser LLDB overlay.
//
//===----------------------------------------------------------------------===//

#ifndef LLDB_SOURCE_PLUGINS_PROCESS_GDB_REMOTE_CONNECTIONMESSAGEPORT_H
#define LLDB_SOURCE_PLUGINS_PROCESS_GDB_REMOTE_CONNECTIONMESSAGEPORT_H

#include "lldb/Utility/Connection.h"

#include <atomic>
#include <mutex>
#include <string>

namespace lldb_private::process_gdb_remote {

/// A byte-stream LLDB connection backed by the browser shared-ring-v1 ABI.
///
/// The URL is wasm-messageport://<opaque-session-id>. The JavaScript host maps
/// the session id to the RSP ring pair; packet framing remains in
/// GDBRemoteCommunication.
class ConnectionMessagePort final : public Connection {
public:
  static constexpr llvm::StringLiteral Scheme = "wasm-messageport://";

  ConnectionMessagePort() = default;
  ~ConnectionMessagePort() override;

  static bool Supports(llvm::StringRef url) { return url.starts_with(Scheme); }

  lldb::ConnectionStatus Connect(llvm::StringRef url,
                                 Status *error_ptr) override;
  lldb::ConnectionStatus Disconnect(Status *error_ptr) override;
  bool IsConnected() const override;

  size_t Read(void *dst, size_t dst_len,
              const Timeout<std::micro> &timeout,
              lldb::ConnectionStatus &status, Status *error_ptr) override;
  size_t Write(const void *src, size_t src_len,
               lldb::ConnectionStatus &status, Status *error_ptr) override;

  std::string GetURI() override;
  bool InterruptRead() override;

private:
  static constexpr uint32_t RspChannel = 1;

  std::atomic<int32_t> m_connection{-1};
  mutable std::mutex m_uri_mutex;
  std::string m_uri;
};

} // namespace lldb_private::process_gdb_remote

#endif

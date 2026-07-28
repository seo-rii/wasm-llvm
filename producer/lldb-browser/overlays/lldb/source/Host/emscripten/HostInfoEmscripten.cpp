//===-- HostInfoEmscripten.cpp ------------------------------------------===//
//
// Browser-specific definitions for the HostInfoLinux interface selected by
// LLVM's Emscripten platform macros.
//
//===----------------------------------------------------------------------===//

#include "lldb/Host/linux/HostInfoLinux.h"

using namespace lldb_private;

void HostInfoLinux::Initialize(SharedLibraryDirectoryHelper *helper) {
  HostInfoPosix::Initialize(helper);
}

void HostInfoLinux::Terminate() { HostInfoPosix::Terminate(); }

llvm::StringRef HostInfoLinux::GetDistributionId() { return {}; }

FileSpec HostInfoLinux::GetProgramFileSpec() {
  return FileSpec("/lldb-web-dap", FileSpec::Style::posix);
}

void HostInfoLinux::ComputeHostArchitectureSupport(ArchSpec &arch_32,
                                                   ArchSpec &arch_64) {
  arch_32.SetTriple("wasm32-unknown-unknown-wasm");
  arch_64.Clear();
}

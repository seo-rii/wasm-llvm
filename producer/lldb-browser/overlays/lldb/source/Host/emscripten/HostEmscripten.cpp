//===-- HostEmscripten.cpp ----------------------------------------------===//
//
// Browser implementations for native-process Host operations.
//
//===----------------------------------------------------------------------===//

#include "lldb/Host/Host.h"

using namespace lldb_private;

uint32_t
Host::FindProcessesImpl(const ProcessInstanceInfoMatch &match_info,
                        ProcessInstanceInfoList &process_infos) {
  return 0;
}

bool Host::GetProcessInfo(lldb::pid_t pid,
                          ProcessInstanceInfo &process_info) {
  return false;
}

Status Host::ShellExpandArguments(ProcessLaunchInfo &launch_info) {
  return Status::FromErrorString(
      "shell argument expansion is unavailable in the browser");
}

//===-- lldb-web-dap.cpp -----------------------------------------------===//
//
// Browser entry point for LLDB's DAP request handlers.
//
//===----------------------------------------------------------------------===//

#include "SharedRingIO.h"

#include "DAP.h"
#include "DAPLog.h"
#include "DAPSessionManager.h"
#include "Handler/RequestHandler.h"
#include "Handler/ResponseHandler.h"
#include "Transport.h"
#include "lldb/API/SBDebugger.h"
#include "lldb/API/SBError.h"
#include "lldb/API/SBStream.h"
#include "lldb/Host/MainLoop.h"
#include "lldb/Target/Platform.h"
#include "llvm/ADT/ScopeExit.h"
#include "llvm/Support/Error.h"
#include "llvm/Support/InitLLVM.h"
#include "llvm/Support/raw_ostream.h"

#include <cstdlib>
#include <memory>
#include <string>
#include <vector>

using namespace lldb_dap;
using namespace lldb_private;

namespace {

class BrowserPlatform final : public Platform {
public:
  BrowserPlatform() : Platform(/*is_host_platform=*/true) {}

  llvm::StringRef GetPluginName() override { return "browser-wasm"; }

  llvm::StringRef GetDescription() override {
    return "Browser WebAssembly host platform";
  }

  std::vector<ArchSpec>
  GetSupportedArchitectures(const ArchSpec &process_host_arch) override {
    return {ArchSpec("wasm32-unknown-unknown-wasm")};
  }

  uint32_t
  FindProcesses(const lldb_private::ProcessInstanceInfoMatch &match_info,
                lldb_private::ProcessInstanceInfoList &process_infos) override {
    return 0;
  }

  bool
  GetProcessInfo(lldb::pid_t pid,
                 lldb_private::ProcessInstanceInfo &process_info) override {
    return false;
  }

  Status ShellExpandArguments(ProcessLaunchInfo &launch_info) override {
    return Status::FromErrorString(
        "shell argument expansion is unavailable in the browser");
  }

  lldb::ProcessSP Attach(ProcessAttachInfo &attach_info, Debugger &debugger,
                         Target *target, Status &error) override {
    error = Status::FromErrorString(
        "attaching native processes is unavailable in the browser");
    return {};
  }

protected:
  void CalculateTrapHandlerSymbolNames() override {}
};

} // namespace

int main(int argc, char **argv) {
  llvm::InitLLVM init(argc, argv, /*InstallPipeSignalExitHandler=*/false);
  if (argc != 2 || std::string(argv[1]).empty()) {
    llvm::errs() << "usage: lldb-web-dap <session-id>\n";
    return EXIT_FAILURE;
  }

  DAP::debug_adapter_path = "/lldb-web-dap";
  lldb::SBError initialize_error =
      lldb::SBDebugger::InitializeWithErrorHandling();
  if (initialize_error.Fail()) {
    lldb::SBStream description;
    initialize_error.GetDescription(description);
    llvm::errs() << "LLDB initialization failed: " << description.GetData()
                 << '\n';
    return EXIT_FAILURE;
  }
  Platform::SetHostPlatform(std::make_shared<BrowserPlatform>());
  llvm::scope_exit terminate_debugger(
      [] { lldb::SBDebugger::Terminate(); });

  auto io = std::make_shared<lldb_web_dap::SharedRingIO>(argv[1]);
  if (!io->IsValid()) {
    llvm::errs() << "failed to open shared-ring-v1 DAP channel\n";
    return EXIT_FAILURE;
  }

  lldb_dap::Log::Mutex log_mutex;
  lldb_dap::Log log(llvm::nulls(), log_mutex);
  MainLoop loop;
  Transport transport(log, io, io);
  constexpr llvm::StringLiteral client_name = "messageport";
  DAP dap(log, ReplMode::Variable, /*pre_init_commands=*/{},
          /*no_lldbinit=*/true, client_name, transport, loop);

  if (llvm::Error error = dap.ConfigureIO()) {
    llvm::logAllUnhandledErrors(std::move(error), llvm::errs(),
                                "failed to configure DAP output: ");
    return EXIT_FAILURE;
  }

  DAPSessionManager::GetInstance().RegisterSession(&loop, &dap);
  llvm::Error loop_error = dap.Loop();
  DAPSessionManager::GetInstance().UnregisterSession(&loop);
  if (loop_error) {
    llvm::logAllUnhandledErrors(std::move(loop_error), llvm::errs(),
                                "DAP session failed: ");
    return EXIT_FAILURE;
  }
  return EXIT_SUCCESS;
}

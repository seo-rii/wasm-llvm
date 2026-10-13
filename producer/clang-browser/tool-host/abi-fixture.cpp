// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
// Contract test linked to the actual patched LLVMSupport archive.
#include "llvm/ADT/BitVector.h"
#include "llvm/Support/Program.h"

using namespace llvm;

int main() {
  StringRef Args[] = {"wasm-ld", "space arg", "한글", ""};
  StringRef Environment[] = {"ONE=value space", "TWO="};
  std::optional<StringRef> Inherit[3] = {};
  std::string Error;
  bool Failed = true;
  std::optional<sys::ProcessStatistics> Stats = sys::ProcessStatistics{};
  auto Call = [&](std::optional<ArrayRef<StringRef>> Env,
                  ArrayRef<std::optional<StringRef>> Redirects,
                  unsigned Timeout, unsigned Memory, BitVector *Affinity) {
    Error.clear();
    return sys::ExecuteAndWait("/toolchains/wasm-ld", Args, Env, Redirects,
                               Timeout, Memory, &Error, &Failed, &Stats, Affinity);
  };
  if (Call(std::nullopt, {}, 0, 0, nullptr) != 23 || Failed || Stats)
    return 1;
  if (Call(ArrayRef(Environment), Inherit, 0, 0, nullptr) != 0 || Failed)
    return 2;
  if (Call(ArrayRef<StringRef>(), {}, 0, 0, nullptr) != 0 || Failed)
    return 3;
  if (Call(std::nullopt, {}, 0, 0, nullptr) != -1 || !Failed || Error.empty())
    return 4;
  if (Call(std::nullopt, {}, 0, 0, nullptr) != -2 || !Failed || Error.empty())
    return 5;
  if (Call(std::nullopt, {}, 1, 0, nullptr) != -1 || !Failed || Error.empty())
    return 6;
  if (Call(std::nullopt, {}, 0, 1, nullptr) != -1 || !Failed || Error.empty())
    return 7;
  std::optional<StringRef> Redirects[] = {std::nullopt, "output.txt", std::nullopt};
  if (Call(std::nullopt, Redirects, 0, 0, nullptr) != -1 || !Failed || Error.empty())
    return 8;
  BitVector Affinity(1);
  if (Call(std::nullopt, {}, 0, 0, &Affinity) != -1 || !Failed || Error.empty())
    return 9;
  return 0;
}

// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
// Initialize the real WASI libc cwd after its reserved startup constructors.
#include <stdint.h>
#include <stdlib.h>
#include <unistd.h>

__attribute__((import_module("wasm_idle_process_v1"),
               import_name("initial_cwd")))
extern int32_t initial_cwd(char *buffer, uint32_t capacity);

__attribute__((constructor(101))) static void initialize_cwd(void) {
  char cwd[4096] = {0};
  int32_t length = initial_cwd(cwd, sizeof(cwd));
  if (length < 2 || length > (int32_t)sizeof(cwd) || cwd[0] != '/' ||
      cwd[length - 1] != '\0')
    _Exit(125);
  for (int32_t i = 0; i < length - 1; ++i)
    if (cwd[i] == '\0')
      _Exit(125);
  if (chdir(cwd) != 0)
    _Exit(125);
}

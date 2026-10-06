/* wasm-llvm V browser producer: WASI has no process tracing. */
#ifndef WASM_LLVM_V_SYS_PTRACE_H
#define WASM_LLVM_V_SYS_PTRACE_H
#include <errno.h>

#define PTRACE_TRACEME 0

static inline long ptrace(int request, ...) {
	(void)request;
	errno = ENOSYS;
	return -1;
}

#endif

/* wasm-llvm V browser producer: WASI has no child processes. V's os module includes this header on
 * Unix-like targets; waiting always reports ECHILD. */
#ifndef WASM_LLVM_V_SYS_WAIT_H
#define WASM_LLVM_V_SYS_WAIT_H
#include <errno.h>
#include <sys/types.h>

#define WNOHANG 1
#define WUNTRACED 2
#define WEXITSTATUS(s) (((s) & 0xff00) >> 8)
#define WTERMSIG(s) ((s) & 0x7f)
#define WSTOPSIG(s) WEXITSTATUS(s)
#define WIFEXITED(s) (!WTERMSIG(s))
#define WIFSTOPPED(s) ((short)((((s) & 0xffff) * 0x10001U) >> 8) > 0x7f00)
#define WIFSIGNALED(s) (((s) & 0xffff) - 1U < 0xffu)

static inline pid_t waitpid(pid_t pid, int *status, int options) {
	(void)pid;
	(void)status;
	(void)options;
	errno = ECHILD;
	return -1;
}

static inline pid_t wait(int *status) {
	(void)status;
	errno = ECHILD;
	return -1;
}

#endif

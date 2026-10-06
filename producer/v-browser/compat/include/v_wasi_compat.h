/* wasm-llvm V browser producer: force-included (`-include v_wasi_compat.h`) when compiling V's C
 * output for wasm32-wasi (Preview 1). It supplies the POSIX process, user-id and file-lock entry
 * points that V's Unix `os` module references but WASI Preview 1 does not provide. Process and
 * descriptor-duplication calls fail with ENOSYS; user/group ids report the unprivileged 1000. */
#ifndef WASM_LLVM_V_WASI_COMPAT_H
#define WASM_LLVM_V_WASI_COMPAT_H
/* wasi-libc's chmod/fchmod always fail; route them to the compat definitions (v-wasi-compat.c). */
#define chmod wasm_llvm_v_chmod
#define fchmod wasm_llvm_v_fchmod
#include <errno.h>
#include <fcntl.h>
#include <sys/types.h>
/* V's builtin module calls signal() without including <signal.h> unless `os` is imported. */
#ifdef _WASI_EMULATED_SIGNAL
#include <signal.h>
#endif

#ifndef F_RDLCK
#define F_RDLCK 0
#define F_WRLCK 1
#define F_UNLCK 2
#endif
#ifndef F_SETLK
#define F_GETLK 5
#define F_SETLK 6
#define F_SETLKW 7
#endif

static inline int pipe(int fds[2]) {
	(void)fds;
	errno = ENOSYS;
	return -1;
}

static inline pid_t fork(void) {
	errno = ENOSYS;
	return -1;
}

static inline int execvp(const char *file, char *const argv[]) {
	(void)file;
	(void)argv;
	errno = ENOSYS;
	return -1;
}

static inline int execve(const char *path, char *const argv[], char *const envp[]) {
	(void)path;
	(void)argv;
	(void)envp;
	errno = ENOSYS;
	return -1;
}

static inline int dup2(int oldfd, int newfd) {
	(void)oldfd;
	(void)newfd;
	errno = ENOSYS;
	return -1;
}

static inline int dup(int oldfd) {
	(void)oldfd;
	errno = ENOSYS;
	return -1;
}

static inline int setpgid(pid_t pid, pid_t pgid) {
	(void)pid;
	(void)pgid;
	errno = ENOSYS;
	return -1;
}

/* WASI has no user database; report the conventional unprivileged id used by WASI runtimes. */
static inline unsigned int getuid(void) { return 1000; }
static inline unsigned int geteuid(void) { return 1000; }
static inline unsigned int getgid(void) { return 1000; }
static inline unsigned int getegid(void) { return 1000; }

static inline int kill(pid_t pid, int sig) {
	(void)pid;
	(void)sig;
	errno = ENOSYS;
	return -1;
}

#endif

/* wasm-llvm V browser producer: WASI Preview 1 entry points that wasi-libc declares but does not
 * define. They are linked into the V compiler and into V programs built in the browser.
 *
 * - mkstemp creates a unique file with O_CREAT|O_EXCL, matching POSIX semantics.
 * - Semaphores implement POSIX counting semantics for a single-threaded process. A wait on a zero
 *   count can never be satisfied without another thread, so it fails with EDEADLK instead of
 *   hanging the program.
 * - chmod()/fchmod() accept any mode on an existing path because WASI has no permission bits.
 * - system() and flock() report ENOSYS because WASI has no subprocesses or advisory locks. */
#include "include/v_wasi_compat.h"
#include <errno.h>
#include <fcntl.h>
#include <semaphore.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

int mkstemp(char *template) {
	static unsigned long counter = 0;
	size_t length = template ? strlen(template) : 0;
	if (length < 6 || memcmp(template + length - 6, "XXXXXX", 6) != 0) {
		errno = EINVAL;
		return -1;
	}
	static const char alphabet[] =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	struct timespec now;
	clock_gettime(CLOCK_REALTIME, &now);
	unsigned long seed = (unsigned long)now.tv_nsec ^ ((unsigned long)now.tv_sec << 7);
	for (int attempt = 0; attempt < 100; attempt++) {
		unsigned long value = seed + (counter++ * 2654435761UL);
		for (int i = 0; i < 6; i++) {
			template[length - 6 + i] = alphabet[value % (sizeof(alphabet) - 1)];
			value /= sizeof(alphabet) - 1;
		}
		int fd = open(template, O_RDWR | O_CREAT | O_EXCL, 0600);
		if (fd >= 0 || errno != EEXIST) return fd;
	}
	errno = EEXIST;
	return -1;
}

/* WASI Preview 1 has no permission bits, and wasi-libc's chmod always fails. V's os.cp() (used
 * to move generated C to its `-o` destination) copies the mode after writing the file, so report
 * success for an existing path and keep the existence check. */
int wasm_llvm_v_chmod(const char *path, mode_t mode) {
	(void)mode;
	struct stat info;
	return stat(path, &info);
}

int wasm_llvm_v_fchmod(int fd, mode_t mode) {
	(void)mode;
	struct stat info;
	return fstat(fd, &info);
}

int system(const char *command) {
	/* POSIX: system(NULL) reports whether a command processor is available. */
	if (!command) return 0;
	errno = ENOSYS;
	return -1;
}

/* V's os.execute() declares these itself (with opaque attribute pointers) on Unix targets. */
int posix_spawn(pid_t *pid, const char *path, const void *actions, const void *attrs,
	char *const argv[], char *const envp[]) {
	(void)pid;
	(void)path;
	(void)actions;
	(void)attrs;
	(void)argv;
	(void)envp;
	return ENOSYS;
}

int posix_spawnp(pid_t *pid, const char *file, const void *actions, const void *attrs,
	char *const argv[], char *const envp[]) {
	return posix_spawn(pid, file, actions, attrs, argv, envp);
}

int posix_spawn_file_actions_init(void *actions) {
	(void)actions;
	return 0;
}

int posix_spawn_file_actions_destroy(void *actions) {
	(void)actions;
	return 0;
}

int posix_spawn_file_actions_adddup2(void *actions, int fd, int newfd) {
	(void)actions;
	(void)fd;
	(void)newfd;
	return 0;
}

int posix_spawn_file_actions_addclose(void *actions, int fd) {
	(void)actions;
	(void)fd;
	return 0;
}

int flock(int fd, int operation) {
	(void)fd;
	(void)operation;
	errno = ENOSYS;
	return -1;
}

int sem_init(sem_t *sem, int pshared, unsigned value) {
	if (pshared) {
		errno = ENOSYS;
		return -1;
	}
	sem->__val[0] = (int)value;
	return 0;
}

int sem_destroy(sem_t *sem) {
	(void)sem;
	return 0;
}

int sem_post(sem_t *sem) {
	sem->__val[0]++;
	return 0;
}

int sem_trywait(sem_t *sem) {
	if (sem->__val[0] > 0) {
		sem->__val[0]--;
		return 0;
	}
	errno = EAGAIN;
	return -1;
}

int sem_wait(sem_t *sem) {
	if (sem_trywait(sem) == 0) return 0;
	errno = EDEADLK;
	return -1;
}

int sem_timedwait(sem_t *restrict sem, const struct timespec *restrict timeout) {
	(void)timeout;
	if (sem_trywait(sem) == 0) return 0;
	errno = ETIMEDOUT;
	return -1;
}

int sem_getvalue(sem_t *restrict sem, int *restrict value) {
	*value = sem->__val[0];
	return 0;
}

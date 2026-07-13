#include <errno.h>
#include <stdio.h>
#include <sys/types.h>

pid_t
fork(void)
{
	errno = ENOSYS;
	return (pid_t)-1;
}

int
system(const char *command)
{
	(void)command;
	errno = ENOSYS;
	return -1;
}

FILE *
popen(const char *command, const char *mode)
{
	(void)command;
	(void)mode;
	errno = ENOSYS;
	return NULL;
}

int
pclose(FILE *stream)
{
	(void)stream;
	errno = ENOSYS;
	return -1;
}

char *
getlogin(void)
{
	errno = ENOSYS;
	return NULL;
}

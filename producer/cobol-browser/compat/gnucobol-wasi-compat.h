#ifndef GNUCOBOL_WASI_COMPAT_H
#define GNUCOBOL_WASI_COMPAT_H

#ifdef __wasi__
#include <stdio.h>
#include <sys/types.h>

pid_t fork(void);
FILE *popen(const char *, const char *);
int pclose(FILE *);
char *getlogin(void);
#endif

#endif

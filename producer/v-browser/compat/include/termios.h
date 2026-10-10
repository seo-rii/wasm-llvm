/* wasm-llvm V browser producer: WASI has no terminals. V's term.termios module includes this
 * header on Unix-like targets; every operation reports ENOTTY so callers take their
 * non-interactive paths. */
#ifndef WASM_LLVM_V_TERMIOS_H
#define WASM_LLVM_V_TERMIOS_H
#include <errno.h>

typedef unsigned int tcflag_t;
typedef unsigned int speed_t;
typedef unsigned char cc_t;
#define NCCS 32

struct termios {
	tcflag_t c_iflag;
	tcflag_t c_oflag;
	tcflag_t c_cflag;
	tcflag_t c_lflag;
	cc_t c_line;
	cc_t c_cc[NCCS];
	speed_t c_ispeed;
	speed_t c_ospeed;
};

#define VINTR 0
#define VQUIT 1
#define VERASE 2
#define VKILL 3
#define VEOF 4
#define VTIME 5
#define VMIN 6
#define ISIG 0000001
#define ICANON 0000002
#define ECHO 0000010
#define ECHOE 0000020
#define ECHOK 0000040
#define ECHONL 0000100
#define IEXTEN 0100000
#define BRKINT 0000002
#define ICRNL 0000400
#define INPCK 0000020
#define ISTRIP 0000040
#define IXON 0002000
#define OPOST 0000001
#define CS8 0000060
#define TCSANOW 0
#define TCSADRAIN 1
#define TCSAFLUSH 2

static inline int tcgetattr(int fd, struct termios *termios_p) {
	(void)fd;
	(void)termios_p;
	errno = ENOTTY;
	return -1;
}

static inline int tcsetattr(int fd, int optional_actions, const struct termios *termios_p) {
	(void)fd;
	(void)optional_actions;
	(void)termios_p;
	errno = ENOTTY;
	return -1;
}

#endif

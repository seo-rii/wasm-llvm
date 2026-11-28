// The directory before ".." must exist and be a directory at lookup time.
#if __has_include("sysroot_missing_entry/../stdio.h")
#error walked through a missing entry
#endif
#if __has_include("stdio.h/../stdio.h")
#error walked through a regular file
#endif
#if !__has_include("linux/../stdio.h")
#error failed to walk through a directory
#endif
int main(void) { return 0; }

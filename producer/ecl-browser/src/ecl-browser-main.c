/*
 * Program entry point for the browser ECL module.
 *
 * This mirrors the `main` that ECL's own COMPILER::BUILD-PROGRAM writes for
 * the upstream `bin/ecl` executable (+lisp-program-main+ in
 * src/cmp/cmpbackend-cxx/cmpbackend-cxx.lsp, with the ECL-HELP and ECL-CDB
 * modules and the default `(SI::TOP-LEVEL T)` epilogue). The upstream build
 * deletes its generated copy after linking, so the producer keeps this
 * equivalent, reviewable source and relinks it with module-oriented
 * Emscripten flags. Command-line processing, the REPL and LOAD are upstream.
 */
#include <ecl/ecl.h>

extern void init_lib_ECL_HELP(cl_object);
extern void init_lib_ECL_CDB(cl_object);

int
main(int argc, char **argv)
{
	cl_boot(argc, argv);
	ECL_CATCH_ALL_BEGIN(ecl_process_env()) {
		ecl_init_module(OBJNULL, init_lib_ECL_HELP);
		ecl_init_module(OBJNULL, init_lib_ECL_CDB);
		cl_eval(ecl_read_from_cstring("(SI::TOP-LEVEL T)"));
	} ECL_CATCH_ALL_END;
	si_exit(0);
	return 0;
}

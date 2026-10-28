#ifndef TINYGO_C_FLAG
#error "TinyGo acceptance requires CFLAGS in the preamble and C source"
#endif

#if TINYGO_C_FLAG != 17
#error "TinyGo acceptance received a different CFLAGS macro value"
#endif

#ifdef TINYGO_CXX_SCALE
#error "CXXFLAGS must not reach the C preamble or C source"
#endif

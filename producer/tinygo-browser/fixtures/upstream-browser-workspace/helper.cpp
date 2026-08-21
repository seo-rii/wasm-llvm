extern "C" int tinygo_asm_add(int left, int right);

#ifndef TINYGO_CXX_SCALE
#error "TinyGo consumer acceptance requires its receipt-bound CXXFLAGS"
#endif

template <int Scale>
static int scaled(int value) {
  return Scale * value;
}

extern "C" int tinygo_cpp_asm_mix(int left, int right) {
  return scaled<TINYGO_CXX_SCALE>(left) + tinygo_asm_add(left, right);
}

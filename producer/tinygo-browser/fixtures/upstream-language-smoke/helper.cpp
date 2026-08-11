extern "C" int tinygo_asm_add(int left, int right);

template <int Scale>
static int scaled(int value) {
  return Scale * value;
}

extern "C" int tinygo_cpp_asm_mix(int left, int right) {
  return scaled<2>(left) + tinygo_asm_add(left, right);
}

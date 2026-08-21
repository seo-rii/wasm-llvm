#include "asm_constants.h"

  .text
  .functype tinygo_asm_add (i32, i32) -> (i32)
  .globl tinygo_asm_add
  .type tinygo_asm_add,@function
tinygo_asm_add:
  .functype tinygo_asm_add (i32, i32) -> (i32)
  local.get 0
  local.get 1
  i32.add
#if TINYGO_ASM_BIAS != 0
  i32.const TINYGO_ASM_BIAS
  i32.add
#endif
  end_function

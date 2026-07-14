# Based on wasi-sdk's CMake toolchain file.
cmake_minimum_required(VERSION 3.27.0)

set(CMAKE_SYSTEM_NAME WASI)
set(CMAKE_SYSTEM_VERSION 1)
set(CMAKE_SYSTEM_PROCESSOR wasm32)

set(_wasm_llvm_triple wasm32-wasip1-threads)

set(CMAKE_C_COMPILER "${WASM_PREFIX}/bin/clang")
set(CMAKE_CXX_COMPILER "${WASM_PREFIX}/bin/clang++")
set(CMAKE_ASM_COMPILER "${WASM_PREFIX}/bin/clang")
set(CMAKE_AR "${WASM_PREFIX}/bin/llvm-ar")
set(CMAKE_RANLIB "${WASM_PREFIX}/bin/llvm-ranlib")
set(CMAKE_C_COMPILER_TARGET "${_wasm_llvm_triple}")
set(CMAKE_CXX_COMPILER_TARGET "${_wasm_llvm_triple}")
set(CMAKE_ASM_COMPILER_TARGET "${_wasm_llvm_triple}")

set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)

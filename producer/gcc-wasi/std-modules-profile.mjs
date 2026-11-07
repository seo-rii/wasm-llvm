// The optional module profile is deliberately exact: GCC BMIs are not portable
// between compiler builds, execution hosts, target options, or library ABIs.
export const stdModulesProfile = Object.freeze({
  standard: 'gnu++23', optimization: '2', exceptions: false, rtti: false,
  targetExceptionHandling: true, signalEmulation: true, cxx11Abi: 1,
  dualAbi: true, glibcxxDebug: false, simd: false, relaxedSimd: false,
  atomics: false, tls: false, sharedMemory: false, debug: false, coverage: false,
  defines: ['__GCC_WASI_SINGLE_THREAD__=1', '_WASI_EMULATED_SIGNAL=1'],
});

export const moduleNames = ['std', 'std.compat'];
export const moduleAssets = {
  std: 'std-modules/std.gcm', stdCompat: 'std-modules/std.compat.gcm',
  initializers: 'std-modules/libstdc++modules.a',
  signal: 'std-modules/libwasi-emulated-signal.a',
};
export const mapperText = 'std /gcc-std-modules/std.gcm\nstd.compat /gcc-std-modules/std.compat.gcm\n';

export function moduleCompilerArguments(sysroot = '/sysroot', mapper = '/gcc-std-modules/mapper.txt') {
  return ['-quiet', '-O2', '-std=gnu++23', '-fdiagnostics-color=never',
    '-Werror=attributes', '-Werror=pragmas', '-D__GCC_WASI_SINGLE_THREAD__=1',
    '-mno-simd128', '-mno-relaxed-simd', '-mno-atomics', '-mno-tls',
    '-mexception-handling', '-D_WASI_EMULATED_SIGNAL=1',
    '-fno-exceptions', '-fno-rtti', '-fuse-cxa-atexit', '-fno-threadsafe-statics',
    '-nostdinc', '-isysroot', sysroot,
    ...['include/c++/17.0.0', 'include/c++/17.0.0/wasm32-wasi',
      'include/c++/17.0.0/backward', 'lib/gcc/wasm32-wasi/17.0.0/include',
      'include/wasm32-wasi', 'include'].flatMap(relative => ['-isystem', sysroot + '/' + relative]),
    '-fmodules', '-fmodule-mapper=' + mapper];
}

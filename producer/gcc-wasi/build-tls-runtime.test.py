import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('tls_runtime_builder', Path(__file__).with_name('build-tls-runtime.py'))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class RuntimeContractTests(unittest.TestCase):
    def test_errno_port_changes_only_the_native_declaration(self):
        source = b'prefix\nextern _Thread_local int errno;\nsuffix\n'
        actual = builder.tls_errno_header(source)
        self.assertTrue(actual.startswith(b'prefix\n'))
        self.assertTrue(actual.endswith(b'\nsuffix\n'))
        self.assertIn(b'extern thread_local int errno;', actual)
        self.assertIn(b'extern _Thread_local int errno;', actual)
        self.assertIn(b'#if !defined(__wasm_tls__)', actual)
        self.assertNotIn(b'__GCC_WASI_SINGLE_THREAD__', actual)
        self.assertNotIn(b'extern int errno;', actual)

    def test_errno_port_rejects_missing_or_duplicate_sdk_declarations(self):
        for source in [b'extern int errno;', b'extern _Thread_local int errno;\n' * 2]:
            with self.assertRaises(RuntimeError):
                builder.tls_errno_header(source)

    def test_compile_profiles_keep_tls_header_before_base_and_real_target_flags(self):
        for profile in ['ordinary', 'shared']:
            args = builder.compile_arguments(profile, Path('/source/runtime.cc'),
                Path('/output/objects') / profile / 'runtime.wat', Path('/compiler'), Path('/base'), Path('/gnu'))
            self.assertIn('-mtls', args)
            self.assertIn('-matomics' if profile == 'shared' else '-mno-atomics', args)
            self.assertLess(args.index('/output/sysroot/include/wasm32-wasi-tls'), args.index('/base/include/wasm32-wasi'))
            self.assertFalse(any('__GCC_WASI_SINGLE_THREAD__' in arg or '__wasm_tls__=' in arg for arg in args))

    def test_old_single_thread_fallback_cannot_claim_runtime_abi(self):
        symbols = '__cxa_thread_atexit T 0 1\n_ZN12_GLOBAL__N_1L13single_threadE d 0 4\n'
        with self.assertRaisesRegex(RuntimeError, 'ABI missing'):
            builder.check_object('ordinary', 'atexit_thread.o', '', '', symbols)


if __name__ == '__main__':
    unittest.main()

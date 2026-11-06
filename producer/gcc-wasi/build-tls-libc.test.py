#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('tls_libc', Path(__file__).with_name('build-tls-libc.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PrivateTlsLibcBoundaries(unittest.TestCase):
    def test_identical_preexisting_generated_files_are_valid(self):
        files = {'source.c': 'original', 'wasi/p2/wit/wasi-libc.wit': 'p2', 'wasi/p3/wit/wasi-libc.wit': 'p3'}
        self.assertEqual(module.check_source_inventory(files, files.copy()), {})

    def test_only_missing_known_generated_paths_are_added(self):
        original = {'source.c': 'original', 'wasi/p2/wit/wasi-libc.wit': 'p2'}
        self.assertEqual(module.check_source_inventory(original, {**original, 'wasi/p3/wit/wasi-libc.wit': 'p3'}),
                         {'wasi/p3/wit/wasi-libc.wit': 'p3'})

    def test_changed_upstream_source_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'Upstream libc source changed'):
            module.check_source_inventory({'source.c': 'original'}, {'source.c': 'modified'})

    def test_unexpected_generated_source_is_rejected(self):
        files = {'source.c': 'original', 'wasi/p2/wit/wasi-libc.wit': 'p2', 'wasi/p3/wit/wasi-libc.wit': 'p3'}
        with self.assertRaisesRegex(RuntimeError, 'Unexpected generated'):
            module.check_source_inventory(files, {**files, 'fake-errno.c': 'provider'})

    def test_private_configuration_never_enables_threaded_sources(self):
        values = {'TARGET_TRIPLE': 'wasm32-wasip1', 'CMAKE_C_FLAGS': module.FLAGS,
                  'MALLOC': 'dlmalloc', 'BUILD_SHARED': 'OFF', 'BUILD_TESTS': 'OFF',
                  'SETJMP': 'OFF', 'SIMD': 'OFF', 'LTO': '', 'BINDINGS_TARGET': 'OFF'}
        cache = '\n'.join(key + ':STRING=' + value for key, value in values.items())
        valid = {'command': 'clang ' + module.FLAGS + ' -mthread-model single', 'file': '/source/errno.c'}
        self.assertEqual(module.check_configuration(cache, [valid]), values)
        for changed in [{**valid, 'command': valid['command'] + ' -D_REENTRANT=1'},
                        {**valid, 'command': valid['command'] + ' -pthread'},
                        {**valid, 'file': '/source/wasi-threads/__wait.c'},
                        {**valid, 'command': valid['command'].replace('-matomics', '')}]:
            with self.assertRaises(RuntimeError):
                module.check_configuration(cache, [changed])


if __name__ == '__main__':
    unittest.main()

#!/usr/bin/env python3
"""Fail-closed checks for the production archive's configuration and call graph."""
import copy
import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location('libatomic_build', Path(__file__).with_name('build-libatomic.py'))
BUILD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILD)


def configuration():
    values = {'WORDSIZE': 8, **{f'HAVE_INT{n}': 1 for n in BUILD.SIZES}}
    for operation in ['LDST', 'CAS', 'EXCHANGE', 'FETCH_ADD', 'FETCH_OP']:
        values.update({f'HAVE_ATOMIC_{operation}_{n}': int(n < 16) for n in BUILD.SIZES})
    values.update({f'HAVE_ATOMIC_TAS_{n}': 1 for n in BUILD.SIZES})
    return '\n'.join(f'#define {name} {value}' for name, value in values.items()) + '\n'


MAKEFILE = '''config_path = wasm
SIZES =  1 2 4 8 16
CFLAGS = -O2 -g0 -save-temps=obj
XCFLAGS = -fno-link-libatomic -matomics
'''


class ConfigurationTests(unittest.TestCase):
    def test_specs_use_supported_rename_instead_of_empty_eof_override(self):
        text = BUILD.runtime_specs(Path('/runtime/lib/wasm32-wasi'))
        self.assertTrue(text.startswith('%rename cc1plus gcc_wasi_original_cc1plus\n\n'))
        self.assertNotIn('*cc1plus:', text)
        self.assertIn('/runtime/lib/wasm32-wasi/libclang_rt.builtins-wasm32.a\n', text)
        self.assertIn('--fatal-warnings -L/runtime/lib/wasm32-wasi -e _start\n', text)

    def test_actual_gnu_configure_receipt_has_64_bit_machine_word(self):
        text = Path(__file__).with_name('libatomic-build-testdata').joinpath('wasm32-auto-config.h').read_text()
        result = BUILD.check_configuration(text, MAKEFILE)
        self.assertEqual(result['definitions']['WORDSIZE'], '8')
        self.assertEqual(result['definitions']['HAVE_ATOMIC_CAS_4'], '1')
        with self.assertRaisesRegex(RuntimeError, 'WORDSIZE=4'):
            BUILD.check_configuration(text.replace('WORDSIZE 8', 'WORDSIZE 4'), MAKEFILE)

    def test_native_small_widths_and_byte_tas_are_distinct_from_native_128(self):
        result = BUILD.check_configuration(configuration(), MAKEFILE)
        self.assertEqual(result['definitions']['HAVE_ATOMIC_TAS_16'], '1')
        self.assertEqual(result['definitions']['HAVE_ATOMIC_CAS_16'], '0')

    def test_rejects_missing_native_lock_primitive(self):
        with self.assertRaisesRegex(RuntimeError, 'HAVE_ATOMIC_CAS_4'):
            BUILD.check_configuration(configuration().replace('HAVE_ATOMIC_CAS_4 1', 'HAVE_ATOMIC_CAS_4 0'), MAKEFILE)

    def test_rejects_accidental_128_native_claim(self):
        with self.assertRaisesRegex(RuntimeError, 'HAVE_ATOMIC_LDST_16'):
            BUILD.check_configuration(configuration().replace('HAVE_ATOMIC_LDST_16 0', 'HAVE_ATOMIC_LDST_16 1'), MAKEFILE)

    def test_rejects_pthread_or_disabled_profile(self):
        for invalid in [MAKEFILE.replace('wasm\n', 'wasm posix\n'),
                        MAKEFILE.replace('-matomics', '-mno-atomics'),
                        MAKEFILE.replace('-matomics', '-matomics -pthread')]:
            with self.subTest(invalid=invalid), self.assertRaises(RuntimeError):
                BUILD.check_configuration(configuration(), invalid)


DISASSEMBLY = '''Custom:
 - name: "linking"
  - symbol table [count=4]
   - 0: F <env.libat_lock_n> func=0 [ undefined binding=global vis=default ]
   - 1: F <libat_load_16> func=1 [ explicit_name binding=global vis=hidden ]
   - 2: F <__atomic_load_16> func=1 [ explicit_name binding=global vis=default ]
   - 3: F <local_copy> func=2 [ explicit_name binding=local vis=default ]
Code Disassembly:
000010 func[1] <libat_load_16>:
 000011: 10 00                      | call 0 <env.libat_lock_n>
 000013: 10 02                      | call 2 <local_copy>
 000015: 0b                         | end
000016 func[2] <local_copy>:
 000017: 28 02 00                   | i32.load 2 0
 00001a: 0b                         | end
'''


def archive():
    objects = [{'member': name, 'functions': [], 'imports': []} for name in BUILD.EXPECTED_MEMBERS]
    lock = next(item for item in objects if item['member'] == 'lock.o')
    lock['functions'].append({'id': 'lock.o:0', 'index': 0, 'name': 'libat_lock_n',
        'exports': ['libat_lock_n'], 'instructions': ['i32.atomic.load', 'i32.atomic.store', 'i32.atomic.rmw.cmpxchg'],
        'targets': []})
    objects[objects.index(next(item for item in objects if item['member'] == 'load_16_.o'))] = BUILD.decode_object('load_16_.o', DISASSEMBLY)
    return objects


class ArchiveTests(unittest.TestCase):
    def test_resolves_aliases_local_calls_and_cross_member_lock(self):
        result = BUILD.check_archive(archive(), ['__atomic_load_16', 'libat_lock_n'])
        self.assertEqual(result['definedFunctions'], 3)
        self.assertEqual(result['callGraph']['load_16_.o:1'], ['lock.o:0', 'load_16_.o:2'])
        self.assertFalse(result['recursiveCalls'])

    def test_rejects_recursive_lock_via_external_alias(self):
        objects = archive()
        lock = next(item for item in objects if item['member'] == 'lock.o')
        lock['functions'][0]['targets'] = [{'import': '__atomic_load_16'}]
        lock['imports'] = ['__atomic_load_16']
        with self.assertRaisesRegex(RuntimeError, 'Recursive'):
            BUILD.check_archive(objects, ['__atomic_load_16'])

    def test_rejects_native_width_self_libcall(self):
        objects = archive()
        native = next(item for item in objects if item['member'] == 'load_4_.o')
        native['imports'] = ['__atomic_load_16']
        with self.assertRaisesRegex(RuntimeError, 'Native-width helper'):
            BUILD.check_archive(objects, ['__atomic_load_16'])

    def test_rejects_missing_and_duplicate_members(self):
        for objects in [archive()[:-1], archive() + [copy.deepcopy(archive()[0])]]:
            with self.subTest(count=len(objects)), self.assertRaisesRegex(RuntimeError, 'inventory'):
                BUILD.check_archive(objects, [])

    def test_rejects_unimplemented_public_abi(self):
        with self.assertRaisesRegex(RuntimeError, 'public ABI'):
            BUILD.check_archive(archive(), ['__atomic_compare_exchange_16'])

    def test_rejects_unsupported_or_pthread_function_import(self):
        for symbol in ['pthread_mutex_lock', 'emscripten_atomic_cas_u32', '__atomic_load_4']:
            objects = archive()
            objects[0]['imports'] = [symbol]
            with self.subTest(symbol=symbol), self.assertRaisesRegex(RuntimeError, 'Unexpected GNU'):
                BUILD.check_archive(objects, [])

    def test_rejects_indirect_or_unresolved_calls(self):
        for text in [DISASSEMBLY.replace('call 0 <env.libat_lock_n>', 'call_indirect 0 (type 0)'),
                     DISASSEMBLY.replace('call 0 <env.libat_lock_n>', 'call 99 <unknown>')]:
            with self.subTest(text=text), self.assertRaises(RuntimeError):
                BUILD.decode_object('load_16_.o', text)

    def test_rejects_plain_load_substitution_for_lock(self):
        objects = archive()
        lock = next(item for item in objects if item['member'] == 'lock.o')
        lock['functions'][0]['instructions'][0] = 'i32.load'
        with self.assertRaisesRegex(RuntimeError, 'native instructions'):
            BUILD.check_archive(objects, [])

    def test_rejects_duplicate_global_definition(self):
        objects = archive()
        lock = next(item for item in objects if item['member'] == 'lock.o')
        lock['functions'][0]['exports'].append('__atomic_load_16')
        with self.assertRaisesRegex(RuntimeError, 'Duplicate'):
            BUILD.check_archive(objects, [])


if __name__ == '__main__':
    unittest.main()

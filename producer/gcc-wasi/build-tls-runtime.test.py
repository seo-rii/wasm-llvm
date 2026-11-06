import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

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


class FirstMutation(Exception):
    pass


def inventory(root):
    result = {}
    for file in sorted(root.rglob('*')):
        name = str(file.relative_to(root))
        if file.is_symlink():
            result[name] = ('symlink', os.readlink(file))
        elif file.is_file():
            result[name] = ('file', file.read_bytes())
        else:
            result[name] = ('directory',)
    return result


class SourceIdentityGuardTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='tls-source-guard-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.work = self.root / 'work'
        self.work.mkdir()
        self.external = self.root / 'immutable-gcc'
        self.external.mkdir()
        (self.external / 'source.cc').write_text('unchanged source\n')
        self.other = self.root / 'other-gcc'
        self.other.mkdir()
        (self.other / 'source.cc').write_text('unchanged source\n')

    def invoke(self, source, *, allowed, output=None):
        output = output or self.root / 'absent-output'
        before = inventory(self.root)
        attempted = []

        def first_mutation(directory, *args, **kwargs):
            attempted.append(directory)
            raise FirstMutation(str(directory))

        # Match the production CLI's Path.resolve() conversion of every input.
        args = [self.work, self.root / 'sdk', self.root / 'sdk.tar.gz', source,
                self.root / 'sysroot', self.root / 'gnu', self.root / 'libc', output]
        with patch.object(Path, 'mkdir', first_mutation):
            if allowed:
                with self.assertRaises(FirstMutation):
                    builder.build(*(value.resolve() for value in args))
                self.assertEqual(attempted, [output.resolve()])
            else:
                with self.assertRaisesRegex(ValueError, 'native receipt must identify work/gcc'):
                    builder.build(*(value.resolve() for value in args))
                self.assertEqual(attempted, [])
        self.assertEqual(inventory(self.root), before)

    def test_physical_intended_source_reaches_output_boundary(self):
        source = self.work / 'gcc'
        source.mkdir()
        self.invoke(source, allowed=True)

    def test_symlinked_intended_source_reaches_output_boundary(self):
        (self.work / 'gcc').symlink_to(self.external, target_is_directory=True)
        self.invoke(self.work / 'gcc', allowed=True)

    def test_physical_unrelated_source_is_rejected_without_output(self):
        (self.work / 'gcc').symlink_to(self.external, target_is_directory=True)
        self.invoke(self.other, allowed=False)

    def test_unrelated_source_symlink_is_rejected_without_output(self):
        (self.work / 'gcc').symlink_to(self.external, target_is_directory=True)
        alias = self.root / 'unrelated-source-alias'
        alias.symlink_to(self.other, target_is_directory=True)
        self.invoke(alias, allowed=False)

    def test_source_output_overlap_still_rejected_before_mutation(self):
        (self.work / 'gcc').symlink_to(self.external, target_is_directory=True)
        before = inventory(self.root)
        with patch.object(Path, 'mkdir', side_effect=AssertionError('unexpected mutation')):
            args = [self.work, self.root / 'sdk', self.root / 'sdk.tar.gz', self.work / 'gcc',
                    self.root / 'sysroot', self.root / 'gnu', self.root / 'libc', self.external / 'output']
            with self.assertRaisesRegex(ValueError, 'TLS output must be isolated'):
                builder.build(*(value.resolve() for value in args))
        self.assertEqual(inventory(self.root), before)



if __name__ == '__main__':
    unittest.main()

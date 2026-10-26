"""Small patch-integrity fixtures, not compiler qualification."""
import copy
import difflib
import hashlib
import importlib.util
import pathlib
import tempfile
import unittest

MODULE = pathlib.Path(__file__).resolve().parents[1] / 'build-support.py'
SPEC = importlib.util.spec_from_file_location('gcc_build_support', MODULE)
SUPPORT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SUPPORT)


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


class SourcePatchesTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='gcc-patch-fixture-')
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        (self.source / 'example.cc').write_text('original\n')
        self.patches = []
        for index, (before, after) in enumerate([
                ('original\n', 'first patch\n'), ('first patch\n', 'second patch\n')]):
            name = f'{index}.patch'
            patch = ''.join(difflib.unified_diff(before.splitlines(True), after.splitlines(True),
                                               fromfile='a/example.cc', tofile='b/example.cc'))
            (self.root / name).write_text(patch)
            self.patches.append({'path': name, 'sha256': digest(patch),
                                 'upstreamCommits': [f'https://example.invalid/{index}'],
                                 'files': {'example.cc': {'beforeSha256': digest(before),
                                                          'afterSha256': digest(after)}}})

    def prepare(self, *, fresh=False):
        return SUPPORT.prepare_patches(self.source, self.patches, fresh=fresh, patch_root=self.root)

    def test_ordered_patches_and_read_only_resume(self):
        receipt = self.prepare(fresh=True)
        file = self.source / 'example.cc'
        self.assertEqual(file.read_text(), 'second patch\n')
        modified = file.stat().st_mtime_ns
        self.assertEqual(self.prepare(), receipt)
        self.assertEqual(file.stat().st_mtime_ns, modified)

    def test_existing_unpatched_tree_requires_fresh_build(self):
        with self.assertRaisesRegex(RuntimeError, 'fresh isolated build directory'):
            self.prepare()
        self.assertEqual((self.source / 'example.cc').read_text(), 'original\n')

    def test_patch_bytes_must_match_lock_before_source_changes(self):
        (self.root / '0.patch').write_text('different patch\n')
        with self.assertRaisesRegex(RuntimeError, 'Patch digest mismatch'):
            self.prepare(fresh=True)
        self.assertEqual((self.source / 'example.cc').read_text(), 'original\n')

    def test_wrong_base_file_is_rejected_before_patching(self):
        (self.source / 'example.cc').write_text('unknown source\n')
        with self.assertRaisesRegex(RuntimeError, 'beforeSha256 mismatch'):
            self.prepare(fresh=True)
        self.assertFalse((self.source / '.gcc-wasm-patches.json').exists())

    def test_changed_patched_source_cannot_resume(self):
        self.prepare(fresh=True)
        (self.source / 'example.cc').write_text('changed after patch\n')
        with self.assertRaisesRegex(RuntimeError, 'afterSha256 mismatch'):
            self.prepare()

    def test_changed_patch_set_cannot_resume(self):
        self.prepare(fresh=True)
        self.patches = copy.deepcopy(self.patches)
        self.patches[0]['upstreamCommits'] = ['https://example.invalid/changed']
        with self.assertRaisesRegex(RuntimeError, 'Source patch identity changed'):
            self.prepare()

    def test_incomplete_application_cannot_be_marked_or_resumed(self):
        self.patches[1]['files']['example.cc']['afterSha256'] = '0' * 64
        with self.assertRaisesRegex(RuntimeError, 'afterSha256 mismatch'):
            self.prepare(fresh=True)
        self.assertFalse((self.source / '.gcc-wasm-patches.json').exists())
        with self.assertRaisesRegex(RuntimeError, 'fresh isolated build directory'):
            self.prepare()


if __name__ == '__main__':
    unittest.main()

#!/usr/bin/env python3
"""Regression tests for linker provenance; these never import the SDK sysroot."""
import copy
import hashlib
import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest
from contextlib import contextmanager
from unittest.mock import patch


HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('gcc_wasi_runtime', HERE / 'prepare-runtime.py')
runtime = importlib.util.module_from_spec(spec)
previous_bytecode = sys.dont_write_bytecode
try:
    sys.dont_write_bytecode = True
    spec.loader.exec_module(runtime)
finally:
    sys.dont_write_bytecode = previous_bytecode


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_json(filename, value):
    data = (json.dumps(value, indent=2) + '\n').encode()
    filename.write_bytes(data)
    return digest(data)


class LinkerProvenanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pin = json.loads((HERE / 'runtime.lock.json').read_text())['browserLinker']
        cls.producer = json.loads((runtime.ROOT / cls.pin['producerManifest']).read_bytes())
        cls.toolchain = json.loads((runtime.ROOT / cls.pin['toolchainReceipt']).read_bytes())

    @contextmanager
    def fixture(self):
        """Use temporary metadata to exercise relations after their hashes pass."""
        with tempfile.TemporaryDirectory(prefix='gcc-wasi-linker-provenance-') as directory:
            root = pathlib.Path(directory)
            pin = copy.deepcopy(self.pin)
            pin.update(archive='lld.zip', producerManifest='producer.json', toolchainReceipt='toolchain.json')
            # linker_inputs checks identity only; archive execution is outside this test.
            archive = b'archive bytes used only by provenance regression tests'
            (root / pin['archive']).write_bytes(archive)
            pin['archiveSha256'] = digest(archive)
            producer = copy.deepcopy(self.producer)
            toolchain = {
                'producer': copy.deepcopy(self.toolchain['producer']),
                'assets': {'lld.zip': pin['archiveSha256']},
                'llvmCommit': self.toolchain['llvmCommit'],
                'llvmVersion': self.toolchain['llvmVersion'],
            }
            pin['producerManifestSha256'] = write_json(root / pin['producerManifest'], producer)
            toolchain['producer']['manifestSha256'] = pin['producerManifestSha256']
            pin['toolchainReceiptSha256'] = write_json(root / pin['toolchainReceipt'], toolchain)
            with patch.object(runtime, 'ROOT', root):
                runtime.linker_inputs(pin)  # Every negative test starts from a valid chain.
                yield root, pin, producer, toolchain

    def test_actual_pinned_archive_and_original_metadata_pass(self):
        archive, producer, toolchain = runtime.linker_inputs(self.pin)
        self.assertEqual(digest(archive), self.pin['archiveSha256'])
        self.assertEqual(digest(producer), self.pin['producerManifestSha256'])
        self.assertEqual(digest(toolchain), self.pin['toolchainReceiptSha256'])
        self.assertEqual(digest(producer), json.loads(toolchain)['producer']['manifestSha256'])

    def test_current_producer_cannot_replace_original_build_manifest(self):
        pin = copy.deepcopy(self.pin)
        pin['producerManifest'] = 'producer/clang-browser/manifest.json'
        current = (runtime.ROOT / pin['producerManifest']).read_bytes()
        self.assertNotEqual(digest(current), self.pin['producerManifestSha256'])
        with self.assertRaisesRegex(RuntimeError, 'Original LLVM producer manifest hash mismatch'):
            runtime.linker_inputs(pin)
        # Updating only the snapshot hash cannot bypass the original receipt link.
        pin['producerManifestSha256'] = digest(current)
        with self.assertRaisesRegex(RuntimeError, 'does not identify the original producer manifest'):
            runtime.linker_inputs(pin)

    def test_changed_archive_bytes_are_rejected(self):
        with self.fixture() as (root, pin, _, __):
            (root / pin['archive']).write_bytes(b'different archive')
            with self.assertRaisesRegex(RuntimeError, 'archive differs'):
                runtime.linker_inputs(pin)

    def test_changed_producer_bytes_are_rejected(self):
        with self.fixture() as (root, pin, _, __):
            filename = root / pin['producerManifest']
            filename.write_bytes(filename.read_bytes() + b'\n')
            with self.assertRaisesRegex(RuntimeError, 'Original LLVM producer manifest hash mismatch'):
                runtime.linker_inputs(pin)

    def test_changed_toolchain_bytes_are_rejected(self):
        with self.fixture() as (root, pin, _, __):
            filename = root / pin['toolchainReceipt']
            filename.write_bytes(filename.read_bytes() + b'\n')
            with self.assertRaisesRegex(RuntimeError, 'LLVM toolchain receipt hash mismatch'):
                runtime.linker_inputs(pin)

    def test_toolchain_must_identify_original_producer_after_hash_passes(self):
        for field in ['manifestSha256', 'manifest', 'id']:
            with self.subTest(field=field), self.fixture() as (root, pin, _, toolchain):
                toolchain['producer'][field] = 'different producer'
                pin['toolchainReceiptSha256'] = write_json(root / pin['toolchainReceipt'], toolchain)
                with self.assertRaisesRegex(RuntimeError, 'does not identify the original producer manifest'):
                    runtime.linker_inputs(pin)

    def test_toolchain_must_identify_linker_after_hash_passes(self):
        for field in ['archive', 'llvmCommit', 'llvmVersion']:
            with self.subTest(field=field), self.fixture() as (root, pin, _, toolchain):
                if field == 'archive':
                    toolchain['assets']['lld.zip'] = '0' * 64
                else:
                    toolchain[field] = 'different linker'
                pin['toolchainReceiptSha256'] = write_json(root / pin['toolchainReceipt'], toolchain)
                with self.assertRaisesRegex(RuntimeError, 'does not identify the pinned linker'):
                    runtime.linker_inputs(pin)

    def test_original_producer_must_identify_llvm_after_hashes_pass(self):
        for field in ['repository', 'commit', 'version']:
            with self.subTest(field=field), self.fixture() as (root, pin, producer, toolchain):
                producer['sources']['llvm'][field] = 'different LLVM source'
                pin['producerManifestSha256'] = write_json(root / pin['producerManifest'], producer)
                toolchain['producer']['manifestSha256'] = pin['producerManifestSha256']
                pin['toolchainReceiptSha256'] = write_json(root / pin['toolchainReceipt'], toolchain)
                with self.assertRaisesRegex(RuntimeError, 'Original LLVM producer identifies another source revision'):
                    runtime.linker_inputs(pin)


if __name__ == '__main__':
    unittest.main()

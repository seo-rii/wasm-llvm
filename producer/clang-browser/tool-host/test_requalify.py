import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
spec = importlib.util.spec_from_file_location("requalify_links", Path(__file__).with_name("requalify.py"))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


def history(root):
    return {"schemaVersion": 1, "complete": False, "optimization": "none", "commands": [
        *[{"argv": ["/sdk/clang++", "-o", str(root / f"{kind}.raw.wasm")],
           "exitCode": 0, "termination": "exited"} for kind in ["clang", "lld"]],
        {"argv": ["node", str(root / "source-pack/verify.mjs"), str(root / "lld.wasm"),
                  str(root / "lld.module.json"), "--initial-cwd", "--kind=lld"],
         "exitCode": 1, "termination": "exited"}
    ]}


class RequalificationTests(unittest.TestCase):
    def test_requires_both_successful_links_and_exact_verifier_only_failure(self):
        root = Path("/candidate")
        receipt = history(root)
        helper.validate_history(receipt, root)
        variants = []
        for change in [lambda r: r.update(complete=True), lambda r: r.update(optimization="Oz"),
                       lambda r: r["commands"][0].update(exitCode=1),
                       lambda r: r["commands"][0].update(termination="timeout"),
                       lambda r: r["commands"].pop(0),
                       lambda r: r["commands"][-1]["argv"].__setitem__(-1, "--kind=clang"),
                       lambda r: r["commands"][-1].update(exitCode=-9),
                       lambda r: r["commands"][-1].update(termination="timeout")]:
            item = copy.deepcopy(receipt); change(item); variants.append(item)
        for item in variants:
            with self.subTest(item=item), self.assertRaises(ValueError):
                helper.validate_history(item, root)

    def setup_candidate(self, root):
        candidate, recipe = root / "candidate", root / "recipe"
        candidate.mkdir(); recipe.mkdir(); (candidate / "source-pack").mkdir()
        for name in ["build.py", "profile.json", "llvm-tool-host.patch", "initial-cwd.c"]:
            data = b'{}' if name == "profile.json" else name.encode()
            (recipe / name).write_bytes(data)
            (candidate / "source-pack" / name).write_bytes(data)
        (root / "manifest.json").write_text('{}')
        original = root / "original.obj"; original.write_bytes(b"read-only cached object")
        receipt = {**history(candidate), "profile": {},
                   "producerManifest": helper.identity(root / "manifest.json"),
                   "inputs": {str(original): helper.identity(original)}}
        (candidate / "build-receipt.json").write_text(json.dumps(receipt))
        for kind in ["clang", "lld"]:
            (candidate / f"{kind}.raw.wasm").write_bytes(kind.encode())
            (candidate / f"{kind}.wasm").write_bytes(kind.encode())
        pins = {kind: helper.identity(candidate / f"{kind}.wasm")["sha256"] for kind in ["clang", "lld"]}
        return candidate, recipe, helper.identity(candidate / "build-receipt.json")["sha256"], pins, original

    def test_pins_preserve_raw_bytes_recipe_and_all_cached_inputs(self):
        for changed in [None, "receipt", "raw", "tool", "recipe", "input"]:
            with self.subTest(changed=changed), tempfile.TemporaryDirectory() as directory:
                candidate, recipe, receipt, pins, original = self.setup_candidate(Path(directory))
                if changed:
                    path = {"receipt": candidate / "build-receipt.json", "raw": candidate / "lld.raw.wasm",
                            "tool": candidate / "clang.wasm", "recipe": recipe / "initial-cwd.c",
                            "input": original}[changed]
                    path.write_bytes(b"changed")
                with patch.object(helper, "HERE", recipe):
                    if changed:
                        with self.assertRaises(ValueError):
                            helper.validate_candidate(candidate, receipt, pins)
                    else:
                        helper.validate_candidate(candidate, receipt, pins)

    def test_invalid_trust_pin_creates_no_output_and_runs_no_verifier(self):
        with tempfile.TemporaryDirectory() as directory:
            from types import SimpleNamespace
            root = Path(directory)
            candidate, recipe, receipt, pins, _ = self.setup_candidate(root)
            args = SimpleNamespace(candidate=candidate, output=root / "new",
                                   source_receipt_sha256="0" * 64, clang_sha256=pins["clang"],
                                   lld_sha256=pins["lld"], node="node")
            with patch.object(helper, "HERE", recipe), patch.object(helper, "run_bounded") as run:
                with self.assertRaises(ValueError): helper.requalify(args)
                run.assert_not_called()
            self.assertFalse(args.output.exists())


if __name__ == "__main__":
    unittest.main()

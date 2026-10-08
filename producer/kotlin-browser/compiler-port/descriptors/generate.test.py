import copy
import importlib.util
import json
import os
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('descriptor_generator', HERE / 'generate.py')
GENERATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GENERATOR)


class DescriptorGeneratorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        prepared = os.environ.get('KOTLIN_DESCRIPTOR_PREPARED')
        if not prepared:
            raise unittest.SkipTest('Set KOTLIN_DESCRIPTOR_PREPARED to a real pinned preparation; skip is not acceptance')
        cls.units = json.loads((Path(prepared) / 'ast.json').read_bytes())
        cls.lock = json.loads((HERE / 'sources.lock.json').read_bytes())

    def generator(self, units=None):
        return GENERATOR.Generator(copy.deepcopy(units or self.units), self.lock['commonAncestorTypes'])

    def test_inherited_nested_types_follow_actual_java_and_kotlin_parents(self):
        generator = self.generator()
        for name in ('FunctionDescriptor', 'SimpleFunctionDescriptor', 'ConstructorDescriptor', 'PropertyAccessorDescriptor'):
            self.assertEqual(generator.resolve('Kind', 'org.jetbrains.kotlin.descriptors.' + name, set()), 'org.jetbrains.kotlin.descriptors.CallableMemberDescriptor.Kind')
        self.assertEqual(generator.resolve('UserDataKey', 'org.jetbrains.kotlin.descriptors.FunctionDescriptor.CopyBuilder', set()), 'org.jetbrains.kotlin.descriptors.CallableDescriptor.UserDataKey')

    def test_nullable_java_contract_is_retained(self):
        generator = self.generator()
        unit = next(unit for unit in self.units if unit['path'].endswith('/FunctionDescriptor.java'))
        source = generator.file(unit)
        self.assertIn('fun substitute(substitutor: org.jetbrains.kotlin.types.TypeSubstitutor): org.jetbrains.kotlin.descriptors.FunctionDescriptor?', source)
        self.assertIn('Collection<out org.jetbrains.kotlin.descriptors.FunctionDescriptor>', source)

    def test_nontrivial_default_body_fails_without_substitute_implementation(self):
        units = copy.deepcopy(self.units)
        unit = next(unit for unit in units if unit['path'].endswith('/ValidateableDescriptor.java'))
        unit['declarations'][0]['members'][0]['body'] = '{\nthrow new Error();\n}'
        with self.assertRaisesRegex(ValueError, 'Nontrivial interface default body'):
            self.generator(units).file(unit)

    def test_original_enum_body_change_fails(self):
        units = copy.deepcopy(self.units)
        unit = next(unit for unit in units if unit['path'].endswith('/CallableMemberDescriptor.java'))
        enum = next(member for member in unit['declarations'][0]['members'] if member['kind'] == 'ENUM')
        method = next(member for member in enum['members'] if member['kind'] == 'METHOD')
        method['body'] = '{\nreturn true;\n}'
        with self.assertRaisesRegex(ValueError, 'Unsupported enum method body'):
            self.generator(units).file(unit)

    def test_properties_override_genuine_kotlin_ancestor(self):
        generator = self.generator()
        unit = next(unit for unit in self.units if unit['path'].endswith('/PropertyDescriptor.java'))
        source = generator.file(unit)
        self.assertIn('override val getter: org.jetbrains.kotlin.descriptors.PropertyGetterDescriptor?', source)
        self.assertIn('override val setter: org.jetbrains.kotlin.descriptors.PropertySetterDescriptor?', source)
        self.assertTrue(any('PropertyDescriptor.getGetter()' in alias for alias in generator.aliases))
        self.assertNotIn('fun getGetter()', source)

    def test_unsupported_type_syntax_and_implementation_fail(self):
        generator = self.generator()
        with self.assertRaisesRegex(ValueError, 'Unsupported type syntax'):
            generator.typ('Class<?>; runtimeEscape()', 'org.jetbrains.kotlin.descriptors.Named', set())
        unit = copy.deepcopy(self.units[0])
        unit['declarations'][0]['kind'] = 'CLASS'
        with self.assertRaisesRegex(ValueError, 'Implementation accidentally included'):
            generator.file(unit)


if __name__ == '__main__':
    unittest.main()

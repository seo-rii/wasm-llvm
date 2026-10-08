import copy,importlib.util,json,os
from pathlib import Path
import unittest

HERE=Path(__file__).resolve().parent
SPEC=importlib.util.spec_from_file_location('type_generator',HERE/'generate.py')
MODULE=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(MODULE)

class TypeContractGeneratorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        prepared=os.environ.get('KOTLIN_TYPE_CONTRACTS_PREPARED')
        if not prepared:raise unittest.SkipTest('Set KOTLIN_TYPE_CONTRACTS_PREPARED to actual preparation; skip is not acceptance')
        cls.prepared=Path(prepared);cls.ast=json.loads((cls.prepared/'ast.json').read_bytes());cls.base=MODULE.load_base(cls.prepared/'base/generate.py')
    def generate(self,ast=None):
        units=MODULE.resolved_units(ast or self.ast);generator=MODULE.make_generator(self.base,units)
        return generator,{Path(unit['path']).stem:generator.file(unit)for unit in units}
    def test_actual_wildcard_imports_resolve_to_real_constant_types(self):
        generator,files=self.generate()
        self.assertIn('value: org.jetbrains.kotlin.resolve.constants.IntValue',files['AnnotationArgumentVisitor'])
        self.assertNotIn('org.jetbrains.kotlin.descriptors.annotations.IntValue',files['AnnotationArgumentVisitor'])
    def test_real_factory_and_original_mapper_body_are_retained(self):
        generator,files=self.generate()
        self.assertIn('org.jetbrains.kotlin.types.checker.NewKotlinTypeChecker.Default',files['KotlinTypeChecker'])
        self.assertIn('@kotlin.jvm.JvmField',files['KotlinTypeChecker'])
        self.assertIn('= emptyList()',files['PlatformToKotlinClassMapper'])
        self.assertEqual(len(generator.preserved_bodies),1)
        self.assertEqual(len(generator.preserved_fields),1)
    def test_genuine_opt_in_and_default_annotations_are_retained(self):
        generator,files=self.generate()
        for name in ['TypeConstructor','TypeProjection']:self.assertIn('@org.jetbrains.kotlin.types.TypeRefinement',files[name])
        self.assertIn('@org.jetbrains.kotlin.container.DefaultImplementation',files['PlatformToKotlinClassMapper'])
        self.assertEqual(len(generator.annotations),3)
    def test_changed_initializer_is_blocked_not_replaced(self):
        ast=copy.deepcopy(self.ast);unit=next(unit for unit in ast if unit['path'].endswith('/KotlinTypeChecker.java'))
        field=next(member for member in unit['declarations'][0]['members']if member['kind']=='VARIABLE')
        field['declaration']['initializer']='null'
        with self.assertRaisesRegex(ValueError,'Unimplemented interface initializer'):self.generate(ast)
    def test_changed_nested_default_body_is_blocked(self):
        ast=copy.deepcopy(self.ast);unit=next(unit for unit in ast if unit['path'].endswith('/PlatformToKotlinClassMapper.java'))
        nested=next(member for member in unit['declarations'][0]['members']if member['kind']=='CLASS');nested['members'][0]['body']='{\nreturn null;\n}'
        with self.assertRaisesRegex(ValueError,'Original mapper default body changed'):self.generate(ast)
    def test_missing_real_opt_in_annotation_is_blocked(self):
        ast=copy.deepcopy(self.ast);unit=next(unit for unit in ast if unit['path'].endswith('/TypeProjection.java'))
        method=next(member for member in unit['declarations'][0]['members']if member['kind']=='METHOD'and member['name']=='refine');method['modifiers']['annotations'].remove('@TypeRefinement')
        with self.assertRaisesRegex(ValueError,'Original type-refinement opt-in contract changed'):self.generate(ast)

if __name__=='__main__':unittest.main()

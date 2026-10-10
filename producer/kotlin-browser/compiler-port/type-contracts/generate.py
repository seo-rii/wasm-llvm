#!/usr/bin/env python3
"""Extend the sealed descriptor generator with actual type/receiver contracts."""
import argparse,copy,hashlib,importlib.util,json
from pathlib import Path

def load_base(path):
    spec=importlib.util.spec_from_file_location('original_descriptor_generator',path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

def resolved_units(units):
    units=copy.deepcopy(units)
    def resolve(declaration):
        declaration['interfaces']=declaration['resolvedInterfaces']
        for member in declaration['members']:
            if member['kind'] in ('INTERFACE','ENUM','CLASS'):resolve(member)
            elif member['kind']=='METHOD':
                member['returnType']=member['resolvedReturnType']
                for parameter in member['parameters']:parameter['type']=parameter['resolvedType']
            elif member['kind']=='VARIABLE':member['declaration']['type']=member['declaration']['resolvedType']
            else:raise ValueError('Unexpected actual AST member')
    for unit in units:
        for declaration in unit['declarations']:resolve(declaration)
    return units

def make_generator(base,units):
    class TypeGenerator(base.Generator):
        def __init__(self,units):
            super().__init__(units);self.preserved_bodies=[];self.preserved_fields=[];self.annotations=[]
        def declaration(self,declaration,owner):
            fq=owner+'.'+declaration['name'];special=copy.deepcopy(declaration)
            classes=[member for member in declaration['members'] if member['kind']=='CLASS']
            fields=[member['declaration'] for member in declaration['members'] if member['kind']=='VARIABLE'] if declaration['kind']=='INTERFACE' else []
            special['members']=[member for member in declaration['members'] if member['kind']!='CLASS' and not(declaration['kind']=='INTERFACE' and member['kind']=='VARIABLE')]
            source=super().declaration(special,owner)
            for nested in classes:
                if fq!='org.jetbrains.kotlin.builtins.PlatformToKotlinClassMapper' or nested['name']!='Default' or nested['interfaces']!=[fq] or len(nested['members'])!=1:raise ValueError('Unimplemented nested class conversion')
                method=nested['members'][0]
                if method['kind']!='METHOD' or method['name']!='mapPlatformClass' or method['body'].strip()!='{\n    return Collections.emptyList();\n}' or method['returnType']!='java.util.Collection<org.jetbrains.kotlin.descriptors.ClassDescriptor>' or len(method['parameters'])!=1 or '@NotNull' not in method['modifiers']['annotations']:raise ValueError('Original mapper default body changed')
                parameter=method['parameters'][0]
                if parameter['name']!='classDescriptor' or parameter['type']!='org.jetbrains.kotlin.descriptors.ClassDescriptor' or '@NotNull' not in parameter['modifiers']['annotations']:raise ValueError('Original mapper input changed')
                source=source[:-1]+'    class Default : '+fq+' {\n        override fun mapPlatformClass(classDescriptor: org.jetbrains.kotlin.descriptors.ClassDescriptor): Collection<org.jetbrains.kotlin.descriptors.ClassDescriptor> = emptyList()\n    }\n}'
                self.methods+=1;self.preserved_bodies.append({'owner':fq+'.Default','method':'mapPlatformClass','originalBody':method['body'],'commonBody':'emptyList()','scope':'original immutable empty collection default, not a replacement checker'})
            for field in fields:
                if fq!='org.jetbrains.kotlin.types.checker.KotlinTypeChecker' or field['name']!='DEFAULT' or field['type']!=fq or field['initializer']!='NewKotlinTypeChecker.Companion.getDefault()':raise ValueError('Unimplemented interface initializer')
                source=source[:-1]+'    companion object {\n        @kotlin.jvm.JvmField\n        val DEFAULT: '+fq+' = org.jetbrains.kotlin.types.checker.NewKotlinTypeChecker.Default\n    }\n}'
                self.preserved_fields.append({'owner':fq,'field':'DEFAULT','originalInitializer':field['initializer'],'commonInitializer':'org.jetbrains.kotlin.types.checker.NewKotlinTypeChecker.Default','semantics':'eager delegation to the genuine original checker factory'})
            for annotation in declaration['modifiers']['annotations']:
                if annotation.replace(' ','')!='@DefaultImplementation(impl=PlatformToKotlinClassMapper.Default.class)':raise ValueError('Unimplemented interface annotation: '+annotation)
                source='@org.jetbrains.kotlin.container.DefaultImplementation(impl = org.jetbrains.kotlin.builtins.PlatformToKotlinClassMapper.Default::class)\n'+source
                self.annotations.append({'owner':fq,'annotation':annotation,'strategy':'original common KClass annotation preserved'})
            if fq=='org.jetbrains.kotlin.builtins.PlatformToKotlinClassMapper' and len(declaration['modifiers']['annotations'])!=1:raise ValueError('Original default-implementation annotation changed')
            for method in declaration['members']:
                if method['kind']!='METHOD':continue
                if fq in ('org.jetbrains.kotlin.types.TypeConstructor','org.jetbrains.kotlin.types.TypeProjection') and method['name']=='refine' and '@TypeRefinement' not in method['modifiers']['annotations']:raise ValueError('Original type-refinement opt-in contract changed')
                for annotation in method['modifiers']['annotations']:
                    if annotation in ('@NotNull','@Nullable','@Override','@ReadOnly'):continue
                    if annotation!='@TypeRefinement' or fq not in ('org.jetbrains.kotlin.types.TypeConstructor','org.jetbrains.kotlin.types.TypeProjection') or method['name']!='refine':raise ValueError('Unimplemented method annotation: '+annotation)
                    needle='    fun refine(';replacement='    @org.jetbrains.kotlin.types.TypeRefinement\n'+needle
                    if source.count(needle)!=1:raise ValueError('Changed type-refinement declaration')
                    source=source.replace(needle,replacement)
                    self.annotations.append({'owner':fq,'method':'refine','annotation':'org.jetbrains.kotlin.types.TypeRefinement','strategy':'official opt-in annotation preserved'})
            return source
    return TypeGenerator(units)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--base-generator',required=True);parser.add_argument('--ast',required=True);parser.add_argument('--output',required=True);args=parser.parse_args()
    ast=Path(args.ast).read_bytes();units=resolved_units(json.loads(ast));base=load_base(args.base_generator);generator=make_generator(base,units)
    output=Path(args.output);output.mkdir(parents=True,exist_ok=False);records=[]
    for unit in units:
        name=Path(unit['path']).with_suffix('.kt').name;source=generator.file(unit).encode();(output/name).write_bytes(source)
        records.append({'path':name,'bytes':len(source),'sha256':hashlib.sha256(source).hexdigest(),'originalPath':unit['path']})
    aliases=('// Typed property aliases for genuine type and receiver contract methods.\npackage org.jetbrains.kotlin.portable.descriptors\n\n'+'\n'.join(generator.aliases)+'\n').encode();name='TypeProperties.kt';(output/name).write_bytes(aliases)
    records.append({'path':name,'bytes':len(aliases),'sha256':hashlib.sha256(aliases).hexdigest(),'originalPath':None})
    summary={'schemaVersion':1,'kind':'official-type-common-contracts','astSha256':hashlib.sha256(ast).hexdigest(),'baseGeneratorSha256':hashlib.sha256(Path(args.base_generator).read_bytes()).hexdigest(),'javaUnits':len(units),'interfaces':sum(declaration['kind']=='INTERFACE' for declaration in generator.types.values()),'enums':sum(declaration['kind']=='ENUM'for declaration in generator.types.values()),'methods':generator.methods,'aliases':len(generator.aliases),'files':records,'auditRequired':generator.ambiguities,'preservedBodies':generator.preserved_bodies,'preservedFields':generator.preserved_fields,'preservedAnnotations':generator.annotations,'typeCheckingAlgorithmsPorted':False,'readiness':False}
    (output/'generation.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps({key:summary[key]for key in ('javaUnits','interfaces','enums','methods','aliases')}))

if __name__=='__main__':main()

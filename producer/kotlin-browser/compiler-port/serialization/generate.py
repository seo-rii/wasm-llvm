#!/usr/bin/env python3
"""Generate portable typed proto2 APIs from an official protoc descriptor set.

No parser/schema substitutions: all field numbers, defaults, oneofs, extension ranges
and enum values come from descriptors. Generated output is a build artifact.
"""
import argparse
import hashlib
import json
from pathlib import Path
from google.protobuf import descriptor_pb2 as pb

KEYWORDS = set('as break class continue do else false for fun if in interface is null object package return super this throw true try typealias typeof val var when while by catch constructor delegate dynamic field file finally get import init param property receiver set setparam where actual abstract annotation companion const crossinline data enum expect external final infix inline inner internal lateinit noinline open operator out override private protected public reified sealed suspend tailrec vararg'.split())
KIND = {1:'DOUBLE',2:'FLOAT',3:'INT64',4:'UINT64',5:'INT32',6:'FIXED64',7:'FIXED32',8:'BOOL',9:'STRING',10:'GROUP',11:'MESSAGE',12:'BYTES',13:'UINT32',14:'ENUM',15:'SFIXED32',16:'SFIXED64',17:'SINT32',18:'SINT64'}
SCALARS = {1:'Double',2:'Float',3:'Long',4:'Long',5:'Int',6:'Long',7:'Int',8:'Boolean',9:'String',12:'ByteString',13:'Int',15:'Int',16:'Long',17:'Int',18:'Long'}

def ident(value): return f'`{value}`' if value in KEYWORDS else value

def literal(value): return json.dumps(value,ensure_ascii=False).replace('$','\\$')

def camel(value):
    parts=value.split('_')
    return parts[0]+''.join(p[:1].upper()+p[1:] for p in parts[1:])

def cap(value): return value[:1].upper()+value[1:]

class Generator:
    def __init__(self, descriptors):
        self.files=descriptors.file
        self.types={}
        self.enums={}
        self.messages={}
        for file in self.files:
            package=file.options.java_package or file.package
            if package=='com.google.protobuf': package='org.jetbrains.kotlin.protobuf'
            outer=file.options.java_outer_classname
            prefix=package+'.'+outer if not file.options.java_multiple_files else package
            for enum in file.enum_type: self.enums['.'+file.package+'.'+enum.name]=enum; self.types['.'+file.package+'.'+enum.name]=prefix+'.'+enum.name
            for msg in file.message_type: self.register(msg,'.'+file.package,prefix)
    def register(self,msg,proto,parent):
        name=proto+'.'+msg.name
        self.types[name]=parent+'.'+msg.name
        self.messages[name]=msg
        for enum in msg.enum_type:
            self.enums[name+'.'+enum.name]=enum
            self.types[name+'.'+enum.name]=parent+'.'+msg.name+'.'+enum.name
        for nested in msg.nested_type: self.register(nested,name,parent+'.'+msg.name)
    def typename(self,field): return self.types[field.type_name] if field.type in (10,11,14) else SCALARS[field.type]
    def default(self,field):
        if field.type in (10,11): return self.types[field.type_name]+'.getDefaultInstance()'
        if field.type==14: return self.types[field.type_name]+'.'+(field.default_value if field.HasField('default_value') else self.enums[field.type_name].value[0].name)
        value=field.default_value if field.HasField('default_value') else None
        if field.type==9: return literal(value or '')
        if field.type==12:
            if value: raise ValueError('Nonempty bytes defaults require exact C escape decoding')
            return 'ByteString.EMPTY'
        if field.type==8: return value or 'false'
        if field.type in (1,2):
            t=SCALARS[field.type]
            if value=='nan': return t+'.NaN'
            if value=='inf': return t+'.POSITIVE_INFINITY'
            if value=='-inf': return t+'.NEGATIVE_INFINITY'
            return (value or '0') + ('.0' if not value or all(c not in (value or '') for c in '.eE') else '') + ('f' if field.type==2 else '')
        number=int(value or 0)
        if SCALARS[field.type]=='Long':
            number=number if number<1<<63 else number-(1<<64)
            return 'Long.MIN_VALUE' if number==-(1<<63) else str(number)+'L'
        number=number if number<1<<31 else number-(1<<32)
        return 'Int.MIN_VALUE' if number==-(1<<31) else str(number)
    def field(self,f,msg=None):
        args=[str(f.number),'ProtoKind.'+KIND[f.type],f'repeated = {str(f.label==3).lower()}',f'required = {str(f.label==2).lower()}',f'packed = {str(f.options.packed).lower()}']
        if f.HasField('oneof_index'): args.append('oneof = '+literal(msg.oneof_decl[f.oneof_index].name))
        args.append('default = { '+self.default(f)+' }')
        if f.type in (10,11): args.append('message = { '+self.types[f.type_name]+'.SCHEMA }')
        if f.type==14: args.append('enumValue = { '+self.types[f.type_name]+'.valueOf(it) }')
        return 'ProtoField('+', '.join(args)+')'
    def enum(self,e,indent=''):
        lines=[f'{indent}enum class {e.name}(@get:JvmName("getNumberProperty") val number: Int) : Internal.EnumLite {{']
        lines += [f'{indent}    {v.name}({v.number})'+(';' if i==len(e.value)-1 else ',') for i,v in enumerate(e.value)]
        lines += [f'{indent}    override fun getNumber(): Int = number',f'{indent}    companion object {{',f'{indent}        fun valueOf(number: Int): {e.name}? = entries.firstOrNull {{ it.number == number }}',f'{indent}        fun internalGetValueMap(): Internal.EnumLiteMap<{e.name}> = Internal.EnumLiteMap {{ valueOf(it) }}']
        lines += [f'{indent}        const val {v.name}_VALUE: Int = {v.number}' for v in e.value]
        return '\n'.join(lines+[f'{indent}    }}',f'{indent}}}'])
    def field_api(self,f,builder=False):
        name=f.json_name or camel(f.name); upper=cap(name); t=self.typename(f); n=f.number; i=ident(name)
        prop=lambda p,t,expr: f'@get:JvmName("get{cap(p)}Property") val {ident(p)}: {t} get() = {expr}'
        lines=[]
        if f.label==3:
            lines += [prop(name+'List',f'List<{t}>',f'list({n}) as List<{t}>'),prop(name+'Count','Int',f'{ident(name+"List")}.size'),f'override fun get{upper}List(): List<{t}> = {ident(name+"List")}',f'override fun get{upper}Count(): Int = {ident(name+"Count")}',f'override fun get{upper}(index: Int): {t} = {ident(name+"List")}[index]']
            if f.type==9: lines += [f'override fun get{upper}Bytes(index: Int): ByteString = listBytes({n}, index)']
            if builder:
                lines += [f'fun set{upper}(index: Int, value: {t}): Builder = replace({n}, index, value)',f'fun add{upper}(value: {t}): Builder = append({n}, value)',f'fun addAll{upper}(values: Iterable<{t}>): Builder {{ values.forEach {{ add{upper}(it) }}; return this }}',f'fun clear{upper}(): Builder = remove({n})']
                if f.type==9: lines += [f'fun add{upper}Bytes(value: ByteString): Builder = append({n}, value)']
                if f.type in (10,11): lines += [f'fun set{upper}(index: Int, value: {t}.Builder): Builder = set{upper}(index, value.build())',f'fun add{upper}(value: {t}.Builder): Builder = add{upper}(value.build())']
        else:
            if builder: lines += [f'@get:JvmName("get{upper}Property") @set:JvmName("set{upper}Property") var {i}: {t}',f'    get() = field({n}) as {t}',f'    set(value) {{ put({n}, value) }}']
            else: lines += [prop(name,t,f'field({n}) as {t}')]
            lines += [f'override fun has{upper}(): Boolean = hasField({n})',f'override fun get{upper}(): {t} = {i}']
            if f.type==9: lines += [prop(name+'Bytes','ByteString',f'bytes({n})'),f'override fun get{upper}Bytes(): ByteString = {ident(name+"Bytes")}']
            if builder:
                lines += [f'fun set{upper}(value: {t}): Builder = put({n}, value)',f'fun clear{upper}(): Builder = remove({n})']
                if f.type==9: lines += [f'fun set{upper}Bytes(value: ByteString): Builder = put({n}, value)']
                if f.type in (10,11): lines += [f'fun set{upper}(value: {t}.Builder): Builder = set{upper}(value.build())',f'fun merge{upper}(value: {t}): Builder = mergeMessage({n}, value)']
        return lines
    def orbuilder(self,msg):
        lines=[f'interface {msg.name}OrBuilder : MessageLiteOrBuilder {{']
        for f in msg.field:
            name=cap(f.json_name or camel(f.name)); t=self.typename(f)
            if f.label==3:
                lines += [f'    fun get{name}List(): List<{t}>',f'    fun get{name}Count(): Int',f'    fun get{name}(index: Int): {t}']
                if f.type==9: lines += [f'    fun get{name}Bytes(index: Int): ByteString']
            else:
                lines += [f'    fun has{name}(): Boolean',f'    fun get{name}(): {t}']
                if f.type==9: lines += [f'    fun get{name}Bytes(): ByteString']
        for oneof in msg.oneof_decl: lines.append(f'    fun get{cap(camel(oneof.name))}Case(): {msg.name}.{cap(camel(oneof.name))}Case')
        return '\n'.join(lines+['}'])
    def message(self,msg,proto):
        name=msg.name; full=proto+'.'+name; extend=bool(msg.extension_range)
        base=f'GeneratedMessageLite.ExtendableMessage<{name}>' if extend else 'GeneratedMessageLite'
        lines=[self.orbuilder(msg),f'class {name} internal constructor(state: ProtoState) : {base}(SCHEMA, state), {name}OrBuilder {{']
        for e in msg.enum_type: lines.append(self.enum(e,'    '))
        for nested in msg.nested_type: lines.append('\n'.join('    '+s for s in self.message(nested,full).splitlines()))
        for f in msg.field: lines += ['    '+s for s in self.field_api(f)]
        for index,oneof in enumerate(msg.oneof_decl):
            cn=cap(camel(oneof.name))+'Case'; prop=camel(oneof.name)+'Case'
            fields=[f for f in msg.field if f.HasField('oneof_index') and f.oneof_index==index]
            lines += [f'    enum class {cn}(@get:JvmName("getNumberProperty") val number: Int) : Internal.EnumLite {{']
            lines += [f'        {f.name.upper()}({f.number}),' for f in fields]
            lines += [f'        {oneof.name.upper()}_NOT_SET(0);',f'        override fun getNumber(): Int = number',f'        companion object {{ fun valueOf(number: Int): {cn}? = entries.firstOrNull {{ it.number == number }} }}','    }',f'    @get:JvmName("get{cap(prop)}Property") val {prop}: {cn} get() = {cn}.valueOf(oneofCase({literal(oneof.name)}))!!',f'    override fun get{cap(prop)}(): {cn} = {prop}']
        lines += [f'    override fun getDefaultInstanceForType(): {name} = getDefaultInstance()',f'    override fun getParserForType(): Parser<{name}> = PARSER',f'    override fun toBuilder(): Builder = Builder(state)',f'    override fun newBuilderForType(): Builder = Builder()', '    companion object {',f'        val SCHEMA: ProtoSchema by lazy(LazyThreadSafetyMode.NONE) {{ ProtoSchema({literal(full[1:])}, listOf(']
        lines += ['            '+self.field(f,msg)+(',' if i<len(msg.field)-1 else '') for i,f in enumerate(msg.field)]
        ranges=', '.join(f'{r.start} until {r.end}' for r in msg.extension_range)
        lines += [f'        ), listOf({ranges})) {{ {name}(it) }} }}',f'        val PARSER: Parser<{name}> = object : Parser<{name}> {{',f'            override fun parsePartialFrom(input: CodedInputStream, registry: ExtensionRegistryLite): {name} = ProtoCodec.decode(SCHEMA, input, registry) as {name}','        }',f'        fun parser(): Parser<{name}> = PARSER',f'        fun getDefaultInstance(): {name} = SCHEMA.defaultInstance as {name}', '        fun newBuilder(): Builder = Builder()',f'        fun newBuilder(prototype: {name}): Builder = Builder(prototype.state)']
        for input_type in ['ByteArray','ByteString','CodedInputStream','ProtoInput']:
            lines += [f'        fun parseFrom(input: {input_type}): {name} = PARSER.parseFrom(input)',f'        fun parseFrom(input: {input_type}, registry: ExtensionRegistryLite): {name} = PARSER.parseFrom(input, registry)']
        lines += [f'        fun parseDelimitedFrom(input: ProtoInput, registry: ExtensionRegistryLite = ExtensionRegistryLite.getEmptyRegistry()): {name}? = PARSER.parseDelimitedFrom(input, registry)']
        lines += [f'        const val {f.name.upper()}_FIELD_NUMBER: Int = {f.number}' for f in msg.field]
        lines += ['    }']
        bb='GeneratedMessageLite.ExtendableBuilder' if extend else 'GeneratedMessageLite.Builder'
        lines += [f'    class Builder internal constructor(state: ProtoState = ProtoState()) : {bb}<{name}, Builder>(SCHEMA, state), {name}OrBuilder {{',f'        override fun buildPartial(): {name} = {name}(_protoState.freeze())','        override fun clone(): Builder = Builder(_protoState.freeze())']
        for f in msg.field: lines += ['        '+s for s in self.field_api(f,True)]
        for oneof in msg.oneof_decl:
            cn=cap(camel(oneof.name))+'Case'; prop=camel(oneof.name)+'Case'
            lines += [f'        @get:JvmName("get{cap(prop)}Property") val {prop}: {cn} get() = {cn}.valueOf(oneofCase({literal(oneof.name)}))!!',f'        override fun get{cap(prop)}(): {cn} = {prop}',f'        fun clear{cap(camel(oneof.name))}(): Builder {{ SCHEMA.fields.filter {{ it.oneof == {literal(oneof.name)} }}.forEach {{ remove(it.number) }}; return this }}']
        lines += ['    }','}']
        return '\n'.join(lines)
    def extensions(self,extensions):
        lines=[]
        for f in extensions:
            t=self.typename(f); t=f'List<{t}>' if f.label==3 else t
            containing=self.types[f.extendee]; name=ident(f.json_name or camel(f.name))
            lines += [f'val {name}: GeneratedMessageLite.GeneratedExtension<{containing}, {t}> by lazy(LazyThreadSafetyMode.NONE) {{',f'    GeneratedMessageLite.GeneratedExtension({literal(f.extendee[1:])}, {self.field(f)})','}']
        lines += ['fun registerAllExtensions(registry: ExtensionRegistryLite) {']+[f'    registry.add({ident(f.json_name or camel(f.name))})' for f in extensions]+['}']
        return '\n'.join(lines)
    def file(self,file):
        package=file.options.java_package or file.package
        if package=='com.google.protobuf': package='org.jetbrains.kotlin.protobuf'
        lines=['// Generated from the pinned official descriptor set; do not edit.', '@file:Suppress("UNCHECKED_CAST")',f'package {package}', 'import kotlin.jvm.JvmName','import org.jetbrains.kotlin.protobuf.*','']
        if not file.options.java_multiple_files: lines += [f'object {file.options.java_outer_classname} {{']
        body=[]
        for enum in file.enum_type: body.append(self.enum(enum))
        for msg in file.message_type: body.append(self.message(msg,'.'+file.package))
        body.append(self.extensions(file.extension))
        if not file.options.java_multiple_files: lines += ['    '+s for s in '\n\n'.join(body).splitlines()]+['}']
        else: lines += body
        return '\n'.join(lines)+'\n'

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--descriptor',required=True); parser.add_argument('--output',required=True)
    args=parser.parse_args(); data=Path(args.descriptor).read_bytes(); descriptors=pb.FileDescriptorSet.FromString(data)
    output=Path(args.output); output.mkdir(parents=True,exist_ok=False)
    generator=Generator(descriptors); records=[]
    for file in descriptors.file:
        name=file.options.java_outer_classname+'.kt'; source=generator.file(file).encode(); path=output/name; path.write_bytes(source)
        records.append({'path':name,'bytes':len(source),'sha256':hashlib.sha256(source).hexdigest(),'schema':file.name})
    catalog=[]
    for proto,message in generator.messages.items():
        fq=generator.types[proto]
        parts=fq.split('.')
        index=next(i for i,p in enumerate(parts) if p and p[0].isupper())
        java='.'.join(parts[:index])+'.'+'$'.join(parts[index:])
        catalog.append({'protoName':proto[1:],'kotlinName':fq,'javaName':java})
    registry=['// Generated schema lookup for codec verification; no reflection.','package org.jetbrains.kotlin.protobuf','object CodecSchemas {','    val factories: Map<String, () -> ProtoSchema> = mapOf(']
    registry += ['        '+literal(r['protoName'])+' to { '+r['kotlinName']+'.SCHEMA }'+(',' if i<len(catalog)-1 else '') for i,r in enumerate(catalog)]
    registry += ['    )','}']
    name='CodecSchemas.kt';source=('\n'.join(registry)+'\n').encode();(output/name).write_bytes(source)
    records.append({'path':name,'bytes':len(source),'sha256':hashlib.sha256(source).hexdigest(),'schema':None})
    catalog_bytes=(json.dumps(catalog,indent=2)+'\n').encode();(output/'catalog.json').write_bytes(catalog_bytes)
    (output/'generation.json').write_text(json.dumps({'schemaVersion':1,'descriptorSha256':hashlib.sha256(data).hexdigest(),'messages':len(generator.messages),'enums':len(generator.enums),'fields':sum(len(m.field) for m in generator.messages.values()),'extensions':sum(len(f.extension) for f in descriptors.file),'catalog':{'path':'catalog.json','bytes':len(catalog_bytes),'sha256':hashlib.sha256(catalog_bytes).hexdigest()},'files':records},indent=2)+'\n')
if __name__=='__main__': main()

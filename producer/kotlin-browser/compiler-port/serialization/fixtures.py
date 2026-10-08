#!/usr/bin/env python3
"""Extract bounded real stdlib protobuf inputs and proto2 edge fixtures.

IR table extraction follows the source-locked lowLevelReaders.kt layout. This is
fixture extraction, not a replacement compiler/KLIB implementation.
"""
import argparse,hashlib,json,struct,zipfile
from pathlib import Path
from google.protobuf import descriptor_pb2 as pb, descriptor_pool, message_factory

def varint(v):
    v &= (1<<64)-1
    result=bytearray()
    while v>=128: result.append((v&127)|128);v>>=7
    result.append(v);return bytes(result)
def field(n,wire,payload): return varint((n<<3)|wire)+payload
def integer(n,v):return field(n,0,varint(v))
def blob(n,b):return field(n,2,varint(len(b))+b)

def table(data):
    if len(data)<4:raise ValueError('Truncated IR array header')
    count=struct.unpack_from('>i',data)[0];packed=count<0;count=abs(count)
    if count>1_000_000:raise ValueError('IR array count exceeded limit')
    pos=4;sizes=[]
    for _ in range(count):
        if packed:
            value=0
            for shift in range(0,35,7):
                if pos>=len(data):raise ValueError('Truncated IR array size')
                byte=data[pos];pos+=1;value|=(byte&127)<<shift
                if byte<128:break
            else:raise ValueError('IR array size overflow')
        else:
            if pos>len(data)-4:raise ValueError('Truncated IR array size')
            value=struct.unpack_from('>i',data,pos)[0];pos+=4
        if value<0:raise ValueError('Negative IR element size')
        sizes.append(value)
    values=[]
    for size in sizes:
        if size>len(data)-pos:raise ValueError('Truncated IR table item')
        values.append(data[pos:pos+size]);pos+=size
    if pos!=len(data):raise ValueError('Unexpected trailing IR bytes')
    return values

def main():
    p=argparse.ArgumentParser();p.add_argument('--prepared-dir',required=True);p.add_argument('--stdlib',required=True);p.add_argument('--stdlib-sha256',required=True);p.add_argument('--output',required=True);args=p.parse_args()
    prepared=Path(args.prepared_dir);output=Path(args.output);output.mkdir(parents=True,exist_ok=False)
    descriptor=pb.FileDescriptorSet.FromString((prepared/'metadata-ir.pb').read_bytes())
    pool=descriptor_pool.DescriptorPool()
    for file in descriptor.file:pool.Add(file)
    declaration_class=message_factory.GetMessageClass(pool.FindMessageTypeByName('org.jetbrains.kotlin.backend.common.serialization.proto.IrDeclaration'))
    catalog=json.loads((prepared/'generated/catalog.json').read_text());java={r['protoName']:r['javaName'] for r in catalog}
    schemas={}
    def add(msg,parent):
        name=parent+'.'+msg.name;schemas[name]={f.name:f for f in msg.field}
        for nested in msg.nested_type:add(nested,name)
    for file in descriptor.file:
        for msg in file.message_type:add(msg,file.package)
    records=[]
    def case(id,name,data,partial=False,extensions=True,limit=65535,origin=None):
        path=f'{len(records):05d}.bin';(output/path).write_bytes(data)
        records.append(dict(id=id,message=name,javaName=java[name],path=path,bytes=len(data),sha256=hashlib.sha256(data).hexdigest(),partial=partial,extensions=extensions,recursionLimit=limit,origin=origin))
    meta='org.jetbrains.kotlin.metadata.';ir='org.jetbrains.kotlin.backend.common.serialization.proto.'
    n=lambda msg,f:schemas[msg][f].number
    case('presence-absent',meta+'Type',b'')
    case('presence-explicit-default',meta+'Type',integer(n(meta+'Type','nullable'),0))
    case('required-missing',meta+'Annotation',b'')
    case('required-partial',meta+'Annotation',b'',partial=True)
    for value in [0,1,-1,(1<<63)-1,-(1<<63)]:
        case('sint64-'+str(value),meta+'Annotation.Argument.Value',integer(n(meta+'Annotation.Argument.Value','int_value'),(value<<1)^(value>>63)))
        case('fixed64-'+str(value),ir+'CommonIdSignature',field(n(ir+'CommonIdSignature','member_uniq_id'),1,struct.pack('<Q',value&((1<<64)-1))))
    unknown=integer(5000,-1)+field(5001,1,bytes(range(8)))+blob(5002,b'\x00\xff')+field(5003,3,integer(1,42)+field(5003,4,b''))+field(5004,5,bytes(range(4)))
    case('all-unknown-wire-types',meta+'Type',unknown)
    case('unknown-enum',meta+'Type.Argument',integer(n(meta+'Type.Argument','projection'),12345))
    case('unknown-enum-negative',meta+'Type.Argument',integer(n(meta+'Type.Argument','projection'),-1))
    case('packed-and-unpacked',ir+'FileEntry',blob(n(ir+'FileEntry','line_start_offset'),varint(0)+varint(128))+integer(n(ir+'FileEntry','line_start_offset'),400))
    case('oneof-last-wins',ir+'IdSignature',blob(n(ir+'IdSignature','public_sig'),integer(n(ir+'CommonIdSignature','flags'),1))+integer(n(ir+'IdSignature','scoped_local_sig'),99))
    case('oneof-message-merge',ir+'IdSignature',blob(n(ir+'IdSignature','public_sig'),integer(n(ir+'CommonIdSignature','flags'),1))+blob(n(ir+'IdSignature','public_sig'),integer(n(ir+'CommonIdSignature','debug_info'),2)))
    namefield=n(meta+'StringTable','string')
    case('utf8-invalid-preserved',meta+'StringTable',blob(namefield,b'\xff\xc3\x28'))
    valueType=meta+'Annotation.Argument.Value'
    for bits in [0,1<<31,0x7fc12345,0x7f800000]:case('float-bits-'+str(bits),valueType,field(n(valueType,'float_value'),5,struct.pack('<I',bits)))
    for bits in [0,1<<63,0x7ff8123456789abc,0x7ff0000000000000]:case('double-bits-'+str(bits),valueType,field(n(valueType,'double_value'),1,struct.pack('<Q',bits)))
    typeName=meta+'Type';nested=n(typeName,'flexible_upper_bound')
    case('singular-message-merge',typeName,blob(nested,integer(n(typeName,'nullable'),1))+blob(nested,integer(n(typeName,'class_name'),42)))
    case('recursion-limit',typeName,blob(nested,blob(nested,blob(nested,b''))),limit=2)
    case('recursion-within-limit',typeName,blob(nested,blob(nested,blob(nested,b''))),limit=3)
    for id,data in [('truncated-varint',b'\x80'),('zero-tag',b'\x00'),('invalid-wire',field(1,6,b'')),('truncated-length',blob(999,b'ab')[:-1]),('negative-length',field(999,2,varint(-1))),('bad-end-group',field(99,3,field(100,4,b''))),('malformed-varint',b'\x80'*11)]:case(id,typeName,data)
    # Unregistered extensions remain unknown and become typed when registered.
    # type_annotation is a repeated Annotation extension with a required id.
    klib=next(f for d in descriptor.file if d.name.endswith('KlibMetadataProtoBuf.proto') for f in d.extension if f.name=='type_annotation')
    annotation=integer(n(meta+'Annotation','id'),123)
    for extensions in [False,True]:case('extension-registered-'+str(extensions),typeName,blob(klib.number,annotation),extensions=extensions)
    case('extension-required-message',typeName,blob(klib.number,b''))
    case('extension-required-partial-message',typeName,blob(klib.number,b''),partial=True)
    stdlib=Path(args.stdlib);actual=hashlib.sha256(stdlib.read_bytes()).hexdigest()
    if actual!=args.stdlib_sha256:raise ValueError('Stdlib hash differs from explicit pinned input')
    actual_counts={}
    with zipfile.ZipFile(stdlib) as z:
        infos=z.infolist();seen=set();total=0
        for i in infos:
            name=i.filename
            if name in seen or name.startswith('/') or '..' in name.split('/') or '\\' in name or '\0' in name:raise ValueError('Unsafe/duplicate KLIB ZIP path')
            seen.add(name);total+=i.file_size
            if total>128*1024*1024 or i.file_size>64*1024*1024:raise ValueError('KLIB decoded bytes limit exceeded')
        case('klib-header','org.jetbrains.kotlin.library.metadata.Header',z.read('default/linkdata/module'),origin='default/linkdata/module')
        fragments=[i.filename for i in infos if i.filename.startswith('default/linkdata/') and i.filename.endswith('.knm')]
        for i,name in enumerate(fragments):case(f'klib-fragment-{i}',meta+'PackageFragment',z.read(name),origin=name)
        actual_counts['metadataFragments']=len(fragments)
        for root in ['default/ir','default/ir_inlinable_functions']:
            for kind,filename,message in [('files','files.knf','IrFile'),('types','types.knt','IrType'),('signatures','signatures.knt','IdSignature'),('fileEntries','fileEntries.knf','FileEntry')]:
                path=root+'/'+filename;rows=table(z.read(path));count=0
                for row_index,row in enumerate(rows):
                    columns=[row] if kind=='files' else table(row)
                    # Representative every first nonempty row's entries plus all file metadata.
                    if kind!='files' and count>=128:continue
                    for column_index,data in enumerate(columns):
                        if kind!='files' and count>=128:break
                        case(root.replace('/','-')+f'-{kind}-{row_index}-{column_index}',ir+message,data,origin=f'{path}#{row_index}:{column_index}');count+=1
                actual_counts[root+'/'+kind]=count
            declaration_rows=table(z.read(root+'/irDeclarations.knd'))
            body_rows=table(z.read(root+'/bodies.knb'))
            references=[];declaration_count=0
            kinds={('IrFunctionBase','body'):'IrStatement',('IrField','initializer'):'IrExpression',('IrValueParameter','default_value'):'IrExpression',('IrEnumEntry','initializer'):'IrExpression',('IrAnonymousInit','body'):'IrStatement'}
            def visit(message,row):
                for f,value in message.ListFields():
                    kind=kinds.get((message.DESCRIPTOR.name,f.name))
                    if kind:references.append((row,value,kind))
                    if f.message_type:
                        for child in value if f.is_repeated else [value]:visit(child,row)
            for row_index,row in enumerate(declaration_rows):
                if len(row)<4:raise ValueError('Truncated declaration table header')
                count=struct.unpack_from('>i',row)[0]
                if count<0 or count>(len(row)-4)//12:raise ValueError('Invalid declaration count')
                seen_ids=set()
                for i in range(count):
                    id,offset,size=struct.unpack_from('>iii',row,4+i*12)
                    if id<0 or id in seen_ids or offset<4+count*12 or size<0 or size>len(row)-offset:raise ValueError('Invalid declaration coordinates')
                    seen_ids.add(id);data=row[offset:offset+size]
                    value=declaration_class.FromString(data);visit(value,row_index)
                    if declaration_count<128:
                        case(root.replace('/','-')+f'-declaration-{row_index}-{id}',ir+'IrDeclaration',data,origin=f'{root}/irDeclarations.knd#{row_index}:{id}');declaration_count+=1
            seen_refs=set();count=0
            for row,index,message in references:
                if (row,index,message) in seen_refs:continue
                seen_refs.add((row,index,message))
                columns=table(body_rows[row])
                if index<0 or index>=len(columns):raise ValueError('Body reference outside source table')
                data=columns[index]
                case(root.replace('/','-')+f'-body-{row}-{index}-{message}',ir+message,data,origin=f'{root}/bodies.knb#{row}:{index}');count+=1
                if count>=128:break
            actual_counts[root+'/declarations']=declaration_count
            actual_counts[root+'/bodyEntries']=count
    (output/'cases.json').write_text(json.dumps({'schemaVersion':1,'stdlib':{'path':str(stdlib.resolve()),'sha256':actual},'counts':actual_counts,'cases':records},indent=2)+'\n')
    def tsv(reference):
        return '\n'.join('\t'.join([r['id'],r['javaName'] if reference else r['message'],r['path'],str(r['partial']).lower(),str(r['extensions']).lower(),str(r['recursionLimit'])]) for r in records)+'\n'
    (output/'reference.tsv').write_text(tsv(True));(output/'portable.tsv').write_text(tsv(False))
    print(json.dumps({'cases':len(records),'bytes':sum(r['bytes'] for r in records),'counts':actual_counts}))
if __name__=='__main__':main()

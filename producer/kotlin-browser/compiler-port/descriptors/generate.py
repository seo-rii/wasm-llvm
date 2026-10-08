#!/usr/bin/env python3
"""Translate selected JDK Java AST interface contracts, never their implementations."""
import argparse,hashlib,json,re
from pathlib import Path

KEYWORDS=set('as break class continue do else false for fun if in interface is null object package return super this throw true try typealias typeof val var when while by catch constructor delegate dynamic field file finally get import init param property receiver set setparam where actual abstract annotation companion const crossinline data enum expect external final infix inline inner internal lateinit noinline open operator out override private protected public reified sealed suspend tailrec vararg'.split())
PRIMITIVES={'void':'Unit','boolean':'Boolean','byte':'Byte','short':'Short','int':'Int','long':'Long','char':'Char','float':'Float','double':'Double','Object':'Any','String':'String','Void':'Nothing?'}
COLLECTIONS={'java.util.List':'List','java.util.Collection':'Collection','java.util.Set':'Set','java.util.Map':'Map'}
def identifier(s):return '`'+s+'`' if s in KEYWORDS else s

def decap(s):return s if len(s)>1 and s[:2].isupper() else s[:1].lower()+s[1:]

class Generator:
 def __init__(self,units,ancestor_types=()):
  self.units=units;self.types={};self.context={};self.aliases=[];self.ambiguities=[];self.methods=0;self.boundaries=[];self.ancestors={record['name']:record['parents'] for record in ancestor_types}
  for unit in units:
   imports={i['name'].split('.')[-1]:i['name'] for i in unit['imports'] if not i['static'] and not i['name'].endswith('.*')}
   for d in unit['declarations']:self.register(d,unit['package'],imports,unit['package'])
 def register(self,d,parent,imports,package):
  fq=parent+'.'+d['name'];self.types[fq]=d;self.context[fq]={'imports':imports,'package':package}
  for m in d['members']:
   if m['kind'] in ('INTERFACE','ENUM'):self.register(m,fq,imports,package)
 def resolve(self,name,owner,params):
  if name in PRIMITIVES:return PRIMITIVES[name]
  if name in params:return name
  if name.startswith('java.util.'):return COLLECTIONS.get(name,name)
  if name.startswith('org.') or name.startswith('kotlin.'):return name
  prefix=owner
  while '.' in prefix:
   candidate=prefix+'.'+name
   if candidate in self.types:return candidate
   inherited=self.inherited_type(name,prefix,set())
   if inherited:return inherited
   prefix=prefix.rsplit('.',1)[0]
  first,*rest=name.split('.')
  imports=self.context[owner]['imports']
  if first in imports:
   fq=imports[first]+('.'+'.'.join(rest) if rest else '')
   return COLLECTIONS.get(fq,fq)
  return self.context[owner]['package']+'.'+name
 def inherited_type(self,name,owner,seen):
  if owner in seen:return None
  seen.add(owner);d=self.types.get(owner)
  if not d and owner not in self.ancestors:return None
  imports=self.context[owner]['imports'] if d else {};package=owner.rsplit('.',1)[0]
  for raw in d['interfaces'] if d else self.ancestors[owner]:
   base=raw.split('<')[0];first,*rest=base.split('.')
   if base.startswith('org.'):parent=base
   elif first in imports:parent=imports[first]+('.'+'.'.join(rest) if rest else '')
   else:parent=package+'.'+base
   candidate=parent+'.'+name
   if candidate in self.types:return candidate
   inherited=self.inherited_type(name,parent,seen)
   if inherited:return inherited
  return None
 def typ(self,raw,owner,params):
  tokens=re.findall(r'[A-Za-z_$][A-Za-z0-9_$]*|[<>,.?\[\]&]',raw);pos=0
  if ''.join(tokens)!=re.sub(r'\s+','',raw):raise ValueError('Unsupported type syntax: '+raw)
  def parse():
   nonlocal pos
   if pos>=len(tokens):raise ValueError('Missing type: '+raw)
   if tokens[pos]=='?':
    pos+=1
    if pos<len(tokens) and tokens[pos] in ('extends','super'):
     variance='out' if tokens[pos]=='extends' else 'in';pos+=1;return variance+' '+parse()
    return '*'
   base=tokens[pos];pos+=1
   while pos<len(tokens) and tokens[pos]=='.':
    pos+=1;base+='.'+tokens[pos];pos+=1
   result=self.resolve(base,owner,params)
   if pos<len(tokens) and tokens[pos]=='<':
    pos+=1;args=[parse()]
    while pos<len(tokens) and tokens[pos]==',':pos+=1;args.append(parse())
    if pos>=len(tokens) or tokens[pos]!='>':raise ValueError('Unclosed generic: '+raw)
    pos+=1;result+='<'+', '.join(args)+'>'
   while pos<len(tokens) and tokens[pos]=='[':
    if pos+1>=len(tokens) or tokens[pos+1]!=']':raise ValueError('Invalid array type: '+raw)
    pos+=2;result=result+'Array' if result in {'Byte','Short','Int','Long','Float','Double','Char','Boolean'} else 'Array<'+result+'>'
   return result
  result=parse()
  if pos!=len(tokens):raise ValueError('Trailing type input: '+raw)
  return result
 def nullable(self,raw,modifiers,owner,params,label):
  t=self.typ(raw,owner,params)
  annotations=modifiers['annotations'];nullable=any(a.split('(')[0].endswith('Nullable') for a in annotations)
  nonnull=any(a.split('(')[0].endswith('NotNull') for a in annotations)
  if nullable and nonnull:raise ValueError('Conflicting Java nullability')
  if nullable and t not in ('Unit',) and not t.endswith('?'):t+='?'
  if not nullable and not nonnull and raw not in PRIMITIVES and raw not in params:
   self.ambiguities.append({'owner':owner,'member':label,'javaType':raw,'strategy':'non-null common reference for fixed compiler call path; unannotated Java platform contract remains audit-required'})
  if any(k in raw for k in ('List<','Collection<','Set<','Map<')) and not any(a.endswith('ReadOnly') for a in annotations):
   self.ambiguities.append({'owner':owner,'member':label,'javaType':raw,'strategy':'Kotlin read-only collection contract; platform mutability remains audit-required'})
  return t
 def params(self,items,owner,inherited=set()):
  names=set(inherited)|{p['name'] for p in items};decl=[];extra=[]
  for p in items:
   bounds=[self.typ(b,owner,names) for b in p['bounds']]
   if len(bounds)>1:raise ValueError('Intersection bounds require explicit conversion')
   decl.append(p['name']+(': '+bounds[0] if bounds else ''))
  return ('<'+', '.join(decl)+'>' if decl else ''),names
 def inherited_names(self,owner,seen=None):
  seen=set() if seen is None else seen
  if owner in seen:return set()
  seen.add(owner);d=self.types.get(owner)
  if not d:return set()
  names={m['name'] for m in d['members'] if m['kind']=='METHOD'}
  params={p['name'] for p in d['typeParameters']}
  for base in d['interfaces']:
   parent=self.resolve(base.split('<')[0],owner,params)
   names |= self.inherited_names(parent,seen)
  return names
 def declaration(self,d,owner):
  fq=owner+'.'+d['name'];g,params=self.params(d['typeParameters'],fq)
  if d['kind']=='ENUM':return self.enum(d,fq)
  if d['kind']!='INTERFACE':raise ValueError('Implementation accidentally included: '+fq)
  parents=[self.typ(p,fq,params) for p in d['interfaces']]
  parent_methods=set()
  for raw in d['interfaces']:parent_methods|=self.inherited_names(self.resolve(raw.split('<')[0],fq,params))
  lines=['interface '+d['name']+g+(' : '+', '.join(parents) if parents else '')+' {']
  for m in d['members']:
   if m['kind'] in ('INTERFACE','ENUM'):lines += ['    '+line for line in self.declaration(m,fq).splitlines()];continue
   if m['kind']!='METHOD':raise ValueError('Interface field needs explicit source-preserving conversion: '+fq)
   if m['returnType'] is None:raise ValueError('Constructor in interface')
   mg,mparams=self.params(m['typeParameters'],fq,params)
   arguments=[]
   for p in m['parameters']:
    t=self.nullable(p['type'],p['modifiers'],fq,mparams,m['name']+'.'+p['name']);arguments.append(identifier(p['name'])+': '+t)
   result=self.nullable(m['returnType'],m['modifiers'],fq,mparams,m['name']+'.return')
   if fq=='org.jetbrains.kotlin.descriptors.DeclarationDescriptor' and m['name'] in ('accept','acceptVoid'):
    if m['parameters'][0]['name']!='visitor':raise ValueError('Changed declaration visitor contract')
    arguments[0]+='?'
    if m['name']=='accept':result+='?'
    self.boundaries.append({'owner':fq,'method':m['name'],'strategy':'Java platform visitor accepts null; R? permits the pinned ModuleDescriptor nullable-return override'})
   override='override ' if '@Override' in m['modifiers']['annotations'] or m['name'] in parent_methods else ''
   body=''
   if m['body'] is not None:
    if m['body'].strip()!='{\n}' or m['name']!='validate' or result!='Unit':raise ValueError('Nontrivial interface default body needs actual conversion: '+fq+'.'+m['name'])
    body=' {}'
   property_override=fq=='org.jetbrains.kotlin.descriptors.PropertyDescriptor' and m['name'] in ('getGetter','getSetter')
   if property_override:
    if m['parameters'] or mg or not override or body:raise ValueError('Changed inherited accessor property contract')
    prop=decap(m['name'][3:]);lines.append('    override val '+prop+': '+result)
    self.aliases.append('fun '+fq+'.'+m['name']+'(): '+result+' = '+prop)
    self.boundaries.append({'owner':fq,'method':m['name'],'strategy':'Overrides selected Kotlin VariableDescriptorWithAccessors property; Java getter-call spelling is a typed extension'})
   else:lines.append('    '+override+'fun '+(mg+' ' if mg else '')+identifier(m['name'])+'('+', '.join(arguments)+'): '+result+body)
   self.methods+=1
   if not m['parameters'] and not mg:
    property_name=None
    if m['name'].startswith('get') and len(m['name'])>3 and result!='Unit':property_name=decap(m['name'][3:])
    if m['name'].startswith('is') and result=='Boolean':property_name=m['name']
    if property_name and not property_override:
     receiver=fq+('<'+', '.join(p['name'] for p in d['typeParameters'])+'>' if d['typeParameters'] else '')
     self.aliases.append('val '+(g+' ' if g else '')+receiver+'.'+identifier(property_name)+': '+result+' get() = '+identifier(m['name'])+'()')
  return '\n'.join(lines+['}'])
 def enum(self,d,fq):
  lines=['enum class '+d['name']+' {'];variables=[m['declaration'] for m in d['members'] if m['kind']=='VARIABLE'];methods=[m for m in d['members'] if m['kind']=='METHOD']
  for i,v in enumerate(variables):
   if v.get('constructorArguments')!=[]:raise ValueError('Nonempty enum constructor requires actual body conversion')
   lines.append('    '+v['name']+(';' if i==len(variables)-1 else ','))
  for m in methods:
   if m['name']!='isReal' or m['returnType']!='boolean' or m['parameters'] or m['body'].strip()!='{\n    return this != FAKE_OVERRIDE;\n}':raise ValueError('Unsupported enum method body: '+fq)
   lines.append('    fun isReal(): Boolean = this != FAKE_OVERRIDE');self.methods+=1
   self.aliases.append('val '+fq+'.isReal: Boolean get() = isReal()')
  return '\n'.join(lines+['}'])
 def file(self,u):
  lines=['// Generated from the selected original Java AST; do not edit.','package '+u['package'],'']
  for d in u['declarations']:lines.append(self.declaration(d,u['package']))
  return '\n\n'.join(lines)+'\n'

def main():
 p=argparse.ArgumentParser();p.add_argument('--ast',required=True);p.add_argument('--source-lock',required=True);p.add_argument('--output',required=True);args=p.parse_args();ast=Path(args.ast).read_bytes();units=json.loads(ast);lock_bytes=Path(args.source_lock).read_bytes();lock=json.loads(lock_bytes);g=Generator(units,lock['commonAncestorTypes']);root=Path(args.output);root.mkdir(parents=True,exist_ok=False);records=[]
 for u in units:
  name=Path(u['path']).with_suffix('.kt').name;source=g.file(u).encode();(root/name).write_bytes(source);records.append({'path':name,'bytes':len(source),'sha256':hashlib.sha256(source).hexdigest(),'originalPath':u['path']})
 source=('// Java getter syntax aliases for common compiler callers.\npackage org.jetbrains.kotlin.portable.descriptors\n\n'+'\n'.join(g.aliases)+'\n').encode();name='DescriptorProperties.kt';(root/name).write_bytes(source);records.append({'path':name,'bytes':len(source),'sha256':hashlib.sha256(source).hexdigest(),'originalPath':None})
 summary={'schemaVersion':1,'kind':'official-descriptor-common-contracts','astSha256':hashlib.sha256(ast).hexdigest(),'sourceLockSha256':hashlib.sha256(lock_bytes).hexdigest(),'javaUnits':len(units),'interfaces':sum(d['kind']=='INTERFACE' for d in g.types.values()),'enums':sum(d['kind']=='ENUM' for d in g.types.values()),'methods':g.methods,'aliases':len(g.aliases),'files':records,'auditRequired':g.ambiguities,'commonContractBoundaries':g.boundaries,'concreteImplementationsPorted':False,'languageReadiness':False}
 (root/'generation.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps({k:summary[k] for k in ('javaUnits','interfaces','enums','methods','aliases')}))
if __name__=='__main__':main()

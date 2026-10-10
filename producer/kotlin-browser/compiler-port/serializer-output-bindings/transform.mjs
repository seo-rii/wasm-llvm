import assert from 'node:assert/strict';

export function applyExact(source, rows) {
 let text=source.toString();
 const changes=[...rows].sort((a,b)=>b.start-a.start);
 let boundary=text.length;
 for(const row of changes){
  assert(row.start+row.before.length<=boundary,'Overlapping transport spans');
  assert.equal(text.slice(row.start,row.start+row.before.length),row.before,'Changed transport span');
  assert.equal(text.slice(0,row.start).split('\n').length,row.line);
  text=text.slice(0,row.start)+row.after+text.slice(row.start+row.before.length);boundary=row.start;
 }
 return Buffer.from(text);
}

export function normalizeRecordedImports(bytes,imports){
 let text=bytes.toString();
 const block='\n'+imports.map(name=>'import '+name).join('\n')+'\n';
 const markers=['\nimport kotlin.jvm.*\n','\nimport org.jetbrains.kotlin.portable.assertions.compilerAssert as assert\n',block],seen=new Set();
 for(let step=0;step<markers.length;step++){
  const p=/^package[^\r\n]+/m.exec(text);assert(p);
  const end=p.index+p[0].length;
  const marker=markers.find(value=>text.startsWith(value,end));if(!marker)break;
  assert(!seen.has(marker),'Duplicated recorded host import block');seen.add(marker);
  text=text.slice(0,end)+text.slice(end+marker.length);
 }
 return Buffer.from(text);
}

export const HIERARCHY_PATTERN=/\b(?:IrICProgramFragments|JsIrProgramFragments|serializeTo|loadIrFragments)\b|\.\s*serialize\s*(?:\(|<)|::\s*serialize\b/;

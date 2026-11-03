import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectAliasObject, verifyAliasDefinitions } from './symbol-alias-inspect.mjs';

const leb = value => { const bytes = []; do { let byte = value & 127; value >>>= 7; if (value) byte |= 128; bytes.push(byte); } while (value); return bytes; };
const string = value => [...leb(Buffer.byteLength(value)), ...Buffer.from(value)];
const section = (id, payload) => [id, ...leb(payload.length), ...payload];
const custom = (name, payload) => section(0, [...string(name), ...payload]);
const symbol = (name, entity = 0, flags = 0) => [0, ...leb(flags), ...leb(entity), ...string(name)];
function object({ aliasIndex = 0, aliasName = 'alias', relocationIndex = 1, relocationOffset = 4, symbolBytes } = {}) {
  const symbols = symbolBytes || [2, ...symbol('target'), ...symbol(aliasName, aliasIndex)];
  return Uint8Array.from([0,97,115,109,1,0,0,0,
    ...section(1,[1,0x60,0,0]), ...section(3,[1,0]), ...section(10,[1,4,0,0x10,0,0x0b]),
    ...custom('linking',[2,8,...leb(symbols.length),...symbols]),
    ...custom('reloc.CODE',[2,1,0,...leb(relocationOffset),...leb(relocationIndex)])]);
}
const fixture = { aliasGroups: [{ kind:'function', names:['target','alias'] }], visibility: {}, localSymbols: [] };

test('alias relocation selects a distinct linking symbol for the same function', () => {
  const parsed = inspectAliasObject(object());
  assert.equal(verifyAliasDefinitions(parsed, fixture), true);
  assert.equal(parsed.functionDefinitions,1);
  assert.equal(parsed.symbols[0].entityIndex,parsed.symbols[1].entityIndex);
  assert.equal(parsed.relocations[0].index,1);
  assert.equal(parsed.relocations[0].symbol,'alias');
});
test('separate function bodies and separate data storage cannot satisfy alias identity', () => {
  const parsed=inspectAliasObject(object()); parsed.symbols[1].entityIndex=1;
  assert.throws(()=>verifyAliasDefinitions(parsed,fixture),/separate body or storage/);
  const data={symbols:[{name:'target',kind:'data',binding:'global',segment:0,offset:0,size:4},{name:'alias',kind:'data',binding:'global',segment:0,offset:4,size:4}]};
  assert.throws(()=>verifyAliasDefinitions(data,{aliasGroups:[{kind:'data',names:['target','alias'],size:4}]}),/separate body or storage/);
  data.symbols[1].offset=0;
  assert.equal(verifyAliasDefinitions(data,{aliasGroups:[{kind:'data',names:['target','alias'],size:4}]}),true);
});
test('missing, duplicate, undefined and weak aliases are rejected', () => {
  assert.throws(()=>verifyAliasDefinitions(inspectAliasObject(object({aliasName:'different'})),fixture),/Missing alias/);
  assert.throws(()=>verifyAliasDefinitions(inspectAliasObject(object({aliasName:'target'})),fixture),/Duplicate linking/);
  for(const [field,value,pattern]of[['undefined',true,/Undefined alias/],['binding','weak',/must not become weak/]]){
    const parsed=inspectAliasObject(object());parsed.symbols[1][field]=value;
    assert.throws(()=>verifyAliasDefinitions(parsed,fixture),pattern);
  }
});
test('alias visibility and local binding are checked independently', () => {
  const parsed=inspectAliasObject(object());
  assert.throws(()=>verifyAliasDefinitions(parsed,{...fixture,visibility:{alias:'hidden'}}),/visibility/);
  assert.throws(()=>verifyAliasDefinitions(parsed,{...fixture,localSymbols:['alias']}),/local binding/);
});
test('out-of-range function, relocation symbol and section offset are rejected', () => {
  assert.throws(()=>inspectAliasObject(object({aliasIndex:1})),/Function symbol index/);
  assert.throws(()=>inspectAliasObject(object({relocationIndex:2})),/relocation symbol index/);
  assert.throws(()=>inspectAliasObject(object({relocationOffset:6})),/outside target section/);
});
test('malformed custom symbol metadata is rejected even when the Wasm engine accepts it', () => {
  const bytes=object({symbolBytes:[2,...symbol('target'),0,0,0,10,97]});
  assert.doesNotThrow(()=>new WebAssembly.Module(bytes));
  assert.throws(()=>inspectAliasObject(bytes),/Truncated symbol name/);
});

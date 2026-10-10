import {writeFile} from 'node:fs/promises';
import path from 'node:path';import {fileURLToPath} from 'node:url';
import {gitBlob,readRegular,sha256} from '../../../scripts/source.mjs';
import {DESERIALIZER,INTEGER_IMPORT} from '../integer/prepare.mjs';
import {transformLengthBoundary} from '../integer-bounds/transform.mjs';
import {bindDeserializer,selectedMethods,commentAddExpression} from './transform.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../../..');
async function pin(name){const bytes=await readRegular(path.join(HERE,name));return {path:name,bytes:bytes.length,sha256:sha256(bytes),gitBlob:gitBlob(bytes)};}
const closureBytes=await readRegular(path.join(HERE,'../../closure.lock.json')),closure=JSON.parse(closureBytes);
const bound=JSON.parse(await readRegular(path.join(HERE,'../integer-bounds/sources.lock.json')));
const original=await readRegular(path.join(REPO,'out/kotlin-compiler-port/sources',DESERIALIZER));
const predecessor=transformLengthBoundary(Buffer.from(original.toString().replace('import java.math.BigInteger',INTEGER_IMPORT)),bound.originalReadBytes),output=bindDeserializer(predecessor);
const utils='compiler/ir/backend.js/src/org/jetbrains/kotlin/ir/backend/js/transformers/irToJs/jsAstUtils.kt',utilsBytes=await readRegular(path.join(REPO,'out/kotlin-compiler-port/sources',utils));
const input=JSON.parse(await readRegular(path.join(HERE,'../input-codec/sources.lock.json')));
const stdlib=JSON.parse(await readRegular(path.join(HERE,'../../../stdlib-probe/recipe.json')));
const factorySource=stdlib.files.find(p=>p.path==='libraries/stdlib/common/src/generated/_Arrays.kt');
const wholeRoot=path.join(REPO,'out/kotlin-compiler-port/builds/common-boundaries-whole-1791635510943341799');
const wholeBytes=await readRegular(path.join(wholeRoot,'compiler-build-receipt.json')),whole=JSON.parse(wholeBytes),argsBytes=await readRegular(path.join(wholeRoot,'compiler-klib.args'));
const args=argsBytes.toString().split('\n').filter(Boolean).map(line=>line.startsWith('"')?JSON.parse(line):line),selectedFiles=args.filter(x=>!x.startsWith('-')&&x.endsWith('.kt'));
const commentConsumerBodies=[];
for(const item of whole.compileSources) { const matches=selectedFiles.filter(filename=>filename.endsWith('/'+item.path));if(matches.length!==1)throw Error(item.path);const bytes=await readRegular(matches[0]);if(bytes.length!==item.bytes||sha256(bytes)!==item.sha256)throw Error('Changed recorded source '+item.path);const text=bytes.toString().replace(/^import[^\n]*\n/gm,'');
 if(!/comments(?:Before|After)Node|[gs]etComments(?:Before|After)Node/.test(text))continue;commentConsumerBodies.push({path:item.path.endsWith('/'+DESERIALIZER)?DESERIALIZER:item.path,bodySha256:sha256(Buffer.from(text.split('\n').filter(line=>line.trim()).join('\n')))});}
commentConsumerBodies.sort((a,b)=>a.path.localeCompare(b.path));
const ast=JSON.parse(await readRegular(path.join(HERE,'../../js-ast/sources.lock.json')));
const lock={schemaVersion:1,kind:'pinned-selected-js-ast-deserializer-consumer',source:closure.source,primaryClosureSha256:sha256(closureBytes),
    selectedCommentInventorySource:{sourceCount:selectedFiles.length,receiptSha256:sha256(wholeBytes),argsSha256:sha256(argsBytes)},commentConsumerBodies,
    sources:[DESERIALIZER,utils].map(name=>closure.files.find(p=>p.path===name)),
    comments:await pin('JsAstComments.kt'),arrayFactory:await pin('upstream/_Arrays.kt'),arrayFactorySource:factorySource,
    inputDependency:{component:'jsAstInputReceipt',path:'compiler-port-js-ast-input/org/jetbrains/kotlin/js/portable/JsAstInput.kt',bytes:input.implementation.bytes,sha256:input.implementation.sha256},
    predecessorOutput:{bytes:predecessor.length,sha256:sha256(predecessor),gitBlob:gitBlob(predecessor)},output:{bytes:output.length,sha256:sha256(output),gitBlob:gitBlob(output)},
    methodProjections:{original:Object.fromEntries(Object.entries(selectedMethods(predecessor)).map(([key,text])=>[key,sha256(Buffer.from(text))])),common:Object.fromEntries(Object.entries(selectedMethods(output)).map(([key,text])=>[key,sha256(Buffer.from(text))])),commentAddSha256:sha256(Buffer.from(commentAddExpression(utilsBytes)))},
    astSourceLockSha256:sha256(await readRegular(path.join(HERE,'../../js-ast/sources.lock.json'))),
    dependencies:await Promise.all(['../integer-bounds/sources.lock.json','../integer-bounds/prepare.mjs','../integer-bounds/transform.mjs','../input-codec/sources.lock.json','../input-codec/prepare.mjs','../input-codec/JsAstInput.kt','../../js-ast/sources.lock.json','../../js-ast/prepare.mjs','../../js-ast/verify.mjs','../../js-ast/evidence/receipt.json','../../../stdlib-probe/recipe.json'].map(pin)),
    tools:await Promise.all(['prepare.mjs','transform.mjs','check.mjs','integrity.test.mjs','update-recipe.mjs'].map(pin)),
    observers:await Promise.all(['Probe.kt','OriginalSupport.kt','CommonSupport.kt','JvmEntry.kt','WasmEntry.kt'].map(pin)),
    globalEmptyListIdentityPreserved:false,fullCompilerBuilt:false,languageReadiness:false};
if(lock.arrayFactory.bytes!==factorySource.bytes||lock.arrayFactory.sha256!==factorySource.sha256||lock.arrayFactory.gitBlob!==factorySource.gitBlob)throw Error('Mismatched pinned Array.toList source');
await writeFile(path.join(HERE,'sources.lock.json'),JSON.stringify(lock,null,2)+'\n');

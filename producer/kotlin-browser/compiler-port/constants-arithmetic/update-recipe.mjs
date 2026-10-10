import {writeFile} from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {gitBlob,readRegular,sha256} from '../../scripts/source.mjs';import {bindOperations,checkerBody,OPERATIONS,ENUM} from './extract.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../..');
async function pin(name){const bytes=await readRegular(path.join(HERE,name));return {path:name,bytes:bytes.length,sha256:sha256(bytes),gitBlob:gitBlob(bytes)};}
const closureBytes=await readRegular(path.join(HERE,'../closure.lock.json')),closure=JSON.parse(closureBytes),original=await readRegular(path.join(REPO,'out/kotlin-compiler-port/sources',OPERATIONS)),output=bindOperations(original);
const ast=JSON.parse(await readRegular(path.join(HERE,'../js-ast/sources.lock.json'))),astPin=ast.portable.find(p=>p.path.endsWith('/AstInteger.kt')),enumPin=closure.files.find(p=>p.path===ENUM);
const lock={schemaVersion:1,kind:'pinned-generated-constants-arithmetic',source:closure.source,primaryClosureSha256:sha256(closureBytes),sources:[closure.files.find(p=>p.path===OPERATIONS),enumPin],
    implementation:await pin('CompilerInteger.kt'),astIntegerSource:astPin,sharedDependencies:[{component:'jsAstReceipt',path:astPin.outputPath,bytes:astPin.bytes,sha256:astPin.sha256,gitBlob:astPin.gitBlob},{component:'retainedOriginal',...enumPin}],
    dependencies:await Promise.all(['../js-ast/sources.lock.json','../js-ast/portable/org/jetbrains/kotlin/js/util/AstInteger.kt','../js-ast/evidence/receipt.json','../js-ast/verify.mjs','../js-ast-consumer-bindings/integer/evidence/receipt.json'].map(pin)),
    output:{bytes:output.length,sha256:sha256(output),gitBlob:gitBlob(output)},checkerSha256:sha256(Buffer.from(checkerBody(original))),operations:['add','subtract','multiply','divide','rem','and','or','xor'],
    tools:await Promise.all(['prepare.mjs','extract.mjs','check.mjs','integrity.test.mjs','update-recipe.mjs'].map(pin)),observers:await Promise.all(['Probe.kt','OriginalSupport.kt','CommonSupport.kt','JvmEntry.kt','WasmEntry.kt'].map(pin)),
    cachedJdkObjectIdentityClaimed:false,fullCompilerBuilt:false,languageReadiness:false};
await writeFile(path.join(HERE,'sources.lock.json'),JSON.stringify(lock,null,2)+'\n');

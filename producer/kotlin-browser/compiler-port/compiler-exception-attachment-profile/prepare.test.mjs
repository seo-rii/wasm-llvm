import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {actualSelection} from '../fir-syntax-lighttree-profile/fixture.mjs';
import {normalizeImports} from '../klib-signature-index/transform.mjs';
import {ENTRY,TARGETS,PSI,references,transform,transformAssembled,exceptionChanges} from './transform.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../..');
test('conservative PSI attachment closure includes legal escaping, aliases, interpolation and joined literals',()=>{
 for(const text of ['import org.jetbrains.kotlin.utils.withPsiEntry as attach','`withPsiEntry`(node)','"${withPsiEntry(node)}"','"with" + "PsiEntry"','\\u0077ithPsiEntry(node)','PsiUtilsKt.getElementTextWithContext(node)'])assert(references(text,PSI).length>0,text);
});
test('all five upstream algorithms and request entry reverse exactly and imports retain their newline',async()=>{
 for(const logical of TARGETS){const bytes=await readFile(logical===ENTRY?path.join(HERE,'../entry/BrowserCompilerPipeline.kt'):path.join(REPO,'out/kotlin-compiler-port/sources',logical)),changes=exceptionChanges(logical,bytes),output=transform(bytes,changes);assert.deepEqual(transform(output,changes,true),bytes);assert(!/\*\/import\s/.test(output.toString()),logical);for(const row of changes.filter(r=>r.before.startsWith('import ')&&r.before.endsWith('\n')))assert(row.after.endsWith('\n'),row.reason);}
});
test('all six real assembled sources retain the exact approved package import prefix and reverse fully',async()=>{
 const current=await actualSelection(process.env.KOTLIN_PROFILE_BASE_BUILD??path.join(REPO,'out/kotlin-compiler-port/builds/overriding-semantic-alias-whole-1791799796857706594')),lock=JSON.parse(await readFile(path.join(HERE,'sources.lock.json')));
 for(const logical of TARGETS){const before=await readFile(current.retainedSources.find(r=>r.path===logical).filename),changes=exceptionChanges(logical,normalizeImports(before,lock.recordedPropertyImports)),after=transformAssembled(before,changes,lock.recordedPropertyImports);
  assert.deepEqual(normalizeImports(after,lock.recordedPropertyImports),transform(normalizeImports(before,lock.recordedPropertyImports),changes));assert.deepEqual(transformAssembled(after,changes,lock.recordedPropertyImports,true),before);}
});

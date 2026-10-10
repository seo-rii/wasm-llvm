import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sha256,gitBlob} from '../../scripts/source.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url));
async function pin(name){const bytes=await readFile(path.resolve(HERE,name));return {path:name,bytes:bytes.length,sha256:sha256(bytes),gitBlob:gitBlob(bytes)};}
const previous=JSON.parse(await readFile(path.join(HERE,'../serializer-comment-type-names/sources.lock.json'))),references=JSON.parse(await readFile(path.join(HERE,'../source-map-path-consumer/sources.lock.json'))).references.filter(pin=>['Utils.kt','FilePathComponents.kt','File.java','UnixFileSystem.java'].includes(path.basename(pin.path)));
const helper={...await pin('ModuleRequirePaths.kt'),outputPath:'compiler-port-module-relative-paths/org/jetbrains/kotlin/js/portable/modules/ModuleRequirePaths.kt'};
const lock={schemaVersion:1,kind:'genuine-posix-module-relative-require-path',source:previous.source,
    inventory:await pin('inventory.json'),helper,references,licenses:await Promise.all(['LICENSE.Kotlin','LICENSE.OpenJDK'].map(pin)),
    tools:await Promise.all(['prepare.mjs','transform.mjs','references.mjs','fixture.mjs','project.mjs','probe.mjs','update-recipe.mjs'].map(pin)),
    observers:await Promise.all(['Probe.kt','ModuleProbe.kt'].map(pin)),
    dependencies:await Promise.all(['../serializer-comment-type-names/sources.lock.json','../serializer-comment-type-names/inventory.json','../serializer-comment-type-names/prepare.mjs','../serializer-output-bindings/transform.mjs'].map(pin)),
    sourceSetExclusions:previous.sourceSetExclusions,recordedPropertyImports:previous.recordedPropertyImports,
    hostProfile:'POSIX single-string File lexical normalization and Kotlin normalized-component toRelativeString; no cwd or filesystem access.',
    windowsHostParity:false,fullModuleGraphWasmExecuted:false,fullCompilerBuilt:false,languageReadiness:false};
await writeFile(path.join(HERE,'sources.lock.json'),JSON.stringify(lock,null,2)+'\n');
console.log(JSON.stringify({references:references.length,sourceSpans:2,helpers:1,predecessors:1}));

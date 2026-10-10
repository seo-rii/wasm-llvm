import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readRegular,writeJson} from '../../scripts/source.mjs';
import {verifyBootstrap} from '../../build/bootstrap.mjs';
import {createSerializerOutputFixture} from './fixture.mjs';
import {prepareSerializerOutputBindings,verifySerializerOutputBindings,verifySerializerOutputSelection} from './prepare.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../..'),execute=promisify(execFile);
const root=path.resolve(process.argv[2]),options=await createSerializerOutputFixture(root);
const component=await prepareSerializerOutputBindings(options);await verifySerializerOutputBindings(options);
const selected=options.retainedSources.map(pin=>{const output=component.receipt.files.find(x=>x.path===pin.path);return output?{...pin,filename:path.join(component.outputRoot,pin.path),bytes:output.bytes,sha256:output.sha256}:pin;});
await verifySerializerOutputSelection({sourceRoot:options.sourceRoot,outputRoot:component.outputRoot,retainedSources:selected});
await writeJson(path.join(root,'fixture.json'),{options,component,selected});
const bootstrap=await verifyBootstrap(),flags=JSON.parse(await readRegular(path.join(HERE,'../build-flags.json'))),ast=JSON.parse(await readRegular(path.join(HERE,'../js-ast/evidence/receipt.json')));
const cp=ast.commands.find(x=>x.phase==='portable-common-jvm-observe').command[3]+path.delimiter+bootstrap.classPath;
const constants=path.join(options.sourceRoot,'compiler/ir/backend.js/src/org/jetbrains/kotlin/ir/backend/js/utils/serialization/Constants.kt');
const sources=[...component.commonSources,...options.preparedOutputCodec.commonSources,...options.preparedOutputStream.commonSources,...options.preparedText.commonSources.filter(x=>/CompilerUtf8(?:Algorithm|Api)\.kt$/.test(x)),constants];
const args=['-Xmx768m','-cp',bootstrap.classPath,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-language-version',flags.languageVersion,'-api-version',flags.apiVersion,'-jvm-target','17',...flags.compilerFlags,'-classpath',cp,'-d',path.join(root,'common.jar'),...sources];
try{const result=await execute('java',args,{cwd:REPO,timeout:900000,maxBuffer:12*1024*1024});process.stderr.write(result.stderr);console.log(JSON.stringify({commonFullSerializerAndFragmentsCompiled:true,fullSerializerWasmExecuted:false}));}
catch(error){process.stderr.write(String(error.stderr??'').slice(-18000));throw new Error(JSON.stringify({code:error.code,signal:error.signal,killed:error.killed}));}

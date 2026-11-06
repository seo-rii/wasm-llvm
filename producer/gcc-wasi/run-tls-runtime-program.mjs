import fs from 'node:fs/promises';
import { WASI } from 'node:wasi';
import { runTlsSharedProgram } from './run-tls-shared.mjs';

const spec=JSON.parse(await fs.readFile(process.argv[2]));
const bytes=await fs.readFile(spec.program);
let result;
if(spec.shared) {
  const actual=await runTlsSharedProgram(bytes,{...spec.shared,...spec.run,cleanup:'__wasm_call_thread_dtors',allowSchedYield:true});
  await fs.writeFile(spec.memory,actual.memory);
  const {memory,...metadata}=actual;result=metadata;
}else{
  const input=await fs.open(spec.stdin,'r'),stdout=await fs.open(spec.stdout,'wx'),stderr=await fs.open(spec.stderr,'wx');
  try{
    const wasi=new WASI({version:'preview1',args:['program',...(spec.run?.args??[])],env:{},preopens:{},
      stdin:input.fd,stdout:stdout.fd,stderr:stderr.fd,returnOnExit:true});
    const instance=await WebAssembly.instantiate(await WebAssembly.compile(bytes),{wasi_snapshot_preview1:wasi.wasiImport});
    try{result={exitCode:wasi.start(instance),trap:false};}
    catch(error){
      if(!(error instanceof WebAssembly.RuntimeError)||error.message!=='unreachable')throw error;
      result={exitCode:null,trap:true,exception:{name:error.name,message:error.message}};
    }
  }finally{await input.close();await stdout.close();await stderr.close();}
  result.stdout=await fs.readFile(spec.stdout,'utf8');result.stderr=await fs.readFile(spec.stderr,'utf8');
}
await fs.writeFile(spec.result,JSON.stringify(result,null,2)+'\n');

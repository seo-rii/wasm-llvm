import { createHash } from 'node:crypto';
import { parseArguments } from './shared.mjs';
import { verifyWamrBrowser } from './verify.mjs';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
const options = parseArguments(process.argv.slice(2));
if (!options.artifacts || !options.receipt) throw new Error('Usage: smoke-transport.mjs --artifacts DIR --receipt FILE');
const root = path.resolve(options.artifacts);
const producerReceipt = await verifyWamrBrowser({ artifacts: root });
const guest = [0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,2,1,0,7,8,1,4,109,97,105,110,0,0,10,6,1,4,0,65,0,11];
await WebAssembly.compile(new Uint8Array(guest));
const workerSource = `import createModule from '/wamr-debug.js';
onmessage = async ({data}) => {
 try {
  const module = await createModule({noInitialRun:true, locateFile:p=>p.endsWith('.wasm')?'/wamr-debug.wasm':'/'+p,
   mainScriptUrlOrBlob: new URL('/wamr-debug.worker.mjs', location.href).href,
   wasmIdleDebugTransport:{protocol:'shared-ring-v1',rspInput:data.input,rspOutput:data.output},
   print:text=>postMessage({stdout:text}),printErr:text=>postMessage({stderr:text})});
  module.FS.writeFile('/main.wasm',new Uint8Array(${JSON.stringify(guest)}));
  postMessage({ready:true});
  try { module.callMain(['-g=127.0.0.1:1234','/main.wasm']); } catch(error) {
   if(error.name!=='ExitStatus') throw error;
  }
 } catch(error) {postMessage({error:String(error),stack:error.stack});}
};`;
const server = createServer(async (request,response)=>{
 response.setHeader('Cross-Origin-Opener-Policy','same-origin');
 response.setHeader('Cross-Origin-Embedder-Policy','require-corp');
 try {
  const pathname = new URL(request.url,'http://localhost').pathname;
  if(pathname==='/') {response.setHeader('Content-Type','text/html');response.end('<!doctype html><title>WAMR smoke</title>');}
  else if(pathname==='/worker.mjs') {response.setHeader('Content-Type','text/javascript');response.end(workerSource);}
  else if(['/wamr-debug.js','/wamr-debug.worker.mjs','/wamr-debug.wasm'].includes(pathname)) {
   response.setHeader('Content-Type',pathname.endsWith('.wasm')?'application/wasm':'text/javascript');response.end(await readFile(path.join(root,pathname.slice(1))));
  } else {response.statusCode=404;response.end();}
 }catch(error){response.statusCode=500;response.end(String(error));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
 browser=await chromium.launch({headless:true});
 const page=await browser.newPage();
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 const result=await page.evaluate(async()=>{
  if(!crossOriginIsolated)throw new Error('Expected cross-origin isolation');
  function descriptor(){const control=new SharedArrayBuffer(28),data=new SharedArrayBuffer(4096);const view=new Int32Array(control);Atomics.store(view,4,4096);Atomics.store(view,6,1);return {control,data,generation:1};}
  const input=descriptor(),output=descriptor();
  const worker=new Worker('/worker.mjs',{type:'module'});const events=[];
  try {
   await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Module startup timeout')),45000);
    worker.onerror=e=>{clearTimeout(timer);reject(new Error(e.message));};
    worker.onmessage=({data})=>{events.push(data);if(data.error){clearTimeout(timer);reject(new Error(data.error));}if(data.ready){clearTimeout(timer);resolve();}};
    worker.postMessage({input,output});
   });
   const bytes=new TextEncoder().encode('$qSupported#37');new Uint8Array(input.data).set(bytes);
   const inputHeader=new Int32Array(input.control);Atomics.store(inputHeader,1,bytes.length);Atomics.add(inputHeader,3,1);Atomics.notify(inputHeader,3);
   let text='';const header=new Int32Array(output.control);const data=new Uint8Array(output.data);
   const deadline=Date.now()+15000;
   while(Date.now()<deadline){
    const read=Atomics.load(header,0)>>>0,write=Atomics.load(header,1)>>>0,count=(write-read)>>>0;
    for(let i=0;i<count;i++)text+=String.fromCharCode(data[(read+i)&4095]);
    if(count){Atomics.store(header,0,write);Atomics.add(header,3,1);Atomics.notify(header,3);}
    if(text.includes('+$qXfer:libraries:read+;PacketSize=1000;#65'))return {passed:true,crossOriginIsolated,text,events};
    if(events.some(e=>e.error))throw new Error(JSON.stringify(events));
    await new Promise(resolve=>setTimeout(resolve,20));
   }
   throw new Error('RSP response timeout: '+JSON.stringify({text,events}));
  }finally{worker.terminate();}
 });
 await writeFile(options.receipt, JSON.stringify({ schemaVersion: 1, kind: 'wamr-transport-smoke',
  browser: await browser.version(), node: process.version,
  producerReceiptSha256: createHash('sha256').update(await readFile(path.join(root, 'producer-receipt.json'))).digest('hex'),
  assets: producerReceipt.assets, cases: ['module-factory', 'pthread-bootstrap', 'shared-ring-qSupported'],
  ...result }, null, 2) + '\n');
 console.log(JSON.stringify(result));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegular, sha256 } from '../../scripts/source.mjs';
export const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../..');
export const BUILD=path.join(REPO,'out/kotlin-compiler-port/builds/memory-host-whole-1791700702126849235');
export async function actualSelection(buildRoot=BUILD){
    const receiptFile=path.join(buildRoot,'compiler-build-receipt.json'),bytes=await readRegular(receiptFile,64*1024*1024),receipt=JSON.parse(bytes);
    assert.equal(receipt.status,'failed');assert.equal(receipt.source.commit,'4d78aae1e337cd40f69baa865aed950fe807a775');
    const argsBytes=await readRegular(path.join(buildRoot,'compiler-klib.args'),16*1024*1024);
    const command=receipt.commands.find(r=>r.phase==='official-compiler-source-to-wasmjs-klib');assert.equal(command.argumentFileSha256,sha256(argsBytes));
    const args=argsBytes.toString().trimEnd().split('\n').map(JSON.parse), filenames=args.slice(-receipt.compileSources.length);
    const retainedSources=receipt.compileSources.map((row,n)=>({...row,filename:filenames[n]}));
    const hostRoot=path.join(buildRoot,'components/sourceHostReceipt');
    return {retainedSources,receipt,preparedHost:{outputRoot:hostRoot,receiptPath:path.join(hostRoot,'compiler-port-host/host-receipt.json'),
        receipt:receipt.sourceHostReceipt,commonSources:receipt.sourceHostReceipt.sources.map(r=>path.join(hostRoot,r.path))},
        evidence:{filename:receiptFile,bytes:bytes.length,sha256:sha256(bytes),argumentFileSha256:sha256(argsBytes),selectedSources:retainedSources.length,compilerExitCode:command.exitCode}};
}

import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertNoSymlink,readRegular,verifyFile} from '../../scripts/source.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../..');
export async function modulePathReferences() {
    const lock=JSON.parse(await readRegular(path.join(HERE,'sources.lock.json'))),root=path.join(REPO,'out/kotlin-module-relative-paths-references');
    await assertNoSymlink(root);await mkdir(root,{recursive:true,mode:0o700});const files=[];
    for(const pin of lock.references) {
        const commit=pin.path.startsWith('src/java.base/')?'openjdk/jdk17u/c35a8d5a87559ad2734f1023bb321176c13c7ba0':'JetBrains/kotlin/4d78aae1e337cd40f69baa865aed950fe807a775';
        assert.equal(pin.url,'https://raw.githubusercontent.com/'+commit+'/'+pin.path);
        const filename=path.join(root,path.basename(pin.path));await assertNoSymlink(filename);let bytes;
        try {bytes=await readRegular(filename,pin.bytes);}catch(error) {
            if(error.code!=='ENOENT')throw error;
            try {bytes=await readRegular(path.join(REPO,'out/kotlin-source-map-path-consumer/references',path.basename(pin.path)),pin.bytes);}catch(cached) {
                if(cached.code!=='ENOENT')throw cached;
                const response=await fetch(pin.url);assert.equal(response.status,200);bytes=Buffer.from(await response.arrayBuffer());
            }
            verifyFile(bytes,pin);await writeFile(filename,bytes,{flag:'wx',mode:0o600});
        }
        verifyFile(bytes,pin);files.push({...pin,filename});
    }
    return {root,files};
}

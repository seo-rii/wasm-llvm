import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoSymlink, readRegular, relativePath, sha256, verifyFile, writeJson } from '../../scripts/source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../../..');

export async function prepareConfigurationSources({ sourceRoot, outputRoot }) {
    sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
    assert(outputRoot.startsWith(path.join(repository, 'out') + path.sep));
    assert(sourceRoot !== outputRoot && !sourceRoot.startsWith(outputRoot + path.sep));
    await assertNoSymlink(sourceRoot); await assertNoSymlink(outputRoot);
    const lockBytes = await readRegular(path.join(here, 'sources.lock.json'));
    const lock = JSON.parse(lockBytes);
    assert.equal(lock.source.commit, '4d78aae1e337cd40f69baa865aed950fe807a775');
    const generated = path.join(outputRoot, 'compiler-port-config');
    await mkdir(generated, { recursive: true });
    const sources = [], commonSources = [];
    for (const pin of lock.sources) {
        const original = verifyFile(await readRegular(path.join(sourceRoot, relativePath(pin.path)), pin.bytes), pin);
        let code = original.toString('utf8');
        assert.equal(code.split('import com.intellij.openapi.util.Key').length, 2);
        code = code.replace('import com.intellij.openapi.util.Key', 'import org.jetbrains.kotlin.portable.config.IdentityKey as Key');
        if (pin.path.endsWith('/CompilerConfiguration.kt')) {
            assert.equal(code.split('import java.util.*').length, 2);
            code = code.replace('import java.util.*', 'import org.jetbrains.kotlin.portable.config.unmodifiableConfigurationValue');
            const start = code.indexOf('    companion object {');
            const end = code.indexOf('\n    @Internals', start);
            assert(start >= 0 && end > start);
            assert.equal(sha256(Buffer.from(code.slice(start, end))), lock.unmodifiableBlockSha256);
            code = code.slice(0, start) + '    companion object {\n        private fun <T> T.unmodifiable(): T = unmodifiableConfigurationValue()\n    }\n' + code.slice(end);
        } else {
            code = code.replace('import org.jetbrains.kotlin.portable.config.IdentityKey as Key',
                'import org.jetbrains.kotlin.portable.config.IdentityKey as Key\nimport kotlin.jvm.JvmStatic');
        }
        const bytes = Buffer.from(code), filename = path.join(generated, path.basename(pin.path));
        await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
        sources.push({ path: relativePath(path.relative(outputRoot, filename)), bytes: bytes.length, sha256: sha256(bytes), original: pin });
        commonSources.push(filename);
    }
    const host = await readRegular(path.join(here, 'ConfigurationHost.kt'));
    const hostFile = path.join(generated, 'ConfigurationHost.kt');
    await writeFile(hostFile, host, { flag: 'wx', mode: 0o600 });
    sources.push({ path: 'compiler-port-config/ConfigurationHost.kt', bytes: host.length, sha256: sha256(host), original: null });
    commonSources.push(hostFile);
    const replacedOriginalPaths = lock.sources.map((pin) => pin.path);
    const receipt = { schemaVersion: 1, kind: 'official-compiler-configuration-memory-host-preparation', source: lock.source,
        sourceLockSha256: sha256(lockBytes), sources, replacedOriginalPaths,
        identityKeys: true, liveReadOnlyViews: true, originalSourcesUnmodified: true, fullBrowserCompiler: false };
    await writeJson(path.join(generated, 'configuration-inputs.json'), receipt);
    return { commonSources, receipt, replacedOriginalPaths };
}

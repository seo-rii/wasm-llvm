import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

/** Compact Git-tree branches prove new source and test paths beneath the already pinned js root. */
export function verifySourceMapTree(lock) {
    const nodes = new Map();
    for (const node of lock.treeProof) {
        assert(!nodes.has(node.path)); assert(node.path === '' || /^[A-Za-z0-9_./-]+$/.test(node.path));
        assert(!node.path.split('/').some(part => part === '.' || part === '..'));
        const entries = [...node.entries].sort((a, b) => {
            const left = a.name + (a.type === 'tree' ? '/' : ''), right = b.name + (b.type === 'tree' ? '/' : '');
            return Buffer.compare(Buffer.from(left), Buffer.from(right));
        });
        assert.deepEqual(node.entries, entries); assert.equal(new Set(entries.map(value => value.name)).size, entries.length);
        const material = Buffer.concat(entries.map(entry => {
            assert(!entry.name.includes('/') && entry.name !== '.' && entry.name !== '..');
            assert(['tree', 'blob'].includes(entry.type)); assert(/^[0-9a-f]{40}$/.test(entry.sha));
            assert(entry.type === 'tree' ? entry.mode === '040000' : ['100644', '100755', '120000'].includes(entry.mode));
            return Buffer.concat([Buffer.from(entry.mode.replace(/^0+/, '') + ' ' + entry.name + '\0'), Buffer.from(entry.sha, 'hex')]);
        }));
        const digest = createHash('sha1').update('tree ' + material.length + '\0').update(material).digest('hex');
        assert.equal(digest, node.sha, 'Changed rooted Git-tree branch'); nodes.set(node.path, node);
    }
    assert.equal(nodes.get('').sha, lock.jsTree.gitTree);
    for (const pin of [...lock.sources, ...lock.tests]) {
        assert(pin.path.startsWith('js/')); const parts = pin.path.slice(3).split('/'); let parent = '';
        for (const [index, name] of parts.entries()) {
            const node = nodes.get(parent); assert(node, 'Missing rooted source branch');
            const entry = node.entries.find(value => value.name === name); assert(entry);
            if (index === parts.length - 1) {
                assert.equal(entry.type, 'blob'); assert(['100644', '100755'].includes(entry.mode));
                assert.equal(pin.gitBlob, entry.sha); assert.equal(pin.bytes, entry.size);
            } else {
                assert.equal(entry.type, 'tree'); const child = parent ? parent + '/' + name : name;
                assert.equal(nodes.get(child)?.sha, entry.sha, 'Disconnected source branch'); parent = child;
            }
        }
    }
    return { root: lock.jsTree.gitTree, branches: nodes.size, paths: lock.sources.length + lock.tests.length };
}

// Emscripten 4 handles "." and ".." before checking the current node type.
// Delegate prefix resolution (including mounts and symlinks) to the original FS.
export function requireDirectoryTraversal(fs) {
	const lookup = fs.lookupPath.bind(fs);
	fs.lookupPath = (path, options) => {
		if (path?.includes('/.')) {
			for (const dot of path.matchAll(/\/\.{1,2}(?=\/|$)/g)) {
				if (!dot.index) continue;
				const prefix = lookup(path.slice(0, dot.index), { follow: true });
				if (!fs.isDir(prefix.node.mode)) throw new fs.ErrnoError(54); // ENOTDIR
			}
		}
		return lookup(path, options);
	};
}

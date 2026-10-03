import fs from 'node:fs/promises';
import path from 'node:path';

// libc++ selects different internal headers in each language mode. The newest
// mode alone does not cover headers used only by older standards either.
export const SYSROOT_CPP_STANDARDS = [
	'gnu++98',
	'gnu++03',
	'gnu++11',
	'gnu++14',
	'gnu++17',
	'gnu++20',
	'gnu++23',
	'gnu++26'
];

export const SYSROOT_C_PROBE = '#include <stdio.h>\nint main(void) { return puts("probe"); }\n';

export const SYSROOT_CPP_PROBE = [
	'#if __cplusplus < 201103L',
	'#include <algorithm>',
	'#include <bitset>',
	'#include <deque>',
	'#include <functional>',
	'#include <iomanip>',
	'#include <iostream>',
	'#include <iterator>',
	'#include <limits>',
	'#include <list>',
	'#include <map>',
	'#include <memory>',
	'#include <numeric>',
	'#include <queue>',
	'#include <set>',
	'#include <sstream>',
	'#include <stack>',
	'#include <string>',
	'#include <utility>',
	'#include <vector>',
	'int main() { std::cout << std::vector<int>().size() << "\\n"; }',
	'#else',
	'#include <bits/stdc++.h>',
	'#include <bits/extc++.h>',
	'#include <ext/rope>',
	'#include <ext/pb_ds/assoc_container.hpp>',
	'#include <ext/pb_ds/tree_policy.hpp>',
	'using namespace std;',
	'using namespace __gnu_cxx;',
	'using namespace __gnu_pbds;',
	'using ordered_set = tree<int, null_type, less<int>, rb_tree_tag, tree_order_statistics_node_update>;',
	'int main() {',
	'  ordered_set values;',
	'  gp_hash_table<int, int> table;',
	'  crope text("abc");',
	'  __gnu_pbds::priority_queue<int> heap;',
	'  cout << values.size() << table.size() << text.size() << heap.size() << "\\n";',
	'}',
	'#endif',
	''
].join('\n');

function dependencyPaths(contents) {
	// -MT below supplies a fixed target. Clang escapes whitespace and '#' in
	// prerequisites, and doubles '$'; do not split escaped paths at spaces.
	const rule = contents.replaceAll(/\\\r?\n/g, ' ');
	if (!rule.startsWith('sysroot-probe:')) throw new Error('Invalid sysroot dependency rule');
	const paths = [];
	let token = '';
	for (let i = 'sysroot-probe:'.length; i < rule.length; i++) {
		const char = rule[i];
		if (char === '\\' && i + 1 < rule.length) {
			token += rule[++i];
		} else if (char === '$' && rule[i + 1] === '$') {
			token += '$';
			i++;
		} else if (/\s/.test(char)) {
			if (token) paths.push(token);
			token = '';
		} else {
			token += char;
		}
	}
	if (token) paths.push(token);
	return paths;
}

export async function pruneSysrootHeaders({
	sysroot,
	resourceIncludeDir,
	probeDir,
	cCompiler,
	cppCompiler,
	cFlags,
	cppFlags,
	cProbe,
	cppProbe,
	run
}) {
	const probes = [
		{ name: 'c', compiler: cCompiler, args: [...cFlags, cProbe] },
		...SYSROOT_CPP_STANDARDS.map((standard) => ({
			name: standard,
			compiler: cppCompiler,
			args: [...cppFlags, `-std=${standard}`, cppProbe]
		}))
	];
	const dependencyFiles = new Set();
	for (const probe of probes) {
		const depsFile = path.join(probeDir, `${probe.name}.d`);
		await run(probe.compiler, [...probe.args, '-E', '-M', '-MF', depsFile, '-MT', 'sysroot-probe']);
		for (const dependency of dependencyPaths(await fs.readFile(depsFile, 'utf8'))) {
			const relative = path.relative(sysroot, path.resolve(dependency));
			if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
			dependencyFiles.add(relative.split(path.sep).join('/'));
		}
	}

	async function prune(directory, isRoot = true) {
		let hasEntries = false;
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			const entryPath = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				if (await prune(entryPath, false)) hasEntries = true;
				continue;
			}
			const relative = path.relative(sysroot, entryPath).split(path.sep).join('/');
			if (!entry.isFile() || dependencyFiles.has(relative)) {
				hasEntries = true;
				continue;
			}
			await fs.rm(entryPath);
		}
		if (!isRoot && !hasEntries) {
			await fs.rmdir(directory);
			return false;
		}
		return true;
	}

	await prune(path.join(sysroot, 'include'));
	await prune(resourceIncludeDir);
	// Fail before packaging if pruning made any supported mode uncompilable.
	for (const probe of probes) {
		await run(probe.compiler, [...probe.args, '-fsyntax-only']);
	}
	return dependencyFiles;
}

// Compile library modules to wasm32 .olean/.ir files with the wasm32 Lean, in dependency order.
// Usage: node build-oleans.mjs <lean.mjs> <workDir> <srcDir> <outDir> <jobs> [prefix...]
// <workDir>/deps.txt lists "Module: Dep Dep ..." lines produced by the native `lean --deps`.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [leanMjs, workDir, srcDir, outDir, jobsArg, ...prefixes] = process.argv.slice(2);
const jobs = Number(jobsArg);
if (!Number.isInteger(jobs) || jobs < 1 || jobs > 3) throw new Error('jobs must be 1, 2, or 3');
const runLean = join(dirname(fileURLToPath(import.meta.url)), 'run-lean.mjs');
const deps = new Map();
for (const line of readFileSync(join(workDir, 'deps.txt'), 'utf8').split('\n')) {
	if (!line.trim()) continue;
	const [name, rest = ''] = line.split(':');
	if (prefixes.length && !prefixes.some((p) => name === p || name.startsWith(`${p}/`))) continue;
	deps.set(name, [...new Set(rest.trim().split(/\s+/).filter(Boolean))]);
}
for (const [name, list] of deps)
	for (const dep of list)
		if (!deps.has(dep)) throw new Error(`${name} needs ${dep} outside the selected modules`);
const built = (name) =>
	existsSync(join(outDir, `${name}.olean`)) && existsSync(join(outDir, `${name}.ir`));
const done = new Set([...deps.keys()].filter(built));
const running = new Set();
let failed = false;
const started = Date.now();

function run(name) {
	running.add(name);
	mkdirSync(dirname(join(outDir, name)), { recursive: true });
	// The upstream stdlib.make options for core libraries, minus warningAsError.
	const args = [
		'--stack-size=4000',
		runLean,
		leanMjs,
		srcDir,
		outDir,
		'--',
		'-j1',
		'-R',
		'/src',
		'-Dinterpreter.prefer_native=false',
		'-Dpp.rawOnError=true',
		'-o',
		`/lean/lib/lean/${name}.olean`,
		`/src/${name}.lean`
	];
	const t0 = Date.now();
	const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
	let log = '';
	child.stdout.on('data', (d) => (log += d));
	child.stderr.on('data', (d) => (log += d));
	child.on('exit', (code) => {
		running.delete(name);
		const secs = ((Date.now() - t0) / 1000).toFixed(1);
		if (code === 0 && built(name)) {
			done.add(name);
			console.log(`ok ${name} ${secs}s [${done.size}/${deps.size}]`);
		} else {
			failed = true;
			writeFileSync(join(workDir, `${name.replaceAll('/', '_')}.olean-fail.log`), log);
			console.log(`FAIL ${name} code=${code} ${secs}s\n${log.slice(-2000)}`);
		}
		pump();
	});
}

function pump() {
	if (failed) {
		if (!running.size) process.exit(1);
		return;
	}
	for (const name of deps.keys()) {
		if (running.size >= jobs) break;
		if (done.has(name) || running.has(name)) continue;
		if (deps.get(name).every((dep) => done.has(dep))) run(name);
	}
	if (!running.size) {
		const complete = done.size === deps.size;
		console.log(complete ? `DONE ${((Date.now() - started) / 60000).toFixed(1)}min` : 'STUCK');
		process.exit(complete ? 0 : 1);
	}
}
pump();

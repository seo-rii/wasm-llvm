// Run the wasm32 Lean module under Node.
// Usage: node run-lean.mjs <lean.mjs> <srcDir> <libDir> -- <lean args...>
// srcDir is mounted at /src (the working directory) and libDir at /lean/lib/lean, the fixed
// virtual toolchain prefix reported by the patched `IO.appPath`. Pass absolute /src paths: the
// Emscripten realpath implementation cannot resolve relative paths inside NODEFS mounts.
import { pathToFileURL } from 'node:url';

const [leanMjs, srcDir, libDir, separator, ...args] = process.argv.slice(2);
if (separator !== '--') {
	console.error('usage: run-lean.mjs <lean.mjs> <srcDir> <libDir> -- <lean args...>');
	process.exit(2);
}
const { default: createLean } = await import(pathToFileURL(leanMjs).href);
let code = 0;
const lean = await createLean({
	noInitialRun: true,
	preRun: [
		(module) => {
			module.FS.mkdir('/src');
			module.FS.mount(module.NODEFS, { root: srcDir }, '/src');
			module.FS.mkdirTree('/lean/bin');
			module.FS.mkdirTree('/lean/lib/lean');
			module.FS.mount(module.NODEFS, { root: libDir }, '/lean/lib/lean');
		}
	],
	print: (line) => process.stdout.write(`${line}\n`),
	printErr: (line) => process.stderr.write(`${line}\n`),
	onExit: (status) => {
		code = status;
	}
});
lean.FS.chdir('/src');
try {
	code = lean.callMain(args);
} catch (error) {
	if (error?.name === 'ExitStatus') code = error.status;
	else {
		console.error(error);
		code = 99;
	}
}
process.exitCode = code;

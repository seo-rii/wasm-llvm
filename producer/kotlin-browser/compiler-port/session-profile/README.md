The selected compiler entry targets Wasm. Its checker registration file also
contains JVM, JS and Native target registrations whose dependencies are outside
the browser console profile. Those declarations still have to type-check before
Wasm DCE, so they cannot simply remain as unused functions.

This source profile separates only those other-target registration shells and
imports. It retains each complete official common, extra-common, experimental,
WasmJs and WasmWasi registration body unchanged, including diagnostic containers.
It does not remove common/target checks or claim that they have executed.

Preparation checks the original source Git blob and both file hashes, the exact
function inventory and every retained body. The compiler build records retained
and excluded function digests. Full FIR/session correctness remains a later
execution gate after the actual compiler source closure builds.

# Descriptor visitor null-only Void profile

This unit maps only the two Java Void generic arguments in 17 acceptVoid
signatures across six pinned Kotlin files to common Nothing?. The selected
visitor calls pass null data, ignore their result, and admit only a null result
in this profile. The generated declaration and complete 15-method visitor
interfaces already express the corresponding contract; neither is edited.

Fourteen originally nullable visitor parameters retain their exact bodies,
including safe calls, null assertions, and real unsupported-operation helpers.
Three originally nonnull visitor parameters become nullable with an immediate
NullPointerException check carrying the original source-owner JVM message.
Their original bodies remain after the check, including ErrorModuleDescriptor's
empty body. Reversing the exact declaration substitutions restores all incoming
files byte for byte, including the preceding generic visitor port.

The exited 3,508-source compiler selection and every selected/primary file hash
were audited. Its specialized descriptor visitor Void occurrences are these
17 declarations. Actual selected acceptVoid callsites use the distinct IR
visitor extensions. Other Java Void uses, ConstantValue<Void?>, memory leak
classification, Java name protocols, and the Wasm IR special Void type are
preserved. This is a selected null-only protocol, not a universal Java Void
class replacement. Reflective construction or nonnull Void values from an
external raw/unchecked visitor are outside the profile.

## Preparation and composition

prepareVisitorVoidProfile({ sourceRoot, outputRoot, preparedDescriptors,
descriptorVisitorComponent, retainedSources }) must run immediately after the
existing descriptor visitor component and before global compiler imports.
It reconstructs the predecessor's precise inputs: the thirteen genuine
visitor-bearing originals are rebound to canonical sourceRoot files, while
all other current files and both canonical generated contracts stay unchanged.
The entire previous preparer, receipt, source inventory and all ten earlier
outputs are replayed. No intermediate input or output is accepted by hash alone.

Exactly three current files are genuine earlier prepared outputs: IR based
descriptors, IR builtins package, and ErrorModuleDescriptor. These have explicit
predecessorBindings to descriptorVisitorReceipt. The three FIR inputs must be
canonical pinned originals. The result has six commonSources directly below
outputRoot at their original logical paths, six replacedOriginalPaths and
three predecessorBindings. Root replaces the previous files once, then applies
normal global host imports. verifyVisitorVoidProfile uses the identical options
and replays source, output, references and all claims. Original Apache 2.0
notices and source provenance remain in all preserved references and outputs.

The lexical incoming guard rejects new Void/null-only visitor specializations,
direct visitor or Void import aliases, direct visitor type aliases, changed
known declarations, duplicate paths and missing inputs. It does not establish
arbitrary type alias expansion, reflective calls or interpolation contents.
Complete selected source typechecking remains necessary.

## Runtime evidence

Probe.kt builds all seventeen real receivers through genuine FIR session/module
APIs and IR constructors/factories. A constructor-only FirSession subclass uses
its real inherited implementation and stubs no methods. The observer implements
the complete real visitor interface and verifies actual descriptor identity,
null data, call counts, ignored null results and visitor exceptions. It covers
null visitors and thirteen raw UTF-16 messages, including unpaired surrogates,
NUL, CRLF, Hangul and emoji. Real unsupported helpers also execute on JVM.

The full original six source files compile against the two original complete
Java interfaces. The six common source files compile against both unchanged
actual generated interfaces, the previously tested genuine ModuleDescriptor
source and the real generated DescriptorProperties getter extensions. Probe
copies add the same property import used by root composition; shipping bodies
are preserved. Both variants agree on 459 raw observations and run on JVM with the pinned
official compiler,
language/API 2.5, target 17, explicit JVM default mode enable and genuine
compiler.jar friend access. Bootstrap helper source commit is unpublished.

The separate common JVM/Node Wasm probe projects fourteen forwarding/empty
bodies. Their safe/bang/direct operators, null data, ignored null return and
checked entry statements remain exact; only each genuine visitor method call
is expressed as standard function invoke. Its receiver is a stdlib Any marker,
its visitor a standard function, and no compiler descriptor/visitor model is
invented. The common JVM/Node Wasm and corresponding original receiver observations
agree on 378 raw records. Three real unsupported helper bodies are not projected. The complete
FIR/descriptor visitor graph, the original Java descriptor implementation family,
portable ModuleImpl, browser execution, whole compiler and public readiness
remain unclosed. This bounded primitive statement proof cannot establish them.

Seven integrity tests cover preparation, unknown consumers, complete predecessor
replay and tampered bodies/messages/references/claims. The final evidence verifier
binds shipping sources, process statuses and all original/common artifacts.

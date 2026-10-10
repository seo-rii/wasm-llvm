# Selected AST byte stream protocol

This is an explicit request-owned byte sink outside Java namespaces. It supports
the two outer AST serialization operations (big-endian integer headers and byte
slices), then flushes and closes once. Action, flush and close exceptions retain
their observed identities and suppression order. Bytes are consumed synchronously;
backing array capacity/identity and synchronization are outside this common host
contract. It executes on one request on one Worker.

The probe projects the complete genuine DataWriter and selected serializer
saveTo method, with explicit prebuilt section/count fixtures outside compiler
namespaces. It compares actual JDK DataOutputStream/use with common JVM/Wasm and
an offline browser Worker, including repeated close and write-after-close.
Byte buffering and UTF-8 use the existing verified common implementations.

Java ThreadDeath precedence, concurrent native threads, host allocation failure,
native file handles, complete serializer execution and browser compiler readiness
remain open. The JDK protocol can be inspected in the original
[FilterOutputStream](https://github.com/openjdk/jdk/blob/jdk-17%2B35/src/java.base/share/classes/java/io/FilterOutputStream.java)
and [DataOutputStream](https://github.com/openjdk/jdk/blob/jdk-17%2B35/src/java.base/share/classes/java/io/DataOutputStream.java).
The common implementation is independently written for this bounded contract.

The sealed profile compares 448 exact records across original JDK, common JVM,
Node Wasm and offline Chromium Worker. All seven commands and six integrity
guards exit 0. Raw backing-array observations are retained separately; their
capacities and identities differ and are not claimed equivalent. Runtime and
local source pins, private logs and final exit statuses are in `evidence/`.

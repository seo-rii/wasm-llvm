# Genuine performance manager and reports

This component ports the complete pinned `PerformanceManager`, `UnitStats`,
`UnitStatsJsonDumper`, `ReportsData`, `StatsCalculator` and
`MarkdownReportRenderer` source files. The latest full compiler attempt reported
errors in this actual selected family. Exact source spans and complete output
hashes bind every transformation; no methods or phases are excluded.

The original phase, dynamic phase, side measurement, exception/finally,
finalization, child aggregation, extended K1 counter, CPU/GC/JIT delta, report
filename and plain/JSON/Markdown algorithms remain present. Private sorted maps
use common maps with sorted reads. The top-module selection still uses a binary
heap, including Java PriorityQueue's comparator tie choices and array iteration
order. Nanosecond conversion retains signed integer division. The JSON builder
uses common `setRange`. UTF-8 report output retains the JVM encoder's `?`
replacement for isolated UTF-16 surrogates.

`TimestampReportsData` consumes a caller-owned `PerformanceReportSortedSet` view.
Its contract requires comparator order, comparator-based uniqueness and live set
iteration. The selected compiler sources contain no constructor call site for
that reporting input. This is a typed input capability; it does not implement a
general Java SortedSet compatibility layer.

## Required host

Install `withPerformanceManagerHost(host)` inside the existing
`withPerformanceCounterClock(clock)` scope for the complete synchronous compiler
request. The manager clock reuses that monotonic nanosecond supplier. Both scopes
restore their previous installation in `finally`. A manager captures its host at
construction. The complete request, including report creation and lazy stats,
must finish before the scopes exit.

`PerformanceManagerHost` requires wall time, worker identity, CPU/user measurement
and enablement, optional JIT measurement, GC providers, path semantics, file
writes, Formatter semantics and date formatter factories. There are no fallback
clocks, CPU zeros, synthetic GC data, discarded writes or placeholder formatting.
A null compilation provider and empty collector list explicitly express absent
facilities. CPU/user unsupported values and provider failures propagate with the
provider's semantics. Filename formatters capture the host's default locale and
timezone; Markdown dates use English and UTC, as in the source.

This is a single synchronous Worker contract. Providers must not suspend or
reenter compilation. It does not provide cross-thread measurements or JVM
management facilities in a browser; the caller must supply its actual
capabilities.

## Preparation and verification

`preparePerformanceManager({ sourceRoot, outputRoot })` emits the six complete
sources and two host/helper files and returns their exact replaced original
paths. `verifyPerformanceManager` replays the pinned preparation.
`verifyFinalPerformanceManager({ sourceRoot, outputRoot, retainedSources,
recordedPropertyImports })` checks every final physical owner, selected size and
hash, and exact original body after only the recorded property, JVM annotation
and assertion import blocks. It rejects duplicate owners, changed bodies,
unrecorded imports and missing family members.

Run the focused proofs with Node 24 and fresh directories under `out/`:

```sh
node producer/kotlin-browser/compiler-port/performance-manager/check.mjs out/NEW-manager-proof
node producer/kotlin-browser/compiler-port/performance-manager/prepare.test.mjs out/NEW-manager-integrity
```

The differential builds and executes all six full files on the original JVM
host-seam reference, common JVM, and Node Wasm. The JVM reference retains Java
sorted maps, PriorityQueue, TimeUnit and StringBuilder replacement; only explicit
host operations are injected. Its four platform dependency files are whole
pinned sources; the unrelated platform utility contributes one exact pinned
`presentableDescription` declaration. PerformanceCounter is the genuine full
source on both sides.

JVM execution records actual Java Formatter and SimpleDateFormat responses.
Common JVM repeats those operations and must produce the same ordered typed
request/response trace. Wasm replays only those formatting/date host responses,
checks each request and checks that all responses were consumed. Measurement,
aggregation, heap, report content, filename and byte algorithms execute in Wasm.
This proves the component against the declared host contract; it does not prove
a browser date/number formatting implementation.

The corpus covers every phase, repeated phases, exceptional dynamic and side
measurements, child/error finalization, absent metric capabilities, sorted GC and
KLIB stats, priority queue ties and bounds, report formats and paths, failing file
writes, signed time bounds, UTF-8 edge cases and scoped host restoration. The
upstream undetailed Markdown table arity failure is preserved and observed.

The evidence does not claim a successful complete compiler build or language
readiness.

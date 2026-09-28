# Performance checks

Compare identical data, dimensions, theme, build mode, and hardware before
claiming an improvement. Keep benchmark results separate from correctness tests.

## Chart hover

Build the dashboard and start its production preview on port 4173, then run:

```bash
make frontend
cd web
npm run preview -- --host 127.0.0.1 --port 4173 --strictPort
# In another terminal, from web/:
LEVIATHAN_PROFILE_TOOLTIPS=1 npm run test:e2e -- tooltip-v041.spec.ts --workers=1
```

The dense fixture uses 13 series, 600 source samples, 0.5-second updates, and
120 pointer moves. The measurement ends at the first animation frame after a
tooltip mutation; it is not a hardware presentation timestamp. The dense case
is opt-in because development instrumentation changes its performance.

The original September 6 worktree report recorded tooltip rectangle reads
falling from 152–153 to 12. Dark-theme p95 changed from 8.7–8.8 ms to 8.5 ms;
light-theme p95 was 9.0 ms with a 127.3 ms tail spike. These historical results
used macOS Darwin 25.6 arm64, Headless Chrome 151, 1280×900, and DPR 1. They do
not establish performance of the current source or eliminate tail latency.

### September 28 production check

The [dense tooltip fixture](../web/e2e/tooltip-v041.spec.ts) ran at 1280×900,
DPR 1, a five-minute chart window, reduced motion, and one worker. Both production
builds used Node 24.20.0, Vite 8.2.2, and React 19.2.8 on an Apple M1 Pro with ten
logical CPUs. The Docker comparison uses baseline `0917e07` and frontend
`6e83f05`, Playwright 1.62.1, Chrome 151.0.7922.34, and the ARM64 image
`mcr.microsoft.com/playwright:v1.62.1-noble` (digest `dcc5531e9784`). Its runtime
is Ubuntu 24.04.4, LinuxKit 7.0.12, Node 24.18.1. The separate native check uses
the same final bundle, fixture, Playwright, and Chrome versions on macOS 26.6.2
(25G83), ARM64, Node 24.20.0.

| Runtime / revision | Theme | Samples | Median | p95 | Maximum | Tooltip rectangle reads |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Docker / before | Dark | 119 | 36.0 ms | 160.2 ms | 226.8 ms | 14 |
| Docker / after | Dark | 120 | 25.9 ms | 188.2 ms | 314.3 ms | 19 |
| Docker / before | Light | 120 | 35.3 ms | 140.5 ms | 166.9 ms | 11 |
| Docker / after | Light | 119 | 30.7 ms | 143.1 ms | 200.8 ms | 11 |
| Native / after | Dark | 120 | 6.4 ms | 10.0 ms | 147.6 ms | 10 |
| Native / after | Light | 120 | 6.3 ms | 10.5 ms | 131.4 ms | 10 |

All runs recorded zero hidden tooltip frames. Both Docker revisions failed the
unchanged p95 < 50 ms budget; both native cases passed, including resize and scroll
checks. These single runs establish no refactor speedup. The native result is a
separate absolute-budget check, not a before/after comparison. The same bundle's
runtime gap suggests an environment contribution, but does not isolate its cause;
other local tasks produced intermittent CPU load. Maximum delays still exceed
130 ms on native macOS. Retained Playwright reports and their JSON attachments
record these summaries; they do not retain individual pointer-latency samples.

## GPU capacity and history

```bash
go test ./internal/kubernetesbridge -run '^$' -bench BenchmarkCapacityEightGPUs -benchmem
go test ./internal/history -run '^$' -bench . -benchmem
```

Capacity evaluation uses an eight-GPU fixture with overlapping MIG placements.
The original worktree reported about 5.45 ms and 3.84 MB allocated per evaluation;
real informer memory and allocator complexity depend on cluster inventory. Re-run
after adapter changes. Fixture results do not establish live scheduler admission.

## History query comparison

The September 28 comparison used Go 1.27.0 on a Mac with an Apple M1 Pro,
Darwin/arm64, and five interleaved before/after repetitions. The fixture has eight
GPUs, three metrics per GPU, and one hour of synthetic one-second input. Raw
queries retain 30 minutes; the aggregate fixture retains twelve hours and queries
four hours of the available data. Aligned responses request at most 300 points.

| Operation | Before median | After median | Allocated bytes before → after |
| --- | --- | --- | --- |
| Raw single-entity query | 411 µs | 259 µs | 720,000 → 592,759 |
| Raw eight-entity aligned query | 7.55 ms | 5.35 ms | 7,526,669 → 2,019,388 |
| Aggregate aligned query | 526 µs | 508 µs | 1,132,944 → 1,248,079 |
| Writer with one raw aligned reader | 1.84 µs | 1.72 µs | — |
| Writer with one aggregate reader | 548 µs | 4.21 µs | — |

Aligned-query allocations fell from 32,721 to 8,460 per operation. Queries copy
requested history under the read lock, then order, align, and filter outside it;
metric maps are copied only for returned raw rows. Aggregate snapshots copy
mutable values, which increases allocated bytes but releases the writer earlier.
The writer benchmark is a tight loop with a continuous reader, not a production
sampling rate or a percentile latency measurement. Its allocation counters include
both goroutines and are omitted above.

Shared-host load caused timing variation: aligned queries ranged from 7.42–11.62 ms
before and 5.28–7.45 ms after. Aggregate query ranges overlapped, with one 943 µs
after outlier; the data does not establish a single-reader aggregate speedup.
These results do not measure browser rendering or live GPU collection.

Repeat with the same source fixture and toolchain on both revisions:

```bash
go test ./internal/history -run '^$' -bench 'Benchmark(Query|QueryAligned|QueryAggregate|WriterWithAlignedReader|WriterWithAggregateReader)$' -benchmem -count=5
```

Correctness checks cover immutable results, raw/aggregate gaps, delayed samples,
independent owner timestamps, custom filesystem IDs, and GPU generations. Sixty
serialized raw/aligned query cases across windows, metric selections, and point
limits matched the pre-change implementation byte for byte.

## Deferred storage measurement

The [workload sampler](../internal/workload/sampler.go) calls
[`readIO`](../internal/workload/io.go) for each Pod, which resolves backing-device
graphs and reads device generations. Repeated Pods on the same devices are a
candidate for reuse within one sampling pass. That path has not been benchmarked
here, so it remains unchanged. Measure representative Pod counts and overlapping
device graphs before adding a cache; preserve unknown/ambiguous accounting and
device-replacement detection between passes.

## Shared snapshot encoding

`BenchmarkSnapshotEncoding` uses the same default fake-provider snapshot and
normalization for both paths, with 16 readers per snapshot sequence. Five runs
on September 28 used Go 1.27.0, Darwin/arm64, and the Apple M1 Pro:

| Path | Median per reader | Range | Allocated bytes | Allocations |
| --- | --- | --- | --- | --- |
| Encode for every reader | 49.9 µs | 47.5–64.2 µs | 40,595–40,644 | 188 |
| Share one encoding per sequence | 3.08 µs | 3.05–3.17 µs | 2,537–2,541 | 11 |

The shared path retains one immutable JSON document, up to 4 MiB. Unversioned
snapshots bypass caching, and an old reader cannot evict the current sequence.
These are amortized encoding costs under this reader pattern, not HTTP/SSE
throughput, network latency, or whole-monitor CPU measurements. Host-load timing
variance is visible above; allocation counts were stable. Repeat with:

```bash
go test ./internal/api -run '^$' -bench BenchmarkSnapshotEncoding -benchmem -count=5
```

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

## GPU capacity and history

```bash
go test ./internal/kubernetesbridge -run '^$' -bench BenchmarkCapacityEightGPUs -benchmem
go test ./internal/history -run '^$' -bench . -benchmem
```

Capacity evaluation uses an eight-GPU fixture with overlapping MIG placements.
The original worktree reported about 5.45 ms and 3.84 MB allocated per evaluation;
real informer memory and allocator complexity depend on cluster inventory. Re-run
after adapter changes. Fixture results do not establish live scheduler admission.

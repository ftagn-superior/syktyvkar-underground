# Diagnostic JSON export v3

Open the game normally, reproduce the delay and use the existing **Diagnostics →
Download report** button promptly. Recording starts with this page's GameSession;
opening the panel or waiting for the HUD's 60-second warmup is not required. Stay
on the same page through saved-spawn fallback/reconnect. Reloading starts a new
run. Exporting does not clear any history. A loaded old client still exports v2;
new fields cannot reconstruct an earlier run or identify an already deployed v2
artifact retrospectively.

v3 preserves the existing `build`, `environment`, `versions`, `rendering`,
`streaming`, `physics`, `prediction`, `preparations` and `metrics` sections and
adds `history`, `server`, `publication`, `semantics` and `measurements`. Consumers
must check `formatVersion`; the legacy HUD `metrics.frameP95Ms` remains filtered
and may legitimately be null while raw observations are available.

## Artifact and publication identity

`build.commit` is embedded by Vite **when building this client**, with build ID,
timestamp, dirty flag and provenance. It is never read from a runtime checkout.
`SU_BUILD_SHA` accepts a full 40-character SHA and `SU_BUILD_ID` a short release
identifier for source archives/CI. Without Git or explicit build metadata the
revision is null. A dirty build identifies its base revision, not a reproducible
clean artifact; retain the dirty flag in comparisons.

`server.build` is optional metadata reported by `/api/world`, separately embedded
when the server is bundled. Source/dev execution or an old server reports no
artifact identity. Never fill this from the client's SHA. This is an additive
HTTP `WorldInfo.serverBuild` field: protocol 27 and join/catalog compatibility are
unchanged. Old clients ignore the field, new clients accept old servers, and
malformed/missing identity is explicitly unknown. It identifies the sampled HTTP
server artifact, not a proof about every replica or every earlier connection.

`publication` distinguishes world/map/epoch, layout revision/hash and asset
release. Current camera/quality/render size/weather remain in `rendering`.

## Clocks and raw frames

`history.runId` is a fresh local ID, unrelated to account/auth/reconnect tokens.
All `atMs`/`startMs` use the same `performance.now()` domain. `history.clock`
contains monotonic/UTC pairs at recording start/export and the browser's
`performance.timeOrigin`. Approximate UTC is:

```text
clock.start.utcMs + (observation.atMs - clock.start.monoMs)
```

These are client clocks, not trusted server time. Compare both anchors for wall
clock adjustments. Rounding to 0.001 ms is serialization precision, not a claim
about clock accuracy or browser timer resolution. Second-resolution external logs cannot explain a single
16-ms frame precisely. A timestamp association is not proof of causality.

`history.frames.samples` contains compact rows described by `frames.columns`:

```text
[frameId, atMs, intervalMs, workElapsedMs, renderSubmitElapsedMs,
 renderOutcome, hudReason, phase]
```

The last three fields are indices into the exported `renderOutcomes`,
`hudReasons` and `phases` dictionaries; phase is sampled at callback entry. A frame is a visible WorldView callback,
including preparation, warmup, input pauses and render deferral. `rendered`
means `scene.render()` returned, not that the display presented it or GPU work
completed. `workElapsedMs` measures the synchronous callback wall duration;
`renderSubmitElapsedMs` brackets only `scene.render()`. Neither is CPU usage,
CPU execution time or GPU duration. An unfinished callback has unknown elapsed
time/outcome rather than fabricated completion.

First/resumed/recreated-renderer boundary intervals are null. Hidden callbacks
are excluded; real slow visible intervals are retained without clamping.
`excluded` counts these decisions over the run. HUD resets/visibility boundaries
appear in `transitions`; raw frames survive HUD resets and connection changes.
`firstFrameId`, `lastFrameId`, time endpoints, row count and valid-interval count
describe actual coverage. `coveredDurationMs` is the span between recorded
callback timestamps, including any intervening gaps, not foreground active time;
it is null with fewer than two observations. An empty history is explicitly
`no-visible-render-loop-observations`, with null endpoints, not zero FPS.

## Events, peaks and network context

- `events`: last **512** observations. Sync spans name actual logical boundaries;
  async spans include waits, preparation and cancellation. Ordinary cell/pump
  spans retain durations >=4 ms and newly observed maxima. Group handoff stages
  are retained even when short. This is not a complete instruction profiler.
- `transitions`: a separate last **128** connection/area/spawn/publication,
  visibility, graphics, camera/quality/defer, input/prediction-pause and HUD-reset observations. They survive frequent
  streaming event eviction. `area.plan`/`area.result` record prepare ID, source,
  outcome/code; `area.prepare` retains elapsed preparation. `spawn.fallback` records the observed
  saved→default plan change, **not an invented server-side cause**.
  `area.result-ignored` distinguishes a late result rejected by existing
  plan/publication guards from an accepted preparation result.
- `samples`: last **240** rows shared between render/network sources, each at
  most 1 Hz. Render rows sample camera, quality/dimensions, time/weather, ready/shown radii and
  cumulative shadow counters; network rows sample RTT/ack/patch ages, pending
  inputs, replay/pause/correction totals, ready state and resource counters.
  They use the render loop, not a background polling timer. No fixed number of
  seconds is guaranteed. Shadow invalidation causes and individual replay-step
  CPU durations are not instrumented.
- `peaks`: maximum newly measured duration for each fixed span name, with start,
  completion, frame associations, group/cell/scope fields and last sampled
  context (`contextSampledAtMs` reveals its age). These survive ring eviction;
  they do not retroactively timestamp legacy lifetime peaks.

`frameId` is null for an event outside a callback; `lastFrameId` is only a
reference. Async spans carry separate start/end associations. Connection ordinals
(`connectionNumber`) distinguish connections without exporting credentials.
Corrections >=0.05 m are events; all correction/replay observations still
contribute to sampled cumulative counters. Prediction pause durations are
elapsed intervals without the local reconciler, including waits, not CPU work.

`group.prepare` includes fetch/parse/engine preparation and waits. Handoffs split
`group.activate` (far activation; near objects are reconciled), `group.reconcile`,
`group.residency` and `group.release`. `group.handoff` encloses these stages; do
not add parent and child durations. `group.adopt` covers staged publication.
`publication.prepare` is async; `publication.swap` is synchronous adoption.
`stream.pump` covers the whole pump including adoption/refresh; legacy
`streaming.peakPumpMs` has narrower historical boundaries. `cell.connect` and
`cell.release` cover one generator advancement, not an entire cell lifetime.

Every ring exports its limit, total observations, overwritten count and time
endpoints. Overwrites mean lost _diagnostic observations_, not dropped displayed
frames. A frame's ID may predate the retained ring. Streamer scope IDs and map
changes distinguish owner/counter generations. Consult `semantics` before
subtracting counters or interpreting peaks. Legacy zero defaults before
connection/physics are retained for compatibility; new sampled missing sources
use null.

## Measurement limits and cost

`measurements` explicitly marks system/process CPU/GPU utilization, process RAM
and physical VRAM unavailable in an ordinary page. Geometry/texture/CPU-array
payloads are estimates and overlap; byte-cache size counts its retained decoded
payload only. `performance.memory`, when exposed, is a partial browser-defined
JS heap reading taken **at export**, not RSS or a historical maximum.

Capabilities describe the actual engine/context. Timer-query support is not a
sample: GPU timer samples are currently **not collected**, or explicitly
unsupported/no-context/context-lost. No zeros are manufactured from unsupported APIs.

The new frame storage is a fixed 225 KiB Float64Array (3600 × 8 × 8 bytes), plus
bounded event/sample/peak objects with selected fields/128-character strings.
No full scene/resource traversal or JSON serialization runs per frame. The
existing detailed snapshot and serialization remain manual export work. The
file size is bounded by record counts, not a constant byte target; legacy
4096-operation/256-HTTP histories can already make files substantial.
Instrumentation overhead and real-device end-to-end download remain to be
checked on hardware; this change makes no FPS improvement claim.

## Verification and S-61 integration

Contract tests cover warmup/deferral, visibility and renderer boundaries, ring
losses, async attribution, peak retention, spawn replacement, clocks, missing
values, privacy and artifact provenance. Hardware/GPU benchmarks, a production
deployment and database changes are outside this change.

This branch targets main. S-61 has a different optimized group pump, visibility
and renderer lifecycle. Port recorder/build/export contracts first, then adapt
only observational hooks around **S-61's existing** batched activation/reconcile/
release. Never replace its optimized files with main's versions or split a
batched reconcile just to collect per-group spans. Validate the final session on
the original device after the port/push; no port/merge is performed here.

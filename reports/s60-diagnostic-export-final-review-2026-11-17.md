## S-60 final review of PR #80

Scope: the manual diagnostic JSON export, including Claude's recorder/context,
planning/effect/shadow additions and opt-in GPU timer. This does not implement
the original UI/continuous telemetry/database project or transfer anything to S-61.

### Refs and independent findings

Fetched `main` = `f680dced221e467ed7ca85569cf622f7e9bf0210` and PR head =
`480cd6bb6658d826b05eb01ec676f5dee92762c6`. The branch contains both original
commits and Claude's `beb7e3d3`, `75846296`, `480cd6bb`. Main is an ancestor;
GitHub reports MERGEABLE/CLEAN, so there are no conflicts to resolve against
that main. Mergeability is not test evidence.

Review found additional blockers in the opt-in timer, fixed before acceptance:

- It could begin/end a TIME_ELAPSED query while another instrument owned it.
  It now checks CURRENT_QUERY, verifies ownership at end, and yields to Babylon's
  GPU capture/token state. A detected competing owner discards our pending sample;
  it never ends the other owner's query or reads its shared disjoint flag.
- Disjoint was checked only after availability. It now invalidates a pending
  sample even before a result is available, as the Khronos extension examples
  require. Queries older than 5000 ms and invalid numeric results are discarded
  with distinct counters. No wait/finish/readPixels or polling loop was added.
- An exception from a diagnostic GL method could interrupt the render loop or
  mask a render exception in finally. The sensor now fails closed with status
  `error`; context loss/restoration and dispose release only owned state.
- Render/network snapshot getters now have a failure boundary. A failed source
  leaves an incomplete sample, increments `history.samples.failures` and emits
  a bounded technical error event. Game work after the observation continues.
  GPU attachment rejects invalid frame IDs and durations.
- Rare snapshots use their actual collection timestamp, rather than the callback
  start passed through a potentially long frame hook. This avoids backdating
  context by a long pump/handoff duration while keeping clock reads at 1 Hz.
- Pipeline HDR/MSAA constants/getters described requests, not necessarily the
  allocated format/sample count after capability fallback. The export now keeps
  requests separately and observes the first post-process input attachment,
  leaving unknown pre-allocation values null. A low-capability regression checks
  that requested HDR/4x MSAA does not become claimed actual HDR/4x MSAA.

These fixes keep the existing game action order, graphics quality, shadow cache,
integrity validation and protocol 27 unchanged. Frame storage is fixed at
337.5 KiB; events/transitions/samples and span-name peaks remain bounded.

### Checks performed here (Linux, Chromium 158, SwiftShader)

- Profiled unit/contract suite: **24 files, 269 tests passed**, including network,
  streaming, environment/lighting, recorder, report, build identity and GPU timer.
  Added regressions cover foreign query ownership, early disjoint, age/invalid
  results, sensor exceptions, a failing resource getter during a real GameSession
  frame, and exported saved→PLAN_REPLACED→default/ignored-result fields through
  the existing message handlers. No assertions were removed or weakened.
  After the final timestamp/effective-HDR changes, the affected contract subset
  passed **72 tests** and the effects/recorder subset passed **41 tests** (these
  subsets overlap, so the numbers must not be added). The latter includes the
  extra low-capability allocation regression.
- `pnpm exec tsc --noEmit`: passed. Targeted formatting and `git diff --check`:
  passed. `pnpm build`: passed world generation, canonical/integrity/catalog
  checks, boundaries and bundling on Linux. After sensor fixes, the final
  `tools/build.mjs` bundle and type check also passed. No Windows validation
  workaround was used or committed.
- Nine actual JSON v3 downloads in a headed Chromium window under Xvfb, with
  SwiftShader and a fresh local PostgreSQL 17 cluster/schema. The test backend
  used physics-lab and the default 15-second preparation limit. Initial spawn,
  both camera modes, quality change, context restore, offline/reconnect, repeated
  export, reload/new run, pre-HUD raw frames and buffer coverage were exercised.
  All JSON contracts passed, GPU timer samples were produced, and render/network
  snapshot failure counters remained zero. Backend and cluster were closed and
  disposed. No production service, database or player settings were used.
- The **full download scenario still exits nonzero** because window minimization
  did not change `document.hidden`, even in this Xvfb environment. Its summary
  explicitly records hiddenBoundary=false and the failed assertion; context
  restore/reconnect checks are true. This is not reported as a fully green browser
  scenario. Real hidden/resume remains unit-tested plus code-reviewed, not a
  native window-system check.
- `node --import tsx tests/browser-gpu-timer.mjs`: passed native WebGL2 checks in
  SwiftShader: another active query is preserved without GL errors, a valid result
  is attached to issuing frame 2, context loss drops the pending query and restores
  the sensor, and an injected API exception disables the timer while rendering
  and GL state remain usable. This is API/lifecycle validation, not a benchmark
  of a physical GPU.

Exact profile command:

```text
pnpm exec vitest run apps/client/src/diagnostics apps/client/src/network apps/client/src/streaming apps/client/src/rendering/environment apps/client/src/ui/diagnostic-report.test.ts tests/build-identity.test.ts
```

### Baseline comparison and gaps

Ran `tests/integration/streaming-fixture.test.ts` and
`tests/integration/terrain-release.test.ts` once on this branch and once in a
detached, clean `f680dced` worktree with its own dependencies. Both results are
identical: **7 passed, 1 failed, 1 SQL-dependent skipped**. The failure is
`creates eight dispersed city seam routes after testing their complete capsule
traversal`, timing out at the unchanged 120000-ms limit. Private terrain release,
canonical/integrity rejection and standalone-server bundle tests pass on both.
The timeout is confirmed baseline, not a newly introduced feature failure; its
limit was not increased. The SQL fixture did not run because these two invocations
had no SU_TEST_DATABASE_URL (the separate browser stand had its own disposable DB).

This is not an independent reproduction of all five unnamed Windows fixture
failures from Claude's interrupted full run, nor a claim that the full suite is
green. No repeated full-suite/benchmark campaign was run. Full Windows build
validation remains unverified; Linux canonical build passed without bypasses.

Saved-spawn fallback was verified here through real client handlers in unit tests,
not an OAuth browser login. The lobby download→spawn issue remains a reported
main/PR baseline from Claude; the existing scenario uses a separate lobby tab and
therefore does not disprove or fix it. Neither gap changes new export semantics
or introduces an authentication/gameplay change, so neither is a merge blocker
for this manual-export increment. A real player log and native hidden/resume
check remain follow-up acceptance evidence.

### Interpretation and recommendation

Claude's two repeats per A/B variant are preliminary observations, not evidence
of zero overhead or a universal bound below 1 ms. Manual export is synchronous
and was measurably more expensive (20–38 ms in that report). Node recorder timing
does not include all browser hooks/GL calls. No new hardware performance claim is
made from this Linux/SwiftShader run.

Callback/planning/submit durations are monotonic wall-time, not CPU execution or
CPU usage. The sampled GPU query duration is neither utilization nor physical
presentation time. A GPU span longer than submit wall-time is insufficient alone
to establish the overall bottleneck. The T480 report was corrected to distinguish
that observation from a causal conclusion; controlled quality/resolution tests
and synchronized CPU/GPU traces remain the next diagnostic step.

**Verdict: ready to merge the manual-export feature after these fixes**, subject
to an exact-head merge and normal GitHub protections. No new feature blocker
remains in the checks above; known non-green baseline/environment checks are
explicitly retained. GitHub had no CI checks attached at initial review, so CI
absence is not presented as a green CI result. Final merge SHA/time belong in the
issue result, after GitHub confirms the operation.

S-61 adaptation remains in `docs/diagnostic-export.md`: transfer recorder/build/
report contracts, adapt hooks around its existing batched work and renderer
lifecycle, use `frameDrawCalls` for its optional SceneInstrumentation, preserve
its GPU profiling guards and shadow optimizations, then validate on the original
device. No merge or cherry-pick into S-61 is performed here.

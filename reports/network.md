# Browser network acceptance — T03

Measured on 11 November 2026 with Node.js 26.10.0, Chromium 155.0.8059.12, Babylon.js 9.35.0, Havok 1.3.14 and Colyseus SDK 0.18.10. Two independent browser contexts use the real rendered application, WebSocket connections and keyboard input. The viewport is 800 × 600; Chromium uses SwiftShader in this environment. These measurements do not establish the graphical performance budget on reference hardware.

## Reproduce

```sh
pnpm build
pnpm exec playwright install chromium
pnpm test:network
```

The default runner starts a fresh local server on an available port for each profile and closes it afterwards. It serves the built client and world, with the current server source. No reset route, direct position assignment or gameplay mutation hook is used. `SU_TEST_URL` optionally targets an existing server, which must start with the untouched `physics-lab` scene. `SU_TEST_PROFILE` selects `rtt50`, `rtt100-jitter20` or `rtt200`. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` optionally selects an installed Chromium executable.

For actual packet loss on Linux:

```sh
pnpm test:network:netem
```

This optional command requires permission to create a network namespace and configure its loopback interface, plus `unshare`, `ip`, `tc` and `curl`. It creates a **new network namespace**, launches its own built server, and verifies the namespace differs from the invoking shell before applying netem. It never changes host interfaces. Assets load before impairment: this checks the running game and TCP recovery, not cold-download throughput. The namespace and owned server are released after the run.

## Method and results

The first three profiles use an application-blind TCP byte relay. It adds half the requested RTT in each direction, preserves byte ordering and implements bounded buffering/backpressure. Jitter uses a fixed seed. It does not discard application messages or pretend to simulate packet loss. The fourth profile uses Linux netem: 100 ms delay with 10 ms normal jitter each way and 1% packet loss. Kernel counters confirm 78 dropped packets alongside 6,627 transmitted packets in this run; retransmissions are handled by TCP.

**Profile names describe injected network delay.** Observed SDK RTT includes browser and host scheduling overhead and is recorded separately below; it was not calibrated to equal the nominal profile name. Tests ran alongside the separate load/soak work. Corrections are the physical position difference before authoritative adoption and after input replay, excluding visual smoothing offsets. The bounded read-only event history records every reconciliation used for each phase; none of the reported events were inferred from predicted-versus-lagged-server position.

Each profile includes walking into a static wall, two players pushing the same crate from one side, two players pushing from opposite sides, and release/convergence checks. The wall phase is four seconds; contact phases are 4.5 seconds. Counts below are per browser per phase. **These are short, small-sample scenarios**: at these sample sizes the reported p95 often equals the largest correction. The runner verifies retained event counts equal emitted counts.

| Injected profile | Observed median RTT range | Wall p95, worst client | Same-side crate p95, worst client | Opposed crate p95, worst client | Maximum pending inputs | Events per client/phase |
|---|---:|---:|---:|---:|---:|---:|
| rtt50 | 122–128 ms | 3.2e-07 m | 0.240 m | 0.080 m | 5 | 15–17 |
| rtt100-jitter20 | 170–178 ms | 3.2e-07 m | 0.249 m | 0.305 m | 5 | 14–17 |
| rtt200 | 271–279 ms | 2.9e-07 m | 0.392 m | 0.270 m | 10 | 14–17 |
| rtt200-loss1 | 273–307 ms | 3.2e-07 m | 0.400 m | 0.197 m | 13 | 13–16 |

All four profiles passed their assertions. The 50/100 ms injected profiles satisfy the measured correction thresholds of 0.2 m at static obstacles and 0.5 m at the crate. The 200 ms and packet-loss profiles check correctness, bounded buffers and recovery; their measured corrections are also shown without claiming identical responsiveness. No browser exceptions or stalled-prediction samples were recorded in these scenarios.

The same-side pushes moved the crate by more than 2.8 m in every final run, confirming an actual dynamic interaction. After fresh resting states arrived, the displayed crate was already within 0.1 m in both browsers at the first observation and remained within that tolerance for a further 500 ms. Final positional disagreement between browsers was zero at the recorded precision. Teleports were not used to establish convergence.

Machine-readable results, screenshots and the two browser videos for each profile are under `output/playwright/network/` (generated and ignored by Git): `results.json`, `netem-results.json`, `netem-counters.txt`, individual profile JSON files and profile video folders. The recorded exact client/phase values, event counts, injected settings and measured RTTs should accompany comparisons with a later build. Full eight-client performance and the 30-minute run are separate acceptance checks.

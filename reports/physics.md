# Physics adapter verification

Implementation: Babylon.js 9.35.0, Havok 1.3.14, Node.js 26.10.0. Run from the repository root:

```sh
pnpm test -- packages/simulation/src/physics.test.ts
pnpm test:physics:browser
```

The renderer-free world uses `NullEngine`, a separate `Scene`, and the documented `HavokPlugin.executeStep(dt, physicsEngine.getBodies())` operation. A simulation step updates every character controller, then advances Havok once. No rendering call or character count controls elapsed physical time. The authoritative crate is a dynamic Havok box. The prediction crate and remote characters are animated collision proxies driven by server snapshots.

The character uses Babylon's `PhysicsCharacterController` and its built-in animated capsule body. Contacts between characters therefore use the same Havok queries and controller solver as contacts with walls; there is no independent 2D collision implementation.

Restoration reconstructs the local character controller using public APIs, restores position and velocity, and restores the application fields (`revision`, orientation, grounded state). This discards internal contact manifolds and displacement caches, whose internals are intentionally not serialized. Snapshot support objects are applied before restoring the local character. Replay uses the same controller update function as the server.

| Check | Evidence | Result |
|---|---|---|
| T01 Node fixed-step path | No rendering; wall collision and settled body height | Pass |
| T01 real Chromium/Node equivalence | Same scenarios in Node 26.10.0 and Chromium 155.0.8059.12; six snapshots for each of 30/60/120 outer cadences | All numeric fields matched exactly |
| T01 outer frame cadence | 30/60/120 outer updates per second produce identical snapshots after 180 physics steps | Pass |
| Common clock | Identical falling-crate height after 30 steps with one and eight characters | Pass |
| T02 restoration | 60 snapshot/restore/replay cycles, six steps each, at a wall | Maximum discrepancy below 0.05 m |
| T02 corner | Diagonal movement into a two-wall inside corner, then reverse; same restoration cycles in Node and Chromium | Maximum discrepancy 0.0240641 m in both |
| Controller contact | Two controllers move head-on for 240 steps | Capsule separation stays above 0.695 m throughout the final 120 steps |
| Shared crate | Two same-side players, replay windows of 3/6/12 steps | p95 position discrepancy below 0.5/0.5/1 m respectively |
| Lifecycle | 20 add/remove cycles | Body count returns to baseline; world disposal returns body/player counts to zero |
| Safe placement | Occupied appearance point and respawn | Occupied point rejected; successful respawn increments revision |

All eleven tests pass. The structural-input regression also checks input fields exposed through prototype accessors (as used by Colyseus schemas). These are integration tests of the real Havok module, not mocks. The replay-window test isolates the approximate crate collider; it is **not** an RTT/jitter/browser measurement and does not by itself close T03. Browser WASM initialization and cross-runtime fixed-step equivalence pass in the isolated real-Chromium harness (`tests/browser-physics.ts`), which starts and closes its own local Vite server without adding client application routes. It writes machine-readable evidence to `output/playwright/physics-equivalence.json`. Actual network correction distributions, visual convergence and performance acceptance belong to the integrated game checks. The measured equality is not a claim of bitwise determinism across all browser platforms.

Install the matching browser with `pnpm exec playwright install chromium`; alternatively set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an existing Chromium executable. The browser test never requires an internet resource during the scenario: both JavaScript and WASM come from its temporary local server.

Static and dynamic body shapes and materials come from the world definition. The spawn check uses Havok shape proximity against the actual world, including the rotated crate. The reset of a lost crate also checks the target with shape proximity before teleporting. Each world releases controllers, bodies, shapes, query collectors, scene and engine. The shared WASM module remains resident for reuse; worlds do not each allocate a separate module.

Integrated two-browser latency, shared-crate convergence and real packet-loss results are recorded in [network acceptance](network.md).

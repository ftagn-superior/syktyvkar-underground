# Client UI

The UI is plain DOM + CSS over the Babylon canvas. Three principles drive it:

1. **Player colour = UI accent.** `ui/theme.ts` `applyAccent(hex)` sets `--accent`, `--accent-soft`,
   `--accent-line`, `--accent-ink` and `--accent-text` on `:root`. Every highlight uses those
   variables, so a colour change recolours the whole UI at once (lobby: live preview; world: the
   player's own colour).
2. **Hidden HUD.** In the world only the `?` hexagon is visible. `ui/help.ts` opens the controls
   panel (click, `H`; `Esc` closes). Chat/reactions/animations/inventory/respawn/leave/diagnostics
   live in that panel; available hotkeys also work directly. First person adds a persistent Overview button and a resume hint. A first-time tip is stored under the
   `su:help-tip:v1` localStorage key.
3. **Low-poly styling.** Cut corners (`clip-path`), hexagons and faceted highlights; primitives are in
   `ui/theme.css` (`.su-facet`, `.su-corner`, `.su-gem`, `.su-hex`).

## Files

| Path | Role |
| --- | --- |
| `ui/theme.css`, `ui/theme.ts` | tokens, accent maths, primitives |
| `ui/lobby.css`, `ui/hud.css` | lobby windows / in-world HUD |
| `ui/characters.ts` | lobby character catalog (data driven; locked placeholders) |
| `ui/avatar-picker.ts`, `ui/color-picker.ts`, `ui/character-preview.ts` | lobby widgets; the preview renders the real avatar in a small private Babylon scene |
| `ui/help.ts` | help button/panel/tip |
| `interaction/` | contextual prompts (see below) |

## First person

`V` and the help menu switch one character between overview and first person. `input/first-person.ts`
waits for browser Pointer Lock confirmation, consumes entry/resume clicks and releases cancelled late
requests. Text fields retain `V` as text. The selected view is independent of mouse capture: chat,
help, Esc, blur, session waits and WebGL loss leave first person selected with neutral input and a
free cursor. Canvas clicks explicitly resume capture. A persistent Overview button remains reachable
with a free cursor. Touch switches back to overview and consumes the switching gesture.

First person permits walking and chat. Inventory, pickup prompts/rings, placement, new reactions and
animation requests are disabled, including shortcuts and periodic UI updates. Already submitted
requests continue through the session. Overview restores those actions. See the
[implementation report](../reports/first-person-mode.md) for browser coverage and remaining acceptance.

## Profile colours

`colorId` is a preset id (`mint`, `cyan`, …, plus legacy `amber`/`sky`/`lilac`) **or** a custom
`#RRGGBB`. `resolveProfileColor()` in `@su/contracts` is the single resolver; migration 4 relaxes the
old enum `CHECK`. Saving happens when entering the world (there is no separate save button).

## Interaction prompts

`interaction/interactable.ts` defines the registry type and `INTERACTION_KINDS` (key, label, range,
priority). `InteractionSystem` (`interaction/prompt.ts`) scans every 100 ms, shows one prompt for the
nearest interactable in range (pickups beat vaults), keeps it 150 ms after leaving range, and routes
the key / a click to `onActivate`. `PickupSource` turns replicated items into pickup interactables.
To add a kind (door, ladder, sit): add an entry to `INTERACTION_KINDS` and a source that yields
`Interactable`s. `closestPointOnSegment`/`distanceToSegment` are ready for linear objects such as
fences; there are no fences or vault mechanic in the world yet, so no `vault` source is registered.

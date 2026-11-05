# The Rust Control Center, B2.1 (#959)

**Status: B2.1 built, 2026-11-03.** The owner approved it in Claude's chat ("Yes, start
B2.1"). Like the bar (`BAR.md`), it runs with `--bar`. The early B2.4 switch
(#1017, owner 2026-11-05) activates it in Hyalo: see `SESSION.md`.
B2.2/B2.3 remain pending; activation does not imply their completion.

| Step | What |
|---|---|
| **B2.1** (this) | the panel, the grid read from GSettings, the ten default tiles working, opened from the bar's Control Center button |
| B2.2 | the detail panels (Wi-Fi's list, Bluetooth's devices, the 1×1 tiles' details), screenshot and recording |
| B2.3 | edit mode (sizes, moves, add/remove) and the widgets not yet ported (battery, clipboard, CPU/memory, Ethernet, VPN) |
| B2.4 | early switch (#1017), without waiting for B2.2/B2.3 |

🔑 Owner rules for what comes next (2026-11-03): **right click changes a tile's size only in
edit mode** (the TS gets this wrong); outside edit mode a tile's menu offers only its own
things (its detail, its panel, its control), never editing.

## Where it lives

| File | What |
|---|---|
| `cclayout.rs` | Pure and unit-tested: the registry, `DEFAULT_LAYOUT`, membership, and the layout (DEFAULT = flow-packed; PERSONAL = the stored cells, clashes moved to the first free cell). It only reads; writing is B2.3's |
| `cc.rs` | The panel: placement, glass, washes, paint, input, the reader nodes, and the writes |
| `status.rs` | The tiles' sources beside the bar's widgets (below) |
| `prefs.rs` | `watch_cc`: dark mode, Night Light, the layout keys |

## On the bar's surface

The panel is a piece of the bar's own surface (rule #708): while it is open the surface
grows to the output's height (`set_layer_placement`, anchor and exclusive zone unchanged),
its input region is the whole surface, and a press outside the panel or Escape closes it.
A press on a bar item closes it and clicks the item. A frame that hides the bar closes it.

It hangs 8 below the bar's glass, its right edge flush with the right capsule's.
Grid: 4 columns × up to 8 rows of 76 with gaps of 20; padding 16.
Shapes: a 1×1 a circle, a 2×1 or 1×2 a capsule, a 2×2 corner 38 (half a cell), and the
4×1 the dock's shape, corner 24 — never a capsule. Every corner is the desktop's one
continuous corner, drawn by Hyalo (and by `nk-render` in the fallback).

## Glass

The material carries more than one kind of pane now (`nk-wayland` `Material`):

- `groups` — further panes, each group with its own tone and shadow. The bar's capsules
  are the first group; each tile is its own group in the `controlCenter` piece's tone.
- `veils` — the variant's `veil` (`glass.json`, now exported; null with reduce
  transparency) over the tiles' bounding box, inset by its `inset`.
- `states` — Hyalo-drawn washes (commandment 12): an active 1×1 tile white, a badge's
  rest and "on", the hovers. Ids `1000 + tile*8 + n`, fade 150 ms.

## Tiles and their sources

| Tile | Reads | Writes |
|---|---|---|
| Wi-Fi | Network1 (the bar's), plus the network's name | — (detail is B2.2) |
| Bluetooth | Bluetooth1 `Snapshot` (first adapter) | `SetPowered` |
| Brightness | DisplayBrightness1 `GetState` (logind's device first) | `SetBrightness` |
| Volume | Audio1 (the bar's) | `SetVolume` on the default output |
| Media | Media1 `Selected` → its player's title, artists, status, cover | `SelectedPrevious` / `PlayPause` / `Next` |
| Dark mode, Night Light | GSettings | Config1 `Apply` |
| Focus | GSettings DND | the key |
| Screenshot, Recording | — | — (B2.2) |

Writes run on one worker thread; a slider sends only its latest value. Covers are decoded
by their bytes, not their name: Media1 caches them as `.img`.

The bold text weight falls back to regular where the font has no bold (the harness's), since
synthetic emboldening panics in the text stack.

## Evidence

`check-bar-headless.sh` opens the panel from the bar's button, checks the tiles in the
reader tree, toggles Focus there and sees the GSettings key and the tile's checked state
follow, then closes it with a click outside and sees the surface shrink back to 48.
Shots: `cc.png`, `cc-focus-on.png`.

What it cannot cover: media, brightness, audio and Bluetooth have no service in the harness;
their reading is unit-tested and their D-Bus signatures were checked against the live bus
where it serves them.

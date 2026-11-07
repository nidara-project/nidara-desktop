# The Rust Control Center, B2.1–B2.2 (#959)

**Status: B2.1 built, 2026-11-03.** The owner approved it in Claude's chat ("Yes, start
B2.1"). Like the bar (`BAR.md`), it runs with `--bar`. The early B2.4 switch
(#1017, owner 2026-11-05) activates it in Hyalo: see `SESSION.md`.
B2.2 is implemented by #1015 (private validation below); B2.3 and physical-session
acceptance remain separate. Activation does not imply their completion.

| Step | What |
|---|---|
| **B2.1** (this) | the panel, the grid read from GSettings, the ten default tiles working, opened from the bar's Control Center button |
| **B2.2** (#1015) | same-surface detail panels, native Wi-Fi secrets, output/player choice, screenshot and owned recording |
| B2.3 | edit mode (sizes, moves, add/remove) and the widgets not yet ported (battery, clipboard, CPU/memory, Ethernet, VPN) |
| B2.4 | early switch (#1017), without waiting for B2.2/B2.3 |

🔑 Owner rules for what comes next (2026-11-03): **right click changes a tile's size only in
edit mode** (the TS gets this wrong); outside edit mode a tile's menu offers only its own
things (its detail, its panel, its control), never editing.

## Where it lives

| File | What |
|---|---|
| `cclayout.rs` | Pure and unit-tested: the registry, `DEFAULT_LAYOUT`, membership, and the layout (DEFAULT = flow-packed; PERSONAL = the stored cells, clashes moved to the first free cell). It only reads; writing is B2.3's |
| `cc.rs` | The panel: placement, glass, washes, paint, input, reader nodes, and coalesced writes |
| `ccdetail.rs` | Detail rows, stable identities, scrolling, keyboard/AT-SPI, and typed actions |
| `ccdata.rs` | Audio/Media object snapshots from the status workers |
| `ccauth.rs` | A view-owned Network1 secrets renderer and bounded password editing |
| `capture.rs` | Screenshot jobs and one recorder shared across outputs |
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
| Wi-Fi | Network1 snapshot, current/saved networks and radio | SetWifiEnabled, Scan, ConnectDefault, Activate, Disconnect, secrets replies |
| Bluetooth | Bluetooth1 `Snapshot` (first adapter) | `SetPowered`, paired-device `Connect` / `Disconnect` |
| Brightness | DisplayBrightness1 `GetState` (logind's device first) | `SetBrightness` |
| Volume | Audio1 (the bar's) | `SetDefaultOutput`, per-node `SetVolume` / `SetMuted` |
| Media | Media1 `Selected` → its player's title, artists, status, cover | `SetSelection`, selected transport and track-revision seek |
| Dark mode, Night Light | GSettings | Config1 `Apply` |
| Focus | GSettings DND | the key |
| Screenshot, Recording | owned capture state and recording preferences | grim / slurp / wl-copy, one owned wf-recorder |

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

## B2.2 details (#1015)

The body/right click of a tile with a detail opens it on this same surface. Its
quick toggle/slider/player controls keep their action; reader nodes expose a
separate Details entry where needed. Outside edit mode no edit menu is added.
Back or Escape returns to the grid; a click outside closes the whole CC. Tab and
arrows navigate, Enter/Space activate, sliders accept SetValue. Lists fit the
output and scroll; offscreen rows remain in the reader tree and Focus reveals them.

Wi-Fi retains the current AP, otherwise the strongest AP for each raw SSID,
including saved hidden profiles. It joins supported existing profiles and ordinary
networks, and disconnects the current one. New enterprise/hidden profile editing is
not invented here. Bluetooth reconnects paired devices, as the TS detail does;
pairing/forgetting is a Settings responsibility. Volume selects an output and
provides capability-gated device/application volume and mute. Media offers Auto,
player selection, transport, and seek with the actual player/track revision. Night
Light includes temperature and schedule times; its master switch is disabled while
a schedule drives it. Brightness has a detail slider at 1×1. Focus and Appearance
have no TS detail and remain quick toggles.

Object lists/actions pin the unique service owner that supplied them; network and
Bluetooth row identities also include the snapshot epoch. A replacement's same
path never becomes an old row's target. Requests against retired node identities
are dropped. Seek identity includes the track revision. Backend values remain
authoritative, with only a held slider following the pointer. Writes coalesce by
owner/destination/key; a long Connect has its own bounded lane so Disconnect and
secret replies remain usable. Errors are visible in the view that issued them,
never a subsequently opened detail.

### Network passwords

Opening Wi-Fi creates a private connection, subscribes, resolves the unique
Network1 owner, then RegisterSecretsUi. A second renderer is refused visibly.
Only that owner's current SecretsRequested ID can be answered. Metadata chooses
allowlisted fields (PSK, selected WEP slot, or the existing enterprise profile's
requested secrets); no settings or credentials are invented. Password text never
enters Debug, command arguments, semantic snapshots or surrounding IME text.
AT-SPI exposes EditableText but no readable Text interface; keyboard/IME entry and
Unicode selection stay view-local. SecretsClosed/owner loss clears the question.
Closing the connection withdraws it through renderer loss; Cancel explicitly calls
CancelSecrets. No renderer or secret is retained after leaving Wi-Fi.

### Screenshot and recording

Screenshot chooses area/screen/window and Save/Copy. It closes the panel before
capture, passes literal argv to grim/slurp, saves under the XDG Pictures directory,
and offers PNG explicitly through wl-copy. A missing focused window is an error,
not an accidental full-screen capture. Temporary files are only owned files and
are removed after copying/failure. File names reserve a new path without clobbering.

Recording chooses screen/region and audio, reads org.nidara.recording preferences
(format/quality/framerate/hardware/audio-source/save-dir), and owns one wf-recorder
across outputs. Start means a child was spawned; failure/exit remains observable.
Stop sends SIGINT only to that unreaped child; a second Stop kills only that child.
setpriv --pdeathsig INT also ends it if the Rust shell dies. No global pkill.
Helpers have deadlines, drain bounded output and are reaped. Screenshot has a
separate lane, so taking one cannot block recording Stop. A quiet controller sleeps.
Actual codec/frames, audio hardware and physical-display acceptance are distinct.

### Verification

check-bar-headless.sh includes B2.2 by default (NK_CC_DETAILS_CHECK=0 retains the
older baseline). check-cc-headless.sh runs the same path and stops after the CC checks.
The extended private bar harness serves: a stand-in Network1
with a suspended Connect/password exchange, Bluetooth devices, real Media1 observing
private MPRIS players. NK_CC_CAPTURE=1 additionally invokes real screenshot/video
tools on software Hyalo; it requires a wf-recorder compatible with the advertised
DMA-BUF version. Stock wf-recorder 0.6 unconditionally binds v4, while software
winit without an EGL render node advertises v3: that extended recording check
fails at the client bind, not at Start/Stop. Keep that failure visible; do not
change the compositor protocol for the test. Its bus,
settings, user directories and output files are private. Set HYALO_BIN,
NK_DOCK_BIN, NK_SESSIOND_BIN and NK_SETTINGS_DATA to this branch's builds/exports;
export both settings data and tokens. Never compile during a headless check.
cc-details.json and cc-*.png are its evidence; physical/hardware acceptance remains
pending. A private real-D-Bus unit test checks Audio1 types, selection, volume,
mute, removal and owner replacement without using the desktop bus.

Product comparison and explicit gaps are recorded in [B2.2.md](B2.2.md): quick
connection plus password (GNOME), per-device/application audio (KDE), and visible
Stop/capture choices. A unified visual capture chooser, enterprise/hidden profile
editor and new-device Bluetooth pairing are not silently approximated by TS.

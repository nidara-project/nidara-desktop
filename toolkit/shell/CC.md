# The Rust Control Center, B2.1–B2.3 (#959)

**Status: B2.1 built, 2026-11-03.** The owner approved it in Claude's chat ("Yes, start
B2.1"). Like the bar (`BAR.md`), it runs with `--bar`. The early B2.4 switch
(#1017, owner 2026-11-05) activates it in Hyalo: see `SESSION.md`.
B2.2 is implemented by #1015; B2.3 is implemented by #1016 (private validation below).
Physical-session acceptance remains separate. Activation does not imply their completion.

| Step | What |
|---|---|
| **B2.1** (this) | the panel, the grid read from GSettings, the ten default tiles working, opened from the bar's Control Center button |
| **B2.2** (#1015) | same-surface detail panels, native Wi-Fi secrets, output/player choice, screenshot and owned recording |
| B2.3 (#1016) | edit mode (sizes, moves, add/remove), battery, clipboard, CPU/memory, Ethernet and VPN |
| B2.4 | early switch (#1017), without waiting for B2.2/B2.3 |

🔑 Owner rules for what comes next (2026-11-03): **right click changes a tile's size only in
edit mode** (the TS gets this wrong); outside edit mode a tile's menu offers only its own
things (its detail, its panel, its control), never editing.

## Where it lives

| File | What |
|---|---|
| `cclayout.rs` | Pure and unit-tested: the registry, `DEFAULT_LAYOUT`, membership, and the layout (DEFAULT = flow-packed; PERSONAL = the stored cells, clashes moved to the first free cell). Moves, resizing, gravity, lift and membership edits share these pure rules |
| `cc.rs` | The panel: placement, glass, reader nodes, coalesced writes; the grid's view on nk-view |
| `ccdetail.rs` | Detail rows, stable identities, AT-SPI and typed actions; its view on nk-view |
| `ccedit.rs` | View-local edit mode, preview, gallery, keyboard and named reader actions |
| `ccaux.rs` | Mapped-only resources, bounded clipboard helpers and visible image previews |
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
  rest and "on", the hover, the press. They are the grid view's frame (below): region ids
  from 200000, the fade and the washes from the exported tokens, eight per tile at most.

## The grid on nk-view (#1048, step 3)

Outside edit mode the grid is an nk-view view (`VIEW.md` §12.4): `cc.rs` builds a pane per
tile in its size's corner on its cells, and nk-view lays it out and owns hover, press,
focus, keys and the washes. The controls are keyed by what they do: `t:` the whole tile (a
toggle), `d:` its detail, `b:` a capsule's badge, `s:` a slider, `m:` the player's
buttons. A 1×1 toggle with a detail carries that detail as a keys-only control, so the
pointer toggles and Tab and readers still reach the detail.

- **Buttons act on release** over themselves; a press that leaves does nothing. A slider
  acts on its press and on every move, and shows where it was let go until the service's
  value is laid out.
- **The editor's panel places the grid**: its scroll region (step 4, below) says where
  the grid's top is, so the grid view lays panes where they are (`set_slides(false)`) and
  the pointer outside the viewport leaves the grid, unless it holds a slider.
- **Tab** follows the readers' order: the Edit button, then each tile's primary control,
  its player buttons, then its Details entry.
- **Back** from a detail focuses the tile that opened it; its ring shows only when a key
  went back (Escape, or the Back row pressed with the keyboard), never after the pointer.
- What is neither text nor glyph is painted in slots: covers, the battery, the resource
  rings with their numbers, and a slider's value as it moves (dark over a 1×2's fill).
- The reader tree is still built by hand with the same ids and names; its bounds and
  focus come from the view.

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
Up/Down navigate, Enter/Space activate, Left/Right step a slider (Night Light's
temperature by 100), sliders accept SetValue. Lists fit the output and scroll;
offscreen rows remain in the reader tree and Focus reveals them.

The page is an nk-view view (`VIEW.md`, #1048): `ccdetail.rs` keeps the model
(rows, identities, typed actions, the secret form) and nk-view lays it out and
owns hover, press, focus, keys, the held slider and the scroll. A row acts on
release over itself, as every nk-view control does; a slider reports while
dragged and on release, and its thumb stays where it was let go until the
service's value arrives. A secret row is a field that receives only its bullets
(§12.2); a choice's mark and a clipboard entry's picture are painted slots (§12.3), and a
setting that is on or off (Ethernet, Wi-Fi, Bluetooth power, Night Light and its schedule,
recording audio) ends its row with a switch (§12.6).

A switch and a toggle tile (Ethernet, Bluetooth, Night Light, Appearance, Focus) show
what they were last asked for, and their next click asks for the opposite of it, until
the service reports that state, a write fails or six seconds pass; then they show what
the service says. A click is never decided from a snapshot alone: one that had not
caught up asked for the same thing again (#1074).

Wi-Fi retains the current AP, otherwise the strongest AP for each raw SSID,
including saved hidden profiles. It joins supported existing profiles and ordinary
networks, and disconnects the current one. New enterprise/hidden profile editing is
not invented here. Bluetooth reconnects paired devices, as the TS detail does;
pairing/forgetting is a Settings responsibility. Volume selects an output and
provides capability-gated device/application volume and mute. Media offers Auto,
player selection, transport, and seek with the actual player/track revision. Night
Light includes temperature and schedule times; its master switch stays usable while
the schedule is on, since the schedule acts only when it crosses a boundary and a
change by hand lasts until the next one (#957). Brightness has a detail slider at 1×1. Focus and Appearance
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

## Edit mode on nk-view (#1048, step 4)

Edit mode is two nk-view views built by `ccedit.rs` (`VIEW.md` §12.7): the panel, a scroll
region with the grid and the rows to add, the error and Edit/Done; and the size menu, on its
own layer in Hyalo. Their keys: `e:done`, `e:t:` a tile, `e:x:` its remove badge, `e:a:` a
row to add, `e:f:x:y` a free cell, `e:z:` a size in the menu and `e:zx` its Remove. The
editor keeps the model (hold, preview, write barrier, named actions); the views place,
hit-test, focus, wash and paint. Edit/Done and the menu's rows act on release over
themselves, as every nk-view control does. Outside edit mode the panel view holds only the
scroll region the grid is laid in and the Edit button.

## B2.3 editing and widgets (#1016)

Edit/Done stays below the scrollable grid. Edit shows all eight rows, their empty
slots, removable tile badges and a list of available nonmembers. Escape leaves
edit mode while keeping the CC open and focusing Edit; closing the CC ends edit.
Outside edit, right click opens only a tile's own detail. In edit, it opens all
three size tiers, including an unavailable tier with its refusal reason. Fixed
tiles have no remove action. Child controls are inactive while their tile moves.

A drag preserves its press offset. Preview uses the same pure layout operations
as keyboard/reader actions and performs no settings writes. An equal-footprint
single overlap swaps the other tile to the origin; other direct conflicts move
to the nearest free cell, with priority below, same row, then above. Resize is
anchored and clamped left/up to fit. Shrink/remove lifts only within freed columns,
never sideways or above their top. DEFAULT add/remove repacks without creating
positions; first move/resize personalizes all cells. Hardware absence never edits
membership, stored positions or sizes. A full grid refuses an edit visibly and
through an Alert node. CPU/RAM and missing hardware retain their source semantics.

Tab focuses tiles, Ctrl+arrows moves, Menu/Shift+F10 opens sizes, Delete removes.
AT-SPI declares named Move up/down/left/right, Resize and nonfixed Remove actions.
Editor IDs occupy a separate high range from detail/list rows; only one view owns
focus. A settings write disables further edits until its matching echo or successful
write acknowledgement. Acknowledgement releases the barrier even if another
writer replaced the layout before the echo; the next sync takes the actual state.
Replies from an earlier write serial cannot unlock a later edit.

### Persistence and motion

Both hosts use the existing wire keys: control-center `positions a{s(ii)}` and
`sizes a{ss}` with `WxH`; widgets `placement a{s(bb)}` with `(bar,cc)`. Edits merge
the latest bar flags, including the registry default for an unstored pair.
GSettings `delay/apply` is **per schema**, so it cannot be one transaction across
these two schemas. Remove writes membership first, then geometry; add writes
geometry first, then membership; move/resize applies geometry once. Every
intermediate layout remains valid. Removal with lift can have a valid intermediate
position distinct from both endpoints. Watchers coalesce key notifications; the
editor retains its pending model until the matching echo or the write reply rather
than showing intermediate phases. A successful reply always releases pending,
including when a concurrent writer makes the final echo different.

Hyalo moves both ink and material in synchronized tile layers. The unpublished
layers v1 protocol appends a parent-space clip, fixed to the viewport while the tile
moves, for glass, ink, shadows and input including descendants. Old/new model positions can cross
the viewport edge during a return. Layer identity survives preview retargeting;
no client timer paints glass or drives motion. Both interfaces stay at v1 with no
capability/version gate; Hyalo and the toolkit must be updated together. See
toolkit/CONTRACT.md.

### Additional sources

Battery reads Power1's display device, state and known time remaining, using the
bar's custom glyph. Ethernet and VPN consume Network1 snapshots, pin their unique
owner/epoch, and call SetWiredEnabled or Activate/Deactivate with literal typed
arguments. There is no nmcli path. CPU/RAM reads /proc only while the resources tile
is mapped in a grid, and sleeps without a timer while hidden. CPU uses counter
deltas; RAM uses MemAvailable. An unavailable value is shown as unknown.

Clipboard uses literal cliphist list/decode/delete/wipe and wl-copy. Parsing strips
C0 bytes before UTF-8 conversion without truncating at NUL; positively identified
UTF-16 text becomes UTF-8, while image bytes are reoffered unchanged. The list is
bounded to 200 records/2 MiB; decode is bounded to 32 MiB. Each child has a five
second deadline, nonblocking owned pipes, and is killed/reaped on failure. Clipboard
writes have a separate lane from layout/hardware writes. Clear asks for confirmation;
individual rows expose Remove. Only visible image rows request decoded previews,
through one worker with a 32-entry cache, bounded allocation/dimensions and 40px
thumbnails. List revisions retire old rows and previews. A missing cliphist makes
the widget unavailable.

### Verification

`check-cc-edit-headless.sh` extends the private notification harness with real
pointer, keyboard, AT-SPI and GSettings, plus private Network1 and clipboard helper
fixtures. No installed clipboard, desktop bus, preferences or session is used.
Set matching HYALO_BIN, NK_DOCK_BIN, NK_SESSIOND_BIN and exported NK_SETTINGS_DATA.
Never build while it runs. The longer walk is a nightly proposal; no CI job is
added here. Physical display, hardware, Orca and installed-session acceptance
remain separate from this local evidence.

The TS wire check bundles the unchanged CCLayoutManager, WidgetConfig and
configFile readers with declaration-only metadata extracted from the actual TS
widget sources. It compares their read cells and `(bar,cc)` placement against the
Rust writes, without booting the TS shell. This proves wire/read compatibility,
not GTK presentation. `cc_layout_controls.py` compiles four actual source mutations
and requires each to fail the layout tests; contradictory observation controls in
the graphical report additionally check its predicates. They are distinct evidence.

Local acceptance for this cut: 188 shell, 18 AT-SPI, 4 renderer and 14 Hyalo
layer tests; workspace/all-target clippy; 23 English and 10 Spanish graphical
assertion/control pairs;
four discriminating layout source mutations. The B2.2 wrapper currently stops
before CC at dock-check.py:602: GetState also contains `nc` after B3.2, while its
assertion expects only `app-grid`. Reproduced on B2.3 and on the clean B3.2 base
281e88f4 (shell sources identical to main 03bc8fcc). Its harness is unchanged.
All eleven new keys are translated in all twelve catalogs; the existing 124-key
debt in ten catalogs is unchanged. Local evidence is evidence-1016 under the
owner's ChatGPT workspace; physical/Orca acceptance remains pending.

Editing refusals distinguish out-of-grid targets (silent arrow no-op / pointer
rollback) from a genuine capacity refusal (`cc.menu.size-full`). Layout write
errors are translated read-only/changed/save-failed messages; raw diagnostics stay
in the log. AT-SPI stable English action identifiers are independent of their
localized names/descriptions, supplied by each current semantic node.

`cc_edit_locale_check.py` runs a short private Spanish reader walk via
`check-notifications-headless.sh` with `NK_WIDGETS_CHECK` selecting that file.
It checks stable English action IDs against localized names/descriptions and the
existing capacity key. The normal edit walk also covers keyboard and pointer
out-of-grid targets; pure tests cover write acknowledgement versus a concurrent
layout change and stale write replies. `Meta::default_in_bar` owns each widget's
bar default alongside its CC default.

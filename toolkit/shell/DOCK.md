# The Rust dock, D1 (#959)

**Status: DESIGN for review, 2026-10-31.** The owner authorized D1 in Claude's chat
("fusiona A1 y empieza D1"). The contract it implements is
`session/design/APPLICATIONS1-DOCK.md` (A1, #976) §8 and the D1 row of §10. This file only
says how D1 is built and what it leaves to D2/D3/D4; where the two disagree, the contract
wins and this file is wrong.

D1 is the visible baseline: one dock per output with pins, running apps, minimized
windows and Trash; Files as the default directory handler; click to launch, focus,
minimize and restore; the fixed margin and uniform shrink; keyboard and AT-SPI;
`Shell1` `focus:dock`. It has **no** foreground usage, attention, Unity counts,
magnification, menus, thumbnail chooser, drag and drop or preferences page (D2/D3), and
no Apps launcher (D4).

## 1. Where it lives

`toolkit/shell`, package and binary **`nidara-shell`** (the contract's working name; the
installed path will be `/usr/bin/nidara-shell`, role `shell` in nidara-access). It is an
ordinary member of the toolkit workspace and uses only toolkit crates: `nk-wayland` (the
layer roots, outputs, tokens, captures), `nk-render`/`nk-text` (pixels, labels),
`nk-a11y` (the semantic tree), plus `zbus` for Applications1/Config1 and the existing
JSON socket for Hyalo. No second Wayland host, no TS bridge, no GTK.

## 2. Threads and data flow

```
            Applications1 (zbus)   Hyalo socket (EventStream)   Config1 / org.nidara.dock
                     \                     |                            /
                      +------------- hub thread (owns all sources) ----+
                                           |  DockView (Arc, immutable) + Waker per dock
                     +---------------------+---------------------+
               dock thread (output A)            dock thread (output B)     ...
               run_layer(LayerOutput A)          run_layer(LayerOutput B)
```

- **Supervisor (main thread).** `outputs()` then an `OutputWatch`. On `Added` it binds
  the instance (`bind_output`), starts that output's dock thread and registers its
  `Waker` with the hub. On `Removed(id)` it wakes that dock to stop and **joins** it
  before handling any later event for the same output (SHELL-SURFACES.md §2). `Lost`
  ends the process (the compositor is gone).
- **Hub thread.** Owns every source and the pure model. Each change recomputes one
  immutable `DockView` and hands the same `Arc` to every dock (an mpsc per dock plus its
  `Waker`). Docks never call a service on their own loop thread; requests (launch,
  focus, minimize, minimize targets) go back to the hub over a channel, and their
  outcomes come back in the next view or as an explicit notice.
- **Dock thread.** One `run_layer` per output. It reads the latest view on
  `Event::Wake`, lays out, paints, owns input/focus/a11y for its surface, and publishes
  its minimize targets through the hub.

Blocking calls get deadlines (zbus calls 2 s, the Hyalo socket 2 s as in sessiond).
A source that fails marks its part of the view unavailable; nothing waits forever.

## 3. Sources

- **Applications1.** Subscribe to `Changed` and `NameOwnerChanged`, then `GetSnapshot`;
  follow `AppsNext` with `ReadSnapshotPage` and `CloseSnapshot` when done; queue
  signals during hydration and reread if a newer revision arrived (contract §2).
  Icons with `GetIcon(epoch, id, generation, size, scale)` at the dock's effective
  size, cached by (id, generation, iconRevision, pixel size); a miss shows a neutral
  placeholder, never another app's art. A lost owner or a new epoch drops pending
  handles and rereads. `Launchable` and the capability list decide whether a click may
  launch (A1 has none; see §6).
- **Hyalo.** `windows` then `event_stream` on a second connection, subscribing before
  hydrating (contract §2, "Before H1"): `WindowsChanged`, `FocusChanged`,
  `OutputsChanged`, lock and fullscreen state. A disconnect marks windows unknown and
  reconnects with backoff; window IDs from an old connection are never reused.
- **Preferences.** Read `org.nidara.dock` position and icon-size through Config1 (the
  same client as Settings) and follow their changes. Magnification, indicators and
  auto-hide are read but only position, size and indicators act in D1.

## 4. The model (pure, unit-tested)

`model.rs` turns (layout, catalogue, windows, preferences) into a `DockView`: ordered
**pinned** entries (apps, the `default-handler:inode/directory` entry resolved to the
current default app, folders), a separator, **running** unpinned app groups in order of
first observed live window, a separator, **minimized** windows (one slot each, dialogs
minimized with their parent folded in), and **Trash** last. Empty sections and their
separators vanish. Focus changes never reorder.

Window → app matching before H1 is a pure lookup against the catalogue, in the
contract's order: exact current app_id as DesktopId (with and without `.desktop`), exact
StartupWMClass, verified Flatpak ID, then initial app_id. Ambiguous stays ambiguous and
gets its own `window:<epoch>:<id>` group; title and executable never choose an app.

## 5. Geometry

From the existing TS dock, so the Rust one keeps its proportions: padding = 0.22 × icon,
gap = 0.16 × icon, capsule radius = half the cross size with exponent 3.2, screen gap
`DOCK_SCREEN_GAP` = 4 logical px, dot 5 px. The glass is Hyalo's: one `Pane` per dock
with the exported `dock` tone (`tokens/glass.json`, by mode and reduce transparency); the
client paints only icons, dots and the separator (commandment 12).

Fit (contract §8): with L the allowed main-axis length (output minus 2 × gap, and for a
side dock minus the top-bar reservation), use the largest `0 < s <= 1` with `W(s) <= L`
applied to every icon, gap, padding, separator, minimized slot and Trash. No minimum
size, no scrolling, no dropped items. Until a Rust bar exists the reservation is a named
constant equal to the current bar region, in one place.

Position changes go through `set_layer_placement` on the same surface (T1); no
recreation. The input region is the resting capsule.

## 6. Actions

- **Launch.** Applications1 `Launch(epoch, id, generation, {Mode: activate, ActivationToken,
  RequestId})` with a token from the click's real serial (`request_activation_token`).
  Until A2 advertises `launch-exec`/`launch-dbus`, a click on an app with no windows
  reports the launch as unavailable (a visible, accessible state) and does nothing
  else: there is no fallback through Exec, uwsm, gtk-launch or the TS shell (Codex,
  Palomar #959 #739). Tests use a fake Applications1 on a private bus.
- **Focus, minimize, restore.** Hyalo `do focus-window ID`, `do minimize ID`, `do
  unminimize ID`, re-reading the window first so a reused ID is never acted on. The
  rules of contract §8 "Clicks": one visible window → focus, or minimize if focused;
  only minimized → restore the most recently minimized; two or more visible → focus the
  most recently focused (the chooser is D2).
- **Minimize targets.** `minimize_targets(output, "nidara-dock", {id: rect})` from the
  laid-out slots, in layer-local logical coordinates, one owner per window.
- **Folders and Trash.** Open through Applications1 `OpenDirectory` (A2). Trash shows its
  slot always; full/empty comes from GIO's trash monitor when available, else the slot
  says it cannot tell. Emptying is D2 (it needs the menu).

## 7. Keyboard and accessibility

One roving focus with a visible ring; arrows along the axis, Tab/Shift+Tab wrap,
Enter/Space act, Escape leaves. `nk-a11y` exposes the dock as a toolbar of buttons with
name, state (running, minimized, launch unavailable) and the same action dispatch as a
click. `Super+Ctrl+D` reaches it through `Shell1` `focus:dock` once the shell owns that
name; if IPC B has not landed, D1 says so and the binding waits for it.

## 8. Evidence for D1

- Unit tests: matching, sections, ordering, fit scale, view diffing, Applications1
  hydration with queued signals (fake), click rules.
- A nested check (`toolkit/shell/check-dock-headless.sh`, the T1 harness): private Hyalo
  + private sessiond `--applications` + fake desktop files; the dock surface persists
  across bottom/left/right, follows output hotplug, reads back windows, publishes target
  rectangles inside its slots, and libatspi walks every item.
- A private nested session (`scripts/dev/rust-session.sh --applications nidara-shell`)
  for the owner to look at. Not the daily session, no install, no sudo.

# The Rust dock, D1 (#959)

**Status: DESIGN, reviewed by Codex (Palomar #959 #741), 2026-10-31.** The owner authorized D1 in Claude's chat
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
  Icons with `GetIcon(epoch, id, generation, size, scale)`: the service takes 16..512
  logical and scale 1..4 (at most 1024 physical), so a dock shrunk below 16 asks for 16
  and scales the art down itself; the layout has no 16 floor. The pixels are straight
  alpha and are converted to the renderer's format once, when cached by (id, generation,
  IconRevision, pixel size). A miss shows a neutral placeholder, never another app's
  art. A lost owner or a new epoch drops pending handles and rereads. A click may
  launch only when the app is `Launchable` AND the service advertises `launch` (A2's
  capability; `open-directory` for folders). `LauncherAvailable` is Unity's and stays
  false in D1; it says nothing about launching.
- **Hyalo.** `event_stream` first, and only after its acknowledgement `windows` on a
  second connection; events that arrive during hydration are reconciled, not dropped
  (contract §2, "Before H1"). Each event carries the whole list, so the newest wins: `WindowsChanged`, `FocusChanged`,
  `OutputsChanged`, lock and fullscreen state. A disconnect marks windows unknown and
  reconnects with backoff; window IDs from an old connection are never reused.
- **Preferences.** Read-only from GSettings `org.nidara.dock` on a GLib thread with its
  change signals (Config1 has no `dock.*` keys yet; it becomes the writer in D2). Never
  `pinned`/`layout`: the layout is Applications1's alone. Only position, icon size and
  indicators act in D1.

## 4. The model (pure, unit-tested)

`model.rs` turns (layout, catalogue, windows, preferences) into a `DockView`: ordered
**pinned** entries (apps, the `default-handler:inode/directory` entry resolved to the
current default app, folders), a separator, **running** unpinned app groups in order of
first observed live window, a separator, **minimized** windows (one slot each, dialogs
minimized with their parent folded in), and **Trash** last. Empty sections and their
separators vanish. Focus changes never reorder.

A minimized slot draws the window's **picture** (`thumbs.rs`): captured once per minimize
through nk-wayland's capture client (Hyalo lists the window under its id in hex and keeps
its last frame), at most 256 px a side, its proportions kept, with the app's icon at 45 %
in the bottom-right corner. Each dock captures only the minimized slots it shows: at most 8
pending and 32 MiB kept. A restored or closed window loses its picture; a lock or a
fullscreen window hides the dock and wipes every picture (zeroed before it is freed). A
failed capture keeps the app's icon for that minimize and is not retried; never an older
picture.

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
size, no scrolling, no dropped items. Until a Rust bar exists, the top reservation is
ONE provisional value held by the hub (the TS bar's `BAR_H` = 36, its exclusive zone,
which already includes its own top margin), replaced by the real reservation later. It
is never inferred from a layer's height, the 4 px gap is not added twice, and it is not
subtracted again when the configured size already left it out. Checked with corners at
scales 1, 1.25 and 2.

Position changes go through `set_layer_placement` on the same surface (T1); no
recreation. The input region is the resting capsule.

## 6. Actions

- **Launch.** Applications1 `Launch(epoch, id, generation, {Mode: activate, ActivationToken,
  RequestId})` with a token from the click's real serial (`request_activation_token`).
  The answer is admission only, never focus or a ready window. Until A2 advertises
  `launch`, a click on an app with no windows
  reports the launch as unavailable (a visible, accessible state) and does nothing
  else: there is no fallback through Exec, uwsm, gtk-launch or the TS shell (Codex,
  Palomar #959 #739). Tests use a fake Applications1 on a private bus.
- **Focus, minimize, restore.** Hyalo `do focus-window ID`, `do minimize ID`, `do
  unminimize ID`, re-reading the window first so a reused ID is never acted on. The
  rules of contract §8 "Clicks": one visible window → focus, or minimize if focused;
  only minimized → restore the most recently minimized; two or more visible → focus the
  most recently focused (the chooser is D2).
- **Minimize targets.** `minimize_targets(output, "nidara-dock", {id: rect})` from the
  laid-out slots, in layer-local logical coordinates. Every dock shows every app, so the
  HUB picks one dock per window (its current output's, else a fixed remaining one) and
  only that dock publishes it; docks never overwrite each other's targets.
- **Folders.** Applications1 `OpenDirectory` (A2, `open-directory`), local directories only.
- **Trash.** Its slot is always there. Opening it is `Launch` of the DefaultDirectoryApp
  with `Mode: open` and `Uris: [trash:///]`, which A2 accepts only when that handler
  takes URIs/inode-directory; otherwise the slot says it cannot open (A2 closes this in
  the contract, #741). Never the physical Trash/files folder, never xdg-open.
  Full/empty comes from GIO's `trash:///` item count (every volume, gvfs); without gvfs, the
  home Trash alone, which the accessible description calls partial; unknown is said too.
  Its art is the icon theme's, both looks fetched up front (Applications1 `GetTrashIcon`),
  so filling or emptying swaps it at once; Nidara's `nd-user-trash` on a faint tile only when
  the theme has none. Emptying is D2 (it needs the menu).

## 7. Keyboard and accessibility

One roving focus with a visible ring; arrows along the axis, Tab/Shift+Tab wrap,
Enter/Space act, Escape leaves. `nk-a11y` exposes the dock as a toolbar of buttons with
name, state (running, minimized, launch unavailable) and the same action dispatch as a
click. `Super+Ctrl+D` reaches it through `Shell1` `focus:dock`, the typed contract of
`crates/nidara-shell-ipc` (IPC B, merged in #978).

As built:
- The focus is drawn as an ink ring just outside the icon (the dark skin's white), not the
  accent. The dock takes the keyboard (layer-shell `exclusive`) only on a focus request and
  gives it back on Escape, after acting, or when the compositor moves the focus away. A
  click never takes it from the app.
- This process serves Shell1 (`shell1.rs`) on a connection of its own: capabilities
  `focus:dock` only; `FocusSurface("dock")` goes to the focused window's output's dock,
  Unavailable while locked or with no dock, `bar` Unavailable, anything else Invalid; the
  other members answer Unavailable, never a silent no-op. GetState is the hub's lock with
  no surfaces and no island; StateChanged follows the lock. Both are the common
  Read/OpenSurface policy, open to any caller. When the name is taken (the TS shell owns
  `org.nidara.Shell` in its session) the dock runs without it.
- Hyalo gives an `exclusive` top/overlay layer the keyboard at once and keeps it there
  (as sway, KDE and niri do), so the dock gives it back itself: Escape, acting, losing
  the focus, or the focused window changing under it (a click on another window).
- The tree (`semantics.rs`): a `Window` named Dock, one `Button` per item in drawn order
  (separators as `Separator`), the state in the description (running, minimized window,
  has minimized windows, not installed, cannot be opened now), disabled when a click
  would do nothing, the roving focus as `focused`. Activate does what a click does, with
  no activation token (there is no input event behind it). Requests made against an
  older tree are dropped. The strings are English until the Rust shell has i18n.
- The skin stays dark whatever the system mode (owner's decision). Reduce transparency
  (`org.nidara.appearance`) picks the tokens' solid variant.

## 8. Evidence for D1

- Unit tests: matching, sections, ordering, fit scale, view diffing, Applications1
  hydration with queued signals (fake), click rules.
- A nested check (`toolkit/shell/check-dock-headless.sh`, the T1 harness): private Hyalo
  + private sessiond `--applications` + fake desktop files; the dock surface persists
  across bottom/left/right, follows output hotplug, reads back windows, publishes target
  rectangles inside its slots, and libatspi walks every item.
- A private nested session (`scripts/dev/rust-session.sh --applications nidara-shell`)
  for the owner to look at. Not the daily session, no install, no sudo.

# The Rust dock, D1–D2 (#959)

**Status: DESIGN, reviewed by Codex (Palomar #959 #741), 2026-10-31.** The owner authorized D1 in Claude's chat
("fusiona A1 y empieza D1"). The contract it implements is
`session/design/APPLICATIONS1-DOCK.md` (A1, #976) §8 and the D1 row of §10. This file only
says how D1 is built and what it leaves to D2/D3/D4; where the two disagree, the contract
wins and this file is wrong.

D1 is the visible baseline: one dock per output with pins, running apps, minimized
windows and Trash; Files as the default directory handler; click to launch, focus,
minimize and restore; the fixed margin and uniform shrink; keyboard and AT-SPI;
`Shell1` `focus:dock`.

D2 adds what the contract's D2 row lists: the app, window and dock menus; the bounded
window chooser; new window, middle click and scroll; indicators, attention, Unity counts
and progress; tooltips; magnification; auto-hide; resizing from the separator, with its
accessible adjuster; and the Dock page of the native Settings. Each has its paragraph
below. Still to come: foreground usage and drag and drop (D3), and the Apps launcher
(D4).

## 1. Where it lives

`toolkit/shell`, package and binary **`nidara-shell`** (the contract's working name; the
installed path will be `/usr/bin/nidara-shell`, role `shell` in nidara-access). It is an
ordinary member of the toolkit workspace and uses only toolkit crates: `nk-wayland` (the
layer roots, outputs, tokens, captures), `nk-render`/`nk-text` (pixels, labels),
`nk-a11y` (the semantic tree), plus `zbus` for Applications1/Config1 and the existing
JSON socket for Hyalo. No second Wayland host, no TS bridge, no GTK.

**In a real session, before D4.** `hyalo/scripts/install-preview.sh` installs it at
`/usr/bin/nidara-shell` (the path nidara-access grants the shell role) with
`bin/nidara-dock.service`. `gsettings set org.nidara.dock native-preview true` makes the
Hyalo preview session use it from the next login: `/usr/lib/nidara-hyalo/start-shell` (Hyalo's
autostart) reads the key, starts nidara-sessiond with `--applications` through
`NIDARA_SESSIOND_PREVIEW` and starts this dock; the TS shell, reading the same key, draws no
dock. Config1 is still the TS shell's there: it takes this dock's `dock.*` writes by its
executable (`ui/shell/core/ConfigService.ts`). Hyprland and the package are untouched; the
key and the unit go at D4.

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
  IconRevision, pixel size). With magnification on, each icon is fetched twice, at the
  icon size and at the largest magnified size, and drawn from the second once it grows
  past the first: the resting art stretched to twice its size came out pixelated. A miss shows a neutral placeholder, never another app's
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
picture. A window Hyalo has not listed to the dock yet is not a failure: a dock started (or
restarted) with windows already minimized asks before the list arrives, so it asks again
every 100 ms for 2 s (`thumbs::LISTING`) before keeping the icon.

Window → app matching before H1 is a pure lookup against the catalogue, in the
contract's order: exact current app_id as DesktopId (with and without `.desktop`), exact
StartupWMClass, verified Flatpak ID; when none of those hits, the id and StartupWMClass
again ignoring ASCII case (owner, 2026-11-02: ChatGPT's window says `Chatgpt` for
`chatgpt.desktop` and was left an iconless stranger beside its own pin); then the same
for the initial app_id. Ambiguous stays ambiguous and gets its own `window:<epoch>:<id>` group; title and executable never choose an app.

**Signals (D2).** Each slot carries a `Signal` beside its windows: a **count** and a
**progress** from the app's Unity record in Applications1 (`Launcher`, shown only while
the app makes it visible; a zero count is no badge), and **attention**, true when Hyalo
flags any of the slot's windows (`demands_attention`, refreshed on `attention_changed`)
or the app's Unity `urgent` is set. Display only: attention never focuses anything. The
count is a pill in `--nidara-danger` (carried into the glass tokens as `danger`) in the
icon's top-right corner, inside its square (owner, 2026-11-02: out of it, it reached into
the gap and touched the separator; a long figure grows it leftward), its figure in the menus' font and weight (the fonts have no
bold, and the text engine refuses to fake one); the progress is a bar along the icon's
foot, a dark rim around a faint ink track so it reads over light and dark art. Attention
never changes the running dot (owner, 2026-11-02: the dash it used to draw broke the
dock's look; the reference dock only bounces); each new false→true edge lifts the icon three times in 3 s (`attention.rs`), by at most half the capsule's
padding so the icon and its count stay inside the surface; repeated `true` restarts
nothing. Reduced motion (`org.gnome.desktop.interface` `enable-animations` off, the key
the appearance portal reads) drops the lift, and with it the only visible sign. A reader hears the
same: "3 pending, 50% done, wants attention". The private check sends a real
`LauncherEntry.Update` signal and checks that all of it goes when the sender does.

## 5. Geometry

From the existing TS dock, so the two look alike: padding 10 and gap 4 at every icon size
(owner, 2026-11-01, after the reference dock, which keeps both fixed; they were 0.22 and
0.16 × icon), capsule radius = half the cross size with exponent 3.2, screen gap
`DOCK_SCREEN_GAP` = 4 logical px, dot 5 px. The glass is Hyalo's: one `Pane` per dock
with the exported `dock` tone (`tokens/glass.json`, by mode and reduce transparency); the
client paints only icons, dots and the separator (commandment 12).
Dots and the separator are placed on whole device pixels where they rest (crisp), and from
there are carried exactly as far as their icon moves, never rounded again (`follow` in
`dock.rs`): they glide with the icons and keep one constant sub-pixel offset from them.
At rest they sit on a rounding edge (a 5 px dot, a 1 px line), so snapping where they are
flipped them a pixel at the first hundredth of movement, and snapping the movement still
stepped them while the icons glided.
The separator, a single pixel, would read blurred split evenly between two pixels while it
moves; it stays whole in one pixel most of the way and crosses to the next over the
middle 0.6 of a pixel, easing in and out (`hand_over`): continuous, never a jump, split only briefly.
Stopped mid hand-over (the pointer resting with the strip grown) it would stay split, so
once the strip has not moved for 50 ms it slides onto the nearer whole pixel over a few
frames, and back as soon as the strip moves again (`settle`).

**Magnification (D2).** With `magnification` on, resting the pointer on the strip grows
the icons under it on the TS dock's bell: a gaussian of sigma 1.1 slots, icons toward
`max-icon-size` (absolute logical px), separators growing 0.4 of that. The surface is an
**envelope** laid out once per configure (`geometry::envelope`): headroom across the
dock (at most a third of the output) and slack at both ends of the main axis, so a grown
icon never needs a new surface size; the exclusive zone stays the rest capsule's. Only
the glass and the grown icons take input (the input region follows the strip), so the
envelope's empty room passes clicks through, except a **reach** beside the resting glass,
at its height, three sigmas long (where the bell is down to about 1 %): there the pointer
coming in from a side already grows the end icons, as on the TS dock (which took the
pointer 250 px past each end). A press there does nothing; only the glass opens the dock
menu. The strip stays **centred** where it rests and grows the same on both sides,
whichever side the pointer comes from, as on the TS dock (owner, 2026-11-01). It was
anchored at the pointer until then: it grew only away from it, followed the pointer out
by a side and jumped back to the middle once the magnification eased out. Centred, the
item under the pointer still stays under it (the bell grows it more than its neighbours
push it), which the unit tests check at both ends and in the middle. Presence eases in on entry and out on leave on
the TS dock's spring (`spring.rs`: stiffness 320, damping 38, from rest, no overshoot;
snapped under reduced motion) at the TS dock's speed, 2.4× wall time (`SIM_SPEED`, so
mostly there in 125 ms), its clock started with the change and a frame advancing at most
1/25 s of it (`MAX_DT`). At the nested session's 25–30 frames a second that cap slows it
about threefold, as it would the TS dock; at 144 Hz it never bites. The 60 ms exponential it replaced started at full speed,
and its first step was measured from the last settled frame, so it landed at once
(owner, 2026-11-01); the reader's bounds follow what is drawn, throttled to
100 ms while moving and exact once settled. Targets published to Hyalo stay the rest
rects.

**Auto-hide (D2).** With `auto-hide` on the dock reserves nothing (exclusive zone 0)
and slides out past its screen edge once the pointer has been gone `hide-delay` ms
(`autohide.rs`). It slides as the TS dock did, by the layer's margin on its anchored
edge, eased with an 80 ms time constant (snapped under reduced motion), so the surface
and its layout never change for it. Once out, its input region is only a 2 px strip
along the screen edge, as long as the glass: the pointer pressed against that edge
brings it back. An open menu, the chooser or the keyboard (Shell1 `focus:dock`) keeps
it out until they let go, and the delay starts again from then. Turning the
preference off brings it back. A fullscreen window hides it either way.

**Resize (D2).** A separator is the dock's size adjuster (`resize.rs`). Pressed and
dragged away from the screen edge or toward it, it changes the `icon-size` preference
one logical pixel for one, within Config1's 32..96, measured from the anchored edge so
the surface resizing under the pointer does not feed back. The dock shows only what
Config1 committed: the hub keeps one Apply in flight and the latest value waiting,
dropping the ones in between. Escape or another button mid-drag asks for the size the
gesture started from, through the same Apply. The fit's shrink never writes the
preference. For the keyboard and readers the separator takes the roving focus (the
focus never starts on one); there the arrow away from the edge grows the icons by 8 px
and the arrow toward it shrinks them, and a reader's `SetValue` is clamped and sent the
same way. No resize cursor yet: the toolkit has no cursor shapes.

**The Dock page (D2).** The native Settings draws `dock` from its manifest page alone
(`routing::MANIFEST`, beside `appearance`): position, icon size, magnification and its
maximum, indicators, auto-hide and its delay, all Config1 keys. The maximum is
insensitive while magnification is off and the delay while auto-hide is off. The dock
menu's "Dock Settings…" opens it. The private check drives it when given
`NK_SETTINGS_BIN` (with a stand-in for the portal's Settings on the private bus): every
row is there, the delay is insensitive, the page's auto-hide switch hides the dock and
makes the delay sensitive, and switching it off brings the dock back.

**Pointers.** The tooltip, the menus and the chooser point at their item, as the TS
kit's glass bubble does (`bubble.rs`, after glass-bubble.ts `bubbleGeometry`: 16 × 8, tip
radius 4, base radius 8). Each opens 8 px larger toward its item; once Hyalo has placed
it, the pointer goes on the side that faces the item (Hyalo may have flipped it) and
slides to the item's centre (Hyalo may have slid it), never into the corner arcs. Hyalo
draws body and pointer as one glass (`Pane::pointer`, `add_shape_pointed`). A menu's rows
and the chooser's tiles are laid out and painted for the body alone and copied beside the
pointer's room; their input and accessible bounds move by the same offset. Without
compositor glass the opaque fallback has no pointer (D5).

**Tooltip (D2).** Hovering an item 500 ms names it in a small panel-material capsule
(`tooltip.rs`) on a **passive** popup: no grab, opened only while no menu is up, closed
by any press. Moving to a neighbour while one is shown switches at once (warm), and the
tooltip keeps a fixed gap over the grown icon (popups anchor from the screen edge to
`POPUP_GAP` past the icon or the capsule, whichever reaches further), following it frame by frame as magnification moves it (the strip grows
centred, so the icon under a still pointer shifts). Every popup (tooltip, menu, chooser)
anchors on an even span centred on the icon's rounded centre and has an even size across
it: the compositor halves both in whole pixels, and the floor and ceil of the icon's ends
put popups up to a pixel and a half to its left. Icon art that is not centred in its own
square (Papirus' Trash sits 1.6 % right) still reads off-centre. When the compositor dismisses it the dock retires the
popup at once, or the next menu would find a stale parent.

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
  `org.nidara.Shell` in its session) the dock runs without it. In the preview both start at
  once and either may get there first, so the dock asks with AllowReplacement and the TS
  shell with REPLACE: the name always ends with the TS shell, which `nidara-ipc`, the
  portal's consent and the screen-share chooser need. Without that, a lost race left
  `nidara-ipc` answering UnknownInterface for the whole session.
- Hyalo gives an `exclusive` top/overlay layer the keyboard at once and keeps it there
  (as sway, KDE and niri do), so the dock gives it back itself: Escape, acting, losing
  the focus, or the focused window changing under it (a click on another window).
- The tree (`semantics.rs`): a `Window` named Dock, one `Button` per item in drawn order
  (separators as a `Slider` named Icon size, the size adjuster: its value is the
  committed size in px, `SetValue` asks Config1 for a new one), the state in the description (running, minimized window,
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
  rectangles inside its slots, and libatspi walks every item. It also requires the Trash's
  theme art (both looks) and its fill (a file trashed in the private session), and a
  minimized window's picture. Other output scales: pass a Hyalo config with
  `[outputs.winit] scale = 1.25` (or 2) as `NK_WIDGETS_HYALO_CONFIG`; 1, 1.25 and 2 pass. D2's steps
  pass at all three too (2026-11-01); at scale 2 the nested output is only 636×344
  logical, so magnification grows a 64 px icon to 85 rather than 121, as the envelope's
  bounds say, and the check asks only that it grows.
- A private nested session (`scripts/dev/rust-session.sh --applications nidara-shell`)
  for the owner to look at. Not the daily session, no install, no sudo.

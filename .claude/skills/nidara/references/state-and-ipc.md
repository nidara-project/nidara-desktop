# Nidara — State machine & IPC

Read this when adding a new overlay, wiring a new keybind to a UI action, debugging "overlay won't close", or touching anything that previously used `globalThis`.

## The contract: `core/Status.ts`

All overlay visibility flows through one central GObject. **Widgets never flip each other directly.** A widget that wants to know whether the Control Center is open subscribes to `notify::cc-open` on `status` and reacts to that signal.

### Mutually exclusive overlays

Setting any of these to `true` closes all the rest:

- `cc_open`
- `nc_open`
- `prism_open`
- `system_menu_open`
- `island_mode` (a STRING, not a bool — the Activity Island's open mode id, `""` = collapsed; modes today: `ISLAND_OVERVIEW` (`"overview"`) and `ISLAND_PLAYER` (`"player"`, the media panel). Replaced the old `overview_open` boolean when the overview became the island's first mode — see `surfaces/island/ActivityIsland.tsx`. Note `""` only means no mode is EXPANDED — the capsule's compact content mutates independently (dots ↔ media compact) and is not Status state.)

The exclusion is implemented by the private `closeExclusive(keep, opts)` helper — each setter calls it on open; when adding a new exclusive overlay, add its `_field → notify-name` to the `EXCLUSIVE` map and call `closeExclusive` from the new setter (don't touch the other setters). Two string-valued members are special-cased: `island_mode` is cleared explicitly inside `closeExclusive` (it can't live in the boolean `EXCLUSIVE` map), and `bar_expanded_id` (the pill expansion capsule) is a **one-way member**: setting it non-empty closes the overlays, and the overlay setters clear it via `opts.barExpanded`. New island MODES are NOT new Status fields — they're new ids for `island_mode`, registered in `ActivityIsland` (mode ids are exported from `Status.ts` so core/IPC/surfaces share one vocabulary).

### Other tracked props

- `about_open` — `AboutWindow` is create+destroy, not hide: `app.ts` listens on `notify::about-open` and creates/destroys the window. Flipped by `status.toggleAbout()` (the system-menu item, and the `toggleAbout` IPC action).
- `settings_open` — Settings hides on close instead.
- `recording`
- `cc_edit_mode`
- `bar_expanded_id` — which Bar pill is currently expanded.
- `cc_detail_id` — which CC detail panel is active.

### Toggles

`Status.ts` exposes typed togglers: `toggleCC`, `toggleNC`, `togglePrism`, `toggleSystemMenu`, `toggleIsland(id)` (+ `toggleOverview`, an alias for `toggleIsland(ISLAND_OVERVIEW)` — also still the IPC action name), `toggleAbout`. There's also a convenience getter `isAnyOverlayOpen`. `dumpState` reports both `overlays.island` (the mode string) and the legacy `overlays.overview` boolean (back-compat for agents).

### Example flow — opening the CC

```
user clicks bar pill
  → ShellActions.toggleCC()
    → status.toggleCC()
      → cc_open = true
        → notify::cc-open fires
          → Bar.tsx (subscribed) shows CC inside the Bar window
          → updates the layer-shell input region
```

This is the canonical pattern: **events go up through actions, state changes propagate down through `notify::` signals.**

## IPC contract: `ags request`

`ags request '<cmd>'` works out of the box because `app.ts` implements `requestHandler(argv, res)`. Hyprland keybinds call `hl.dsp.exec_cmd("ags request <cmd>")`.

### The IPC surface is self-describing

The commands live in a **declarative table** (`IPC_COMMANDS` in `app.ts`) — name, description,
optional aliases, handler. `requestHandler` is a thin lookup over it; there is no switch.
Two built-in commands make the surface introspectable, so scripts and agents never need to
read source to discover it:

- `ags request listActions` → JSON describing every command (name, desc, aliases).
- `ags request dumpState` → JSON snapshot of live shell state: version, locale, dark mode,
  monitor count, which overlays are open, edit/recording flags. Read state → act → re-read
  to verify: that's the intended agent loop. (`nidara-doctor` embeds this output in
  its diagnostic report.)

Current commands (run `listActions` for the live list): `toggleCC|toggleControlCenter`,
`toggleNC|toggleNotificationCenter`, `togglePrism|toggleSearch`, `toggleAppGrid`,
`openSettings` (alias `toggleSettings`), `settingsPage <pageId>`, `toggleOverview`, `togglePlayer` (media island; errors if no MPRIS player is on the bus), `toggleAgent` (the built-in Assistant island; `Super+A`), `toggleAbout`, `toggleBarOverlay` (alias `toggleGameOverlay`),
`openWindowMenu`, `hideForLock`, `showAfterLock`, `describeConfig`, `getConfig [key]`,
`setConfig <key> <value>`, `screenshot [path]`, `queryUI [selector]`, `listApps`, `launchApp <id>`,
`disableComputerControl`, `notifyComputerAction` (computer-use tools ping it so the bar's AI-control
indicator pulses "active"), `agentPointer …` (drives the fake-AI-cursor visual — see the
computer-use section), `listActions`, `dumpState`, plus the **window/workspace management**
cluster (see below): `listWindows`, `listWorkspaces`, `focusWorkspace <id|±1|name>`,
`focusDirection <l|r|u|d>`, `focusWindow <window>`,
`closeWindow <window>`, `moveWindowToWorkspace <window> <wsId>`, `toggleFloat`/`toggleFullscreen`/
`centerWindow`/`togglePin`/`togglePseudo` `<window>`, `toggleGroup [window]`,
`moveWindowOutOfGroup <window>`, `sendWindowToSpecial [name] [window]`, `setLayout <dwindle|master>`.
Aliases are intentional — Hyprland keybinds were renamed at one point and old names are kept.

**One member of that cluster is GATED: `closeWindow`** (`ai.allowWindowClose`, default **true**).
The rest stay ungated on purpose — focus, move, float, fullscreen, pin, group and layout are all
reversible, so they are the shell driving its own compositor. Closing is the one that can destroy
unsaved work, and "the model misread a sentence" is a realistic way to reach it (user's call
2026-07-21). Default true because it *asks* the window to close rather than killing it, so an app
with unsaved work still gets to prompt, and "close the browser" is a reasonable thing to ask an
assistant. The gate is enforced in the SHELL's IPC handler like every other gate — never in the
daemon.



`screenshot [path]` captures the focused monitor with grim and returns the PNG path
(default `/tmp/nidara-shot-<ts>.png`) — the visual-verification leg of the agent
loop: open a surface (`toggleCC`, `settingsPage X`), wait ~1.5 s, `screenshot`, read the
image. Gated by Settings → AI (`allowScreenshot`), separately from config writes —
capturing the screen is privacy-sensitive. `dumpState` also reports the **effective**
Hyprland config (gaps/rounding/border via `getoption` — includes `hyprland-user.lua`
overrides) and the AI-governance flags.

`queryUI [selector]` (`core/UITree.ts`) is the **assertion** leg — it turns "screenshot +
eyeball" into a programmatic check. It walks every **mapped** toplevel and returns a FLAT
JSON list of on-screen widgets carrying signal (a test-id, a CSS class, visible text, or an
interactive GType), each with a `path` of ancestors and `bounds`. Read-only, **ungated** like
`dumpState` (a diagnostic read), with one safeguard: text of password/masked entries is
returned as `‹redacted›`. Selectors: `.cssClass`, `#id` (the widget's `set_name()`, not its
GType), `Type` (substring, case-insensitive), optionally scoped `selector@window`.
Two gotchas learned building it: (1) **overlays live under the `nidara-bar` window**
(commandment 5), so scope the CC/NC/menus with `@bar`, *not* `@control`; (2) `pageBox(id)`
sets the id as a **CSS class**, so a Settings page is `.display-page`, not `#display-page`.
Examples: `ags request queryUI .bar-app-name` (assert the focused-app wordmark text),
`queryUI .nidara-list-title@settings` (assert a Display monitor section rendered),
`queryUI .nidara-menu-row` (a flat menu's rows). It pairs with the deterministic show
actions (`settingsPage X`, `toggleCC`) — open, then `queryUI` to assert — and avoids
synthesizing clicks. Some surfaces only open on a click, so they get a **deterministic
interaction hook**: an IPC action that invokes the *same handler* the click would, no
synthetic input. The first is `openWindowMenu` (the AppTitle capsule menu — `ags request
openWindowMenu`, then `queryUI .nidara-menu-label` for its rows). The pattern: the
widget that owns the menu registers a `shellActions.openWindowMenu`-style fn (it needs the
widget's local anchor/builder/state), and a thin IPC command calls it — see `ShellActions.ts`
and `AppTitle.tsx`. The second is `toggleAbout` (the About window used to be reachable only
by clicking the system-menu item): it flips `status.toggleAbout()` and the existing
`notify::about-open` listener in `app.ts` creates/destroys the window — so About is openable,
readable and closable agent-side (`toggleAbout`, then `queryUI .about-spec-val@about` — the
window's name is `nidara-about` — or check `dumpState` → `overlays.about`). Add more the same
way (e.g. a dock context menu) when a click-only surface needs verifying. NB: menu **row text** lives on the child `.nidara-menu-label`
label, not the `.nidara-menu-row` button container (queryUI reports own text, not
descendant text), so assert against the label class. Tier 1 is structure+text; semantic per-widget state (slider value,
dock-item running/active) is a deferred opt-in tier the widgets would cooperate on, sharing
the same node model the AT-SPI2 backend now fills for third-party apps (see "computer-use"
below — `queryUI` is the shell's own toplevels; `query_app` is the same shape via AT-SPI).

Commands receive arguments: `requestHandler` passes `argv.slice(1)` to the handler
(`run(args)`). `ags request settingsPage bluetooth` opens the Settings window directly on
that page (sidebar category ids; returns `unknown page: <id>` for bad ids) — the agent-
friendly way to reach a Settings page without synthesizing clicks.

### Window & workspace management (ungated, the shell driving its own compositor)

Hyprland **is** Nidara's compositor, so window-manager operations — switch
workspace, focus/move/close a window, float/fullscreen/pin/group it, set the tiling layout —
are a **first-class shell capability, not computer-use**. They are deterministic (they target
the compositor by window address, no synthetic input, no focus race) and **ungated**, the same
reasoning as `launchApp`: a WM op reaches into no third-party app's internals (the `allowComputerControl`
gate stays on the things that DO — synthetic keyboard/pointer and AT-SPI actions). The MCP path
still has its global `allowMcp` floor; local `ags request` is always available.

- **Reads** (ungated, like `dumpState`): `listWindows` (authoritative, async — reads `hyprctl
  clients -j` via `HyprlandState.getClientsJson`; carries `floating`/`fullscreen`/`pinned`/`grouped`,
  which the cached `AstalHyprland.Client` props get wrong) and `listWorkspaces`
  (`HyprlandState.getWorkspacesJson`; `active` = focused, plus the window count and special flag).
- **Actions**: `focusWorkspace <id|±1|name>` (absolute id, relative `+1`/`-1` → the cycle-incl-empty
  `e±1` the wheel binds use, or a Hyprland workspace string like `previous`/`name:foo`),
  `focusDirection <left|right|up|down>` (move focus spatially — benign), `focusWindow <window>`,
  `closeWindow`, `moveWindowToWorkspace <window> <wsId>`, `toggleFloat`, `toggleFullscreen`,
  `centerWindow`, `togglePin`, `togglePseudo`, `toggleGroup [window]`, `moveWindowOutOfGroup`,
  `sendWindowToSpecial [name] [window]`, `setLayout <dwindle|master>` — one thin IPC command per
  **already-built, live-verified** `HyprlandState` dispatch method (the same ones the AppTitle
  window menu / dock / overview / arrow-key + wheel binds call). All of `focusWorkspace`/
  `focusDirection`/`focusWindow` ride Hyprland's **one unified `hl.dsp.focus` dispatcher**
  (`{ workspace | direction | window }`).
- **`<window>` is resolved by `resolveWindow(arg)` in `app.ts`** — accepts an exact address
  (`0x…`, what `listWindows` reports — precise) **or** a class/title substring (`firefox`). Every
  window-targeting command shares it, so they all take the same flexible argument.
- **`focusWindow` is ungated** (it used to be gated as the synthetic-keyboard precondition).
  Focusing a window is benign — exactly what a dock click or `launchApp` already does ungated —
  and the gates that matter (`type_text`/`press_key`/`click_*` + AT-SPI `do_app_action`) still
  apply and still focus-verify. So there is now **one** focus path, shared by WM use and the
  computer-use keyboard loop.
- **MCP**: the two reads get dedicated tools (`list_windows`, `list_workspaces`, parity with
  `dump_state`/`query_ui`); the actions go through `run_action` (the established pattern — action
  verbs need no dedicated tool, their `listActions` description is the documentation).
- IPC `run` may now return a **Promise** (`requestHandler` awaits it) so `listWindows`/`listWorkspaces`
  can read authoritative async compositor state.
- **Deliberately NOT built — directional window-move (`movewindow l/r/u/d`) and resize
  (`resizeactive`)**: both classic dispatchers act on the **active window only** (no window
  selector), so they're inherently focus-dependent (the focus-race class — see
  `feedback_no_focus_dependent_scripting`) AND their `hl.dsp.*` Lua names aren't in our config to
  copy (guessing risks a silent-fail `.catch` no-op — the lesson behind the four broken methods).
  Low agent value too (moveWindowToWorkspace/float/fullscreen/center already cover relocation).
  If wanted later: verify the Lua dispatcher name first (don't guess), and consider that they only
  make sense right after a deterministic `focusWindow`.

### `Client.fullscreen` is an enum, not a boolean (maximize ≠ fullscreen)

`AstalHyprland.Client.fullscreen` is the `Fullscreen` **enum** (`NONE`/`MAXIMIZED`/`FULLSCREEN`),
NOT a boolean — a plain `!!client.fullscreen` is truthy for **maximize** (`Super+M`, FSMODE 1)
too, not just real fullscreen (FSMODE 2). That mismatch used to make maximizing a window hide the
dock, blank the bar and release its top reservation, because the bar/dock chrome-hiding watchers
rode that truthy check. Chrome-hiding now keys off **`HyprlandState.isRealFullscreen(client)`**
(true only for `FULLSCREEN`), so **maximize deliberately keeps all chrome visible + clickable**
(fill-the-workspace, the Windows/GNOME maximize convention). Only real fullscreen hides the bar,
and `Super+B` / `toggleBarOverlay` still promotes it to the OVERLAY layer above the fullscreen
window. When you need the authoritative int instead of the cached enum, read `HyprlandState.
getClientJson(addr).fullscreen` (`hyprctl clients -j`: `0` none / `1` maximized / `2` fullscreen).

### Hyprland reports "no active window" when OUR OWN layer surface drops a keyboard grab

Read `HyprlandState.focusedClient`, **never `AstalHyprland.get_default().focused_client`** — the raw
property lies, and it stays lying.

Measured on the Hyprland event socket (2026-07-26, one open/close of the island's overview):

```
  1.62  MARK   ==> OPEN overview        # taking an EXCLUSIVE grab emits NOTHING
  4.25  MARK   ==> CLOSE overview
  4.27  EVENT  activewindow>>,          # releasing it announces "no active window"
  4.27  EVENT  activewindowv2>>
  6.79  MARK   hyprctl activewindow = [kitty]     # …while the window is still right there
```

Releasing an EXCLUSIVE keyboard grab makes Hyprland announce that nothing is focused. Whether a
restoring `activewindow>><class,title>` follows is **not guaranteed**: it depends on Hyprland's
`refocusLastWindow()` succeeding, which needs an eligible last window still on the visible workspace
and no keyboard-focusable layer under the cursor. When it does follow it lands within a millisecond
(that is the normal case since the `ON_DEMAND` fix below); when it does not, AstalHyprland's
`focused_client` goes null and **stays** null. The one thing that heals it then is an *unrelated*
re-emission — Hyprland re-sends `activewindow>>class,title` when the focused window's **title**
changes — which is why a terminal with a spinner recovers by itself within a second and an idle
browser stays "unfocused" indefinitely. That intermittency is what makes this look like a rendering
bug instead of a state bug. The trace above was captured while the dock still rested in `ON_DEMAND`,
which suppressed the restore entirely; the reconciliation stays regardless, because the null is
always emitted first and the restore is only usual, not certain.

It is never only a cosmetic bug, because *everything* asks who is focused: the bar's title capsule
falls back to the workspace name, `WindowMenu` finds no window to act on, `DockItem` loses its focus
ring, and "screenshot the focused window" has no target.

`HyprlandState._refresh` therefore reconciles focus before computing its state signature: it keeps the
last address Hyprland genuinely reported as focused and re-validates it against the live client list —
still open, **and still on the focused workspace**. Two consequences worth keeping:

- The workspace check is what makes it correct rather than a patch. Without it, switching to an empty
  workspace would keep showing the window you left behind on the previous one.
- Reconciling *before* `_stateSignature()` means a grab release is not a structural change at all, so
  nothing repaints and the capsule never even blinks.

The rule this encodes, and the one to preserve if you touch `getWordmark`: **the workspace name is the
fallback for an empty workspace, not for "the compositor went quiet".**

#### The compositor's LIVE answer needs the same validation — it can be confidently wrong

The reconciliation above only guarded the *null*. The mirror-image failure is a non-null lie: while a
layer surface holds an EXCLUSIVE grab, Hyprland **refuses to move window focus at all** (`rawWindowFocus`:
"Refusing a keyboard focus to a window because of an exclusive ls"). So switching workspace from the app
grid's workspace strip — which switches *without* closing, keeping its grab — leaves `focused_client`
naming a window on the workspace you LEFT. No event, no null, just a stale answer that the title capsule
repeated back. Measured 2026-07-26: standing on ws4 with the grid open, `hyprctl activewindow` still named
the ws1 terminal, while ws4's own `lastwindow` correctly named the browser.

So `focusedClient` enforces one invariant on both halves: **the focused window is always on the focused
workspace.** The compositor's live answer is used only if it satisfies it; otherwise the fallback chain is

1. the remembered address, if still open **and** still here (the grab-release case above), then
2. the focused workspace's own `last_client` — Hyprland's `lastwindow`, i.e. the window that workspace
   *would* focus. Still the compositor's answer, not an invention, and it stays right while a grab blocks
   the focus from actually moving. Re-validated against the live client list, since it can name a window
   that has closed.
3. nothing → `null` → the workspace name (an empty workspace, per the rule above).

One exception is deliberate: a window on a **special (scratchpad) workspace** counts as here. Special
workspaces overlay the active one and announce themselves on `activespecial`, never on `workspace`, so
`focusedWorkspaceId` keeps naming the normal workspace underneath — without the exception, popping the
scratchpad would blank the title.

Note the door: the getter, not just `_refresh`. `_refresh` computes the fallback, but
`get focusedClient()` is what consumers call, and it consults `hl.focused_client` live (so it stays fresh
between refreshes) — the validation has to be *there* too, or the raw value walks straight past it.

#### The same release also UNDOES a workspace switch — and you cannot win that race by ordering

Hyprland does not merely announce the null: it **refocuses the last window**, and focusing a window
that lives on another workspace *takes the workspace with it*. So a surface that switches workspace
and closes in the same gesture — the overview does exactly that — can put the user on an empty
workspace and have the compositor yank them back a few milliseconds later. Only empty targets are
affected: with a window of its own on the target, the refocus lands there and nothing moves. It read
as "sometimes", which is what a race always reads as.

**The obvious fix does not work, so do not re-try it.** Releasing the grab first and dispatching
second changes nothing, because *asking* for the release is not performing it: layer-shell keyboard
interactivity is **double-buffered state**, applied only on the surface's next commit. Measured with
`scripts/dev/hypr-trace.py` against the shell's own log (2026-07-26):

```
t+0 ms    [shell]  set_keyboard_mode(NONE) requested, hyprctl dispatch spawned
t+8 ms    [hypr]   workspace>>5      ← a whole SUBPROCESS lands first
t+12 ms   [hypr]   activewindow>>,   ← our Wayland state only reaches the compositor now
t+12 ms   [hypr]   workspace>>1      ← …and takes the workspace back with it
```

A `hyprctl` subprocess beats our own surface state by ~4 ms. Reordering the two calls left the bug at
12 failures in 21 attempts; an idle tick between them changed nothing either.

What works is waiting for the compositor to **announce** the release — that announcement is the same
`activewindow` null above — which is what `HyprlandState.focusWorkspaceOnGrabRelease(id)` does, with
an 80 ms fallback for the case where nothing was focused and no announcement is coming. Any surface
that switches workspace *while closing* must use it; `focusWorkspace` is for surfaces that stay open
(the app grid switches workspaces without releasing its grab, so it is unaffected).

### How to find out who holds the keyboard: `dumpState.keyboardFocus`

Two of the obvious routes are dead ends (2026-07-26): `hyprctl activewindow` reports the focused
**window**, which stays put while a layer surface holds the keys, and `hyprctl layers` does not expose
keyboard interactivity at all. The third — Hyprland's own log — is **not** a dead end, contrary to an
earlier note here: the log looks empty of focus lines only because Hyprland's core logging is off by
default (`debug:disable_logs` defaults to true; everything you see in `hyprland.log` is aquamarine
backend spam, which logs separately). Turning it on is worth doing before theorising about focus, and
there is one catch:

```lua
-- ~/.config/nidara/hyprland-user.lua  (temporary, remove afterwards)
hl.config({ debug = { disable_logs = false } })
```

```bash
hyprctl reload                 # REQUIRED: the logger re-reads the flag only on a config reload,
                               # so `hyprctl eval` alone sets the value and changes nothing
hyprctl rollinglog -f          # then every focus change is announced:
# DEBUG ]: Set keyboard focus to surface 0x…, with [Window 0x…: title: "…"]
```

Pair it with the event socket (`activewindow>>,` = the drop) and you can read the whole handover.

Our side does know, because GDK marks a toplevel active when the compositor sends it
`wl_keyboard.enter`. `dumpState.keyboardFocus` reports that per shell window:

```bash
ags request dumpState | jq -c '.keyboardFocus'
```

```
"nidara-dock":   {"active": true,  "focusable": false, "focusWidget": null}   # ← keys go nowhere
"nidara-bar":    {"active": false, ...}
"nidara-island": {"active": false, ...}
```

`active: true` on a shell surface means the keyboard is going **there**, not to the user's window.
`focusWidget` is what would receive a keypress inside it — `GtkText.prism-search-entry` when Prism is
up, `null` when a surface is holding the keyboard for nothing. **No surface active is ambiguous**: it
means either the user's window has the keys or nobody does. Disambiguate with the event socket — the
drop is announced as `activewindow>>,`.

Repairs ruled out by measurement, so nobody re-tries them: `focusWindow` on the still-active window
(Hyprland no-ops it — the dispatch emits nothing), `focus({ monitor })` (no effect),
`focus({ last })` (works, but focuses a *different* window and can change workspace), and
`cursor.move` nudges (warping the pointer generates no libinput motion, so focus-follows-mouse never
fires — which is why moving the mouse *by hand* cures it and a synthetic move does not).

### THE RULE: a shell surface rests in `NONE`, never in `ON_DEMAND`

`ON_DEMAND` reads like "available but idle". It is not, and taking it literally cost a long hunt for a
bug that looked like four different bugs (2026-07-26). Both halves are in Hyprland's
`src/desktop/view/LayerSurface.cpp` — read them, don't reason from the protocol wording:

- **`onMap`** grabs the seat for *any* interactivity other than `NONE`
  (`GRABSFOCUS = ISEXCLUSIVE || interactivity != NONE`). A surface that maps `ON_DEMAND` takes the
  keyboard **immediately**, so every shell reload left the dock holding it with `focusWidget: null` —
  keys went nowhere until the user moved the mouse.
- **`onCommit`** treats the two ways down from `EXCLUSIVE` completely differently:
  `EXCLUSIVE → NONE` runs `rawSurfaceFocus(nullptr)` **and `refocusLastWindow()`**, which hands the
  keyboard back to the last window; `EXCLUSIVE → ON_DEMAND` only calls `simulateMouseMovement()` — a
  no-op when the pointer has not actually moved. So closing the app grid left the dock holding the
  keyboard, and *that* was the "poisoning" that made every other surface look broken afterwards.

`ON_DEMAND` is legitimate in exactly one shape: **transiently, on a surface that already holds the
keyboard**, because a `Gtk.Popover` cannot take focus from under an `EXCLUSIVE` grab (the app grid's
context menu). It drops to `ON_DEMAND` for the life of the popover and climbs back to `EXCLUSIVE`. It
is never a resting mode.

With every surface resting in `NONE`, the release is clean and measurable — `activewindow>>,`
followed by `activewindow>><the window>` inside 1 ms, on all three grabbing surfaces (bar/Prism,
island/overview+assistant, dock/app grid). `dumpState.keyboardFocus` shows `{}` at rest, and a `{}`
there now means the user's window has the keys, not that they are lost.

**The trap on the way out, and why the previous attempt was abandoned.** Fixing the keyboard exposed a
latent input-region bug that had been masked by it: the dock's layer surface is the size of the whole
screen (`0 0 2560 1440` — it hosts the fullscreen app grid) and sits on `TOP` above the bar, so while
the app grid is open its input region is stamped over everything. `DockAxis.buildInputRegion` dedupes
by a shape key, and the open path used to call `set_input_region(null)` **directly**, bypassing that
cache — so the key still described the *resting* region. On close, `buildInputRegion` recomputed the
same resting key, matched the stale cache and **skipped the restore**, leaving a full-screen surface
eating every click on the screen; only the island, on `OVERLAY`, still got any (which is exactly how
the symptom reads: "the bar capsules are dead, but the Activity Island works"). It self-healed on dock
hover, because magnification changes the key. What hid it before was the compositor's
`simulateMouseMovement()` on the `EXCLUSIVE → ON_DEMAND` release: the fake motion re-entered the dock
and changed the key for us. **Rule: never call `set_input_region` behind a dedupe cache's back** — go
through the function that owns the key.

### The agent config surface: `describeConfig` / `getConfig` / `setConfig`

Settings are exposed to agents through a typed registry (`core/ConfigRegistry.ts`; entries
registered in `config-entries.ts`):

- `ags request describeConfig` → JSON schema of every exposed setting: description, type,
  enum values / min/max, writability, current value. **Read this first** — never guess keys.
- `ags request getConfig dock.iconSize` (one key) / `ags request getConfig` (all values).
- `ags request setConfig appearance.accent blue` → validates against the declared
  type/constraints, applies through the owning service (persists + notifies the UI exactly
  like Settings would), and echoes `{key, value}` back. Invalid input returns a
  self-explanatory error, not a crash.

Rules:
- Writes are **gated by Settings → AI** (`AgentConfig.allowConfigWrite`, `ai.json`). When
  disabled, `setConfig` refuses with a pointer to the page. Reads are never gated.
- `ai.*` keys are visible but **not writable via setConfig** — the gate must not be
  flippable through the door it controls.
- **Adding a setting:** register it in `config-entries.ts` (NOT in core/ — dock settings
  import widget state) with a real `desc` (that string is the agent-facing documentation)
  and delegate `set` to the owning service's setter. That's ALL it takes to appear in
  `describeConfig`.

### The MCP server: `nidara-mcp`

The whole surface above is also served over MCP by `bin/nidara-mcp` (installed to
`/usr/bin`), a standalone GJS script — same no-Node pattern as `nidara-portal` — speaking
MCP over stdio. Two discovery paths, dev and user:
- The repo's `.mcp.json` registers it for any agent working in this checkout.
- `install.sh` always (re)writes `~/.config/nidara/.mcp.json` — the one
  installer-managed file in the config dir — pointing at the PATH binary. An agent opened
  inside the config dir auto-discovers it; any other agent can be told to "register the MCP
  server described in `~/.config/nidara/.mcp.json`" (content:
  `{"mcpServers": {"nidara": {"command": "nidara-mcp"}}}`). The Settings → AI
  page shows this path to the user ("Connect Your Agent" row).

It is a **thin adapter with mostly no logic of its own**: every shell-self-control tool shells
out to `ags request` (or `nidara-doctor`), so the `IPC_COMMANDS` table stays the single
source of truth — a new IPC command is reachable through the `run_action` tool with zero MCP
changes. Tools: `list_actions`, `run_action(name, args)`, `list_apps`, `launch_app(id)`,
`dump_state`, `query_ui(selector)`, `list_windows`, `list_workspaces`,
`query_app(app)`, `do_app_action(app, node, action)`, `type_text(app, text)`,
`press_key(app, key)`, `focus_window(window)` (ungated — a WM op), `click_app(app, node, button?)`, `click_at(app, x, y, button?)`,
`scroll_app(app, node, direction, amount?)`, `scroll_at(app, x, y, direction, amount?)`,
`drag_at(app, from_x, from_y, to_x, to_y)`,
`describe_config`, `get_config`, `set_config`, `screenshot` (returns the PNG **inline as MCP image
content** — the client sees it without a separate read), `doctor`.
(Action verbs like `openWindowMenu` need no dedicated tool — they go through `run_action`; the
dedicated tools are the read/introspection verbs and the computer-use verbs.)

**App listing / launching** (`listApps` / `launchApp <id>` IPC, `list_apps` / `launch_app` MCP
tools) is a first-class **shell capability**, not computer-use: it reuses `AppService`
(`getAllApps()` for the list, `getLaunchCommand()` + the dock's `uwsm app -- sh -c 'cd "$HOME" &&
exec …'` path for launch — origin-aware flatpak/gtk-launch). It only *opens* an installed app; it
does not drive it (that's the gated computer-use layer). **Ungated** by design (parity with a dock
click; bounded to the installed set) — opening a window is low-risk, unlike driving one.

`query_app`, `do_app_action`, `type_text` and `press_key` are the exceptions to "delegates to the
shell": they are the **computer-use** layer's perception, AT-SPI-action and synthetic-keyboard
legs, and they run `nidara-a11y` / `nidara-act` / `nidara-type` directly (like `doctor` runs
the doctor), **not** `ags request` — because reaching into a *third-party* app is not
shell-self-control and must not live in the shell process. See "The computer-use layer" below.

Governance: `ai.json.allowMcp` (Settings → AI → "Enable MCP Server") is re-read on **every**
tool call, so the toggle applies live with no restarts; when off, every tool refuses with a
pointer to the page. The finer gates (`allowConfigWrite`, `allowScreenshot`, `allowComputerUse`,
`allowComputerControl`) are enforced downstream (by the shell, or by
`nidara-a11y`/`nidara-act`/`nidara-type` for the computer-use tools) — never duplicate them in
the MCP layer beyond the live re-read the tool already does. Like the rest of `ai.*`, `allowMcp`
is visible via `describeConfig` but not writable via `setConfig`.

### The built-in Assistant: `bin/nidara-agent` (the brain)

The MCP server exposes the surface to EXTERNAL agents. `bin/nidara-agent` is Nidara's
OWN conversational assistant — and it is deliberately **just another client of the same
gated surface**: its tools ARE `ags request` calls, so Settings → AI gates
(`allowConfigWrite` …) and the kill switch apply for free, and a new IPC action is usable
with zero changes here (`run_action` is a passthrough — 100% coverage, exactly like MCP).

- **Standalone GJS** (same no-Node pattern as `nidara-mcp`), but the INVERSE topology: it is a
  long-running **stdio child of the shell** (spawned by `core/AgentService.ts` in the island
  Agent mode — PR 2), speaking a tiny **JSON-lines protocol**, not MCP JSON-RPC:
  - shell→daemon: `{t:"user",text}` · `{t:"cancel"}` · `{t:"reset"}`
  - daemon→shell: `{t:"state",s:"thinking"|"acting"|"idle"}` · `{t:"delta",text}` ·
    `{t:"tool",name,summary}` · `{t:"toolresult",ok,summary}` · `{t:"done",usage}` · `{t:"error",message}`
- **BYOK, THREE backends** (two native + one universal, and the split is deliberate): Anthropic
  Messages API (`POST /v1/messages`, `x-api-key` + `anthropic-version`) · **Gemini native**
  (Interactions API, `POST {endpoint}/interactions`, `x-goog-api-key`) · any **OpenAI-compatible**
  endpoint (`POST {endpoint}/chat/completions`, `Authorization: Bearer` optional — this is what makes
  a local Ollama, a custom server and most clouds work with one adapter, which on a Linux desktop is
  a feature, not a shortcut). Native for the providers shipped as a first choice, so their quirks
  stop being ours: Google's compat shim cost three defects in one afternoon, all translation
  artefacts. All three **streamed via `curl -N` SSE** as a `Gio.Subprocess` (the house HTTP pattern —
  zero new deps); `cancel` = `force_exit()` the curl.
- **Provider vs protocol** (`core/AgentProviders.ts`): the user picks a provider by NAME
  (Anthropic · OpenAI · Google (Gemini) · Mistral · Groq · OpenRouter · Ollama (local) · Custom);
  the registry maps each onto one of the three wire protocols and pins its endpoint + default model.
  `AgentConfig.setBrainProvider(id)` writes `brainProvider` **and** the derived `brainBackend` /
  `brainEndpoint` / `brainModel`, so **the daemon stays dumb** — it never carries a provider table.
  `brainModels` is per-provider model memory (switching to Ollama no longer leaves
  `claude-opus-4-8` in the field). Adding a provider = one row in the registry + one i18n label;
  brand names are proper nouns and are NOT translated (only Off/Ollama (local)/Custom are).
- **Config re-read from `ai.json` every turn** (`brainProvider`/`brainBackend`/`brainModel`/
  `brainEndpoint`, via `AgentConfig`), so a provider/model change takes effect live. The
  **API key is NEVER in `ai.json`**: it lives in the DE keyring — **libsecret, schema
  `org.nidara.Assistant`, attribute `provider`** (one key per PROVIDER, not per protocol —
  a key belongs to the company that issued it, and Google/Mistral/Groq all ride the openai
  path, so a protocol-keyed slot would make them overwrite each other and return a 401 from a
  provider whose key was just saved). Written by Settings → AI (`gi://Secret` `password_store`/`password_clear`),
  read back by the daemon (`Secret.password_lookup_sync`). All keyring calls are **fail-soft**: a
  session with no Secret Service yet just proceeds keyless (fine for Ollama; an auth error for
  Anthropic). The keyring is unlocked at login via PAM (`pam_gnome_keyring` in `/etc/pam.d/greetd`,
  wired by `nidara-setup`), and `hyprland.lua`'s `gnome-keyring-daemon --start` is what completes
  that daemon's initialization — the unlock does NOT happen without it. Both halves depend on
  `gnome-keyring-daemon.socket` being disabled; if you ever see the Assistant report no key on a
  session where Settings → AI shows one saved, that is the symptom — read "The login keyring"
  in `dev-workflow.md` before touching anything else.
- **Token accounting has three rules, each learned from getting it wrong (2026-07-21).**
  (1) **`done` carries the turn's cost and lives in the `finally`** — it used to sit on the success
  path, so the expensive failures (a 25k-token turn that hit the step cap) reported *zero*. Usage is
  also accumulated BEFORE any early return. (2) **Normalise across backends**: OpenAI-compatible
  `prompt_tokens` INCLUDES cached tokens, Anthropic's `input_tokens` EXCLUDES cache reads/writes —
  so the Anthropic handler adds them back. Without this the same label means two different things
  depending on which provider the user picked. (3) **`cached` is a SUBSET of input, never an
  addition** — the island shows it as a percentage (`5.4k tokens · 74% cached`), because the useful
  question is "is this being re-read cheaply", which a raw count doesn't answer.
- **Read tool calls from their PRESENCE, not from `finish_reason`** (measured 2026-07-21, Google
  `gemini-3-flash-preview` over the compat endpoint): it streams a `tool_calls` delta and then
  finishes with `"stop"`. The loop used to gate execution on `finish_reason === "tool_calls"`, so the
  call was dropped, no tool ran, and the turn ended with nothing to say — **every conversation worked
  once and then went dead on the first turn that needed a tool**. If tool calls accumulated, execute
  them. The per-step log prints `stop=` (how the loop read it) next to `finish=` (the provider's raw
  value) precisely so the next divergence shows up instead of being inferred.
- **Carry the provider's opaque per-call extras back verbatim.** Gemini 3 attaches an encrypted
  **thought signature** to every function call (`tool_calls[].extra_content.google.thought_signature`)
  and answers the FOLLOWING request with a **400** unless it is echoed back inside the assistant
  message's `tool_calls`. So `toolUses` carries an `extra` blob straight from the stream into
  `toOpenaiMsgs()` — never interpreted, never rebuilt, just relayed. Other OpenAI-compatible
  providers don't send the field and don't care. The step log prints `sig=N/M` whenever a turn has
  tool calls: `sig=0/1` against Gemini means the signature never arrived and the echo can't work
  (which would make the compat path unusable for tools → the native backend stops being optional).
- **Anthropic's equivalent of that rule: echo the THINKING BLOCKS back, verbatim.** Same shape of
  trap, found 2026-07-25 by reading the reference instead of by losing a turn to it. The rule (docs
  → thinking → *preserving thinking blocks*): *"when you return a tool result, the thinking blocks
  from the assistant message must come back with it"*, and *"rebuilding the message or filtering out
  `redacted_thinking` blocks triggers a 400 error"*. `toAnthropicMsg()` **does** rebuild the
  message, so the blocks are captured in the handler (`thinkBlocks`), ride on the history entry as
  `thinking` (the Anthropic twin of Gemini's `thoughtSig`; each lane's converter reads its own field
  and ignores the other's) and are re-emitted **ahead of** the text/`tool_use` they belong to. Three
  details that make this easy to get wrong:
  - With the default `display: "omitted"` (Opus 5 / 4.8 / 4.7) **no `thinking_delta` ever arrives**:
    the block opens empty, receives one **`signature_delta`** just before closing, and that
    signature is the whole payload. A handler watching only for text sees an empty block and
    silently drops the one field that has to go back.
  - The lane got away without this only because it never asks for thinking, and on Opus 4.8/4.7
    omitting the parameter means none. **On Claude Opus 5 thinking is ON by default** — the blocks
    arrive unasked, so a tool-using turn on the flagship model would have 400'd on its second step.
  - The newest-turn cache breakpoint must **not** land on a thinking block (adding a field to one is
    exactly the "modified" case), and `max_tokens` is a ceiling on **thinking + answer together** —
    sized for prose alone it turns a normal reply into a mid-sentence cut-off reported as "hit the
    reply length limit". Hence 32768: under the output cap of every current model (Haiku 4.5 is the
    lowest at 64k) so it can never itself become a 400.
  Covered by CI (`agent-loop` scenario 3) — the assertion is on the captured request bytes, so it
  holds without a key. `think=` in the step log now also reports Anthropic's thinking tokens
  (`usage.output_tokens_details.thinking_tokens`, final `message_delta` only).
- **A failing tool call gets TWO strikes, then the turn is aborted.** Measured 2026-07-21: Gemini
  called `run_action` with `{"args":[…]}` and no `action`, was told it was invalid, and repeated the
  identical call **seven times** — the whole step budget and ~25k input tokens on one question. The
  loop now compares `name + rawArgs` against the previous failure and stops on the repeat. Two
  supporting rules: a rejection message must hand the model back **what it actually sent** (a bare
  "needs an action name" told it nothing it didn't already believe), and `history` must receive the
  tool results **before** any abort — every tool call needs its matching result or the next request
  is malformed. Also read `arguments` permissively (string per spec, object from some compat
  endpoints) and **log a JSON parse failure**: swallowing it makes a malformed call look identical to
  "the model sent nothing", which is how this was misdiagnosed at first.
- **Key streamed tool calls by index OR id — never `index ?? 0`.** OpenAI puts an `index` on every
  chunk; **Google's compat layer omits it entirely** and identifies calls by `id`. Defaulting to 0
  filed every call in one slot: two calls merged into one, arguments concatenated into invalid JSON
  (`{"action":"listWindows"}{}`), name overwritten by the last, and the UI showed a `run_action ?`
  chip for a call the model never made that way. This was the real cause of what looked like a dumb
  model. Resolution order: explicit `index` → call `id` → continue the slot being filled (a pure
  continuation chunk carries neither). Keep the slots insertion-ordered so multiple calls execute in
  the order asked for.
- **Tools offered to the model** (five, all executed via `ags request`, gates enforced by the shell —
  a refusal comes back as the tool-result STRING; the daemon never re-checks gates; no
  screenshot/computer-use in v1): `run_action(action, args?)` for every desktop action, plus the
  settings/state cluster `set_config(key, value)`, `get_config(key?)`, `dump_state()`,
  `describe_settings()`.
- **Every desktop action goes through ONE `run_action` tool whose DESCRIPTION carries a name index**
  — `snake_name — first clause of the action's description`, one per line — instead of one first-class
  tool schema per action. The index is GENERATED from `listActions` in `buildToolset()` (cached per
  session), so a new IPC action still appears for free — the self-maintaining property. Measured
  2026-07-23 against the live 42-action shell, same method (the daemon's `body=… tools=Nb` log): the
  whole tool block **8,819 → 3,808 bytes (−57%)**, and the full fixed prefix re-sent on EVERY step
  (`sys`+`tools`) **10,426 → 5,495 bytes (~halved)**. The 32-action index is ~1,600 chars (~450 tok)
  where the same 32 as JSON schemas were ~2,000 tok.
  **Why an index and not 32 first-class tools** (that was tried and committed briefly in `cd459db`,
  then reverted 2026-07-23 at the user's request to cut fixed cost): a text index buys the same two
  things the first-class tools were adopted for, at ¼ the weight. (1) **No discovery round-trip** —
  names + summaries are always in front of the model, so it never spends a request on a `list_actions`
  lookup before acting; the *earlier* run_action design paid that round-trip only because the names
  lived BEHIND a lookup, and moving them into the description is what removes it. (2) **No invented
  names** — the index is snake_case, `run_action` takes a snake_case `action`, and `execTool` maps it
  back (accepting camelCase too). Keep descriptions in the index, not bare names: `toggle_cc` /
  `toggle_nc` / `toggle_prism` are ambiguous, and that one clause is what lets "open control center"
  land in one step.
- **Settings stay their own tools, deliberately.** `describe_settings()` gates a ~4 KB schema whose
  size-to-lookup ratio genuinely pays for on-demand loading, and the model must call it once before a
  `set_config`/targeted `get_config` (never guess a key). `run_action` resolves ONLY the visible
  actions in `actionMap` — the config door is these dedicated tools, and hidden plumbing stays
  unreachable, so run_action opens no gate the tool list doesn't already advertise. The static core
  also carries a one-line **capability summary** + an explicit rule to answer "what can you do?" from
  it (never a tool) — a reply built from 42 raw IPC names is a worse answer than one from a curated
  summary; costs ~50 tok on every request, worth it for the better answer as much as the cheaper one.
- **The cost of the index design is compliance** — a model that ignores the list will invent a name.
  Three defences, keep all three: the core rules are imperative ("pick a name from the list, never
  invent one, never look actions up"), the `run_action` description repeats "this list is the
  COMPLETE set", and its rejection hands back the exact name it sent. If a model is seen guessing,
  strengthen those before reverting to fatter tool schemas. Side benefit: `buildSystemPrompt()` never
  calls `ags request`, so the daemon doesn't depend on the shell being up at spawn.
- **Two lossless squeezes stay** (both still in `buildToolset`/`execTool`): **`compactJson()`** strips
  the pretty-printing the shell emits for humans (tool results ride in `history` and are re-sent every
  later step, so this matters more there than in the prompt), and **`HIDDEN_ACTIONS`** is a denylist
  keeping out actions already offered as dedicated tools (`getConfig`/`setConfig`/`dumpState`/
  `describeConfig`), the redundant `listActions`, and shell-internal plumbing (`hideForLock`,
  `agentPointer`, the kill switch). Denylist on purpose: a NEW action still appears in the index for
  free.
- **Token/cache is a PARKED topic (user, 2026-07-22) — don't reopen it with experiments.** What is
  known and stable: `cached` is a SUBSET of input shown as a percentage on the island; the cost driver
  is STEP COUNT, not prompt size (an 8-step turn is ~25k input tokens); Anthropic needs
  `cache_control:{type:"ephemeral"}` on the system block while OpenAI-compat caches implicitly; and
  Google's implicit cache is unreliable with tools defined. `ai.brainProvider`/`brainBackend`/
  `brainModel` are visible read-only via `describeConfig`; the key is never exposed.
- **Test headless with `scripts/dev/fake-brain.py`** (a scripted OpenAI-compatible SSE mock) — see
  `dev-workflow.md`. GOTCHA proven 2026-07-20: the write gate lives in the SHELL (it reads the
  user's REAL `ai.json`), so pointing the daemon at a test config with `allowConfigWrite:false` does
  NOT block a write — a `set_config` E2E hits the live shell for real. Test the daemon's
  rejection-surfacing non-destructively with an INVALID value instead (the validator refuses, nothing
  mutates), or flip the real gate in Settings.

- **A turn NEVER ends in silence — treat this as an invariant, not a nicety** (the worst bug of the
  first live run, tech-debt #39). Every abnormal end has to reach the island: provider error, curl
  failure, empty completion, the `MAX_STEPS` cap, and — shell-side — the daemon dying mid-turn or a
  failed spawn/write. `Turn.error` is a field of its OWN (not appended to `text`) precisely so an
  error that lands AFTER some text already streamed still shows; `AgentService.failTurn()` is the one
  door for all of it, and it re-opens the island when the failure happened with it closed. If you add
  a code path that can end a turn, it must end it through text or through `failTurn`.
- **Telemetry: both halves land in `nidara-ui.log`.** The daemon logs to **stderr, which it inherits
  from the shell** (`Gio.Subprocess` is spawned with STDIN/STDOUT pipes only — do NOT pipe stderr, that
  would swallow it), prefixed `[nidara-agent]`; `AgentService` logs `[AgentService]`. Together they
  cover: spawn (argv) → turn start (provider/backend/model, prompt LENGTH) → each HTTP leg (host, body
  size, whether a key was found) → each step's result shape → each tool + outcome → turn end (duration,
  tokens) → daemon death **with exit status or signal**. `grep -E '\[(nidara-)?[aA]gent' nidara-ui.log`
  reads a whole session. **Never log the prompt or the reply** (a desktop log is not the conversation's
  home) and never the key — shape only. Without this a user's "it did nothing" is unreconstructible,
  which is exactly how the 2026-07-21 silent death was lost.

**UI wiring (the face).** `core/AgentService.ts` owns the daemon subprocess + the transcript and
exposes `send`/`cancel`/`reset` + `subscribe` (see `architecture.md`). The chat lives in the Activity
Island as the **`agent` mode** (`surfaces/island/AgentIsland.tsx`, `ISLAND_AGENT`,
`needsKeyboard:true`) with a matching **`agent` activity** (priority 25 — the "working pill"). IPC:
**`toggleAgent`** → `status.toggleIsland(ISLAND_AGENT)`, bound to **`Super+A`** in `hyprland.lua`.
Two behaviours worth knowing: (1) the agent activity `isLive` = `busy || island_mode===ISLAND_AGENT`,
so closing the island mid-turn does NOT cancel (the pill keeps working) and reopening shows the same
transcript; (2) **expand-on-finish** — when a turn ends with the desktop otherwise idle (`!isAnyOverlayOpen`),
AgentService pops the island open so a background answer surfaces. Being the island's first TEXT mode,
its `handleKey` claims only Escape (everything else falls through to the entry); the bar grants EXCLUSIVE
keyboard while `needsKeyboard()`. The empty state (no provider) routes to Settings → AI.

### The computer-use layer (third-party perception + action)

The agent surface above is the shell controlling **itself**. The computer-use layer is the jump
to perceiving and driving **any** third-party app. Phase 1 — perception, read-only:

- **`bin/nidara-a11y`** (standalone GJS, `gi://Atspi`; same no-Node pattern as
  `nidara-mcp`/`nidara-portal`) reads an app's **AT-SPI2 accessibility tree** and prints
  it in the **same flat `UINode` shape as `queryUI`** (additive a11y fields: `role`, `states[]`,
  `actions[]`, and `shortcuts[]` when present). `nidara-a11y` (focused window, resolved via
  `hyprctl activewindow`) or `nidara-a11y <app-name>`. Read-only: it lists available action
  *names* but invokes none. **`shortcuts[]`** = the AT-SPI key bindings (accelerators) of a
  control's actions, e.g. `["Control+X"]` — often the *only* semantic handle on a label-less
  control: **GTK4 popover-menu items expose no accessible name/text** (verified: `name`/`text`/
  child node all empty), but they DO carry their accelerator, so `Control+X`⇒Cut, `F2`⇒Rename,
  `Delete`⇒Move to Trash. Items with no accelerator (e.g. "Move to…") still need vision —
  this is the **hybrid** at work (AT-SPI for structure + shortcuts + the `focused` state for
  navigation tracking; screenshots read the labels AT-SPI hides). Carries `UITree.ts`'s password
  redaction; caps nodes/depth + a soft deadline (AT-SPI calls are sync D-Bus and can hang — that's
  why it's a separate process, never the shell's main loop).
- **Gate: `ai.json.allowComputerUse`** (Settings → AI → "Allow Agents to See Other Apps"), the
  **only gate that defaults OFF** — it reaches outside the shell (privacy-sensitive, ≈ the
  screenshot gate). Enabling it (via `AgentConfig.setAllowComputerUse`) also turns on
  `toolkit-accessibility`, since the capability is useless while a11y is globally off. Re-read
  live by both `nidara-a11y` and the `query_app` MCP tool.
- **Coverage caveat**: GTK4 exposes its tree on Wayland regardless; Qt needs `QT_ACCESSIBILITY=1`
  (which `allowComputerUse` triggers via `toolkit-accessibility`, so Qt shows a "screen-reader
  mode" banner); Chromium/Electron need `--force-renderer-accessibility`; the rest fall back to
  `screenshot` (vision). AT-SPI screen coords are unreliable on Wayland → bounds are
  **window-relative**.

Phase 2a — **action, deterministic only (built)**:

- **`bin/nidara-act`** (standalone GJS, `gi://Atspi`; SEPARATE binary from `nidara-a11y` so
  perception stays read-only) invokes a **named AT-SPI action on a named accessible** via
  `atspi_action_do_action(i)` — `nidara-act <app> <node-name> <action> [role] [occurrence]`.
  **No coordinates, no synthetic input**: it targets the accessible directly, so it is auditable
  and **not focus-dependent** (sidesteps the focus-race class of bug). The agent perceives a node
  (name + `actions[]`) with `query_app`, then acts by name with `do_app_action`. GTK4 exposes
  rich actions (incl. its GActions: `win.go-home`, `view.show-hidden-files`…); Qt often exposes
  only `SetFocus` (focus yes, click no — clicking Qt waits for synthetic input, Phase 2b).
- **Gate: `ai.json.allowComputerControl`** (Settings → AI → "Allow Agents to Control Other
  Apps"), a **second** default-OFF gate distinct from perception. Enabling it (via
  `AgentConfig.setAllowComputerControl`) also enables `allowComputerUse` — you can't drive what
  you can't see. The effective check is `allowComputerControl && allowComputerUse`, re-read live
  by `nidara-act` and the `do_app_action` MCP tool.
- **CC badge + banner**: the model + both consumers live in
  `surfaces/bar/StatusIndicators.tsx` (`ccBadge`, `ccStatusBanner`), shared with the recording
  indicator. While control is granted, a small **badge** on the bar's Control-Center button signals
  it — **subtle** when armed (granted, idle), **pulsing** when active (recording, or for
  ~`ACTING_DECAY_MS` after a real action). The action tools (`nidara-act`/`nidara-type`/`nidara-click`)
  ping `ags request notifyComputerAction` on success → `AgentConfig.pulseComputerAction()` flips the
  transient `computerActing` flag (auto-decays). Opening the CC shows a **status banner above the
  widgets** (`ControlCenter.tsx`) with a row per active indicator + a **Stop** button — **that is the
  kill switch**. Mouse-revoke is **2 clicks** (open CC → Stop) by design; the one-key kill switch is
  `Super+Shift+Esc` (`config/hypr/hyprland.lua` → `ags request disableComputerControl`). The badge
  staying visible while armed means the user is never unaware the agent may act.
Phase 2b-i — **synthetic keyboard (built)**, for controls AT-SPI can't reach (Qt text fields;
Qt buttons that only expose `SetFocus` → focus then press Enter/Space):

- **`bin/nidara-type`** (standalone GJS; wraps **`wtype`**, the Wayland-native
  `zwp_virtual_keyboard`, no daemon; SEPARATE binary, synthetic input never lives in the perceive
  or AT-SPI-action helpers). `nidara-type text <app> <string>` /
  `nidara-type key <app> <keyspec>` (`Return`, `Tab`, `ctrl+a`, `ctrl+shift+t`; `super`→`logo`).
  MCP: `type_text` / `press_key`. The loop: `query_app` → `do_app_action … SetFocus` →
  `type_text`/`press_key`.
- **Same gate as 2a** (`allowComputerControl` + the 2a indicator/kill switch) — no new toggle.
- **SAFETY — focus-dependent**: `wtype` types into whatever window has focus (unlike `do_action`).
  So `<app>` is **required** and `nidara-type` **verifies it is Hyprland's active window**
  (`hyprctl activewindow`) before injecting, refusing otherwise — a keystroke can only land in the
  named app while it is actually focused. This is the deliberate mitigation for the focus-race
  class of bug.
- **`focusWindow <window>` IPC + `focus_window` MCP tool** — raise/focus a window (by address or
  class) so it becomes the active window (the **precondition** for the keyboard). Unlike the other
  computer-use tools, this is a **shell IPC command** (it reuses `HyprlandState.focusWindow`, the
  same path the dock uses on a running-app click — `hl.dsp.focus({ window = 'address:…' })` via
  `hyprctl dispatch`; the classic `hyprctl dispatch focuswindow class:X` is rejected by our Lua
  config). **Ungated** — it's a window-manager op (see "Window & workspace management" above), as
  benign as a dock click; the keyboard/pointer tools it feeds stay gated and focus-verified. The
  full autonomous loop:
  `focus_window telegram` → `do_app_action telegram "<field>" SetFocus` → `type_text telegram "…"`.

Phase 2b-ii — **synthetic pointer (click, right-click, scroll, drag), built**, for what AT-SPI/keyboard
can't reach (canvas, no-a11y surfaces, list items/tabs that need a real click, context menus,
scrolling off-screen content, drag-and-drop / rubber-band selection / sliders):

- **`bin/nidara-input`** — a tiny **C** Wayland client (`zwlr_virtual_pointer_v1`, no daemon/uinput)
  compiled by `install.sh` (`wayland-scanner` + `cc` on `wlr-protocols`' XML; only the `.c` is
  committed, the binary is git-ignored). A **dumb injector**, verbs:
  `move|click|rightclick <x> <y> <w> <h>`, `scroll <x> <y> <w> <h> <dx> <dy>` (signed wheel notches,
  `dy>0`=down, `dx>0`=right — emitted as `axis_source(WHEEL)`+`axis`+`axis_discrete` frames, 15
  units/notch, the wlroots wheel convention), and `drag <x> <y> <w> <h> <x2> <y2>` (press at (x,y),
  glide to (x2,y2) over interpolated motion steps with small real-time gaps, release — the gradual
  travel is what trips drag-threshold/DnD detection; a press→jump→release does NOT register). All
  output-relative logical coords + the output's logical extent. All protocol verbs are available at
  manager **version 1** (what we bind) — adding right-click/scroll/drag needed **no install.sh /
  protocol-version change**.
- **`bin/nidara-click`** (GJS, sibling of nidara-act/nidara-type) owns the smarts: gate +
  focus-verify, AT-SPI node resolution (centre) or a window-relative point, then the **coordinate
  mapping** — `global = window.at + rel` (AT-SPI window coords are logical, like Hyprland's `at`);
  `output_rel = global − monitor.xy`; `extent = monitor.{w,h} / monitor.scale` (hyprctl `w/h` are
  physical). Modes: `app`/`at` (left-click), `rclick-app`/`rclick-at` (right-click),
  `scroll-app`/`scroll-at` (scroll, with `<dx> <dy>` notches), `drag-at` (two window-relative
  points). MCP: `click_app`/`click_at` take a `button` (`"left"`/`"right"`); `scroll_app`/`scroll_at`
  take `direction` (up/down/left/right) + `amount` (notches, default 3), mapped to dx/dy by the
  server; `drag_at(app, from_x, from_y, to_x, to_y)`. Drag is **point→point only** — to drag
  from/to a named control, resolve its centre from `query_app` bounds and pass the coords (no
  `drag-app`: a two-ended gesture doesn't map cleanly to the single-node `*-app` shape).
- **Same gate + indicator + kill switch + focus verification** as the keyboard (clicking/scrolling
  is position/stacking-dependent, so geometry is read FRESH right before injecting). First slice is
  single-monitor.
- **Coord mapping**: the **same logical-coordinate convention as the overview minimap**
  (`common/WorkspaceSchematic.ts` — `logical = physical/scale`, position − monitor origin), which
  is the in-shell, battle-tested reference incl. fractional scale (`nidara-click` mirrors it
  because it's a separate process). Verified exact here (scale 1: measured via `hyprctl cursorpos`;
  AT-SPI window bounds align 1:1 with Hyprland's `at`, no CSD offset). Still **measure** on
  fractional-scale / multi-monitor before trusting (per [[feedback_debug_verify_before_theory]]).
- **Deferred (not built)**: multi-monitor output targeting (`create_virtual_pointer_with_output`) —
  needs a second display to verify the per-output coordinate mapping.
- **Still deferred (beyond drag + multi-monitor above)**: a per-app allowlist; the Prism assistant
  as the perceive→act orchestration surface (Phase 3).

**The agent-pointer visual (fake AI cursor)** — pointer actions are no longer invisible: a
Cairo-painted cursor arrow (live accent fill + glass "AI" badge, `t("agentPointer.badge")`)
plays the choreography on an OVERLAY layer-shell window per monitor
(`surfaces/agent-pointer/AgentPointer.ts` — see architecture.md for the window-model exception).
Only visible **during actions**: pop-in at the REAL cursor's position (MATERIALIZE hold so the
eye locks on before anything moves), ease-in-out travel on a gently bowed bezier (~0.3-1 s,
distance-scaled — deliberately hand-like, never a robotic zip), ripple on click, then a ~4 s
linger with a pulsing accent **halo** around the tip before fading (persistent state is already
the bar's AI badge). The halo is load-bearing, not decoration: the real injection warps the
HARDWARE cursor onto the landing point and the cursor plane always paints on top of layer
surfaces — without the ring the covered arrow reads as "the AI cursor turned back into the
normal one" (the original v1 complaint). During the linger the overlay polls `hyprctl cursorpos`
(~2 Hz, idle phase only): if the user moves the real cursor > 24 px off the landing point it
fades early — the user always wins, also during the linger. Visible over fullscreen. Key
properties:

- **Land→confirm protocol — the visual never lies**: `nidara-click` reads `hyprctl cursorpos`
  (baseline), then blocks on `ags request agentPointer <kind> <gx> <gy> [gx2 gy2] [from bx by]`
  — the request resolves when the fake cursor **lands** (~0.45-1.2 s incl. pop-in; inside the
  helper's `timeout 2` bound). It then **re-checks the
  gate** (the kill switch can fire mid-animation and now stops the injection inside that window)
  and re-reads `cursorpos`: if the user moved the mouse **> 10 logical px** (euclidean), it
  aborts with a readable `{ok:false}` error and sends `agentPointer cancel` (fade, NO ripple) —
  **the user always wins**. Only if it actually injects does it send `agentPointer confirm`
  (async, right before the injector spawns) → the ripple ≈ the real click; a drag glides the
  fake cursor concurrently with the real 24-step drag (small cosmetic skew accepted).
- **The visual is an ENHANCEMENT, never a gate**: `visual()` in `nidara-click` is
  try/catch + `timeout 2` — shell down or pre-agentPointer shell = silent no-op, injection
  proceeds. Abort authority lives ONLY in `nidara-click` (gate re-check + user-wins); the shell
  overlay adds a 3s orphan timeout (helper died between land and confirm → fade out anyway).
- **Gate parity (defense in depth)**: action kinds of the `agentPointer` IPC check
  `allowComputerControl` in the shell too; `confirm`/`cancel` are ungated (they only finish an
  animation). The kill switch (`disableComputerControl` / bar indicator / Settings → AI /
  `Super+Shift+Esc`) hard-hides the overlay instantly via an `agentConfig.onChange` hook in the
  factory; `hideForLock` cancels it too.
- Verify with `dumpState.flags.agentPointer` (true while travelling/effecting/fading) and
  `hyprctl layers` (`nidara-agent-pointer` listed only while acting — unmapped at rest).

### Adding a new IPC command

1. Add the action to the typed `core/ShellActions` registry.
2. Wire it inside `app.ts main()` (where the registry is populated).
3. Add an entry to the `IPC_COMMANDS` table in `app.ts` — **with a real description**; that
   string is the command's documentation (it's what `listActions` serves). Never grow a
   parallel switch or a second command list elsewhere.
4. Use it from `hyprland.lua` as `hl.dsp.exec_cmd("ags request <yourCmd>")`.

## `ShellActions` replaces `globalThis`

Widget code uses the typed `core/ShellActions` registry. **Do not reintroduce `globalThis` coupling** — there used to be a pattern of stashing functions on the global object, and it's been intentionally removed. If you find yourself reaching for `globalThis` to break a dependency, the fix is almost always to add a typed entry to `ShellActions` and populate it from `app.ts main()`.

## `hideForLock` / `showAfterLock`

The lockscreen needs the shell out of the way while it's active. These two IPC commands hide all shell windows and restore them afterwards. Keep them symmetric — every code path that calls `hideForLock` must have a corresponding `showAfterLock` on the other side, or the shell becomes invisible after an aborted lock.

## Overlay placement: inside the Bar window

This is commandment #5 in `SKILL.md` but it's worth restating here because it's load-bearing for the whole state model:

Overlays (CC, NC, Prism, SystemMenu, Overview) **live as children of the Bar's window** via `Gtk.Overlay`. They are NOT separate `gtk4-layer-shell` windows. Reasons:

- Avoids Hyprland layer-rule conflicts (one Bar layer is easier to reason about than five).
- Lets show/hide animations be GTK-side via `common/ScaleRevealer.ts` (grow+fade) instead of fighting compositor animations.
- Simplifies input region management (one window's mask, not five).

If you find yourself making a new overlay its own window, stop and ask why. The few exceptions (Settings, About) are full top-level windows for separate reasons and don't follow the overlay state machine.

**The one exception INSIDE the overlay state machine: the Activity Island** (`surfaces/island/IslandWindow.ts`, namespace `nidara-island`, layer OVERLAY) — the compact capsule and the expanded modes together. It still lives on `status.island_mode` and still animates GTK-side; only the surface it paints on is different. The reason is physical, not stylistic: Hyprland blurs what is composited BEHIND a surface, so nothing painted inside the bar's window can ever blur the bar's own capsules — and the island is the only overlay that covers the bar row (every other panel drops below it at `PANEL_TOP`). At the default `overlayOpacity` of 0.05 the capsules read through the island sharp and unblurred. A surface one layer level up is composited after the bar, so the blur pass finally samples it.

**Move the capsule WITH the modes — this is load-bearing.** A first cut kept the capsule on the bar's surface. Two things went wrong: `compute_bounds` no longer resolved (it works inside one hierarchy only), forcing a coordinate bridge; and mid-morph both surfaces painted glass over the same pixels, so their blurs stacked and the transition showed a visible seam. One surface owning the shape end to end is what makes the morph what it was always meant to be — one object changing shape, not one dissolving into another. What the exception still costs, and what you inherit if you touch it:

- **Two input regions, not one.** The island surface stamps the capsule (always — it is a click target on an otherwise click-through surface) plus whatever mode is revealed. **Re-stamp when the capsule RESIZES**, not just when a mode opens: the compact stack interpolates width when the fronting activity changes, and a different media title reshapes the pill with no page change. `Bar.tsx` hangs that off the capsule's glass `DrawingArea::resize`.
- **An EXCLUSIVE keyboard grab also captures the POINTER — so the island needs its OWN catcher.** In Hyprland a layer surface holding `KeyboardMode.EXCLUSIVE` receives pointer events regardless of input regions. The bar's catcher therefore never sees an outside click while a `needsKeyboard` island mode is open, and the overview and the assistant simply stopped closing when the island moved out of the bar's window — while the ambient player, which takes no grab, kept working. The symptom points at input regions and the cause is the grab. `IslandWindow` owns a catcher of its own for exactly this; grabbing modes give it the full height (a bar-strip click cannot reach the bar anyway, so dismissing beats doing nothing), ambient modes inset it by `BAR_H` so capsule-to-capsule switching stays ONE click. Its rect is unioned into the region EXPLICITLY, not measured — it is shown and stamped in the same turn, so its allocation is a layout pass behind (the bar does the same for its own).
- **Hiding is by NAME, in two places.** The surface is always mapped (the capsule is permanent furniture), so it must follow the bar out of sight explicitly, and both places filter windows by name.
  - **Fullscreen (`Bar.tsx`) — this one has teeth.** The bar only goes to opacity 0; since the capsule no longer rides its surface, without `islandWin.setShown(false)` it stays floating over the fullscreen window.
  - **Lock (`lockScreen`/`unlockScreen` in `app.ts`) — consistency, not a fix.** Under `ext-session-lock-v1` (the path Hyprland actually takes — the lockscreen logs `supported: true`) the compositor composites ONLY the lock surfaces, so nothing else is drawn regardless. It would only matter on `startFallback` (`ui/lockscreen/app.ts`), the plain OVERLAY layer-shell degradation used when the protocol is unsupported, which does not happen here. It is in the list because the agent pointer already sets that precedent one branch above ("paints on OVERLAY (above the lockscreen fallback)"), and leaving the island out would make it the only shell surface not covered by the convention.
- **Keyboard grabs must not collide.** Island modes with `needsKeyboard` grab EXCLUSIVE on the ISLAND surface; the bar's `syncKeyboardMode` now only covers Prism. Two surfaces both holding EXCLUSIVE means the compositor picks one and the other silently stops receiving keys.
- **Scoped CSS must name both windows.** `.agent-*` lives under `#nidara-bar, .nidara-bar-window, #nidara-island, .nidara-island-window` because the compact pill is in one surface and the expanded panel in the other.
- **Layer-level ordering is re-asserted, not assumed.** Bar overlay mode moves the bar to OVERLAY too, which would append it above the island; `islandWin.raise()` puts the island back on top.

**Bar.tsx owns ALL overlay geometry**, not the surfaces themselves. `syncPanelMargins` in `Bar.tsx` sets each overlay's `margin_top`/`margin_start`/`margin_end` (and re-runs on dock-side changes); the surface modules just build content and align to a corner. Because each overlay is wrapped in a `ScaleRevealer`, **the wrapper IS the `cc`/`nc`/`systemMenu`/... variable**, so margins/alignment/input-region all operate on the wrapper transparently. Conventions: panels sit `8px` from the screen edge (flush with the bar capsules, which is a stronger visual reference than the tiling `gaps_out` grid beneath). Gotcha: **the system menu must dodge a left-side dock** (`margin_start += dock.width`) and CC/NC/popups dodge a right-side dock — because the **dock is its own layer-shell window stacked ABOVE the bar window**, so an un-dodged overlay slides under it. Don't move positioning logic back into a surface module.

**Panels are content-sized — never force a wrapper's height.** Overlay panels sit ABOVE the catcher in the overlay stack, and GTK4 picking is geometric: a transparent Box still wins the pick. Any wrapper forced taller than its visible content (an old `height_request` on `nc`/`cc` did this) turns the empty remainder into a dead zone that swallows the outside-clicks that should dismiss the panel. Also remember `height_request` can only RAISE a minimum — it never caps, so it's the wrong tool for a height budget anyway. The vertical budget (bar→dock gap, `applyPanelHeights`) is pushed into the surface and enforced by an internal `Gtk.ScrolledWindow` with `propagate_natural_height: true` + `max_content_height` (NC does this via a `setMaxHeight` function attached to its returned widget, the same pattern as WorkspaceOverview's `onOpen`): the panel hugs its content until the list overflows, then scrolls.

**Outside-click dismissal is the `catcher`** — an invisible `Gtk.Button` overlay in `Bar.tsx`, visible whenever `isAnyOverlayOpen` (except CC edit mode). It covers everything **below the bar strip only** (`margin_top = BAR_H`): the bar's capsules stay clickable while a surface is open, so clicking another capsule switches surfaces in ONE click (the capsule's toggle fires and Status's mutual exclusion closes the previous one). Don't extend the catcher over the bar — that regresses to the close-then-reopen double click. The pill guards in `Bar.tsx`/`AppTitle.tsx` check `cc_edit_mode` (pills inert while editing the CC), NOT `cc_open`.

**Input-region staleness gotcha (CC edit mode).** `updateInputRegion` reads `widget.get_allocation()`, which only reflects a size change **after the next layout pass**. Normally that's harmless because an open overlay is backed by the full-screen catcher rect — but in CC edit mode that rect is deliberately skipped (other windows stay interactive while editing), so the region is exactly the CC's rect. Toggling edit mode also *resizes* the CC (content-height grid ↔ full 8-row board + Done pill), so a naive allocation-based stamp uses the pre-toggle size and everything the grid grows into — the Done pill included — is click-through (clicks fall to whatever window is underneath). Three pieces make it correct, and all three matter:

1. **`measure()`, not just allocation**: in edit mode `updateInputRegion` unions the CC's *measured natural height* (reflects the resize synchronously) with its allocation, so the grown grid is clickable in the same frame.
2. **`IslandGrid` flips `status.cc_edit_mode` AFTER its `rebuild()`** — measure() can only see the new size if the height requests were already updated when the notify fires. Keep that ordering.
3. **Wayland input regions are double-buffered** — `set_input_region` only takes effect on the surface's **next commit**. A stamp that doesn't ride a visual change would sit pending until some incidental repaint (this read as "the Done pill stays dead for a while"), so `updateInputRegion` ends with `win.queue_draw()`. The `notify::cc-edit-mode` handler also re-stamps on a deferred one-shot (defer-a-frame idiom, as `showExpansion`) to settle the shrink direction when leaving edit mode.

If you add another state change that both resizes an overlay and relies on per-widget region rects, follow the same recipe.

**Keyboard focus for a keyboard-driven overlay → `EXCLUSIVE`, not `ON_DEMAND`.** Because the overlays share the Bar's single layer-shell window, keyboard focus is a *window-level* concern: `Bar.tsx` calls `Gtk4LayerShell.set_keyboard_mode(win, …)` via a shared `syncKeyboardMode()` helper on the relevant overlay's `notify`. Click-only overlays (CC/NC/SystemMenu) need no keyboard, so they never set a mode. Two overlays DO need it: **Prism** (text input) and the **Activity Island** when its open mode declares `needsKeyboard` (the overview does: arrow-key workspace nav) — `syncKeyboardMode()` grants `EXCLUSIVE` while either holds (`prism_open || island.needsKeyboard()`) and returns to `NONE` otherwise. The Overview owns no text field: it exposes `onOpen()`/`handleKey()` on its widget, `ActivityIsland` routes them per-mode, and `Bar.tsx` adds a CAPTURE-phase `Gtk.EventControllerKey` on `win` that forwards keys to `island.handleKey` while `island_mode` is set (←/→ move a `.keyboard-focus` cursor, Enter switches + closes, Esc closes) — the exact pattern the app grid uses on the dock window. A search/text overlay (Prism) **must** open with `EXCLUSIVE` and return to `NONE` on close — under `ON_DEMAND` **Hyprland withholds keyboard focus from the layer surface until the pointer enters or clicks it**, so the search caret won't blink and you literally can't type until you move the mouse. `EXCLUSIVE` makes the compositor grant focus the instant the surface opens (a widget-side `entry.grab_focus()` alone is not enough — the toplevel must be compositor-active for the caret to render). The app grid (its own window) does the same: `EXCLUSIVE` while open, dropping to `ON_DEMAND` **only** when a `Gtk.Popover` context menu needs to take keyboard focus (an EXCLUSIVE layer won't let a child popover grab it); Prism has no popover, so it stays `EXCLUSIVE` throughout. When adding a new overlay with a text field, wire the same EXCLUSIVE↔NONE toggle — and note that the *resting* end of that toggle is `NONE` and nothing else: see "THE RULE: a shell surface rests in `NONE`, never in `ON_DEMAND`" above for what `ON_DEMAND` actually does to the seat.

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

The exclusion is implemented by the private `closeExclusive(keep, opts)` helper — each setter calls it on open.

⚠️ **Adding a new exclusive overlay is THREE edits, and only the first one is obvious. The other two fail in SILENCE** (both shipped broken with the app grid's move, 2026-08-09 — `tech-debt.md` §18):

1. The setter itself: add `_field → notify-name` to the `EXCLUSIVE` map and call `closeExclusive` from the new setter (don't touch the other setters).
2. **`isAnyOverlayOpen`.** It is not the convenience getter it looks like: it is the FIRST line of the bar's empty-strip dismissal handler (`barStripClick` in `Bar.tsx`), so an overlay missing from it silently stops being dismissable from a pixel that dismisses every other one. It is also what stops `AgentService` popping the Assistant island over something the user opened.
3. **`dismissOverlays()` in `Bar.tsx`** — required as soon as the new surface whitelists the BAR in its focus grab, because a grab peer is by definition a surface the compositor will not dismiss on. Skip it and the empty bar strip becomes the one press on screen that does nothing.

None of the three produces an error, a warning or a failed build when missed. Two string-valued members are special-cased: `island_mode` is cleared explicitly inside `closeExclusive` (it can't live in the boolean `EXCLUSIVE` map), and `bar_expanded_id` (the pill expansion capsule) is a **one-way member**: setting it non-empty closes the overlays, and the overlay setters clear it via `opts.barExpanded`. New island MODES are NOT new Status fields — they're new ids for `island_mode`, registered in `ActivityIsland` (mode ids are exported from `Status.ts` so core/IPC/surfaces share one vocabulary).

### Other tracked props

- `about_open` — `AboutWindow` is create+destroy, not hide: `app.ts` listens on `notify::about-open` and creates/destroys the window. Flipped by `status.toggleAbout()` (the system-menu item, and the `toggleAbout` IPC action).
- `settings_open` — Settings hides on close instead.
- `recording`
- `cc_edit_mode`
- `bar_expanded_id` — which Bar pill is currently expanded.
- `cc_detail_id` — which CC detail panel is active.

### Toggles

`Status.ts` exposes typed togglers: `toggleCC`, `toggleNC`, `togglePrism`, `toggleSystemMenu`, `toggleIsland(id)` (+ `toggleOverview`, an alias for `toggleIsland(ISLAND_OVERVIEW)` — also still the IPC action name), `toggleAbout`. There's also `isAnyOverlayOpen` — treat it as load-bearing, not convenient: see the three-edit warning above. `dumpState` reports both `overlays.island` (the mode string) and the legacy `overlays.overview` boolean (back-compat for agents).

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
`openSettings` (alias `toggleSettings`), `settingsPage <pageId>`, `toggleOverview`, `togglePlayer` (media island; errors if no MPRIS player is on the bus), `toggleAgent` (the built-in Assistant island; `Super+A`), `agentNewConversation` (ends the Assistant's conversation and starts an empty one — hidden from the Assistant itself, refuses mid-turn), `toggleAbout`, `toggleBarOverlay` (alias `toggleGameOverlay`),
`openWindowMenu`, `hideForLock`, `showAfterLock`, `describeConfig`, `getConfig [key]`,
`setConfig <key> <value>`, `screenshot [path]`, `queryUI [selector]`, `listApps`, `launchApp <id>`,
`disableComputerControl`, `notifyComputerAction` (computer-use tools ping it so the bar's AI-control
indicator pulses "active"), `agentPointer …` (drives the fake-AI-cursor visual — see the
computer-use section), `setIsland <closed|agent|overview|player|battery>` (EXACT island state — use this
over the ambiguous `toggle*` when you cannot see the current one), `yieldInput <begin|end>` (the helpers make the shell let go of the keyboard
so their action can land — see "The shell has to step out of the way"), `listActions`, `dumpState`, plus the **window/workspace management**
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
descendant text), so assert against the label class.

**Switches, toggles and check buttons report `active`** (added 2026-07-30). A `GtkSwitch`
arrives with no id, no text and no CSS class of its own, so a Settings page used to read as a
column of labels beside eight indistinguishable switches — and **a reader that cannot see a
value does not always say so**: asked which AI permissions were on, an agent read the AI page
plus the schema and reported one of the eight as off while it was on. A permissions page is the
worst place to leave someone guessing. The field is **omitted, not `false`**, for everything
that has no state — a missing field reads as "not applicable", a `false` reads as "off". Only
`active`: there is no `value` to report because Nidara has no `Gtk.Scale` (sliders are Cairo).
Beyond that, tier 1 is structure+text; the remaining semantic state (dock-item
running/active) is a deferred opt-in tier the widgets would cooperate on, sharing
the same node model the AT-SPI2 backend now fills for third-party apps (see "computer-use"
below — `queryUI` is the shell's own toplevels; `query_app` is the same shape via AT-SPI).

**That split is invisible from the outside, so both tools have to state it** (done 2026-07-30
after measuring the cost). Nidara's windows are not reachable through AT-SPI under any name an
agent would try — it registers on the bus as `gjs` with unnamed frames (see `tech-debt.md`) —
so `query_app io.Astal.ags` and `query_app "Nidara Settings"` both return zero **with the
window open in front of it**, which reads as "nothing there" rather than "wrong door". A model
asked to read its own Settings window spent three steps and ~15k tokens finding that out, then
answered from `describe_settings` instead. `queryUI`'s `desc` now opens by naming whose windows
it reads (that first clause is the entire line the daemon's action index carries, cut at the
first `.`/`[`/`(` — so keep those characters out of it), and `query_app`'s says "OTHER apps
only" plus where the inside door is, in the daemon and the MCP server both.

Commands receive arguments: `requestHandler` passes `argv.slice(1)` to the handler
(`run(args)`). `ags request settingsPage bluetooth` opens the Settings window directly on
that page (sidebar category ids) — the agent-friendly way to reach a Settings page without
synthesizing clicks. **A rejection lists the valid ids** (`unknown page: AI — valid: network,
bluetooth, appearance, …`, from `pageIds` published by the window) and lookup is
case-insensitive: the ids are lowercase while the page NAMES are not, and the labels are
translated, so neither the user nor an agent can derive an id from what is on screen. An error
that only says "no" costs a whole step to re-guess — measured on `settings_page AI`, 2026-07-30.

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
- **`focusWindow` yields the shell's keyboard grab first, and VERIFIES.** While one of our layer
  surfaces grabs, the dispatch is refused outright (next section), so the old handler returned
  `focused <class>: <title>` for a focus that never happened — and the model believed it and kept
  going. It now wraps the dispatch in `inputYield.begin()/end()`, waits 80 ms for the answer to
  arrive by event, compares `HyprlandState.focusedClient` against the requested address, and reports
  `focus refused by the compositor — still on <class>` when they differ. If you add another
  focus-moving IPC command, do the same: a success string is a claim, and this one is checkable.
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

⚠️ **Both failures above are EXCLUSIVE-era, and no shell surface asks for EXCLUSIVE any more. The
reconciliation stays anyway — audited 2026-08-07 — because it stopped being a patch and became the
INPUT to the root fix.** Two things now depend on it, neither of which is a compositor lie:

- The *remembered window* is who `restoreFocusAfterGrab` hands the keyboard back TO. Dropping a focus
  grab makes Hyprland refocus **by pointer**, so dismissing with the cursor over the wallpaper still
  leaves the session with nothing focused (measured 2026-08-05) — a different cause, the same null,
  and with no memory of who was focused there is nobody to restore.
- *Validating the live answer* is that repair's correctness guard: focusing a window that lives on
  another workspace DRAGS THAT WORKSPACE over the user, so the repair relies on this accessor never
  handing it one. That is a property of `focusWindow`, not of any grab.

Consumers were swept in the same audit (AppTitle, both fullscreen watchers, `DockItem` ×3,
`WindowMenu`, `widgets/screenshot.ts`, `app.ts` ×3): all **read-only**, none carrying a parallel
workaround. Read the accessor; never re-derive focus yourself.

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
`activewindow` null above — which is what `HyprlandState.afterGrabRelease(cb)` does, with an 80 ms
fallback for the case where nothing was focused and no announcement is coming.

⚠️ **The workspace half of this is HISTORY (2026-08-05), the mechanism is not.** Every modal surface
moved to `hyprland-focus-grab-v1`, whose release is *not* double-buffered and which never refused
focus moves to begin with, so `focusWorkspaceOnGrabRelease` is deleted and
`focusWorkspaceFromShell(id)` (the single door for the app grid's strip and the island's overview)
just switches. `afterGrabRelease` stays, and still has two callers that genuinely need it —
`restoreFocusAfterGrab` and `InputYield` below — because `refocus()` runs on the compositor's clock
whether or not the request was buffered. Keep the measurement above: it is why nobody should
"simplify" either of them into a timeout.

### The shell has to STEP OUT OF THE WAY for computer-use: `core/InputYield`

The same refusal has a second victim, and it is the one that made the built-in Assistant look
useless. Read the compositor's own code (`FocusState.cpp`, `CFocusState::rawWindowFocus`, 0.56):

```cpp
if (!g_pInputManager->m_exclusiveLSes.empty()) {
    Log::logger->log(Log::DEBUG, "Refusing a keyboard focus to a window because of an exclusive ls");
    return;                       // ← a hard return: focus does NOT move, no event is posted
}
```

The Assistant island holds a compositor focus grab the entire time it is open (as does every other
modal surface — see `architecture.md` → "Focus grab"; the quote above is why the layer-shell
`EXCLUSIVE` path it replaced was even worse). Therefore, from inside the Assistant:

1. `focus_window <app>` is a **no-op**. Not slow, not racy — refused.
2. `hyprctl activewindow` then correctly still names the old window, so every helper's focus check
   (`nidara-click`, `nidara-type`) refuses. **That guard was right.** Do not "fix" it by sourcing
   focus from the shell (`listWindows.focused`) instead: that only teaches the helper to approve an
   action that cannot land, and for the keyboard it is actively harmful — the keys genuinely belong
   to the island, so the text would be typed into the Assistant's own prompt box.
3. Even with focus sorted, the click would be eaten: a grab **clamps pointer focus** to the grabbed
   surface regardless of its input region, and the island spans the whole monitor.

AT-SPI perception (`query_app`) and named actions (`do_app_action`) never look at focus, so those
kept working throughout — which is why the failure looked like "the model is bad at clicking".

**The fix is a scoped truce, `core/InputYield`.** `begin()` asks every grabbing surface to RELEASE
its focus grab *and* stamp an EMPTY input region, waits for the compositor to announce it
(`hyprlandState.afterGrabRelease`), and only then lets the caller act. `end()` gives the grab back.
Things to keep if you touch it:

- **The helpers drive it, not the agent daemon** (`yieldInput begin|end`, spawned like `visual`).
  That way an external MCP client acting while the user has Prism or the app grid open is covered
  by the same mechanism, instead of only the built-in Assistant.
- **Dropping the grab is not enough on its own.** The grab is what makes Hyprland ignore input
  regions; the region itself still covers the screen while a panel is open. Every grabbing surface
  therefore goes click-through for the duration: `Bar.updateInputRegion`, `IslandWindow.updateInputRegion`
  (capsule included — the surface is monitor-sized) and both `DockAxis.buildInputRegion` bodies
  return early on `inputYield.active`. In the dock that early return needs **its own region cache
  key** (`"yield"`), or the restore matches the stale key and silently skips. ⚠️ Since 2026-08-09 the
  dock's yield branch keeps its BLUR rect (only the input region is dropped): a yield changes who
  gets the clicks, not what is drawn, and the only thing that used to paint outside that rect — the
  app grid — has its own surface now.
- **`registerHolder` exists so the common case costs nothing.** With no surface grabbing, `begin()`
  resolves immediately instead of paying the 80 ms release wait on every single action.
- **A watchdog (15 s) restores everything** if a helper dies between `begin` and `end`. Without it
  a crash would leave the shell keyboard-less and click-through with no way back.
- Restore by RE-ACQUIRING, never by replaying a remembered layer-shell mode. This used to need care
  (the app grid dropped to `ON_DEMAND` for the life of a context-menu popover, so a blind restore to
  `EXCLUSIVE` broke the menu); now `acquireFocusGrab` is the only thing to redo, and FocusGrab owns
  the popup case by suspending the lease.

- **`begin()` GIVES THE FOCUS BACK that the release takes away** (`_restoreFocus`, 2026-08-13). It
  reads `focusedClient` *before* the notify and re-focuses that address once the release has landed.
  Not defensive coding — without it computer-use is structurally broken on this desktop; the
  mechanism is spelled out below.

⚠️ **What the release refocuses TO is a property of this repo's own config, not of the grab.**
`CSeatManager::setGrab(nullptr)` (Hyprland 0.56.1, `src/managers/SeatManager.cpp`) branches on
`input:follow_mouse`: `0 || 2 || 3` → `refocusLastWindow(monitor-under-cursor)`, **anything else —
i.e. 1 — → `g_pInputManager->refocus()`**, which focuses whatever the cursor is over.

`config/hypr/hyprland.lua` shipped `follow_mouse = 1` until **2026-08-15 and now ships `2`** (pointer
focus detached from keyboard focus — see the window-menu entry in `architecture.md` for why), which
moves the default install onto the `refocusLastWindow` branch: the release now hands the keyboard to
the last window the monitor had, which after a `focusWindow` IS the target. ⚠️ That does NOT retire
`_restoreFocus` or `restoreFocusAfterGrab` — `follow_mouse` is one `hyprland-user.lua` line from being
1 again, and neither repair costs anything when the compositor already answered correctly. Read the
value, never assume it. Everything below is the measurement under `1`, kept because it is the only
written record of the pointer branch (and because it is what a user who overrides will hit).

That is why the sequence documented here until 2026-08-12 ("the release refocuses the last window,
which is the target") was only ever true for the configs Nidara does not ship. What actually
happened, measured in a live Assistant run: `focusWindow org.gnome.TextEditor` succeeded and the
compositor confirmed it by title; 3.2 s later the click was refused because the pointer had been
resting over a terminal the whole time, and the yield's own release had handed it the focus. The
caller was then told to focus the window it had already focused.

🔑 **The repair is timed by the same event the yield already waits for.** The `activewindow` that
`afterGrabRelease` listens for IS the wrong focus arriving (the refocus happens inside
`setGrab(nullptr)`, before the event), so restoring in that callback needs no delay and no polling.
And it is a ONE-SHOT: `follow_mouse` re-evaluates on pointer motion, so nothing undoes the restore
while the pointer stays still. The dispatch is awaited to completion — `hyprctl` exiting means the
compositor applied it — before `begin()` resolves, so the helper's own `hyprctl activewindow` (a
separate process, spawned only after the IPC reply) cannot race it.

⛔ **Do not "fix" this in the helpers instead** by moving the pointer to the target before the focus
check. It looks equivalent and is not: it changes what the user sees (the pointer choreography in
`surfaces/agent-pointer/` owns that), it does nothing for `nidara-type`, which never moves the
pointer, and it treats a defect of ours as an ordering detail of theirs.

⚠️ **This is NOT the policy of `restoreFocusAfterGrab`**, which returns early when the compositor
found *someone*. That is right for a dismissal — whatever the pointer is over is a fine answer when
the user just clicked a panel away — and wrong here, because the caller has already chosen the
window and the helpers verify focus before they inject. Two callers, two policies, one mechanism;
they share `afterGrabRelease` and nothing else.

Sequence that works, and why (verified against `rawSurfaceFocus`, which touches only
`m_focusSurface` — a layer-shell grab never clears `m_focusWindow`): `focusWindow` yields → focus
moves → grab comes back (window focus untouched) → the helper yields again → the release refocuses
by pointer → **`begin()` puts it back before it answers** → `hyprctl activewindow` names the target
→ the focus check passes.

#### The same refusal has a THIRD victim: a window that MAPS while a surface grabs (2026-07-31)

`InputYield` fixed the verbs — but a newly mapped window never asked for focus, so nothing yielded
for it and Hyprland simply did not focus it. Verified by A/B with the variable isolated: island
closed → the launched app is focused; island open in agent mode → the previously focused toplevel
stays active. That is structural for the built-in Assistant, because the island is open **by
definition** while the user is talking to it: every "open X and do Y" paid a refused pointer/keyboard
verb plus a `focus_window` round trip. An external MCP client, with nothing grabbing, never sees it —
which is why only the terminal bench could find it.

So `launchApp` now **waits for the window and focuses it** (`focusLaunched` in `app.ts`), reusing the
same `inputYield.begin()/end()` truce as `focusWindow`. Two properties worth keeping:

- **Focusing a window while the island grabs does NOT take the keyboard from the island** (measured:
  typed text still lands in `.agent-entry`, the focused app receives nothing). The conversation is
  not disturbed by the shell putting the launched app in front.
- `begin()` is a **no-op when nobody is grabbing**, so the ordinary dock-click case pays nothing and
  Hyprland's own focus stands.

`launchApp` also resolves a **name**, not just an exact desktop id (`launchApp calculator`), through
the same `AppService.search()` Prism uses, and answers an ambiguous name with the CANDIDATES. The
old exact-id-only version cost two steps and a 7 KB catalogue dump that then rode in `history` for
the rest of the turn — the model asked for `calculator`, was told "see listApps", and obeyed. Same
lesson as `settingsPage` (#68): **a reply that points at the catalogue costs the catalogue.**

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

🔴 **Since 2026-08-05 the rule is absolute: `NONE` is the ONLY value any shell surface ever sets,
once, at init.** Modality comes from `hyprland-focus-grab-v1`, which needs no interactivity at all.
The one exception that used to exist — dropping transiently to `ON_DEMAND` because a `Gtk.Popover`
cannot take focus from under an `EXCLUSIVE` grab (the app grid's context menu) — is gone with the
rest of the layer-shell path. If you are reaching for `set_keyboard_mode` outside a surface's setup,
you are re-introducing `m_exclusiveLSes`.

With every surface resting in `NONE`, the release is clean and measurable — `activewindow>>,`
followed by `activewindow>><the window>` inside 1 ms, on all the grabbing surfaces (bar/Prism,
island/overview+assistant, app grid — the last of which was the DOCK's surface until 2026-08-09). `dumpState.keyboardFocus` shows `{}` at rest, and a `{}`
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
- **Every `ai.*` key that GRANTS something is visible but not writable via setConfig** — a gate
  must not be flippable through the door it controls. The line is *grant*, not namespace:
  `ai.assistantGlow` (the glow on the window the Assistant is working in, `AgentGlow.ts`) is
  writable, because it turns a *signal* on and off and permits nothing. That also makes it
  answerable — "stop glowing my windows" is a reasonable thing to ask the Assistant, and it is
  the one thing on this page it can do about itself.
- **Every gate in `ai.json` must be registered here, `writable: false`** — all eight of them
  (`allowConfigWrite`, `allowScreenshot`, `allowWindowClose`, `allowMcp`, `allowComputerUse`,
  `allowComputerControl`, `allowFileRead`, `allowFileWrite`). The last four were added with the
  computer-use and file layers and **not registered until 2026-07-30**, which made
  `describeConfig` a half-truth rather than an omission: asked which permissions were on, the
  Assistant read the registry honestly and answered **four of eight** with nothing marking the
  list as partial. A gate the agent cannot see is one it cannot report, explain, or point the
  user at — and an incomplete answer that looks complete is worse than a refusal. Registering a
  gate is **not** making it writable: `writable: false` keeps `setConfig` refusing, and the
  Settings → AI page stays the only door that flips one.
- **Adding a setting:** register it in `config-entries.ts` (NOT in core/ — dock settings
  import widget state) with a real `desc` (that string is the agent-facing documentation)
  and delegate `set` to the owning service's setter. That's ALL it takes to appear in
  `describeConfig`.
- **Before adding a persisted setting, check whether the Astal library ALREADY persists it.**
  Astal properties are not all in-memory: `AstalNotifd.dont_disturb` is a straight accessor over
  GSettings (`io.astal.notifd dont-disturb`, schema in `/usr/share/glib-2.0/schemas/`), so it
  survives logout and reboot in dconf with no help from us. Nidara had shadowed it anyway with a
  `notifications.dndDefault` boolean in `notif-config.json` plus a "Enable on login" toggle in
  Settings → Notifications, and a seeding block in `app.ts` `main()`. Two settings, one bit — and
  the copy could only ever *set* it, never clear it, so its OFF position promised sessions would
  start undisturbed while the persisted flag quietly kept DnD on. (Worse, `main()` runs on every
  UI reload, not just at login.) All three were removed 2026-08-16; the registry key is now
  `notifications.doNotDisturb`, reading and writing the live flag, and Settings shows the live
  state like GNOME does. **The check is one command:** `gsettings list-recursively io.astal.<lib>`,
  or read the `.vala` property — if the getter hits `settings.get_*`, it persists. A shadow copy
  can only ever disagree with the real one.
- **A `desc` should not restate the DEFAULT.** `value` sits in the same JSON object, so a
  default is a second answer to the question the reader came with. (It was first suspected of
  causing a misread of `ai.allowFileWrite`; removing it did not fix that — the cause was the
  UI tree carrying no switch state, below — so this is hygiene, not a proven bug.) Put in the
  desc only what the value cannot say: what the setting does, which other setting it implies,
  where a human flips it.

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
`hover_app(app, node)`, `hover_at(app, x, y)`,
`scroll_app(app, node, direction, amount?)`, `scroll_at(app, x, y, direction, amount?)`,
`drag_app(app, from_node, to_node)`, `drag_at(app, from_x, from_y, to_x, to_y)`,
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
OWN conversational assistant — and for everything it does TO THE DESKTOP it is deliberately
**just another client of the same gated surface**: those tools ARE `ags request` calls, so
Settings → AI gates (`allowConfigWrite` …) and the kill switch apply for free, and a new IPC
action is usable with zero changes here (`run_action` is a passthrough — 100% coverage,
exactly like MCP). The **file layer below is the one documented exception** to that rule.

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
  tool calls, **and `tsig=y|n` next to it on the native Gemini lane — read the pair, never `sig=`
  alone.** The signature legitimately arrives in either place, and on the live Interactions stream
  it normally rides the **thought step**, not the call: `sig=0/1 tsig=y` is a HEALTHY turn. The
  real defect is neither (`sig=0/1 tsig=n`), which 400s the next request, and the daemon prints an
  explicit *"NO reasoning signature anywhere"* line for it rather than leaving a counter to be
  interpreted — `sig=0/N` alone was misread as a defect indicator for weeks (tech-debt #38 (i)).
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
- **Tools offered to the model.** The `ags request` five — `run_action(action, args?)` for every
  desktop action, plus the settings/state cluster `set_config(key, value)`, `get_config(key?)`,
  `dump_state()`, `describe_settings()` — with gates enforced by the SHELL (a refusal comes back as
  the tool-result STRING; the daemon never re-checks those). Two groups do not go through
  `ags request` and enforce their own gates in the daemon: the **file layer** and the
  **computer-use tools** (both below).
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
- **`HIDDEN_ACTIONS` is also the AUTHORITY boundary, not only a token squeeze** — and the distinction
  matters when adding to it. Two of its three categories are about cost or redundancy; the third is
  about what the Assistant may not be able to do at all. It holds because the list is **enforcing,
  not advisory**: `run_action` resolves only through `actionMap`, built with the same filter, so a
  hidden name is UNREACHABLE — a model that guesses it, or one steered by a prompt injection in a
  window title it just read, is stopped by the resolver and not merely left uninformed. Pinned in
  `scripts/ci/agent-loop-test.py` ("hidden actions: unreachable, not just unlisted"), which asserts
  BOTH halves, because either alone is a false sense of safety. The stub `ags` serves the hidden name
  from `listActions` on purpose — a stub that omitted it would pass without the denylist.
  **`agentNewConversation` is the first entry of that third kind** (see below).
- **`agentNewConversation` — the one verb deliberately out of the Assistant's reach.** It ends the
  conversation and starts an empty one, dropping BOTH halves (`transcript.json` and the daemon's
  `session.json`, in memory and on disk) via `AgentService.reset()`. Reachable from a terminal
  (`ags request`) and from MCP, whose `run_action` is an unfiltered passthrough by design — its
  client is a person's agent, not this daemon. NOT reachable from the built-in Assistant: a reset
  mid-turn would strand the `tool_call` whose `tool_result` the next request has to carry, and
  "start over" belongs to the user or to whoever drives an eval, never to a move inside a turn.
  It **refuses while a turn is in flight** rather than resetting under it, and the refusal names
  something pollable — `dumpState` grew `ai.assistant` (`configured`/`busy`/`state`/`turns`) for
  exactly that reason, an addition the Assistant itself never pays for (`dumpState` is hidden too).
  No alias: aliases are a FIELD in `listActions`, never a key, so they never enter the index and the
  denylist would never see one — a second name would look covered without being it.
  **Why it had to exist:** deleting the two state files under a live shell does nothing, because the
  shell holds the conversation in memory and rewrites them at the next turn end. Before this verb,
  a fresh conversation meant restarting the shell, which every bench run had to do.
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
its `handleKey` claims only Escape (everything else falls through to the entry); the keyboard comes
from the island's own focus grab, which it takes for any open mode. The empty state (no provider) routes to Settings → AI.

**Bubble anatomy — an assistant turn is NOT one reply (2026-07-29).** A multi-step turn narrates
between calls ("I'll check whether Nautilus is focused first"), and every provider does it. Measured
live on a 5-step turn: 0 / 148 / 109 / 0 / 79 chars, so the actual answer was 79 of 336 — the other
257 were expired status reports, one of them announcing something that had not happened yet.

- **`Turn.text` is the FINAL answer only; narration lives on `ToolCall.interim`,** the chip it
  preceded. **Nothing marks it as interim on the wire and nothing should.** The daemon streams a
  step's deltas and only then emits that step's `tool` events, so **arrival order already carries the
  interleaving**: `AgentService`'s `case "tool"` moves whatever text is still unclaimed onto the new
  chip and clears `text`. Text with a chip behind it was narration; text unclaimed at the end is the
  answer. Deriving it means the two views cannot disagree — and it is why this needed **no daemon
  change and no transcript version bump** (an older transcript simply has no `interim` and renders
  as it always did).
- **Only the ANSWER is bubbled. The work is bare on the glass.** An assistant turn renders as
  pulse → `toolsBox` (narration + chips, unbubbled) → `bubble` (the answer, or the error that
  replaced it). A bubble says "one utterance" and a six-call turn is not one, so wrapping the lot in
  a single bubble was what made the steps read as one block. **The background is the differentiator**
  — the reply is the only part of the turn wearing one — which separates the answer no matter how
  many steps ran and costs no chrome. Same model as Claude Code / Cursor: an assistant turn is a
  stream of blocks and the reply is the last one. A USER turn is one utterance and keeps the plain
  bubble.
- **Chips render BEFORE the answer.** Chronology (the tools ran first), and also why the answer
  lands where the transcript auto-scrolls to. Text-then-chips put the answer above the cut on any
  turn with more than a few steps. **Do not re-order these two.**
- **Narration is dim but FULL SIZE (`$fs-small`).** The first cut used `$fs-mini` and that was the
  real mistake in it: the opening sentence of a turn is not the caption of whatever chip happens to
  follow, and 11px prose labelled it as one. The chip pill is `halign START` for the same reason —
  bare on glass a full-width pill reads as a band, not a marker.
- The interim move is **not** a reflow. Streaming text sits in `textLabel` at the bottom; when a chip
  arrives the text becomes that chip's `interim`, the same position on screen (the chip is appended
  below it). It dims in place rather than jumping.
- **`bubble.visible` is gated on `text || error`**, not on the turn existing — otherwise an empty
  rounded rectangle sits under the chips for the whole length of a working turn.
- Rejected alternatives, each for a reason worth keeping: a ChatGPT-style collapsible step list
  (hides exactly what explains a failure, and here the user is watching an agent touch their own
  desktop); discarding interim text (loses the *why* — "Nautilus wasn't focused" was the most useful
  sentence of the run it came from); per-step cards and a left rail (both buy differentiation with
  chrome the 300px panel cannot spare, and the unbubbled form gets it by removing chrome instead).

#### Session persistence — the conversation survives a reload (2026-07-27)

The daemon is a **child** of the shell, so `Super+Shift+R` took it down and the model's context with
it. Both halves are now written to disk at the same turn boundary, each by whoever owns the data:

| File | Owner | Holds |
|---|---|---|
| `$XDG_STATE_HOME/nidara/agent/session.json` | `bin/nidara-agent` | the neutral `history` (model context) |
| `$XDG_STATE_HOME/nidara/agent/transcript.json` | `core/AgentService.ts` | the `transcript` (bubbles) |

**Not `~/.config/nidara/`, and this overrides the house "all user state is JSON under
`~/.config/nidara`" convention** — that directory is a git repo now (the write tools' undo history),
so a conversation persisted there gets committed permanently into a repo the user never asked for. A
conversation is not configuration; the shell log already lives outside `~/.config` for the same
reason. Directory is 0700; the content is plaintext.

Three details that are load-bearing:
- **Written at the turn boundary only.** Mid-turn the history is inconsistent (a `tool_use` without
  its result), and a provider rejects that on restore.
- **The persisted history is the STUBBED view** (`historyForRequest()`), so prior turns' tool results
  are not stored at full size — they are already omitted from every request. `load_skill` results are
  exempt, so a restored conversation keeps its rules instead of silently losing them.
- **`reset()` deletes BOTH files from the shell side.** The daemon clears its own on `{t:"reset"}`,
  but it is spawned lazily, so "New conversation" on an idle desktop reaches a daemon that is not
  running — `writeLine` returns false, the UI empties, and the next message resurrects the thread the
  user just discarded. The shell owns the session LIFECYCLE; the daemon owns its file's contents.

A turn **in flight** is still lost — see `tech-debt.md` #37(g); fixing that means making the daemon a
systemd sibling rather than a child, and is deferred until tier 2 needs it.

#### The file layer ("tier 1") — the ONE thing that is not `ags request`

Added 2026-07-27. Six tools implemented **inside the daemon** with GLib/Gio rather than as IPC
actions: `read_file` · `list_dir` · `search_files` · `edit_file` · `write_file` · `load_skill`.

**Why it breaks the "everything through the gated surface" rule, deliberately:** external MCP
clients already bring their own file tools, so there is nothing for `nidara-mcp` to inherit; and
pushing file contents through the `ags` socket would put blocking I/O on the shell's main loop for
no gain. Do not "fix" this by promoting them to IPC actions.

**No bash, and this is not a step towards it.** Reading a file is a syscall — five of the six touch
no subprocess at all. `search_files` spawns `grep` with a **fixed argv**; `Gio.Subprocess.new()`
takes an array and never invokes a shell, so the model supplies data, never a command.

**Two frontiers, different shapes on purpose** (`resolvePath(raw, mode)` is the single door):

| | |
|---|---|
| **READ** — prefix roots | `~/.config/nidara`, `~/.config/uwsm`, `~/.config/hypr`, `/usr/share/nidara`, plus the shell log (both spellings of `nidara-ui`'s `${XDG_RUNTIME_DIR:-/tmp}` fallback). NOT the rest of `$HOME`: whatever it reads goes to the model provider, so this is a privacy boundary too. Symlinks ARE followed — in `--dev`, `/usr/share/nidara/config/hypr/hyprland.lua` is a symlink into the repo. |
| **WRITE** — exact 3-file allowlist | `~/.config/nidara/hyprland-user.lua` (+ the legacy `~/.config/hypr/` one), `~/.config/nidara/hypridle.conf`. Symlinks refused here. |

Paths are `GLib.canonicalize_filename`'d **before** the prefix check, so `~/.config/nidara/../../.ssh`
resolves and is refused rather than sneaking past.

**The write frontier grants DEFERRED EXECUTION and there is no way around it** —
`hyprland-user.lua` exists to hold `hl.exec_cmd(…)`, `hypridle.conf` holds `on-timeout` commands. That
is inherent to "add me a keybind", not a hole, but it means tier 1's property is **"nothing
invisible"**, not "cannot execute": everything scheduled is legible plain text, gated, and revertible.
Hence `allowFileWrite` defaults **OFF** (like computer-use) while `allowFileRead` defaults **ON** (like
screenshot — Nidara reading Nidara). Write implies read; revoking read revokes write.
**`~/.config/uwsm/env` is readable and deliberately NOT writable**: `LD_PRELOAD` there is straight
privilege escalation.

**Every settings JSON is absent from the write list, and the reason is a real bug class:**
`AgentConfig.save()` serialises the whole in-memory `_settings` on every change and **no config JSON
has a `FileMonitor`** — so a hand-edit survives until the next settings change and is then silently
overwritten. `set_config` is the only correct door. This is also why `skills/customize/SKILL.md` leads
with it.

**Three invariants enforced in code, not documented and hoped for:**
- The `-- @autostart start/end` block of `hyprland-user.lua` belongs to Settings → Apps → Autostart
  (`Autostart.tsx:writeEntries` re-reads from disk and splices only that region). Both write tools diff
  the block before/after and refuse — an edit inside it would vanish days later with nothing linking
  cause to effect.
- `write_file` refuses to overwrite a file not read this session (`readThisSession`, cleared on
  `reset`). `edit_file` needs no such check: knowing the exact text to replace IS having read it.
- `edit_file` requires a **unique** match; an ambiguous anchor edits a line nobody was looking at.

**Git-backed undo.** `~/.config/nidara` becomes a git repo on the first assistant write; every write is
a commit; identity passed per-invocation so it works with no global git config; failures are logged and
never fail the write. **The baseline commit MUST happen before the file is written** — the first
implementation initialised after, which committed the already-changed file as the baseline and made the
assistant's very first action the one thing that could never be undone.

**Skills** (`skills/<name>/SKILL.md`, resolved dev-checkout-first via the `.dev` marker exactly like
`readShellVersion`, else `/usr/share/nidara/skills`). Progressive disclosure is mandatory, not a
refinement: this very skill is ~100k tokens across its references — right for a developer's agent,
unusable where every token rides on every step of every turn. So `load_skill`'s description carries
only names + one-line descriptions and the body is fetched on demand. **Shipped by BOTH install paths**
— `install.sh` and `packaging/nidara/PKGBUILD`; forgetting the PKGBUILD line leaves `load_skill`
quietly absent for every package user while working perfectly on the maintainer's machine.

**`reloadHyprland`** (`HyprlandState.reloadConfig`) exists because a config edit previously had no way
to be applied: the shell listened for `configreloaded` and nothing could provoke it. It bypasses
`_dispatch` on purpose — `reload` is a top-level `hyprctl` command, not a dispatcher.

**Cost, measured 2026-07-27** — the fixed per-request prompt roughly doubled: `sys` 1687→2688 b,
`tools` 3893→7543 b, i.e. **≈ +1163 tokens on every step of every turn**. Mostly recovered by the
existing cache breakpoints, but the Gemini lane was observed at `cached=0` on the first step of each
turn (implicit cache expiring between turns). The two path lists inside `read_file`/`edit_file`
descriptions are the biggest single addition and are the first dial to turn if this needs shrinking —
they buy the absence of a guess-and-retry round-trip.

#### Computer-use — the same helpers, but only while the gate is on (2026-07-27)

The Assistant reaches third-party apps through the **same four helpers** MCP uses
(`nidara-a11y`/`nidara-act`/`nidara-type`/`nidara-click`, see the next section), with the **same
tool names and parameters** (one addition: `query_app` takes a `match` — see the projection below).
One vocabulary for the project: a verb added to the wrapper lands in both consumers with the same
shape, and the section below documents both.

Five things are specific to this consumer and are the whole content of the work:

- **The gates decide what is OFFERED, not only what is refused.** `buildToolset()` appends
  `query_app` only while `allowComputerUse` is on, and the ten action tools only while
  `allowComputerControl` is too. Both ship OFF, so the common case pays nothing — measured on the
  CI shell: fixed prefix **8,472 b → 9,384 b** with perception (+912 b), **→ 17,400 b** with control
  (**+8,928 b ≈ +2,200 tokens on every step**). That number is the reason for the conditioning, not
  a footnote to it. Perception-without-control is a real state and is offered as one: look at an
  app and report, touch nothing.
- **The gate is re-read at the TURN BOUNDARY** (`syncComputerGate()` in `runTurn`), which drops the
  cached toolset AND system prompt when it changed. Without that, a user who grants permission
  mid-conversation keeps talking to an assistant that was never told. Deliberately not mid-turn:
  rebuilding between two steps of one request chain produces a `tool_result` for a tool the
  provider was never offered.
- **`helperResult()` marks a refusal as a FAILED result.** Every helper prints one JSON object
  (`{error}` / `{ok:false}` / `{ok:true}`); MCP relays it as text, but three things here read `ok`
  and all three are wrong otherwise — the island's tool chip (it would settle as success), the
  two-strike repeat guard, and the model.
- **A real accessibility tree does not fit in a chat, and `query_app` is projected because of it.
  This was proven by a live failure, not predicted.** Asked to toggle Nautilus's sidebar, the
  Assistant queried the window, never found the control, and invented an action name. The button
  was there and perfectly described — `id:"Show Sidebar"`, `role:"toggle button"`,
  `actions:["click"]` — at **node 157 of 175, byte 55,313 of 60,367**: past the cap.
  **A positional cut loses the wrong end** — GTK walks content first and chrome last, so a file
  list fills the budget and the header bar, where the buttons worth pressing live, is what falls
  off. Four changes, none of which makes anything unreachable:
  - **`match`** (substring over name/text/role) — the lever the truncation notice names. An empty
    match reports how many nodes WERE scanned, so "nothing matched" is distinguishable from "the
    window is empty". A matched look costs **~256 b**.
  - **`match` takes alternation** — `"a|b"` keeps a node matching either, so the two ends of a drag
    are one call. Added because the model wrote `match:"cs.svg|Trash"` unprompted and got five
    empty results against the old plain-substring test (live, 2026-07-29). A literal `|` in a name
    loses; that is the trade.
  - **`showing` on a match with ≤ 8 hits, plus the PRICE of the alternative.** A filtered query
    that found little is one step from the whole-window dump, and the model cannot see what that
    costs: measured 2026-07-29, one such fallback on Telegram put 37 KB into the history and rode
    every later step — **~78k of a 125k-token turn**, spent to learn that the button is called
    *"Buscar mensajes"* (the UI is in Spanish; the model had matched `"search"`). So the result now
    carries the on-screen labels and a hint naming the dump's size in KB, instead of the old hint
    that recommended `without match` while saying nothing about its cost. **Control-first, not
    document order** — same head-cut trap one level up: on the live Telegram tree, document order
    spends 18 of its first 19 slots on table cells, while a role filter gives 16 names, all
    controls, 401 b, target second. **But control-first is an ORDERING, not a filter** — the
    remaining slots fill with everything else labelish, because in a chat window the content is
    noise while in a **file manager the content is the target** (Nautilus draws items as
    `table cell`/`table row`; a role-only list offered "Open Trash" and not the file to drag onto
    it, and the model paid a 21 KB dump for the other half). Filling costs Nautilus 406 → 729 b
    and Telegram 401 → 743 b. MCP clients are unaffected — this lives in the daemon's projection,
    and they get the raw tree.
  - **Leaned nodes** — drop what carries no targeting information: `window` (the same string on all
    175 nodes; hoisted to the top), `type` (a duplicate of `role` in every node observed),
    `visible` (already in `states`), and the states every node has (`sensitive`/`showing`/…).
  - **`path` trimmed** to its last two links, each capped at 48 chars. It is the heaviest field —
    51 KB of Nautilus's 102, **348 KB of Telegram's 503** — because the chain repeats for every
    sibling and an ancestor's name can BE the content (a Telegram list item's accessible name is
    the whole message, ~900 chars, echoed down every descendant). This consumer never navigates by
    path; it targets name + role + occurrence.
  - **Repeated siblings collapse** — first 3 of each `path`+`role` run, then a count. A file
    manager's hundred rows are one *kind* of thing. Document order is preserved: reordering would
    cost the model the only spatial information a flat list still carries.

  Measured after: **Nautilus 102 KB → 27 KB, Telegram 503 KB → 19 KB, both arriving WHOLE** instead
  of cut at the header bar. Orientation fields (`window`, `count`, `of_nodes`, `match`, `hint`) are
  emitted FIRST — a notice appended after 30 KB of nodes sits behind everything else in the result.
  The cap here is its own (`MAX_A11Y_RESULT`, 32 KB, sized from those measurements) because a
  window's controls are the whole point of the tool. MCP clients keep the raw tree — they have the
  context and pay once per call.
- **A tool description must not model the thing it forbids.** The same live failure had a second
  half: `do_app_action` was sent `win.toggle-sidebar` — a plausible GTK action name the model had
  never seen — aimed at a panel whose `actions` array was empty. The description had offered *"or
  an app action like `view.show-hidden-files`"* as an example, which is an invitation to invent
  one. It now says the action must be COPIED from that node's own `actions`, and that a node with
  none is `click_app`'s job.
- **The descriptions are re-authored, not copied, and the reason is not brevity.** THIS CLIENT HAS
  NO EYES. The MCP wording sends an agent to a screenshot to read what the tree cannot show; here
  that is advice to stare at a PNG it will never receive. So `hover_app` says a tooltip's text is
  unreachable *and to say so*, the `*_at` tools say coordinates come from a node's bounds and never
  a guess, and the gated prompt block states once that `run_action screenshot` returns a **path**,
  not a picture. Cross-cutting rules (focus first, preference order do_app_action → keyboard →
  pointer → coordinates) live in that prompt block instead of being repeated in eleven schemas.

Covered by CI (`agent-loop` scenario 4): both gate states, the positional argv handed to
`nidara-click` (`role` omitted + `occurrence` given must pad with `""`, or the occurrence lands in
the role slot and filters for a control whose role is `"2"`), the refusal-honesty flag, and every
half of the projection. Its stub tree is the shape that broke it live — a long run of identical
rows FIRST and the control the user asked for LAST — and the load-bearing assertion is that **the
control after the list survives**. Each assertion was verified to FAIL when its line is removed,
which is the only reason to believe any of them.

### The computer-use layer (third-party perception + action)

The agent surface above is the shell controlling **itself**. The computer-use layer is the jump
to perceiving and driving **any** third-party app. **Two consumers, one surface:** `nidara-mcp` for
external agents and the built-in Assistant (above) — both spawn the same helpers with the same
verbs, and the helpers are where every gate, focus check and kill-switch re-check lives. Add a verb
here and it is one wrapper mode + one tool in each consumer. Phase 1 — perception, read-only:

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
- **Terminals: the EMULATOR publishes the tree, not the program inside it.** A VTE terminal
  (`gnome-terminal`) exposes its visible screen as ONE node, `role: "terminal"`, whose `text` is
  the screen — so an agent can read a TUI, including another coding agent's session. **kitty
  publishes no tree at all** (absent from the registry, not empty), so there is nothing to read
  there and no filter will find it. **No scrollback** either way: only the visible grid.
  Three things about that node that are not guessable and cost real time:
  - **The cap cuts by the TAIL for grid roles** (`TAIL_FIRST_ROLES`), because a terminal's newest
    output and its prompt are at the BOTTOM. Head-first truncation is the same
    positional-truncation failure as the node budget losing Nautilus's header bar: it returns a
    stale screen and no way to tell. The notice states the loss and names no lever — there is none.
  - **⚠️ `get_character_count` OVER-REPORTS on VTE** (measured 5535 against a `get_text(0, n)`
    returning 4925: it counts screen CELLS, the text drops per-line trailing blanks). Usable as
    the upper bound of a range request and **nothing else** — an offset derived from it lands past
    the real end and AT-SPI answers with an **EMPTY STRING, not an error**, i.e. `text: null` with
    a silent stderr. Take a tail by fetching the node whole and slicing in JS.
  - **Grid text is per-line rstripped** (1402 of 5432 chars on one screen were width padding).
    Lossless on a grid, so it buys back a quarter of the budget; **not** applied to plain text
    widgets, where a trailing space can be something someone typed.
- **A control ADOPTS the value it displays (`foldValueCarriers`).** GTK4 puts a control's text in a
  CHILD — a combo box's entry, a spin button's field — so flattened it lands as `text: null` on the
  control plus a separate anonymous node, tied to it by nothing but geometry. Any role filter then
  keeps the control and drops the carrier: `match:"combo box"` answered with seven nameless boxes and
  the value nowhere, the model reported the text "not available through the accessibility interface"
  with it ONE NODE AWAY, and recovering cost a 23 KB whole-window dump (bench, 2026-08-01). A control
  with nothing to read now adopts the text/value of a descendant that fills it, and that descendant is
  dropped.
  - **Containment, NOT equality** — the same lesson as `collapseContained`, and getting it wrong cost
    a debugging pass here too: a combo box is 405 px wide and its entry 369, because the arrow takes
    the rest. The test is "inside the host and ≥ half its area"; the area floor is what stops a list
    item in a scroll pane from being read as the pane's value.
  - Only ANONYMOUS descendants fold (one with an accessible name is addressable in its own right),
    and the action helpers walk the live AT-SPI tree themselves — nothing here can make a control
    unreachable.
  - **It does not manufacture coverage.** A plain `GtkDropDown` showing "Left" is, verified raw,
    panels all the way down with no name and no text anywhere: the value is simply not in AT-SPI.
    There the honest answer really is "I cannot see it", and that is what the model will get.
- **A name-addressed tool must name the coordinate-addressed one.** `do_app_action` aims by accessible
  name, and an app can be full of controls that have none (GTK4's own widget factory: nameless
  switches, combo boxes, tabs). No wording about picking a *better* name can rescue that — on the
  bench the model spent three steps here, twice sending an EMPTY node name. Both the miss and the
  omitted-node case now point at `click_at` + the `bounds` from `query_app`. An omitted argument is a
  SIGNAL (the caller had nothing to give), not a slip; restating the signature just buys a third try.
- **ONE APP WEARS THREE NAMES, and every helper must answer to all three.** Hyprland's class
  (`org.gtk.WidgetFactory4` — what `list_windows` and `launch_app` hand back), AT-SPI's app name
  (`gtk4-widget-factory` — what `query_app` sees) and the `.desktop` name (`Widget Factory`). The
  invariant is **`sameApp()`, duplicated verbatim in `bin/nidara-{a11y,act,click,type}`** (they are
  standalone scripts, each copied to `/usr/bin` on its own — there is no shared module, so the
  comment marks them as copies; change one, change all four). `AppService.nameTokens` in the shell
  is the same rule in TypeScript. It runs as a **rescue after a strict substring miss**, so an exact
  filter keeps meaning exactly what it meant, and app selection is decided on NAMES BEFORE the tree
  is walked — the rescue never costs a second walk.
  - Order: exact/substring → **token-set subset** → bare-letters containment.
  - **Tokenize the ORIGINAL string, never a lowercased one.** The word breaks of `WidgetFactory`
    live in its capitals; lowercasing first fuses it to one token and the match fails. This is the
    bug the deterministic test caught while writing the fix — `sameApp` had it internally.
  - Subset, not equality, is what makes a **superset query** work (`GTK Widget Factory` ⊇
    `Widget Factory`) — which is how users and window titles actually name things.
  - The bare-letters pass exists because `hyprctl activewindow` hands us an **already-lowercased**
    class, where the camelCase seams are gone for good.
  - Why it matters, measured on the bench 2026-08-01: `query_app` accepted only the AT-SPI name and
    `click_at` only the Hyprland class, so **no single string drove both halves** and the model tried
    four names for one app — six wasted steps in one turn. Perception and action must be aimable by
    the same string or the loop cannot close.
- **A perception result is a SNAPSHOT and the tool has to say so** — measured twice with the
  same model, which is what rules out model tier. Fresh conversation: it called `query_app` and
  answered correctly. Same question with an earlier `query_app` in history: **`steps=1 tools=0`**,
  no call at all, answered from the stale copy while the answer sat on the live screen. Reusing it
  is *reasonable* — a file read stays true until something writes, and the daemon models exactly
  that (`readThisSession`, invalidated in `writeFile`). A screen has **no write to hook**: it goes
  stale on its own, so no mechanism can mark it and the DESCRIPTION carries the rule ("snapshot of
  one instant, call it again before answering about now"). Kept in parity in `nidara-agent` and
  `nidara-mcp`. **Any new volatile perception tool needs the same sentence** — and note the shape
  of the lesson: the truncation notice that named a lever the tool did not have made things worse,
  so a caveat must always name the lever that works.

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
  `surfaces/bar/StatusIndicators.tsx` (`ccBadge`, `ccStatusBanner`). Since 2026-08-02 the registry
  holds **AI control only** — it is the home of PERMISSIONS THE CC HOLDS THE SWITCH FOR (mic,
  camera, screen-share when they get source detection), not of activities. Recording left in two
  steps and both are the same lesson: **the badge means "the Control Center has something for
  you", so an indicator whose CC surface may not exist must not light it.** A capture is fully told
  by the Activity Island (pill + ticking clock, always on screen), and the only CC thing about it
  is the screenrecord tile, which is opt-in (`defaultInCc: false`) and can live in the BAR ONLY —
  the badge was pointing at a panel that might say nothing, and it even brightened armed→active
  when a capture started, promising an escalation with nothing behind it.
  While control is granted, a small **badge** on the bar's Control-Center button signals it —
  **subtle** when armed (granted, idle), **full** when active (for ~`ACTING_DECAY_MS` after a real
  action); neither state animates, see design-system.md. The banner card is a **Cairo
  SquircleContainer** (`Shape.CAPSULE`, BaseIsland's padding/border/inset numbers, `GRID_WIDTH`
  size request on the CAPSULE and `halign END` to share the grid's right edge), NOT a CSS card, and
  it is deliberately not given `.cc-island` — that class carries
  `.cc-island button { @include nidara-reset }`, which matches `button.nidara-btn` at EQUAL
  specificity and, `_control-center` being imported after `_components`, would strip the Stop
  button's background and border. The action tools (`nidara-act`/`nidara-type`/`nidara-click`)
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
  MCP: `type_text` / `press_key`. The loop: `query_app` → `focus_window` →
  `type_text`/`press_key`. **Two different kinds of focus, and confusing them cost a step in a
  live run (2026-07-28):** the WINDOW must be Hyprland's active one and `focus_window` is the only
  verb for that — `do_app_action … SetFocus` cannot do it. Focusing the CONTROL with `SetFocus`
  works only where the toolkit exposes that action (Qt usually does; **GTK4 usually does not** — it
  dropped ATK, `Component.GrabFocus` returns false and many nodes carry an empty action list). To
  put a NUMBER in a field, don't aim a keyboard at all: `do_app_action … set-value=N`.
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
  `focus_window telegram` → `do_app_action telegram "<field>" SetFocus` → `type_text telegram "…"`
  (the middle step is the **Qt** case; on GTK4 it usually fails — go straight from `focus_window`
  to `type_text`, or use `set-value` for a number). A refusal from `nidara-type`/`nidara-click`
  now carries the target window's **address** in `focus`, so recovery is one `focus_window` call
  and not the `list_windows` → `focus_window` → retry that a live run spent three steps on.

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
  physical). **Every verb has both forms** — `*-app` names an AT-SPI node, `*-at` takes a
  window-relative point: `app`/`at` (left-click), `rclick-app`/`rclick-at` (right-click),
  `hover-app`/`hover-at` (pointer move, no button), `scroll-app`/`scroll-at` (scroll, with
  `<dx> <dy>` notches), `drag-app`/`drag-at` (two nodes / two points). The CLI mode name is the
  wrapper's vocabulary and `MODES[mode].action` is the injector's — they differ where the
  user-facing verb is clearer (`hover-*` → the C verb `move`). MCP: `click_app`/`click_at` take a
  `button` (`"left"`/`"right"`); `scroll_app`/`scroll_at` take `direction` (up/down/left/right) +
  `amount` (notches, default 3), mapped to dx/dy by the server; `drag_app(app, from_node, to_node)`
  with per-end `from_role`/`from_occurrence`/`to_role`/`to_occurrence`, `drag_at(app, from_x,
  from_y, to_x, to_y)`.
  **`hover-*` is not a lesser click.** It is the only way to reach state that does not exist until
  the pointer is there — tooltips, hover-revealed controls, submenus that open on hover — so the
  a11y tree cannot show it to you in advance. Read the tree AFTER hovering, **with one measured
  exception: a GTK tooltip is drawn on screen but is not an accessible at all.** Verified live on
  GTK4 (Nautilus, 2026-07-27): hovering its Back button rendered the tooltip in a screenshot while
  the AT-SPI tree held **zero** tooltip-role nodes before *and* after. So a hover can reveal state
  that a client without vision still cannot read — `screenshot` is the only way to that text.
  Controls a hover *reveals* are ordinary widgets and do appear in the tree.
  **Two more measured facts, 2026-07-29 (tech-debt #38 (l)) — a hover HOLDS, and what it reveals
  may not exist for AT-SPI.** The pointer is never moved back: `hyprctl cursorpos` still reported
  the target seconds after the helper exited, and the revealed panel stayed open indefinitely. But
  a hover is not a state we keep — it is a consequence of **which surface owns the pointer**, so
  the moment a full-screen shell region returns the app gets a pointer LEAVE and the popup closes.
  That is exactly what the **Activity Island's input region** does when it comes back, re-stamped by
  `InputYield`'s `end()` (until 2026-08-05 the same job was done by a full-screen dismissal catcher;
  the surface still owns the pointer either way). Hence the
  sequence the agent is taught: **`setIsland closed` → `hover_app` → `query_app` → `setIsland
  agent`**. And the second fact: **a Qt popup is as invisible as a GTK tooltip** — Telegram's emoji
  panel, open on screen, was absent from two independent walks of its tree (398 → 401 nodes, all
  four new ones unrelated, one window throughout). This is why `hover_app` does NOT read the tree
  inside the truce: it would have returned nothing.
  **Correction (2026-07-27):** this file used to justify the absence of `drag-app` with *"a
  two-ended gesture doesn't map cleanly to the single-node `*-app` shape"*. It maps fine — the
  wrapper resolves both ends through the same `resolveNode()` before anything is pressed, and a
  half-resolved drag is precisely what that ordering prevents. The real reason it was missing was
  that nobody had written it.
- **A control and the label INSIDE it are ONE candidate, not two** (`collapseContained`,
  2026-07-31). GTK gives a labelled button two accessible nodes with the same name in the same
  place; `resolveNode` counted both and refused — so on the bench **every** key press in
  gnome-calculator (`8`, `×`, `=`) came back `ambiguous: 2 nodes … pass a role and/or occurrence`
  and cost a round trip to re-ask, on a tree the model had already read. The collapse is by
  **containment, not proximity**: a hit whose centre falls inside an earlier hit's bounds is part
  of it (the walk is parent-first, so the control is the one kept). Verified both ways — the four
  calculator keys now land first try, and the `=` in the display vs the `=` key, which do not
  contain one another, are still correctly reported as two. `occurrence` therefore indexes DISTINCT
  targets now, which is what a caller meant by it. `centreOf` carries `w`/`h` for this and they are
  stripped before any candidate list is emitted, so the `{x, y, role}` shape is unchanged.
  **Not covered by CI**: it needs a live AT-SPI tree, and `agent-loop`'s stub helpers never reach
  the resolver.
- **A keyspec failure now says what to do instead** (2026-07-31). `wtype`'s own `Unknown key '*'`
  names what broke and not the next move, so the caller pays a round trip guessing — measured on
  the bench, `press_key *` failed and the recovery (`type_text "*"`) was a whole extra step. The
  key-mode failure appends that keysyms are NAMES (`asterisk`, not `*`) and that a literal
  character goes through text mode. Same principle as the two above and as `settingsPage` (#68):
  **an error that only names the failure costs a step; one that names the next move costs nothing.**
- **A refusal states what it KNOWS, never what it inferred** (2026-08-01). The focus refusal used to
  end `; it is not open — run_action list_windows to see what is` whenever it failed to find a
  matching window. That is an inference from *our own* matcher missing, and on the bench it was
  **flatly false**: the window was open AND focused, under another of its names. The model obeyed the
  sentence — `focus_window`, then `list_windows`, both no-ops — and failed again, two steps. It now
  says `no open window answers to that name`, which is the fact. Generalises past this one string:
  **an error that names the next move is worth nothing if the move is wrong**, and a diagnostic
  derived from a failed lookup must describe the lookup, not the world.
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
distance-scaled — deliberately hand-like, never a robotic zip), an effect keyed to the verb, then
a ~4 s linger with a pulsing accent **halo** around the tip before fading (persistent state is
already the bar's AI badge). **The effect must not lie about what the machine did**: a click
ripples OUTWARD ("something left here — a button went down"); a **hover** gets the same ring run
backwards, contracting onto the tip and docking into the halo's radius ("something arrived here"),
and its halo skips the 250 ms ramp so the accent never blinks out at the moment of landing.

**The real cursor is HIDDEN for the length of a choreography** (`cursor:invisible` via
`hs.setRealCursorVisible()`), and this is not polish — it is the only available fix. The hardware
cursor plane paints above every layer surface, so the fake arrow cannot be drawn over the real
one; the halo was the first attempt and a live session rejected it (2026-07-27): what the eye
follows is the cursor, and you saw the ordinary black pointer land on top of the arrow and then
teleport between chained actions. There is no way to raise a layer above the cursor plane, so the
other one goes. **The SHELL owns the hide, never `nidara-click`** — that helper is short-lived and
a crash between hide and restore would leave the user with no pointer. Every ending already passes
through `hardHide` (fade complete, kill switch, `hideForLock`, 3 s orphan timeout), which is where
the restore lives; `syncRealCursor()` derives the state from `isAgentPointerActive()` rather than
counting calls, so a burst across monitors cannot strand it; and the factory restores once per
shell start as unconditional insurance against a shell that died mid-action.
**Consequence that made a latent bug expensive:** every `cancel` from `nidara-click` must be sent
with `wait`. An abort emits its JSON and returns, so a fire-and-forget spawn dies with the process
and the choreography only ends on the orphan timeout. Measured: moving the mouse mid-action left
the user with **no cursor for 5.3 s**, against 343 ms once the cancel is delivered, and ~1.1 s end
to end (the remaining second is the travel — the wrapper only checks the physical cursor once the
fake one has landed). During the linger the overlay polls `hyprctl cursorpos`
(~2 Hz, idle phase only): if the user moves the real cursor > 24 px off the landing point it
fades early — the user always wins, also during the linger. Visible over fullscreen. Key
properties:

- **Land→confirm protocol — the visual never lies**: `nidara-click` reads `hyprctl cursorpos`
  (baseline), then blocks on `ags request agentPointer <kind> <gx> <gy> [gx2 gy2] [from bx by]`
  — the request resolves when the fake cursor **lands** (~0.45-1.2 s incl. pop-in; inside the
  helper's `timeout 2` bound). It then **re-checks the
  gate** (the kill switch can fire mid-animation and now stops the injection inside that window)
  and re-reads `cursorpos`: if the user moved the mouse **> 10 logical px** (euclidean), it
  aborts with a readable `{ok:false}` error and sends `agentPointer cancel` **synchronously**
  (fade, NO ripple) — **the user always wins**. Only if it actually injects does it send
  `agentPointer confirm` (async, right before the injector spawns) → the ripple ≈ the real click;
  a drag glides the fake cursor concurrently with the real 24-step drag (small cosmetic skew
  accepted). `confirm` survives being async only because the injector spawns after it; if that
  order ever changes it has to wait too, for the reason above.
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

**Two exceptions INSIDE the overlay state machine, for different reasons. First, the Activity Island** (`surfaces/island/IslandWindow.ts`, namespace `nidara-island`, layer OVERLAY) — the compact capsule and the expanded modes together. It still lives on `status.island_mode` and still animates GTK-side; only the surface it paints on is different. The reason is physical, not stylistic: Hyprland blurs what is composited BEHIND a surface, so nothing painted inside the bar's window can ever blur the bar's own capsules — and the island is the only overlay that covers the bar row (every other panel drops below it at `PANEL_TOP`). At the default `overlayOpacity` of 0.05 the capsules read through the island sharp and unblurred. A surface one layer level up is composited after the bar, so the blur pass finally samples it.

**The second exception: the app grid** (`surfaces/app-grid/AppGridWindow.ts`, namespace `nidara-app-grid`, layer OVERLAY, 2026-08-09). Its reason is economic rather than physical, and the distinction matters because it is the one a third candidate is most likely to fake. The grid used to be a child of the DOCK's window; Hyprland charges layer blur by the surface's BOX, so a guest that can paint anywhere forced the dock to clear its declared region for as long as the grid was up — the §46 saving disappeared exactly when the screen was busiest. On its own surface it declares the panel's rect (measured 1110×834 of 2560×1440) and is UNMAPPED when closed, which costs nothing at all, and the dock keeps its pill rect in every state.

It joined the state machine on the way out: `status.app_grid_open` is a normal mutually-exclusive overlay now. It was NOT one before — the dock coupling (opening the grid also revealed the dock) was the reason, and trading that coupling away removed the reason. What it inherits from being its own surface is the same list as the island's below, minus the morph-specific items: its own focus grab, its own input region, and CSS scoped to `#nidara-app-grid, .nidara-app-grid-window` rather than to the dock's window.

⚠️ **Peers are load-bearing, and the failure is silent.** A focus grab CLAMPS pointer focus to the surfaces in its whitelist, so a shell surface left out stops receiving even MOTION. The grid shipped with only the DOCK as a peer and the bar's capsules went inert — no hover, no click (user-caught 2026-08-09). Its peers are now the bar, the island and the dock: the same set the bar and island already grant each other. **Adding the bar as a peer has a required counterpart** — `dismissOverlays()` must close whatever you just whitelisted, because a peer is precisely a surface the compositor will not dismiss on, and the empty bar strip is GTK's job (see below).

**Move the capsule WITH the modes — this is load-bearing.** A first cut kept the capsule on the bar's surface. Two things went wrong: `compute_bounds` no longer resolved (it works inside one hierarchy only), forcing a coordinate bridge; and mid-morph both surfaces painted glass over the same pixels, so their blurs stacked and the transition showed a visible seam. One surface owning the shape end to end is what makes the morph what it was always meant to be — one object changing shape, not one dissolving into another. What the exception still costs, and what you inherit if you touch it:

- **Two input regions, not one.** The island surface stamps the capsule (always — it is a click target on an otherwise click-through surface) plus whatever mode is revealed. **Re-stamp when the capsule RESIZES**, not just when a mode opens: the compact stack interpolates width when the fronting activity changes, and a different media title reshapes the pill with no page change. `Bar.tsx` hangs that off the capsule's glass `DrawingArea::resize`.
- **A grab captures the POINTER, so the island's own surface owns its dismissal.** Whoever holds the grab receives the presses regardless of input regions, so a second surface cannot dismiss on its behalf. This first showed up under layer-shell `EXCLUSIVE`: only `needsKeyboard` modes grabbed, the bar's catcher therefore never saw an outside click while one was open, and the overview and the assistant stopped closing when the island moved out of the bar's window — while the ambient player, taking no grab, kept working. The symptom pointed at input regions and the cause was the grab. Today `IslandWindow` takes its own focus grab for EVERY open mode and whitelists the bar as a peer, which is what keeps capsule-to-capsule switching ONE click.
- **Hiding is by NAME, in two places.** The surface is always mapped (the capsule is permanent furniture), so it must follow the bar out of sight explicitly, and both places filter windows by name.
  - **Fullscreen (`Bar.tsx`) — this one has teeth.** The bar only goes to opacity 0; since the capsule no longer rides its surface, without `islandWin.setShown(false)` it stays floating over the fullscreen window.
  - **Lock (`lockScreen`/`unlockScreen` in `app.ts`) — consistency, not a fix.** Under `ext-session-lock-v1` (the path Hyprland actually takes — the lockscreen logs `supported: true`) the compositor composites ONLY the lock surfaces, so nothing else is drawn regardless. It would only matter on `startFallback` (`ui/lockscreen/app.ts`), the plain OVERLAY layer-shell degradation used when the protocol is unsupported, which does not happen here. It is in the list because the agent pointer already sets that precedent one branch above ("paints on OVERLAY (above the lockscreen fallback)"), and leaving the island out would make it the only shell surface not covered by the convention.
- **Grabs must not collide — and now they cannot silently.** The island takes its own focus grab on the ISLAND surface for every open mode, the bar takes one for what IT owns (`barModal()`). There is exactly ONE grab slot compositor-wide, so the two must never want it at the same time; when they do, the second EVICTS the first and the loser is TOLD (`onCleared`), which is what `FocusGrab`'s lease exists for. Under the old layer-shell path the same collision was silent: two surfaces holding EXCLUSIVE meant the compositor picked one and the other just stopped receiving keys.
- **Scoped CSS must name both windows.** `.agent-*` lives under `#nidara-bar, .nidara-bar-window, #nidara-island, .nidara-island-window` because the compact pill is in one surface and the expanded panel in the other.
- **Layer-level ordering is re-asserted, not assumed.** Bar overlay mode moves the bar to OVERLAY too, which would append it above the island; `islandWin.raise()` puts the island back on top.

**Bar.tsx owns ALL overlay geometry**, not the surfaces themselves. `syncPanelMargins` in `Bar.tsx` sets each overlay's `margin_top`/`margin_start`/`margin_end` (and re-runs on dock-side changes); the surface modules just build content and align to a corner. Because each overlay is wrapped in a `ScaleRevealer`, **the wrapper IS the `cc`/`nc`/`systemMenu`/... variable**, so margins/alignment/input-region all operate on the wrapper transparently. Conventions: panels sit `8px` from the screen edge (flush with the bar capsules, which is a stronger visual reference than the tiling `gaps_out` grid beneath). Gotcha: **the system menu must dodge a left-side dock** (`margin_start += dock.width`) and CC/NC/popups dodge a right-side dock — because the **dock is its own layer-shell window stacked ABOVE the bar window**, so an un-dodged overlay slides under it. Don't move positioning logic back into a surface module.

**Panels are content-sized — never force a wrapper's height.** The layer-shell input region is unioned from these allocations, so any wrapper forced taller than its visible content (an old `height_request` on `nc`/`cc` did this) puts the empty remainder into the region — and the compositor then reads a press there as INSIDE the grab instead of dismissing. It bit identically in the catcher era for a different reason (GTK4 picking is geometric, so a transparent Box above the catcher still won the pick): one bug, both mechanisms. Also remember `height_request` can only RAISE a minimum — it never caps, so it's the wrong tool for a height budget anyway. The vertical budget (bar→dock gap, `applyPanelHeights`) is pushed into the surface and enforced by an internal `Gtk.ScrolledWindow` with `propagate_natural_height: true` + `max_content_height` (NC does this via a `setMaxHeight` function attached to its returned widget, the same pattern as WorkspaceOverview's `onOpen`): the panel hugs its content until the list overflows, then scrolls.

**Outside-click dismissal is the COMPOSITOR's**, via `hyprland-focus-grab-v1` (`common/FocusGrab.ts`; mechanism and traps in `architecture.md` → "Focus grab"). The invisible full-screen `overlay-catcher` buttons that used to fake it are deleted (2026-08-05) and there is no fallback — a refused grab is a loud `console.error`, not a degrade. The bar's capsules stay clickable while a surface is open because the bar's own surface is inside the grab's whitelist, so clicking another capsule switches in ONE click; a press on the EMPTY strip between capsules is inside the whitelist too, so that dismissal is GTK's job (a bubble-phase gesture on `masterOverlay`). The pill guards in `Bar.tsx`/`AppTitle.tsx` check `cc_edit_mode` (pills inert while editing the CC), NOT `cc_open`.

**Input-region staleness gotcha (CC edit mode).** `updateInputRegion` reads `widget.get_allocation()`, which only reflects a size change **after the next layout pass**. Nothing backs the region up any more (the full-screen catcher rect used to hide this by accident), so every panel needs an exact rect — and CC edit mode is the hardest case, because it is the one open state that takes NO grab at all (other windows stay interactive while editing), leaving the region as literally the only thing deciding what is clickable. Toggling edit mode also *resizes* the CC (content-height grid ↔ full 8-row board + Done pill), so a naive allocation-based stamp uses the pre-toggle size and everything the grid grows into — the Done pill included — is click-through (clicks fall to whatever window is underneath). Three pieces make it correct, and all three matter:

1. **`measure()`, not just allocation**: in edit mode `updateInputRegion` unions the CC's *measured natural height* (reflects the resize synchronously) with its allocation, so the grown grid is clickable in the same frame.
2. **`IslandGrid` flips `status.cc_edit_mode` AFTER its `rebuild()`** — measure() can only see the new size if the height requests were already updated when the notify fires. Keep that ordering.
3. **Wayland input regions are double-buffered** — `set_input_region` only takes effect on the surface's **next commit**. A stamp that doesn't ride a visual change would sit pending until some incidental repaint (this read as "the Done pill stays dead for a while"), so `updateInputRegion` ends with `win.queue_draw()`. The `notify::cc-edit-mode` handler also re-stamps on a deferred one-shot (defer-a-frame idiom, as `showExpansion`) to settle the shrink direction when leaving edit mode.

If you add another state change that both resizes an overlay and relies on per-widget region rects, follow the same recipe.

**Keyboard focus for a keyboard-driven overlay → a FOCUS GRAB. Never `EXCLUSIVE`, never `ON_DEMAND`.** ⚠️ This section used to instruct the opposite; the layer-shell keyboard path was replaced wholesale by `hyprland-focus-grab-v1` (2026-08-06, `common/FocusGrab.ts`). **Every shell surface now rests AND opens in `KeyboardMode.NONE`** — bar, island, dock, app grid, agent-pointer — and takes the keyboard by acquiring a grab instead. Wiring an `EXCLUSIVE↔NONE` toggle into a new overlay does not merely duplicate a mechanism: `EXCLUSIVE` re-adds the surface to `m_exclusiveLSes`, and that list makes Hyprland **refuse to move window focus at all**, handing back the exact bug the migration removed (`tech-debt.md` §53).

So, for a new keyboard-driven overlay: leave `set_keyboard_mode` at `NONE` and call `acquireFocusGrab([win, …peers], onCleared)` when it opens, `releaseFocusGrab(token)` when it closes. The grab grants keyboard focus the instant it takes, which is what a text caret needs (a widget-side `entry.grab_focus()` alone is not enough — the toplevel must be compositor-active for the caret to render), and it brings outside-click dismissal with it. `Bar.tsx` does this in `syncKeyboardMode()` for everything it owns (`barModal()`), `IslandWindow` for every open island mode, `AppGridWindow` for the grid (it was `DockCore` until the grid got its own surface on 2026-08-09).

Key routing is unchanged and still worth copying: the Overview owns no text field — it exposes `onOpen()`/`handleKey()` on its widget, `ActivityIsland` routes them per-mode, and `Bar.tsx` adds a CAPTURE-phase `Gtk.EventControllerKey` on `win` that forwards keys to `island.handleKey` while `island_mode` is set (←/→ move a `.keyboard-focus` cursor, Enter switches + closes, Esc closes) — the exact pattern the app grid uses on its own window.

*Historical, and the reason the old advice existed:* under layer-shell, `ON_DEMAND` made **Hyprland withhold keyboard focus from the surface until the pointer entered or clicked it**, so Prism's caret wouldn't blink until you moved the mouse — hence "EXCLUSIVE, not ON_DEMAND". The app grid was the last surface stuck on it, because an `EXCLUSIVE` layer won't let a child `Gtk.Popover` take keyboard focus and its context menus needed one; FocusGrab's popup SUSPEND (see `architecture.md` → "Focus grab") is what finally freed it. `ON_DEMAND` remains wrong for an unrelated reason — see "THE RULE: a shell surface rests in `NONE`, never in `ON_DEMAND`" above for what it does to the seat.

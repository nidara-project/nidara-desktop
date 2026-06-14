# Crystal Shell — State machine & IPC

Read this when adding a new overlay, wiring a new keybind to a UI action, debugging "overlay won't close", or touching anything that previously used `globalThis`.

## The contract: `core/Status.ts`

All overlay visibility flows through one central GObject. **Widgets never flip each other directly.** A widget that wants to know whether the Control Center is open subscribes to `notify::cc-open` on `status` and reacts to that signal.

### Mutually exclusive overlays

Setting any of these to `true` closes all the rest:

- `cc_open`
- `nc_open`
- `prism_open`
- `system_menu_open`
- `overview_open`

This mutual exclusion is **enforced manually inside each setter** — every setter explicitly closes the others. This is a known duplication smell (~80 lines repeated across setters; see `tech-debt.md` item 4) but until it's refactored into a `closeOthersExcept()` helper, you must preserve the pattern when adding a new exclusive overlay.

### Other tracked props

- `about_open` — opened via `status.about_open`, not via a `toggleAbout` because `AboutWindow` is create+destroy, not hide.
- `settings_open` — Settings hides on close instead.
- `recording`
- `cc_edit_mode`
- `bar_expanded_id` — which Bar pill is currently expanded.
- `cc_detail_id` — which CC detail panel is active.

### Toggles

`Status.ts` exposes typed togglers: `toggleCC`, `toggleNC`, `togglePrism`, `toggleSystemMenu`, `toggleOverview`, `toggleAbout`. There's also a convenience getter `isAnyOverlayOpen`.

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
  to verify: that's the intended agent loop. (`crystal-shell-doctor` embeds this output in
  its diagnostic report.)

Current commands (run `listActions` for the live list): `toggleCC|toggleControlCenter`,
`toggleNC|toggleNotificationCenter`, `togglePrism|toggleSpotlight`, `toggleAppGrid`,
`openSettings` (alias `toggleSettings`), `settingsPage <pageId>`, `toggleOverview`, `toggleGameOverlay`,
`openWindowMenu`, `hideForLock`, `showAfterLock`, `describeConfig`, `getConfig [key]`,
`setConfig <key> <value>`, `screenshot [path]`, `queryUI [selector]`, `listActions`, `dumpState`.
Aliases are intentional — Hyprland keybinds were renamed at one point and old names are kept.

`screenshot [path]` captures the focused monitor with grim and returns the PNG path
(default `/tmp/crystal-shell-shot-<ts>.png`) — the visual-verification leg of the agent
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
Two gotchas learned building it: (1) **overlays live under the `crystal-bar` window**
(commandment 5), so scope the CC/NC/menus with `@bar`, *not* `@control`; (2) `pageBox(id)`
sets the id as a **CSS class**, so a Settings page is `.display-page`, not `#display-page`.
Examples: `ags request queryUI .bar-app-name` (assert the focused-app wordmark text),
`queryUI .crystal-list-title@settings` (assert a Display monitor section rendered),
`queryUI .crystal-menu-row` (a flat menu's rows). It pairs with the deterministic show
actions (`settingsPage X`, `toggleCC`) — open, then `queryUI` to assert — and avoids
synthesizing clicks. Some surfaces only open on a click, so they get a **deterministic
interaction hook**: an IPC action that invokes the *same handler* the click would, no
synthetic input. The first is `openWindowMenu` (the AppTitle capsule menu — `ags request
openWindowMenu`, then `queryUI .crystal-menu-label` for its rows). The pattern: the
widget that owns the menu registers a `shellActions.openWindowMenu`-style fn (it needs the
widget's local anchor/builder/state), and a thin IPC command calls it — see `ShellActions.ts`
and `AppTitle.tsx`. Add more the same way (e.g. a dock context menu) when a click-only
surface needs verifying. NB: menu **row text** lives on the child `.crystal-menu-label`
label, not the `.crystal-menu-row` button container (queryUI reports own text, not
descendant text), so assert against the label class. Tier 1 is structure+text; semantic per-widget state (slider value,
dock-item running/active) is a deferred opt-in tier the widgets would cooperate on, sharing
the same node model the AT-SPI2 backend now fills for third-party apps (see "computer-use"
below — `queryUI` is the shell's own toplevels; `query_app` is the same shape via AT-SPI).

Commands receive arguments: `requestHandler` passes `argv.slice(1)` to the handler
(`run(args)`). `ags request settingsPage bluetooth` opens the Settings window directly on
that page (sidebar category ids; returns `unknown page: <id>` for bad ids) — the agent-
friendly way to reach a Settings page without synthesizing clicks.

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

### The MCP server: `crystal-shell-mcp`

The whole surface above is also served over MCP by `bin/crystal-shell-mcp` (installed to
`/usr/bin`), a standalone GJS script — same no-Node pattern as `crystal-portal` — speaking
MCP over stdio. Two discovery paths, dev and user:
- The repo's `.mcp.json` registers it for any agent working in this checkout.
- `install.sh` always (re)writes `~/.config/crystal-shell/.mcp.json` — the one
  installer-managed file in the config dir — pointing at the PATH binary. An agent opened
  inside the config dir auto-discovers it; any other agent can be told to "register the MCP
  server described in `~/.config/crystal-shell/.mcp.json`" (content:
  `{"mcpServers": {"crystal-shell": {"command": "crystal-shell-mcp"}}}`). The Settings → AI
  page shows this path to the user ("Connect Your Agent" row).

It is a **thin adapter with mostly no logic of its own**: every shell-self-control tool shells
out to `ags request` (or `crystal-shell-doctor`), so the `IPC_COMMANDS` table stays the single
source of truth — a new IPC command is reachable through the `run_action` tool with zero MCP
changes. Tools: `list_actions`, `run_action(name, args)`, `list_apps`, `launch_app(id)`,
`dump_state`, `query_ui(selector)`,
`query_app(app)`, `do_app_action(app, node, action)`, `type_text(app, text)`,
`press_key(app, key)`, `focus_window(app)`, `click_app(app, node, button?)`, `click_at(app, x, y, button?)`,
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
legs, and they run `crystal-a11y` / `crystal-act` / `crystal-type` directly (like `doctor` runs
the doctor), **not** `ags request` — because reaching into a *third-party* app is not
shell-self-control and must not live in the shell process. See "The computer-use layer" below.

Governance: `ai.json.allowMcp` (Settings → AI → "Enable MCP Server") is re-read on **every**
tool call, so the toggle applies live with no restarts; when off, every tool refuses with a
pointer to the page. The finer gates (`allowConfigWrite`, `allowScreenshot`, `allowComputerUse`,
`allowComputerControl`) are enforced downstream (by the shell, or by
`crystal-a11y`/`crystal-act`/`crystal-type` for the computer-use tools) — never duplicate them in
the MCP layer beyond the live re-read the tool already does. Like the rest of `ai.*`, `allowMcp`
is visible via `describeConfig` but not writable via `setConfig`.

### The computer-use layer (third-party perception + action)

The agent surface above is the shell controlling **itself**. The computer-use layer is the jump
to perceiving and driving **any** third-party app. Phase 1 — perception, read-only:

- **`bin/crystal-a11y`** (standalone GJS, `gi://Atspi`; same no-Node pattern as
  `crystal-shell-mcp`/`crystal-portal`) reads an app's **AT-SPI2 accessibility tree** and prints
  it in the **same flat `UINode` shape as `queryUI`** (additive a11y fields: `role`, `states[]`,
  `actions[]`, and `shortcuts[]` when present). `crystal-a11y` (focused window, resolved via
  `hyprctl activewindow`) or `crystal-a11y <app-name>`. Read-only: it lists available action
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
  live by both `crystal-a11y` and the `query_app` MCP tool.
- **Coverage caveat**: GTK4 exposes its tree on Wayland regardless; Qt needs `QT_ACCESSIBILITY=1`
  (which `allowComputerUse` triggers via `toolkit-accessibility`, so Qt shows a "screen-reader
  mode" banner); Chromium/Electron need `--force-renderer-accessibility`; the rest fall back to
  `screenshot` (vision). AT-SPI screen coords are unreliable on Wayland → bounds are
  **window-relative**.

Phase 2a — **action, deterministic only (built)**:

- **`bin/crystal-act`** (standalone GJS, `gi://Atspi`; SEPARATE binary from `crystal-a11y` so
  perception stays read-only) invokes a **named AT-SPI action on a named accessible** via
  `atspi_action_do_action(i)` — `crystal-act <app> <node-name> <action> [role] [occurrence]`.
  **No coordinates, no synthetic input**: it targets the accessible directly, so it is auditable
  and **not focus-dependent** (sidesteps the focus-race class of bug). The agent perceives a node
  (name + `actions[]`) with `query_app`, then acts by name with `do_app_action`. GTK4 exposes
  rich actions (incl. its GActions: `win.go-home`, `view.show-hidden-files`…); Qt often exposes
  only `SetFocus` (focus yes, click no — clicking Qt waits for synthetic input, Phase 2b).
- **Gate: `ai.json.allowComputerControl`** (Settings → AI → "Allow Agents to Control Other
  Apps"), a **second** default-OFF gate distinct from perception. Enabling it (via
  `AgentConfig.setAllowComputerControl`) also enables `allowComputerUse` — you can't drive what
  you can't see. The effective check is `allowComputerControl && allowComputerUse`, re-read live
  by `crystal-act` and the `do_app_action` MCP tool.
- **Always-visible indicator + kill switch**: while control is granted, a red `bar-cua-capsule`
  shows in the bar (mirrors the recording indicator; `Bar.tsx`). It IS the kill switch — clicking
  it, or the `Super+Shift+Esc` keybind (`config/hypr/hyprland.lua` → `ags request
  disableComputerControl`), revokes control instantly. The user is never unaware the agent may act.
Phase 2b-i — **synthetic keyboard (built)**, for controls AT-SPI can't reach (Qt text fields;
Qt buttons that only expose `SetFocus` → focus then press Enter/Space):

- **`bin/crystal-type`** (standalone GJS; wraps **`wtype`**, the Wayland-native
  `zwp_virtual_keyboard`, no daemon; SEPARATE binary, synthetic input never lives in the perceive
  or AT-SPI-action helpers). `crystal-type text <app> <string>` /
  `crystal-type key <app> <keyspec>` (`Return`, `Tab`, `ctrl+a`, `ctrl+shift+t`; `super`→`logo`).
  MCP: `type_text` / `press_key`. The loop: `query_app` → `do_app_action … SetFocus` →
  `type_text`/`press_key`.
- **Same gate as 2a** (`allowComputerControl` + the 2a indicator/kill switch) — no new toggle.
- **SAFETY — focus-dependent**: `wtype` types into whatever window has focus (unlike `do_action`).
  So `<app>` is **required** and `crystal-type` **verifies it is Hyprland's active window**
  (`hyprctl activewindow`) before injecting, refusing otherwise — a keystroke can only land in the
  named app while it is actually focused. This is the deliberate mitigation for the focus-race
  class of bug.
- **`focusWindow <app>` IPC + `focus_window` MCP tool** — raise/focus a third-party window by
  class so it becomes the active window (the **precondition** for the keyboard). Unlike the other
  computer-use tools, this is a **shell IPC command** (it reuses `HyprlandState.focusWindow`, the
  same path the dock uses on a running-app click — `hl.dsp.focus({ window = 'address:…' })` via
  `hyprctl dispatch`; the classic `hyprctl dispatch focuswindow class:X` is rejected by our Lua
  config). Gated by `allowComputerControl`. The full autonomous loop:
  `focus_window telegram` → `do_app_action telegram "<field>" SetFocus` → `type_text telegram "…"`.

Phase 2b-ii — **synthetic pointer (click, right-click, scroll, drag), built**, for what AT-SPI/keyboard
can't reach (canvas, no-a11y surfaces, list items/tabs that need a real click, context menus,
scrolling off-screen content, drag-and-drop / rubber-band selection / sliders):

- **`bin/crystal-input`** — a tiny **C** Wayland client (`zwlr_virtual_pointer_v1`, no daemon/uinput)
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
- **`bin/crystal-click`** (GJS, sibling of crystal-act/crystal-type) owns the smarts: gate +
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
  is the in-shell, battle-tested reference incl. fractional scale (`crystal-click` mirrors it
  because it's a separate process). Verified exact here (scale 1: measured via `hyprctl cursorpos`;
  AT-SPI window bounds align 1:1 with Hyprland's `at`, no CSD offset). Still **measure** on
  fractional-scale / multi-monitor before trusting (per [[feedback_debug_verify_before_theory]]).
- **Deferred (not built)**: multi-monitor output targeting (`create_virtual_pointer_with_output`) —
  needs a second display to verify the per-output coordinate mapping.
- **Still deferred (beyond drag + multi-monitor above)**: a per-action "acting now" flash; a
  per-app allowlist; the Prism assistant as the perceive→act orchestration surface (Phase 3).

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

**Bar.tsx owns ALL overlay geometry**, not the surfaces themselves. `syncPanelMargins` in `Bar.tsx` sets each overlay's `margin_top`/`margin_start`/`margin_end` (and re-runs on dock-side changes); the surface modules just build content and align to a corner. Because each overlay is wrapped in a `ScaleRevealer`, **the wrapper IS the `cc`/`nc`/`systemMenu`/... variable**, so margins/alignment/`height_request`/input-region all operate on the wrapper transparently. Conventions: panels sit `8px` from the screen edge (flush with the bar capsules, which is a stronger visual reference than the tiling `gaps_out` grid beneath). Gotcha: **the system menu must dodge a left-side dock** (`margin_start += dock.width`) and CC/NC/popups dodge a right-side dock — because the **dock is its own layer-shell window stacked ABOVE the bar window**, so an un-dodged overlay slides under it. Don't move positioning logic back into a surface module.

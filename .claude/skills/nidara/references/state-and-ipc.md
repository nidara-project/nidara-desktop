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
- **BYOK, two backends**: Anthropic Messages API (`POST /v1/messages`, `x-api-key` +
  `anthropic-version`) and any OpenAI-compatible endpoint (`POST {endpoint}/chat/completions`,
  `Authorization: Bearer` optional — covers a local Ollama). Both **streamed via `curl -N` SSE**
  as a `Gio.Subprocess` (the house HTTP pattern — zero new deps); `cancel` = `force_exit()` the curl.
- **Provider vs protocol** (`core/AgentProviders.ts`): the user picks a provider by NAME
  (Anthropic · OpenAI · Google (Gemini) · Mistral · Groq · OpenRouter · Ollama (local) · Custom);
  the registry maps each to one of the two wire protocols and pins its endpoint + default model.
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
  wired by `nidara-setup`) and its secrets component is launched from `hyprland.lua`.
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
- **Tools offered to the model**: `run_action(action, args?)`, `set_config(key, value)`,
  `get_config(key?)`, `dump_state()` — all executed via `ags request`, gates enforced by the shell
  (a refusal comes back as the tool-result STRING; the daemon never re-checks gates). No
  screenshot/computer-use in v1.
- **System prompt = a small static core. The catalogues are TOOLS, not prose** (progressive
  disclosure, user's call 2026-07-21: "load what the agent needs when it needs it"). It used to paste
  in the whole IPC action list + settings schema + a state snapshot: **2,269 of the 3,157 tokens a
  bare "hello" cost — 72% of every request** for knowledge most turns never touch. Now
  `list_actions` / `describe_settings` / `dump_state` are tools the model calls when a request
  actually reaches the desktop, and the answer then lives in history for the rest of the
  conversation. Measured: a greeting **12,630 → 4,041 bytes (−68%)**; a desktop turn that already
  discovered what it needs, −66%; a desktop turn INCLUDING the discovery round-trip, −9% (the extra
  request is a small one). It also loads only the half it needs — a question about windows never
  pays for the settings schema.
  **The cost of this design is compliance**: a model that forgets to look up will invent action
  names. Three defences, keep all three — the core rules are imperative ("NEVER invent or guess"),
  each tool description repeats the requirement, and `run_action`'s rejection hands back what was
  actually sent. If a model is seen guessing, strengthen those before reverting to a fat prompt.
  Side benefit: `buildSystemPrompt()` no longer calls `ags request` at all, so the daemon no longer
  depends on the shell being up at spawn.
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
- **Tools offered to the model**: `run_action(action, args?)`, `set_config(key, value)`,
  `get_config(key?)`, `dump_state()` — all executed via `ags request`, gates enforced by the shell
  (a refusal comes back as the tool-result STRING; the daemon never re-checks gates). No
  screenshot/computer-use in v1.
- **System prompt** is autogenerated once per session: a short static core + a dump of
  `listActions` + `describeConfig` + a `dumpState` snapshot, so new actions/settings are usable with
  no prompt edits. **It is also the dominant token cost** — ~3.4k tokens, resent on EVERY request,
  and a tool step costs an extra request. Three things keep it in check (all measured 2026-07-21,
  16.3 KB → 12.5 KB on the wire, −23%):
  - **`compactJson()`** strips the pretty-printing the shell emits for humans (−13%, lossless).
  - **`HIDDEN_ACTIONS`** keeps out actions already offered as first-class tools (`getConfig`,
    `setConfig`, `dumpState`, …) and shell-internal plumbing (`hideForLock`, `agentPointer`, the kill
    switch). A **denylist**, deliberately: `run_action` stays a passthrough and a NEW action still
    appears for free — the property that makes the prompt self-maintaining.
  - **Prompt caching.** The prompt is byte-identical across a session, so it is cacheable. The
    OpenAI-compatible providers do this implicitly (no flag); **Anthropic does not and must be asked**
    — hence `cache_control: {type:"ephemeral"}` on the system block (write 1.25×, reads 0.1×).
  **Before optimising this further, read `cached=` in the step log** — and read it across a SESSION,
  not one request: implicit caching only pays from the second request onwards, so `cached=0` early
  means "not yet", not "never". Measured against Google 2026-07-21: `tok=4717 cached=4022` — 85%
  served from cache, i.e. the fixed prompt is largely a non-problem and further shrinking has poor
  returns. **The cost driver is STEP COUNT, not prompt size** (an 8-step turn cost ~25k input tokens);
  optimise the loop, not the prose. `ai.brainProvider`/`ai.brainBackend`/`ai.brainModel` are visible read-only via `describeConfig`
  (like the other `ai.*` keys); the key is not exposed.
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

**Bar.tsx owns ALL overlay geometry**, not the surfaces themselves. `syncPanelMargins` in `Bar.tsx` sets each overlay's `margin_top`/`margin_start`/`margin_end` (and re-runs on dock-side changes); the surface modules just build content and align to a corner. Because each overlay is wrapped in a `ScaleRevealer`, **the wrapper IS the `cc`/`nc`/`systemMenu`/... variable**, so margins/alignment/input-region all operate on the wrapper transparently. Conventions: panels sit `8px` from the screen edge (flush with the bar capsules, which is a stronger visual reference than the tiling `gaps_out` grid beneath). Gotcha: **the system menu must dodge a left-side dock** (`margin_start += dock.width`) and CC/NC/popups dodge a right-side dock — because the **dock is its own layer-shell window stacked ABOVE the bar window**, so an un-dodged overlay slides under it. Don't move positioning logic back into a surface module.

**Panels are content-sized — never force a wrapper's height.** Overlay panels sit ABOVE the catcher in the overlay stack, and GTK4 picking is geometric: a transparent Box still wins the pick. Any wrapper forced taller than its visible content (an old `height_request` on `nc`/`cc` did this) turns the empty remainder into a dead zone that swallows the outside-clicks that should dismiss the panel. Also remember `height_request` can only RAISE a minimum — it never caps, so it's the wrong tool for a height budget anyway. The vertical budget (bar→dock gap, `applyPanelHeights`) is pushed into the surface and enforced by an internal `Gtk.ScrolledWindow` with `propagate_natural_height: true` + `max_content_height` (NC does this via a `setMaxHeight` function attached to its returned widget, the same pattern as WorkspaceOverview's `onOpen`): the panel hugs its content until the list overflows, then scrolls.

**Outside-click dismissal is the `catcher`** — an invisible `Gtk.Button` overlay in `Bar.tsx`, visible whenever `isAnyOverlayOpen` (except CC edit mode). It covers everything **below the bar strip only** (`margin_top = BAR_H`): the bar's capsules stay clickable while a surface is open, so clicking another capsule switches surfaces in ONE click (the capsule's toggle fires and Status's mutual exclusion closes the previous one). Don't extend the catcher over the bar — that regresses to the close-then-reopen double click. The pill guards in `Bar.tsx`/`AppTitle.tsx` check `cc_edit_mode` (pills inert while editing the CC), NOT `cc_open`.

**Input-region staleness gotcha (CC edit mode).** `updateInputRegion` reads `widget.get_allocation()`, which only reflects a size change **after the next layout pass**. Normally that's harmless because an open overlay is backed by the full-screen catcher rect — but in CC edit mode that rect is deliberately skipped (other windows stay interactive while editing), so the region is exactly the CC's rect. Toggling edit mode also *resizes* the CC (content-height grid ↔ full 8-row board + Done pill), so a naive allocation-based stamp uses the pre-toggle size and everything the grid grows into — the Done pill included — is click-through (clicks fall to whatever window is underneath). Three pieces make it correct, and all three matter:

1. **`measure()`, not just allocation**: in edit mode `updateInputRegion` unions the CC's *measured natural height* (reflects the resize synchronously) with its allocation, so the grown grid is clickable in the same frame.
2. **`IslandGrid` flips `status.cc_edit_mode` AFTER its `rebuild()`** — measure() can only see the new size if the height requests were already updated when the notify fires. Keep that ordering.
3. **Wayland input regions are double-buffered** — `set_input_region` only takes effect on the surface's **next commit**. A stamp that doesn't ride a visual change would sit pending until some incidental repaint (this read as "the Done pill stays dead for a while"), so `updateInputRegion` ends with `win.queue_draw()`. The `notify::cc-edit-mode` handler also re-stamps on a deferred one-shot (defer-a-frame idiom, as `showExpansion`) to settle the shrink direction when leaving edit mode.

If you add another state change that both resizes an overlay and relies on per-widget region rects, follow the same recipe.

**Keyboard focus for a keyboard-driven overlay → `EXCLUSIVE`, not `ON_DEMAND`.** Because the overlays share the Bar's single layer-shell window, keyboard focus is a *window-level* concern: `Bar.tsx` calls `Gtk4LayerShell.set_keyboard_mode(win, …)` via a shared `syncKeyboardMode()` helper on the relevant overlay's `notify`. Click-only overlays (CC/NC/SystemMenu) need no keyboard, so they never set a mode. Two overlays DO need it: **Prism** (text input) and the **Activity Island** when its open mode declares `needsKeyboard` (the overview does: arrow-key workspace nav) — `syncKeyboardMode()` grants `EXCLUSIVE` while either holds (`prism_open || island.needsKeyboard()`) and returns to `NONE` otherwise. The Overview owns no text field: it exposes `onOpen()`/`handleKey()` on its widget, `ActivityIsland` routes them per-mode, and `Bar.tsx` adds a CAPTURE-phase `Gtk.EventControllerKey` on `win` that forwards keys to `island.handleKey` while `island_mode` is set (←/→ move a `.keyboard-focus` cursor, Enter switches + closes, Esc closes) — the exact pattern the app grid uses on the dock window. A search/text overlay (Prism) **must** open with `EXCLUSIVE` and return to `NONE` on close — under `ON_DEMAND` **Hyprland withholds keyboard focus from the layer surface until the pointer enters or clicks it**, so the search caret won't blink and you literally can't type until you move the mouse. `EXCLUSIVE` makes the compositor grant focus the instant the surface opens (a widget-side `entry.grab_focus()` alone is not enough — the toplevel must be compositor-active for the caret to render). The app grid (its own window) does the same: `EXCLUSIVE` while open, dropping to `ON_DEMAND` **only** when a `Gtk.Popover` context menu needs to take keyboard focus (an EXCLUSIVE layer won't let a child popover grab it); Prism has no popover, so it stays `EXCLUSIVE` throughout. When adding a new overlay with a text field, wire the same EXCLUSIVE↔NONE toggle.

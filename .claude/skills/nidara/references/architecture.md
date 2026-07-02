# Nidara — Architecture

Read this when adding/editing widgets, changing how overlays attach, modifying any `core/` service, or trying to understand how the shell actually boots.

## Tech stack at a glance

| Layer | Tech |
|---|---|
| Language | TypeScript / TSX → compiled to GJS |
| UI framework | AGS v3 (Astal + Gnim JSX) |
| Toolkit | GTK4 (pure — libadwaita fully removed) |
| Wayland surfaces | gtk4-layer-shell (layer-shell protocol), `Gtk4SessionLock` (ext-session-lock-v1) |
| Compositor | Hyprland ≥ 0.55 (config in **Lua**) |
| Session manager | **uwsm** (manages the session as systemd units/scopes) |
| Display manager | greetd (default; only installed if no other DM is enabled) |
| Astal system services | AstalHyprland, AstalNetwork, AstalWp, AstalMpris, AstalNotifd, AstalBluetooth, AstalTray, AstalBattery, AstalApps, AstalGreet, AstalAuth |
| Styling | SCSS → `style.css` |
| Build | `ags bundle` → standalone binary |
| Wallpaper | `awww` (swww fork) |
| Idle / night light | hypridle, hyprsunset |
| Qt look | Kvantum + qt5ct/qt6ct (synced from the theme engine) |

`@girs/` (≈58 MB of auto-generated GI typings) is **git-ignored**; it only powers local typecheck and editor IntelliSense.

## Boot sequence

1. Display manager (greetd by default) runs `/usr/bin/nidara` via `/usr/share/wayland-sessions/nidara.desktop`.
2. `nidara` (session wrapper script) sets Wayland/GI env, then:
   `exec uwsm start -e -D Hyprland hyprland.desktop -- -c /usr/share/nidara/config/hypr/hyprland.lua`.
   uwsm runs the session as systemd units → activates `graphical-session.target`, clean teardown on exit.
3. `hyprland.lua` on `hyprland.start` launches daemons via `uwsm app -- <daemon>` (independent systemd scopes):
   `nidara-ui`, `awww-daemon`, polkit agent, `hypridle`, `wl-paste --watch cliphist store`.
4. **`nidara-ui`** (UI launcher in `/usr/bin/`): kills stale `gjs`, then —
   - **Dev mode:** if `~/.config/nidara/.dev` exists, `cd` to its path and `ags run app.ts`.
   - **Prod mode:** exec the bundle at `/usr/share/nidara/ui/shell/build/nidara`.
   - Log: `/tmp/nidara-ui.log`.
5. **`app.ts`** (`ui/shell/app.ts`): sets dark/light via `Gtk.Settings.gtk_application_prefer_dark_theme` (pure GTK4 — no `Adw.init()`); registers the `nd-*-symbolic` icon search path; `app.start({ applicationId: "org.nidara.desktop", main, requestHandler })`. In `main()`: iterates monitors → `createUI(monitor)` (Bar + Dock per monitor), wires the dock-rebuild debounce, and populates `core/ShellActions` + the IPC registry (the bar/dock blur layer rules live in `hyprland.lua` as `hl.layer_rule` — the old `hyprctl keyword layerrule` calls were dead under the Lua parser and were removed).
6. Reload in dev: **`Super+Shift+R`** re-runs `nidara-ui` (the old `start_ui.sh`/`reload_ui.sh` no longer exist).

## Directory map (`ui/shell/`)

Five pillars by responsibility (UI split renamed from the old `widget/` dir 2026-06-11):

- **`core/`** — singleton services. **Never touch the UI directly.** (Detailed below.)
- **`styles/`** — all SCSS, compiled to one `style.css`.
  - `_base.scss` holds design tokens + `@mixin glass` + `@mixin nidara-reset`.
  - `_reset.scss` neutralizes Adwaita residue.
  - Per-component modules are scoped with `window#id { … }`.
- **`surfaces/`** — whole TSX surfaces that consume `core/` state. Each surface is a function that takes a `Gdk.Monitor` and returns a `Gtk.Widget`:
  - `bar/`, `dock/`, `control-center/`, `app-grid/`, `overview/`, `prism/`
  - `settings/` (+ `settings/pages/`, 18 pages), `about/`
- **`common/`** — shared UI pieces used across surfaces and widgets
  (`Slider`, `SquircleContainer`, `ScaleRevealer`, `MenuRow`, `widget-kit`, `DrawingUtils`…).
- **`widgets/`** — atomic CC/bar widgets, **auto-registered**: one file that
    default-exports a `const w: AtomicWidget = {...}` is ALL it takes —
    `scripts/gen-widget-index.mjs` scans the dir and regenerates the committed
    `widgets.gen.ts` (imports + `ALL_WIDGETS`; runs on npm build/dev hooks, on
    the dev launcher before `ags run`, and CI job `widgets-gen` fails if stale).
    Rules: widgets-only directory (anything else is a codegen hard-error; new
    helpers go in `common/` — `bar-helpers.ts` is grandfathered in EXCLUDE);
    unique `id`; no module-scope dependency on another widget (import order is
    alphabetical). Each widget declares a required `category` (`"media"` |
    `"utilities"` | `"system"`) + optional `barOrder`; `BAR_ORDER` is **derived**
    from those in `widgets/index.ts` (category order `[media, utilities, system]` =
    left→right, system nearest the tray, macOS-style — no hand-maintained list).
    `CC_DEFAULT_ORDER` stays editorial. The CC factories in `Toggles`/`Sliders`/
    `MediaIsland` return `CCWidgetSpec` (= `Omit<AtomicWidget,"category">`): they
    build content, not registry metadata, so they carry no category.
    **Zero-layout contract (2026-06-11)**: a widget never does host-geometry math.
    `buildContent(size, budget)` receives a `ContentBudget` (inner px the host
    guarantees: tile span − island padding, computed in `IslandGrid` from
    `islandPadding()` exported by `BaseIsland`) — size content from it, never
    from `UNIT`/`GAP`/padding knowledge (cpu-memory's ring derives from it; a
    widget's own intrinsic sizes — icon circles, buttons, its caption height —
    are fine). Panel widths (bar expansions / CC details) come from the
    **`PANEL_W` tier vocabulary** in `common/widget-kit.ts`
    (sm 200 / md 220 / lg 240 / xl 280 / full 356), never hardcoded px.
    GOTCHA: widget-kit MUST stay a leaf module — importing `CCLayoutManager`
    from it closes the cycle CCLayoutManager → widgets/index → widget →
    widget-kit → CCLayoutManager and **crashes the shell at boot**
    (CC_DEFAULT_ORDER undefined mid-cycle; typecheck does NOT catch module
    cycles — only a runtime boot does).
    **Hardware gate**: a widget tied to hardware declares `isAvailable()` (+
    optional `watchAvailable(cb)` for hotplug) — when false it's hidden from
    bar + CC (filtered in `Bar.rebuildBarWidgets` and `IslandGrid.syncCCLayout`,
    at the layout level so edit-mode cells stay coherent) and its Settings card
    renders off+disabled with a "no hardware" hint. Placement config is NEVER
    mutated by availability. battery/wifi/bt/ethernet/brightness implement it;
    a fallback "not present" buildContent branch is no longer the mechanism for
    hiding (battery keeps one only as defense in depth).
  - `common/` — shared: `SquircleContainer`, `DrawingUtils`, `Slider.ts` (the ONE Cairo slider — no `Gtk.Scale`, no PillSlider), `ManagedWindow`, `NidaraPopover`, `WorkspaceSchematic`, `ScaleRevealer.ts` (the ONE show/hide animation — overlays + banners, see design-system.md), `poll.ts` (`pollWhileMapped` — ANY recurring widget poll must gate on map/unmap: built-once-hidden surfaces like CC tiles must not keep session-long timers; idle baseline is 0 wakeups/s and we keep it that way), `MenuRow.ts` (`menuRow`/`menuSeparator`/`menuHeader`/`setRowChecked` — the shared row builder for flat `nidara-menu-*` lists; used by the CC context menu and the bar window menu. New flat menus use it, not hand-rolled rows)
  - `bar/WindowMenu.ts` — the **window-options menu**: any-button click on the AppTitle capsule opens it in the bar's shared expansion capsule (`openCustomExpansion`, same system as tray menus — glass/fade/anchoring/outside-click for free). Anchoring defaults to **centered** under the pill (fine for right-side tray menus), but left-edge capsules pass `align: "start"` so the panel's left edge sits flush with the pill's — AppTitle does, because a centered panel there spills off the left screen edge. Sections: window actions (float/pseudo/fullscreen + center/pin when floating; all checks from the one `hs.getClientJson` read), inline move-to-workspace strip (1..5, current disabled), **group/tabs (v2, 2026-06-11)**, workspace actions (float all). The group section reads `grouped` (member addresses in tab order) from the same json read: one `menuRow` per member (checked = the menu's window, i.e. the active tab; clicking another member = `hs.focusWindow` — focusing a member IS the tab switch), plus "Move Out of Group" (`hs.moveOutOfGroup`, only when ≥2 members) and "Ungroup" (`hs.toggleGroup(addr)`, dissolves the whole group); ungrouped windows get a single "Create Group" row (lone group → groupbar appears, others join by drag/keybind). Astal clients are used for tab LABELS only (identity: wordmark/title) — never state. Deliberately absent: "move into group" (`into_group` ignores the window selector — acts on the focused window only — and needs a direction, meaningless in a menu) and group-lock (`lock_active` dispatches fine but its state is not readable anywhere, and a check you can't read is bad menu UX).

Other top-level dirs: `ui/lib/nidara-kit/` (pure-GTK4 primitives lib — see end of file) and the greeter/lockscreen bundles. `ui/lib/` itself holds small modules shared ACROSS bundles: `users.ts` (user enumeration), `avatar.ts` (circular avatar for greeter+lockscreen — Gtk.Picture + center-crop pixbuf + pill radius, the same recipe as Settings → Users; plain Gtk.Image can't clip to a circle), `accent.ts`, `status-colors.ts`.

## `core/` services (singletons)

These are GObject singletons. Widgets subscribe to them via `notify::prop`. **None of them ever import a widget or call UI code directly** — state flows out, never in.

| File | LOC | Role |
|---|---|---|
| `Status.ts` | 202 | Central GObject state machine for overlays. Mutually-exclusive setters (opening one closes the others). Props: `cc/nc/prism/system-menu/overview/about/settings-open`, `recording`, `cc-edit-mode`, `bar-expanded-id`, `cc-detail-id`. **See `state-and-ipc.md`.** |
| `AppService.ts` | 685 | `.desktop` discovery, icon resolution + fallbacks, WM-class → Desktop-ID mapping. Backs Dock + AppGrid. **Launching: ALWAYS go through `getLaunchCommand(id)`** (wrapped in `uwsm app -- sh -c 'cd "$HOME" && exec <cmd>'`): it picks `flatpak run` for flatpak entries (gtk-launch's D-Bus activation dies silently for them when the session bus indexed its service dirs without the flatpak exports) and `gtk-launch` for everything else. Never parse `Exec=` by hand. Flatpak/Snap *discovery* requires `XDG_DATA_DIRS` set **before gjs starts** — done in `bin/nidara-ui`; GLib caches data dirs at first use, so patching the env in-process cannot fix it (verified 2026-06-12). For ordered icon-name fallback chains use `resolveIconChain(names)` (theme-first: any name in the ACTIVE theme beats earlier names that only exist in deep fallbacks or shipped assets; absolute-path entries = final custom fallback) — plain `getIconName(array)` exhausts deep fallbacks per name. Icon resolution NEVER mixes themes: per-app override (`~/.local/share/icons/nidara/`) → active theme (+ its `Inherits`) → hicolor (the app's own installed icon) → pixmaps. An icon the active theme lacks is fixed via the Settings → Apps per-app override, never by borrowing from another installed theme. When nothing resolves, app surfaces (dock, app grid, Prism, overview) fall back to `application-x-executable` (the active theme's generic app icon) — never GTK's broken-image `image-missing`. |
| `TrashService.ts` | ~125 | Watches the trash (gvfs `trash:///` + `trash::item-count`, aggregates all volumes; falls back to a FileMonitor on `~/.local/share/Trash/files`). Exposes `isEmpty`/`itemCount` + `subscribe`. Drives the dock trash icon (full ↔ empty, swapped in place by DockItem). |
| `ThemeManager.ts` | 534 | GTK/icon/cursor theme, dark mode, CSS providers (main/font/tokens/tint), hot-reload of `style.css` in dev. Also pushes the accent into Hyprland's **groupbar** active-tab color (`syncHyprlandGroupAccent`, at boot + on accent change, via `hs.evalLua`) — the one place accent enters compositor chrome; the rest of the group styling is static in `hyprland.lua`'s `group` block (glass borders like windows). Gotcha: a groupbar **bakes its colors at group creation** — config changes only affect groups made afterwards. |
| `NidaraTheme.ts` | 436 | Token engine: `generateTokensCss()` emits `@define-color` + `--nidara-*` for accent, transparency, materials, shadows, tint. Holds the canonical `ACCENT_PALETTE`. Syncs Kvantum/qt. |
| `RegionConfig.ts` | 218 | Time/date format, timezone (`region.json`). |
| `InputConfig.ts` | 194 | Keyboard/mouse/touchpad → writes `nidara-settings.lua`. |
| `HyprlandState.ts` | ~270 | Reactive wrapper over AstalHyprland (clients/workspaces/monitors + dispatch helpers) **and the ONLY door to hyprctl** — services/widgets never shell out to hyprctl directly; they call (or add) a method here. Vocabulary: dispatch helpers (`focusWindow`/`closeWindow`/`floatWindow`/`togglePseudo`/`togglePin`/`toggleFullscreen`/`centerWindow`/`sendToWorkspace`/`toggleGroup`/…, all `hl.dsp.*` Lua via a private `_dispatch` that logs the offending call), `getClientJson(addr)` (one-shot raw `clients -j` read for fields AstalHyprland.Client lacks: `pinned`, `grouped` — on demand only, never in `_refresh`), `evalLua(call)` (live config changes — the Lua parser rejects `keyword`), `getOptionInt(name)` (sync) / `getOptionJson(name)` (async batch re-syncs), `setCursor(theme, size)`, `version()`. Caches **effective** config AstalHyprland doesn't expose (`availableModesByName` — `Monitor.available_modes` is always null) and emits `config-reloaded` on Hyprland's `configreloaded` IPC event (effective-config consumers re-sync on it). Exempt from the single-door rule: config text *written for other daemons* (the hypridle config generated by Power.tsx — those lines execute outside the shell; the before/after-sleep hooks themselves are static scripts in `bin/`). |
| `NightLightManager.ts` | 174 | Blue-light filter via hyprsunset (`night-light.json`). |
| `WallpaperManager.ts` | 127 | Wallpaper + transitions via `awww` (`wallpaper`). |
| `MonitorConfig.ts` | ~120 | Per-monitor mode/scale/rotation + VRR → `nidara-monitor.lua`. Applies at runtime via **`hyprctl eval "hl.monitor({...})"`** (see the Lua-parser note below). `applyMode`/`applyTransform` apply without persisting; `commit()` writes the .lua — used for the revert-safety dialog on resolution/rotation changes. |
| `Icons.ts` | 92 | `nd-*-symbolic` icon catalog. |
| `WidgetConfig.ts` | 88 | CC widget metadata/registry (`widgets.json`). |
| `GamingManager.ts` | 79 | Game-mode state + `gaming.json`. |
| `NotifConfig.ts` | 60 | Notification DND default. |
| `AudioService.ts` | ~120 | **Stateless facade** over the reactive `AstalWp` singleton (PipeWire/WirePlumber). `volumeIcon`/`targetVolumeIcon` (the volume-level icon ladder that used to live in FOUR copies), `streamIconName` (per-app stream icon), `setDefault` (`wpctl set-default`), `toggleMute`, endpoint/stream/default accessors, and `watchDevices`/`watchStreams`/`watchVolume`. Consumed by Settings → Audio + the CC volume tile/detail (`Sliders.tsx`, `widgets/volume.ts`) + the bar volume widget. Returns Gio icons via `core/Icons` (core→core); the volume *slider widget* is `makeVolumeSlider` in `common/Slider.ts` (UI layer). Never imports Gtk. |
| `BluetoothService.ts` | ~330 | **Stateless facade** over the reactive `AstalBluetooth` singleton (same pattern as NetworkService): power (`isPowered`/`setPowered`/`togglePower`), device categorisation (`pairedDevices`/`nearbyDevices`/`deviceName`), guarded command wrappers (`connectDevice`/`disconnectDevice`/`pairDevice`/`removeDevice`/`startDiscovery`/`stopDiscovery`), and `watchPower`/`watchDevices` notify helpers. `watchDevices` also wires each device's own `notify::paired/connected/name` (re-wiring on set change) — `notify::devices` alone misses in-place pairing/connection changes. Also owns the **BlueZ pairing agent** (`org.bluez.Agent1`, capability `KeyboardDisplay`, raw Gio D-Bus on the SYSTEM bus — AstalBluetooth has no agent support): `registerPairingAgent(handler)`/`unregisterPairingAgent()`; the Settings → Bluetooth page supplies the dialog handler (`PairingPrompt` kinds: `confirm`/`display`/`enter-passkey`/`enter-pin`/`authorize`), so core stays UI-free. The agent registers when the page is built (first Settings open; effectively session-lifetime since Settings hides rather than closes). `pairDevice` sets `trusted=true` on successful pairing so reconnections skip authorization; `RequestAuthorization`/`AuthorizeService` auto-accept trusted/paired devices. **Testing gotcha:** D-Bus policy only lets root call `Agent1` methods, so exercise dialogs with `sudo busctl --system call <shell-unique-bus-name> /org/nidara/bluetooth/agent org.bluez.Agent1 RequestConfirmation ou /org/bluez/hci0/dev_00_11_22_33_44_55 123456` (find the bus name by matching the gjs PID in `busctl --system list`; the python-dbusmock bluez5 template never calls back into agents). Consumed by Settings → Bluetooth (full management: scan/pair/forget) + the bar/CC bt tile, whose
CC detail panel (`widgets/bluetooth.ts`, split-target capsule — see design-system.md) drives a
compact paired-device connect/disconnect list with the same `pairedDevices`/`connectDevice`/
`disconnectDevice`. **Gotcha:** `setPowered` drives `adapter.powered`, NOT the read-only `is_powered`. Never imports Gtk. |
| `NetworkService.ts` | ~190 | **Stateless facade** (a plain function module, *not* a GObject — AstalNetwork is already a reactive singleton) for all network domain logic: nmcli command vocabulary (`connectAp`/`disconnectIface`/`forgetProfile`/`rescan`/`setWifiEnabled`/`toggleWifi`/`listSavedWifiSsids`/VPN), NM-flag + frequency derivations (`isSecured`/`securityLabel`/`freqBand`/`freqChannel`), `getIp`/`wiredConnected`/`wifiEnabled`, and `watchWifi`/`watchWired` notify-subscription helpers. Consumed by Settings → Network, the CC wifi/ethernet tiles (`Toggles.tsx`), and the bar widgets (`widgets/wifi.ts`, `widgets/ethernet.ts`) — they used to each re-derive `getIp` and toggle WiFi three different ways. Never imports Gtk. |
| `PowerManager.ts` | 43 | hypridle hooks (screen-off/lock/suspend). |
| `ShellActions.ts` | 21 | Typed action registry populated by `app.ts main()`; consumed by Dock/Bar/AppGrid (replaces `globalThis`). |
| `AgentConfig.ts` | ~120 | Governance of the agent-facing surface (`ai.json`): `allowConfigWrite` gates `setConfig` writes; `allowScreenshot` gates the `screenshot` IPC; `allowComputerUse` gates third-party perception (`query_app`/`nidara-a11y`); `allowComputerControl` gates third-party action — AT-SPI `do_action` (`do_app_action`/`nidara-act`), synthetic keyboard (`type_text`/`press_key`/`nidara-type`, focus-verified), synthetic pointer — left/right click + scroll + drag (`click_app`/`click_at`/`scroll_app`/`scroll_at`/`drag_at`/`nidara-click`+`nidara-input`) — and window focus (`focus_window`/`focusWindow`) — and **requires perception** (enabling it implies `allowComputerUse`). The two computer-use gates **default OFF** (they reach outside the shell; enabling either flips on `toolkit-accessibility`, otherwise the a11y tree is empty). Separate toggles — each capability is sensitive on its own. Toggled from Settings → AI. It is a **consent layer over the official door, not a security boundary** (any local process can still edit config files / drive the a11y bus directly) — keep that framing in docs/UI copy. Reading the shell's *own* state is never gated (doctor/diagnostics depend on it). |
| `ConfigRegistry.ts` | ~120 | Typed registry of agent-readable/-writable settings — the data half of `describeConfig`/`getConfig`/`setConfig` (see `state-and-ipc.md`). Same pattern as ShellActions: core defines the registry; **entries are registered from `config-entries.ts`** (app level, NOT core) because dock settings live in `surfaces/dock/state.ts` and core must never import widget code. Each entry is self-describing (desc/type/enum/min/max) and delegates `set` to the owning service, so validation/persistence/notify behave exactly as if Settings had been used. NB: result types use optional fields, not discriminated unions — tsconfig has `strict:false`, under which tsc doesn't narrow `r.ok ? r.value : r.error`. |
| `UITree.ts` | ~160 | Serializer behind the `queryUI` IPC command (see `state-and-ipc.md`): walks every **mapped** toplevel and returns a flat list of on-screen widgets carrying signal (test-id / CSS class / visible text / interactive GType) + ancestor `path` + `bounds`, for read-only UI **assertions** (screenshot → programmatic check). Redacts password/masked entry text. Read-only/ungated like dumpState. Tier 1 = structure+text; the node model is source-agnostic — `bin/nidara-a11y` now fills the **same shape** for third-party apps via AT-SPI2 (the computer-use layer's `query_app`; see `state-and-ipc.md`). |

### Gotcha: changing Hyprland config at runtime → `hyprctl eval`, not `keyword`

This shell configures Hyprland through the **Lua parser** (`config/hypr/hyprland.lua`, `hl.*`).
Under it, **`hyprctl keyword …` is rejected** (`"can't work with non-legacy parsers. Use eval."`).
To change config live, use **`hyprctl eval "hl.<call>(...)"`** — e.g.
`hl.monitor({...})`, `hl.config({ general = { layout = '…' } })`, `hl.config({ misc = { vrr = 1 } })`.
`hyprctl getoption …` still works. **`hyprctl dispatch` only takes Lua expressions** —
the argument is wrapped as `hl.dispatch(<arg>)`, so legacy dispatcher strings are Lua
syntax errors: `hyprctl dispatch dpms on` ✗ → `hyprctl dispatch 'hl.dsp.dpms({ action = "enable" })'` ✓
(actions `enable`/`disable`/`toggle`), `hyprctl dispatch exit` ✗ → `'hl.dsp.exit()'` ✓.
This is not cosmetic: legacy dpms strings in `hypridle.conf` failed silently for months and
left the screen unrecoverable-black after wake-from-suspend (2026-06-10 incident — the
after-sleep hook is the ONLY thing that re-enables displays, so treat its syntax as critical
and never "verify" dpms commands by running them live). Two safety rules from the
second 2026-06-10 incident (screen dark, input wouldn't wake it): **(1)** `misc` sets
`mouse_move_enables_dpms`/`key_press_enables_dpms = true` so the compositor itself wakes
the screen on input — hypridle's `on-resume` is NOT reliable (its idle tracking resets on
daemon restart/inhibitor churn and then never fires). **(2)** hypridle has exactly ONE
owner: the session exec line (`uwsm app -s b -- hypridle`). Never start/restart it via
`systemctl --user … hypridle` — the package ships a user unit, and using it spawns a second
instance that fights over `org.freedesktop.ScreenSaver` and silently drops app idle
inhibitors (videos no longer keep the screen on). The Settings Power page restarts it with
stop-unit + pkill + wait-until-dead + uwsm relaunch. A full audit (2026-06-08)
migrated every remaining `keyword` caller — they were all silently broken on the Lua parser:
- `InputConfig` live-apply → `hl.config({ input = { … } })` (incl. nested `touchpad`, and
  `kb_layout`/`kb_variant`). The whole Input page was a no-op live until this.
- `AboutWindow` float/center → a static `hl.window_rule` in `hyprland.lua` (matched by the
  "About Nidara" title; the `windowrulev2` keyword calls were removed).
- greeter `LocaleBar` kb_layout → eval (the greeter runs its OWN Lua config,
  `config/greetd/hyprland-greeter.lua`, so it's the same parser).
- `app.ts` bar-blur layerrules → **deleted** (dead duplicates of the `hl.layer_rule`
  already in `hyprland.lua`).
Only `dispatch`/`getoption`/`monitors`/`eval` callers remain (all valid). Also: a fractional
monitor scale must divide the native resolution into whole logical pixels or Hyprland snaps
it — the Display page filters scale presets to exact-valid per monitor.

The same sweep applies to **dispatch strings**: classic dispatcher syntax is forbidden
everywhere, `hl.dsp.*` Lua only. Four HyprlandState methods (`sendToWorkspace`,
`floatWindow`, `toggleGroup`, `sendToSpecial`) shipped with classic strings and were
silently broken (the `.catch` swallowed the Lua error) until 2026-06-11. The
`{ window = 'address:0x..' }` selector is verified on `window.float/pin/move/close`.
The full dispatcher surface is documented in `/usr/share/hypr/stubs/hl.meta.lua`
(`hl.dsp.window.*`, `hl.dsp.group.*`, `hl.dsp.workspace.*`) — check it before assuming a
dispatcher doesn't exist. The stubs type args as `fun(...)`; when the exact table shape
matters, the binary's error strings are authoritative (`strings /usr/bin/Hyprland | grep
'expected a table'`). Group vocabulary verified live 2026-06-11: `hl.dsp.group.toggle()`
takes the window selector; `hl.dsp.group.active({ index, window })` (1-based) switches
tabs (so does plain focus on a member address); `hl.dsp.window.move` accepts `out_of_group
= true` + selector, and `into_group = '<dir>'` but **selector-less** (focused window
only). Group membership/order reads from `grouped` in `clients -j`; group-lock state is
not readable anywhere. Gotcha: pseudo-tile **state** is not readable anywhere
(no `pseudo` field in `hyprctl clients -j` nor `HL.Window`) — `togglePseudo` is fire-only.
Bigger gotcha: **`AstalHyprland.Client` window-state props go stale** — `floating` can
read true on a tiled window (observed live 2026-06-11: wrong menu checks, float-all
skipping windows), and `pinned`/`grouped` aren't exposed at all. Authoritative window
state = `hs.getClientJson(addr)` / `hs.getClientsJson()` (one-shot `hyprctl clients -j`,
on demand only — never in the `_refresh` hot path). Never build UI checks or filter bulk
window ops from Astal Client props.

**Since 2026-06-10 all of this goes through `HyprlandState`** (single-door sweep): use
`hs.evalLua(...)` / `hs.getOptionJson(...)` / `hs.setCursor(...)` / `hs.version()` instead of
shelling out to hyprctl — add a method to HyprlandState if the vocabulary is missing. The
shell itself (greeter excluded — separate bundle, own Lua config) has zero direct hyprctl
calls outside HyprlandState.

## `ui/lib/nidara-kit/`

Pure-GTK4 primitives + Nidara tokens, **no Adwaita, no resets**. Consumed only by the shell's Settings pages today:

- `NidaraSplitView` — replaces `Adw.OverlaySplitView` + `Breakpoint`
- `NidaraClamp` — replaces `Adw.Clamp`
- `NidaraButton` — suggested/destructive/pill variants
- `NidaraSelect` — dropdown
- `NidaraSidebar` — single-select nav list; items take an optional `groupStart` to draw a thin **title-less divider** before them (macOS-style thematic clusters, no group labels). The Settings sidebar uses this for its 3 clusters (connectivity · look/shell/behaviour · system & devices).
- `showNidaraAlert` — replaces `Adw.AlertDialog`; optional `entry` (single-line input, `digitsOnly`/`maxLength`, text reaches `onResponse` as 2nd arg, Enter fires the suggested response) and returns an `AlertHandle` whose `close(id?)` responds programmatically (used by the BlueZ pairing agent to honor `Cancel()`)
- `NidaraOverlayManager` — for future floating UI

### Settings information architecture

The Settings sidebar (`Settings.tsx` `categories[]`) is **ordered into 3 unlabelled clusters** via `NidaraSidebar`'s `groupStart` dividers; the array order *is* the IA, so reorder there. The window opens on **Appearance** by default (not the first item). The **AI page** (`pages/Ai.tsx`, third cluster) governs the agent surface — its rule: every row must gate or report something REAL (no placeholder toggles); it grows with the AI-native roadmap (assistant model picker…). Its IA (2026-07) is four groups, one concept each: **Desktop Access** (shell-scoped capabilities, default on) · **Other Apps** (computer-use perception/control, escalating, default off) · **MCP Server** (the CHANNEL: enable toggle + `.mcp.json` connect row — a transport, not a permission; capability toggles gate `ags request` and MCP alike) · **Agent Interface** (read-only facts). Don't fold the MCP toggle back among the capability toggles. Pages that contain sub-screens use the **parent-page + `pushSubpage` pattern**: e.g. **Apps** is a landing (`pages/Apps.tsx`) with two navigable rows that push **Default Apps** (`pages/DefaultApps.tsx`) and **App Icons** (`pages/AppIcons.tsx`). Caveat: subpage rows aren't in the search index (subpages build lazily), so a parent's landing rows should carry searchable labels.

Naming note (2026-07): the page with id `widgets` (`pages/Widgets.tsx`) is titled **"Control
Center"** in the UI and its copy says "controls" — macOS terminology, since it manages bar + CC
placement exactly like macOS's Control Center settings page. `AtomicWidget`, the `widgets/` dir
and all ids/keys keep the internal name; only user-facing strings changed.

This is the right place for new shared, Adwaita-free primitives.

## Game mode

- **`hyprland.lua` (compositor side):** on `window.open`, detects Steam windows (`class = steam_app_<id>` or by reading `SteamAppId` from `/proc/<pid>/environ`, walking parent PIDs). Moves them to the special `gamespace` workspace (no blur/anim/shadow, `immediate`, `opaque`, `idle_inhibit`). Optionally swaps wallpaper to Steam library hero-art (`awww`) and sets power profile to `performance`. On last-game close: returns to previous workspace, restores wallpaper + `balanced`.
- **`nidara-game-mode` script (`Super+Shift+G`)** + **`GamingManager.ts` + Settings → Gaming (`gaming.json`):** `wallpaperMode` (artwork/custom/none), transition, `performanceProfile`.
- **`Super+B` → `toggleBarOverlay`** (alias `toggleGameOverlay`): promotes **only the Bar** to OVERLAY layer over any fullscreen window (requires an active fullscreen window to activate; deactivation always allowed). Not game-specific — it lives here because games are the main fullscreen use case.

# Crystal Shell — Architecture

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

1. Display manager (greetd by default) runs `/usr/bin/crystal-shell` via `/usr/share/wayland-sessions/crystal-shell.desktop`.
2. `crystal-shell` (session wrapper script) sets Wayland/GI env, then:
   `exec uwsm start -e -D Hyprland hyprland.desktop -- -c /usr/share/crystal-shell/config/hypr/hyprland.lua`.
   uwsm runs the session as systemd units → activates `graphical-session.target`, clean teardown on exit.
3. `hyprland.lua` on `hyprland.start` launches daemons via `uwsm app -- <daemon>` (independent systemd scopes):
   `crystal-shell-ui`, `awww-daemon`, polkit agent, `hypridle`, `wl-paste --watch cliphist store`.
4. **`crystal-shell-ui`** (UI launcher in `/usr/bin/`): kills stale `gjs`, then —
   - **Dev mode:** if `~/.config/crystal-shell/.dev` exists, `cd` to its path and `ags run app.ts`.
   - **Prod mode:** exec the bundle at `/usr/share/crystal-shell/ui/ags-v3/build/crystal-shell`.
   - Log: `/tmp/crystal-shell-ui.log`.
5. **`app.ts`** (`ui/ags-v3/app.ts`): sets dark/light via `Gtk.Settings.gtk_application_prefer_dark_theme` (pure GTK4 — no `Adw.init()`); registers the `cs-*-symbolic` icon search path; `app.start({ applicationId: "com.crystalshell.fluid", main, requestHandler })`. In `main()`: applies `hyprctl keyword layerrule blur`, iterates monitors → `createUI(monitor)` (Bar + Dock per monitor), wires the dock-rebuild debounce, and populates `core/ShellActions` + the IPC registry.
6. Reload in dev: **`Super+Shift+R`** re-runs `crystal-shell-ui` (the old `start_ui.sh`/`reload_ui.sh` no longer exist).

## Directory map (`ui/ags-v3/`)

Three pillars by responsibility:

- **`core/`** — singleton services. **Never touch the UI directly.** (Detailed below.)
- **`styles/`** — all SCSS, compiled to one `style.css`.
  - `_base.scss` holds design tokens + `@mixin glass` + `@mixin crystal-reset`.
  - `_reset.scss` neutralizes Adwaita residue.
  - Per-component modules are scoped with `window#id { … }`.
- **`widget/`** — TSX components that consume `core/` state. Each widget is a function that takes a `Gdk.Monitor` and returns a `Gtk.Widget`. Sub-dirs:
  - `bar/`, `dock/`, `control-center/`, `app-grid/`, `overview/`, `prism/`
  - `settings/` (+ `settings/pages/`, 18 pages), `about/`
  - `widgets/` — atomic CC widgets
  - `common/` — shared: `SquircleContainer`, `DrawingUtils`, `PillSlider`, `ManagedWindow`, `CrystalPopover`, `WorkspaceSchematic`, `fade.ts`

Other top-level dirs: `ui/lib/crystal-ui/` (pure-GTK4 primitives lib — see end of file) and the greeter/lockscreen bundles.

## `core/` services (singletons)

These are GObject singletons. Widgets subscribe to them via `notify::prop`. **None of them ever import a widget or call UI code directly** — state flows out, never in.

| File | LOC | Role |
|---|---|---|
| `Status.ts` | 202 | Central GObject state machine for overlays. Mutually-exclusive setters (opening one closes the others). Props: `cc/nc/prism/system-menu/overview/about/settings-open`, `recording`, `cc-edit-mode`, `bar-expanded-id`, `cc-detail-id`. **See `state-and-ipc.md`.** |
| `AppService.ts` | 685 | `.desktop` discovery, icon resolution + fallbacks, WM-class → Desktop-ID mapping. Backs Dock + AppGrid. |
| `ThemeManager.ts` | 534 | GTK/icon/cursor theme, dark mode, CSS providers (main/font/tokens/tint), hot-reload of `style.css` in dev. |
| `FluidCrystal.ts` | 436 | Token engine: `generateTokensCss()` emits `@define-color` + `--crystal-*` for accent, transparency, materials, shadows, tint. Holds the canonical `ACCENT_PALETTE`. Syncs Kvantum/qt. |
| `RegionConfig.ts` | 218 | Time/date format, timezone (`region.json`). |
| `InputConfig.ts` | 194 | Keyboard/mouse/touchpad → writes `crystal-settings.lua`. |
| `HyprlandState.ts` | ~210 | Reactive wrapper over AstalHyprland (clients/workspaces/monitors + dispatch helpers). Also caches **effective** config that AstalHyprland doesn't expose: `availableModesByName` (from `hyprctl monitors -j` — `Monitor.available_modes` is always null) and `getOptionInt(name)` (`hyprctl getoption`). Read-once, not yet reactive to `configreloaded` (see `tech-debt.md`). |
| `NightLightManager.ts` | 174 | Blue-light filter via hyprsunset (`night-light.json`). |
| `WallpaperManager.ts` | 127 | Wallpaper + transitions via `awww` (`wallpaper`). |
| `MonitorConfig.ts` | ~120 | Per-monitor mode/scale/rotation + VRR → `crystal-monitor.lua`. Applies at runtime via **`hyprctl eval "hl.monitor({...})"`** (see the Lua-parser note below). `applyMode`/`applyTransform` apply without persisting; `commit()` writes the .lua — used for the revert-safety dialog on resolution/rotation changes. |
| `Icons.ts` | 92 | `cs-*-symbolic` icon catalog. |
| `WidgetConfig.ts` | 88 | CC widget metadata/registry (`widgets.json`). |
| `GamingManager.ts` | 79 | Game-mode state + `gaming.json`. |
| `NotifConfig.ts` | 60 | Notification DND default. |
| `NetworkService.ts` | ~190 | **Stateless facade** (a plain function module, *not* a GObject — AstalNetwork is already a reactive singleton) for all network domain logic: nmcli command vocabulary (`connectAp`/`disconnectIface`/`forgetProfile`/`rescan`/`setWifiEnabled`/`toggleWifi`/`listSavedWifiSsids`/VPN), NM-flag + frequency derivations (`isSecured`/`securityLabel`/`freqBand`/`freqChannel`), `getIp`/`wiredConnected`/`wifiEnabled`, and `watchWifi`/`watchWired` notify-subscription helpers. Consumed by Settings → Network, the CC wifi/ethernet tiles (`Toggles.tsx`), and the bar widgets (`widgets/wifi.ts`, `widgets/ethernet.ts`) — they used to each re-derive `getIp` and toggle WiFi three different ways. Never imports Gtk. |
| `PowerManager.ts` | 43 | hypridle hooks (screen-off/lock/suspend). |
| `ShellActions.ts` | 21 | Typed action registry populated by `app.ts main()`; consumed by Dock/Bar/AppGrid (replaces `globalThis`). |

### Gotcha: changing Hyprland config at runtime → `hyprctl eval`, not `keyword`

This shell configures Hyprland through the **Lua parser** (`config/hypr/hyprland.lua`, `hl.*`).
Under it, **`hyprctl keyword …` is rejected** (`"can't work with non-legacy parsers. Use eval."`).
To change config live, use **`hyprctl eval "hl.<call>(...)"`** — e.g.
`hl.monitor({...})`, `hl.config({ general = { layout = '…' } })`, `hl.config({ misc = { vrr = 1 } })`.
`hyprctl dispatch …` and `hyprctl getoption …` still work. (Fixed in `MonitorConfig` and
`HyprlandState.setLayout`, which were silently broken on `keyword`.) Also: a fractional monitor
scale must divide the native resolution into whole logical pixels or Hyprland snaps it — the
Display page filters scale presets to exact-valid per monitor.

## `ui/lib/crystal-ui/`

Pure-GTK4 primitives + Crystal tokens, **no Adwaita, no resets**. Consumed only by the shell's Settings pages today:

- `CrystalSplitView` — replaces `Adw.OverlaySplitView` + `Breakpoint`
- `CrystalClamp` — replaces `Adw.Clamp`
- `CrystalButton` — suggested/destructive/pill variants
- `CrystalSelect` — dropdown
- `showCrystalAlert` — replaces `Adw.AlertDialog`
- `CrystalOverlayManager` — for future floating UI

This is the right place for new shared, Adwaita-free primitives.

## Game mode

- **`hyprland.lua` (compositor side):** on `window.open`, detects Steam windows (`class = steam_app_<id>` or by reading `SteamAppId` from `/proc/<pid>/environ`, walking parent PIDs). Moves them to the special `gamespace` workspace (no blur/anim/shadow, `immediate`, `opaque`, `idle_inhibit`). Optionally swaps wallpaper to Steam library hero-art (`awww`) and sets power profile to `performance`. On last-game close: returns to previous workspace, restores wallpaper + `balanced`.
- **`crystal-game-mode` script (`Super+Shift+G`)** + **`GamingManager.ts` + Settings → Gaming (`gaming.json`):** `wallpaperMode` (artwork/custom/none), transition, `performanceProfile`.
- **`Super+G` → `toggleGameOverlay`:** promotes **only the Bar** to OVERLAY layer over fullscreen games (requires an active fullscreen window to activate; deactivation always allowed).

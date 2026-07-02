# Changelog

All notable changes to Nidara are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — Initial release

_Date set at tag time._

First public release. Nidara is a full Wayland desktop environment for Arch Linux,
built on Hyprland and AGS v3 (Aylur's GTK Shell), registering as a proper login session.

### Desktop

- **Compositor** — Hyprland (Wayland) with smooth animations and tiling + floating
  window management; Lua-based config with a user override file
  (`~/.config/nidara/hyprland-user.lua`).
- **Bar** — live clock, workspaces, system tray, resource indicators, and a system
  menu with inline power actions.
- **Dock** — macOS-style with spring magnification physics; bottom, left, and right
  positions.
- **App Launcher** — full-screen grid with instant fuzzy search.
- **Control Center** — volume (WirePlumber), brightness, Wi-Fi, Bluetooth, battery,
  and MPRIS media, with a resizable tile grid and per-widget bar/CC placement.
- **Notification Center** — grouped notifications with inline actions.
- **Login & Lock** — a greetd-based greeter (`nidara-greeter`) and a lock screen
  (`nidara-lock`, on `ext-session-lock-v1`), both sharing the Nidara look; no regreet,
  no hyprlock.
- **Idle management** — hypridle with configurable screen-off, lock, and suspend timers.
- **Hardware & media keys** — volume, mic mute, brightness (floored above black), and
  MPRIS transport (`XF86*`) bound out of the box, working on the lock screen too.

### Settings

- Multi-page settings panel: Appearance, Display, Audio, Network, Input, Bluetooth,
  Language & Region, Applications (default apps + per-app icon overrides), Dock & Panel,
  Control Center (controls placement), Notifications, Autostart, Power, Accessibility, Gaming, Users, AI, and About.
- Live Wi-Fi (connect/forget/detail), Bluetooth (pairing agent with passkey/PIN dialogs),
  and audio device management.

### Design system

- Nidara design system: dynamic accent colors, glassmorphism/material tokens, and
  dark/light mode, generated at runtime by the theme engine.
- libadwaita apps follow the Nidara accent live via a desktop-portal backend.

### Gaming

- Game mode: Steam games auto-move to a dedicated `gamespace` workspace (no
  blur/shadow/animations, `immediate` mode), with optional library-art wallpaper and a
  performance power profile. `Super + B` floats the bar above any fullscreen window.

### AI-native tooling

- Bundled **MCP server** (`nidara-mcp`) that lets an AI agent see and control the running
  desktop through the official interface — read state, change settings, run shell actions,
  and take screenshots to verify its work.
- An in-repo agent skill (`.claude/skills/nidara/`) ships with the code so coding agents
  can extend and fix the desktop.
- All agent capabilities are governed by consent toggles in **Settings → AI** (config
  writes, screenshots, and the MCP server itself can each be switched off, effective
  immediately).

### Installation & updates

- `install.sh` provisions onto an existing minimal Arch system: installs dependencies,
  builds the Astal/AGS libraries from pinned sources (no AUR helper) and hands them to
  pacman, builds the three bundles, and registers the Wayland session. Enables `greetd`
  only when no display manager is already present.
- Stateless updates via `nidara-update`; user config in `~/.config/nidara/` is never
  overwritten.
- First-run defaults are seeded from the existing Arch setup (keyboard layout, timezone,
  locale) without prompting.

### Internationalization

- All UI strings routed through `t()`; English and Spanish included.

[0.1.0]: https://github.com/nidara-project/nidara-desktop/releases/tag/v0.1.0

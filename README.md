# Crystal Shell

Crystal Shell is a full **Wayland desktop environment** built on **Hyprland** and **AGS v3 (Aylur's GTK Shell)**, designed to be fast, visually premium, and tightly optimized for **Arch Linux**.

It is not a theme or a set of scripts — it registers as a proper Wayland session (like GNOME or KDE) and is launched by the display manager.

---

## Features

- **Compositor**: Hyprland (Wayland) — smooth animations, tiling + floating window management.
- **Shell**: AGS v3 (TypeScript/TSX) — reactive, modular UI.
- **Bar**: Live clock, workspaces, system tray, resource indicators, system menu with inline power actions.
- **Dock**: macOS-style with spring magnification physics. Supports bottom, left, and right positions.
- **App Launcher**: Full-screen grid with instant fuzzy search.
- **Control Center**: Volume (WirePlumber), brightness, Wi-Fi, Bluetooth, battery, MPRIS media.
- **Notification Center**: Grouped notifications with inline actions.
- **Settings**: Multi-page settings panel:
  - Appearance — theme, accent color, glassmorphism, dark/light mode
  - Display — per-monitor scale, rotation, VRR/FreeSync
  - Audio — output/input device selection, volumes
  - Network — Wi-Fi and wired connections
  - Input — pointer speed, acceleration, touchpad, keyboard layout
  - Bluetooth — paired devices, scan, pair/connect/forget
  - Language & Region — time format, timezone
  - Applications — per-app icon overrides
  - Dock & Panel — position, size, behavior
  - Widgets — Control Center layout
  - Autostart — manage `exec-once` entries
  - Power — performance profile, screen-off, lock, suspend timers (hypridle)
  - About — system info, Crystal Shell version
- **Fluid Crystal Design System**: Dynamic accent colors, glassmorphism tokens, dark/light mode.
- **Lock screen**: hyprlock with frosted-glass blur.
- **Idle management**: hypridle — configurable screen-off, lock, and suspend timers.

---

## Installation

Requires **Arch Linux**.

```bash
git clone https://github.com/Fluid-Crystal/Crystal-Shell.git ~/crystal-shell-install
cd ~/crystal-shell-install
./install.sh
```

The installer:
1. Installs system dependencies (GTK4, Libadwaita, Hyprland, GJS, Astal libraries, AGS CLI).
2. Builds the UI bundle (`ags bundle`).
3. Installs system files:
   - `/usr/bin/crystal-shell` — Wayland session entry point
   - `/usr/bin/crystal-shell-ui` — UI launcher (auto-detects dev/system mode)
   - `/usr/share/crystal-shell/` — configs, bundle, version file
   - `/usr/share/wayland-sessions/crystal-shell.desktop` — session entry
4. Creates `~/.config/crystal-shell/` with default configs (never overwritten on updates).
5. Enables system services: `pipewire`, `wireplumber`, `sddm`.

**To start:** reboot and select _Crystal Shell_ from the login screen.

---

## User Configuration

User config lives in `~/.config/crystal-shell/` and is **never overwritten** by updates.

To customize Hyprland (monitors, keyboard layout, startup apps, extra keybinds), edit:

**`~/.config/crystal-shell/hyprland-user.conf`**

```ini
# Keyboard layout
input {
    kb_layout = es
}

# Monitors
monitor = HDMI-A-1, 1920x1080@60, 0x0, 1

# Custom keybinds
bind = SUPER, F1, exec, firefox

# Autostart
exec-once = my-app

# Override any Hyprland setting
general {
    gaps_out = 16
}
```

> **NVIDIA users** — uncomment the NVIDIA block in `hyprland-user.conf` after installation.

---

## Keybindings

### Window Management

| Shortcut | Action |
| :--- | :--- |
| `Super + Q` | Close active window |
| `Super + F` | Toggle floating |
| `Super + P` | Toggle pseudo-tiling (dwindle) |
| `Super + Left / Right / Up / Down` | Move focus |
| `Super + Shift + Arrow` | Resize active window |
| `Super + Mouse drag (left button)` | Move window |
| `Super + Mouse drag (right button)` | Resize window |

### Workspaces

| Shortcut | Action |
| :--- | :--- |
| `Super + 1–5` | Switch to workspace |
| `Super + Shift + 1–5` | Move window to workspace |
| `Super + Scroll` | Cycle workspaces |

### Apps & Shell

| Shortcut | Action |
| :--- | :--- |
| `Super + D` | Toggle App Launcher |
| `Super + S` | Open Settings |
| `Super + T` | Terminal (Kitty) |
| `Super + E` | Files (Nautilus) |
| `Super + Shift + R` | Reload Crystal Shell UI |
| `Super` (tap) | Toggle App Launcher |

### Screenshots

| Shortcut | Action |
| :--- | :--- |
| `Print` | Region screenshot → clipboard |
| `Shift + Print` | Region screenshot → `~/Pictures/` |

---

## Developer Guide

### Setup

```bash
git clone https://github.com/Fluid-Crystal/Crystal-Shell.git ~/Dev/Crystal-Shell
cd ~/Dev/Crystal-Shell
./install.sh --dev
```

`--dev` installs system binaries normally but writes `~/.config/crystal-shell/.dev` pointing to your repo. The `crystal-shell-ui` launcher detects this file and runs `ags run app.ts` from source — no full rebuild needed to see changes.

```bash
cd ui/ags-v3
npm install   # IDE support (TypeScript autocomplete)
```

### Project Structure

```
Crystal-Shell/
├── config/
│   └── hypr/                  # Hyprland config (installed to /usr/share/crystal-shell/)
├── defaults/                  # Default user configs (copied once on first install)
├── scripts/
│   ├── crystal-shell          # Wayland session entry → /usr/bin/crystal-shell
│   └── crystal-shell-ui       # UI launcher (dev/system) → /usr/bin/crystal-shell-ui
├── VERSION                    # Current version (semver)
├── install.sh                 # Provisioning script
└── ui/ags-v3/                 # Shell (TypeScript + AGS v3)
    ├── app.ts                 # Entry point + IPC request handler
    ├── core/                  # State, theme engine, services
    ├── widget/                # UI components (Bar, Dock, AppGrid, Settings…)
    ├── styles/                # Modular SCSS
    ├── style.css              # Compiled CSS (committed for convenience)
    └── build/
        └── crystal-shell      # Standalone bundle (committed for releases)
```

### Development Workflow

- **Reload UI:** `Super + Shift + R`
- **Logs:** `tail -f /tmp/crystal-shell-ui.log`
- **Kill stale GJS process:** `killall gjs`
- **Compile SCSS:** `cd ui/ags-v3 && sass --no-charset style.scss style.css && sed -i '/@charset/d' style.css`
- **Send IPC command:** `ags request toggleAppGrid`

### Publishing a Release

```bash
cd ui/ags-v3
npm run build          # compiles SCSS + bundles app

cd ../..
git add ui/ags-v3/style.css ui/ags-v3/build/crystal-shell
git commit -m "release: vX.Y.Z"
git tag vX.Y.Z
git push && git push --tags
```

---

**Crystal Shell** — *Performance, Aesthetics, Intelligence.*

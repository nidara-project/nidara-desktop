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
- **Settings**: Multi-page panel — Appearance, Display, Audio, Network, Input, Bluetooth, Language & Region, Applications, Dock & Panel, Widgets, Autostart, Power, and About.
- **Fluid Crystal Design System**: Dynamic accent colors, glassmorphism tokens, dark/light mode.
- **Game Mode**: Steam games auto-move to a dedicated `gamespace` workspace (no blur/shadow/animations, `immediate` mode), optional library-art wallpaper and performance power profile; `Super + G` floats the bar above fullscreen games.
- **Login & Lock**: Custom AGS apps — a greetd-based greeter (`crystal-greeter`) and a lock screen (`crystal-lock`) built on `ext-session-lock-v1`, both sharing the Crystal look. The greeter is launched directly by greetd (no regreet); the lock screen uses no hyprlock.
- **Idle management**: hypridle — configurable screen-off, lock, and suspend timers.
- **Internationalization**: All UI strings via `t()`; English + Spanish included.

---

## Installation

Crystal Shell targets **Arch Linux** (and Arch-based distros such as EndeavourOS). The intended
path is the simplest one: install a **minimal Arch base with no desktop environment**, log in at
the TTY, and run the installer — it pulls everything else in. It also works on top of an existing
Arch desktop: if a display manager is already enabled it's left untouched and Crystal Shell is just
added as another session to pick at login.

**Prerequisites:** a normal user account with `sudo`, an internet connection, and `git`:

```bash
sudo pacman -S --needed git
```

Then clone and run:

```bash
git clone https://github.com/fluid-crystal/crystal-shell.git ~/crystal-shell-install
cd ~/crystal-shell-install
./install.sh
```

The installer needs no AUR helper — it builds the Astal/AGS libraries from pinned sources, packages
them, and hands them to `pacman` so they stay trackable and upgradable. It:

1. Installs system dependencies (Hyprland, GTK4, GJS, the Astal libraries + AGS CLI, audio/network/bluetooth stacks, fonts).
2. Builds the shell, greeter, and lock-screen bundles (`ags bundle`).
3. Installs system files:
   - `/usr/bin/crystal-shell` — Wayland session entry point
   - `/usr/bin/crystal-shell-ui` — UI launcher (auto-detects dev/system mode)
   - `/usr/share/crystal-shell/` — configs, bundles, version file
   - `/usr/share/wayland-sessions/crystal-shell.desktop` — session entry
4. Creates `~/.config/crystal-shell/` with default configs (never overwritten on updates), seeding keyboard layout, timezone and locale from your existing Arch setup — it never prompts.
5. Enables `pipewire`, `wireplumber`, `power-profiles-daemon`, and (only if no display manager is already enabled) `greetd` with the Crystal greeter.

**To start:** reboot and select _Crystal Shell_ from the login screen.

> **Status:** Crystal Shell installs onto an existing Arch system today. A fully automated path —
> a minimal Arch install bundled with Crystal Shell via a Calamares installer — is planned but not
> here yet.

---

## User Configuration

User config lives in `~/.config/crystal-shell/` and is **never overwritten** by updates.

The Hyprland config is written in **Lua** (requires Hyprland ≥ 0.55). To customize
Hyprland (monitors, keyboard layout, startup apps, extra keybinds), edit:

**`~/.config/crystal-shell/hyprland-user.lua`**

```lua
-- Keyboard layout
hl.config({ input = { kb_layout = "es" } })

-- Monitors
hl.monitor({ output = "HDMI-A-1", mode = "1920x1080@60", position = "0x0", scale = 1 })

-- Custom keybinds
hl.bind("SUPER + F1", hl.dsp.exec_cmd("firefox"))

-- Autostart (runs once on Hyprland start)
hl.on("hyprland.start", function()
    hl.exec_cmd("uwsm app -- my-app")
end)

-- Override any Hyprland setting
hl.config({ general = { gaps_out = 16 } })
```

> **NVIDIA users** — set NVIDIA / Wayland environment variables in
> `~/.config/uwsm/env` and `~/.config/uwsm/env-hyprland` (both created on first
> install), not in the Hyprland config.

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
| `Super + S` | Open Settings |
| `Super + T` | Terminal (Kitty) |
| `Super + E` | Files (Nautilus) |
| `Super + L` | Lock screen |
| `Super + G` | Game overlay (bar above fullscreen games) |
| `Super + Shift + G` | Toggle game mode |
| `Super + M` | Exit session (log out) |
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
git clone https://github.com/fluid-crystal/crystal-shell.git ~/Dev/crystal-shell
cd ~/Dev/crystal-shell
./install.sh --dev
```

`--dev` installs system binaries normally but writes `~/.config/crystal-shell/.dev` pointing to your repo. The `crystal-shell-ui` launcher detects this file and runs `ags run app.ts` from source — no full rebuild needed to see changes.

```bash
cd ui/ags-v3
npm install   # IDE support (TypeScript autocomplete)
```

### Project Structure

Crystal Shell is **three independent AGS bundles** (shell, greeter, lock screen), plus the
provisioning and Hyprland config:

```
crystal-shell/
├── config/
│   ├── hypr/                  # Hyprland Lua config + hypridle (→ /usr/share/crystal-shell/)
│   ├── greetd/                # greetd config + greeter Hyprland session
│   └── applications/          # .desktop entries
├── defaults/                  # Seed user configs (copied once on first install; never overwritten)
│   ├── uwsm/                  # env / env-hyprland templates (toolkit & NVIDIA vars)
│   └── wallpaper/             # Default wallpaper (shipped asset)
├── scripts/
│   ├── crystal-shell          # Wayland session entry → /usr/bin/crystal-shell
│   ├── crystal-shell-ui       # UI launcher (dev/system) → /usr/bin/crystal-shell-ui
│   ├── crystal-greeter        # Greeter launcher
│   ├── crystal-lock           # Lock screen launcher (Super+L)
│   ├── crystal-game-mode      # Game mode toggle (Super+Shift+G)
│   └── *-i18n.mjs             # Translation extract/apply tooling
├── VERSION                    # Current version (semver)
├── install.sh                 # Provisioning script (system / --dev)
└── ui/
    ├── ags-v3/                # Main shell (TypeScript + AGS v3)
    │   ├── app.ts             # Entry point + IPC request handler
    │   ├── core/              # State (Status), theme engine (FluidCrystal), services
    │   ├── widget/            # UI components (Bar, Dock, AppGrid, Control Center, Settings…)
    │   ├── styles/            # Modular SCSS (tokens, glass mixin, per-component)
    │   ├── style.css          # Compiled CSS (committed for convenience)
    │   └── build/crystal-shell    # Standalone bundle (committed for releases)
    ├── greeter/               # Login screen (greetd + AstalGreet)
    ├── lockscreen/            # Lock screen (ext-session-lock-v1, shares greeter CSS)
    └── lib/crystal-ui/        # GTK4 primitive widgets (no Adwaita): SplitView, Select, Button…
```

The runtime architecture, IPC contract, persistence layout and design-system rules are documented in
the in-repo agent skill at `.claude/skills/crystal-shell/` (`SKILL.md` + `references/`). It ships
with the code on purpose — see [Contributing](#contributing).

### Development Workflow

- **Reload UI:** `Super + Shift + R`
- **Logs:** `tail -f /tmp/crystal-shell-ui.log`
- **Kill stale GJS process:** `killall gjs`
- **Compile SCSS:** `cd ui/ags-v3 && sass --no-charset style.scss style.css && sed -i '/@charset/d' style.css`
- **Type-check:** `cd ui/ags-v3 && npm run typecheck` (catches type errors before they reach the running shell)
- **Send IPC command:** `ags request toggleAppGrid`

Before opening a PR, make sure the SCSS build passes (`cd ui/ags-v3 && npm run build`) and, if you
have the git-ignored `@girs/` typings, the typecheck too. See [Contributing](#contributing) for the
personal-vs-global heuristic and the full PR flow.

---

## Contributing

Crystal Shell is **AI-native by design**: it ships an agent skill inside the repo
(`.claude/skills/crystal-shell/`) so that anyone running [Claude Code](https://claude.com/claude-code)
— or a similar coding agent — can extend, customize, and fix their own desktop, and propose
globally-useful improvements back upstream. You can also contribute the traditional way.

Start with [`CONTRIBUTING.md`](CONTRIBUTING.md). The key idea: classify each change as **personal**
(stays in your config), **a setting** (add the knob, not a hardcode), or **global** (worth a PR —
correctness, hardware compatibility, performance, accessibility).

---

## License

Crystal Shell is released under the **GNU General Public License v3.0** (GPL-3.0).
See [`LICENSE`](LICENSE) for the full text.

This is the same license used by AGS, and is compatible with the LGPL-2.1
libraries it builds on (GTK4, Astal). You're free to use, study, modify, and
redistribute it — derivative works must remain open under the same terms.

---

**Crystal Shell** — *Performance, Aesthetics, Intelligence.*

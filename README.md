# Nidara

Nidara is a full **Wayland desktop environment** built on **Hyprland** and **AGS v3 (Aylur's GTK Shell)**, designed to be fast, visually premium, and tightly optimized for **Arch Linux**.

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
- **Nidara Design System**: Dynamic accent colors, glassmorphism tokens, dark/light mode.
- **Game Mode**: Steam games auto-move to a dedicated `gamespace` workspace (no blur/shadow/animations, `immediate` mode), optional library-art wallpaper and performance power profile; `Super + G` floats the bar above fullscreen games.
- **Login & Lock**: Custom AGS apps — a greetd-based greeter (`nidara-greeter`) and a lock screen (`nidara-lock`) built on `ext-session-lock-v1`, both sharing the Nidara look. The greeter is launched directly by greetd (no regreet); the lock screen uses no hyprlock.
- **Idle management**: hypridle — configurable screen-off, lock, and suspend timers.
- **Internationalization**: All UI strings via `t()`; English + Spanish included.

---

## Installation

Nidara targets **Arch Linux** (and Arch-based distros such as EndeavourOS). The intended
path is the simplest one: install a **minimal Arch base with no desktop environment**, log in at
the TTY, and run the installer — it pulls everything else in. It also works on top of an existing
Arch desktop: if a display manager is already enabled it's left untouched and Nidara is just
added as another session to pick at login.

**Prerequisites:** a normal user account with `sudo`, an internet connection, and `git`:

```bash
sudo pacman -S --needed git
```

Then clone and run:

```bash
git clone https://github.com/nidara-project/nidara-desktop.git ~/nidara-install
cd ~/nidara-install
./install.sh
```

The installer installs the **latest release** (if your clone's `main` is ahead of it, the
installer jumps back to the release tag first — you always get the same tested version as
everyone else; developers opt out with `--dev` or by checking out another branch).

The installer needs no AUR helper — it builds the Astal/AGS libraries from pinned sources, packages
them, and hands them to `pacman` so they stay trackable and upgradable. It:

1. Installs system dependencies (Hyprland, GTK4, GJS, the Astal libraries + AGS CLI, audio/network/bluetooth stacks, fonts).
2. Builds the shell, greeter, and lock-screen bundles (`ags bundle`).
3. Installs system files:
   - `/usr/bin/nidara` — Wayland session entry point
   - `/usr/bin/nidara-ui` — UI launcher (auto-detects dev/system mode)
   - `/usr/share/nidara/` — configs, bundles, version file
   - `/usr/share/wayland-sessions/nidara.desktop` — session entry
4. Creates `~/.config/nidara/` with default configs (never overwritten on updates), seeding keyboard layout, timezone and locale from your existing Arch setup — it never prompts.
5. Enables `pipewire`, `wireplumber`, `power-profiles-daemon`, and (only if no display manager is already enabled) `greetd` with the Nidara greeter.

**To start:** reboot and select _Nidara_ from the login screen.

### Updating

```bash
nidara-update
```

That's it — no git knowledge needed. The installer leaves a managed copy of the source at
`~/.local/share/nidara/src` (so the folder you originally cloned is disposable);
the updater pulls the latest release there and reinstalls only what changed — the pinned
dependency stack is rebuilt only when the pins actually moved, so updates take a minute,
not an hour. Your config in `~/.config/nidara/` is never touched, and the running
shell reloads by itself. **Settings → About** also tells you when a new release is available.

> **Status:** Nidara installs onto an existing Arch system today. A fully automated path —
> a minimal Arch install bundled with Nidara via a Calamares installer — is planned but not
> here yet.

---

## User Configuration

User config lives in `~/.config/nidara/` and is **never overwritten** by updates.

The Hyprland config is written in **Lua** (requires Hyprland ≥ 0.55). To customize
Hyprland (monitors, keyboard layout, startup apps, extra keybinds), edit:

**`~/.config/nidara/hyprland-user.lua`**

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

### Using an AI agent with your desktop

Nidara ships an **MCP server** (`nidara-mcp`, installed system-wide) that lets
an AI agent see and control your running desktop through the official interface: discover and
change settings, run shell actions, read state, take screenshots to verify its work. To
connect an agent, just tell it:

> *Register the MCP server described in `~/.config/nidara/.mcp.json`*

That manifest is installed for you (and kept up to date — it's the one file in the config dir
the installer manages). Claude Code users who open a session inside `~/.config/nidara/`
get it auto-discovered. Everything an agent can do is governed by the consent toggles in
**Settings → AI** — config writes, screenshots and the MCP server itself can each be switched
off at any time, taking effect immediately.

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
| `Super + Shift + R` | Reload Nidara UI |
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
git clone https://github.com/nidara-project/nidara-desktop.git ~/Dev/nidara
cd ~/Dev/nidara
./install.sh --dev
```

`--dev` installs system binaries normally but writes `~/.config/nidara/.dev` pointing to your repo. The `nidara-ui` launcher detects this file and runs `ags run app.ts` from source — no full rebuild needed to see changes.

```bash
cd ui/shell
npm install   # IDE support (TypeScript autocomplete)
```

### Project Structure

Nidara is **three independent AGS bundles** (shell, greeter, lock screen), plus the
provisioning and Hyprland config:

```
nidara/
├── config/
│   ├── hypr/                  # Hyprland Lua config + hypridle (→ /usr/share/nidara/)
│   ├── greetd/                # greetd config + greeter Hyprland session
│   └── applications/          # .desktop entries
├── defaults/                  # Seed user configs (copied once on first install; never overwritten)
│   ├── uwsm/                  # env / env-hyprland templates (toolkit & NVIDIA vars)
│   └── wallpaper/             # Default wallpaper (shipped asset)
├── bin/                       # Installed binaries/launchers (→ /usr/bin, /usr/lib/systemd)
│   ├── nidara          # Wayland session entry → /usr/bin/nidara
│   ├── nidara-ui       # UI launcher (dev/system) → /usr/bin/nidara-ui
│   ├── nidara-greeter        # Greeter launcher
│   ├── nidara-lock           # Lock screen launcher (Super+L)
│   └── nidara-game-mode      # Game mode toggle (Super+Shift+G)
├── scripts/                   # Repo tooling (not installed): i18n extract/apply, dev helpers
├── VERSION                    # Current version (semver)
├── install.sh                 # Provisioning script (system / --dev)
└── ui/
    ├── shell/                 # Main shell (TypeScript + AGS v3)
    │   ├── app.ts             # Entry point + IPC request handler
    │   ├── core/              # State (Status), theme engine (NidaraTheme), services
    │   ├── surfaces/          # Whole surfaces (Bar, Dock, AppGrid, Control Center, Settings…)
    │   ├── widgets/           # Auto-registered atomic widgets (battery, wifi, media…)
    │   ├── common/            # Shared UI pieces (Slider, SquircleContainer, fade…)
    │   ├── styles/            # Modular SCSS (tokens, glass mixin, per-component)
    │   ├── style.css          # Compiled CSS (committed for convenience)
    │   └── build/nidara    # Standalone bundle (committed for releases)
    ├── greeter/               # Login screen (greetd + AstalGreet)
    ├── lockscreen/            # Lock screen (ext-session-lock-v1, shares greeter CSS)
    └── lib/nidara-kit/        # GTK4 primitive widgets (no Adwaita): SplitView, Select, Button…
```

The runtime architecture, IPC contract, persistence layout and design-system rules are documented in
the in-repo agent skill at `.claude/skills/nidara/` (`SKILL.md` + `references/`). It ships
with the code on purpose — see [Contributing](#contributing).

### Development Workflow

- **Reload UI:** `Super + Shift + R`
- **Logs:** `tail -f /tmp/nidara-ui.log`
- **Kill stale GJS process:** `killall gjs`
- **Compile SCSS:** `cd ui/shell && sass --no-charset style.scss style.css && sed -i '/@charset/d' style.css`
- **Type-check:** `cd ui/shell && npm run typecheck` (catches type errors before they reach the running shell)

Optionally, you can drive the running shell from the CLI to test a specific surface — e.g.
`ags request toggleAppGrid` (the full command list lives in the `requestHandler` in `ui/shell/app.ts`).

Before opening a PR, make sure the SCSS build passes (`cd ui/shell && npm run build`) and, if you
have the git-ignored `@girs/` typings, the typecheck too. See [Contributing](#contributing) for the
personal-vs-global heuristic and the full PR flow.

---

## Contributing

Nidara is **AI-native by design**: it ships an agent skill inside the repo
(`.claude/skills/nidara/`) so that anyone running [Claude Code](https://claude.com/claude-code)
— or a similar coding agent — can extend, customize, and fix their own desktop, and propose
globally-useful improvements back upstream. You can also contribute the traditional way.

Start with [`CONTRIBUTING.md`](CONTRIBUTING.md). The key idea: classify each change as **personal**
(stays in your config), **a setting** (add the knob, not a hardcode), or **global** (worth a PR —
correctness, hardware compatibility, performance, accessibility).

---

## License

Nidara is released under the **GNU General Public License v3.0** (GPL-3.0).
See [`LICENSE`](LICENSE) for the full text.

This is the same license used by AGS, and is compatible with the LGPL-2.1
libraries it builds on (GTK4, Astal). You're free to use, study, modify, and
redistribute it — derivative works must remain open under the same terms.

---

**Nidara** — *Performance, Aesthetics, Intelligence.*

# Nidara

Nidara is a full **Wayland desktop environment** built on **Hyprland** and **AGS v3 (Aylur's GTK Shell)**, designed to be fast, visually premium, and tightly optimized for **Arch Linux**.

It is also **AI-native** — not as a bolt-on, but in how it is built and maintained. Nidara is
developed with AI coding agents, ships a first-class interface for an agent to *see and operate*
the running desktop, and is designed to keep improving through AI-authored contributions: point a
coding agent at your own install, have it fix or extend something, and send that improvement back
upstream as a pull request. The agent knowledge and the contribution rules live **inside the repo**,
so every clone is ready to be worked on by an agent out of the box.

![Nidara desktop — Files and Settings over the default wallpaper](https://raw.githubusercontent.com/nidara-project/nidara-desktop/assets/screenshots/hero.webp)

| | |
|:---:|:---:|
| ![Control Center](https://raw.githubusercontent.com/nidara-project/nidara-desktop/assets/screenshots/cc.webp) | ![App launcher](https://raw.githubusercontent.com/nidara-project/nidara-desktop/assets/screenshots/appgrid.webp) |
| Control Center | App launcher |
| ![Dock magnification](https://raw.githubusercontent.com/nidara-project/nidara-desktop/assets/screenshots/dock.webp) | ![Search overlay](https://raw.githubusercontent.com/nidara-project/nidara-desktop/assets/screenshots/prism.webp) |
| Dock with magnification | Search |
| ![Workspace overview](https://raw.githubusercontent.com/nidara-project/nidara-desktop/assets/screenshots/overview.webp) | ![Greeter](https://raw.githubusercontent.com/nidara-project/nidara-desktop/assets/screenshots/greeter.webp) |
| Workspace overview | Login greeter |

*Screenshots live on the [`assets`](https://github.com/nidara-project/nidara-desktop/tree/assets) branch to keep code clones lean.*

---

## Features

- **Compositor**: Hyprland (Wayland) — smooth animations, tiling + floating window management.
- **Shell**: AGS v3 (TypeScript/TSX) — reactive, modular UI.
- **Bar**: Live clock, workspaces, system tray, resource indicators, system menu with inline power actions.
- **Dock**: Hover magnification with spring physics. Supports bottom, left, and right positions.
- **App Launcher**: App grid with instant fuzzy search.
- **Search**: Type-to-find overlay for apps and recent files (`Super + Space`).
- **Control Center**: Volume (WirePlumber), brightness, Wi-Fi, Bluetooth, battery, MPRIS media.
- **Notification Center**: Grouped notifications with inline actions.
- **Settings**: Multi-page panel — Network, Bluetooth, Appearance, Display, Audio, Top Bar, Dock, Control Center, Gaming, Notifications, Accessibility, Apps, Devices, Power, Language & Region, Autostart, Users, AI, and About.
- **Nidara Design System**: Dynamic accent colors, glassmorphism tokens, dark/light mode.
- **AI-native**: An MCP server (`nidara-mcp`) lets a coding agent perceive and drive the live desktop; an in-repo agent skill and a PR-based contribution model are built for AI-authored improvements. Built with AI, operable by AI, improved by AI — see [Using an AI agent](#using-an-ai-agent-with-your-desktop) and [Contributing](#contributing).
- **Game Mode**: Steam games auto-move to a dedicated `gamespace` workspace (no blur/shadow/animations, `immediate` mode), optional library-art wallpaper and performance power profile; `Super + B` floats the bar above any fullscreen window.
- **Login & Lock**: Custom AGS apps — a greetd-based greeter (`nidara-greeter`) and a lock screen (`nidara-lock`) built on `ext-session-lock-v1`, both sharing the Nidara look. The greeter is launched directly by greetd (no regreet); the lock screen uses no hyprlock.
- **Idle management**: hypridle — configurable screen-off, lock, and suspend timers.
- **Internationalization**: The shell ships in 11 languages — English, Spanish, French, German, Italian, Brazilian Portuguese, Polish, Dutch, Russian, Simplified Chinese, and Japanese (Settings → Language & Region). Clocks and dates follow the system regional format (`LC_TIME`), including on the login and lock screens.

---

## Hardware & platform support

Nidara is young. This is what it has actually been tested on — not what we hope works.

**✅ Supported** — tested by the maintainer; bugs here are treated as priority.

- Vanilla **Arch Linux** (x86_64), from a minimal base install
- **EndeavourOS** — the maintainer's daily driver (it uses Arch's own repos unmodified)
- **AMD and Intel GPUs** (Mesa)
- Single-monitor desktops
- **QEMU/KVM** VMs with `virtio-gpu-gl` (for trying it out)

**🧪 Experimental** — wired up and expected to work, but not validated on real hardware
yet. Reports (and fixes) are the most valuable contribution you can make right now.

- **NVIDIA GPUs** (proprietary driver or open kernel modules): the installer auto-detects
  your card and driver and configures the environment for you, but upstream NVIDIA support
  is newer and less battle-tested than AMD/Intel, and we haven't verified it on real NVIDIA
  hardware. Nouveau is untested.
- **Multi-monitor**: the bar and dock spawn on every display and per-monitor
  scale/mode/VRR live in Settings → Display, but hotplugging a display currently needs a
  UI reload (`Super + Shift + R`).
- **Laptops**: battery, brightness keys and idle/suspend timers work; lid-switch
  behaviour and suspend/resume cycles are untested.
- Other Arch derivatives that track Arch's repos closely.

**❌ Not supported**

- Derivatives with delayed or held-back packages (e.g. **Manjaro**) — Nidara pins
  Hyprland ≥ 0.55 and builds its UI stack against current Arch libraries
- **VirtualBox** (no usable 3D acceleration for Wayland compositors)
- X11 (Wayland-only by design), ARM

Hardware-compatibility fixes are explicitly a "global" contribution — see
[Contributing](#contributing).

---

## Installation

Nidara targets **Arch Linux** (see [Hardware & platform support](#hardware--platform-support)
for what's tested, including which Arch derivatives qualify). The intended
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

The installer needs no AUR helper — everything lands as **real pacman packages, prebuilt from
the project's signed repo** ([nidara-repo](https://github.com/nidara-project/nidara-repo)): every
package and the repo database are GPG-signed by CI, and the installer imports the signing key and
requires valid signatures. That includes **Nidara itself**: the desktop ships as a `nidara`
package, so pacman owns every installed file — clean upgrades with the rest of the system, clean
removal with `pacman -R nidara`, no untracked drift. If the repo is ever unreachable, or it
doesn't serve your exact release yet, the installer builds the same pinned sources locally with
the very recipe the repo uses. It:

1. Installs system dependencies (Hyprland, GTK4, GJS, the Astal libraries + AGS CLI, audio/network/bluetooth stacks, fonts).
2. Installs the `nidara` package — the session entry point (`/usr/bin/nidara`), helper binaries,
   the shell/greeter/lock-screen bundles and shared configs under `/usr/share/nidara/`, and the
   `/usr/share/wayland-sessions/nidara.desktop` session entry. Prebuilt when the repo serves this
   release, otherwise built on the spot from the same `packaging/nidara/PKGBUILD`.
3. Runs `nidara-setup` — the idempotent first-time setup: creates `~/.config/nidara/` with default
   configs (never overwritten on updates), seeding keyboard layout and timezone from your existing
   Arch setup and generating the system locales for every language the UI ships — it never
   prompts — and enables `pipewire`, `wireplumber`,
   `power-profiles-daemon`, `bluetooth`, and (only if no display manager is already enabled)
   `greetd` with the Nidara greeter.

**To start:** reboot and select _Nidara_ from the login screen.

With the `[nidara]` repo configured (the installer sets it up), Nidara is just a package from
then on: `sudo pacman -S nidara && nidara-setup` is a complete install.

### Updating

```bash
nidara-update
```

That's it — no git knowledge needed. New releases arrive through the signed pacman repo like
any other package: `nidara-update` runs a full system upgrade (`pacman -Syu`), re-applies the
idempotent setup, and reloads the running session — the last two only when the version actually
changed. A plain `pacman -Syu` delivers the same release (it's just a package); `nidara-update`
is the wrapper that also handles setup and the live reload. Updates take a minute, not an hour:
prebuilt packages, no local builds.

Installs that predate the package model migrate by themselves: their first `nidara-update`
fetches the latest release into a throwaway directory and installs it as the `nidara` package —
pacman takes ownership of the files, and every later update takes the package path above. No
source copy is kept on disk, so the folder you originally cloned stays disposable. Your config
in `~/.config/nidara/` is never touched. **Settings → About** also tells you when a new release
is available.

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
| `Super + M` | Toggle maximize (keeps the bar visible) |
| `Super + Shift + F` | Toggle fullscreen |
| `Super + P` | Toggle pseudo-tiling (dwindle) |
| `Super + Left / Right / Up / Down` | Move focus |
| `Alt + Tab` / `Alt + Shift + Tab` | Cycle windows on the workspace |
| `Super + Shift + Arrow` | Resize active window |
| `Super + Mouse drag (left button)` | Move window |
| `Super + Mouse drag (right button)` | Resize window |

### Workspaces

| Shortcut | Action |
| :--- | :--- |
| `Super + 1–5` | Switch to workspace |
| `Super + Shift + 1–5` | Move window to workspace |
| `Super + W` | Workspace overview (`← / →` to navigate, `Enter` to switch) |
| `Super + Scroll` | Cycle workspaces |
| `Super + Ctrl + ← / →` | Previous / next workspace |
| `Super + Ctrl + Shift + ← / →` | Move window to previous / next workspace |

### Apps & Shell

| Shortcut | Action |
| :--- | :--- |
| `Super + S` | Open Settings |
| `Super + Space` | Search (apps & recent files) |
| `Super + T` | Terminal (Kitty) |
| `Super + E` | Files (Nautilus) |
| `Super + L` | Lock screen |
| `Super + B` | Bar overlay (bar above fullscreen windows) |
| `Super + Shift + G` | Toggle game mode |
| `Super + Shift + Escape` | Revoke AI computer-control instantly (kill switch) |
| `Super + Shift + R` | Reload Nidara UI |
| `Super` (tap) | Toggle App Launcher |

### Screenshots

| Shortcut | Action |
| :--- | :--- |
| `Print` | Region screenshot → clipboard |
| `Shift + Print` | Region screenshot → `~/Pictures/` |

### Media & hardware keys

Volume, microphone mute, brightness and media-transport keys (`XF86*`) work out of
the box — including on the lock screen. Brightness never steps down to fully black.

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
    │   ├── style.css          # Compiled CSS — generated from styles/ (gitignored)
    │   └── build/nidara    # Bundle output from `ags bundle` (gitignored)
    ├── greeter/               # Login screen (greetd + AstalGreet)
    ├── lockscreen/            # Lock screen (ext-session-lock-v1, shares greeter CSS)
    └── lib/nidara-kit/        # GTK4 primitive widgets (no Adwaita): SplitView, Select, Button…
```

The runtime architecture, IPC contract, persistence layout and design-system rules are documented in
the in-repo agent skill at `.claude/skills/nidara/` (`SKILL.md` + `references/`). It ships
with the code on purpose — see [Contributing](#contributing).

### Development Workflow

- **Reload UI:** `Super + Shift + R`
- **Logs:** `tail -f "$XDG_RUNTIME_DIR/nidara-ui.log"`
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

All participation is governed by our [Code of Conduct](CODE_OF_CONDUCT.md).

---

## Credits

Nidara stands on the work of some excellent open-source projects:

- **[Aylur](https://github.com/Aylur)** — [AGS](https://github.com/Aylur/ags) and the
  [Astal](https://github.com/Aylur/astal) libraries: the framework the entire Nidara UI is built on.
- **[Hyprland](https://hyprland.org)** — the Wayland compositor at Nidara's core, along with
  hypridle, hyprsunset, and xdg-desktop-portal-hyprland from the same ecosystem.
- **[GNOME](https://www.gnome.org)** — GTK4 and GJS, the toolkit and runtime under every Nidara surface.
- **[Arch Linux](https://archlinux.org)** — the distribution Nidara is built for.
- **[Lucide](https://lucide.dev)** — the icon set used throughout the shell
  (ISC license; see [`NOTICE`](NOTICE)).

…and the wider stack Nidara relies on every day: [greetd](https://git.sr.ht/~kennylevinsen/greetd),
[PipeWire](https://pipewire.org) & WirePlumber, [uwsm](https://github.com/Vladimir-csp/uwsm),
and many more. Thank you.

---

## License

Nidara is released under the **GNU General Public License v3.0** (GPL-3.0).
See [`LICENSE`](LICENSE) for the full text.

Copyright (C) 2026 The Nidara Authors.

This is the same license used by AGS, and is compatible with the LGPL-2.1
libraries it builds on (GTK4, Astal). You're free to use, study, modify, and
redistribute it — derivative works must remain open under the same terms.

## Trademarks

The GPL covers Nidara's **source code**. It does **not** grant rights to the
**"Nidara" name or logo**, which are trademarks of the Nidara project.

You are welcome to fork and redistribute the code under the GPL — but a fork or
redistribution that is not the official project **must use a different name and
logo**, and must not present itself in a way that implies endorsement by, or
affiliation with, the Nidara project. (Same model as Firefox, GNOME and many
other open-source projects: the code is free, the brand identifies the project.)

See [`NOTICE`](NOTICE) for attribution details.

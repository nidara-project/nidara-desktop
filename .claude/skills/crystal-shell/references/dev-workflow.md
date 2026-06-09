# Crystal Shell — Dev workflow, installer, persistence, keybinds

Read this when running the installer, debugging a reload that won't take, looking for where a setting is persisted, or adding a new keybind.

## Installer (`install.sh`)

Arch-only provisioning. Two modes:

- **`--system` (default):** installs binaries into `/usr/bin/` and configs into `/usr/share/crystal-shell/`. Runs the production bundle.
- **`--dev`:** installs system binaries **and** writes `~/.config/crystal-shell/.dev` pointing at the source tree. The UI launcher will then `ags run app.ts` from source instead of running the bundle.

### Pinned upstreams

These are bumped + clean-install-tested before tagging:

- `ASTAL_REF` — commit SHA, no tags
- `AGS_REF` — tag (e.g. `v3.1.2`)
- `APPMENU_REF` — commit

### Install steps (in order)

1. `pacman` deps.
2. Build Astal libs from source: `io`, `gtk3`, `gtk4`, `apps`, `hyprland`, `mpris`, `network`, `battery`, `notifd`, `bluetooth`, `tray`, `greet`, `auth`, `lang/gjs` + `appmenu-glib-translator`.
3. Build the `ags` CLI.
4. `npm install` + SCSS compile + `ags bundle` × 3 (shell, greeter, lockscreen).
5. Install binaries / configs / session entry / XDG portals.
6. Seed `~/.config/crystal-shell/` — **never overwrites existing user config.**
7. Enable services: pipewire/wireplumber (user), power-profiles-daemon (system), greetd (system; **only if no other DM is enabled**).

### Detection (no questions asked)

The installer detects from the existing Arch install:
- keyboard layout (`vconsole` → XKB)
- timezone
- locale

### Install targets

- `/usr/bin/{crystal-shell, crystal-shell-ui, crystal-greeter, crystal-lock, crystal-game-mode}`
- `/usr/share/crystal-shell/` — configs, bundles, `VERSION`, wallpaper
- `/usr/share/wayland-sessions/crystal-shell.desktop`
- `/usr/share/applications/`
- XDG portal config

User config always under `~/.config/crystal-shell/`.

### Asset resolution — `SHELL_ROOT`, never the config dir

Code-shipped assets (icons in `assets/icons/`, `style.css`) resolve ONLY against
`SHELL_ROOT` (`core/Paths.ts` = `$CRYSTAL_SHELL_ROOT`, set by `scripts/crystal-shell-ui`):
the source tree `repo/ui/ags-v3` in `--dev`, `/usr/share/crystal-shell/ui/ags-v3` in
`--system`. `install.sh` ships `ui/ags-v3/assets/` into `/usr/share/...`.

Do NOT resolve assets against `~/.config/crystal-shell/` — an old secondary
`${config}/crystal-shell/ui/ags-v3/...` path existed only because the config dir used
to be a symlink to the repo (see footgun below); it was removed from
`Icons.ts`/`app.ts`/`ThemeManager.ts` (2026-06-05). Rule of thumb: **shipped assets →
`SHELL_ROOT`; user state → `~/.config/crystal-shell/`.** They are never the same place.

## Dev loop

```bash
./install.sh --dev                       # one-time setup
# edit TSX/SCSS in ui/ags-v3/
Super+Shift+R                            # reload UI in a graphical session
tail -f /tmp/crystal-shell-ui.log        # logs
killall gjs                              # nuke stale GJS holding the old UI
cd ui/ags-v3 && ags types -d .           # (re)generate @girs/ typings — see below
cd ui/ags-v3 && npm run typecheck        # needs @girs/
cd ui/ags-v3 && npm run build            # SCSS + ags bundle
ags request toggleAppGrid                # send an IPC command
```

### Debugging "the change didn't apply"

When a reload seems to do nothing or styles refuse to refresh, the cause is almost always a zombie `gjs` process still drawing the previous UI. Order of escalation:

1. `Super+Shift+R` again.
2. `killall gjs` — then `Super+Shift+R` once it's gone.
3. `tail -f /tmp/crystal-shell-ui.log` and re-trigger; look for stack traces.

CI gates **only SCSS compile** (pure JS, no system libs). Local typecheck is required because it needs the git-ignored `@girs/` (~58 MB of GI typings).

**Regenerating `@girs/` (and the trap it sets).** `@girs/` is git-ignored, so a fresh clone / a new
environment has none. Regenerate with `cd ui/ags-v3 && ags types -d .` (offline — reads the system
`.gir` files; ~208 `.d.ts`; do **not** pass `-u`, which would rewrite the committed `tsconfig`).
**The trap:** without `@girs/`, `npm run typecheck` doesn't fail loudly — it floods you with ~57
*false* `Namespace '"ags/gtk4".Gtk' has no exported member 'Box'`-style errors. Real errors hide in
that noise, so a regression can sit unnoticed (it did: typecheck silently went 0→32 between work
sessions). **If you see "has no exported member" on GI types, you're missing `@girs/` — regenerate
before trusting any typecheck result.**

**i18n key types come from `en`, not `es`.** `t()` is typed `key: keyof typeof en` (canonical
English-first source); `es`/future locales may lag and fall back at runtime (`es → en → key`). Add
new strings to `en.ts`; don't expect a missing `es` entry to be a type error. (It used to derive from
`es`, which broke the typecheck on every English-first key added — fixed in `core/i18n/index.ts`.)

### Testing Wi-Fi without a Wi-Fi adapter

The Network settings page is driven by `AstalNetwork`, so most of it only exercises
when a Wi-Fi device exists. On a wired-only box, simulate one with the kernel's
`mac80211_hwsim` (virtual 802.11 radios that NetworkManager treats as real). A dev
helper lives at `scripts/dev/fake-wifi.sh` (start/stop a WPA2 AP). The recipe:

```bash
sudo modprobe mac80211_hwsim radios=2     # → wlan0 + wlan1; not persistent across reboot
sudo pacman -S hostapd                    # broadcaster
nmcli radio wifi on                       # radios boot "unavailable" until wifi is enabled
sudo scripts/dev/fake-wifi.sh start       # AP "CrystalTest" / pass crystal123
# Settings → Network → Scan → connect
sudo scripts/dev/fake-wifi.sh stop
```

Three non-obvious traps this setup exposes, all of which bit real code:

- **`AstalNetwork` watches exactly ONE Wi-Fi device.** `network.vala`'s `get_device()`
  prefers a device with an active connection, else returns the **first** wifi device
  (`wlan0`). So the *fake AP must run on `wlan1`* and `wlan0` stays the managed client —
  otherwise the page watches the broadcaster and sees an empty AP list while `nmcli`
  on the other interface sees everything.
- **The world regulatory domain `00` sets `NO-IR` on 2.4 GHz**, which silently stops
  hostapd from ever beaconing — the interface stays `type managed` instead of `type AP`.
  Pin a real country first (`iw reg set ES`, also `country_code=` in the hostapd conf).
- **`AstalNetwork.Wifi` is a single object, not a collection.** There is no
  `get_devices()` and no `access-points-changed` signal — use the `device` property and
  `notify::access-points`. These were latent bugs that never ran on wired-only hardware.

### Testing Bluetooth without a Bluetooth adapter

`AstalBluetooth` talks to **BlueZ over the system D-Bus**, so (unlike Wi-Fi's real
`mac80211_hwsim` radio) you fake the whole `org.bluez` service with **python-dbusmock**'s
`bluez5` template — the same approach GNOME uses for its BT panel. Dev helper:
`scripts/dev/fake-bluetooth.sh` (needs `pacman -S python-dbusmock`; run as root — it
stops `bluetooth.service` and owns `org.bluez`).

```bash
sudo scripts/dev/fake-bluetooth.sh start   # adapter + Keyboard/Mouse (paired) + Phone (nearby)
# Super+Shift+R, then Settings → Bluetooth
sudo scripts/dev/fake-bluetooth.sh stop    # restores real bluetooth.service
```

The bluez5 template has **two quirks the script works around**, plus one hard limit:

- **`StartDiscovery` throws `KeyError: 'DiscoveryFilter'`** — the template reads that
  adapter prop without initialising it. The script seeds it with an empty
  `Adapter1.SetDiscoveryFilter` after `AddAdapter`, so the Scan button works.
- **`Device1.Connect`/`Disconnect` (what the UI buttons call) update an internal
  `device.connected` *attribute* + emit `PropertiesChanged`, but NOT the property store**,
  while the `Mock.ConnectDevice` *control* method does the opposite. Mixing them desyncs a
  device (the guard then raises `AlreadyConnected`/`NotConnected` and the click silently
  no-ops). So the script creates devices **paired-but-disconnected** and never pre-connects.
  Live connect↔disconnect then works within a session, but **after a UI reload a device
  reverts to disconnected** (the store was never updated) and reconnecting can stick —
  `stop && start` the mock to reset.
- **Pairing is "just works" only** — the template's `Pair` never calls back into a
  registered `Agent1`, so the passkey/PIN flow can't be exercised with this mock (see the
  pairing-agent gap in `tech-debt.md`).

This setup surfaced a real latent bug, fixed in `BluetoothService.setPowered`:
`AstalBluetooth.Bluetooth.is_powered` is **read-only** (writing it throws "not writable"),
so the old `bt.is_powered = state` toggle flipped the switch visually but never powered the
radio. Drive `bt.adapter.powered` instead.

### Testing the battery widget on a desktop (no battery)

`AstalBattery` reads UPower's composite **DisplayDevice over the system D-Bus**, so on a
desktop (`is_present = false`) the battery tiles only render a dim fallback icon and the
Cairo glyph can't be seen. Fake it with python-dbusmock's `upower` template via
`scripts/dev/fake-battery.sh` (run as root — it stops `upower.service` and owns
`org.freedesktop.UPower`):

```bash
sudo scripts/dev/fake-battery.sh start 72              # 72% discharging (neutral fill)
sudo scripts/dev/fake-battery.sh start 10 discharging  # low → red fill + "low" warning
sudo scripts/dev/fake-battery.sh start 45 charging     # green fill
sudo scripts/dev/fake-battery.sh start 100 full        # fully charged
sudo scripts/dev/fake-battery.sh stop                  # restores real upower.service
```

**Policy gotcha (why not `SetupDisplayDevice`):** UPower's D-Bus system policy
(`/usr/share/dbus-1/system.d/org.freedesktop.UPower.conf`) whitelists `send_interface` to
Introspectable/Peer/Properties/UPower[.Device] — the dbusmock control interface
`org.freedesktop.DBus.Mock` is **not** in it, so the template's `SetupDisplayDevice` method
is **"Access denied"** (bluez5 works only because `org.bluez`'s policy is permissive). The
script instead seeds the DisplayDevice via `org.freedesktop.DBus.Properties.Set` (whitelisted),
which dbusmock honours. Re-running `start` with new values **re-seeds live** (the glyph
updates without a reload — `Set` emits `PropertiesChanged`). Only the **first** `start` flips
`is_present` false→true, which `buildContent` reads at build time — so reload once
(Super+Shift+R) after the first start, then change values freely.

**Range gotcha:** UPower's `Percentage` is **0–100**, but `AstalBattery.percentage` divides
it to a **0–1 fraction** (per the GI docs). The widget uses `bat.percentage` (0–1) directly
for the Cairo fill and `× 100` for the label — an earlier `Math.round(bat.percentage)` in
the detail panel was a latent "0%/1%" bug, hidden only because desktops never showed it.

## Persistence

All persistent state lives in `~/.config/crystal-shell/`:

| File | Purpose |
|---|---|
| `theme_settings.json` | Theme engine state |
| `fluid-crystal.json` | Token engine config |
| `appearance.json` | Appearance state (+ world-readable mirror at `/var/tmp/crystal-shell/appearance.json` for the greeter) |
| `dock_settings.json` | Dock layout/behavior |
| `dock_pinned.json` | Dock pinned apps |
| `cc_layout.json` | Control Center layout |
| `widgets.json` | CC widget registry/metadata |
| `bar-settings.json` | Bar config |
| `region.json` | Time/date/timezone |
| `gaming.json` | Game-mode config |
| `night-light.json` | Night light schedule |
| `wallpaper` | Current wallpaper path |
| `greeter-prefs.json` | Greeter preferences |

### Hyprland config ownership model (settled 2026-06-05 — do NOT re-litigate)

There were multiple conflicting approaches across past sessions. This is the final,
verified-live model. Two tiers, cleanly split:

**SHARED (one for all users, in `/usr/share`):**
- `/usr/share/crystal-shell/config/hypr/hyprland.lua` — the base config. Same for
  everyone; ships with the shell. In `--dev` it's a **symlink → repo**
  (`config/hypr/hyprland.lua`); in `--system` it's a real copy. **Never edit the
  installed copy directly** — edit the repo, it says so in its own header.

**USER (per-user, in `~/.config/crystal-shell/`):**
- `hyprland-user.lua` — personal overrides, **never overwritten** by updates.
  `safe_require`'d LAST so it wins. The `@autostart start/end` marker block inside
  it is managed by the Autostart Settings page (`Autostart.tsx`); everything outside
  the markers is the user's free space.
- `crystal-settings.lua` — UI-generated input/keyboard config (sensitivity,
  `kb_layout`, repeat, touchpad), written by `InputConfig.ts` from the Input page.
- `crystal-monitor.lua` — UI-generated monitor config (output/mode/scale/vrr),
  written by `MonitorConfig.ts` from the Display page.
- `hypridle.conf` — idle config.

**NOTHING goes in `~/.config/hypr/`.** Mainline Hyprland defaults to
`~/.config/hypr/hyprland.lua`, but Crystal Shell deliberately keeps that directory
empty and loads the shared config explicitly via `-c` (see load mechanism below).
A stray `~/.config/hypr/hyprland.lua` is a leftover from older approaches — remove it.

`crystal-settings.lua` / `crystal-monitor.lua` are **live UI-generated config, not
junk** — deleting them is technically safe (`hyprland.lua` uses `safe_require`/pcall,
so missing files don't break boot) but you'd lose real settings (e.g. `kb_layout`)
until the user re-touches that Settings page, which regenerates the file. Don't tell
users to delete them.

### How the shared config actually loads (`-c` through `start-hyprland` — subtle)

Session chain: `crystal-shell` (launcher) → `uwsm start … hyprland.desktop` →
`start-hyprland` (stock hyprland pkg watchdog) → `Hyprland`. To make `Hyprland`
load the `/usr/share` config instead of the `~/.config/hypr` default, the launcher
passes a **DOUBLE `--`**:

```
uwsm start -e -D Hyprland hyprland.desktop -- -- -c /usr/share/crystal-shell/config/hypr/hyprland.lua
```

Why two: `uwsm` forwards args after *its* `--` onto `start-hyprland`; `start-hyprland`
only forwards args after *its own* `--` to `Hyprland`. A single `--` yields
`start-hyprland -c <path>`, which `start-hyprland` swallows → Hyprland silently falls
back to `~/.config/hypr/hyprland.lua`. Don't "simplify" the double dash away
(`scripts/crystal-shell`, commit d03c9f1).

Verify which config is live: `cat /proc/$(pidof Hyprland)/cmdline | tr '\0' ' '` →
must show `-c /usr/share/crystal-shell/config/hypr/hyprland.lua`. (Hyprland 0.55.2
logs it as `[cfg] Config is either explicit or special`, NOT the literal phrase
"lua config <path>".)

### Config dir is a real directory, not a symlink (historical footgun)

`~/.config/crystal-shell/` must be a **real directory** holding only runtime config
(the `.json` files + the three `.lua` + `wallpaper` + `.dev`). It is **separate** from
the repo at `~/Dev/Distroia`. Historically it was once a manual symlink → the repo,
which fused the config dir and the git tree and caused a delete incident (an
"organize the config dir" sweep wiped the live checkout). If you ever find it's a
symlink, that's the bug — make it a real dir.

### Env vars

- `~/.config/uwsm/env` + `~/.config/uwsm/env-hyprland` — toolkit/NVIDIA env. **This is where env vars live, NOT in the Hyprland config.** A new contributor's first instinct is to drop env vars in `hyprland.lua`; that's wrong.
- Session-wide env (Wayland backend, `QT_QPA_PLATFORMTHEME=xdgdesktopportal`, GI paths) is exported by the `scripts/crystal-shell` launcher itself.
- **GOTCHA — sourcing order:** uwsm **sources** `~/.config/uwsm/env` as a shell, and it does so AFTER the launcher's own exports, so the env file WINS on any conflicting var. (A stale `QT_QPA_PLATFORMTHEME=qt6ct` in the env file was silently overriding the launcher's `xdgdesktopportal` — fixed in `defaults/uwsm/env` + an idempotent migration in install.sh.) Because it's sourced, values with shell metachars must be quoted: `export QT_QPA_PLATFORM="wayland;xcb"` (a bare `;` truncates the var and runs `xcb` as a command).
- **NVIDIA autodetect:** `install.sh` detects NVIDIA hardware + active driver (`lspci` + `lsmod`) and uncomments the GPU env vars in `~/.config/uwsm/env` ONLY for the proprietary/open driver (never nouveau — those `nvidia-drm`/GBM vars break a nouveau/mesa session). It warns (never auto-edits boot) if `nvidia_drm modeset` is off, and informs on hybrid graphics. AMD/Intel need nothing.

## Default keybindings (from `hyprland.lua`)

| Keys | Action |
|---|---|
| `Super+S` | Settings |
| `Super` (tap) | App launcher (Prism) |
| `Super+T` | Kitty |
| `Super+E` | Nautilus |
| `Super+L` | Lock |
| `Super+G` | Game overlay |
| `Super+Shift+G` | Game mode |
| `Super+M` | Exit session |
| `Super+Shift+R` | Reload UI |
| `Super+Q` | Close window |
| `Super+F` | Float |
| `Super+P` | Pseudo |
| `Super+1–5` | Switch workspace |
| `Super+Shift+1–5` | Move to workspace |
| `Super+Scroll` | Cycle workspaces |
| `Super+arrows` | Focus |
| `Super+Shift+arrows` | Resize |
| `Super+LMB drag` | Move window |
| `Super+RMB drag` | Resize window |
| `Print` | Region → clipboard |
| `Shift+Print` | Region → `~/Pictures/` |

### Adding a new keybind that triggers UI

The pattern is: keybind in `hyprland.lua` → `ags request <cmd>` → `requestHandler` in `app.ts` → `ShellActions.<action>()` → `Status.<setter>()`.

Don't shortcut this. Every step is there for a reason (Hyprland reload-safety, IPC visibility from CLI, typed registry, central state).

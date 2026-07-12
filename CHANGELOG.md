# Changelog

All notable changes to Nidara are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-07-12

### Added

- **Nidara now speaks 11 languages.** French, German, Italian, Brazilian
  Portuguese, Polish, Dutch, Russian, Simplified Chinese and Japanese join
  English and Spanish. The desktop follows your system language; change it in
  Settings → Language & Region.
- **You can now see your AI agent's cursor.** When an agent acts through
  computer control (off by default, Settings → AI), an accent-colored pointer
  with an "AI" badge travels to the target and pulses where the action lands —
  you always see where the agent clicked, and it backs off the moment you move
  your own mouse. The red bar indicator and the Super+Shift+Esc kill switch
  still stop everything instantly.
- Autostart entries can now be added by picking from your installed apps —
  search, pick, done. The raw-command field remains for advanced entries.

### Changed

- Clocks and dates across the desktop — top bar, login screen and lock
  screen — now follow your system regional format: localized day and month
  names and the native field order, including year-first formats such as
  Chinese and Japanese (e.g. 7月12日 土曜日). Dates no longer render in
  hardcoded English.
- Autostart moved from its own sidebar page into Settings → Apps, and it now
  appears in Settings search.
- A consistency pass over the English and Spanish interface texts (sentence
  case throughout, unified terminology).

### Fixed

- Autostart entries edited in Settings now take effect on a standard install —
  the old page wrote to a file Hyprland never read, so its entries silently
  never launched.

## [0.1.7] — 2026-07-11

### Added

- Default terminal configuration: kitty now ships with a Nidara config on new
  setups — window padding that keeps text clear of the rounded corners, the
  JetBrains Mono font, a subtle glass transparency, and terminal colors that
  follow the system dark/light toggle live. Seeded only when you have no kitty
  config of your own; an existing setup is never touched, and once seeded the
  file is yours (updates never overwrite it).

### Changed

- Laptops now suspend after 30 minutes of idle by default (desktops never
  auto-suspend); Settings → Power overrides this either way.

### Fixed

- Appearance → Fonts on a fresh install showed "Adwaita Mono" — a font Nidara
  doesn't ship — as the monospace font. The bundled JetBrains Mono is now the
  default; a font you picked yourself is never overridden.
- Users created after install time (Settings → Users, `useradd`, archinstall)
  now get their per-user configuration seeded at first login, before the
  desktop loads — previously they landed on an unthemed session with defaults
  missing. A deleted `~/.config/nidara` heals itself the same way.
- Users without a profile photo now see the same avatar glyph on the login
  screen, the lock screen and Settings, instead of a different placeholder on
  each.

## [0.1.6] — 2026-07-10

### Added

- The login screen now remembers the last user who signed in and preselects them at
  boot — avatar, name and their appearance/clock preferences — instead of always
  presenting the first account.

### Fixed

- Settings → Users no longer shows "Unknown" as the display name on systems installed
  without a full name (e.g. archinstall); setting a name now takes effect immediately
  across Settings, the login screen and the lock screen.
- The language and keyboard layout picked at the login screen now survive a reboot,
  and stray greeter dotfiles no longer land in the filesystem root.
- Creating a user: cancelling the password authorization no longer closes the dialog
  as if it had succeeded (the account existed but couldn't log in) — the error is
  shown and Create retries just the password step; a blank password now intentionally
  creates a locked account, as the field promised; picking an existing username now
  says exactly that.
- The Other Users list no longer goes blank after creating or deleting a user.
- "Change Password" on a user row now opens (it failed silently before) and survives
  a cancelled authorization prompt.
- The administrator toggle no longer re-opens the authorization prompt in an endless
  loop when cancelled, has a visible label now, and the user glyph in the list is no
  longer black in dark mode.

## [0.1.5] — 2026-07-09

### Fixed

- The lock screen now shows the default wallpaper on fresh installs — until a wallpaper
  was picked in Settings it painted a flat backdrop. It also falls back gracefully (user
  wallpaper → default) when the configured image no longer exists on disk, instead of
  going blank. Groundwork included for assigning independent wallpapers to the desktop,
  lock screen and login screen from Settings in a future release.
- On multi-user machines the lock screen now shows — and verifies the password of — the
  user who actually locked the session; previously it always presented the first user
  account, locking everyone else out of their own session.
- The login screen's clock now honors the time and date format chosen in Settings even
  when the user's home directory is private (mode 700).
- Config files generated before the Nidara rename no longer keep "Crystal Shell" headers
  forever — they're rewritten (comments only, never user content) on the next
  install or update.

## [0.1.4] — 2026-07-09

### Changed

- Settings → Apps → **Installed Apps** (formerly "App Icons") now opens each app on its
  own page instead of a pop-up dialog — more room for the icon override, which now applies
  instantly (no Apply/Cancel), and a natural home for future per-app settings. Each row now
  shows the app's id as its subtitle.

### Fixed

- The tails of letters like g, j, y and p no longer linger as faint leftover fragments — nor
  get clipped short — in the Installed Apps search while filtering the list.

## [0.1.3] — 2026-07-07

### Changed

- **Nidara now installs as a real pacman package (`nidara`).** System installs consume it
  prebuilt from the project's signed repo (or build it on the spot from the same in-repo
  recipe when the repo doesn't serve the release yet) — pacman owns every installed file,
  so Nidara upgrades with the rest of the system (`pacman -Syu`) and removes cleanly
  (`pacman -R nidara`). Existing installs migrate automatically on their next
  `nidara-update`; user config is untouched.
- `nidara-update` on package installs is now a full system upgrade plus the idempotent
  setup pass, reloading the running session only when the version actually changed.
- New `nidara-setup` binary carries the first-time setup packaging can't do (greeter,
  services, per-user config seeding) — with the repo configured,
  `sudo pacman -S nidara && nidara-setup` is a complete install.

### Added

- `toggleAbout` IPC action — the About window can now be opened, verified and closed
  deterministically (agent tooling parity with the other surfaces).
- Community docs: Code of Conduct (Contributor Covenant 2.1) and a Credits section.

### Fixed

- Upgrading or reinstalling under a live session no longer leaves a stuck Hyprland
  "cannot open … hyprland.lua" error banner — replacing the packaged config file killed
  the compositor's config watch; both update paths now reload it once the new file is
  in place.

## [0.1.2] — 2026-07-06

### Fixed

- With a surface open (Control Center, Notification Center, system menu, or a widget
  pill), clicking another bar capsule now switches to it in a single click — the first
  click no longer just dismisses. Clicking anywhere below the bar still dismisses.
- The widget expansion panel no longer flashes at the previous pill's position when
  jumping directly from one pill to another.
- Updates no longer abort on the repository's moving `ci-assets` tag — `nidara-update`
  fetches only release tags (`v*`).
- Updates no longer silently drop agent-carried local fixes: when a patch stack is
  registered (`~/.config/nidara/.patches`), `nidara-update` and `install.sh --update`
  refuse the blind reinstall and point at the carry flow (rebase onto the new release,
  then `install.sh --update-apply`).

## [0.1.1] — 2026-07-05

### Security

- The prebuilt dependency repo ([nidara-repo](https://github.com/nidara-project/nidara-repo))
  is now GPG-signed end-to-end: CI signs every package and the repo database, and
  `install.sh` imports the project key and enforces signature verification
  (`SigLevel = Required DatabaseOptional`). Existing installs are migrated automatically
  on their next update. No changes to the desktop itself.

## [0.1.0] — 2026-07-05

First public release. Nidara is a full Wayland desktop environment for Arch Linux,
built on Hyprland and AGS v3 (Aylur's GTK Shell), registering as a proper login session.

### Desktop

- **Compositor** — Hyprland (Wayland) with smooth animations and tiling + floating
  window management; Lua-based config with a user override file
  (`~/.config/nidara/hyprland-user.lua`).
- **Bar** — live clock, workspaces, system tray, resource indicators, and a system
  menu with inline power actions.
- **Dock** — hover magnification with spring physics; bottom, left, and right
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
- **Familiar shortcuts** — `Alt + Tab` window cycling, `Super + M` maximize,
  `Super + Space` Search, `Super + Ctrl (+ Shift) + ←/→` workspace navigation,
  alongside the tiling basics (focus, resize, float, fullscreen, pseudo-tile).

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

[0.1.2]: https://github.com/nidara-project/nidara-desktop/releases/tag/v0.1.2
[0.1.1]: https://github.com/nidara-project/nidara-desktop/releases/tag/v0.1.1
[0.1.0]: https://github.com/nidara-project/nidara-desktop/releases/tag/v0.1.0

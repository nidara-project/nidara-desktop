---
name: crystal-shell
description: "Authoritative reference for working on the Crystal Shell desktop environment codebase — a full Wayland session for Arch Linux built with AGS v3 + TypeScript/TSX → GJS on GTK4 + Hyprland. Use this skill whenever the user mentions Crystal Shell, fluid-crystal, the shell bar, dock, control center, notification center, prism/spotlight, app grid, overview, system menu, settings window, lockscreen, or greeter; asks to edit files under `ui/shell/`, `ui/greeter/`, `ui/lockscreen/`, or `ui/lib/crystal-ui/`; wants to modify `hyprland.lua`, SCSS in `styles/`, a `core/` service, or run `install.sh`. Also trigger on questions about reloading the UI (Super+Shift+R), `ags request` IPC, `Status.ts`, the three build bundles, or the Fluid Crystal design system. ALWAYS consult this skill BEFORE editing files in this repo — strict conventions (no `Adw.OverlaySplitView`, no transform scale on clickables, no hardcoded colors, scoped CSS only, IPC via `ShellActions` not `globalThis`) are easy to violate without it."
---

# Crystal Shell

> Repo: `github.com/fluid-crystal/crystal-shell` · License: GPL-3.0 · Version in `VERSION` (0.1.0).

## What this project is

Crystal Shell is a **full Wayland desktop environment** for Arch Linux — not a theme, not a set of scripts. It registers as a proper Wayland session (like GNOME/KDE) and is launched by the display manager. The compositor is **Hyprland**; the UI is **AGS v3 (Aylur's GTK Shell)** written in **TypeScript/TSX → GJS**, on **GTK4 + gtk4-layer-shell** (libadwaita fully removed), styled with **SCSS** and painted with **Cairo** where shapes get custom (dock squircles, workspace dots, resource rings, schematic).

The aesthetic is "Crystal literal": heavy-blur glass capsules with a 1px inner white edge, soft outer shadow, top sheen; the accent color is used **only for active/selected state**.

It is also **AI-native by design**: this skill ships *inside* the repo so that any user's agent can extend, customize, and fix their own desktop — and propose globally-useful improvements back upstream. If you're helping a user with their installed copy rather than the project itself, start at `references/agent-contribution.md`.

## The repo is THREE separate bundles, not one app

This is the single most important fact to internalize before touching anything:

| Bundle | Source | Output binary | Role |
|---|---|---|---|
| **Shell** | `ui/shell/` | `build/crystal-shell` | Desktop: bar, dock, overlays, settings |
| **Greeter** | `ui/greeter/` | `build/crystal-greeter` | Login (greetd + AstalGreet) |
| **Lockscreen** | `ui/lockscreen/` | `build/crystal-lock` | Lock via `Gtk4SessionLock` (OVERLAY-layer fallback) |

Each has its own `app.ts`, its own `package.json`, its own `ags bundle` invocation. Code shared between the greeter and the lockscreen is currently duplicated (see `references/tech-debt.md`).

## The ten inviolable commandments

These are non-negotiable. Violating them produces bugs that are hard to debug because the symptoms don't point at the cause.

1. **Never use `Adw.OverlaySplitView` in Settings** — use `CrystalSplitView` from `ui/lib/crystal-ui/`. Adw's version breaks capsule margins.
2. **Never write unscoped global CSS** — every widget's CSS goes inside `window#name { … }`.
3. **Kill zombies before debugging.** A stuck terminal or "styles won't refresh" almost always means a zombie GJS is still drawing the dead UI. Run `killall gjs` before changing code in a loop.
4. **`core/` never touches the UI.** All visibility changes flow through `Status.ts`. Widgets never flip each other directly.
5. **Overlays live inside the Bar's window** via `Gtk.Overlay`, not in their own windows. This avoids Hyprland layer conflicts; that's why show/hide animations are GTK-side (`common/ScaleRevealer.ts`).
6. **IPC goes through `ags request` + `core/ShellActions`** — never reintroduce `globalThis` coupling.
7. **The Settings window appears in Hyprland as class `io.Astal.ags`**, not `com.crystalshell.fluid`. The dock filters and remaps it to `crystal-shell-settings`. Don't "fix" this without understanding why.
8. **`AboutWindow` is create+destroy, not hide** (Settings is the opposite — it hides on close).
9. **No CSS `transform: scale` or `transform: translate` on clickable widgets.** GTK respects them but they break hit-testing. Use `margin`, scale in Cairo, or `common/ScaleRevealer.ts` for transient show/hide grow animations (snapshot-time, ends at identity — see `references/design-system.md`).
10. **No hardcoded colors. No emoji as iconography.** Resolve against `--crystal-*` tokens; use SVGs in `assets/fluid-crystal/assets/scalable/` or the `cs-*-symbolic` icon set.

## Quick orientation: where to start

Before doing anything that touches code:

- **Editing TSX widgets, adding overlays, changing dock/bar/CC behaviour** → read `references/architecture.md` first, then `references/state-and-ipc.md`.
- **Editing SCSS, restyling anything, working on the design tokens** → read `references/design-system.md`.
- **Adding a new core service or modifying state** → read `references/architecture.md` (core/ section) and `references/state-and-ipc.md` (Status.ts).
- **Working on the installer, build, or session boot** → read `references/dev-workflow.md`.
- **Debugging something weird, or considering a refactor** → check `references/tech-debt.md` first — it might already be a known issue.
- **Helping a user customize their OWN installed copy** (not the canonical repo) → read `references/agent-contribution.md` FIRST. It tells you whether a change is personal (→ config layer), should become a Setting, or is a global improvement worth proposing back upstream as a PR.

The references are short and load-on-demand. Don't try to hold the whole project in context; read the specific reference you need.

## The dev loop in one screen

```bash
./install.sh --dev                       # one-time setup: system binaries + ~/.config/crystal-shell/.dev
# ... edit TSX/SCSS in ui/shell/ ...
# In a graphical session:
Super+Shift+R                            # reload the UI (re-runs crystal-shell-ui → ags run)
tail -f /tmp/crystal-shell-ui.log        # logs
killall gjs                              # nuke stuck old UI when reload misbehaves
cd ui/shell && npm run typecheck        # local typecheck (needs the git-ignored @girs/)
cd ui/shell && npm run build            # SCSS compile + ags bundle
ags request listActions                  # discover the shell's IPC surface (JSON)
ags request dumpState                    # live shell state as JSON (overlays, version, effective Hyprland config…)
ags request describeConfig               # agent-facing settings: schema + current values (JSON)
ags request setConfig <key> <value>      # change a setting officially (validated; gated by Settings → AI)
ags request screenshot [path]            # capture the focused monitor → PNG path (visual verification; gated)
crystal-a11y [app]                       # computer-use perception: a THIRD-PARTY app's UI via AT-SPI, same shape as queryUI (read-only; gated by allowComputerUse, default OFF)
crystal-act <app> <node> <action>        # computer-use action: invoke a named AT-SPI action on a named control (deterministic, no synthetic input; gated by allowComputerControl, default OFF, requires perception)
crystal-type text|key <app> <payload>    # computer-use synthetic keyboard via wtype (focus-verified: <app> must be the active window); same allowComputerControl gate. Pair with crystal-act … SetFocus
ags request focusWindow <app>            # raise/focus a 3rd-party window by class (precondition for the keyboard; reuses the dock's HyprlandState.focusWindow); gated by allowComputerControl
ags request disableComputerControl       # kill switch: revoke AI control instantly (also: click the bar indicator, or Super+Shift+Esc)
crystal-shell-doctor                     # Markdown diagnostic report (bug/PR evidence)
crystal-shell-mcp                        # all of the above as MCP tools over stdio (incl. query_app → crystal-a11y, do_app_action → crystal-act, type_text/press_key → crystal-type, focus_window → ags request focusWindow; .mcp.json: repo root for dev; installer-managed copy in ~/.config/crystal-shell/ for users)
```

CI gates SCSS compile, typecheck, widget-registry freshness **and a headless boot smoke**:
the smoke job builds the pinned Astal/AGS stack in an Arch container, bundles the shell,
boots it on a real Hyprland over a virtual display (kernel vkms + llvmpipe) and fails on death, silent IPC,
or JS errors; screenshots are uploaded as artifacts for human review. The typecheck job
downloads a compressed `@girs/` snapshot from the repo's `ci-assets` release (`@girs/`
itself stays git-ignored, ≈58 MB generated); when it goes stale a maintainer refreshes it —
see `references/dev-workflow.md`.

## When in doubt

- The codebase is intentionally **pure GTK4 + Cairo** for anything custom-painted (Dock, Bar, dots, rings, schematic) and **AGS/GTK + custom CSS** for floating overlays. **libadwaita has been fully removed** — windows are `Gtk.Window`, `Adw.AlertDialog` → `showCrystalAlert`, `Adw.Clamp` → `CrystalClamp`, and dark/light is driven by `Gtk.Settings.gtk_application_prefer_dark_theme` (no `Adw.init()`). Don't reintroduce any `Adw.*`. See `references/design-system.md`.
- The state model is **one central GObject (`Status.ts`)** with mutually-exclusive overlay setters. Subscribe via `notify::prop`. See `references/state-and-ipc.md`.
- The dock H/V split is **already deduplicated**: `DockHorizontal.tsx` and `DockVertical.tsx` are 7-line wrappers; shared logic lives in `DockCore.tsx` with axis differences isolated in `DockAxis.ts`. Edit those, not the wrappers — see `references/tech-debt.md`.
- Sliders are **one component**: `makeSlider` (Cairo) in `common/Slider.ts` — horizontal or vertical, optional thumb, custom non-warp input. There is no native `Gtk.Scale`. See `references/design-system.md`.

## Keep this skill current (part of "done", not a follow-up)

This skill is only useful if it matches reality. **When a change introduces or alters
something that needs explanation** — a new mechanism, a non-obvious pattern, a "why is it
done this way", a new shared component, or a gotcha that bit you — **update the skill in the
same change**:

- Put the *how/why* in the right `references/` file (architecture / design-system /
  state-and-ipc / dev-workflow), not just in the commit message. If a contributor's agent
  would need it to work correctly, it belongs here.
- Keep `references/tech-debt.md` honest: **remove items you just resolved** and **add new
  debt or deferred work** you created or found. The list must reflect the current state.
- Fix any statement in `SKILL.md`/references that your change made wrong.

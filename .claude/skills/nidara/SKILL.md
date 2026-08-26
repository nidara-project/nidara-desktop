---
name: nidara
description: "Authoritative reference for working on the Nidara desktop environment codebase — a full Wayland session for Arch Linux built with TypeScript/TSX → GJS on GTK4 + Hyprland (no AGS, no Astal). Use this skill whenever the user mentions Nidara, nidara-project, the shell bar, dock, control center, notification center, prism/search, app grid, overview, system menu, settings window, lockscreen, or greeter; asks to edit files under `ui/shell/`, `ui/greeter/`, `ui/lockscreen/`, or `ui/lib/nidara-kit/`; wants to modify `hyprland.lua`, SCSS in `styles/`, a `core/` service, or run `install.sh`. Also trigger on questions about reloading the UI (Super+Shift+R), `nidara-ipc` IPC, `Status.ts`, the three build bundles, or the Nidara design system. ALWAYS consult this skill BEFORE editing files in this repo — strict conventions (no `Adw.OverlaySplitView`, no transform scale on clickables, no hardcoded colors, scoped CSS only, IPC via `ShellActions` not `globalThis`) are easy to violate without it."
---

# Nidara

> Repo: `github.com/nidara-project/nidara-desktop` · License: GPL-3.0 · Version: read `VERSION` at the repo root (do not restate it here — this line said 0.1.0 while the file said 0.7.2).

## What this project is

Nidara is a **full Wayland desktop environment** for Arch Linux — not a theme, not a set of scripts. It registers as a proper Wayland session (like GNOME/KDE) and is launched by the display manager. The compositor is **Hyprland**; the UI is **TypeScript → GJS** on **GTK4 + gtk4-layer-shell** (libadwaita fully removed), hosted by **our own `Gtk.Application` in `ui/lib/host.ts`** and bundled by **our own `scripts/bundle.sh`** (esbuild), styled with **SCSS** and painted with **Cairo** where shapes get custom (dock squircles, workspace dots, resource rings, schematic).

⚠️ **AGS is GONE, entirely, since 2026-08-18** — runtime first (`ui/lib/{host,process,file,app-id}.ts` replaced its four modules), toolchain the same day:

| was | is | what it actually was |
|---|---|---|
| `ags bundle` | `scripts/bundle.sh` | esbuild with a fixed flag set + a bash wrapper around the JS |
| `ags run` | `scripts/run.sh` | the same bundle, executed by `gjs` |
| `ags types -d .` | `scripts/gen-types.sh` | one `npx @ts-for-gir/cli generate` call |
| `ags request` | `nidara-ipc` | a D-Bus call to `io.Astal.ags`, now `org.nidara.Shell` |

The flags in `bundle.sh` are AGS's, transcribed and **verified**: all three bundles come out
byte-identical to what `ags bundle` produced. Two of them are load-bearing and their comments say
so — `--tsconfig` (via `target: ES2020` it turns `useDefineForClassFields` OFF, and define-semantics
on a GObject subclass would shadow the property accessors) and the wrapper's `LD_PRELOAD` (no
gtk4-layer-shell ⇒ no bar, no dock, nothing in the log). See `references/architecture.md` →
"The application host is OURS" and `references/dev-workflow.md` → "The toolchain is ours".

⚠️ **Widgets are built imperatively — there is no JSX in this repo** and none of Gnim's reactive
primitives are used, despite the `.tsx` extensions. Read `references/architecture.md` ("There is no
JSX in this repo") before writing a widget; a JSX-shaped contribution will not match anything here.

The aesthetic is "Nidara literal": heavy-blur glass capsules with a 1px inner white edge, soft outer shadow, top sheen; the accent color is used **only for active/selected state**.

It is also **AI-native by design**: this skill ships *inside* the repo so that any user's agent can extend, customize, and fix their own desktop — and propose globally-useful improvements back upstream. If you're helping a user with their installed copy rather than the project itself, start at `references/agent-contribution.md`.

## The repo is FOUR separate bundles, not one app

This is the single most important fact to internalize before touching anything:

| Bundle | Source | Output binary | Role |
|---|---|---|---|
| **Shell** | `ui/shell/` | `build/nidara` | Desktop: bar, dock, overlays, settings |
| **Greeter** | `ui/greeter/` | `build/nidara-greeter` | Login (greetd, spoken directly — no AstalGreet) |
| **Lockscreen** | `ui/lockscreen/` | `build/nidara-lock` | Lock via `Gtk4SessionLock` (OVERLAY-layer fallback) |
| **Installer** | `ui/installer/` | `build/nidara-installer` | The live medium's installer — a GTK4 front-end over `archinstall` |

Each has its own `app.ts`, its own `package.json`, its own `scripts/bundle.sh` invocation. Code shared between the greeter and the lockscreen is currently duplicated (see `references/tech-debt.md`).

⚠️ **The fourth one does not ship with the desktop.** `packaging/nidara/PKGBUILD` is a SPLIT
package (since 2026-08-25): it builds `nidara` and `nidara-installer`, and only nidara-iso's
`packages.x86_64` ever names the second — a system somebody is using must not carry a program
whose job is to erase a disk. Two consequences that bite silently:

- anything picking "the package makepkg just built" has to say WHICH. `install.sh` passes
  `makepkg --pkg nidara` and matches the file by name; nidara-repo's `build-repo.sh` copies
  every package produced instead of the newest one. The old `ls -t … | head -1` would have
  installed an installer onto somebody's Arch.
- `install=` and `backup=` live INSIDE `package_nidara()`. At the top level of a split PKGBUILD
  they apply to every package.

The installer is a bundle of the desktop's toolkit, but **what it installs is not in this repo**:
its base archinstall config is airootfs content in nidara-iso
(`/usr/share/nidara-installer/base.json`), so the product's package list changes without
rebuilding anything here. `nidara-iso/INSTALLER.md` is the decision record — including why it is
not Calamares, and the line it never crosses (it collects answers and runs one process; it never
partitions, formats, pacstraps or writes a bootloader).

## The ten inviolable commandments

These are non-negotiable. Violating them produces bugs that are hard to debug because the symptoms don't point at the cause.

1. **Never use `Adw.OverlaySplitView` in Settings** — use `NidaraSplitView` from `ui/lib/nidara-kit/`. Adw's version breaks capsule margins.
2. **Never write unscoped global CSS** — a surface's CSS goes inside its window's selector
   (`#nidara-bar, .nidara-bar-window` / `#nidara-island …` / `#nidara-dock …` /
   `window.nidara-settings-window`). The design system's global layer is the sole exception:
   `_base.scss` tokens, the TWO `_components.scss` (`ui/lib/styles/` = the kit's, shared with the
   other bundles; `ui/shell/styles/` = the shell's half), `_reset.scss`, `@keyframes`. Scope table and
   the two traps in `references/design-system.md`.
3. **Kill zombies before debugging.** A stuck terminal or "styles won't refresh" almost always means a zombie GJS is still drawing the dead UI. Run `killall gjs` before changing code in a loop.
4. **`core/` never touches the UI.** All visibility changes flow through `Status.ts`. Widgets never flip each other directly.
5. **Overlays live inside the Bar's window** via `Gtk.Overlay`, not in their own windows. This avoids Hyprland layer conflicts; that's why show/hide animations are GTK-side (`common/ScaleRevealer.ts`). **TWO documented exceptions, each with a different reason — read both before claiming a third:**
   - **The Activity Island** (`surfaces/island/IslandWindow.ts`) — compact capsule AND expanded modes — needs its own OVERLAY-level surface because a surface cannot blur its own siblings. Move the whole thing or nothing: splitting the capsule from its modes across two surfaces breaks `compute_bounds` and makes their blurs stack into a seam mid-morph.
   - **The app grid** (`surfaces/app-grid/AppGridWindow.ts`, 2026-08-09) — for a purely economic reason, not a visual one. It used to be a child of the DOCK's window, and because Hyprland charges layer blur by the surface's BOX, a guest that can paint anywhere forced its host to hand back its whole monitor-sized region for as long as the grid was up. Its own surface declares the panel's rect (measured: 1110×834 of 2560×1440) and is UNMAPPED when closed, so a closed grid has no blur pass at all.
   The test a further candidate has to pass is one of those two: compositor blur physically unreachable inside the host window, or a monitor-sized-and-mostly-closed overlay costing its host its region. CC/NC/Prism/system menu/overview are none of that — they are small, they sit on the bar, and the bar pays for them only while they are open. (`architecture.md` counts these as the *second* and *third* exceptions because it also lists the agent pointer, which is a click-through cursor overlay rather than a UI surface.) See `architecture.md`.
6. **IPC goes through `nidara-ipc` + `core/ShellActions`** — never reintroduce `globalThis` coupling.
7. **A window that is an APPLICATION window declares its own app-id.** The shell's regular windows (Settings, About, Settings' modal dialogs) call `setWindowAppId(win, "nidara-settings")` from `ui/lib/app-id.ts` — or pass `appId` to `NidaraWindow` — so Hyprland files them under a name the desktop registry actually has. Do NOT go back to remapping a class in `AppService`: that remap existed only because AGS forced the app-id to `io.Astal.ags`, and it is deleted. Two silent traps live in `app-id.ts` (the `GdkWayland` import, and `map` vs `realize`) — read its header before touching it. *(This commandment used to say the opposite; the AGS host went on 2026-08-18.)*
8. **`AboutWindow` is create+destroy, not hide** (Settings is the opposite — it hides on close).
9. **No CSS `transform: scale` or `transform: translate` on clickable widgets.** GTK respects them but they break hit-testing. Use `margin`, scale in Cairo, or `common/ScaleRevealer.ts` for transient show/hide grow animations (snapshot-time, ends at identity — see `references/design-system.md`).
10. **No hardcoded colors. No emoji as iconography.** Resolve against `--nidara-*` tokens; use SVGs in `assets/nidara/assets/scalable/` or the `nd-*-symbolic` icon set.

## Quick orientation: where to start

Before doing anything that touches code:

- **Editing TSX widgets, adding overlays, changing dock/bar/CC behaviour** → read `references/architecture.md` first, then `references/state-and-ipc.md`.
- **Editing SCSS, restyling anything, working on the design tokens** → read `references/design-system.md`.
- **Adding a new core service or modifying state** → read `references/architecture.md` (core/ section) and `references/state-and-ipc.md` (Status.ts).
- **Working on the installer, build, or session boot** → read `references/dev-workflow.md`.
- **Touching the Assistant** (`bin/nidara-agent`, a wire lane, or what it can perceive) → read `references/dev-workflow.md`: the fake-brain walk, the wire-lane re-sync procedure, and the terminal bench for perception claims (a model that answers from a stale read looks identical in the island — only the log tells you).
- **Debugging something weird, or considering a refactor** → check `references/tech-debt.md` first — it might already be a known issue, or a **standing decision** telling you not to do what you were about to do. It holds only what is still owed; the bodies of resolved items live beside it in `references/tech-debt-resolved.md` (same numbers, never reused, indexed at the bottom of the live file).
- **Helping a user customize their OWN installed copy** (not the canonical repo) → read `references/agent-contribution.md` FIRST. It tells you whether a change is personal (→ config layer), should become a Setting, or is a global improvement worth proposing back upstream as a PR.

The references are short and load-on-demand. Don't try to hold the whole project in context; read the specific reference you need.

## The dev loop in one screen

```bash
./install.sh --dev                       # one-time setup: system binaries + ~/.config/nidara/.dev
# ... edit TSX/SCSS in ui/shell/ ...
# In a graphical session:
Super+Shift+R                            # reload the UI (re-runs nidara-ui → scripts/run.sh)
tail -f "$XDG_RUNTIME_DIR/nidara-ui.log"  # logs (per-user; falls back to /tmp)
killall gjs                              # nuke stuck old UI when reload misbehaves
cd ui/shell && npm run typecheck        # local typecheck (needs the git-ignored @girs/)
cd ui/shell && npm run build            # SCSS compile + scripts/bundle.sh (needs the `esbuild` package)
nidara-ipc listActions                  # discover the shell's IPC surface (JSON)
nidara-ipc dumpState                    # live shell state as JSON (overlays, version, effective Hyprland config…)
nidara-ipc describeConfig               # agent-facing settings: schema + current values (JSON)
nidara-ipc setConfig <key> <value>      # change a setting officially (validated; gated by Settings → AI)
nidara-ipc screenshot [path]            # capture the focused monitor → PNG path (visual verification; gated)
nidara-a11y [app]                       # computer-use perception: a THIRD-PARTY app's UI via AT-SPI, same shape as queryUI (read-only; gated by allowComputerUse, default OFF)
nidara-act <app> <node> <action>        # computer-use action: invoke a named AT-SPI action on a named control (deterministic, no synthetic input; gated by allowComputerControl, default OFF, requires perception)
nidara-type text|key <app> <payload>    # computer-use synthetic keyboard via wtype (focus-verified: <app> must be the active window); same allowComputerControl gate. Focus the WINDOW with focusWindow — NOT with nidara-act … SetFocus (a control-level action GTK4 mostly does not expose; a refusal hands back the target's address in `focus`). A number goes in with nidara-act … set-value=N, no keyboard at all
nidara-click <mode> <app> …            # computer-use synthetic POINTER. EVERY verb has both forms — *-app names an AT-SPI node, *-at takes a window-relative point: app/at = left-click; rclick-app/rclick-at = right-click; hover-app/hover-at = pointer move, NO button; scroll-app/scroll-at = wheel scroll (signed dx/dy notches); drag-app/drag-at = press→glide→release between two nodes / two points (DnD / rubber-band / sliders). nidara-input.c (zwlr_virtual_pointer, compiled by install.sh) is the injector; the CLI mode is the wrapper's vocabulary and MODES[mode].action the injector's (hover-* → the C verb `move`). Focus-verified; same gate. HOVER is not a lesser click: it is the only way to reach state that does not exist until the pointer is there (tooltips, hover-revealed controls, submenus) — read the a11y tree AFTER hovering. Every action plays the fake-AI-cursor visual (accent arrow + AI badge, `agentPointer` IPC, land→confirm; a hover lingers and does NOT ripple — it pressed nothing) and ABORTS if the user moves the mouse >10 px or the kill switch fires during the animation — the user always wins; the visual is an enhancement, never a gate (shell down = silent no-op)
nidara-ipc listWindows                  # window/workspace mgmt (UNGATED — shell driving its own compositor, not computer-use): open windows as JSON [{address,class,title,workspace,floating,…}]
nidara-ipc listWorkspaces               # workspaces as JSON [{id,name,windows,active,special}]; focusWorkspace <id|±1|name>/focusDirection <l|r|u|d>/focusWindow/closeWindow/moveWindowToWorkspace/toggleFloat|Fullscreen/…/setLayout act on them (window arg = address from listWindows OR class/title); each = one HyprlandState dispatch method. movewindow-directional + resize deliberately NOT added (active-window-only/focus-dependent + unverified Lua)
nidara-ipc focusWindow <window>         # raise/focus a window by address or class — a WM op (UNGATED, like a dock click); also the precondition for the synthetic keyboard (which stays gated)
nidara-ipc disableComputerControl       # kill switch: revoke AI control instantly (also: click the bar indicator, or Super+Shift+Esc)
nidara-doctor                     # Markdown diagnostic report (bug/PR evidence)
nidara-agent                      # the built-in Assistant's BRAIN: a BYOK LLM tool-use loop (Anthropic Messages / OpenAI-compatible via curl-SSE) whose desktop tools ARE `nidara-ipc` — so for those the assistant is just another client of the gated surface. A stdio child of the shell (spawned by core/AgentService; the island Agent mode / Super+A is its face), NOT run by hand; API key in the DE keyring (libsecret schema org.nidara.Assistant), brain config in ai.json (brainBackend/brainModel/brainEndpoint). Test with scripts/dev/fake-brain.py
                                  # ALSO reaches THIRD-PARTY apps through the same four computer-use helpers as nidara-mcp, with the same tool names — but only while the matching gate is on (`query_app` behind allowComputerUse; the ten action tools behind allowComputerControl), because the schemas cost ~2.2k tokens per step and a model told about a tool it cannot use promises what it cannot deliver. Gate re-read at the TURN boundary (grants mid-conversation take effect); a helper refusal is reported as a FAILED tool result, not an "ok" containing an error
                                  # ALSO owns a DAEMON-LOCAL file layer ("tier 1", 2026-07-27) that does NOT go through `nidara-ipc` — read_file/list_dir/search_files/edit_file/write_file/load_skill, implemented with GLib/Gio (no subprocess; only search_files spawns grep, fixed argv, never a shell). Deliberate exception to the IPC rule: MCP clients bring their own file tools, and file contents through the IPC socket would put blocking I/O on the shell's main loop. Two frontiers in the daemon — READ = prefix roots (~/.config/{nidara,uwsm,hypr}, /usr/share/nidara, the shell log), WRITE = an EXACT 3-file allowlist. Gated by allowFileRead (default ON) / allowFileWrite (default OFF; write implies read). Paths are canonicalised before the prefix check; writes refuse symlinks and refuse to touch the @autostart block; write_file refuses a file not read this session; every write commits to a git repo auto-created in ~/.config/nidara (baseline BEFORE the first write — see references/state-and-ipc.md)
nidara-mcp                        # all of the above as MCP tools over stdio (incl. list_windows/list_workspaces (reads), focus_window (ungated WM op), query_app → nidara-a11y, do_app_action → nidara-act, type_text/press_key → nidara-type, click_app/click_at (left + button:"right") / hover_app/hover_at / scroll_app/scroll_at / drag_app/drag_at → nidara-click; WM action verbs via run_action; .mcp.json: repo root for dev; installer-managed copy in ~/.config/nidara/ for users)
```

There is no test runner; **nine CI jobs** stand in for one (`.github/workflows/ci.yml`, every
one with a `timeout-minutes`):

| job | gates |
|---|---|
| `styles` | the SCSS of the shell, the greeter/lock sheet and the installer compiles — **and every bundle defines the `--nidara-*` tokens its rules paint with** (`token-contract-check.mjs`; an undefined custom property is silently dropped by GTK4, never an error) |
| `typecheck` | `tsc --noEmit`, against a compressed `@girs/` snapshot pulled from the repo's `ci-assets` release (`@girs/` itself stays git-ignored, ≈58 MB generated; a maintainer refreshes the snapshot when it goes stale) |
| `widgets-gen` | the generated widget registry matches `widgets/` |
| `smoke` | **a real headless boot** — official Arch packages in a container, build both C libraries (`libnidara-wl`, `libnidara-auth` + its eight signals), bundle the shell, boot it on real Hyprland over a virtual display (kernel vkms + llvmpipe); fails on death, silent IPC or JS errors, and uploads screenshots as artifacts |
| `i18n` | translation parity + the ledger (`scripts/ci/i18n-check.mjs --check`) — see `dev-workflow.md` |
| `skill-docs` | three prose/consistency checks: no repeated headings anywhere under `.claude/skills` (a duplicated section is how a reference comes to contradict itself), `wrapping-prose-check` (a wrapping `GtkLabel` must FILL its column — documented, then violated six times, because the failure only appears in someone else's locale), `same-app-check` (the four `bin/nidara-{a11y,act,click,type}` copies of `sameApp`/`nameTokens` must not drift from `core/app-search.ts`, or perception and action disagree about what an app is called) |
| `pkgbuild` | `bash -n` on the PKGBUILD + `depends=()` still sources as an array of ≥40 (v0.6.0 shipped with an unquoted `hyprland>=0.56` that bash read as a redirection and silently truncated the array) |
| `hypr-config` | `luac -p config/hypr/hyprland.lua` (one syntax error = the session boots with NO Nidara config at all) + the game-mode handlers driven against a stubbed `hl` |
| `agent-loop` | drives `bin/nidara-agent` against a mock provider (`scripts/ci/agent-loop-test.py`) |

⚠️ A REQUIRED check skipped by a path filter never reports, and that **stalls the merge queue** —
skip the *work* inside a job, never the job. Details in `references/dev-workflow.md`.

## When in doubt

- The codebase is intentionally **pure GTK4 + Cairo** for anything custom-painted (Dock, Bar, dots, rings, schematic) and **GTK + custom CSS** for floating overlays. **libadwaita has been fully removed** — windows are `Gtk.Window`, `Adw.AlertDialog` → `showNidaraAlert`, `Adw.Clamp` → `NidaraClamp`, and dark/light is driven by `Gtk.Settings.gtk_application_prefer_dark_theme` (no `Adw.init()`). Don't reintroduce any `Adw.*`. See `references/design-system.md`.
- The state model is **one central GObject (`Status.ts`)** with mutually-exclusive overlay setters. Subscribe via `notify::prop`. See `references/state-and-ipc.md`.
- The dock H/V split is **already deduplicated**: `DockHorizontal.tsx` and `DockVertical.tsx` are 7-line wrappers; shared logic lives in `DockCore.tsx` with axis differences isolated in `DockAxis.ts`. Edit those, not the wrappers — see `references/tech-debt.md`.
- Dock springs integrate via `stepSpring` in `DockPhysics.ts`, which **substeps internally (≤1/60 s per substep)**. Never integrate a spring with a raw frame `dt`: semi-implicit Euler diverges when `damping·dt > 2`, and the frame clock can stall/fall back to ~60 Hz (e.g. a fullscreen window occludes the dock) pushing `dt` to the `MAX_DT` clamp — that exact combination exploded the auto-hide slide to 1e+68 px (2026-07-18). Stability comes from the substep, not from `MAX_DT`.
- Sliders are **one component**: `makeSlider` (Cairo) in `ui/lib/nidara-kit/slider.ts` — horizontal or vertical, optional thumb, custom non-warp input. There is no native `Gtk.Scale`. It lives in the KIT, so it gets its accent and its surface mode from the **appearance seam** (`nidara-kit/appearance.ts`) that each bundle registers once in `app.ts` — never by importing `ThemeManager`. See `references/design-system.md`.

## Keep this skill current (part of "done", not a follow-up)

This skill is only useful if it matches reality. **When a change introduces or alters
something that needs explanation** — a new mechanism, a non-obvious pattern, a "why is it
done this way", a new shared component, or a gotcha that bit you — **update the skill in the
same change**:

- Put the *how/why* in the right `references/` file (architecture / design-system /
  state-and-ipc / dev-workflow), not just in the commit message. If a contributor's agent
  would need it to work correctly, it belongs here.
- Keep `references/tech-debt.md` honest: **add new debt or deferred work** you created or
  found, and when you resolve an item **move its body to `references/tech-debt-resolved.md`**,
  keeping its number and leaving its line in the live file's index. Do not renumber, and do not
  delete outright — several resolved items still carry a rule that binds. The live file must
  read as what is still owed.
- Fix any statement in `SKILL.md`/references that your change made wrong.

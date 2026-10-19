---
name: nidara
description: "Authoritative reference for working on the Nidara desktop environment codebase — a full Wayland session for Arch Linux built with TypeScript/TSX → GJS on GTK4 + Hyprland (no AGS, no Astal). Use this skill whenever the user mentions Nidara, nidara-project, the shell bar, dock, control center, notification center, prism/search, app grid, overview, system menu, settings window, lockscreen, or greeter; asks to edit files under `ui/shell/`, `ui/greeter/`, `ui/lockscreen/`, or `ui/lib/nidara-kit/`; wants to modify `hyprland.lua`, SCSS in `styles/`, a `core/` service, or run `install.sh`. Also trigger on questions about reloading the UI (Super+Shift+R), `nidara-ipc` IPC, `Status.ts`, the five build bundles, or the Nidara design system. ALWAYS consult this skill BEFORE editing files in this repo — strict conventions (no `Adw.OverlaySplitView`, no transform scale on clickables, no hardcoded colors, scoped CSS only, IPC via `ShellActions` not `globalThis`) are easy to violate without it."
---

# Nidara

> Repo: `github.com/nidara-project/nidara-desktop` · License: GPL-3.0-or-later, except `ui/lib/nidara-kit/` = LGPL-3.0-or-later (every kit file carries the SPDX line; CI checks it) · Version: read `VERSION` at the repo root (do not restate it here — this line said 0.1.0 while the file said 0.7.2).

## What this project is

Nidara is a **full Wayland desktop environment** for Arch Linux — not a theme, not a set of scripts. It registers as a proper Wayland session (like GNOME/KDE) and is launched by the display manager. The compositor is **Hyprland**; the UI is **TypeScript → GJS** on **GTK4 + gtk4-layer-shell** (libadwaita fully removed), hosted by **our own `Gtk.Application` in `ui/lib/nidara-kit/platform/host.ts`** and bundled by **our own `scripts/bundle.sh`** (esbuild), styled with **SCSS** and painted with **Cairo** where shapes get custom (dock squircles, workspace dots, resource rings, schematic).

⚠️ **The compositor is changing: Hyprland → Hyalo** (owner's decision, 2026-10-01). Hyalo is
Nidara's own Wayland compositor, on Smithay (Rust), in `hyalo/`. The plan, with the parity table,
is issue #680; the evidence, #679. 🔑 **Since 2026-10-02 Hyprland is FROZEN and Hyalo is the only
target** (owner's decision): no new work on Hyprland, fixes included, and a change no longer has to
work on both compositors — the one floor until the switch (#685) is that the shell still BOOTS on
Hyprland, because that is what 0.13 ships. Work follows #680's WAVES (safe and usable daily →
what the switch lost → the system → the switch), and Hyalo is built for this desktop alone: where
the desktop was shaped around a Hyprland limit, #708 decides the structural change. Anything that
talks to the compositor still goes through `CompositorState`. Released packages run Hyprland until
#685, and much of this skill still describes it.

⚠️ **AGS is GONE, entirely, since 2026-08-18** — runtime first (`ui/lib/{host,process,file,app-id}.ts` replaced its four modules), toolchain the same day:

| was | is | what it actually was |
|---|---|---|
| `ags bundle` | `scripts/bundle.sh` | esbuild with a fixed flag set (the JS API, `scripts/bundle.mjs`, since #108 phase 3) + a bash wrapper around the JS. `--kit-external=<dir>` makes the app LOAD nidara-kit from `<dir>` instead of bundling it — the shell, greeter and lock ship that way (`architecture.md` → "The kit's CODE is loaded, not bundled") |
| `ags run` | `scripts/run.sh` | the same bundle; shell uses its native libgjs host, other entries use `gjs` |
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

The aesthetic is "Nidara literal": heavy-blur glass capsules with a 1px inner white edge, soft outer shadow, top sheen; the accent color is used **only for active/selected state** — with one exception, MENUS: the shell's menus and every dropdown's list, whose row under the pointer is filled with it (design-system.md → "Context menus").

It is also **AI-native by design**: this skill ships *inside* the repo so that any user's agent — whichever it is: `AGENTS.md` is every agent's entry, `CLAUDE.md` only imports it, and `.agents/skills/nidara` is a symlink here; edit only `.claude/skills/nidara/` — can extend, customize, and fix their own desktop — and propose globally-useful improvements back upstream. If you're helping a user with their installed copy rather than the project itself, start at `references/agent-contribution.md`.

## The repo is FIVE separate bundles, not one app

This is the single most important fact to internalize before touching anything:

| Bundle | Source | Output binary | Role |
|---|---|---|---|
| **Shell** | `ui/shell/` | `build/nidara` | Desktop: bar, dock, overlays |
| **Settings** | `ui/settings/` | `build/nidara-settings` | Independent settings application (#571) |
| **Greeter** | `ui/greeter/` | `build/nidara-greeter` | Login (greetd, spoken directly — no AstalGreet) |
| **Lockscreen** | `ui/lockscreen/` | `build/nidara-lock` | Lock via `Gtk4SessionLock` (OVERLAY-layer fallback) |
| **Installer** | `ui/installer/` | `build/nidara-installer` | The live medium's installer — a GTK4 front-end over `archinstall` |

Each has its own `app.ts`, its own `package.json`, its own `scripts/bundle.sh` invocation. Code shared between the greeter and the lockscreen is currently duplicated (see `references/tech-debt.md`).

⚠️ **The installer does not ship with the desktop.** `packaging/nidara/PKGBUILD` is a SPLIT
package (since 2026-08-25): it builds `nidara-desktop`, `nidara-kit` (the platform library the
desktop depends on and outside apps can too — since 2026-09-23, `architecture.md` → "The kit's own
package") and `nidara-installer`, and only nidara-iso's `packages.x86_64` ever names the last — a
system somebody is using must not carry a program whose job is to erase a disk. Two consequences
that bite silently:

- anything picking "the package makepkg just built" has to say WHICH. `install.sh` installs
  `nidara-desktop` + `nidara-kit` by name, in one `pacman -U`; nidara-repo's `build-repo.sh` copies
  every package produced instead of the newest one. The old `ls -t … | head -1` would have
  installed an installer onto somebody's Arch.
- `install=` and `backup=` live INSIDE `package_nidara-desktop()`. At the top level of a split PKGBUILD
  they apply to every package.

The installer is a bundle of the desktop's toolkit, but **what it installs is not in this repo**:
its base archinstall config is airootfs content in nidara-iso
(`/usr/share/nidara-installer/base.json`), so the product's package list changes without
rebuilding anything here. `nidara-iso/INSTALLER.md` is the decision record — including why it is
not Calamares.

⚠️ **archinstall owns the disk, in both modes.** Between 2026-08-28 and 2026-09-04 `steps/run.ts`
ran `sgdisk`/`mkfs.*`/`mount` itself; #310 gave partitioning back, and `lib/disk-config.ts` now
only EMITS the `disk_config` archinstall carries out. What the bundle still writes itself is the
boot side, after archinstall: `lib/bootloader.ts` edits the loader entries, the kernel cmdline
and the mkinitcpio hook. Read `references/dev-workflow.md` → "Who owns the disk — archinstall, in
both modes" and "The installer runs in a VM, or it does not run" (the arming rule) before
touching either file.

⚠️ **Every refusal belongs on the page that asked, never on the run page.** `assemblePlan` is
first called after Install is pressed, so a rule that lives only there refuses a disk the person
already confirmed erasing. The size floor was that bug until 2026-09-17: the disk page now asks
`entireDiskFits` (and `manualProblems` holds a manual `/` to the same `MIN_ROOT_MIB`), and the
throw inside `entireDiskConfig` is the last word, not the first.

## The eleven inviolable commandments

These are non-negotiable. Violating them produces bugs that are hard to debug because the symptoms don't point at the cause.

1. **Never use `Adw.OverlaySplitView` in Settings** — use `NidaraSplitView` from `ui/lib/nidara-kit/`. Adw's version breaks capsule margins.
2. **Never write unscoped global CSS** — a surface's CSS goes inside its window's selector
   (`#nidara-bar, .nidara-bar-window` — every panel, island and app grid included / `#nidara-dock …` /
   `window.nidara-settings-window`). The design system's global layer is the sole exception:
   `_base.scss` tokens, the TWO `_components.scss` (`ui/lib/nidara-kit/styles/` = the kit's, shared with the
   other bundles; `ui/shell/styles/` = the shell's half), `_reset.scss`, `@keyframes`. Scope table and
   the two traps in `references/design-system.md`.
3. **Kill zombies before debugging.** A stuck terminal or "styles won't refresh" almost always means a zombie GJS is still drawing the dead UI. Run `killall nidara-shell` before changing code in a loop.
4. **`core/` never touches the UI.** All visibility changes flow through `Status.ts`. Widgets never flip each other directly.
5. **Every panel lives inside the Bar's window** via `Gtk.Overlay` — the Control Center, the Notification Center, Prism, the system menu, the Activity Island (capsule, chips AND every mode) and the app grid. **No exceptions** since #708 point 3 (owner, 2026-10-06: the bar is the one surface every panel hangs from; the dock stays a surface of its own). Show/hide animations are GTK-side (`common/ScaleRevealer.ts`, `common/MorphRevealer.ts`); on Hyalo the compositor paints their glass from the shapes they declare.
   - **Why one surface.** Hyalo draws each surface's glass on its own, under ALL of that surface's content, so pieces can only melt into one silhouette (capsule ↔ panel morphs, fusion, #705) within one surface — and a panel on its own surface over the bar would be glass on glass, which the reference material avoids.
   - **The rule that replaces the island's old reason** (it had a layer of its own so its modes could blur the bar's capsules under them): a panel that grows over the bar's row takes the groups it covers OUT of the way — they fade with the capsule's content (`MorphRevealer` companions, `ActivityIsland` → `coveredBy`). Never stack glass on glass. Today only the overview is that wide.
   - **The app grid's old reason** (Hyprland charging a layer's blur by its BOX) does not exist on Hyalo, which charges per declared shape. Over a fullscreen window the grid still opens: the bar's surface rises to OVERLAY for as long as it is up, with the row hidden (`liftForGrid` in `Bar.tsx`).
   - A further surface of its own needs a reason of this kind, decided with the owner — not convenience. The agent pointer (a click-through cursor overlay, not a panel) is the one other shell layer. See `architecture.md`.
6. **IPC goes through `nidara-ipc` + `core/ShellActions`** — never reintroduce `globalThis` coupling.
7. **A window that is an APPLICATION window declares its own app-id.** Nidara's regular windows (Settings, About, Settings' modal dialogs) call `setWindowAppId(win, "nidara-settings")` from `ui/lib/nidara-kit/platform/app-id.ts` — or pass `appId` to `NidaraWindow` — so Hyprland files them under a name the desktop registry actually has. Do NOT go back to remapping a class in `AppService`: that remap existed only because AGS forced the app-id to `io.Astal.ags`, and it is deleted. Two silent traps live in `app-id.ts` (the `GdkWayland` import, and `map` vs `realize`) — read its header before touching it. *(This commandment used to say the opposite; the AGS host went on 2026-08-18.)*
8. **`AboutWindow` is create+destroy, not hide. Settings exits on close** since #571: it is a separate application, relaunched on demand. Its page cache lives only while it is open.
9. **No CSS `transform: scale` or `transform: translate` on clickable widgets.** GTK respects them but they break hit-testing. Use `margin`, scale in Cairo, or `common/ScaleRevealer.ts` for transient show/hide grow animations (snapshot-time, ends at identity — see `references/design-system.md`).
10. **No hardcoded colors. No emoji as iconography.** Resolve against `--nidara-*` tokens; use SVGs in `assets/nidara/assets/scalable/` or the `nd-*-symbolic` icon set — interface icons are asked for ONLY by `nd-` names of the Nidara icon spec (`ui/shell/assets/icons/nidara/SPEC.md`), never by freedesktop names; those are for APP icons.

11. **We use GTK, with OUR styles. Nothing by default.** (Owner's decision, 2026-09-20 —
    tech-debt #107, a STANDING DECISION.) A GTK widget that enters this codebase arrives WITH its
    rules in one of our stylesheets, or it does not ship. The old habit — drop the widget in, see
    GTK's default, patch it afterwards — is what produced a toggle that looked like Nidara in the
    shell and like GNOME in the installer, and a "blank theme" hack to paper over the difference.
    Our own processes run on **no GTK theme at all** — `GTK_THEME=Empty`, which GTK itself ships in
    its gresource, selected through `useNoGtkTheme()` in `ui/lib/nidara-kit/platform/gtk-theme.ts` — so whatever our
    CSS does not draw is drawn by nothing. Never name a theme instead: one that resolves to nothing
    loads GTK's FULL built-in theme, silently (measured).
    🔴 **And it must never reach a CHILD.** `GTK_THEME` is inherited, and GTK re-reads it at
    every theme update, so it cannot be unset once we are up (measured: unset it, flip dark
    mode, and the shell loads Adwaita). Until 2026-09-27 every app the dock, the app grid or
    Prism launched therefore came up with NO theme. Every child process starts through
    `spawn()` in `ui/lib/process.ts` (`exec`/`execAsync` use it), which leaves it behind;
    `scripts/ci/child-env-check.mjs` fails on any other way of starting one in the desktop
    bundles (`Gio.Subprocess.new`, `GLib.spawn_*`, `Gio.AppInfo.launch*`…).
    ✅ **The original four bundles are there since 2026-09-23** — the shell was the last (tech-debt #107
    step 5). What is under a node none of our classes reach is the **base layer**,
    `ui/lib/nidara-kit/styles/_base-layer.scss`: GTK's own GEOMETRY for each node (read out of libgtk's
    gresource) with OUR paint. Copy GTK's box, never invent one — shell widgets that declare
    colours but not padding had been taking their box from the theme, and a base `button` with
    10px more padding truncated a Control Center label. Read the file's header before adding a rule.
    ⚠️ This is about OUR processes. Third-party applications keep following gsettings
    `gtk-theme`, a different lever entirely. **And the other half of the same decision, taken the
    same day: a Nidara APPLICATION is never reskinned by a foreign GTK theme either.** `nidara-kit`
    is the platform library — what libadwaita is to a GNOME app — so Settings, the installer and any
    app we publish outside this repo carry our look as a dependency, and the user's customisation
    axis is the appearance portal (accent, colour scheme, contrast, font), which reaches ours AND
    everybody else's apps. A Nidara GTK theme for THEIR apps is a separate artefact we do intend to
    ship, and its body is the base layer of tech-debt #107. The lever table — who moves what, and how
    far it reaches — is canonical in `references/design-system.md` ("Who may change each layer").
    `scripts/ci/style-ownership-check.mjs` is the gate.

## Quick orientation: where to start

Before doing anything that touches code:

- **Writing or changing a WIDGET** (a bar pill / CC tile) → `references/writing-a-widget.md` is the
  whole thing on one page: the file, the vocabulary, and the boundary CI enforces.
- **Working on independent Settings** → `references/architecture.md` → "Settings is its own application" (process role, portal paint, IPC, rollback). Start it with `bin/nidara-settings`, not a bare `gjs` invocation.
- **Editing TSX widgets, adding overlays, changing dock/bar/CC behaviour** → read `references/architecture.md` first, then `references/state-and-ipc.md`.
- **Editing SCSS, restyling anything, working on the design tokens** → read `references/design-system.md`.
- **Adding a new core service or modifying state** → read `references/architecture.md` (core/ section) and `references/state-and-ipc.md` (Status.ts).
- **Working on the installer, build, or session boot** → read `references/dev-workflow.md`.
- **Touching the Assistant** (`bin/nidara-agent`, a wire lane, or what it can perceive) → read `references/dev-workflow.md`: the fake-brain walk, the wire-lane re-sync procedure, and the terminal bench for perception claims (a model that answers from a stale read looks identical in the island — only the log tells you).
- **Debugging something weird, or considering a refactor** → check `references/tech-debt.md` first — it might already be a known issue, or a **standing decision** telling you not to do what you were about to do. It holds only what is still owed; the bodies of resolved items live beside it in `references/tech-debt-resolved.md` (same numbers, never reused, indexed at the bottom of the live file).
- **Working on Hyalo** (`hyalo/`, the compositor of our own — a preview session until #685),
  or on anything in the shell that must work on BOTH compositors → `references/hyalo.md`.
- **Adding an event a user's scripts can react to, or asked "can I run something when X happens?"** → `references/user-hooks.md`. The event table lives in `bin/nidara-hook` and nowhere else.
- **Helping a user customize their OWN installed copy** (not the canonical repo) → read `references/agent-contribution.md` FIRST. It tells you whether a change is personal (→ config layer), should become a Setting, or is a global improvement worth proposing back upstream as a PR.

The references are short and load-on-demand. Don't try to hold the whole project in context; read the specific reference you need.

## The dev loop in one screen

```bash
./install.sh --dev                       # one-time setup: system binaries + ~/.config/nidara/.dev
# ... edit TSX/SCSS in ui/shell/ ...
# In a graphical session:
Super+Shift+R                            # reload the UI (re-runs nidara-ui → scripts/run.sh)
# ⚠️ run.sh re-bundles the TS but does NOT compile SCSS: after a .scss edit, first
#    cd ui/shell && npx sass --no-charset style.scss style.css && sed -i '/@charset/d' style.css
#    (else the reload paints the OLD style.css and the change "did nothing" — owner-caught 2026-09-25)
tail -f "$XDG_RUNTIME_DIR/nidara-ui.log"  # logs (per-user; falls back to /tmp)
killall nidara-shell                              # nuke stuck old UI when reload misbehaves
cd ui/shell && npm run typecheck        # local typecheck (needs the git-ignored @girs/)
cd ui/shell && npm run build            # SCSS compile + scripts/bundle.sh (needs the `esbuild` package)
nidara-ipc listActions                  # discover the shell's IPC surface (JSON)
nidara-ipc dumpState                    # live shell state as JSON (overlays, version, effective compositor layout `compositorLayout`…)
nidara-ipc describeConfig               # agent-facing settings: schema + current values (JSON)
nidara-ipc setConfig <key> <value>      # change a setting officially (validated; gated by Settings → AI)
nidara-ipc screenshot [path]            # capture the focused monitor → PNG path (visual verification; gated)
nidara-a11y [app]                       # computer-use perception: a THIRD-PARTY app's UI via AT-SPI, same shape as queryUI (read-only; gated by allowComputerUse, default OFF)
nidara-act <app> <node> <action>        # computer-use action: invoke a named AT-SPI action on a named control (deterministic, no synthetic input; gated by allowComputerControl, default OFF, requires perception)
nidara-type text|key <app> <payload>    # computer-use synthetic keyboard via wtype (focus-verified: <app> must be the active window); same allowComputerControl gate. Focus the WINDOW with focusWindow — NOT with nidara-act … SetFocus (a control-level action GTK4 mostly does not expose; a refusal hands back the target's address in `focus`). A number goes in with nidara-act … set-value=N, no keyboard at all
nidara-click <mode> <app> …            # computer-use synthetic POINTER. EVERY verb has both forms — *-app names an AT-SPI node, *-at takes a window-relative point: app/at = left-click; rclick-app/rclick-at = right-click; hover-app/hover-at = pointer move, NO button; scroll-app/scroll-at = wheel scroll (signed dx/dy notches); drag-app/drag-at = press→glide→release between two nodes / two points (DnD / rubber-band / sliders). nidara-input.c (zwlr_virtual_pointer, compiled by install.sh) is the injector; the CLI mode is the wrapper's vocabulary and MODES[mode].action the injector's (hover-* → the C verb `move`). Focus-verified; same gate. HOVER is not a lesser click: it is the only way to reach state that does not exist until the pointer is there (tooltips, hover-revealed controls, submenus) — read the a11y tree AFTER hovering. Every action plays the fake-AI-cursor visual (accent arrow + AI badge, `agentPointer` IPC, land→confirm; a hover lingers and does NOT ripple — it pressed nothing) and ABORTS if the user moves the mouse >10 px or the kill switch fires during the animation — the user always wins; the visual is an enhancement, never a gate (shell down = silent no-op)
nidara-ipc listWindows                  # window/workspace mgmt (UNGATED — shell driving its own compositor, not computer-use): open windows as JSON [{address,class,title,workspace,floating,…}]
nidara-ipc listWorkspaces               # workspaces as JSON [{id,name,windows,active,special}]; focusWorkspace <id|±1|name>/focusDirection <l|r|u|d>/focusWindow/closeWindow/moveWindowToWorkspace/getWorkspaceMode <id>/setWorkspaceMode <id> <floating|tiling>/toggleWorkspaceMode [id]/toggleFloat|Fullscreen/…/setLayout act on them (window arg = address from listWindows OR class/title); each = one HyprlandState dispatch method. movewindow-directional + resize deliberately NOT added (active-window-only/focus-dependent + unverified Lua)
nidara-ipc focusWindow <window>         # raise/focus a window by address or class — a WM op (UNGATED, like a dock click); also the precondition for the synthetic keyboard (which stays gated)
nidara-ipc disableComputerControl       # kill switch: revoke AI control instantly (also: click the bar indicator, or Super+Shift+Esc)
nidara-hook --list                # the desktop events a user's own scripts can react to, and what each passes (~/.config/nidara/hooks/<event>.d/*). `nidara-hook <event> [args]` fires one by hand — that is how a hook gets tested. The table in bin/nidara-hook is the ONLY list; CI checks it against the call sites
nidara-doctor                     # Markdown diagnostic report (bug/PR evidence)
nidara-doctor --log               # the shell log's CRITICAL/WARNINGs since the shell last started, one line per KIND with its count — read this after a reload, not a tail (a tail shows what fired last, a count shows what is broken). In dev mode you are also TOLD: a CRITICAL in the shell log raises a critical notification (`core/DevLogWatch.ts`)
nidara-agent                      # the built-in Assistant's BRAIN: a BYOK LLM tool-use loop (Anthropic Messages / OpenAI-compatible via curl-SSE) whose desktop tools ARE `nidara-ipc` — so for those the assistant is just another client of the gated surface. A stdio child of the shell (spawned by core/AgentService; the island Agent mode / Super+A is its face), NOT run by hand; API key in the DE keyring (libsecret schema org.nidara.Assistant), brain config in GSettings org.nidara.ai (brain-backend/brain-model/brain-endpoint). Test with scripts/dev/fake-brain.py
                                  # ALSO reaches THIRD-PARTY apps through the same four computer-use helpers as nidara-mcp, with the same tool names — but only while the matching gate is on (`query_app` behind allowComputerUse; the ten action tools behind allowComputerControl), because the schemas cost ~2.2k tokens per step and a model told about a tool it cannot use promises what it cannot deliver. Gate re-read at the TURN boundary (grants mid-conversation take effect); a helper refusal is reported as a FAILED tool result, not an "ok" containing an error
                                  # ALSO owns a DAEMON-LOCAL file layer ("tier 1", 2026-07-27) that does NOT go through `nidara-ipc` — read_file/list_dir/search_files/edit_file/write_file/load_skill, implemented with GLib/Gio (no subprocess; only search_files spawns grep, fixed argv, never a shell). Deliberate exception to the IPC rule: MCP clients bring their own file tools, and file contents through the IPC socket would put blocking I/O on the shell's main loop. Two frontiers in the daemon — READ = prefix roots (~/.config/{nidara,uwsm,hypr}, /usr/share/nidara, the shell log), WRITE = an EXACT 3-file allowlist. Gated by allowFileRead (default ON) / allowFileWrite (default OFF; write implies read). Paths are canonicalised before the prefix check; writes refuse symlinks and refuse to touch the @autostart block; write_file refuses a file not read this session; every write commits to a git repo auto-created in ~/.config/nidara (baseline BEFORE the first write — see references/state-and-ipc.md)
nidara-mcp                        # all of the above as MCP tools over stdio (incl. list_windows/list_workspaces (reads), focus_window (ungated WM op), query_app → nidara-a11y, do_app_action → nidara-act, type_text/press_key → nidara-type, click_app/click_at (left + button:"right") / hover_app/hover_at / scroll_app/scroll_at / drag_app/drag_at → nidara-click; WM action verbs via run_action; .mcp.json: repo root for dev; installer-managed copy in ~/.config/nidara/ for users)
```

The CI jobs stand in for a test runner (`.github/workflows/ci.yml`, every
one with a `timeout-minutes`):

| job | gates |
|---|---|
| `styles` | the SCSS of the shell, Settings, the greeter/lock sheet, the installer and the kit's own sheet (`kit.scss` → `kit.css`, loaded at runtime by the others: #108) compiles — **and the token contract holds in BOTH directions**: every bundle defines the `--nidara-*` its rules paint with (`token-contract-check.mjs`; an undefined custom property is silently dropped by GTK4, never an error), every token a bundle defines is read by something (`token-orphan-check.mjs`, with a control — an orphan is a value that drifts from the one on screen, which is how `--nidara-edge` was retuned in #600 and changed no pixel: tech-debt #106), and **the kit draws what the kit builds** (`style-ownership-check.mjs`, two controls — a kit component styled only in `ui/shell/styles/` is INVISIBLE in every other bundle, because those bundles load no GTK theme at all: tech-debt #59, commandment 11). **And the client-painted glass's model holds its numbers** (`scripts/dev/glass-legibility-probe.ts`, with a control that moves a tooltip floor — the least glass whose text reads 4.5:1 over any backdrop) |
| `typecheck` | `tsc --noEmit` over all five bundles (installer, greeter and lock in full since 2026-09-22 — their one shim is `ui/lib/nidara-kit/gi-cairo.d.ts`, which must be FIRST in `include` or it is silently ignored), against a compressed `@girs/` snapshot pulled from the repo's `ci-assets` release (`@girs/` itself stays git-ignored, ≈58 MB generated; a maintainer refreshes the snapshot when it goes stale) |
| `widgets-gen` | the generated widget registry matches `widgets/` — **and the widget boundary holds**: `widgets/` imports nothing from `surfaces/`, and `common/widget-kit/` stays a leaf. Neither is a compile error (28 widget→surface imports type-checked on 2026-09-01) and the second one crashes the shell at BOOT, which `tsc` cannot see. **Also the Settings import closure** (`settings-closure-check.mjs`, #571): what Settings.tsx reaches transitively may not include another surface, a widget or a shell-only module beyond a shrink-only allowlist. **And the kit is a package** (`kit-boundary-check.mjs`, #108): nothing under `ui/lib/nidara-kit/` imports from outside it — an app outside this repo has the kit and nothing else. **And a child process never inherits our `GTK_THEME=Empty`** (`child-env-check.mjs`, with a control: every process starts through `spawn()`, commandment 11) |
| `smoke` | **a real headless boot** — official Arch packages in a container, build both C libraries (`libnidara-wl`, `libnidara-auth` + its eight signals), bundle the shell, boot it on real Hyprland over a virtual display (kernel vkms + llvmpipe); fails on death, silent IPC, JS errors or **a toolkit CRITICAL** (Gtk/Gdk/Gsk/GLib/Gjs — a failed assertion is a bug that draws nothing wrong on the spot; only a missing accessibility bus is exempt, that is the container), prints the grouped warning summary every run, and uploads screenshots as artifacts |
| `i18n` | translation parity + the ledger (`scripts/ci/i18n-check.mjs --check`) — see `dev-workflow.md` — **and the export the native Settings reads** — its tokens too: `scripts/export-tokens.mjs` (styles job) runs the token ENGINE itself over all 72 inputs (accent × mode × reduce/window transparency) over `_base.scss` COMPILED, plus `_tokens.scss`'s variables (`meta.module-variables`) and `tokens.ts`'s data; a `gi://` stub loader runs the frozen kit untouched; `settings-tokens-check.py` requires every `var(--nidara-*)` of the Settings/kit sheets in every set; and `tokens/glass.json`, the kit's glass material ASKED through its own source (`registerGlassMaterial` with a stub host; `./material` and `gi://GLib`/`Gtk` stubbed in the loader): tone/ink/shadow by pane side as steps, per dark/light × reduce transparency (a dropped-`panel` copy must fail) — (`scripts/export-settings-data.mjs` → `build/settings-data/{manifest.json,i18n/*.json}`, from the same `manifest.ts`/`locales/*.ts`; `settings-data-check.py` compares it with a pattern reading of the sources, and a dropped-key copy must fail). Locales stay `.ts`: edit them as always, never the JSON |
| `skill-docs` | seven prose/consistency checks: no repeated headings anywhere under `.claude/skills` (a duplicated section is how a reference comes to contradict itself) — and ONE copy of the skill: `.agents/skills/nidara` must be a symlink to it, `AGENTS.md` must exist and `CLAUDE.md` must only import it (`@AGENTS.md`), so every agent, Claude Code or not, starts from the same text (until 2026-10-12 another agent read a hand-made copy weeks behind); `wrapping-prose-check` (a wrapping `GtkLabel` must FILL its column — documented, then violated six times, because the failure only appears in someone else's locale), `same-app-check` (the four `bin/nidara-{a11y,act,click,type}` copies of `sameApp`/`nameTokens` must not drift from `core/app-search.ts`, or perception and action disagree about what an app is called), `blur-threshold-check`, `chrome-scope-check`, `hook-events-check` (the user-hook event table in `bin/nidara-hook` and the `fireHook(…)` call sites must be the same set — an event fired but undeclared is refused by the runner, one declared but never fired is a directory that can only stay empty), and `icon-registry-check` (every name in `core/Icons.ts` is an `nd-` name with its shipped drawing, no drawing is orphaned, and `ui/shell/assets/icons/nidara/SPEC.md` — the Nidara icon spec theme authors build against — lists exactly those names at the same spec version as the code and the theme generator; a missing glyph is never an error, just a hole on screen) |
| `pkgbuild` | `bash -n` on the PKGBUILD + `depends=()` still sources as an array of ≥40 (v0.6.0 shipped with an unquoted `hyprland>=0.56` that bash read as a redirection and silently truncated the array) + **config migrations are valid bash, no-op on a fresh install and idempotent with the marker cleared** (`migrations-check.mjs`; a migration mutates a user's config once, on a machine nobody can inspect afterwards) |
| `hypr-config` | `luac -p config/hypr/hyprland.lua` (one syntax error = the session boots with NO Nidara config at all) + **game mode's session is undone** (`scripts/dev/game-session-probe.ts` drives `core/game-session-logic.ts` against a fake world, with a control) + **every window rule names something the source declares** — Hyprland's and Hyalo's (`hypr-rule-check.mjs`: a rule is a string matched against a string a GTK window announces, and our windows change class at MAP — a STATIC effect sees only the birth class, a DYNAMIC one only the current one, and both traps are silent) + **the Lua the shell GENERATES parses** (`hypr-lua-check.mjs`: `nidara-settings.lua` and `nidara-monitor.lua` are built from TypeScript strings, so `tsc` sees a string and `luac` never sees what it produced — and `hyprland.lua` requires both at every login) |
| `sessiond` | `session/`: locked Rust build, clippy `-D warnings`, unit tests and a private D-Bus integration with the real GJS notification client. A prior step disables `replaces_id` adoption and requires the integration to catch it. Tests history compatibility, sender signals/timers/actions, images, and shell/daemon restart without banner replay. |
| `toolkit` | `toolkit/`: font preflight (`fc-match` must not substitute a required family), locked build and clippy `-D warnings` for the whole workspace, then nk-text's corpus on Parley and nk-render's pixel tests. Two prior steps break a rule and require it caught: backspace by scalar (`combining-marks`, `scripts/ci/nk-text-control.py`) and a renderer that drops glyph runs (`scripts/ci/nk-render-control.py`). The window itself is checked in the `hyalo` job (`scripts/ci/nk-phase0-check.py`: mapped, committed glass, virtual keyboard, preedit, clipboard, at scale 1 and 1.25, each with its control). **Not required** yet |
| `agent-loop` | drives `bin/nidara-agent` against a mock provider (`scripts/ci/agent-loop-test.py`) |
| `hyalo` | Hyalo (`hyalo/`, the compositor of our own): clippy `-D warnings` and unit tests, then **the package** — `packaging/nidara/PKGBUILD` built by `makepkg -e` in the checkout and installed with `pacman -U` (desktop, kit, Hyalo) — and a boot of its tty backend (DRM/KMS through seatd) on the same vkms with the INSTALLED shell on it (`nidara-ui`, `XDG_CURRENT_DESKTOP=Nidara`); a file the package lacks fails here, not at release; held to the smoke's log bar; screenshots over Hyalo's IPC. **Not required** while Hyalo is a preview (`scripts/ci/hyalo-smoke.sh`, `references/hyalo.md`). Its Rust build (≈ 6 of its 9 minutes cold) is cached in `hyalo/target`; a PR can only restore its own branch's cache or main's, and `ci.yml` has no push trigger, so `hyalo-cache.yml` warms main's on every push that touches `hyalo/` — it tests nothing |
| `installer-logic` | the installer's rules as pure functions — no disk, no window, no GTK. The `disk_config` it emits and the layouts `manualProblems` must REFUSE (`disk-config-probe.ts`); what the account form accepts and refuses (`account-rules-probe.ts`), whose rules are all that stand between a capitalised username and a `useradd` failure inside the chroot; and what we may touch on an EFI partition that is **not only ours** (`bootloader-rules-probe.ts`) — a shared ESP is the one case whose damage lands on somebody else's operating system, and it is unreachable from this repo. And what the run page COUNTS (`run-progress-probe.ts`), fed lines from a real install — a bar that fell back to the start would read as the install starting over. ⚠️ Each probe is preceded by a step that deletes one of its rules and requires the probe to CATCH it — a probe that has only ever printed "ok" has been run, not tested, and both of these exited 0 while printing `N FAILURE(S)` until 2026-09-05 |

⚠️ A REQUIRED check skipped by a path filter never reports, and that **stalls the merge queue** —
skip the *work* inside a job, never the job. A job skipped by its `if:` DOES report (as a pass),
which is how `scope` (`scripts/ci/ci-scope.sh`, its own self-test first) gates the long jobs:
`code=false` (every changed path a `.md`) skips smoke/hyalo/toolkit/sessiond. `gates=true` runs
the Hyalo job's real fcitx5/Orca matrices (~35 of its ~45 min) ONLY when a changed path is one
they use — `needs_gates()`, a list of what RUNS them: Hyalo's input, focus, a11y, handlers,
shortcuts, binds, control, layers and focus-grab files and its Cargo files; the toolkit (not the
Settings slice); the layers protocol; Hyalo's config; the matrix checks. `full=true` adds their
controls (each assertion re-run with a fault) and scale 1.25 — only when the checks or the test
window's faults change (`needs_full()`; `NK_REAL_FULL=false` → `NK_FCITX5_SCALES=1
NK_REAL_CONTROLS=0`). Until 2026-10-19 `gates` was a SKIP list and almost every Hyalo PR ran
the 35 minutes (owner: "we can't lose an hour on tests that give the same result"). What a skip
lets through, the **nightly** full run on main finds (`schedule`, no base, so everything runs);
`nightly-report` opens/updates the issue "Nightly CI failed", and closes it when green. A file
the matrices start depending on? Add it to `needs_gates()` with a self-test line.

🔑 **The PR budget** (owner, 2026-10-19: "we keep adding tests and have more and more CI
problems"). A PR's CI aims at **15 minutes**. A NEW check goes to the nightly run by default;
it runs on PRs only scoped to the paths it can catch (a `ci-scope.sh` output with self-test
lines), and only if its result does not depend on the runner's speed — CI's GL is software,
and a check that races an animation, a capture or a `gjs` start against the clock fails on a
correct change and teaches everyone to re-run. Such a check is fixed (read the moment from
Hyalo — a capture's `capture.json` says where moving windows were in it) or removed, never
retried. A check's CONTROLS prove it can fail: they belong with the check's own changes and
the nightly run, not every PR. **The checks that watch an animation on screen** — minimize, motion, layer
motion (Hyalo's and the toolkit's) — run only nightly (`HYALO_ANIMATION_CHECKS`, true on
`schedule`/`workflow_dispatch` and in a local run): CI's software GL draws a frame in 2-4 s at
times, and they failed correct PRs for a whole day (owner: "I want to work on the project, not
on the CI"). A PR touching animation is checked locally (the headless cage) and by the night.

⚠️ **`apt-get` in CI only through `scripts/ci/apt.sh install …`.** A bare `apt-get update` waits
forever on a stalled Ubuntu mirror: twice on 2026-10-01 a job sat silent for 45 minutes until
Actions cancelled it, and the merge queue threw the entry out. The script sets apt's network
timeouts, caps each attempt and tries three times. Details in `references/dev-workflow.md`.

## When in doubt

- **The TypeScript kit (`ui/lib/nidara-kit/`) is FROZEN** (owner, 2026-10-15, #818): fixes only, no new components, no new features. Nidara is getting its own toolkit, in Rust, designed together with Hyalo, starting with Settings. Anything added to the TS kit now would only be rewritten. If a task seems to need a new kit component, say so and point at #818 instead of building it here. The kit's design rules (measurements, tokens, the measured glass) stay valid: they are the new kit's specification. The new kit lives in `toolkit/` (its own Cargo workspace); what each of its pieces offers the others is `toolkit/CONTRACT.md`, changed before the code that depends on it. Its text layout is **Parley** (owner, 2026-10-15, after phase 0's corpus against Pango, #824): `toolkit/crates/nk-text`, whose README says why and how to run the corpus. The first native window is `toolkit/phase0` (`nk-phase0`, #826): `nk-render` paints nk-text's glyph runs with `vello_cpu`, `nk-wayland` is the Wayland transport (xdg-shell, shm, seat/xkb, text-input-v3, clipboard, `nidara-material-v1`). `nk-wayland` carries NO look: the app hands it the `Material` (glass, tone, shadow, shapes) with each frame. It is the ONE transport — the Settings slice runs on it too, with its own app-id (`Options`) and the window background of D6 (`Application::window_background`) — and it runs on any compositor (`capabilities()`, PHASE1.md D5: four protocols required, every other one has a fallback, unit-tested; `Options::require_material` for an app that needs Hyalo). Never give an app a Wayland host of its own: add what it lacks to `nk-wayland`. Its README has the owner's live fcitx5 steps; it needs Hyalo (the glass is Hyalo's). Accessibility is `toolkit/crates/nk-a11y`: a semantic tree the app owns (`TextInfo` is plain byte-offset data the app fills from `Editor`/`Layout`; nk-a11y converts to characters and depends on nothing of ours) projected by a **direct AT-SPI provider over zbus** (owner, 2026-10-15, #830 — AccessKit lost the comparison). A password's text is redacted in the tree before the provider sees it. Text extents come from the painted Layout as plain `TextInfo.geometry`; see `references/architecture.md` → "Native toolkit text geometry" for Unicode, coordinate and flat-review rules. The `hyalo` job drives the form through libatspi as Orca would (`scripts/ci/nk-a11y-check.py`, 18 checks each with its control — `active` included: Orca ignores focus inside a window that is not active; and a combo box's value goes through AT-SPI `Selection`, its change through `selection-changed`). Motion is Hyalo's: a layer is a synchronized `wl_subsurface` the app hands over through `nidara-layers-v1` (`Window::create_layer`, `set_position/scale/opacity`, `set_transition`, all landing with ONE parent commit); Hyalo animates it and hit-tests it where it is SEEN, even while the app is blocked (test 5, #831, `scripts/ci/nk-layer-motion-check.py`). A text field inside a layer names its layer for the IME cursor (`set_layer_text_input`): text-input-v3 focus stays on the root, and Hyalo maps the rectangle every frame.
- The codebase is intentionally **pure GTK4 + Cairo** for anything custom-painted (Dock, Bar, dots, rings, schematic) and **GTK + custom CSS** for floating overlays. **libadwaita has been fully removed** — windows are `Gtk.Window`, `Adw.AlertDialog` → `showNidaraAlert`, `Adw.Clamp` → `NidaraClamp`, and dark/light is driven by `Gtk.Settings.gtk_application_prefer_dark_theme` in the shell (no `Adw.init()`). Every OTHER process — installer, lock screen, any app — learns the accent, the mode and the opacities from the **Settings portal and only from it**; the greeter, outside any session, reads the mirror. That is the appearance contract in `references/architecture.md` — read it before a new window needs a colour. Don't reintroduce any `Adw.*`. See `references/design-system.md`.
- The state model is **one central GObject (`Status.ts`)** with mutually-exclusive overlay setters. Subscribe via `notify::prop`. See `references/state-and-ipc.md`.
- The dock H/V split is **already deduplicated**: `DockHorizontal.tsx` and `DockVertical.tsx` are 7-line wrappers; shared logic lives in `DockCore.tsx` with axis differences isolated in `DockAxis.ts`. Edit those, not the wrappers — see `references/tech-debt.md`.
- Dock springs integrate via `stepSpring` in `DockPhysics.ts`, which **substeps internally (≤1/60 s per substep)**. Never integrate a spring with a raw frame `dt`: semi-implicit Euler diverges when `damping·dt > 2`, and the frame clock can stall/fall back to ~60 Hz (e.g. a fullscreen window occludes the dock) pushing `dt` to the `MAX_DT` clamp — that exact combination exploded the auto-hide slide to 1e+68 px (2026-07-18). Stability comes from the substep, not from `MAX_DT`.
- **The shell's skin is DARK** (white ink) whatever the system mode and whatever the wallpaper, since 2026-09-30, except where a surface follows the mode (the dock, the app grid); a light skin is to come back as a Setting, not defined yet. A Cairo painter on shell chrome therefore asks `chromeIsDarkFor(itsArea)` / `glassAlphaFor(itsArea, role)` / `glassTintFor(itsArea)` from `common/ShellGlass.ts` — never the global `Theme.chromeIsDark` / `Theme.overlayOpacity` or a bare `GLASS_TINT.dark` (`references/design-system.md` → "The shell's glass, as a painter asks for it"). The ADAPTIVE glass (#673: measure the backdrop, thicken the tint) went with #762. **On Hyalo the compositor paints the glass itself**: a glass painter registers its shapes with `trackGlass` and, while `compositorPaintsGlass(itsArea)` is true, paints only content and state (it is false for glass inside glass, `nested`, and for the greeter, still on Hyprland) — see `references/hyalo.md` → "The shell's glass is declared". And there the TEXT is white and turns dark per pane only where Hyalo measured the whole backdrop under it white (the ink): `chromeIsDarkFor` already answers it, CSS follows `INK_DARK_CLASS` — `references/hyalo.md` → "The ink". Not every pane takes it (owner, 2026-10-08, after measuring the reference): the Control Center and the notifications stay white (`trackNoInk`), the dock follows the system MODE (`trackModeGlass` + `skinFromMode`), glass buttons follow the backdrop, the bar row is undecided — "WHO takes the ink" there. What the glass does to the backdrop is each pane's TONE — the reference's own filter, stage by stage as it was measured (ceiling, levels, saturation, wash, ambient), with each kind of pane's values (`trackGlassPiece`: control, panel, controlCenter, dock; the table is `TONES` in `glass-material.ts`); the BLUR is the reference's, measured: one capture, three blurs mixed per pane by its size, small to large on the reference's own ramp (`BlurMix`, `references/hyalo.md` → "The blur"); there is no adaptive tint and no shadow under the glass any more, only the CC/NC's FIXED veil (`trackVeilRegion`) — and each pane's own shadow OUTSIDE its glass, measured, by size (`set_shadow`, `references/hyalo.md` → "Each pane's shadow") — `references/hyalo.md` → "The tone".
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

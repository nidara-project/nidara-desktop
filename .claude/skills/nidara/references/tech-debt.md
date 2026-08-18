# Nidara — Known tech debt

Read this before a refactor or before "fixing" something that feels weird — many odd
patterns are known tradeoffs with reasons. **Keep this file honest:** when you resolve an
item, remove it (or move it to "Resolved — rules that still apply"); when you create or find
debt, add it. It must match reality.

## Active debt

### 1. `@mixin glass()` underused — audited 2026-06-09, mostly NOT migratable
Defined in `_base.scss` (levels `surface`, `raised`, `floating`) with few call sites. A
sweep audit found the manual glass-ish blocks **diverge deliberately** (different radii,
inset shadows, transitions, extra colors) — force-migrating them would change pixels, so
they stay. The actionable parts of that sweep were done instead: Adwaita named colors
eradicated (`@accent_bg_color` in `_workspace.scss`/`_app-grid.scss` — those DID track the
accent, but only via a fragile accidental chain: our gsettings `accent-color` → the
libadwaita that AGS force-loaded defines the named color → GNOME's palette flavor of the
accent, not our exact token; on an Adwaita-free system it breaks silently — and since the AGS host
went (#9) EVERY system is Adwaita-free in-process, so that chain is now simply dead. Now they use
`--nidara-accent` directly), `--nidara-accent-10` unified (5 sites), orphaned
`.bar-ws-dot` and `.cc-resize-btn` CSS deleted (the latter was the pre-context-menu tile
resize UI). For dark badges over imagery, don't hardcode rgba blacks — add scrim tokens
when a real user appears (a `--nidara-scrim` trio existed briefly; removed as speculative
once its only consumer turned out to be dead CSS). Rules that stand: **new code uses the
mixins/tokens**
(`glass()`, `material-*`, `nidara-row-states`/`-tile-states`, scrims); two accent-button
hover conventions coexist (`rgba(accent, .82/.85)` translucent vs `color-mix(… white 15%)`
lightened) — they look intentional per-material, don't blind-unify without a visual pass.
Sweep-verification recipe: compile `style.scss` before/after and diff — a pure refactor
must produce an identical (or fully-accounted) CSS diff.
**Systematic orphan purge done 2026-06-10:** a detector script (extract every `.class` from
`styles/*.scss`, `grep -rF` each against `surfaces/ widgets/ common/ core/ app.ts ../lib`) found and removed
~45 dead classes (−459 compiled lines, −13%) — remnants of the dock pre-DockCore, the
pre-commandment-5 separate overlay windows, the old sidebar variant, deleted Resources.tsx,
and the pre-context-menu CC edit chrome. **False-positive traps for the next run:** classes
built dynamically (`accent-${key}` in Appearance.tsx, `nidara-btn--${variant}` in
nidara-kit/button.ts), GTK-internal node classes (`day-name`/`other-month`/`week-number` =
Gtk.Calendar, `combo`), and live names that look stale (`notif-win`).

#### The four "kit classes with zero consumers" are TWO different things, not one bucket

This list read as one open question for months — *"should these be deleted?"* — and that framing was
the problem, not the classes. Settled 2026-08-10 by reading the history instead of the counts.
**Nothing in the kit was declared upfront; every one of these came out of a real need.**

**(a) Three are the OPT-IN HALF of a rule that is fully live**, and were never meant to have
consumers. They are escape hatches shipped alongside an element rule that does the actual work:

| Class | The live half | Reach |
|---|---|---|
| `.nidara-input` | `entry, .nidara-input { … }` | ~20 real `Gtk.Entry`/`PasswordEntry` (Settings Ai/Users/Region/Autostart/Network, the kit's `alert-dialog`, greeter + lock) |
| `.nidara-switch` | `switch, .nidara-switch { … }` | 10+ real `Gtk.Switch` |
| `.is-selected` | `&:selected, &.is-selected` inside `nidara-row-states` / `nidara-tile-states` | every include of those two mixins |

The class exists to say *"this thing is not a `Gtk.Entry` but should look like one"*. Deleting it
removes zero declarations from any existing widget — the body stays either way — and `.is-selected`
is not even a standalone rule, it lives inside two mixins next to GTK's own `:selected` (which only
appears on `GtkListBox` rows, so the alias is the only route for widgets we paint ourselves).
**Zero consumers is the expected state for an alias. Stop re-triaging these.**

**(b) `.nidara-tile` is the one genuine finding, and it is UNFINISHED, not unused.** It came from
`69cce101 refactor(ui): universal CrystalRow/CrystalList`, whose own message says: *"Floating tiles
already share one model (`crystal-tile-states`); a `.crystal-tile` class + CrystalSidebar/
CrystalMenu/CrystalWindow are **Increments 2-3**."* Every sibling in that plan shipped and is used
(`.nidara-row` 23 consumers, `.nidara-menu` 4, `.nidara-window-glass` 3, `.nidara-list` 4,
`.nidara-sidebar` 1). Only the tile migration never happened.

The reusable part was never the problem: the **mixin** `nidara-tile-states` is well adopted, by
`.app-grid-button`, `.cc-split-icon-btn`, `.cc-detail-back-btn` and `.bar-popover-icon-btn`. What
stalled is visible in those four — they take **different radii (`md` / `sm` / `sm` / `xs`) and their
own padding**, so absorbing them needs size variants, which is a design decision. Rows all share one
geometry and sailed through; tiles do not and did not.

✅ **DROPPED 2026-08-10 (owner's call).** The options were finish it or delete it — "leave it sitting
there" was the only one that kept lying, same shape as the `cc-*` prefix in §56. The class is gone;
the mixin stays. **Bring it back WITH variants if the migration is ever attempted, never bare.**

🔑 **It was never used, not used-then-dropped, and the distinction took one command.** `git log -S`
across the whole history — under both this name and the pre-rename `.crystal-tile`, since #22 hides
the origin of every kit class — finds no commit that ever applied it from code. Its comment named
"CC icon tiles" among the intended wearers, which is exactly why it read like CC chrome that had
fallen out of use; the history says otherwise. **A class's comment describes the plan, the history
describes what happened.**

⚠️ Two traps met while establishing that, both of which nearly produced a wrong answer:
`git log -S'.crystal-tile'` also matches `.crystal-tile-states`, so it appears to point at the mixin's
commit — search the declaration (`'.crystal-tile {'`) when a name is a prefix of another. And `-S`
over `ui/` hits the **committed generated `style.css`** as well as the source, so a "consumer" can be
the compiled output of the very rule you are investigating.
**Re-run 2026-06-23 (271 classes):** removed 2 newly-confirmed dead blocks —
`.settings-icon-btn--danger` (`_components.scss`, a never-wired "danger tint" modifier; the base
`.settings-icon-btn` is only ever added plain/`+flat`) and `.is-danger` (`_control-center.scss`, the
only live `is-*` toggle is `.is-active` in `StatusIndicators.tsx`). The other 24 candidates are all
accounted-for traps: the 9 dynamic `.accent-*` swatches, `.nidara-btn--ghost` (variant `"ghost"` IS
used, Audio.tsx), the 4 GTK-internal nodes (`combo`/`day-name`/`other-month`/`week-number`), the 4 kept aliases above, and 4
tombstone *comments* the extractor matches inside `/* … */` (`bar-ws-dot`/`cc-resize-btn`/
`nidara-media-progress`/`settings-page-title` — the CSS is already gone, the comment documents why the
live class is named differently). **Next-run trap:** the extractor matches `.name` inside comments, so
a tombstone comment reads as an orphan — check whether the only hit is a comment before acting.

### 2. Anti-Adwaita resets still dense in two files
`_control-center.scss` (~33 reset rules) and `_settings.scss` (~24). High reset counts signal
these surfaces are fighting Adwaita widgets they shouldn't use. **Don't add more resets** —
use `@mixin nidara-reset` or switch the widget to base GTK4 / `ui/lib/nidara-kit/`.

### 3. CC row typography doesn't scale with the font picker
`_control-center.scss` overrides `.nidara-row-title` / `.nidara-row-subtitle` to fixed
`$fs-small` **px**, while the shared component (and Settings) use the `$fse-*` **em** ramp that
follows the Settings font-size picker. Intentional for chrome (must not reflow) but worth a
look when polishing the CC — decide whether CC text should track the picker like Settings.

### 4. Effective-config re-sync exists at the service layer, not the page layer
`HyprlandState` now emits **`config-reloaded`** (caught from Hyprland's `configreloaded` IPC
event — `hyprctl reload` / a `hyprland-user.lua` edit) and refreshes its `availableModesByName`
cache. The effective-config services subscribe and re-read: `InputConfig.syncFromHyprland()`
and `MonitorConfig._vrr`. This protects against the **clobber bug** — both services rewrite
their whole `.lua` override from in-memory state on the next `setX()`, so without re-sync an
external edit would be overwritten.
**Mostly closed now.** The shared helpers `toggleRow` / `dropdownRow` (in `SettingsHelpers.ts`)
take an optional `onExt?: (apply) => (() => void)` and `sliderRow` takes `opts.onExtChange` —
each registers a live external-sync callback that updates the control through a **guarded**
setter (no `setX`, so no feedback loop) and disconnects on `unrealize`. `Input.tsx` wires every
control to `inputConfig.connect("changed")` via a local `onCfg(read)` factory, so an external
`hyprctl reload` (→ `config-reloaded` → `syncFromHyprland` → `"changed"`) now live-updates the
sliders/switches/dropdowns. The old no-op `"changed"` stub is gone.
**Pattern for any future reactive control:** prefer the helper's `onExt`/`onExtChange` over a
hand-rolled signal — the guard against the cb→setX→`"changed"`→cb loop lives inside the helper.
**Still missing:** the *monitor* (Display) page reflects topology live (#8-style) but not external
geometry/scale edits; and the generic per-page rebuild convenience for arbitrary content still
doesn't exist (you wire per-control or per-signature, as Input/Display do).
**Page-level precedent now exists** (`Display.tsx`): it subscribes to `hs.connect("changed")`
and rebuilds its monitor sections, but **only when a stable signature changes** — there, the
sorted set of monitor *names* (topology), so monitor hot-plug/unplug is reflected live. It
deliberately does NOT rebuild on geometry/scale `"changed"` churn: `hs."changed"` fires on every
window/workspace event, and resolution/rotation are user-driven through that page's own
dropdowns, so a mid-interaction rebuild would clobber the in-flight revert-dialog closure state.
Any future reactive page should copy this **"subscribe broadly, rebuild on a narrow signature"**
shape rather than rebuilding on raw `"changed"`.
NB: the dock's bottom *screen* gap and rounding are its OWN (`dockSettings.screenGap`, fixed
Cairo `DOCK_CONSTANTS` rounding) — independent of Hyprland's `gaps_out`/`rounding`. So
`config-reloaded` as shipped exists for the input/monitor/vrr clobber fix, not for layout.
**BUT effective `gaps_out` does have a real (not-yet-built) consumer:** the vertical dock's
length bounds. `DockAxis.ts` (vertical adapter) currently hardcodes `BAR_HEIGHT = 40` and sets
`WIN_H = monMain - BAR_HEIGHT`, centering the dock in that span with **no `gaps_out` inset**.
The intended model (deferred, undefined): top limit = the bar's *actual* exclusive zone +
`gaps_out`, bottom limit = `gaps_out`; and later the horizontal dock's max width = monitor
width − `gaps_out` each side. When that's built it should read effective `gaps_out` via
`HyprlandState.getOptionInt("general:gaps_out")` and refresh on `config-reloaded`, and replace
the hardcoded `BAR_HEIGHT = 40` with the bar's real exclusive zone.

### 5. i18n has no hot-reload
`detectLanguage()` runs once at startup; a locale change needs `Super+Shift+R`. Out of scope
for most PRs, but know it when testing locale changes.

### 6. Architecture/skill docs are intentionally git-ignored
`NIDARA_SHELL_ARCHITECTURE.md` and `docs/nidara-skill-brief.md` are local-only by the
owner's decision. Record architectural decisions there and/or in this skill's `references/`,
not in a tracked repo doc.

### 7. `pageHeader()` removed — RESOLVED
Settings page titles live in the **window header** as a breadcrumb (driven by
`Settings.tsx`, shown via `NidaraWindow`'s `headerTitle`). The in-body `pageHeader()`
stub, all ~19 `page.append(pageHeader(...))` call sites + their imports, and the
`.settings-page-title`/`-subtitle` CSS have been swept. The dead `settings.*.subtitle`
i18n keys were purged 2026-06-10 along with 13 other dead keys (32 total, both locales) —
detector: keys in `en.ts` minus literal `t("…")` uses; **dynamic lookups are the trap**
(`t(TIER_LABEL[tier])` keeps `cc.menu.size.*` alive), and the typecheck (`keyof typeof en`)
is the authoritative safety net: a wrongly-removed live key fails `npm run typecheck`.
Asset sweep verdict, same date: do NOT prune `assets/nidara/scalable/` by grep —
those SVGs are GTK theme assets resolved by NAME CONVENTION (checkbox/radio/window-control
glyphs), invisible to code search.

### 8. Settings subpages: the framework still builds them once
A subpage pushed via `SettingsNav.pushSubpage` is built once (fresh on each push, but static
after) — `pushSubpage` itself has no live-rebuild story, so a subpage that needs reactivity
must wire its own signals. The Wi-Fi AP detail page now does exactly that (it subscribes via
`NetworkService.watchWifi` + the AP's `notify::strength` and updates its labels in place, with
the IPv4 group shown only while that AP is the active connection). So the *pattern* for a
reactive subpage exists; the generic framework convenience does not.

### 9. The per-boot Adwaita-WARNING — ✅ RESOLVED 2026-08-18 (the host went)
**It was AGS's, and it left with AGS.** `/usr/share/ags/js/lib/gtk4/app.ts` called `Adw.init()`
unconditionally (`catch`-guarded) whenever libadwaita existed on the system, with no way to opt
out — so libadwaita was initialised in a process whose widget tree had none. `ui/lib/host.ts` does
not. Verified on the live shell: the `Adwaita-WARNING … gtk-application-prefer-dark-theme … is
unsupported` line that fired at every boot is gone, and `Adw.is_initialized()` is false
(`scripts/dev/host-probe.ts` asserts it, and its `--astal` control shows the warning and the `true`).

`ThemeManager.setPreferDark()` keeps its `AdwStyleManager` probe **on purpose**: it is a
`probeAdwStyleManager()` that returns null when Adw is not initialised, so it costs one dynamic
import and then takes the plain `Gtk.Settings` path forever. Leaving it is what makes the file
correct in a process that some future bundle DOES initialise Adw in; deleting it would be a
correctness bet for no gain.

⚠️ **The anti-Adwaita resets (#2) are still needed, for a different reason than this item used to
give.** It said they were needed "because the Adwaita stylesheet IS loaded in-process" by
`Adw.init()`. That is now false and the resets still matter: GTK4 ships its OWN default theme, also
called Adwaita, and loads it regardless. Measured through the host probe — a bare `Gtk.Label`'s
colour was `rgb(255,255,255)` with libadwaita initialised and is `rgb(238,238,236)` without, which
is GTK's built-in dark foreground, not "no theme". So `_reset.scss`'s
`button, calendar { color: var(--nidara-text) }` is doing the same job against a different sheet.
**Concrete gotcha (cost a debugging pass, 2026-06-23):** Adwaita's in-process `button { color }`
(and `calendar` label colour) beat an *inherited* `color` by specificity — so a menu row that is a
`Gtk.Button` (`.nidara-menu-row`, `.window-menu-ws-btn`) or GtkCalendar day labels show **Adwaita's
button colour (white in a dark-prefer process), NOT the inherited `--nidara-text`**, even when an
ancestor (`.nidara-menu`) sets `color: var(--nidara-text)`. Symptom: white menu/calendar text on a
light-pinned shell skin (the `shellAppearance` scope only redefines the `--nidara-*` custom props; it
can't fix a real `color` Adwaita set on the element). **Fixed systematically (not per-element):**
`_reset.scss` binds `button, calendar { color: var(--nidara-text) }` in the neutralization layer — LOW
specificity but HIGH provider priority, so it beats Adwaita's element rule yet LOSES to our own classes
(`.nidara-btn--primary`, `.today`, `.nidara-text-secondary`, …) which keep their colours. So new shell
buttons/menus/calendar text follow the pin automatically; **don't** add per-element `color` overrides for
this. (Provider priority is the outer sort key in GTK — our USER-priority providers beat Adwaita's
THEME-priority sheet regardless of selector specificity; specificity only decides within our own sheet.)

### 11. Idle GPU spin on bar/dock — RESOLVED (two distinct causes)

**(B) `nidara-bar-zone` configure storm — RESOLVED 2026-06-15 (this was the residual ~30–47% GPU drain).**
The invisible exclusive-zone reservor (the "Zone reservor" block in `Bar.tsx`) was an EMPTY layer-shell
surface that Hyprland reconfigured **~60/s** (gdb + libgtk-4 debuginfo/addr2line: `gdk_wayland_surface_configure`
→ `gdk_surface_request_layout` 60/s on the 2560×1 zone surface), spinning its frame clock → continuous
recomposite + reblur of bar/dock. Content-bearing surfaces (bar, dock) never storm even with an exclusive
zone — only the empty spacer did. **FIX:** deleted `zoneWin`; the bar reserves its own top strip
(`set_exclusive_zone(win, 40)` instead of `-1`; the fullscreen/overlay toggles now operate on `win`).
Measured Hyprland gfx **47% → 4%**, `reserved [L,T,R,B]=[0,40,0,100]` intact, `nidara-bar-zone` layer gone.
Universal (no empty spacer for any dock position). **Trade-off:** a SIDE dock now squishes the bar (it
respects the dock's exclusive zone) instead of spanning full-width above it — acceptable / more correct.
**Method notes (costly, don't repeat):** Hyprland readouts LIE (`getoption` reported blur OFF while ON) →
trust per-process `drm-engine` in `/proc/*/fdinfo`, not readouts; transparency, concrete width, and
TOP-only anchor were each disproven LIVE (GPU stayed 47%); **NEVER `call gjs_dumpstack()` from a gdb
`Breakpoint.stop()`** — it core-dumped the shell (auto-restarted) — use the gdb frame API +
safe pure getters (`gdk_surface_get_width/height`). STILL OPEN: occasional idle GPU blips 0→5–10% with
nothing happening (intermittent damage → reblur; suspects: clock tick, wifi/battery widget churn via
generic `notify`, cursor); blur is the cost multiplier (inherent).

**(A) `HyprlandState "changed"` storm — FIXED 2026-06-14 (commit 6fcde4c).** On a live *armed* instance
(~125/s main-thread wakeups) `gsk_renderer_render` now fires **~2/s** (was ~120/s) — a 98% cut
in repaints, verified by gdb. The user-visible symptom (elevated GPU / continuous compositing)
is resolved.

✅ **The residual is gone too (2026-08-17).** It was an **AstalHyprland busy IO-watch on
socket2**: ~40–60% of fresh instances woke the main thread ~120/s because the lib re-emitted
`"event"` spuriously even though Hyprland sends ~4 real events/s, and reading its getters
during `_refresh` could feed that back into itself. AstalHyprland was replaced by
`core/hypr-ipc.ts` — the same two sockets, read directly — so there is no re-emitter left and
the loop cannot form. The dirty-check and the throttle below both STAY, for a different and
still-valid reason: **Hyprland itself bursts** (dragging a window across a workspace boundary
emits movewindow + activewindow + workspace within one frame), and several tracked events
describe the same settled state.

**The fix (3 parts, all in `core/HyprlandState.ts` + `surfaces/overview/WorkspaceOverview.tsx`):**
- **Dirty-check** (the load-bearing one): `_refresh()` computes a structural `_stateSignature()`
  (focus + per-client addr/class/geometry/**fullscreen**/workspace + workspace list; **excludes
  titles**) and only `emit("changed")` when it differs. Redundant events see identical state →
  no `"changed"` → no repaint. Titles arrive on the narrow `"title-changed"` signal instead, which
  only AppTitle listens to — measured live 2026-08-17: a terminal spinner produced **14
  `title-changed` and 0 `changed`** in 14 s. `fullscreen` joined the signature when
  AstalHyprland went: a maximized window toggling FSMODE does not have to move a pixel, and the
  bar and dock used to catch that with per-client `notify::fullscreen` handlers.
- **Throttle**: `_scheduleRefresh()` floors the interval between refreshes at
  `REFRESH_MIN_INTERVAL_MS = 60` — one refresh per burst (real events are sparse, so the floor is
  imperceptible).
- **Visibility gate**: `WorkspaceOverview` only runs `syncAll` (icon churn + schematic
  `queue_draw`) while `status.overview_open` — not on every `"changed"` while closed.

**Root cause (how it was found, gdb + `gjs_dumpstack()`):** the spinning surfaces are
**`nidara-bar` AND `nidara-dock`** (both 2560×1440), NOT the `nidara-bar-zone` reservor
(2560×**200**; ruled out via `gdk_surface_get_height` at a `gsk_renderer_render` breakpoint —
the old "zone" attribution was WRONG). Chain: `gsk_renderer_render` ← `queue_draw` ←
`WorkspaceOverview` schematic ← `syncAll` ← `HyprlandState` **"changed"** ← `_refresh()` running
~120/s. Activity-independent: spin persisted with blur OFF, with a STATIC title, and regardless
of focused window — so the earlier **blur and title leads were BOTH disproven** by live test.

**Validation method (reusable):** count repaints with gdb, NOT wakeups — wakeups can't tell a
fixed instance (cheap busy-loop handler) from a broken one. Recipe:
`break gsk_renderer_render` + a 2 s gdb-python `continue` loop counting hits. Restarting to
sample arming is rate-limited (`StartLimitBurst=5/30s`); a temp drop-in
`StartLimitIntervalSec=0` (then `daemon-reload`, remove after) lets you restart freely.

**Original full investigation trail (kept for the gdb/forensics recipes):** Found by attaching gdb
to a live *armed* instance (ptrace + Arch debuginfod) and reading the JS stack via
`gjs_dumpstack()`:
- The spinning surfaces are **`nidara-bar` AND `nidara-dock`** (both 2560×1440), repainting
  every frame — **NOT** the `nidara-bar-zone` reservor (its surface is 2560×**200**; verified
  by `gdk_surface_get_height` at a `gsk_renderer_render` breakpoint). The old "zone" attribution
  below was **WRONG**.
- `gsk_renderer_render` fires ~120/s. Walking up: `gtk_widget_queue_draw` ← `WorkspaceOverview`'s
  `ctx.schematic()` (`canvas.queue_draw()`) ← `syncAll` ← `HyprlandState` **"changed"**.
- `HyprlandState._refresh()` runs ~120/s in a **self-feeding loop**: `_refresh()` reads
  `hl.get_clients()/get_workspaces()/get_monitors()`, which makes **AstalHyprland re-emit
  `"event"`** → the `connect("event")` handler calls `refresh()` → `_scheduleRefresh()` →
  `idle_add` → `_refresh()` → … (15/15 idle-scheduler stacks were identical:
  event-handler → refresh → _scheduleRefresh). Hyprland's own `socket2` is nearly silent
  (~4 events/s — just the kitty title spinner), so this is NOT driven by real compositor events.
  It's the same AstalHyprland re-emission class the code already dodges for `notify::clients`
  (see `HyprlandState.ts:63-65`).
- **Instance-random (~40–60% of fresh shells arm; the rest read 0/s)** = whether that
  AstalHyprland re-emit race establishes at startup. Activity-independent: verified the spin
  persists with blur OFF, with a STATIC focused-window title, and regardless of which window is
  focused (so the earlier blur and title leads are BOTH disproven).

**Tooling note:** `strace`/`perf`/`bpftrace`/`ltrace` are NOT installed; `gdb` IS, and Arch
`debuginfod` (`DEBUGINFOD_URLS=https://debuginfod.archlinux.org`) gives symbols. `ptrace_scope`
defaults to `1` (only descendants) → attaching to the systemd-spawned shell needs
`sudo sysctl kernel.yama.ptrace_scope=0` (restore to 1 after; resets on reboot). Recipe that
cracked this: break `gsk_renderer_render` → `gdk_surface_get_height((void*)gsk_renderer_get_surface((void*)$rdi))`
to ID the surface; break `gtk_widget_queue_draw` / `g_idle_add_full` → `call (void)gjs_dumpstack()`
(prints the JS stack to `/tmp/nidara-ui.log`) to find the JS culprit; map bundle line
numbers by reading `/run/user/$UID/ags.js`.

Historical detail (SUPERSEDED — the "zone surface" claim is WRONG, see above):

Idle baseline is **0 wakeups/s** (genuinely event-driven — keep it that way; measure with
`awk '/voluntary/{s+=$2} END{print s}' /proc/$PID/task/$PID/status` deltas, or
`nidara-doctor` which now reports it). On 2026-06-09 several instances armed to a
permanent ~137/s (≈144 Hz refresh) during real desktop use — but an exhaustive controlled
hunt **failed to reproduce it**: all five overlay open/closes, Settings window, AppGrid,
dock context menus, grouped notifications + NC, workspace overview, system menu + power
menu, MPRIS media actively playing, tooltips, smooth + coarse cursor sweeps across dock and
bar, and the cursor parked on every interactive element — every one left 0/s.
**Methodology trap that created a false lead:** measurements taken while the user's cursor
sat wherever they left it (or mid-interaction) read 130–450/s and made it look like "opening
the CC leaks" — always park the cursor in a dead zone (`hyprctl dispatch movecursor`) before
sampling. CPU stays ~0.2% — battery concern, not perf.
**The spinning surface IS identified: `nidara-bar-zone`** (the invisible 40 px
exclusive-zone reservor window, `Bar.tsx` "Zone reservor" block — empty box, opacity 0,
TOP layer, always mapped). Proof on a live armed instance: with `hideForLock` unmapping
bar+dock, the rate persisted (~125/s — zone is the only shell surface left), and fullscreen
AppGrid occlusion collapses it (compositor stops frame callbacks). A DPMS off/on cycle does
NOT disarm it. **Unknown: what arms it** — fresh boots sometimes start armed, sometimes
clean, with no identified difference.
**Mitigation shipped (a6c00e8, 2026-06-09):** the zone is now invisible via scoped
transparent CSS instead of `set_opacity(0)` — toplevel opacity composits every frame and
was the prime spin suspect. **Status: under observation** — the trigger was never
on-demand reproducible, so only days of the doctor's wakeup section reading 0/s can confirm
the kill. If it arms again despite this, the remaining suspects are a GTK/GSK frame loop on
the (still 200 px tall — gtk4-layer-shell ignores child height) empty surface, or a
configure interaction with the compositor.
**Plan B (design change, not a patch):** delete the zoneWin hack entirely and reserve the
bar strip with Hyprland-native `addreserved`. Why it's not trivial: the current `hl.*` Lua
DSL exposes no reserved-area call (check the parser), the reservation must follow monitors
dynamically (bars are per-monitor), and monitor config is rewritten wholesale by
`MonitorConfig` (see #4's clobber risk). The zone window exists because a LEFT+RIGHT
anchored surface gets squished by the vertical dock's side exclusive zone, and the visible
bar (fullscreen overlay host, `exclusive_zone=-1`) must never be — the *mechanism* is
sound; only its GTK implementation details are in question.

**(C) Widget-level over-broad `notify` → bar re-blur — partially FIXED 2026-06-15.** Same
storm class as (A) but at the *widget* layer, not the state layer: a widget subscribes to the
generic `obj.connect("notify", …)` of an Astal object that churns properties on a timer, and the
handler re-assigns a `Gtk.Image.gicon` unconditionally → `gtk_image_clear` → `queue_draw` → a
full bar re-blur for an icon that never visually changed. **Fixed:** the always-visible bar
widgets — `widgets/wifi.ts` (narrowed to `notify::enabled`/`notify::ssid`, AstalNetwork.Wifi
churns `strength`/`scanning` on NM scans, commit dc42f44) and the bar **media** widget
(`widgets/media.ts buildBarContent`, guarded the play/pause `gicon` — AstalMpris polled position
every 1 s while PLAYING via `player.vala init_position_poll` → `notify::position`, so it re-blurred
at **1 Hz** while music played, commit d1803e2). **The media half of this lost its source on
2026-08-17**: `core/mpris.ts` extrapolates position instead of polling it, so a playing player
emits nothing at all (`scripts/dev/mpris-probe.ts` asserts 0 notifies in 3 s). The guards stay —
they are the right shape for a generic `notify`, which still fires for real metadata changes. **Rule:** guarding the `gicon` assignment
(`if (img.gicon !== want) img.gicon = want`; `Icons.*` are module-load cached refs so `===` holds)
is enough and is *safer* than narrowing — the generic `notify` stays robust to all metadata
changes, and with the only redraw-triggering setter guarded the 1 Hz wakeup queues no draw
(repaints are the cost, not wakeups — same principle as (A)). `label`/`sensitive`/`visible` are
already GTK equality-guarded. **Deferred items CLOSED in the 2026-07-02 optimization pass:**
- **Cover-art decode churn fixed** (`media.ts` rich panel + `MediaIsland.tsx`): `loadArt` now
  guards on the art PATH (decode only when it changes), `MediaState` carries an
  `artVersion` and every tile's `update()` gates `queue_draw` on it, and the play/pause `gicon`
  reassigns are identity-guarded. Before: 1 decode + full redraw per second while music played
  (AstalMpris position poll — gone since 2026-08-17), even with nothing visible: the media tile
  ships in the CC default.
- **CC toggle icons guarded at the funnel**: all Toggles.tsx icon writes go through `setIcon`,
  which now identity-guards (`if (img.gicon !== icon)`) — covers wifi/every capsule sync. If a
  `getIcon()` returns fresh instances the guard just falls through to assignment (no regression).
- **battery/ethernet re-checked**: no unguarded `gicon` reassign left (labels are GTK
  equality-guarded; battery paints via Cairo on low-freq UPower notifies). Nothing to do.
- **Same pass, same class (always-on pollers in built-once-hidden surfaces):** `brightness.ts`
  sliders used to spawn 2×`brightnessctl` every 2 s FOREVER once built (CC tiles hide, never
  unrealize, so `onExtChange`-cleanup-on-unrealize never fired). Now they poll via
  `pollWhileMapped` (zero spawns while hidden; map-tick doubles as the initial fetch) and
  `brightnessctl m` (max, immutable) is fetched once. **Rule:** a poller inside CC tile / bar
  expansion content must be `pollWhileMapped` (`common/poll.ts`), never a bare repeating
  `timeout_add` — cleanup wired to `unrealize` does NOT stop it, those widgets never unrealize.
  Known accepted residual: `widgets/vpn.ts` keeps ONE shared 10 s `nmcli` poll for the whole
  widget once first built (off-by-default tile; gate it on mapped if it ever matters), and
  brightness `watchActive` keeps a 2 s no-spawn wakeup for the TALL gauge.
- **Settings wallpaper previews** (`Appearance.tsx`/`Gaming.tsx`) now decode at 2× the 320×180
  preview box (`new_from_file_at_scale(path, 640, 360, true)`) instead of the full wallpaper
  (~17 MB decoded, retained forever because Settings hides instead of destroying).

### 12. Sporadic double-disconnect CRITICALs — RESOLVED (helper + sweep 2026-06-23; lifecycle half in 12b, 2026-08-02)
Rare bursts (≈2 in 30 h) of `GLib-GObject-CRITICAL … instance has no handler with id` (3–4
ids at once, 2 instances) and `GLib-CRITICAL … Source ID not found when attempting to
remove it`. Some cleanup path disconnects handlers / removes sources twice. Ruled out by
direct exercise (no critical emitted): all five overlay toggles, window open/close churn,
notifications (incl. `-r` replacement + NC open), DPMS off/on. Next occurrence: don't
theorize — run the shell once under `G_DEBUG=fatal-criticals` while reproducing the user's
action of that moment and read the coredump backtrace (recipe in `dev-workflow.md`).
**REPRODUCED 2026-06-20 (clean-VM first-run sweep).** The trigger is *rapid churn*, not a single
action: a script cycling every overlay on/off in a loop AND navigating every Settings page
back-to-back (`settingsPage <id>` for all pages, then `closeWindow`) emits the `has no handler with
id` bursts reliably (15+ at once). The earlier "ruled out by direct exercise" was too gentle — single,
spaced toggles don't trip it; quick successive Settings page build/destroy (and/or overlay
ScaleRevealer teardown) does.

**Root cause + fix (2026-06-21).** `obj.disconnect(staleId)` emits a `GLib-GObject-CRITICAL` at the
C level that a JS `try/catch` does NOT catch (it's a logged critical, not a thrown error) — so the
ubiquitous `try { obj.disconnect(id) } catch {}` was useless. Cleanups wired to `unrealize` run on
every realize/unrealize cycle (an overlay toggled open/closed, a Settings page rebuilt), so the
second run disconnects an already-stale id. Fix = `core/signals.ts` → `safeDisconnect(obj, id)`,
which guards with `GObject.signal_handler_is_connected` (idempotent). Migrated the reproducing
cluster — the CC/overlay/Settings widgets that recycle: `Sliders.tsx`, `MediaIsland.tsx`,
`widgets/{volume,battery,media,screenrecord,ethernet,night-light,dark-mode}.ts`, plus
`nidara-kit/slider.ts` and once-guarded the `onExt` cleanup in `SettingsHelpers.ts` toggleRow/dropdownRow.
**Full sweep done 2026-06-23.** Every remaining disconnect-in-cleanup site now goes through
`safeDisconnect` — both the useless `try{disconnect}catch{}` guards AND the bare unguarded
`obj.disconnect(id)` calls on `unrealize`/`destroy` (which were the actual repro pattern: `unrealize`
fires on every realize/unrealize cycle, so the second run disconnected a stale id). Migrated 21 files:
`core/{NetworkService,AudioService,BluetoothService}.ts`, `surfaces/bar/{Bar,AppTitle,Tray}.tsx`,
`surfaces/control-center/{Toggles,NotificationCenter}.tsx`, `surfaces/dock/{DockCore,DockItem}.tsx`,
`surfaces/overview/WorkspaceOverview.tsx` (WorkspacePreview.tsx was deleted 2026-07-19: orphaned,
Gtk.Popover-based), `surfaces/app-grid/AppGrid.tsx`,
`surfaces/about/AboutWindow.tsx`, `widgets/wifi.ts`, and the Settings pages
(Appearance, Display, Region, Input, Network, Bluetooth). Verified: zero `try{…disconnect…}catch`
left tree-wide, the only `.disconnect(` call is inside `safeDisconnect` itself; typecheck + build green.
**Rule still stands:** use `safeDisconnect` for ALL disconnect-in-cleanup code — never bare
`try{disconnect}catch{}` (it doesn't catch the C-level critical) and never a bare `obj.disconnect(id)`
in an `unrealize`/`destroy` handler.

#### 12c. …and `obj.disconnect(id)` was itself unsafe, because `disconnect` can be SHADOWED (2026-08-17)
`safeDisconnect` internally called `obj.disconnect(id)`. That is fine right up until the object owns a
method of its own by that name — `disconnect` is an ordinary identifier, not a reserved GObject slot.
**`NM.Device` owns one**: `nm_device_disconnect(device, cancellable)` **deactivates the interface**.
So on an NM device the cleanup call resolved to libnm's method with the handler id handed over as the
`GCancellable`. Found the moment `core/NetworkService.ts` started holding NM devices (#71): GJS
rejected it on type — `Expected an object of type GCancellable for argument 'cancellable' but got type
number` — surfacing as a failed cleanup instead of as a dropped network connection, which is a
coin-flip we should not have been taking. Fix (one line, `ui/lib/signals.ts`):
`GObject.signal_handler_disconnect(obj, id)`, which is unambiguous and cannot be shadowed. Benefits
all 40 call sites. **When reaching for a GObject method that a GI class might also define
(`disconnect`, `connect`, `emit`, `run`, `close`), prefer the `GObject.*` free function.** Checked at
the time: `connect`/`emit` are NOT shadowed on the NM classes we touch, only `disconnect` on
`NM.Device`.
⚠️ This also corrects the 06-23 claim above that "the only `.disconnect(` call is inside
`safeDisconnect` itself": three bare ones survived that sweep and still exist — `common/Tooltip.ts`
(×2: a layer surface and `Theme`) and `common/FocusGrab.ts` (a popup). None is an NM object so none is
shadowed, and each is guarded by its own null check rather than by `signal_handler_is_connected`. Left
alone on 2026-08-17 rather than widening an unrelated change, but they are the remaining EXCEPTIONS to
the rule, not evidence that the rule moved.

#### 12b. …but that sweep silenced the criticals without fixing the LIFECYCLE — RESOLVED 2026-08-02
The 06-23 sweep made double-cleanup *harmless*. It never made anything re-subscribe. Nothing above
is wrong; it was half the bug, and the silent half is the one users feel.

**The mechanism.** `showPage()` swaps pages with `contentArea.remove(current)` + `append(next)`, and
category pages are built once into `pageCache`. Removing a widget from its parent **unroots it →
`unrealize`**, but the page is not destroyed — coming back re-realizes *the same widget*. So
`page.connect("unrealize", dispose)` fires the first time the user navigates away and is never
undone: **the page comes back looking alive but frozen.** `safeDisconnect` and the `cleaned`
once-guards in `SettingsHelpers` turned that into a bug with no symptom in the log.

What it actually cost, before the fix (all confirmed by reading the disposal path of each page):
- **Audio** — `watchDevices`/`watchStreams` gone: plug in a headset after your first visit and the
  list never notices.
- **Bluetooth** — device list frozen AND `unregisterPairingAgent()` left standing: **pairing stops
  working for the rest of the session**.
- **Display** — monitor topology stale. **Appearance** — theme + night-light sync dead.
  **Dock**, **Power** — same shape.
- **Every `toggleRow`/`dropdownRow` with `onExt`** on every page — deaf to external config change.
- **Region** — the one page that still screamed, because a GLib *source* has no `safeDisconnect`
  equivalent: `GLib.source_remove(clockTimerId)` unguarded and never nulled → the clock preview died
  after one visit, and each later departure logged `GLib-CRITICAL … Source ID N was not found`
  (**always the same N** — the tell that a stale id is being re-removed rather than a new one leaking).

**Fix:** `bindWhileRealized(widget, subscribe)` (`nidara-kit/lifetime.ts` since 2026-08-16;
`SettingsHelpers.ts` re-exports it) — subscribes on every
`realize`, disposes on every `unrealize`, idempotent both ways. Put the initial refresh INSIDE
`subscribe`: a page you return to must re-read the world, not replay the state it had when the
window opened. All 8 sites migrated (Region, Audio, Bluetooth, Display, Appearance ×2, Dock, Power,
plus both `SettingsHelpers` row helpers, whose `cleaned` guards are gone).

🔑 **Rule: in Settings, `unrealize` means "I was taken out for a moment", NOT "I am being
destroyed".** Anything a page needs in order to stay CURRENT — service watches, signal handlers,
GLib timers — goes through `bindWhileRealized`. A bare unrealize-cleanup is only correct for things
that are genuinely per-realization and re-created on the way in (subpages qualify: `pushSubpage`
rebuilds them on every push — that is why `Network.tsx`'s AP-detail teardown was never affected).

⚠️ Diagnostic that generalises: **the same source/handler id repeating in a critical means a stale
id is being removed again; a leak shows different ids.** And `G_DEBUG=fatal-criticals` was never
needed here — the user naming the exact navigation (Language → Appearance) beat three rounds of
static analysis, two of which pointed at the wrong file.

⚠️ **This family is NOT confined to Settings, and the audit that found it did not look elsewhere**
(2026-08-17, found by the VM sweep of the released 0.7.1). The **Control Center's volume tile** had
it in its purest form: `Sliders.tsx` captured `default_speaker` when the widget SPEC was built — once,
at shell start — read `speaker.volume` into a `const` and handed the slider `() => current * 100`. A
CC widget spec is built at shell start, and at that moment AstalWp has not populated the endpoint's
properties, so that read was **0**: the slider showed 0% from login with the sink at 40% and
unmuted, and only corrected when something changed the volume from OUTSIDE. Four opens did not fix
it; a shell restart with the sink settled for minutes reproduced it exactly. Its neighbour survived
by accident — brightness `pollWhileMapped`s every 2 s, so it re-reads whether or not anyone primed
it. Fixed by resolving the endpoint through a getter (never captured), priming inside `onExtChange`,
and re-targeting on `notify::default-speaker` via `AudioSvc.watchDevices`.
🔑 **The rule for CC widgets specifically: a spec is built ONCE, at shell start, so nothing in it may
capture a service endpoint or a value read from one.** More precisely, `buildContent` re-runs on a CC
layout/size rebuild and NOT on open (the note in `MediaIsland.tsx` is the authority), so for a user
who never rearranges tiles, "once at shell start" is the whole session. The kit's slider already
states the contract (`nidara-kit/slider.ts`: callers whose `onExtChange` primes re-read on every
realize) — the volume tile simply did not hold it.

**✅ The rest of the CC WAS swept, 2026-08-17 (all 16 widgets + the CC surfaces), and there is no
second instance.** Recording the result so it is not re-run blindly:

- **Nothing else freezes a VALUE.** The volume tile was alone in reading into a `const` and handing
  the builder a closure over the number. Every other tile passes live getters —
  focus/bluetooth/night-light/dark-mode/vpn/screenrecord read through a function on each call, media
  keeps one shared subscribed state, and brightness `pollWhileMapped`s.
- **Captures that remain, and why each is not this bug:** `buildCCDetail`/`buildBarExpanded`
  (volume.ts) resolve when the panel is opened, by which time the endpoint exists;
  `NotificationPopups` used to capture the notifd singleton, which cannot be absent because the shell
  IS that daemon (it goes through `core/NotifService` since 2026-08-18 and captures nothing);
  `battery.ts`/`common/BatteryGlyph.ts` capture the UPower client at module import, but read
  `is_present`/`percentage` live through it, so only a null client at import would bite.
- ⚠️ **Wi-Fi and Ethernet look exactly like the family and must NOT be "fixed" the same way.**
  `Toggles.tsx` captures `AstalNetwork.get_default()?.wifi` / `?.wired` at spec build, and
  `widgets/wifi.ts` + `widgets/ethernet.ts` do the same — but re-resolving through a getter would
  change nothing, because the limitation is one layer DOWN: the service itself binds its device at
  init and never learns about one added later (**#22**, where the fix is written: watch NM's device
  list reactively in `core/NetworkService`, not at construction). A getter in the widget would be
  fix-shaped and inert — the tile would keep asking an object that never gains the device. The tell
  that these two are a different bug: the volume endpoint DID exist and populate later and the widget
  was the thing holding it wrong; here the widget is right and its source is empty.

⚠️ **The 2026-08-17 sweep asked the right question about VALUES and never asked it about
SUBSCRIPTIONS — and that is where the rest of the family was hiding** (found 2026-08-18, by running
the UI after `core/wireplumber.ts` replaced AstalWp). Four widgets drawing the default output wrote
`watchVolume(defaultSpeaker(), cb)` by hand, resolving the endpoint once at build or at realize:

- the **bar** volume icon, the **CC 1×1** icon, the **CC TALL** icon (via `makeVerticalFillTile`'s
  `iconSubscribe`), and `watchActive` — the CC gauge's REPAINT trigger.
- `watchVolume(null, …)` is a **silent no-op**, so each looked subscribed and never heard again.
  On screen: the bar icon stuck on MUTED with the sink at 95 %, and the TALL tile's label and icon
  keeping up while the pink fill stayed frozen at its first paint (86 % → 5 %, capsule still full).

🔑 **Why it was invisible until the library changed, and this generalises beyond audio:** AstalWp's
`default_speaker` was a PERMANENT proxy object that swapped its inner node underneath — never null,
so a subscription taken too early was still live and self-corrected on the first change. (It also
never emitted `notify::default-speaker`; nothing in the library emits it, so the re-target branches
those widgets carried had never once run.) A service that answers **null before its roster arrives**
— ours does, deliberately — turns the same code from "works by accident" into "dead for the
session". **When you replace a library, the bugs you inherit are the ones its shape was hiding.**

**Fix:** `AudioService.watchDefaultSpeaker(cb)` — subscribes to whichever endpoint is currently the
default, follows it when the default changes, and primes on subscribe. All four sites are one line
now. `makeVerticalFillTile` also moved its icon onto `bindWhileRealized`, which the VALUE beside it
had used since 0.7.1 and the icon never did.

Two more of the same shape, closed in the same pass:
- **Settings → Audio** opened with `if (!audio) return "no service"`. A page is cached for the
  window's lifetime, so that verdict was permanent; every accessor is now resolved live and the
  placeholder decision moved into `applyVisibility`.
- **`core/wireplumber.ts` emitted `speaker-added` BEFORE resolving the defaults**, so a handler that
  asked "who is the default?" for the very node that had just become it was answered "nobody".

### 13. Lockscreen GTK4 segfault when a wl_output vanishes — upstream, mitigated by watchdog
On wake-from-suspend the DP link re-trains and the wl_output disappears for ~1 s; GTK
destroys the session-lock window bound to that output and segfaults inside
`gtk_window_destroy` (stack is pure libgtk-4/libwayland — our JS is not in it; coredump
2026-06-10 11:53). With the lock client dead, Hyprland showed its red "lock app crashed"
screen. Mitigation shipped: `bin/nidara-lock` relaunches the bundle on abnormal exit
(≤5 attempts) and `misc.allow_session_lock_restore = true` lets the new instance take the
lock over. Real fix is upstream (GTK4 / gtk4-layer-shell `Gtk4SessionLock`); if a clean
reproducer emerges, file it there. Don't try to "handle" output removal in lockscreen JS —
the crash happens below us, during Wayland event dispatch.

### 14. Two more flat-menu row implementations could migrate to `MenuRow.ts`
`common/MenuRow.ts` (2026-06-11) is the shared builder for flat `nidara-menu-row`
lists; the CC context menu and the bar window menu use it. Two hand-rolled siblings remain:
`NidaraMenu.ts` `makeRow` (renders Gio menu models — tray **and now the dock context menu**;
different shape: model iteration, submenus flattened to headers, section labels → headers) and
`Bar.tsx` `buildOverflowList` rows. Migrate opportunistically if already editing those files;
not worth a standalone pass.

**The dock AND app-grid context menus were migrated off native `Gtk.PopoverMenu`
(dock 2026-06-27, app-grid 2026-06-28):** both are now plain `Gtk.Popover`s whose body is the
shared Cairo glass bubble (`common/GlassBubble.ts`, `paintGlassBubble` — same painter as the
tooltip, **with a pointer aimed back at the item**) + `renderMenuModel` rows, so they're themed
glass that blurs on the layer like the tooltip — no more raw GTK chrome. The tooltip's bubble
painter was extracted into `GlassBubble.ts` so there's ONE silhouette/arrow/0.38-floor
implementation, and the popover-chrome reset is the shared `.nidara-menu-popover` class
(`_components.scss`), used by both menus (the old per-surface `.dock-menu` rule is gone).
The app-grid menu, unlike the dock (edge-anchored, fixed direction), **chooses its own open
direction** per right-click — items low in the launcher flip the menu up so it stays on screen
and the fixed Cairo arrow still points at the item (`compute_bounds` vs root height, 0.65
threshold). **There are no more native `Gtk.PopoverMenu`s in the shell.**

### 15. Overlay scrollbar grew on pointer proximity and ate right-edge buttons — RESOLVED (2026-08-03)
GTK expanded the overlay slider on **proximity** (it adds `.hovering`/`.dragging` itself, not
the CSS `:hover`), so the bar reached toward the very control the user was aiming at — the NC
cards' close ✕, then the clipboard rows' ✕. CSS could never win it: Adwaita's
`scrollbar.overlay-indicator.hovering slider` beat every in-process override, its base slider
rule carries `border: 4px solid transparent` (8px of invisible width) that takes over exactly
when hovered, and `set_can_target(false)` was useless — proximity expansion is independent of
event targeting. Anchoring the bar flush to the wall was mitigation, not a fix.
**Fixed by `NidaraScrolled`** (`lib/nidara-kit/scrolled.ts`): `vscrollbar_policy: EXTERNAL` so
no scrollbar widget exists, plus our own fixed-width bar (transparent hit lane + 5px thumb)
that **still drags** — a first pass made it non-interactive and the user rejected that as a
regression; the drag was never the problem, the *growth* was. A second pass laid the bar out
with `margin_top`/`height_request` and produced a lagging drag plus flicker/ghosting, because a
scroll position is not a layout property (details in design-system.md); the bar is now a single
stationary DrawingArea that only repaints. Migrated everywhere including
windows: clipboard + CC detail, NC, Assistant transcript, all Settings pages, app grid. Their
`scrollbar` CSS blocks are deleted and `overlay_scrolling: false` is gone — don't reintroduce
either. See design-system.md, "Any ScrolledWindow". Same root as #9 (Adwaita loaded in-process).

### 16b. Adwaita button classes — RESOLVED, sweep complete (2026-08-02)
`widgets/vpn.ts`, `widgets/bluetooth.ts` and `widgets/screenshot.ts` all build `NidaraButton`s, and
connect/disconnect follows the Settings pages' intent mapping (connect = `primary`, **disconnect =
`secondary`, not `danger`** — it is reversible). `widgets/volume.ts` and `settings/pages/Widgets.tsx`
lost vestigial `flat`s riding along with `settings-icon-btn`, which already owns that look and is
unscoped.

The last holdout — `volume.ts`'s "set as default" text link (`["flat", "compact-btn"]`) — closed the
same day by **adding the size axis the swap needed**: `NidaraButton({ size: "compact" })` →
`nidara-btn--compact`, orthogonal to variant/pill/icon, one step down the ramp ($fs-caption, ~24px).
The link is now `ghost` + `compact`; `button.compact-btn` was deleted from `_control-center.scss`.
The vocabulary decision and its two guard rails (compact is editorial, not a fitting tool; the
modifier must stay declared LAST in `button.nidara-btn`) are written up in `design-system.md` —
read that before adding a third size.

Residual, deliberate: `button.flat` stays in `_control-center.scss` with **no author-side consumers**,
as a defensive normalizer for GTK composite widgets that carry `.flat` internally (night-light's
`SpinButton`). Deleting it would silently hand those internals back to Adwaita inside the panel. Not
debt to pay down; just don't write `flat` in page code.

NOT to be confused with `.nidara-seg-btn.suggested-action` (screenshot/screenrecord mode rows): there
the Adwaita class is not a button style but the SELECTED marker of a segmented control, and
`_components.scss` owns that rule. Legitimate, leave it.

### 17. Status-indicator subsystem: extension points deliberately not wired (2026-06-19)
`surfaces/bar/StatusIndicators.tsx` is a declarative registry (`INDICATORS`, three states
hidden/armed/active) rendered as a small **badge on the bar's Control-Center button**
(`ccBadge`) + a **status banner inside the CC** above the widgets (`ccStatusBanner`, where the
Stop/kill-switch lives). It currently hosts only recording + AI-control but is the intended home for
**privacy/activity indicators** (mic, camera, screen-share, location). Those are **not wired** (no
source detection yet); adding one = a new `INDICATORS` entry with `state()` + `subscribe()` + `onClick`.
The banner is a **Cairo island** since 2026-08-02 (user call), not a CSS `material-card`: same
painter/gloss/border/inset as the tiles below it, transparent CSS background, `margin-bottom: 24px`
(the CC's BLOCK rhythm — the air the Edit pill gets; 12px is the WITHIN-block tile gap, and using it
made the card look stuck to the grid). It also lost its danger tint on background AND border: four
reds on one row — tint, border, dot, Adwaita-red button — read as "something has gone wrong"
instead of "AI control is on". It states a fact and offers the switch; the red left is the dot. Its
button is `NidaraButton({variant:"secondary"})` — revoking a permission is reversible, and `danger`
means destructive.
**Recording left the registry entirely** on 2026-08-02 (badge-only from 08-01, then gone): the island
owns the live capture end to end, and the badge must never point at a CC that has nothing to show —
the screenrecord tile is opt-in and can be bar-only. The `banner?: boolean` opt-out that existed for
one day went with it (no consumer left). The boundary that settled it: **the CC says what is GRANTED
(permissions, and the kill switch), the island says what is RUNNING.** A privacy indicator with no
island activity behind it (mic, camera) gets a full entry here; anything the island already shows
live gets none.
Also deferred by product decision: **drag-reorder of bar widgets** (bar order is category-derived via
`barOrder`; the CC has its own Edit-mode reorder). The AI "active" signal depends on the tools pinging
`notifyComputerAction` — an action path that bypasses `nidara-act/type/click` would stay "armed", not
"active"; fine today (those are the only action tools), re-check if a new path is added.

### 18. ✅ CLOSED — the app grid left the dock's window, and the coupling that kept it there was TRADED, not lost (2026-08-09)

**What this entry used to say, and it was right at the time:** the grid was implemented inside the
dock window (`DockCore.tsx`, closure var `appGridPanelOpen`, exposed as `toggleAppGridPanel` /
`isAppGridPanelOpen`) rather than as a `Status.ts` overlay, **deliberately** (owner, 2026-06-20),
because launching it also **revealed the dock** — the way to reach the dock when auto-hide or a
fullscreen window had put it away. It warned: don't "fix" this by moving it into Status.

**It was not fixed; it was PRICED.** The owner asked for the move once the bill was named: Hyprland
charges layer blur by the surface's BOX, so a guest that can paint anywhere forced the dock to hand
back its whole monitor-sized region for as long as the grid was up (`DockAxis.ts` had a
`st.appGridPanelOpen` branch in each axis that did exactly that, plus an `appGridPainting` flag so
the close animation kept it). The §46 saving vanished at the busiest moment on screen. Told that
the reveal was the price, the owner chose the region — **"prefiero optimizar antes que mantener
eso"**.

**What shipped.** `surfaces/app-grid/AppGridWindow.ts`: its own OVERLAY layer surface per monitor,
namespace `nidara-app-grid`, UNMAPPED while closed. Measured on the real shell: it declares
**1110×834 of 2560×1440** (~25%) while open, and the dock now declares its pill rect in **every**
state — every `apply()` in both axes passes a blur rect, there is no branch left that clears it.

**Three things the move made possible or necessary, none of them optional:**
- **It IS a Status overlay now** (`status.app_grid_open`), because the dock coupling was the only
  thing keeping it out. That closes this entry's own "accepted consequence": the grid could sit open
  behind the Control Center, and now the exclusion is mutual both ways (verified live). `dumpState`
  reads the property; the window-scanning `isAppGridOpen` accessor in `app.ts` is gone.
- **The CSS scope moved with it** — `_app-grid.scss`, `_workspace.scss`'s shared block, and BOTH
  neutralization lists in `_reset.scss`. See §56: this is also how that file's half of §56 closed.
- **A Hyprland layer rule is not optional for a new namespace.** `nidara-app-grid` needs
  `blur + blur_popups + ignore_alpha` or the panel renders as unblurred glass. It keeps the DOCK's
  `0.04`, not the bar's `0.01`: 0.04 is what it has been blurred at all along, and the reason the
  dock is not at 0.01 is app ICONS haloing, which is most of what this surface paints.

🔑 **A coupling documented as "deliberate, don't fix" is a decision with a price nobody has quoted
yet.** This entry told three agents not to touch it and none of them asked what it cost. The move
took an afternoon once the question was "what does the reveal cost?" instead of "should the grid be
in Status?".

⚠️ **What was actually given up, so nobody re-adds it by accident:** Super no longer reveals the
dock. Two things soften it and both are verified live — the dock's windows are **peers** in the
grid's focus grab (its icons still launch with the grid open, and clicking one does not dismiss),
and with auto-hide on, an edge hover still slides the dock in **while the grid stays open**.

🔑 **Moving a surface into `Status` is THREE edits, not one, and the other two fail in silence**
(both found the same day, one by the user and one by chasing it). A new overlay property needs:
the setter + `EXCLUSIVE` map (obvious), **`isAnyOverlayOpen`** (it is the first line of the bar's
empty-strip dismissal handler AND what stops `AgentService` popping the island over something the
user opened — the grid was missing from both), and **`dismissOverlays()`** in `Bar.tsx` (only once
the bar is a grab peer, but then mandatory). Symptom of the first miss: the empty bar strip
dismissed every overlay except the new one, from the same pixel.

⚠️ **A grab CLAMPS pointer focus, so the peer list decides who can be HOVERED, not just clicked.**
The grid shipped with only the dock whitelisted and the bar's capsules went dead — user-caught
within the hour. Peers are now bar + island + dock, the set the bar and island already granted each
other.

⚠️ **Multi-monitor is unchanged, which means still imperfect.** Each surface takes its own focus
grab and there is one grab compositor-wide, so on two monitors the second open evicts the first and
closes it. That was already true of the two docks, and it is true of the island today — see the
`setModal` call in `Bar.tsx`. Not a regression; not fixed either.

### 19. Shipped default config was a personal snapshot — RESOLVED
The seeded `defaults/*.json` were a dump of the maintainer's personal config, not curated
defaults (caught by the clean-VM first-run test, 2026-06-20). **PR #27 curated `appearance.json`**
(accent → blue, iconTheme → Papirus, transparency → a deliberate 0.5 — was a slider-derived float)
and added the packaging that made it resolve: `papirus-icon-theme`/`adwaita-icon-theme`/`xdg-utils`,
the default file-manager association (`xdg-mime` `inode/directory` → nautilus, else the dock's Files
item `xdg-open`ed a terminal), and a wallpaper-on-first-run fallback in `hyprland.lua` (awww-daemon's
cache is empty on a fresh box). *(That fallback was itself replaced on 2026-07-26 — it raced the
daemon's async cache restore and could permanently overwrite the user's wallpaper with the shipped
default; see architecture.md "Wallpaper at login: never trust awww's cache".)*
**Now fully resolved (bar/CC placement):** `defaults/widgets.json` and `defaults/cc_layout.json` were
**deleted** — bar/CC placement no longer ships as a personal dump. It comes from the shell's **code
defaults** (`DEFAULT_PLACEMENT` from each widget's `defaultInBar`/`defaultInCc`, + `CC_DEFAULT_ORDER`,
both in `widgets/index.ts`), which are version-controlled, reviewable and **hardware-adaptive**:
- **Bar status cluster** = `defaultInBar: true` on `wifi`, `battery`, `volume`; the bar's hardware
  gate (`widgetAvailable`) prunes absent ones (desktop → no battery, etc.).
- **CC default** = universal tiles seeded in `CC_DEFAULT_ORDER` (media, dark_mode, focus, volume,
  cpu_memory, calculator) + hardware-adaptive tiles (`wifi`, `bt`, `brightness`: `defaultInCc` true
  but **not** in the seed) that `syncCCLayout` appends to a free cell **only when the hardware is
  present**. The load-bearing rule: never seed a hardware-gated tile, because `CCLayoutManager.remove()`
  does NOT reflow, so a tile removed on a hardware-less box would leave a hole (see the comment on
  `CC_DEFAULT_ORDER`). Off-by-default-but-addable (`defaultInCc: false`): ethernet, vpn, clipboard,
  screenshot, screenrecord, night-light.
The runtime `~/.config/nidara/{widgets,cc_layout}.json` are still written by the managers once the user
customizes; only the shipped seeds are gone. NB `defaults/region.json` is NOT seeded from the repo
(install.sh derives it from the system locale), so it was never part of this.

### 20. AstalHyprland boot CRITICAL on empty-workspace login (dependency, not our code)
On a clean boot into an empty workspace, `libastal-hyprland` logs at startup `Json-CRITICAL …
json_node_get_string: assertion 'JSON_NODE_IS_VALID (node)' failed` + `astal_hyprland_hyprland_get_client:
assertion 'address != NULL' failed` (clean-VM first-run sweep, 2026-06-20). It's inside AstalHyprland —
an event parsed with a missing/empty address when nothing is focused. Harmless (assertion, shell
continues) but boot noise; reinforces AstalHyprland as the #1 facade-replacement candidate
([[project_astal_dependency]]). Don't chase it in shell code; if it must be silenced before the facade
swap, guard the focused-client read path.

### 21. `nidara-repo` — install.sh consumes it (DONE); signed (DONE); residual = permanent pin lockstep
`github.com/nidara-project/nidara-repo` (public, 2026-06-21) is a pacman binary repo serving the 18
deps (appmenu + 16 Astal + ags; down to 5 by 2026-08-18 — see the Astal absorption below), GitHub Pages (`https://nidara-project.github.io/nidara-repo/$arch`,
repo name `nidara`, **GPG-signed since 2026-07-05**: CI signs packages + db, clients use
`SigLevel = Required DatabaseOptional`, key bundled at `packaging/nidara-repo.gpg`, imported/lsigned
by install.sh which also migrates unsigned-era `Optional TrustAll` entries). **`install.sh` now consumes it**
(validated E2E in a clean VM 2026-06-21): §1 registers `[nidara]` + `pacman -S`'s them explicitly
(the `libastal-*` declare `depends=()`, so they must be listed — resolution won't pull them), §2/§4
skip the source build when `DEPS_FROM_REPO=yes`; **the from-source build stays as the fallback** on any
repo failure (installer still succeeds, slower). A **lockstep guard** after `pacman -S` verifies the
installed versions encode this script's pins (pkgver carries `r<sha7>`/the tag) and only then sets
`DEPS_FROM_REPO=yes` — otherwise a repo lagging a pin bump would `pacman -S` "successfully" with stale
versions and the fallback would never fire (both branches VM-validated 2026-06-22). Because of that
fallback (and the update pin-skip
record), `install.sh` keeps its own `*_REF` pins → **pins still live in two places** (`install.sh`
`*_REF` + `nidara-repo/pins.env`) and must be bumped **in lockstep**. This is now *permanent*, not
transitional — the earlier "Phase 3 collapses to one SoT" plan does **not** apply (the fallback needs
the refs). **Build toolchain: DERIVED, not retyped (2026-08-12).** The workflow used to carry a hand-written
union of the PKGBUILDs' `makedepends`, which drifted silently because `build-repo.sh` runs
`makepkg --nodeps` on purpose — a declared makedepend missing from the workflow is simply absent,
with no warning (it killed v0.7.0 on `missing protocol: …/hyprland-focus-grab-v1.xml`).
Deriving it required first making the PKGBUILDs honest: the 16 `libastal-*` declared only
`meson ninja vala gobject-introspection git glib2-devel`, harmless on a user's machine (install.sh's
`PACMAN_DEPS` ran first) and fatal in CI. Now `gen-pkgbuilds.sh` declares real per-package
`makedepends` (each one read out of that lib's `meson.build` at the pinned rev) and
`scripts/build-deps.sh` prints the union incl. the `NIDARA_REF` tag's own PKGBUILD. **Consequence
for this repo:** `packaging/nidara/PKGBUILD`'s `makedepends` is load-bearing — whatever `build()`
reaches for must be named there or it will not exist in the build container (`wayland` and `gtk4`
were added for exactly that reason). nidara-repo also builds PRs now (unsigned, no publish), so a
change to the chain is provable before merging. **Still deferred at the repo:** tightening
`depends=()` + `provides`/`conflicts` (a
`nidara-keyring` package could later replace the bundled-key import, but the current
`pacman-key --add` path works and ships). **Since the packaging switch (2026-07) the repo also
ships `nidara` itself**: built LAST by `build-repo.sh` from the `NIDARA_REF` tag in `pins.env`,
with the PKGBUILD found INSIDE the tag (`packaging/nidara/`); `install.sh --system` consumes it
(prebuilt or local makepkg fallback) and `nidara-update` goes through `pacman -Syu` +
`nidara-setup` on package installs. See
`packaging/README.md` and `references/dev-workflow.md`. Next link of the distribution track:
`nidara-repo → archiso → Calamares` ([[project_installer]]).

### 22. ✅ CLOSED — duplicate of #71 (2026-06-22 → 2026-08-17)

Found in the clean-VM nivel-3 sweep with `fake-wifi.sh`: a shell that started with no Wi-Fi device
never noticed one appearing later. Correctly guessed at the time ("init-time device binding in
`libastal-network` rather than a `device-added` subscription") and then re-found from the other end
in **#71**, which carries the diagnosis, the fix and the verification. Read that one.

### 23. `appearance.shellAppearance` covers the WHOLE shell skin — RESOLVED (2026-06-23)
The pin now applies to **bar + dock + every overlay** (CC/NC/Prism/system menu/overview/app grid), not just
bar/dock. App-mode windows (Settings `nidara-settings-window`, About `nidara-about`) are **excluded** — they
follow the system/app mode like any app. Mechanism: `generateChromeTokenScope` scopes
`window#nidara-bar *, window#nidara-dock *` (overlays live inside those windows; Settings/About are separate
toplevels), and `SquircleContainer` defaults `chrome:true` (= shell skin). The old "transient bar surfaces
excluded" caveat is gone — the expansion panel + system menu live in the bar window, so they follow the pin
now. No opacity floor (WYSIWYG). See `design-system.md` → "Shell-skin appearance & opacity".

### 24. Unified surface-appearance + opacity coherence — RESOLVED (2026-06-23)
The coherence redesign landed and was verified live. **Done:**
- **Appearance pin → whole shell** (see #23): the user chose to KEEP the pin (shell skin independent of app
  mode) over the simpler "shell = app mode"; it now covers all shell surfaces except Settings/About.
- **Opacity model rebuilt.** The three confusing sliders (`transparency`/`shellOpacity`/`dockOpacity`, one
  inverted, plus a surviving 0.40 light-mode floor) → **one "Glass" master + an "Advanced" disclosure** over
  four plain-opacity surfaces `barOpacity`/`overlayOpacity`/`dockOpacity`/`windowOpacity` (range [0.05,0.80],
  **floor removed entirely** — WYSIWYG). `windowOpacity` = the Settings/About CSS token path (`--nidara-bg`/
  materials/popovers in `nidaraVars`); the Cairo surfaces use the other three via
  `SquircleContainer({ opacityRole })` / `DockAxis`. `setGlassOpacity` is the master. See `design-system.md`.
- **Adwaita colour leak fixed** (#9): `button, calendar { color: var(--nidara-text) }` in `_reset.scss`.
- **Dead code removed** (#25): tint subsystem + orphan tokens.

**Phase 3 (legibility polish) — DONE 2026-06-23 (built + typecheck/build green; live-verify pending the user's reload):**
- **Washed-out light-mode text — FIXED.** `nidaraVars` now ramps `--nidara-text-secondary`/`-dim` to
  `rgba(fg, 0.85/0.72)` in light (was a flat 0.8/0.6); dark keeps 0.8/0.6. Propagates to the pinned shell
  skin automatically because `generateChromeTokenScope` reuses `nidaraVars(chromeIsDark)`.
- **Slider track now follows the surface skin — FIXED.** New `Theme.surfaceIsDark(widget)` (ThemeManager)
  resolves dark/light by the widget's root window name (`nidara-bar`/`nidara-dock` → `chromeIsDark`, else
  `isDark`); `nidara-kit/slider.ts` track uses it. Redraws on `Theme "changed"` (slider already subscribes).

**Residual (NOT Phase 3 — product decision / cosmetic, left as-is):**
- **Tray icon coherence (partly unsolvable).** Symbolic tray icons follow the theme/pin; pixmap-only ones
  can't (inherent to SNI — `core/tray.ts` decodes the ARGB32 pixels the app sent, and pixels have no
  theme). A uniform policy is a product decision, not a bug.
- Minor drift: `_base.scss` static `--nidara-bg: rgba(30,30,30,…)` vs the engine `rgba(36,36,36,…)` (only the
  instant before tokens load).

### 25. Accent-tint subsystem is dead code — RESOLVED (deleted 2026-06-23)
The "tint" feature (wash CC / app-grid panels with the accent colour) was wired end to end but had **zero
entry points** (no Settings UI, not in `config-entries.ts`, no IPC; defaults `0`/`false` → `generateTintCss`
always returned `/* No tint */`). **Deleted** in the theming-audit cleanup: `TintPanels`, `tintStrength`,
`tintPanels`, `PANEL_SELECTORS`, `generateTintCss` (NidaraTheme.ts) + `tintProvider`, `_lastTintCss`,
`refreshTintCss`, `setTintStrength`/`setTintPanel`, the getters, the imports, and the persisted keys in
save/load (ThemeManager.ts). Same pass removed other emitted-but-unconsumed tokens (verified 0 consumers
tree-wide): the `@define-color fc_*`/`sidebar_*` named colours and the `--nd-accent`/`--nd-transparency`/
`--accent-color`/`-bg-color`/`-fg-color` custom props (the `--accent-<key>` swatch palette and the libadwaita
`accent_*` bridge were KEPT — both have live consumers). Typecheck + build green. **Rule:** don't reintroduce
an accent-panel tint (or any token) without a real entry point — a Setting/`config-entries`/IPC — wired at the
same time. Side effect: the duplicate alpha/popover computation in `generateTokenHeader` is gone, so the
light-mode opacity floor now lives in exactly ONE place (`nidaraVars`) — see #24.

### 28. Settings → App Icons row is cramped — RESOLVED (2026-07-09)
Each row in Settings → Apps → **Installed Apps** (renamed from "App Icons") now drills into its
own subpage via `nav.pushSubpage` (`apps/icons/{id}` → `buildAppIconDetailPage`), replacing the
old modal dialog. The detail page applies instantly (choose image / restore, no Apply/Cancel),
mirroring the pattern already used for the Bar page's launcher icon. It's also the intended stable
surface for **future per-app settings** (window rules, default workspace, gaming profile,
autostart, permissions…) and for an agent to write per-app overrides — add another `listGroup` to
`buildAppIconDetailPage` when the next one lands. Row subtitle changed from the resolved icon
name/path to `app.id` — meaningful for a general app list, and the icon internals don't belong
there anymore now the page isn't icon-only. See memory `project_settings_apps_page`.

### 29. Ghost descenders on list mutation — ✅ RESOLVED at the root 2026-08-11 (#123 + #124)
Kept because the WRONG diagnosis held for a month and is easy to arrive at again.

**Symptom:** on `invalidate_filter` (App Icons / Installed Apps, the Autostart app picker) and
on ROW REMOVAL from a plain `.nidara-list` (deleting entries in Settings → Apps → Autostart),
GTK4 left the descender ink of `y/g/j/p` behind hidden rows and clipped it on visible ones.

**What it was read as:** a GskGL damage/re-raster bug. Every geometry-neutral attempt failed —
`queue_draw` at any scope, swaps, rebuild-fresh-rows, opacity toggle — and padding "fixed" it
by cutting the tail off. The shipped workaround grew one list's line box
(`.apps-list .nidara-row-subtitle { line-height: 1.35 }`), which is why it never reached the
row-removal trigger at all.

**What it was:** the LINE BOX was wrong. The font's ascent/descent were unrounded, so the box
the toolkit reported did not contain the ink it drew; any re-layout repainted the box and left
the rest on screen. The same defect shaved the tops of flat glyphs (T E F H I L) DE-wide —
"the T is cut but the G is not" was the same bug wearing different clothes. Fixed in #123
(`gtk-hint-font-metrics` + whole-pixel font sizes, see design-system.md); the line-height came
out in #124. Both triggers verified after: the filter cycle by pixel diff, the row removal by
the user on real hardware.

🔑 **The transferable lesson:** when ink survives a repaint, suspect the BOX before the
compositor. A widget whose reported geometry is smaller than what it draws produces damage
that cannot cover its own output, and no amount of invalidation from our side fixes it.
⚠️ And the trap that made this expensive: **hover re-render and window resize both clear the
ghost**, so an interaction-driven check reports a pass it did not earn. Park the pointer, or
have a human look.

### 30. Users page form dialogs are unstyled Gtk.Windows — need a nidara-kit form-dialog primitive (2026-07-10)
Settings → Users has three dialogs with two different skins: Delete User goes through
`showNidaraAlert` (nidara-kit `alert-dialog.ts`, full design-system chrome), while Add User and
Change Password are hand-rolled plain `Gtk.Window`s — only their `NidaraButton`s are styled; the
window, labels and entries render with GTK defaults, so they visibly belong to another family
(user-flagged in the 07-10 VM pass). Deliberate deferral to keep PR #22 functional-only. The fix
is NOT to hand-style those two windows: build a reusable **form-dialog primitive in
`ui/lib/nidara-kit`** (window + heading + body slot + response row, sharing the alert-dialog's
chrome/classes) and rebuild both dialogs on it — per the universal-components rule, so every
future form dialog is born coherent. Design decisions pending: CSD header vs headerless card,
glass level, entry styling (`nidara-alert-entry` already exists as a starting point).

### 31. Legacy `~/.config/hypr/hyprland-user.lua` is edited in place, never migrated (2026-07-11)
The Autostart page (now Settings → Apps → Autostart) resolves the effective override file the
same way Lua's `require` does (`~/.config/nidara/` first, then `~/.config/hypr/`) and edits
whichever it finds — see `resolveUserConf` in `Autostart.tsx` and dev-workflow.md's ownership
model. A pre-2026-07 install that only has the hypr file keeps using it forever; we deliberately
don't auto-migrate (moving a user's hand-edited file around is riskier than tolerating the legacy
path). If a migration is ever wanted, it belongs in `nidara-setup`, not the Settings page. Note
the duplicated search+list scaffold between `AppIcons.tsx` and the Autostart picker is marked
"extract on third consumer" in both files.

### 32. `/var/tmp/nidara` greeter mirror is first-writer-owned — a second user can't update it (2026-07-10)
`ThemeManager.saveSettings` and `RegionConfig` mirror `appearance.json` + `region.json` into
`/var/tmp/nidara` (dir 0755, owned by whoever wrote it first) so the greeter — a system user
with no access to a 700 home — can render the accent and clock format. On a multi-user
machine the SECOND user's shell cannot write there (fail-soft: a console warn, nothing
breaks), so the login screen keeps reflecting the FIRST user's appearance no matter who used
the machine last. Leftover of the 07-10 multi-user sweep (first-login bootstrap + per-user
logs). Fix direction: per-user mirror files (e.g. `/var/tmp/nidara/<user>/…`) with the
greeter reading the `lastUser`'s (it already tracks lastUser since PR #22) — touches shell +
greeter; or a sticky group-writable dir. Low urgency, cosmetic.

### 33. Agent-pointer visual: accepted best-effort edges (2026-07-12)
The fake AI cursor (`surfaces/agent-pointer/`, `agentPointer` IPC, choreography in
`bin/nidara-click`) ships with three deliberately-accepted rough edges:
- **Drag skew is cosmetic**: on confirm the fake cursor glides start→end in ~290 ms
  *concurrently* with the real injector's 24-step drag — the two aren't frame-locked, so a
  small visual/real offset during the glide is expected and fine (the endpoints match).
- **Monitor hotplug is inherited, not handled**: one overlay window per monitor is created at
  boot (same lifecycle as bar/dock); a monitor added later has no overlay until the shell
  restarts. Same standing limitation as the rest of createUI.
- **Multi-monitor INJECTION is still deferred** (`create_virtual_pointer_with_output`, see
  state-and-ipc.md) — the overlay already routes the visual to the monitor containing the
  target point, but verifying the injection mapping needs a second physical display.

### 34. Gtk-CRITICAL `gtk_widget_is_ancestor` on dock context-menu open — GTK bug, don't chase it (2026-07-16)
Every dock context-menu open logs `Gtk-CRITICAL … gtk_widget_is_ancestor: assertion
'GTK_IS_WIDGET (widget)' failed`. Diagnosed with a live gdb backtrace: it's a missing NULL
check inside GTK (`gtk_popover_focus`, gtkpopover.c:1126, still unfixed in GTK main as of
2026-07-16). When an `autohide` popover is shown, GTK tries to move keyboard focus into it;
if the popover has **no focusable children** AND **nothing in the root window holds keyboard
focus**, `gtk_root_get_focus` returns NULL and GTK passes it unchecked to
`gtk_widget_is_ancestor`. The dock menu always meets both conditions (custom non-focusable
glass rows + a layer-shell window that never holds keyboard focus) → exactly one CRITICAL
per open. 100% harmless: the assertion aborts that check and the menu works normally. The
same applies to any other autohide glass menu on a layer surface (tray, app-grid) if its
window has no focused widget. **Do NOT "fix" it in shell code** — making menu rows focusable
would change real focus behavior just to silence someone else's warning. The right fix is a
one-liner upstream (`if (!p || …)` at that line); reporting to GNOME/gtk is pending (no
GitLab account yet).

### 35. Island media compact: focus-aware mutation deferred (2026-07-19)
The capsule's compact content mutates to the media form whenever the selected player is
PLAYING. The agreed ideal is stricter: only mutate while the playing app is NOT focused
(music in the foreground app doesn't need an ambient indicator — you're looking at it).
Deferred from phase 2 as secondary; needs `HyprlandState` focused-window class matched
against the player's `entry`, with a real edge case: a browser playing in a background TAB
of a focused window would wrongly count as "focused". Design the matching before wiring it.

### 36. Built-in Assistant v1 — minor debt after both PRs (2026-07-20)
Brain (PR 1: `bin/nidara-agent` + Settings → AI picker + keyring) and face (PR 2: `core/AgentService.ts`
+ island **Agent mode** `surfaces/island/AgentIsland.tsx` `ISLAND_AGENT`, `agent` activity priority 25,
`Super+A → toggleAgent`, SCSS in `_bar.scss`, `island.agent.*` i18n) are both implemented. Residual v1
debt: ~~(a) the model field is shared across backends~~ — **RESOLVED 2026-07-21** by the provider
picker: `brainModels` in `ai.json` is per-provider model memory, restored on every switch.
(b) Conversation history is unbounded (daemon-side, capped only by
`MAX_STEPS`/turn; UI transcript grows too) — add a turn cap / context trim before long sessions.
(c) `toolresult.ok` is `true` whenever the tool RAN (even on a shell refusal/validation error) — the
truth is in the content the model reads, but the UI chip only tints danger when the daemon says
`ok:false`, which it currently never does for a refusal string; consider error-shape detection.
(d) AgentIsland bubbles have no max-width cap (wrap at the 356px panel). (e) Anthropic backend
implemented to spec but only OpenAI-compatible verified live. (f) **Expand-on-finish** may feel
intrusive — watch the user's live verdict; easy to gate tighter or drop. Full plan:
`~/.claude/plans/spicy-twirling-galaxy.md`.

### 38. Computer-use verb surface — gaps found by audit 2026-07-27
Traced every verb through all four layers (`nidara-input.c` → `nidara-click` →
`nidara-mcp` → the built-in Assistant). **Layer 2→3 is complete** — `click_app` /
`click_at` absorb all four click modes via a `button` param, so the MCP server is
correctly wired and is NOT where the problem is. Four gaps, cheapest first;
**(a) and (b) are fixed, (c) and (d) are open.**

**(a) ~~`move` is BUILT AND UNREACHABLE.~~ FIXED 2026-07-27** — `hover-app` /
`hover-at` in `nidara-click`'s `MODES` (→ the C verb `move`), `hover_app` /
`hover_at` in MCP, and a `move` kind in the fake-cursor choreography that
**lingers without rippling** (a hover presses nothing, and the visual never
lies). No C, as predicted. The estimate that missed: this was billed as "wrapper
+ MCP", but the pointer overlay is a third consumer of the verb list — anything
that adds a verb has to teach `agentPointer` what it looks like.

**(b) ~~`drag` is the only asymmetric verb.~~ FIXED 2026-07-27** — `drag-app` /
`drag_app` resolve BOTH ends through the same `resolveNode()` before anything is
pressed (a half-resolved drag would press the button with nowhere legitimate to
release it), with per-end role/occurrence disambiguation. The old justification
for its absence — *"a two-ended gesture doesn't map cleanly to the single-node
`*-app` shape"* — was wrong and is corrected in `state-and-ipc.md`.

**(c) No middle button, no double-click, at any layer.** The injector knows only
`BTN_LEFT`/`BTN_RIGHT`, and a double-click is not two clicks — it needs the
timing window modelled. This one IS new C, which means recompiling the binary on
every machine (`install.sh` builds it), so weigh it accordingly. Double-click
probably earns that (opening things in file managers is constant); middle-click
looks marginal.

**(d) Single-output, cross-cutting.** `nidara-input.c`'s header says so
explicitly: it maps logical coords against ONE output's extent, so every
positioned verb is wrong on a multi-monitor setup. Widest-reaching of the four.
Hyprland's own cursor control (`dispatch movecursor`, global coords, natively
multi-monitor) is the candidate here — it stays compositor-mediated, so it does
not violate the no-uinput guardian rule; it would complement the virtual-pointer
path for POSITIONING rather than replace it for buttons.

**Order matters, and it is not what it looks like:** doing the Assistant's
computer-use parity FIRST would duplicate (a), (b) and (d) into a fourth consumer
and cement the drag asymmetry in one more place. Fix the surface, then mirror it.
**Done in that order** — (a) and (b) landed in #62, and the Assistant mirrored the
*fixed* surface afterwards (2026-07-27): same names, same parameters, hover and
`drag_app` included from the start rather than bolted on later. (c) and (d) are
still open and now have TWO consumers to land in, which is the argument for doing
(d) in the wrapper rather than in either caller.
The surface both consumers now mirror is **symmetric** — five verbs, each with an
`-app` and an `-at` form.

**(e) ~~Every pointer/keyboard verb was structurally dead from inside the
Assistant.~~ FIXED 2026-07-27, and it is the reason the first live trial read as
"it can't do anything".** Not a fifth gap in the verb surface: a compositor
constraint nobody had connected to computer-use. `CFocusState::rawWindowFocus`
returns early while any layer surface holds an EXCLUSIVE keyboard grab — which the
Assistant island does the whole time the user is typing at it — so `focus_window`
was a no-op, the helpers' focus check then correctly refused, and the click would
have been swallowed anyway (Hyprland routes the pointer to a grabbing surface
regardless of its input region, and the island spans the monitor). AT-SPI
perception and `do_app_action` were unaffected, which is what made it look like
model clumsiness. Fixed with `core/InputYield` + the `yieldInput` IPC (the helpers
ask the shell to let go for the length of one verb); `focusWindow` now verifies
instead of reporting a refused focus as success. Full reasoning in
`state-and-ipc.md` → "The shell has to STEP OUT OF THE WAY for computer-use".
**The mis-diagnosis is worth remembering:** the first reading was "`hyprctl
activewindow` lies while a grab is held", and the obvious fix — source focus from
`listWindows.focused` instead — would have made the helper approve an action that
cannot land, and typed the agent's text into its own prompt box. The compositor's
source code settled it in one grep.

**(f) ~~A successful action reported FAILURE — `pingShell` polluted stdout.~~
FIXED 2026-07-28, found in the first live run after (e).** `nidara-type` and
`nidara-act` pinged the AI-control indicator with
`GLib.spawn_command_line_async("nidara-ipc notifyComputerAction")`, which **cannot
redirect stdio**, so the child inherited ours and the `ags` CLI's reply (`ok`)
landed on the helper's stdout right after its JSON. The daemon parses exactly one
JSON per helper, so it failed → the tool came back `ok:false`. **Deterministic, not
racy:** the daemon reads to EOF, and the pipe's write end stays open until the ping
child exits, so the `ok` is always waited for. Worst in `nidara-act`, which pings
only when the action **succeeded** — so the tool reported failure precisely when it
had worked. `nidara-click` already had the fix (Gio + `STDOUT_SILENCE`) and the
comment explaining it; the other two never got it. It stayed invisible because the
focus gate refused every Assistant call before reaching the ping. **Rule for any new
helper: nothing but the one JSON may reach stdout — fire-and-forget children must be
`Gio.Subprocess` with `STDOUT_SILENCE`, never `spawn_command_line_async`.**

**(m) `scroll` and `drag` verified live at last — and the friction was `match`.
Fixed 2026-07-29.** The sixth run dragged `cs.svg. File` onto `Open Trash` in
Nautilus and scrolled it four times, every call `ok:true`. That closes the live gap:
**all five pointer verbs** (click / hover / scroll / drag / type) have now been
driven against a real window. The waste was elsewhere, again, and again in what we
tell the model:

- **The model wrote `match:"cs.svg|Trash"` and got `count: 0` five times.** `match`
  was a plain `includes()`, so `|` meant a literal pipe. It was **right to want it**:
  the two ends of a drag are two names and asking for both in one call is the
  correct economy. `match` now splits on `|` and keeps a node matching EITHER. A
  literal pipe in an accessible name loses — a trade worth making.
- **`showing` had half the answer and the model still dumped the window.** Measured
  against the live Nautilus tree: the list it would have returned contains
  **"Open Trash"** in 406 b — the very label the model paid a 21 KB whole-window
  dump to learn. What it did NOT contain was the file: Nautilus draws items as
  `table cell`/`table row`, which the control-role pass excludes. **In a chat window
  the content is noise; in a file manager the content is the target.** So
  controls-first is now strictly an ORDERING, with the remaining slots filled from
  everything else labelish: Nautilus 406 → 729 b, Telegram 401 → 743 b, both still
  ~50× cheaper than the dump they exist to prevent. Pinned: scenario 4 asserts the
  first label is the control AND that content fills the rest (both verified failing).

**(l) A hover DOES hold — until our own island takes the pointer back. Measured
2026-07-29, do not re-derive.** The user hovered Telegram's emoji button through
the agent, watched the panel open, and then watched it close on its own. Three
facts, all measured live, and they decide a design question that was about to be
answered wrongly:

1. **The pointer never moves back.** `hyprctl cursorpos` reported the hover target
   (1207, 1308) still, seconds after `nidara-click` had exited. With the island
   CLOSED the panel stayed open indefinitely — user-confirmed on screen.
2. **Opening the island closes it.** While an island mode is open, its surface owns
   the pointer and `IslandWindow.updateInputRegion` stamps what it covers (at the
   time of this entry, a catcher rect from y=0 to the full monitor height). `InputYield`
   empties that region for the action and `Bar.tsx`'s `notify::active` handler
   re-stamps it at `end()` — so the app under the cursor gets a pointer LEAVE and
   the popup closes. **A hover is not a state we hold; it is a consequence of which
   surface owns the pointer.**
3. **The revealed popup may not exist for AT-SPI at all.** Two independent walks of
   Telegram's tree with the panel open ON SCREEN: 398 → 401 nodes, the four new
   ones unrelated churn (a chat item's presence changed), and **one window** in the
   tree throughout. A Qt popup is drawn without an accessible node, exactly like a
   GTK tooltip.

**Fact 3 is why the obvious fix was NOT built.** The plan was to have `hover_app`
read the tree inside the truce, before `end()` closes the popup — an atomic "hover
and look". It would have returned nothing here, because there is nothing to return.
Measuring first is the only reason that code does not exist. The sticky-yield
variant (hold the truce open across a hover) dies on the same fact and costs a
click-through shell for up to the 15 s watchdog.

What shipped instead is the sequence that already works, taught where the decision
is made: **`setIsland closed` → `hover_app` → `query_app` → `setIsland agent`**, in
the gated prompt block, plus honest descriptions on both consumers (a hover holds;
what it reveals may be unreadable — say so rather than guess). No CI pin: the
constraint lives in the compositor's pointer-focus rules, and a string assertion on
prose would be theatre.

**(k) The fourth live run cost 62 % of its tokens on ONE unfiltered `query_app`.
Fixed 2026-07-29.** The run itself went well — the focus refusal from (j) recovered
in a single step, exactly as designed. The waste was elsewhere, and only the token
counts show it: step 1 filtered (`match:"search"`, 4 hits, history 3,199 b), and
because the UI is in **Spanish** none of the 4 was the button, so step 2 asked for
the whole window. History went to 40,845 b and **every one of the six remaining
steps carried it** — ~78k of the turn's 125,483 input tokens, spent to discover
that the control is called "Buscar mensajes".

**The model cannot see the price of what it is about to ask for.** Worse, the old
code only hinted on a match of exactly ZERO, and the hint recommended *"call again
without `match`"* — i.e. it pointed at the 37 KB path without naming its cost. Now
a filtered query with ≤ 8 hits carries `showing` (the labels on screen) and a hint
that states the size of the dump it is declining to recommend. Free: those nodes
are already in hand, and it is computed **only** on that path.

**`showing` is CONTROL-FIRST, and that is the whole point** — taking labels in
document order repeats the head-cut bug the projection exists to fix, one level up.
Measured on the live Telegram window: document order spends 18 of its first 19
slots on table cells (*Remitente, Mensaje, Entrega…*), while filtering by role
gives **16 names, all controls, 401 bytes, with "Buscar mensajes" second**. Below 8
control-role names it falls back to every labelish name — an unknown toolkit must
degrade to a noisy list, never an empty one. Pinned in `agent-loop` scenario 4,
where the stub's only control sits at node 121 behind 120 rows: with the role pass
removed the assertion reports `['file-000.txt', …]`. The live measurement is **Qt**
(Telegram); the GTK side is the stub, built from the measured Nautilus tree, not
re-measured live.

**(j) The third live run SUCCEEDED — and its two wasted steps were both our own
text, not the model's judgement. Fixed 2026-07-29.** "Añade un temporizador de 7
minutos con título Hola Manola": 11 steps, timer created, Clocks tiled with a
floating window over it. Two tool calls failed on the way, and the transcript names
the cause of each — read the log, not the vibe.

- **We taught a remedy we had already measured as broken.** Step 4 was
  `do_app_action Clocks "Hola Manola" SetFocus`, and the model did not invent it:
  `type_text`'s own description said *"Focus the field first (do_app_action …
  SetFocus)"*, and `nidara-type`'s focus-gate refusal repeated it — while
  `nidara-click`'s refusal already said the right thing (`focus_window`), and while
  entry (h) above records that GTK4 does not implement `Component.GrabFocus`.
  **Advice drift between sibling helpers, the same class as the double-`ok` bug in
  (a).** Now all four say the same thing, and the distinction is stated once,
  everywhere it appears: the WINDOW is focused with `focus_window` (the only verb
  that can); a CONTROL takes `SetFocus` only where the toolkit exposes it (Qt yes,
  GTK4 usually not); a NUMBER takes `set-value=N` and no keyboard at all. Pinned
  **statically** by `agent-loop` scenario 3d — no stub would have caught this, and
  a live run is not a place to discover our own documentation is wrong.
- **A refusal that names the remedy but not the target still costs three steps.**
  `type_text` → refused → `list_windows` → `focus_window` → retry. The helper knew
  which app was meant, so both `nidara-type` and `nidara-click` now resolve it and
  hand back `focus: {address, class, title}` — recovery is one call. The lookup runs
  **only on the refusal path**; the happy path must not pay for a second `hyprctl`.
- **`nidara-act`'s miss was still a dead end** — the `showing` list from (g) went to
  `nidara-click` only, and the two helpers are aimed by the SAME name, so a dead end
  in one is a dead end in both. It answered with a list of *applications*, which is
  the wrong question answered when the app has already matched. Now: app not found →
  `apps` (the only case where that list IS the answer); node not found → `showing`,
  same 40-name / 48-char / single-line filter as `nidara-click`.

Verified live (read-only paths only — no pointer verbs): a node miss on Clocks
returns 11 real control labels, an unknown app returns the app list, and both
refusals hand back `0x55c8c9cc6df0` — the exact address the model had spent two
steps discovering.

**(i) ~~Every Gemini tool turn died on step 2 — the reasoning signature was never
captured.~~ FIXED 2026-07-28.** Surfaced as "a JSON error from Google"; the log said
only `curl failed: exit=22 http=400`. Three things had to be fixed to even see it,
and the order matters if this recurs:

1. **The 400's body was being thrown away.** `--fail-with-body` was already there, so
   the provider's explanation WAS captured — and the log printed curl's useless
   `stderr="returned error: 400"` instead. Body first now.
2. **Root cause, measured against the live API** (three probes, not docs): the
   Interactions API **rejects a history whose `function_call` carries no signature
   anywhere**, with a bare `Request contains an invalid argument` that names no field.
   Verified positively too — a preceding `{type:"thought", signature}` step is
   accepted, and so is the signature placed on the call; only "neither" fails.
   The signature arrives as a **bare `{"signature": …}` delta with NO `type` field**:

   ```
   step.start {"index":0,"step":{"type":"thought"}}
   step.delta {"index":0,"delta":{"signature":"CiQBEU0y…"}}     ← here, untyped
   step.start {"index":1,"step":{"type":"function_call",…}}     ← NOT here
   ```

   The daemon tested `d.type === "thought_signature"`, a shape the API never sends,
   so it captured nothing and replayed unsigned calls. **`sig=0/1` in the step log
   was this, and it had been sitting in the log for weeks read as a curiosity.**

   **CORRECTION, 2026-07-29 — do NOT read `sig=` alone.** The first version of this
   entry said "treat `sig=0/N` on a Gemini turn as a defect, not a quirk", and that
   is wrong in the direction that wastes time: the signature rides the **thought
   step**, so `sigs` (which counts signatures on the CALL) is legitimately 0 on a
   perfectly healthy turn. The next live run — 11 steps, every request 200 —
   printed `sig=0/1` on all of them. A counter that reads identically whether or
   not the thing works is not telemetry. The step log now prints **`tsig=y|n`**
   beside it, and the genuine failure (neither place) gets its own named line:
   *"NO reasoning signature anywhere … the next request will be rejected"*.
   Pinned by `agent-loop` **scenario 3c**, whose stub is 3b's stream with the
   signature delta deleted (with an `assert` that the deletion actually happened,
   so a no-op replace cannot make it pass for the wrong reason).
3. **A dead end that made it worse:** the model had called `list_apps` — an ACTION
   from run_action's index — as if it were a tool, and got "there is no tool called
   list_apps", which is the least useful possible answer about a name that plainly
   appears in its prompt. The unknown-tool branch now checks the action index and
   answers `"list_apps" is an ACTION — retry as run_action with action="list_apps"`.

**Two wrong turns worth remembering, because both looked convincing.** The first
theory was "Gemini 400s on an undeclared function name in history" — tested against
`generateContent`, which returned **200**, so it was dropped. The second was "the
call id must be server-issued" — three id shapes were tried and all failed
*identically*, which is what pointed at something common to all of them. The
Interactions API's single generic error message makes bisecting the request the only
way through; `scripts/ci/agent-loop-test.py` now pins the outcome (scenario 3b,
verified failing against the old condition before being kept).

**(h) Three failures from the second live run (a 7-minute timer), all fixed
2026-07-28.** Read the transcript, not the vibe — every one had a mechanical cause.

- **"No puedo."** Twice, with both gates ON, before the user insisted. The model was
  reciting the system prompt's *"What you can do"* summary, which listed shell
  surfaces and windows and said nothing about driving other apps — while a rule two
  lines below tells it to answer that question **from the summary, without calling a
  tool**. So a capability missing from that sentence is one the model actively
  DENIES. The summary now grows with the gates. **Anything you add to computer-use
  has to be added there too, or it does not exist as far as self-description goes.**
- **7 minutes became 11 h 40 min (= 700 minutes).** GNOME Clocks' "Minutes" node is a
  `spin button` whose `actions` array is **empty**, so `SetFocus` failed, and the
  agent typed "7" blind — the digits landed on whatever had focus and concatenated
  with what was already in the field. Verified against a live GtkSpinButton: the
  widget reports `value=true component=true`, i.e. the number was always settable
  directly. `nidara-a11y` now reports a `value` block (current/min/max) for anything
  carrying the Value interface, and `nidara-act` takes `set-value=<n>`, reading the
  result BACK so a clamp is reported as `ok:false` with the real value rather than a
  cheerful lie. No new tool: `do_app_action` already passes `action` through, so this
  cost zero prompt bytes — only the descriptions changed (daemon + MCP, kept in step).
- **It clicked controls sitting UNDER its own panel.** The user called this a design
  fault and had asked for the fix long before: *the agent must know whether the
  island is open and be able to control it.* The island now reports what it COVERS
  (`IslandWindow.occupiedRect`, capsule + revealed mode, with the monitor connector
  so a multi-monitor consumer cannot compare across screens) via
  `dumpState.overlays.islandBounds`; `yieldInput begin` returns the same rect so
  `nidara-click` can flag a click that lands inside it **as a warning on a SUCCESSFUL
  action** — the click does land (the yield makes the surface click-through), it is
  the invisibility that needs saying. `setIsland <mode|closed>` is the exact-state
  verb. Resizing/reshaping the island from the agent is explicitly LATER (user).

**NO `focus` VERB — measured, not assumed, so do not add one back.**
`Atspi.Component.grab_focus` is the obvious companion to `set-value` and it returns
FALSE on GTK4 even with its own window already focused (checked against a live
GtkSpinButton with `hyprctl activewindow` naming the probe). GTK4 dropped ATK and its
AT-SPI backend does not implement `Component.GrabFocus`. A tool that always fails is
worse than no tool AND costs prompt bytes on every request. Focus a WINDOW with
`focusWindow`; to put a value somewhere, set the value instead of aiming a keyboard.

**(g) A miss now answers the next question.** `nidara-click`'s "no showing node
named X" was a dead end, and recovery cost a whole `query_app` round trip (measured:
2 of 11 calls in that run were guesses — `"page tab"`, a ROLE in the name slot, and
`"Start"`). It now returns `showing`: the short, single-line names on screen, free
because `nameOf` is already called for every node on that walk. **The filter is the
point, not a detail** — an accessible name is not a label (in Telegram it is the
entire message), so unfiltered this returned ~10 KB and would have cost more than
the round trip it saves. Live-checked against Telegram: 1157 bytes, 40 real control
labels.

**Found while verifying (a) live, and it decided how the Assistant's hover reads:**
a GTK tooltip is **not an accessibility node**. Hovering Nautilus's Back button
rendered the tooltip in a screenshot while the AT-SPI tree held zero tooltip-role
nodes before and after. So hover reveals state that a client WITHOUT VISION still
cannot read — the MCP descriptions say to use `screenshot` for tooltip text, which
would be useless advice for the Assistant (it gets a path, not an image). Its
`hover_app` description therefore says the tooltip text is unreachable **and to say
so to the user**; hover stays useful there for *provoking* UI — opening hover menus,
revealing controls, which are ordinary accessibles. Do not "fix" the absence of
tooltip nodes: it is GTK's, not ours.

**Not a gap, recorded to stop it being "fixed" again:** `screenshot` is reachable
by the built-in Assistant today (it is not in `HIDDEN_ACTIONS`) and returns a PNG
path the Assistant cannot see. That is FINE — "take me a screenshot" is a
legitimate user request the Assistant fulfils without vision. Do not hide it. The
only adjustment worth making is wording: the MCP description frames screenshots as
a way for an agent to *verify its own work*, which is true for a client with vision
and false for the Assistant. **Done 2026-07-27**, and in the cheaper place: the
`listActions` first clause the Assistant actually sees was already neutral, so the
correction is one line in the gated prompt block — *screenshot returns a file PATH,
you never see the image, never describe its contents*. It sits behind the
perception gate because that is when a model starts reaching for eyes.

### 37. Assistant file layer ("tier 1") — debt created 2026-07-27
The six daemon-local file tools shipped (see `state-and-ipc.md` for the frontiers and the
enforced invariants). What they left behind:

**(a) The fixed prompt roughly doubled and item 36(b) is now urgent, not theoretical.**
Measured: `sys` 1687→2688 b, `tools` 3893→7543 b ≈ **+1163 tokens on every step of every
turn**, against a `run_action` design that was squeezed to ~450 tokens precisely because
that cost is paid per request. Cache breakpoints recover most of it on paper, but the
Gemini lane was observed at `cached=0` on the FIRST step of each turn (implicit cache
expiring in the ~2 min between turns), so on that lane it is largely paid in full. The two
path lists inside `read_file`/`edit_file` descriptions are the largest single addition and
are the first dial to turn — they exist to buy the absence of a guess-and-retry round-trip
(break-even ≈ 25 requests), so measure before cutting them.

**(b) `MAX_STEPS` is now 16 with still no context compaction.** File reads make turns
genuinely longer, and a `read_file` result can be 24 KB (the `MAX_TOOL_RESULT` cap). The
existing prior-turn `RESULT_STUB` does not help WITHIN a turn. A long diagnostic
conversation will hit context limits before it hits the step cap. This is the same debt as
36(b) seen from the other side; do the turn cap / trim before raising `MAX_STEPS` again.

**(c) No IPC/MCP parity, on purpose — but re-check the reasoning if it ever bites.** File
tools are daemon-local because MCP clients bring their own. If Nidara ever grows a
non-MCP external consumer that needs them, that argument stops holding.

**(d) `reloadHyprland` is untested live.** Registration and the dispatch path were checked
in source only; it re-applies monitor config and the standing rule here is that
display-affecting commands are not verified by running them. Wants a human eye.

**(e) The `customize` skill is the only skill, and it is unversioned.** Nothing checks that
`skills/customize/SKILL.md` still matches the code — if the frontier changes and the skill
does not, the assistant confidently tells users the wrong ownership model. Consider a CI
check tying the writable-file list in the skill to `WRITE_FILES` in the daemon.

**(g) A turn IN FLIGHT is still lost to a shell restart — the daemon is a CHILD of
the shell.** Session persistence (36 v1.1) covers reload/crash/logout *between*
turns, which is every case that happens today. It does not cover the tier-2 case:
an assistant that edits shell source and reloads is killing its own parent, and
therefore itself, mid-turn. The fix is topological, not more persistence —
promote `bin/nidara-agent` to its own **systemd user service** (sibling, not
child) with a socket instead of stdio pipes; there is precedent in
`bin/nidara.service`. Deliberately NOT built yet: it trades the lazy-spawn
property ("an idle desktop shouldn't carry an extra gjs", and one holding an API
key) for survival nobody needs until tier 2 exists. Build it when tier 2 forces
it, and make "build → verify → reload" an explicit end-of-turn step at the same
time so the restart lands on a turn boundary the persistence already handles.

**(f) Legacy `~/.config/hypr/hyprland-user.lua` is writable but NOT git-tracked** — the
undo history only covers `~/.config/nidara`. Rare (pre-2026-07 installs), logged, and not
worth a second repo, but know it before promising a user "you can always undo".

**Conversation persistence / history / memory — deferred, user-confirmed 2026-07-20 ("leave it for
now, note it").** Current v1 behaviour (intended): the conversation lives in memory only — it PERSISTS
across closing/reopening the island and across compact mutations (the `AgentService` transcript + the
`AgentIsland` widget are session-long singletons; the island only hides on close, never rebuilds), and a
background turn keeps running when the island is closed. It is wiped by a shell reload / logout / reboot,
and by the "New conversation" reset (which also clears the daemon's `history`). NOTE the two histories
can desync: `AgentService.transcript` is the UI view; the daemon's `history[]` is the model context — a
daemon crash+respawn keeps the UI but loses the model's memory. The agreed roadmap (do NOT build until
asked):
- ~~**v1.1 — persist the CURRENT conversation**~~ — **DONE 2026-07-27.** Both halves, each owned by
  whoever holds the data: the daemon writes its neutral `history` to `session.json`, `AgentService`
  writes the `transcript` to `transcript.json`, both at the same turn boundary (the only point where
  the history is consistent — every `tool_use` has its result, and a half-written turn restored later
  would be rejected by the provider). **NOT under `~/.config/nidara/`, which is where this entry
  originally said to put it**: that directory became a git repo on 2026-07-27 (the write tools' undo
  history), so persisting there would commit the user's conversations, permanently, into a repo they
  never asked for. It lives in `$XDG_STATE_HOME/nidara/agent/` (0700) instead — a conversation is not
  configuration, and the shell log already sets the precedent for state outside `~/.config`.
  Two things worth knowing: the persisted history is the **stubbed** view (prior turns' tool results
  are already omitted from every request, so storing their full payloads would be megabytes the model
  will never see again) with `load_skill` results **exempt**, so a restored conversation still carries
  its rules; and `reset()` deletes BOTH files from the shell side, because the daemon is spawned
  lazily and "New conversation" on an idle desktop would otherwise reach a daemon that is not running
  — clearing the UI while leaving the model's copy on disk to be resurrected by the next message.
- **v2 — conversation history browser**: "New conversation" archives the current thread; a list to
  revisit past threads (`conversations/*.json`, auto title + timestamp). New UI surface (a submode or
  panel) → needs a design round.
- **v3 — long-term memory of FACTS about the user** (opt-in, big): extract → store → inject into the
  system prompt, à la Claude/ChatGPT memory. Distinct from the desktop-STATE memory the assistant
  already has (system prompt regenerates from dumpState/describeConfig/listActions each session). Must
  fit Nidara's privacy stance: opt-in, with UI to view/edit/delete what it remembers.
- Privacy note for v1.1+: stored conversations are potentially sensitive plaintext on disk — ship an
  easy "clear history" and consider making persistence a toggle.

**Provider picker — ✅ DONE 2026-07-21 (was deferred; shipped before the 0.5.0 tag, which was the
whole point).** Settings → AI now picks by **provider NAME** via `core/AgentProviders.ts`; the two wire
protocols stay internal. The load-bearing part was the **keyring slot**: the key is now stored under the
libsecret attribute `provider` (`google`/`mistral`/…) instead of `backend` (`anthropic`/`openai`) — with
a protocol-keyed slot, Google and Mistral (both openai-compatible) would overwrite each other's key and
the symptom is a 401 from a provider whose key the user just saved. Doing it pre-release was free; after
users store keys it is a migration. Also closed #36(a) via `brainModels` per-provider model memory.

**Two residual notes.** (a) `defaultModel` for the non-Anthropic providers is best-effort — only the
Anthropic id is verified against a first-party source (the `claude-api` skill); model ids churn, which
is exactly why the model field stays editable. Don't treat the table as authoritative. (b) A **native
Gemini backend** (a 3rd protocol, better tool-call/usage handling) remains optional and low priority —
the compat path already covers Gemini. Vertex AI is OpenAI-shaped too but needs GCP OAuth rather than a
plain key, so it is not BYOK-simple and is deliberately absent from the registry.

### 39. Built-in Assistant is NOT release-ready — polish backlog (2026-07-21)
**User's call after the first real end-to-end run against a live provider: "estamos muy lejos de
publicar esto… no sé si va a ser para la 5.0".** The skeleton works — it connects, streams, calls
tools — but the PRODUCT feel is absent. Treat the Assistant as unfinished regardless of what the
milestone says, and do not let a 0.5.0 tag imply otherwise.

**⚠️ Release exposure — decide before ANY tag.** Brain and face are already merged to `main` (#48,
#49). It is off by default (`brainProvider: ""` = no traffic, no key, empty state) and only reachable
via `Super+A`, so shipping it dormant is defensible — but it IS reachable, and the empty state invites
the user to configure it. Either accept that and say so in the release notes, or gate it behind a flag
until the list below is closed. Do not discover this question at tag time.

Ordered by what hurt most in the live run:

1. ~~**A turn can die in total silence.**~~ **ADDRESSED 2026-07-21** (same branch as the provider
   picker). Every abnormal end now paints: provider error, curl-level failure, empty completion, the
   `MAX_STEPS` cap (daemon side), daemon death mid-turn / failed spawn / failed write (shell side).
   `Turn.error` is its own field so an error arriving after partial text is no longer swallowed, and
   `failTurn()` re-opens the island when the failure happened in the background. The four daemon-side
   paths are E2E-verified against the mock. **Death mid-turn is now CONFIRMED LIVE (2026-07-25)**:
   a watcher tailed `nidara-ui.log` for the daemon's `turn start` line and `SIGKILL`ed it 1.5 s later,
   so the kill landed while a real Gemini turn was in flight (`POST … body=5658b` already out). The
   shell logged `daemon gone (signal 9) MID-TURN` and — verified by reading the screen, not the log —
   the error row was visible and mapped with `island.agent.error.died`. Do it that way rather than by
   hand: killing on a human's reaction time races the turn, and a screenshot would only prove pixels,
   not that the label is live. **Still unconfirmed: failed spawn / failed write** (needs a
   deliberately broken daemon path).
   See the invariant in `state-and-ipc.md`.
2. ~~**No telemetry on the agent path.**~~ **DONE 2026-07-21** — lifecycle, turn boundaries, every
   HTTP leg, every tool, and the daemon's exit status/signal, from both halves, into `nidara-ui.log`.
   Rules (prompt/reply/key never logged; stderr must stay inherited) in `state-and-ipc.md`.
   A bonus that fell out of it: curl's stderr used to be piped and dropped, so a dead endpoint
   surfaced as the generic "Request failed" — it now reads "Failed to connect to …".
3. ~~**Tool calls against Google's OpenAI-compatible path — UNVERIFIED HYPOTHESIS.**~~ **MEASURED AND
   FIXED 2026-07-21**, by the telemetry above, on the first try: `step 1: ok=true text=0c tools=1
   stop=end` — Gemini streamed the tool call and finished with `"stop"` instead of `"tool_calls"`, so
   the loop skipped it and ended the turn empty. The user's symptom was exact: *"only answers the
   first time, the second time it doesn't"* — the first turn needed no tool. Fix: execute tool calls
   when they are PRESENT (see `state-and-ipc.md`). This was the payoff for doing items 1–2 first;
   diagnosis took one `grep`, not a debugging session. **Second layer, same day:** with the call
   finally executing, Gemini 400'd the NEXT request — it requires its encrypted **thought signature**
   to be echoed back with the call (`extra_content.google.thought_signature`). Also fixed; see
   `state-and-ipc.md`. Two provider-specific quirks in one path is the real signal here: **Google's
   compat endpoint is a moving target**, and its own error text steers callers toward the Interactions
   API — a native Gemini backend is drifting from "optional" to "eventually necessary". Not building
   it yet, but that is the direction; log `sig=`/`finish=` are the early-warning instruments.
4. ~~**No sense of activity.**~~ **ADDRESSED 2026-07-21** (branch `agent-feel`). The root problem was
   not the missing animation but that the pending assistant bubble was HIDDEN (empty rows are
   hidden), so the transcript showed literally nothing during the wait — a blank panel where the
   user is actually looking. Now: the pending bubble holds a three-dot pulse until the first token
   lands (`common/PulseDots.ts`), the capsule glyph breathes while a turn is in flight (the only
   sign of life when work runs with the island closed), and a tool chip's dot breathes while that
   tool is RUNNING, settling when its result arrives. Shared refcounted driver — see
   `design-system.md`. **Still open under this heading — but only for ONE of three cases** (split
   2026-07-25; the original wording overstated it). A turn ends with no positive beat: the dots stop,
   the glyph stops breathing, the header switches to the token count — all absences, no "done".
   Case by case:
   - **Island closed, work in the background** → already handled, and well: `AgentService.ts`
     expand-on-finish pops the island open with the answer when the desktop is otherwise idle.
   - **Island open, user watching** → the arriving text IS the beat, same as every chat UI
     (ChatGPT, Claude). Adding a chime/flash here would be noise. Deliberately nothing.
   - ~~**THE REAL HOLE: the turn finishes while another overlay is open**~~ **CLOSED 2026-08-01**,
     and not by the fix this entry proposed. The plan was an "unread" mark on the CAPSULE, which
     would have been a mechanism serving one case. The island's INDICATOR ROW made it a property of
     something already on screen instead: `AgentService.unread` (`"answer" | "error" | null`) is set
     at turn end exactly where expand-on-finish stands down, cleared by `island_mode === ISLAND_AGENT`
     (in the service, so no route into the island can leave it stale), and painted as a badge on the
     assistant's chip — which is already there, because a configured assistant is always indicated.
     **It covers the silent ERRORS too** (`failTurn`'s suppressed branch, the half this entry never
     mentioned), badged in danger colour: an error and an answer are not equally good news. The
     lesson is the one the user made the call on: a general surface absorbs the special case, so
     wait for it rather than patching the case alone.
5. ~~**Replies ignore the UI language.**~~ **The item was WRONG — reframed by the user 2026-07-21.**
   The desired behaviour is the opposite of what it asked for: **the assistant replies in the language
   of the MESSAGE, and follows the user if they switch. The desktop locale is a hint for the ambiguous
   case, never the rule** — running an English desktop and talking to it in Spanish is normal, and the
   locale says nothing about the language of a given sentence. Live behaviour already did the right
   thing, but the system prompt said `Reply in the user's language (LANG=…)`, which defines "their
   language" AS the locale — a more literal model would have obeyed it and answered in English.
   Prompt fixed to state the rule properly. **Lesson for anything locale-driven in the shell: a
   configured locale is evidence about the user, not an instruction about the current interaction.**
6. **Gemini 3 Flash Preview essentially does not cache for us — and shrinking the prompt may have
   made it worse.** The `cached=` instrument settled this after two wrong readings of my own (first
   "never caches", then "caches fine, 85%" off a single hit). **The real number: 1 cache hit in 36
   requests.** Our side is verified correct — consecutive request bodies share a byte-identical 99%
   prefix (recorded and diffed), so nothing we send invalidates it. Two documented reasons on
   Google's side: Gemini 3 requires a **4,096-token minimum** for implicit caching, and there is an
   **open report that implicit caching does not work on `gemini-3-flash-preview` when tools are
   defined** — and we always define tools. Fits the data: the single hit was the one request clearly
   above 4k (4717 → 4022 cached).
   **The uncomfortable irony: the trim took step 1 from 4403 → 2885 tokens, i.e. from above that
   threshold to below it.** Do NOT respond by padding the prompt to game the threshold — fragile,
   model-specific, and it bets on a path Google itself reports as broken. The trim is an
   unconditional saving (fewer tokens sent is less paid, cache or no cache); caching is a bonus this
   preview model does not reliably deliver. A non-preview model, or Anthropic (explicit
   `cache_control`, implemented but UNVERIFIED — no key), should behave better.
   **General rule this cost three wrong conclusions to learn: judge a provider behaviour over a
   RUN of requests, never one reading.** Established regardless: the real cost driver is STEP COUNT
   (an 8-step turn cost ~25k input tokens).
7. **Anthropic caching: two breakpoints — and the premise of this item was WRONG (corrected
   2026-07-25).** A `cache_control` marker caches everything from the start of the request up to
   itself, and render order is tools → system → messages. There is a **minimum cacheable prefix**
   below which a marker silently does nothing (no error, `cache_creation_input_tokens: 0`) — and that
   minimum is **not flat and not monotonic across generations**, which is what the earlier version of
   this item got wrong (it assumed 4096 everywhere): **512** on Opus 5 / Fable 5, **1024** on Opus 4.8
   / Sonnet 5 / Sonnet 4.6 / Sonnet 4.5, **2048** on Opus 4.7, **4096** on Opus 4.6/4.5 and Haiku 4.5.
   Our tools + system span is **~1,213 tokens** and never grows, so the same marker is **live on Opus
   5, borderline on Opus 4.8, and dead on Opus 4.7 and older** — i.e. "the system marker can never
   fire" was true for the models of the day and is false for the current default. The generalisable
   half stands: **a marker over a fixed-size prefix below the minimum is inert; only a marker after
   something that grows can ever engage** — hence `markNewestTurn()`, a second marker on the newest
   turn's last content block (live turns measured 3.0–4.9k tokens). It must never land on a thinking
   block; see `state-and-ipc.md`.
   **Still NOT verified against a live Anthropic key** — the logic is unit-checked and the request
   bytes are asserted in CI, but nothing has watched `cache_read_input_tokens` come back on the wire.
   **Do NOT pad the prompt to cross a threshold** — the fix is where the marker goes, not how fat the
   prompt is, and padding for the older models would buy nothing on the newer ones. Known limit
   accepted: a breakpoint looks back only ~20 content blocks, so a tool-heavy turn that adds more than
   that simply misses.
8. **A native Gemini backend — evidence accumulating, decision NOT taken (2026-07-21).**
   Three separate failures in one afternoon all traced to Google's OpenAI-*compatible* layer, not to
   the model: (a) tool calls streamed with `finish_reason: "stop"` instead of `"tool_calls"`, so calls
   were dropped; (b) Gemini 3's thought signature had to be echoed back or the next request 400s;
   (c) implicit caching that we cannot influence — no marker to place, 1 hit in 36 requests across two
   models. (a) and (b) are translation artefacts of the compat shim; (c) is a capability the compat
   path simply does not expose (Google's own API has explicit cached-content, with real control).
   A native backend would address all three — and cost a THIRD wire protocol to maintain, against a
   standing rule of "Anthropic native, everything else via compat". **Not proposed for now.** Recorded
   so the decision is made against the accumulated evidence rather than the next surprise. Revisit if
   a fourth compat-specific defect appears, or if token cost on Google becomes a real complaint.

9. **We cannot currently tell "no cache" from "cache not reported" on Google — settle it before
   designing anything else around caching (user's call 2026-07-21: "define it properly before doing it
   wrong, or doing it three times").** What is established: the field we read
   (`usage.prompt_tokens_details.cached_tokens`) is real and Google does populate it — a single
   reading of 4022 proves the plumbing. What is NOT established: whether a `0` is a measurement or a
   silence. From inside the daemon those are indistinguishable, so no amount of further log-reading
   settles it. **Method to use before touching caching again** (this is the process that three wrong
   conclusions in one afternoon earned):
   1. **Dump the provider's RAW usage object once**, not the one field we extract — if Google reports
      cache under another key in the compat layer, our instrument reads 0 forever while caching works.
   2. **Judge over a RUN, not a sample** — the three wrong conclusions each came from one reading.
   3. **Confirm against an INDEPENDENT source** (the provider's own billing/usage console) before
      concluding. Self-reported telemetry cannot validate itself.
   4. **Never design around unverified provider behaviour** — and never pad, restructure, or add a
      protocol to chase a discount that has not been observed end to end.

10. **The daemon's user-facing strings are English-only.** Every message it emits — "The answer was cut
   off…", "The assistant kept repeating…", relayed provider errors — is a hardcoded English literal,
   while the assistant itself answers in the user's language. It is a separate process with no access
   to `core/i18n`, so the fix is either passing the locale's strings in at spawn or moving these
   messages to the shell side (`AgentService` already owns two of them via `t()`). Not urgent, clearly
   wrong.
11. **Tool results ride in history and are resent every later request — COMPACTED, plus old turns
   STUBBED.** The island truncates a result to 200 chars for display, but `history` keeps the whole
   thing. Two lossless mitigations, both current: `compactJson()` on tool output (listWindows −32%,
   listApps −25%), and `historyForRequest()`/`RESULT_STUB`, which replaces the CONTENT of tool results
   from turns BEFORE the current one with a short stub (structure, ids, pairing, thought-signatures all
   intact) so a `listApps` whale stops riding every later request forever. Note the action catalogue is
   NO LONGER a history result — since 2026-07-23 it lives in `run_action`'s fixed (cached) description,
   so `describe_settings`' schema is the main catalogue that still lands in history as a result. What
   remains genuinely lossy and deliberately NOT done: capping a large CURRENT-turn result. `step N: POST
   host body=Xb (sys=Yb tools=Zb hist=Wb)` tells you which part is actually growing before anyone
   optimises on instinct.
12. **The island's token counter is CUMULATIVE and doesn't say so (2026-07-21).** It shows the whole
   conversation's usage; the user read "2k tokens" as the cost of the turn they had just sent (that
   turn was 1,078). Not wrong data, ambiguous framing — a number in a chat header doesn't announce
   its own scope. **Deferred by the user ("lo dejamos así de momento"), with their idea recorded:
   put the PER-TURN detail in a tooltip** and leave the header showing the conversation total, which
   is what actually reaches the bill. If picked up: use the house tooltip (`common/Tooltip.ts`) —
   there are no native GTK tooltips in this shell — and the per-turn numbers already exist in the
   daemon's `turn end` log line, they simply aren't carried to the UI (only the running totals are,
   via `done`). Cheapest shape: add the turn's own usage to the `done` payload alongside the totals.
13. **Provider catalogs can list dead models.** Google's `/v1/models` returned `gemini-2.0-flash-lite`,
   retired — picking it 404s. The catalog exposes no retired flag, so this cannot be filtered
   reliably; the model field stays free text on purpose.
14. ~~**The bubble is the concatenation of every reply in the turn, and the answer lands
   off-screen.**~~ **FIXED 2026-07-29** — narration moved onto `ToolCall.interim`, chips render
   before the answer. See `state-and-ipc.md`, "Bubble anatomy". **Residual: NOT pinned by CI, and
   it is the kind of thing that regresses silently.** The ordering is three `append` calls in
   `makeBubble` and the derivation is one `case` in a subscribed handler — reverse either and
   nothing errors, nothing fails typecheck, and the boot smoke still passes, because the shell has
   no test runner and `agent-loop-test.py` only drives the daemon. A shell-side harness would cover
   this and a good deal else (`AgentService`'s event reducer is pure data), but standing one up is
   its own decision and was not made here.

### 37. No `NidaraScroller` in the kit — every surface re-solves the scrollbar (2026-07-21)
**User's call, deferred by them ("not now, but we have to"):** the scrollbar is rebuilt from scratch
on every surface that scrolls, so it looks and behaves differently in each one and the same bugs get
re-litigated. Three separate hand-rolled versions today: `.nc-scroll.nc-transparent-scroll`
(`_control-center.scss`), the Settings lists (`overlay_scrolling: false` + `_reset.scss`), and
`.agent-scroller` (`_bar.scss`). Each re-derives the lane, the trough reset and the flush pin.

**What bit us here (2026-07-21, twice in one sitting)** and what the component must encode:
- The `_reset.scss` shell scrollbar is scoped by **ID** (`#nidara-bar scrollbar slider`, (1,0,2)).
  Any per-surface override written as a bare class (`.agent-scroller scrollbar slider`, (0,1,2))
  **silently loses** — the CSS looks right, applies nothing, and you debug geometry that was never
  in play. A surface override MUST sit inside its window scope (commandment 2 gives you the ID for
  free — which is the real reason that commandment exists here, not tidiness).
- The default GTK overlay bar floats **inset** from the edge: the visible "gap on the right" comes
  from Adwaita's `trough` margins, not from the slider's width. Fixing it means resetting the
  trough, not shrinking the slider.

**Hover growth is a THIRD trap, and the numbers matter** (extracted from the gtk4 gresource, not
guessed): Adwaita's overlay indicator is `min-width: 3px` at rest via
`scrollbar.overlay-indicator:not(.dragging):not(.hovering)`, but on hover that rule stops applying
and the BASE `scrollbar > range > trough > slider` takes over — `min-width: 8px` **plus
`border: 4px solid transparent`** (invisible, 8px of real width) ≈ 16px, plus a `#313131cc` track.
An override that only sets `min-width` does NOT stop the growth; it must also kill the `border`.

**Open nit, user-deferred to this component (2026-07-21):** pinned flush the bar reads as slightly
OUTSIDE the panel near the rounded corners — the lane runs to the glass edge while the squircle
curves inward, so the slider's travel extremes overhang the curve. The component should stop the
lane ~3–4px short of the glass edge (or inset by the corner radius at the extremes). The user's
verdict on the current state was "better, but maybe too far right — leave it for the component".

Shape when built: `NidaraScroller` in `ui/lib/nidara-kit/` owning lane width, trough reset, flush
pin, thin slider and the hover behaviour, with the three call sites migrated onto it. Universal
reusables are `nidara-*` in the kit, never per-surface classes.

### 38. ~~`queryUI` is blind to the Activity Island~~ — NOT REPRODUCIBLE; it was a measurement error (2026-07-21, retracted 2026-07-25)
**The bug does not exist.** With the island open and at rest, `queryUI` sees its whole subtree:
`.agent-panel` 1, `.agent-transcript` 1, `.agent-scroller` 1, `.agent-bubble` 2, `.agent-error-text` 1,
paths resolving through `MorphRevealer.top > … > GtkBox.agent-panel`. A snapshot-painted surface is
still mapped at rest, so `core/UITree.ts` descends it fine. Do NOT "fix" the walk.

**What actually happened, and it is a trap worth keeping:** an outside click dismisses the island —
and typing `nidara-ipc queryUI` in a terminal requires clicking that terminal. (At the time this was
the `overlay-catcher`; since 2026-08-05 it is the compositor's focus grab. Same trap.) The island was closing *before* the query ran, so `queryUI` correctly
reported `count: 0` for a surface that was no longer on screen. This is exactly the confusion the
original entry warned about one line later, and it caught its own author twice more on 2026-07-25.

**Method rule for introspecting any dismiss-on-click-outside surface:** open it and query it **in the
same shell invocation** (`nidara-ipc toggleAgent; nidara-ipc queryUI …`), and read `dumpState`'s
`overlays.island` **in that same pass** — otherwise you cannot tell "not on screen" from "traversal
broken". Both return `count: 0`. Sanity-check the walk itself against a class that is always live
(`.bar-centerbox`).

## Resolved — rules that still apply

These were paid down; the *rule* remains:
- **(resolved 2026-07-10) Never call `AstalGreet.login()` — use the greeter's `lib/greetd.ts`.**
  Upstream's `Request.send()` RETURNS greetd's `{type:"error"}` reply as an object (throws only
  on socket/JSON failures) and `login_with_env()` discards every response, so a wrong password
  "succeeds": the card quit()s, greetd sees "greeter exited without creating a session" and
  terminates, systemd restarts it — TTY flash, fresh greeter, no error shown. It also never
  `cancel_session`s the failed attempt, breaking the next `create_session`. `lib/greetd.ts`
  drives the same Request classes but checks every response (throwing typed `AuthError`) and
  always cancels on failure. VM-verified both paths 2026-07-10. Upstream PR candidate (like the
  tray fix, Aylur/astal#451). Related greeter rule: re-enable widgets BEFORE `grab_focus()` —
  grabbing an insensitive entry silently fails and strands keyboard focus.
- **(was #26 + #31, resolved 2026-07-10) Wrapper logs/state are per-user; new users bootstrap
  at first login.** Every `bin/*` wrapper writes its log (and runtime state) to
  `${XDG_RUNTIME_DIR:-/tmp}/nidara-*` — NEVER a fixed `/tmp` name or a root-only path: on a
  multi-user system the second user can't write the first user's file, and because bash skips
  a command whose redirect fails, the wrapped binary silently never launches (exactly how the
  lockscreen died on every install, 2026-07-03). Redirects into logs must never gate the exec.
  Per-user seeding: `bin/nidara` runs `nidara-setup --user` at session start when
  `~/.config/nidara` is missing (first-login bootstrap, issue #23 — details in
  dev-workflow.md). **Any new per-user seed belongs in nidara-setup's per-user section** —
  never in install.sh directly — so install, update AND first-login all apply it.
- **(was #27, resolved 2026-07-05) Media player selection + cover art live in `core/MediaService.ts`.**
  Widgets must NEVER go back to `get_players()[0]` — the facade owns WHICH player the shell
  shows: auto heuristic (a PLAYING player beats paused ones; ties go to the most recent
  playback-status change) plus a manual pin (source-selector glass menu in the media detail
  panel, `pinPlayer(busName|null)`; session-scoped, auto-resumes when the pinned player leaves
  the bus). Cover art goes through `resolveCoverArt` — chain: `file://` → a bare path →
  `data:` (decoded once into `~/.cache/nidara/media-art/`) → `http(s)` (async curl into the
  same cache, negative-cached on failure so a dead URL isn't retried). The chain used to start
  at AstalMpris's own `cover_art` cache; that step went with the lib on 2026-08-17 and nothing
  was lost, because the two kinds it did NOT cover (`data:`, and `https:` without GVfs) are the
  common ones — it only ever logged 2× `player.vala … Failed to cache cover art` per track for
  them. `MediaIslandContent` shares ONE `MediaState`
  singleton across tile rebuilds (a per-build state leaked its player subscription). Test with
  `scripts/dev/fake-mpris.js` (see `dev-workflow.md`) — heuristic + both art paths were
  verified live with it (2026-07-05).
- **Layer popups blur via `blur_popups`, NOT the layer's `blur` (verified 2026-06-26).** A `Gtk.Popover`
  on the dock/bar (the glass tooltip, the dock context menu) is a SEPARATE surface = a *popup of a layer*.
  The `blur` layerrule only blurs the layer surface itself + its `Gtk.Overlay` children (CC/NC/system
  menu/overview — that's why those blur and aren't popovers). Layer popups need a SEPARATE `blur_popups`
  layerrule (added to `nidara-bar`/`nidara-dock` in `hyprland.lua`); `decoration:blur:popups` only covers
  popups of WINDOWS (Settings' native dropdown). And the popup's content must clear `popups_ignorealpha`
  (0.30) — the shared `common/GlassBubble.ts` painter floors its glass at 0.38, used by BOTH the
  tooltip and the **dock context menu** (a `Gtk.Popover` + glass bubble + the unified `renderMenuModel`
  rows — no longer a `Gtk.PopoverMenu`). It's a Hyprland *config* change → needs a Hyprland reload,
  not Super+Shift+R.
- **Stable updates are STATELESS (2026-06-19).** There is NO per-user source clone. The old
  model kept a managed `~/.local/share/nidara/src` per user while `/usr/share` was shared →
  divergent src, "last sudoer-updater wins" globally. `nidara-update` now shallow-clones the
  newest release tag (default branch pre-release) to a throwaway temp, builds, installs,
  discards (~6 MB clone, negligible). **Rule:** never reintroduce a persistent per-user source
  copy as the update source; the runtime is system-wide, so the source of truth is the git
  remote + `/usr/share`. Dev installs are the one exception (they update from the developer's
  own registered clone via `.dev`/`.source`). `install.sh` system mode migrates away any
  legacy `src`/`.source`.
- **(was #16, resolved 2026-07-02) `install.sh` re-syncs a Nidara-owned `/etc/greetd` on update.**
  Fingerprint-gated, NOT bare enabled-state: the block runs when `ACTIVE_DM=none` OR greetd is
  enabled AND `/etc/greetd` is recognizably ours (`config.toml` → `hyprland-greeter.lua`, or the
  `.lua` launching `nidara-greeter`). A foreign greetd (tuigreet/gtkgreet/ReGreet) or foreign DM is
  left untouched, with a hint printed. Folded into the same fix: the stale
  `/usr/share/nidara/wallpaper.png` is removed (the refreshed greeter `.lua` points at
  `wallpaper.jpg`), and the pacman dep list got its own fingerprint (`/usr/share/nidara/pins-pacman`)
  so a changed list runs phase 1 on update (new deps like playerctl now reach updated installs)
  while unchanged-list updates keep skipping it. Validated E2E in the VM 2026-07-02: update from
  the 06-22 snapshot refreshed `/etc/greetd`, installed playerctl, removed the stale png, greeter
  booted; the immediate re-update took the fast path ("pins and package list unchanged").
- **(was #16) Settings is a normal window.** `openSettings` opens/raises it — NOT a toggle
  (re-invoking just raises; it closes only via its own close button). Don't turn it into a
  toggle-hide. **Raising across workspaces:** `gtk_window_present()` alone does NOT jump to the
  window when it's on another workspace — its Wayland activation is ignored by Hyprland
  (`misc:focus_on_activate=false`). So `raiseSettings()` (app.ts) present()s *and* dispatches an
  explicit `hyprlandState.focusWindow(addr)` (found by class `io.Astal.ags` + title
  `Nidara Settings`), which switches to its workspace like clicking any running dock app.
  Same pattern applies to any normal (non-layer-shell) window the shell wants to summon.
  `toggleSettings` is kept as a **compat alias** (the `hyprland.lua` Super+S
  keybind / user scripts) — don't drop it without updating those. `status.settings_open`
  (→ `dumpState.overlays.settings`) is wired to the window's `notify::visible` in
  `Settings.tsx` — keep it honest. There's deliberately **no IPC to CLOSE** Settings: restart
  the shell to reset state in a verification run, and use `queryUI` (a `nidara-settings-window`
  toplevel present = open) as the ground truth.
- **(was #10) Boot-time `g_list_store_remove` CRITICAL (astal-tray)** fixed upstream:
  Aylur/astal#451 merged 2026-06-12 (kotontrion's pending-items pattern, verified A/B/A on
  the reproducing machine: stock = 1 CRITICAL/boot, patched = 0/8 boots) and `ASTAL_REF` now
  pins past it. A boot CRITICAL from `libastal-tray.so` reappearing means a stale Astal
  build — re-run `install.sh` so the pin rebuild kicks in; don't chase it in shell code.
  **Testing a patched Astal lib gotcha (reusable):** the installed typelib embeds the
  **absolute** `.so` path, so `LD_LIBRARY_PATH` alone won't load your build. Point
  `GI_TYPELIB_PATH` at the build dir's typelib — and if that one embeds a prefix you can't
  write to (`/usr/local/lib`), binary-patch a copy with a same-length `/tmp` path (python
  `bytes.replace`, assert equal lengths) and place the patched `.so` there. **AND**:
  `/usr/bin/nidara-ui` PREPENDS `/usr/lib:/usr/local/lib` to `GI_TYPELIB_PATH`, so a
  systemd `Environment=` drop-in never wins — override `ExecStart` in the drop-in (replicate
  the dev launch with your dir FIRST), and verify the loaded `.so` in
  `/proc/<gjs pid>/maps` before trusting any result.
- **(was #15) `ui/shell/widget/` rename** done 2026-06-11: `surfaces/` (bar, dock,
  control-center, settings, overview, prism, app-grid, about), `widgets/` (auto-registered
  atomics) and `common/` (shared pieces) are now top-level siblings of `core/`/`styles/`.
  greeter/lockscreen keep their own `widget/` dirs on purpose (no widget/widgets ambiguity
  there). Docs/paths in skills + README updated; don't reintroduce a `widget/` dir.
- **(was #13) Bluetooth pairing agent** is implemented: `org.bluez.Agent1` lives in
  `BluetoothService` (`registerPairingAgent`), the dialogs in the Bluetooth page. Real-device
  pairing (passkey/PIN flows) is still UNVERIFIED on hardware — D-Bus policy only lets root
  call agent methods, so the dbusmock template can't exercise it (see `architecture.md` for
  the `sudo busctl` recipe).
- **Dock H/V** is deduplicated — fix dock logic in `DockCore.tsx` / `DockAxis.ts`, never the
  7-line wrappers.
- **Accent colors** live only in `ui/lib/accent.ts` — add/change them there.
- **Greeter ↔ lockscreen ↔ shell** share `ui/lib/accent.ts` + `ui/lib/users.ts` + `ui/lib/wallpaper.ts`
  + `ui/lib/avatar.ts`, and since 2026-08-10 also **`ui/lib/styles/_components.scss`** — the kit's
  own stylesheet, which the two login surfaces now `@use` (see "The greeter wears the kit" below)
  — and since 2026-08-09 (see #57) **`ui/lib/styles/_tokens.scss`** (the
  design system's mode-independent half — type ramp, spacing, motion, radius ladder),
  **`ui/lib/tokens.ts`**'s `LOCK_GLASS` (the numeric half of the glass mirror the lockscreen's
  painter needs) and **`ui/lib/icons.ts`** (the shipped icon set, for the two bundles with no
  `core/`). Reach for `ui/lib` before copying anything into a bundle
  (Settings → Users consumes `users.ts` too — don't reintroduce a per-surface passwd parser);
  `lib/i18n.ts` stays separate per bundle on purpose (different config paths / superset).
  Both mini-catalogs (greeter 12 keys, lockscreen 7) cover the full 12-language set,
  including pt-PT, with the same LANG-prefix detection chain as the shell (which now
  also carries pt-PT — see `core/i18n/index.ts`) plus one extra rule: `pt_br` → pt-BR
  before the generic `pt` → pt-PT. Power/password terminology mirrors the shell catalogs
  (`bar.system-menu.*`, `settings.users.password`) — keep them in lockstep when either
  side changes. The greeter's language dropdown sets the GREETER's own language only
  (persisted in `greeter-prefs.json`); the session language comes from
  `/etc/locale.conf` via Settings → Language — greetd starts sessions with an empty
  env, and the unprivileged greeter can neither `localectl` nor write other users'
  homes. (Future idea, deliberately out of scope: let the greeter pick set the session
  language — needs a privileged path.) Since the date-locale fix, the greeter also
  aligns its PROCESS locale with that language (`initProcessLocale()` — clock date
  names via LC_TIME + Pango's CJK face selection; no-pref fallback reads
  `/etc/locale.conf`, so the login screen speaks the system language out of the box);
  mechanics + the GTK-resets-setlocale gotcha in dev-workflow.md "Fonts & CJK
  variants".
- **`noto-fonts-cjk` is a hard dep** (install.sh §1 + PKGBUILD, since the i18n round-2
  PR): the zh-CN/ja catalogs AND the 简体中文/日本語 endonyms in the language pickers
  render as tofu boxes without it — caught in the 07-13 VM sweep (a clean Arch ships
  no CJK font; ~300 MB installed, the honest cost of shipping those languages).
- **Shell pt-PT catalog SHIPPED (07-13)**: `ui/shell/core/i18n/locales/pt-PT.ts`
  (621 keys, European norm — utilizador/palavra-passe/ficheiro/ecrã/rato/eliminar/
  definições/controlo, enclisis, `a + infinitivo` instead of gerund) wired into
  `core/i18n/index.ts` (import + map entry + `detectLanguage()` reorder: `pt_br` →
  pt-BR BEFORE the generic `pt` → pt-PT, mirroring the greeter/lockscreen chain) +
  README counter 11 → 12. Not yet native-reviewed (same gate as the other 11
  languages — see the translation-wave native-review follow-up). Same shape of
  future candidate: zh-TW (today `zh_TW` → zh-CN).
- **The bulk-translated locales owe 84 keys each, and that number is now WRITTEN DOWN**
  (2026-08-17). `en`/`es` carry 698 keys; the other ten carry 614. The gap is mostly the
  Assistant surface (`settings.ai.*`, `island.agent.*`, 57 keys) and it is not new — v0.6.0
  and v0.7.0 both shipped it. What was wrong is that it moved from 82 to 84 across those two
  releases with nothing recording it, because the workflow's "defer the other ten to a bulk
  pass" had no artifact and therefore no floor. `ui/shell/core/i18n/translation-state.json`
  is that artifact and `scripts/ci/i18n-check.mjs --check` is the CI gate; the debt is
  allowed, but it cannot move without the number moving in the PR's own diff.
  **The gate also catches the failure mode nothing could see before**: a key whose English
  was rewritten AFTER it was translated. That one is worse than a missing key, because a
  missing key falls back to English and looks obviously untranslated, while a stale one
  renders a fluent sentence that is no longer true. Seeding the ledger from git history
  found two live cases — `settings.region.locale.lang.desc` / `.regional.desc`, rewritten
  on 08-16 to draw the system-wide-vs-account distinction while all ten locales still said
  "requires a session restart". Fixed in the same change. Workflow: `--sync` after touching
  English (bookkeeping, never claims a translation is current), `--translated <locale>`
  after actually translating one. Do NOT rebuild the ledger by deleting it and re-syncing —
  with no prior basis every translation is declared current and outstanding drift vanishes.
- **Clock day/month names come from LC_TIME via GLib `%a/%A/%b/%B`** — every installed
  locale is localized for free (the clock follows the "Regional Format" setting, like
  Gtk.Calendar and macOS/GNOME). `formatDatePart()` derives the date order from the
  locale's own `%x`: day-first, month-first, **or year-first** (zh_CN/ja_JP render
  `%x` as `2000年01月02日` — added when those two languages were translated, since the
  older day-first/month-first-only probe silently produced garbage, e.g. the numeric
  format read "01年02年2000"). Year-first also captures the three separator/suffix
  literals (年/月/日) as regex groups, so `short`/`short-year`/`long` assemble in
  native order ("{month}{day}日 {weekday}") instead of the Western comma template.
  `%a/%A/%b/%B` are `.trim()`-ed too — some locales (ja_JP's `abmon`) pad abbreviated
  names to fixed width for tabular alignment, which otherwise leaks a stray space.
  It's triplicated across `ui/shell/core/i18n/dateNames.ts`, `ui/greeter/lib/dateNames.ts`,
  `ui/lockscreen/lib/dateNames.ts` (separate ags bundles) but is still PURE LOGIC — no
  per-language data, so adding a language needs zero changes there, CJK included.
  Only the `settings.region.date.*` preview labels are hand-localized per catalog and must
  match `formatDatePart` output for that language's typical locale — when it matters,
  check `/usr/share/i18n/locales/<locale>` (glibc's own source) directly rather than
  guessing. Caveat: the clock follows LC_TIME, not the in-app UI-language toggle (they
  diverge only if the user sets a Regional Format ≠ their UI language, which is
  correct), and the target locale must be generated — nidara-setup generates the 12
  shipped `xx_XX.UTF-8` locales in `/etc/locale.gen` + `locale-gen` (idempotent,
  system-level, skipped by `--user`), which is also what makes Settings → Language
  autocomplete them (`localectl list-locales` only lists generated ones).
  **Known remaining gap:** CJK
  weekday placement/parenthesization conventions differ further within the family
  (e.g. Japanese commonly parenthesizes: "4月6日(月)") — the current space-separated
  rendering is generic and correct, not idiomatic polish; left for native review.
- **Wallpaper resolution is centralized** in `ui/lib/wallpaper.ts` (`resolveWallpaper(surface)`:
  per-surface override → global `path` → `/usr/share/nidara/wallpaper.jpg`, each step
  existence-checked). The lockscreen paints its own copy (session-lock covers awww); shell +
  greeter paint via awww with their own `.lua`-side default fallback. The
  `~/.config/nidara/wallpaper` JSON reserves a `surfaces` block for future per-surface
  wallpapers from Settings — `WallpaperManager._save()` merge-writes so it never clobbers
  keys it doesn't own.
- **`getDefaultUser()` is greeter-ONLY** (pre-login, no session). The lockscreen runs as the
  locked session's owner and must use `getCurrentUser()` / its own config dir — using
  `getDefaultUser()` there once pointed PAM at the first /etc/passwd user, locking every
  other user out of their own session. Inside the greeter prefer `getPreferredUser()`
  (`ui/greeter/lib/greeter-prefs.ts`): the last user who logged in from this greeter
  (persisted as `lastUser` in `greeter-prefs.json` on successful auth), falling back to
  `getDefaultUser()`. LoginCard preselects it (matching against its own `users` array —
  the switcher chips compare by object identity) and app.ts/Clock.ts read that user's
  appearance/region config. For user config the greeter can't read (700 homes),
  the shell mirrors world-readable copies to `/var/tmp/nidara/` (`appearance.json` from
  ThemeManager, `region.json` from RegionConfig); greeter readers try home → mirror.
- **Greeter home = `/var/lib/greeter`, enforced by nidara-setup.** Arch greetd's sysusers
  ships the `greeter` user with passwd home `/` and creates no dir — with that, greeter
  artifacts (Hyprland's own config discovery, D-Bus-activated services like dconf, which
  inherit the LOGIN env rather than the .lua's `hl.env`) land as dotfiles in the
  filesystem root, and greeter prefs could never persist (the greeter can't mkdir under
  root-owned `/var/lib`). nidara-setup therefore creates `/var/lib/greeter` (greeter-owned),
  aligns the passwd home via `usermod -d` (idempotent; tolerates a busy greeter and
  converges next run), and sweeps a stray greeter-owned `/.config`. `greeter-prefs.json`
  (locale/kb) lives there — always read it via `GLib.get_user_config_dir()`, never a
  hardcoded path (`hyprland-greeter.lua` also sets `HOME`/`XDG_CONFIG_HOME` to the same
  place as belt-and-braces). The `~greeter/.config/hypr/hyprland.lua` symlink is only a
  fallback; the operative pointer is `HYPRLAND_CONFIG` in greetd's `config.toml`. Verified
  E2E in VM 07-09: home migrated, greeter boots, locale pref survives reboot.
- **`Status.ts` exclusion** — add a new overlay's `_field → notify` to `EXCLUSIVE` and call
  `closeExclusive(...)`; don't touch the other setters.
- **Repo weight** — history was rewritten (.git 342→95 MiB); old clones must re-clone. Don't
  commit binaries: the app bundles (`ui/*/build/*`) and every `style.css` are gitignored too —
  `install.sh` rebuilds them from source on the target. Verify pngs / build artifacts stay git-ignored.
- **Sliders** — one Cairo `makeSlider` (`nidara-kit/slider.ts`); no native `Gtk.Scale`,
  no `PillSlider`. See `design-system.md`.
- **Monitor config** — applies via `hyprctl eval "hl.monitor({...})"`, NOT `hyprctl keyword`
  (rejected by the Lua parser). See `architecture.md`.
- **Widget registration is generated** — never hand-edit `widgets/widgets.gen.ts` or re-add
  manual imports to `widgets/index.ts`; the registry comes from `scripts/gen-widget-index.mjs`
  (phase 1 of the widget plugin system; phase 2 — zero-layout contract — still deferred).
  `bar-helpers.ts` is the only grandfathered non-widget in `widgets/` (EXCLUDE list).
- **Notification swipe-to-dismiss** — one implementation in `common/ScaleRevealer.ts`:
  `attachHorizontalSwipe` (gesture detector — claims only on horizontal intent so the NC
  scroller keeps its vertical drag; cancels the row's release-phase tap) + `setSwipe`/`swipeOut`/
  `settleSwipe` (paint-only snapshot translate + off-screen fling / animated snap-back; never use
  margins — they reflow the card, double-painting wrapped labels) + `collapseAway` (height-collapse
  for list rows). Cards must open on RELEASE (`SquircleContainer` `clickOnRelease`) or the
  press-tap fires before the swipe is recognised. **Banners slide off directly** (they can leave
  the screen). **NC rows slide via a GHOST** (`attachGhostSwipeDismiss`): the scroller clips any
  translate at the panel walls, so on swipe start the row's render is captured statically
  (`WidgetPaintable.get_current_image` — the DnD-drag-icon mechanism), the live row drops to
  opacity 0 (keeps its allocation AND the pointer grab), and the capture follows the finger from
  an input-transparent `Gtk.Fixed` lazily layered over the Bar's master overlay, above every
  panel. On dismiss the ghost flings off while the real row height-collapses; on cancel the ghost
  settles back and the live row is swapped in at identity. The row's `unmap` drops a live ghost
  and restores opacity (rows persist across NC open/close via the group cache — a row left at 0
  would come back invisible).
- **Notification hero images have TWO shapes** (`NotificationCenter.tsx`): compact = 44px
  cover-fit squircle thumb on the RIGHT (the macOS shape; banners and NC rows; text ceding
  width to it is the universal pattern, not a bug); expanded NC rows swap the thumb for a
  full-width `.nc-hero-big` below the text row (iOS long-look / Android BigPicture; action
  buttons move under the image). Small sources never take the big path — `hasExpandedHero`
  reads dimensions header-only via `GdkPixbuf.Pixbuf.get_file_info` and requires ≥240px
  source width, so a 64-160px chat avatar keeps its thumb even when expanded instead of
  being cover-fit into mush. Both shapes share one squircle painter (`heroDrawingArea`).
  Banners never expand. Card controls (time · count badge / expand chevron · close) share
  the TITLE line — never a dedicated right column, which shortened every text line instead
  of just the title. The thumb is the card's right edge, spanning title+body centred.
  All card controls are HOVER-ONLY (macOS), one scheme on EVERY card (banner and NC row —
  no per-surface inconsistency): the CLOSE floats over the top-left corner on a
  `Gtk.Overlay` (overlay children aren't measured → never affects card size); the RIGHT
  edge is contextual — expand chevron on the title line (swapped in for the timestamp so
  the line stays put; no chevron → the timestamp just stays) for NC rows, ≤2 glass action
  capsules overlaid for banners (the thumb fades via opacity so text never rewraps
  mid-hover; presses capture-claimed to beat the card tap + swipe). The count badge is
  info, always visible. Reveal is via EventControllerMotion on the capsule (child
  crossings don't emit leave); the title line pins `height_request: 22` so reveals can't
  nudge tall rows by 1px. The expanded-group control header hover-reveals via OPACITY +
  `can_target` instead — its buttons steal no text width, and `visible` would reflow the
  row height there. The expanded NC row still lists every action below the text.
  CLEAR-ALL replays the swipe fling per row (swipeOut → collapseAway), top-down with a
  45ms stagger, WITHOUT ghosts — clipping at the panel wall is the intended exit look.
  While the cascade runs, `resolved`/`notified` rebuilds are deferred (`pendingClear`) and
  only the click-time snapshot gets dismissed at the end; closing the NC mid-cascade must
  settle immediately (unmapped rows stop ticking — their tick callbacks never fire).

### 40. Activity Island on its own layer surface — residuals (2026-07-26)

The whole Activity Island — compact capsule included — moved out of the bar's window into
`nidara-island` (`surfaces/island/IslandWindow.ts`, OVERLAY level) so Hyprland's blur finally
reaches the bar capsules underneath: a surface cannot blur its own siblings, which is why they
read sharp through the glass before. A deliberate, documented exception to commandment 5 (see
`architecture.md` / `state-and-ipc.md`).

**The capsule moved on the second pass, and the first pass is the lesson.** Leaving it on the bar's
surface while only the modes moved cost a cross-window coordinate bridge in `MorphRevealer` — and
made both surfaces paint glass over the same pixels mid-morph, whose blurs stacked into a seam the
user caught immediately on close. Splitting an object that morphs across two surfaces is the wrong
shape; the bridge is deleted, not refactored.

What it left behind:

- **The surface is MONITOR-SIZED and always mapped.** Anchored on all four edges with
  `exclusive_zone = -1` — anything else and the bar's own 40px reservation pushes the surface, and
  therefore the capsule, off the bar row. So there are now two permanently-mapped full-monitor
  blurred layers instead of one. Damage tracking should make the idle cost of a static transparent
  surface near zero (the bar has lived this way forever), but **that is reasoning, not a
  measurement** — if a GPU-idle regression appears, this is the first suspect, and the fix
  direction is a surface sized to the bar row when collapsed and to the monitor while a mode is
  open (resize on open/close, never per frame).
- ~~The capsule is now at the MONITOR centre, not the bar-surface centre.~~ **RETRACTED the same
  day — the premise was false.** It assumed a side dock's exclusive zone insets the bar's surface.
  It does not: layer-shell arranges a surface requesting `exclusive_zone > 0` against the FULL
  output area, and only surfaces asking for zone 0 are pushed into the remaining usable area. The
  bar asks for 40. Measured on DP-1: `hyprctl monitors -j` reports `reserved [0,40,0,100]` with a
  bottom dock, while `hyprctl layers -j` still puts `nidara-bar` at `0 0 2560 1440` — the full
  monitor. So **the bar and the island are the same rect in every dock configuration**, the capsule
  does not move, and `measureOverflow`'s budget is unaffected. (The first pass's `sourceOffset`
  therefore always computed 0 — dead code, correctly deleted with the rest of the bridge.) The
  misleading claim came from a stale "trade-off" comment in `Bar.tsx`, now corrected in place.
- **The island is above the DOCK now.** It used to be in the bar's window, which stacks below the
  dock; on OVERLAY it stacks above. An expanded mode tall enough to reach a bottom dock will draw
  over it instead of under. No mode is that tall today.
- **UNVERIFIED BY EYE: the double blur.** The bar blurs the wallpaper; the island blurs
  bar+wallpaper on top of that wherever it covers the bar's OTHER capsules (AppTitle, clock, tray).
  Whether their 1px inner white edge survives that or smears is a judgement only the user's eye can
  make (screenshots hide exactly this class of artifact).
- **Pre-existing leak found in passing, NOT fixed:** `MorphRevealer.dismantle()` calls
  `this.sourceGhost?.unparent()` — the field is `sourceGhosts` (an array), so the optional chain
  no-ops and every source-ghost twin leaks its parent link. Harmless today (island revealers are
  long-lived and `dismantle` is never called on them), one line to fix when someone is in there
  for a real reason.

### 41. Settings → AI takes a hung keyring write for a working one (2026-07-26)

`surfaces/settings/pages/Ai.tsx` treats the Secret Service as binary — reachable or not — and a
keyring that is *listed but not loaded* is neither. Two gaps, both hit on a real machine (see the
login-keyring section of `dev-workflow.md` for how a session gets into that state):

- `keyringAvailable()` only proves the SERVICE answers: it does a lookup and reports success when
  nothing throws. A collection whose D-Bus object does not exist answers lookups instantly with "not
  found", so the check passes and every button enables. The honest probe is the collection object
  (`/org/freedesktop/secrets/collection/login`), not the service.
- `storeKey()` disables `saveBtn` and re-enables it only from the store callback. When the write
  blocks on an unlock prompt that never resolves — `gcr-prompter` starts, times out after 10 s and
  dies without answering — the callback never runs, so the button stays dead **forever, with no
  message**. It reads as "Settings → AI is broken" when the desktop's keyring is the broken part.

Fix direction: a timeout around the store (10–15 s) that re-enables the button and surfaces a real
error pointing at the keyring, plus a writability probe instead of a liveness one. Worth doing —
the failure is silent, and the Assistant's API key is the one thing this page exists to save.

### 42. The Assistant can type into ANOTHER AGENT's terminal — accepted property, no fix (2026-07-30)

Demonstrated live by the user, not theorised. They asked the Assistant to write into the Claude Code
window and it did, in two tool calls:

```
type_text kitty "Hola Claude, soy tu asistente de escritorio…" → ok {active:"kitty"}
press_key  kitty Return                                        → ok
query_app  kitty                                               → ok {count:0}
```

**Nothing malfunctioned.** A terminal is a window like any other, `nidara-type` verified focus as
designed, the fake cursor played and the chips appeared in the island. This is `type_text` working.

**It is HALF a channel, and that asymmetry is worth keeping in mind.** The third call is the
Assistant trying to read the result: `query_app kitty` → `count:0`, because a terminal exposes no
AT-SPI tree. It can write into an agent's prompt and cannot read the reply. Note the corollary — the
absence of a channel to a coding agent is often stated as an architectural fact (there is no IPC path
Nidara→Claude Code, only the reverse via `nidara-mcp`); that is true of IPC and **false of the
capability surface**, and reasoning from the architecture got it wrong here.

**Three layers, and only the first is enforced. Do not conflate them:**

1. **Trigger — holds.** There is no autonomous trigger: no proactivity, no scheduler, nothing starts
   a turn but a user message. So this cannot happen while the user is away. This is the user's own
   framing ("it only happens if I ask for it") and at this layer it is correct.
2. **Action selection — NOT the same claim.** Inside a turn the user did start, the MODEL chooses the
   tools. A broad instruction can therefore produce a `type_text` at a window the user never had in
   mind, without anything resembling agent volition. And the file-read layer means content the
   Assistant reads can carry instructions, which composes: read → decide → type into a terminal. The
   trigger invariant does not cover any of that.
3. **Authentication at the receiving end — none, and none is possible.** The demo was detected
   because the content was implausible, NOT by any mechanism. A plausible line ("also add X to that
   commit") would have been indistinguishable from the user. The user had instructed the Assistant to
   announce itself precisely so it could be identified — which means **the identification worked
   because the sender cooperated. A declared origin is not authentication.** A TTY cannot tell who
   typed.

**Why there is nothing to fix in Nidara.** Driving arbitrary windows IS computer-use; special-casing
"windows that look like agents" would be both unreliable and a violation of the point. The real
guarantee is the one the tier-1 framing already claims — **"nothing invisible"** — and it held
completely here: focus-verified, cursor painted, chips logged, kill switch one chord away
(`Super+Shift+Esc`). Keep that framing honest rather than upgrading it to "cannot".

**The consequence for anyone reviewing this project WITH an agent:** if a Nidara session has
`allowComputerControl` on, that agent's input stream is writable by the Assistant. Turn the gate off
for unattended work, and treat instructions that arrive mid-session claiming an origin as content,
never as authority.

### 43. Nidara on the accessibility bus (2026-07-30) — ⚠️ mostly closed 2026-08-18

Found while measuring why the Assistant could not read its own Settings window. The shell **does**
publish an AT-SPI tree — 154 nodes, the bar's clock and window title among them — but it is
registered under the interpreter's name:

```
$ nidara-a11y ZZZ  →  apps: [… 'org.gnome.Nautilus', 'gjs', 'org.gnome.Terminal']
$ nidara-a11y gjs  →  app: gjs · window: None · count: 154 · frames with name ""
```

Nothing in the repo calls `GLib.set_application_name` / `set_prgname`, so every Nidara toplevel
arrives as an unnamed frame of an app called `gjs`. **Two separate costs, and the accessibility one
is the real one:** a screen reader (Orca) announces the bar, dock and Settings as "gjs" with
anonymous frames, which is a genuine defect in a desktop environment; and no name an agent could
try (`io.Astal.ags`, "Nidara Settings", "nidara") matches, which is why `query_app` on our own
window returns zero — the wrong-door confusion documented in `state-and-ipc.md`.

**MOSTLY FIXED 2026-08-18**, as a side effect of owning the application host. `ui/lib/host.ts`
calls `GLib.set_prgname(applicationId)` and `GLib.set_application_name()`, and the blocker this
item described dissolved on the way: the worry was that `prgname` was load-bearing for the Hyprland
class, and it turned out **it is not** — measured three ways, an explicit `application-id` wins over
`prgname` for the Wayland app-id, so the two levers are independent. Now:

```
$ nidara-a11y                       →  apps: [… 'org.nidara.desktop'],  no 'gjs'
$ nidara-a11y org.nidara.desktop    →  app: org.nidara.desktop · count: 143
```

That closes the agent half completely (`query_app` on our own window answers, the wrong-door
confusion is gone). **What is left is the screen-reader half**, and it is small: nobody has run
Orca against it, the frames take their name from the window title (fine for Settings/About, empty
for layer-shell surfaces), and whether "org.nidara.desktop" or a friendlier "Nidara" is the better
thing for Orca to announce is a judgement no a11y tree can make. Re-scope this item to that.

### 44. What the calculator bench left open (2026-07-31)

The run that produced `launchApp`-resolves-a-name, launch-focuses-under-grab and
`collapseContained` also produced three things that were measured but NOT acted on.

**(a) The model drives text entry one glyph per API round trip — and we may have caused it.**
Asked to compute `1847 × 293`, run 1 used `type_text "1847"`; runs 2 and 3 clicked eight digit keys
individually, 8 steps where 1 would do, and the glyph-by-glyph path is also where the name mistakes
happen (`*` instead of `×`). The plausible cause is uncomfortable: **the focus refusal we removed
was the thing advertising the keyboard**, since the recovery went through `focus_window`, whose
description says it is "the precondition for the synthetic keyboard". The obvious response — a line
in `click_app`/`launchApp` pointing at `type_text` — is a PROMPT change and must be treated as one:
A/B it on the same model with a fresh conversation each run, report the token cost, and remember the
falsified theory in #39 (removing "Off by default" changed nothing). **Unproven; do not land it as
an obvious win.**

**(b) ~~There is no IPC verb to start a new conversation.~~ RESOLVED 2026-08-01 —
`agentNewConversation`.** See `state-and-ipc.md`. Two things this item got wrong, both worth keeping:

- **It is NOT gated, and equating it with `agentSend` was the error.** `agentSend` *causes* a turn,
  so it spends the user's API budget directly; this one only resets state — the next turn pays an
  uncached prefix, but only if a human sends one. The control it actually needs is the opposite kind:
  **who may call it**, not how much it may spend. It is in the daemon's `HIDDEN_ACTIONS`, so the
  Assistant cannot reach it (a mid-turn reset would strand the `tool_call` whose `tool_result` the
  next request must carry), while a terminal and an MCP client can. A permission toggle would have
  bought nothing here and left the real hazard — the model calling it on itself — wide open.
- **The stated reason the old dance was needed was wrong.** The shell does not rewrite the state
  files on exit (`saveTranscript()` fires only at turn end); it holds the conversation **in memory**,
  which is why deleting the files under a live shell is silently undone. Same conclusion, different
  mechanism — and the difference matters, because "it writes on exit" implies deleting files after a
  stop is unreliable, and it is not.

**(c) `collapseContained` has no test and cannot easily get one.** It needs a live AT-SPI tree;
`agent-loop` stubs the helpers and never reaches the resolver. It is a pure function of boxes, so a
GJS unit runner would cover it — there is no such runner today, and standing one up is its own
decision (the same one #39.14 reaches from the shell side).

**Data point for #39.6 while here:** on `gemini-2.5-flash` the implicit cache DOES fire — `cached=`
was non-zero on 8 of 13 steps, up to 10.7k tokens, i.e. the fixed `sys`+`tools` prefix (22 KB) is
largely paid once. That does not contradict the "1 hit in 36" measured on `gemini-3-flash-preview`;
it narrows it to that preview model. The consequence is that **the growing history, not the schema
block, is the lever** — the step-4 `query_app` dump (11 KB, no `match`) was resent on all nine
following steps, ≈25k of the turn's 127k tokens.

### 45. `sameApp()` is duplicated in four helpers (2026-08-01)

`bin/nidara-{a11y,act,click,type}` each carry a **verbatim copy** of `sameApp`/`nameTokens`, and
`AppService.nameTokens` is a fifth expression of the same rule in TypeScript. That is deliberate for
now: the four helpers are standalone GJS scripts, each `sudo cp`'d to `/usr/bin` on its own by
`install.sh`, so there is no import path they could share without inventing one (a `/usr/share/nidara/bin/`
module + a resolver that also works when running from the repo). The existing convention in these
files is comment-enforced duplication ("Kept identical in nidara-type"), and this follows it.

**The reason it is debt and not just a choice:** the whole POINT of the function is that all five
sites agree on what an app is called. A drifted copy reintroduces exactly the failure it was written
to kill, and nothing catches it — there is no test that runs the four helpers against each other
(same gap as #44(c): these need a live AT-SPI bus, and `agent-loop` stubs them). If a GJS unit runner
ever lands, the first thing to put in it is one table of name pairs asserted against all five copies.
Until then: **grep for `sameApp` before touching any of them.**

---

### 46. All three layers are monitor-sized and blurred — and dynamic sizing is a DEAD END (2026-08-02)

`hyprctl layers` on a 2560x1440 desktop: `nidara-bar`, `nidara-dock` and `nidara-island` are all
`0 0 2560 1440`, **all three with blur**. Making the island resize itself was implemented, measured,
and **reverted the same day**. Read the "what was ruled out" part before proposing it again.

> **Status 2026-08-04 — CLOSED. Every blurred surface declares a `set_visible_region`, each measured
> on the real shell: horizontal dock −7.0, island −7.2, bar −6.9, vertical dock −7.9 GPU points. The
> surfaces are still monitor-sized — that is the whole point of the mechanism. Kept here as the
> record of what was ruled out (dynamic sizing, splitting a surface, `xray`) and of the two rules
> that govern a region.**
>
> **Addendum 2026-08-09 — the saving was CONDITIONAL and one of the conditions is now gone.** Those
> four numbers were all measured AT REST. The moment something opened, the code handed the whole
> surface back on purpose, so the win evaporated exactly when the screen was busiest. The worst
> case was the DOCK, because its guest was the app grid: `st.appGridPanelOpen` in each axis cleared
> the region outright, and `appGridPainting` held it cleared through the close animation. **§18
> fixed that at the root** — the grid moved to its own surface (`AppGridWindow.ts`), so the dock now
> declares its pill rect in every state (every `apply()` in both axes passes one; no branch clears
> it), and the grid declares its own **1110×834 of 2560×1440** while open and is UNMAPPED when
> closed. **The equivalent condition on the BAR is gone too, same day** — `paintsBelowStrip()` used
> to clear the region for ANY open panel (CC, NC, Prism, system menu, expansion capsule, banners),
> i.e. for most of any interaction; it now declares `strip + one padded rect per open panel`. See
> the section at the end of this entry. ⚠️ The dock's numbers above are still valid — they were
> at-rest measurements and the at-rest path did not change. **Both 2026-08-09 changes are now
> MEASURED** (same day, last section): with the CC open the bar costs **4.1 % → 0.65 %** GPU, i.e.
> an open panel adds nothing over the no-panel baseline; with the app grid open, all four surfaces
> declaring is **22.8 % → 2.0 %**. Read the two harness traps there before running it again.

**The mechanism, because `ignore_alpha` makes it easy to guess wrong:** Hyprland charges layer blur
by the surface's **BOX**, not by the pixels that end up visible. `ignore_alpha` decides what is SEEN
blurred, not what is COMPUTED — it is cosmetic and buys nothing here. Cost ≈ *damaged area × number
of blurred layers covering it*, so with three full-screen layers **every repaint of every window
anywhere pays triple blur**. It is a tax on daily use (scroll, video, dragging), not on idle — a
different axis from #18's idle work.

**Where this section came from (2026-08-01), because the framing still does the work.** The first
measurement was not "shrink a layer" but "turn each layer's blur OFF and see what comes back", via a
temporary `layer_rule` override + `hyprctl reload` under continuous synthetic damage:

| | GPU |
|---|---|
| all three layers blurred (what shipped) | 43.7 % |
| island's blur off | 33.4 % |
| + dock's off | 23.1 % |
| + bar's off | 12.0 % |
| `decoration:blur:enabled = false` | 8.6 % |

🔑 **~10 points per full-screen blurred layer — and the ISLAND, which showed a ~300px capsule, cost
exactly what the BAR cost.** That sentence is the whole reason this section exists: it separates
what a surface *is* from what it *shows*, which is the distinction every fix since has been built on.
⚠️ **The absolute numbers are that day's machine, not today's** — idle alone was 4-6 % before #18
fixed it (it is 0.0-0.1 % now), and the modern harness reads +5.9 pts for a full-screen blurred
layer. Quote the ratio, never the values. (This measurement was recovered 2026-08-10 from a branch
that was never pushed; the rest of that day's findings had already landed through the AgentGlow work.)

**Measured 2026-08-02**, synthetic damage 1600x700 at 144/s, 3 rounds shuffled, baseline stable to
±0.4 pts: a full-screen blurred layer costs **+5.9 pts** of GPU; the same layer shrunk to what it
actually shows costs **+0.4**. Fixing the island A/B'd at **31.4% → 25.3% (−6.1 pts)** against the
real shell. ⚠️ **Do not quote these as the user-visible win:** cost scales with area × repaint rate,
so 720p video at 60fps is roughly a third of this load (~2 pts/layer). Real, worth doing, not
dramatic.

#### Why dynamic sizing was reverted — and what was ruled out

The island version WORKED and delivered the win: A/B'd against the real shell at **31.4% → 25.3%,
−6.1 pts**, capsule and modes functionally unchanged, surface cycling cleanly 96↔1440 with no
unmap/remap. It was reverted anyway, because **every grow produced a visible artefact**: the
workspace dots rise and stretch horizontally, the indicator chips narrow upward before hiding. Fast —
a frame or two — but plainly visible, on every single open.

**Ruled out, each by a build the user compared against the pre-change one:**
1. **GTK layout — the whole widget tree, with a CONTROL.** Instrumented `IslandWindow` to log
   window, root, every hit target and every `MorphRevealer` (bounds + `progress`) on every frame
   across a grow. Results: the capsule is constant at `1103,8 273x32` throughout; the chips are
   constant until they unmap; the opening mode's revealer shows **one frame at `0,0 0x0`** before
   snapping to `381,8 1798x341`. That `0x0` frame looks like a smoking gun and **is not one** — the
   control build (`COLLAPSED_H` = monitor height, i.e. every other change in place but no resize
   ever happening, the build the user confirms looks correct) shows **the identical `0x0` frame**.
   It is just GTK: a widget made visible has no allocation until the next layout pass.
   ⚠️ Deferring the reveal until `win.get_height()` matches does NOT avoid it either — the window
   reports its new height a frame BEFORE its children are allocated. Waiting on the window is
   waiting on the wrong thing.
   **Conclusion, now with a control behind it: shell-side geometry is IDENTICAL in the good and bad
   builds.** The only difference is the surface resize, so the artefact is compositor-side and
   cannot be fixed from the widget tree.
2. **Hyprland's `layers` animation** (it animates layer geometry, speed 3 / easeOut — the obvious
   suspect for a stretch). Disabled globally via the user config; artefact unchanged. Note the base
   config sets it at hyprland.lua:228 and `safe_require("hyprland-user")` runs at :637, so a user
   override does win — verify with `hyprctl animations` and read the `enabled` field, not just the
   first two lines.
3. **Timing / ordering.** Deferring the morph until the allocation matched, then a further
   `SETTLE_FRAMES` for the buffer to catch up: no effect. The artefact tracks the RESIZE, not the
   animation that follows it.
4. **Blur kernel clamped at the surface edge** (with a 96px surface the capsule has only 48px of
   margin below it, less than the effective blur radius). Raised the collapsed height to 320: no
   effect.

5. **Hyprland re-arranging the other layers on a resize** (user's hypothesis: the island ignores
   exclusive zones — `zone -1` — while the bar respects them, so they visibly diverge when
   Hyprland's error bar appears). Polled `hyprctl layers` at ~250/s while a test layer toggled
   between `2560x1300` and `400x60`: **every other layer reported exactly one geometry throughout**.
   Resizing one layer does not move the others.

The only change that removed it was removing the resize. **Root cause not established** — it is
somewhere in how the compositor presents a layer surface across a size change, and chasing it further
needs Hyprland-side instrumentation, not shell-side.

⚠️ **Correction 2026-08-09: this evidence is ISLAND-SPECIFIC, and the heading over-generalises.**
Every ruled-out hypothesis above was measured on a surface that STAYS MAPPED and cycles its size
96↔1440, and the artefact tracked the RESIZE. The app grid never resizes its surface — it maps at
full size and unmaps (§18) — so "dynamic sizing is a dead end" does not automatically transfer to a
map/unmap surface; nobody has tested that case. It is still not worth spending: with a region
declared, the remaining headroom is the difference between this entry's own +0.4 (a layer showing
only what it paints) and 0, i.e. the tail of the win, and only while the grid is open. **Do not cite
this section as proof for a surface that does not resize.**

**Separate bug found along the way (user-reported 2026-08-02) — FIXED the same day**, see
`architecture.md`'s IslandWindow section and `HyprlandState.layerTop`. That first fix read the bar's
position once per `configreloaded`, which fixed the island going DOWN and left it stuck there when
the error bar went away (user-reported 2026-08-04): Hyprland releases that reservation after a fade
animation, on no event at all. Now measured on the event and then watched at 400ms **only while
displaced** — the reasoning, the Hyprland source it rests on, and the layer-ordering rule that
decides which surfaces can displace the bar are all in `architecture.md`.

**So: do not re-propose "just make the layers smaller".** It is measured, it works, and it looks
wrong. If the GPU cost is worth paying down, the mechanism has to be one that does not resize the
surface at all — which is `set_visible_region` (below).

**If someone does revisit it anyway**, the parts that were right and should be reused: keep the
origin fixed (anchor TOP, leave BOTTOM free, drive HEIGHT only) so every root-relative rect stays
valid; grow BEFORE the animation; shrink only once every revealer is at rest closed — a surface does
not draw outside its own rect, and `MorphRevealer.reveal` fires `onDone` synchronously for revealers
already in the target state, so a naive shrink-on-done guillotines the one still animating.

#### Also dead: splitting the island into TWO surfaces (capsule small + modes on demand)

The obvious follow-up — capsule and chips on a small surface that never resizes, modes on a
monitor-sized surface that is only MAPPED while something is open — was prototyped in C on
2026-08-02 (`handoff.c`, scratchpad). Three sub-questions passed:

- **Map/unmap is visually clean** (soft fade from `layersIn`, no stretch, no jump) and **costs zero
  while unmapped** — measured as a textbook square wave: a layer toggling every 1.5s produced 7 low
  and 7 high 1.5s windows with a **4.5 pt** step, returning to baseline every cycle.
- The small surface **never resized and never remapped** (2560x96 in 1745/1745 samples) once it was
  changed to stop PAINTING rather than hide.
- `hl.layer_rule` accepts **`animation = "none"`**, so the map fade can be suppressed per namespace.

**The handoff itself is what kills it.** Whichever way it is ordered, the small surface's frame lands
before the big one's — its buffer is 2560x96 against 2560x1440, so it renders sooner. Result,
confirmed by the user on the prototype: **opening shows a GAP** (capsule's glass vanishes, then the
mode's appears) and **closing shows DOUBLE GLASS**. Reversing the order just swaps which end gets
which. Even moving the map out of the critical path — present the big surface empty and transparent
first, then swap contents on two already-mapped surfaces in one turn — does not fix it, because the
two commits still land on different frames.

**What it would take is an atomic commit across two layer surfaces, and Wayland does not offer one.**
That is the real reason the whole island lives on ONE surface (the 2026-07-26 seam) — inside a single
surface the handoff IS atomic. Treat commandment 5's exception as load-bearing, not stylistic.

#### Also dead: `decoration:blur:xray = true`

The one zero-code lever: with xray the layers blur only the BACKGROUND, so a window repainting under
them costs nothing — exactly the cost measured above, gone for a config line. **Rejected on design
grounds (user, 2026-08-02), and the reason generalises past the bar:** it applies to every glass
surface we have. Open the Control Center over a window and it would blur the *wallpaper* instead,
with the window simply absent underneath. The glass would stop behaving like glass. That is not a
taste setting, it breaks the premise of the material — do not offer it as a Setting either.

#### The remaining candidate: `set_visible_region`

`hyprland-surface-v1.set_visible_region` (`hyprland-protocols`, in Arch `extra`; Hyprland ≥0.56
implements it — verified in the installed binary's symbols) declares a visible sub-region and
recovers ~88% of the same cost **without resizing the surface at all**, so by construction it cannot
produce the artefact above. Measured 2026-08-02 with a purpose-built C client: full-screen blurred
layer +5.9 pts, same layer with a 400x60 region declared **+0.7**, and it holds even when the damage
falls directly UNDER the declared region (cost tracks the intersection, monotonically — a 1280x600
region costs +3.0). Two caveats from the same measurements: there is a **floor of ~1 pt per layer**
however small the region (the blur samples past the edge, so the cost is the region expanded by the
radius), and a region declared away from the damage measured CHEAPER than an unblurred full-screen
layer — the clip cuts composition too, not just blur.

**Why it is not done:** it cannot be called from GJS (`libwayland-client` has no GI, and
`gdk_wayland_surface_get_wl_surface` is `introspectable="0"` in `GdkWayland-4.0.gir`), so it needs a
small C library with GIR + typelib, packaged into pacman/`install.sh` and wired into all three
bundles. Precedent for the C part exists (`bin/nidara-input.c`, compiled by `install.sh` and the
PKGBUILD) but that is a standalone binary; this one has to be **in-process**, because the region is
set on OUR OWN `wl_surface`.

⚠️ **Its failure mode is worse than resizing's, and that is the real design constraint:** content
outside the declared region is **not drawn at all** — a hard GL scissor on the geometry, not just on
the blur (`OpenGL.cpp` ~1574-1594: with a non-empty `clipRegion` the texture draw iterates the clip
region instead of the damage). And `SurfacePassElement.cpp:150-158` intersects the region with the
buffer and sets `cancel` if it comes out empty, so a stale region after a resize **makes the surface
vanish** rather than degrade. There is exactly 1px of tolerance (`visibleRegion.expand(1)`).
Confirmed in the source and live: with a 1200x400 shape declared visible only over its left 400px,
the other 800px — frame included — simply were not there.

#### ✅ 2026-08-04: the blocker is gone — `lib/nidara-wl/` exists

The C library described above is built and packaged (`install.sh`, PKGBUILD, headless smoke), and the
region path is verified end-to-end **from GJS**: a 800x400 layer window declaring a 220x110 region
draws only that patch. `hyprland_surface_manager_v1` advertises **v2** on Hyprland 0.56, so the
request is live, not theoretical. See `architecture.md` → "`lib/nidara-wl/`".

⚠️ **One trap found while wiring it, and it looks exactly like success:** the region only applies on
the next real `wl_surface.commit`. The first A/B here showed *no clipping at all* with the request
delivered and no error — the test window's content never changed, so GTK never committed.
`gtk_widget_queue_draw()` alone does not force it. **Declare the region as part of a change that
repaints**, and do not trust a `TRUE` return as proof it took effect.

**What is left is the per-surface work, which was always the real cost:** each surface has to know
what it is currently showing. Order by risk — island (own layer, modes already explicit state), then
dock (~200 px of margin for magnification and bubbles), then bar (its `Gtk.Overlay` overlays make the
region hardest, and it is the one whose failure is most visible).

#### ✅ 2026-08-04 (same day, later): the horizontal dock, MEASURED on the real shell

Not synthetic any more. A/B on this machine (2560x1440@144, `damage` layer repainting at vsync, three
rounds, order shuffled, `NIDARA_VISIBLE_REGION=0` as the only variable — the shell is restarted in
both arms so map order and startup cost are identical):

| damage 1600x700, ABOVE the dock (the everyday case) | GPU |
|---|---|
| no region (2560x1440 box) | 34.0 % |
| region declared | **27.0 %** |

**−7.0 points**, with non-overlapping ranges (33.2–34.8 vs 26.6–27.6). Idle without damage: 3.9 %.

| damage 1600x340 landing ON the dock's strip | GPU | declared rect |
|---|---|---|
| no region | 30.5 % | — |
| padding 260/200 | 23.4 % | 1586x366 |
| padding 24/24 | **19.4 %** | 1234x130 |

So the region is worth ~7 points either way, and **the padding alone was worth another 4**.

🔑 **Three findings that make the dock's implementation smaller than it looked:**

1. **The dock's tooltip AND its context menu are `Gtk.Popover`s** (`common/Tooltip.ts`,
   `DockItem.tsx` — `renderMenuModel` only builds the ROWS, the popover is the dock's). Own Wayland
   surfaces, so this region cannot clip them — which is also why the dock's layer rule needs
   `blur_popups` on top of `blur`. The fat 260 px cross-padding was reserving room for something that
   never paints in this surface; the magnified bulge is already inside the rect via `reach()`, and the
   rect is already built at `totalMain + 500`. Padding is now 24/24, and the comment says why.
2. **A menu being open is not a reason to give up.** Same reason: it paints elsewhere. The branch
   now hands over the body rect instead of clearing. ⚠️ It needed its own cache key — sharing the
   grid's would let a grid-open transition match a stale key and keep the dock's small rect, which
   WOULD clip the grid.
3. **A hidden dock can keep declaring its rect.** Auto-hide slides the LAYER (`applySlide` →
   layer-shell bottom margin), not the content, and the region is buffer-local: the pill never moves
   inside its own buffer. The auto-hide and fullscreen branches now declare the body rect too — they
   only ever differed in INPUT.

**Escape hatch, and how the A/B is run at all:** `NIDARA_VISIBLE_REGION=0` (read in
`common/VisibleRegion.ts`) keeps every surface un-optimised. It exists because the failure mode is a
missing piece of desktop, not a glitch — someone who hits it needs a bootable shell before they can
report anything, and `systemctl --user set-environment` works from a TTY.

#### ✅ 2026-08-04: the ISLAND, the layer with the worst ratio

Monitor-sized, blurred, and at rest it shows a ~750x64 capsule — **1.3 % of its own box**. Measured
with the same harness, damage placed outside both the island's band and the dock's strip, and the
dock's region active in BOTH arms so the delta is the island alone:

| | GPU |
|---|---|
| island declares nothing | 26.6 % |
| island declares its capsule | **19.4 %** |

**−7.2 points**, ranges non-overlapping (26.3–27.1 vs 18.6–20.0).

🔑 **The rule here is the OPPOSITE of the dock's, and the difference is the morph.** The dock knows
its silhouette before it paints, so it can declare in every state. The island's expanded modes arrive
through a `MorphRevealer`, and **a widget just made visible has no allocation until the next layout
pass** (the `0,0 0x0` frame documented above — normal GTK, present in control builds too). A region
computed at open time would describe the capsule alone while the mode paints outside it, and the mode
would be scissored away *for as long as it stayed open*. So: **declare only while resting as the
compact capsule; hand the whole surface back the moment anything is revealed or still animating**
(`get_visible()` is not enough on the way out — a closing revealer is visible until its final tick,
`tickId` is what says "still moving"). Resting is ~all of the time and is the expensive state anyway.

⚠️ **SUPERSEDED 2026-08-10 — the rule in that last paragraph was wrong** (see the entry below). The
missing allocation lasts ONE FRAME, not "as long as the mode stays open", and `MorphRevealer` has the
same `onAllocated`-inside-`vfunc_size_allocate` guarantee the bar's panels rely on. The island now
declares its open modes too; the numbers above (capsule at rest, −7.2 pts) still stand.

🔑 **The two paddings are deliberately asymmetric (200 x / 16 y), and that asymmetry is what makes it
safe.** The win is entirely in the HEIGHT — 1440 → 64. The horizontal is where the MOTION is: the
capsule is centred, so anything changing its width slides it sideways, and one of those paths
re-stamps **400 ms late** (`Bar.tsx` → `onBackgroundChanged`: a chip appearing does not resize the
glass, so the `resize` hook never fires). Late is harmless for an input region and *fatal* for a
visible one — it would be a chip that is not drawn for 400 ms. A pad wider than any such shift
(three chips ≈ 150 px) retires that whole class of bug for almost no area.

**General lesson for the bar, which is next:** an input region tolerates being late, a visible region
does not. Every call site that stamps input has to be re-read with that question before it can be
trusted to stamp blur too.

#### ✅ 2026-08-04: the BAR — the third and last monitor-sized layer

The hard one on paper: every overlay in the shell lives inside this window (commandment #5), so the
region has to follow which of them is open, and the failure mode is the most visible on the desktop.
In practice the mechanism above made it small. Same harness, damage 1600x700 at y=200..900 (below the
bar strip, above the dock's), dock and island declaring in BOTH arms:

| | GPU |
|---|---|
| bar declares nothing | 19.3 % |
| bar declares its strip | **12.4 %** |

**−6.9 points**, ranges non-overlapping (18.9–19.7 vs 11.9–12.7). Declared rect **2560x64 = 4.4 %**
of the box — the same order as the dock (−7.0) and the island (−7.2). Idle: 1.6 %.

**Shape**: the island's rule, since the bar is in the island's situation, not the dock's — panels
arrive through `ScaleRevealer`s and paint far outside the strip. So: declare `0,0 W x (strip+16)`
only while nothing else in the window paints, hand the whole surface back otherwise. Full monitor
WIDTH on purpose: the surface is that wide anyway, and it buys immunity to every capsule that resizes
itself (window title, clock, tray). The height is where the entire 1440 → 64 win lives.
⚠️ **The second half of that rule was replaced on 2026-08-09** — the bar now declares the panels too;
see the last section of this entry. The strip rect and the reason for its full width are unchanged.

🔑 **The "can this stamp be late?" audit found exactly one offender, and it was written in the code
as a deliberate choice.** `NotificationPopups.tsx` defers its stamp to an idle *on purpose*, so it
reads a settled allocation, reasoning that a banner is not clickable until it has grown in anyway.
Correct for input, fatal for blur: a banner appended in one turn and declared an idle later is a
banner that is **never drawn**. Fix is mechanical — appending fires a second, SYNCHRONOUS hook
(`onContentAppeared`) that only ever clears the region; the deferred hook keeps owning input.
`showExpansion` needed the same treatment (it makes the panel visible, then defers 16 ms to position
and reveal it), and the `inputYield` early-return needed the region call the island's does: a yield
changes who gets the CLICKS, not what is painted.

🔑 **The predicate is WALKED off `masterOverlay`, not hand-listed** — a panel mounted there later is
covered by construction. Two children are not panels and are documented at the call site: `barBox`
(the strip itself) and `popups` (a container, `visible` whether or not it holds a banner — its
CHILDREN are the content). An open ISLAND mode does not count either and no longer needs excluding by
hand: the island paints on its own surface, so nothing of it is a child here and this window still
declares only the strip — and a long-running activity (media, the assistant) is exactly when the
saving is worth having. Two earlier drafts gave that optimisation away in exactly that state: one
used `status.isAnyOverlayOpen` as a safety net, and the other had to skip the `overlay-catcher` by
hand because it was shown for island modes (both are gone — the catchers were deleted 2026-08-05).

The rect is floored at `PANEL_TOP` rather than depending on the measurement, so the **first** stamp
declares something instead of giving up until an overlay opens; the floor is right by construction
(every panel in this window is positioned to start there). The real declaration rides the 300 ms
opacity change — the shim only applies a region on a real commit, never on `queue_draw()` alone.

Verified in the live session before measuring, one screenshot per state: rest, control centre, Prism,
the expansion capsule (window menu) and a `notify-send` banner. All draw complete, all keep their
blur.

#### ✅ 2026-08-04: the VERTICAL dock — the debt is CLOSED

Mechanical, as predicted: `verticalAxis.buildInputRegion` now mirrors the horizontal one branch for
branch (body rect computed before the branches, handed over by the fullscreen / auto-hide-trigger /
menu branches, cleared for the yield and the app grid).

| damage 1600x700 to the RIGHT of a left-side dock | GPU |
|---|---|
| no region | 20.8 % |
| region declared | **12.9 %** |

**−7.9 points**, ranges non-overlapping (20.3–21.2 vs 12.2–13.5). Declared rect **130x1252** — the
biggest saving of the four surfaces.

🔑 **The paying axis is SWAPPED, and it changes which padding is expensive.** Horizontally the
surface is 2560x1440 to show a strip at the bottom, so the win is the height; vertically it is 2560
wide to show a ~130px column, so the win is the WIDTH, and the tall rect (the ±250 main padding that
was already in the input region) is nearly free — it only costs when damage lands inside a 130px
column. Tightening it is a knob, not a fix; the horizontal axis' 260/200 → 24/24 experiment does not
transfer, because there the padding was on the *wide* axis.

⚠️ **The key-collision trap from #90 was already present here, latent.** Two branches (`appGridPanelOpen`
and `menuOpenCount > 0`) both keyed `"null"`. Harmless while the key only guarded `set_input_region`,
a real bug the moment a blur rect rides the same cycle: the menu branch declares the body rect, so a
menu→grid transition would have matched the cached key and **scissored the app grid away**. Keys were
made `grid` / `menu:<body>`. ⚠️ **The `grid` branch is gone as of 2026-08-09** (§18 — the grid left
the dock's window), so the collision cannot recur here; the LESSON still applies to every branch
added to `buildInputRegion`, which is why `menu:<body>` keeps a distinct key with nothing to collide
with today.

Verified live with the dock moved to the left: rest (full column, glass intact), app grid open (draws
complete over the dock), auto-hide on→off (returns clean). Setting restored to `bottom` afterwards.

**This closes §46's implementation.** All four blurred surfaces declare: horizontal dock −7.0,
island −7.2, bar −6.9, vertical dock −7.9.

#### ✅ 2026-08-09: the BAR declares its PANELS too — the last conditional saving

The at-rest numbers above were never the whole story: `paintsBelowStrip()` handed the entire surface
back for **any** open panel, and five of them live in this window (CC, NC, Prism, system menu, the
expansion capsule) plus the notification banners. "Something is open" is most of any interaction, so
the −6.9 evaporated exactly when the screen was busiest. It now declares **`strip + one padded rect
per painting panel`**. Measured on the live shell with the CC open: `2560x64` + `388x642` =
**11.2 % of the box**, against 100 % before.

🔑 **The bar was never in the island's situation — it is in the app grid's, and the difference is
one option object.** The island was believed unable to declare while open, because its modes arrive
through a `MorphRevealer` (wrong, and fixed the next day — see the 2026-08-10 entry; the belief is
what mattered here, because it is what the bar copied). Every panel here is a
`ScaleRevealer` with `OVERLAY_POP` and `animateLayout: false`, so the allocation is the FINAL one
from the first laid-out frame and the 0.97→1.0 pop paints strictly inside it. Borrowing the island's
rule wholesale was the actual mistake, and it cost the entire open-state saving for four months.

🔑 **What makes it safe is `onAllocated`, and specifically WHERE it fires.** `ScaleRevealer` calls it
from inside `vfunc_size_allocate`, i.e. before the snapshot of the same frame — so however stale the
bounds were when the open path stamped, the panel's real rect lands on the very frame that first
paints it. That retires the whole "can this stamp be late?" class for the panels without a tick
callback, a timeout, or a settle count. ⚠️ Consequence: that hook is now **load-bearing for what is
drawn**, not just for clicks, so it is wired by walking `masterOverlay` like the rect predicate
itself. A hand-list that missed a panel added later used to cost a late click; it would now cost a
panel that is not drawn.

⚠️ **The banners are the one thing that still clears**, and only inside a known window: between
`onContentAppeared` (synchronous, fires on append) and the deferred stamp that follows the grow-in,
the box's bounds describe the PREVIOUS stack — a second banner declared off those bounds is a banner
that is never drawn. A `popupsSettled` flag makes that window explicit instead of hoping. Their band
is also the only one declared at **full monitor width**: swipe-to-dismiss flips the revealer to
`overflow: VISIBLE` and flings the card clear off screen, and that is the one place GTK stops
clipping for us.

🔑 **The pad is 16, not the app grid's 48, and the reason is structural**: every panel here sits
inside a revealer whose `overflow` is `HIDDEN`, so whatever it paints outside its allocation is
already clipped by GTK before the compositor sees it. The squircle's soft edge lives INSIDE the rect
(`GLASS_INSET`). The pad covers rounding, not an escaping shadow. When a surface's own widget tree
already clips, the region does not have to guess at a margin — check that before padding.

`common/VisibleRegion.ts` grew `setVisibleRects` for this (`setVisibleRect` is now the one-rect
convenience). Multi-rect is free protocol-side — `wl_region_add` is additive and Hyprland iterates
the clip region, not its bounding box — so the cost is the rects' own area, not their union's box.

Verified live, one screenshot per state: rest, control centre, notification centre, Prism empty,
Prism with results (the slide-down revealer that resizes per frame), the window menu (expansion
capsule, left-anchored), the system menu, one banner, two stacked banners, and CC **edit mode** (the
panel grows from 610 to ~900 px and the Done pill draws). All complete, none clipped.

#### ✅ 2026-08-09, same day: MEASURED — and the harness has two traps of its own

Damage layer 1600x700 at (480,200) — below the bar strip, above the dock's, clear of the CC's rect —
on an **empty workspace**, `amdgpu` `gpu_busy_percent` sampled at 20 Hz for 20 s per arm, shell
restarted in every arm. Baselines: idle **0.0 %**, damage running with nothing open **0.6 %**.

**Scenario 1 — the control centre open, single variable = `Bar.tsx`** (the old file checked out from
`main`, so dock and island declare in BOTH arms), 3 rounds shuffled:

| CC open, damage at 144 fps | GPU |
|---|---|
| bar hands the whole surface back (old) | 4.0 / 4.2 / 4.0 % |
| bar declares `strip + panel` (new) | **0.7 / 0.7 / 0.6 %** |

**−3.4 points**, ranges nowhere near overlapping. 🔑 The number that matters is not the delta but the
**0.6**: that is the no-panel baseline, so **an open control centre now adds nothing measurable to
the blur bill**, where it used to add +3.4. The open state stopped being the expensive one.

**Scenario 2 — the app grid open, every surface's region vs `NIDARA_VISIBLE_REGION=0`** (the
all-or-nothing switch, so this bounds the whole §46 mechanism in the busiest state rather than
isolating one surface), 2 rounds shuffled:

| app grid open, damage at 144 fps | GPU |
|---|---|
| no surface declares | 22.8 / 22.8 % |
| all four declare | **2.1 / 2.0 %** |

**−20.7 points, −91 %.**

⚠️ **Trap 1: a cairo `draw_func` is not a valid damage source.** Rasterising 1.1 MP on the CPU every
frame throttled the client to 27–40 fps — and to a DIFFERENT rate per arm (31 vs 40), so the two arms
were carrying different loads and the GPU comparison meant nothing. A single **GSK color node**
(`vfunc_snapshot` + `append_color`) holds 144.0 fps in every arm. **Print the fps and refuse any arm
that is not at the monitor's rate**; the first two rounds of this measurement were thrown away for
exactly this.

⚠️ **Trap 2: a stray damage client from an earlier launch doubles the load and says nothing.** Kill
by pattern, not by pidfile. (And `pkill -f damage.js` from a shell whose own command line contains
that string kills the shell instead — put the kill in a script file.)

#### ✅ 2026-08-10: the ISLAND declares its OPEN MODES too — the rule above was wrong

The 2026-08-04 entry says the island "genuinely cannot declare while open" because its modes arrive
through a `MorphRevealer`. That was the same mistake the bar made, one layer further along: it is
true while the morph has **no allocation yet**, which is one frame, and it was written as if it were
true for **as long as the mode stays open**, which is a whole Assistant conversation.

`MorphRevealer.onAllocated` fires from inside `vfunc_size_allocate` — the same property that made the
bar's panels safe — and `IslandWindow.mount` had already wired it to `updateInputRegion` (for clicks)
since the focus-grab migration. The blur region rides the same call, so a mode's rect lands on the
frame that first paints it, and on every relayout after that (a growing conversation, a `margin_top`
re-pin). Measured on the live shell, declared rect as a share of the 2560x1440 box:

| island state | declared | % of its box |
|---|---|---|
| at rest (capsule) | 753x64 | 1.3 % |
| Assistant | 792x145 | **3.1 %** |
| battery | 753x159 | 3.3 % |
| media player | 832x278 | 6.3 % |
| workspace overview | 2560x457 | 31.7 % |

All of them were **100 %** before. The overview is full-monitor-width by design, so its win is 3×;
the Assistant — the mode that stays open for as long as a conversation lasts — is 32×.

🔑 **The morph needs no per-frame region, and that was the thing actually worth avoiding.**
`applyProgress` only sets opacity and queues a draw — never a relayout — so the revealer's allocation
is FINAL from its first layout pass: **one stamp per open, one per close**, verified in the log (a
`pending` immediately followed by one rect, then silence for the whole 300ms). And the travelling
shape stays inside that one rect: it is `lerp(capsule, glass)`, the capsule is a hit target, the glass
is inside the revealer's own box (the shape's cairo node clips itself to that box + 8px), and a lerp
between two rects sharing a top edge and a centre never leaves their bounding box.

⚠️ **The one frame that cannot be measured is the turn that REVEALS a mode** — `set_visible(true)`
runs before any layout pass. That is the `pending` case and its answer is the whole surface, for the
single frame until `onAllocated` re-stamps. Falling back to "I don't know" is the only correct answer
there; a rect computed from a revealer with no allocation describes the capsule while the mode paints
outside it, and outside the region is NOT DRAWN.

⚠️ **The indicator chips are covered by the PAD, not by a rect anyone computed for them.**
`hitTargets()` drops them the moment they fade to opacity 0 (35 % into the morph, by design), so any
re-stamp taken mid-morph measures a union without them — and on the way back out they ramp up again
with no relayout to trigger a re-measure. Three chips ≈ 150px against `BLUR_PAD_X = 200`. Anyone
tightening that pad has to give the chips a rect first.

Verified visually per mode on the real shell (overview / player / Assistant fully drawn, blur intact)
and numerically at the risky edge: sampling a column down through the player panel's drop shadow,
alpha reaches 0 at y≈236 against a region bottom of 278 — the 16px pad clears the shadow with room,
so nothing is scissored mid-fade.

**MEASURED in GPU points** with the harness above — which now **lives in the repo** as
`scripts/dev/blur-arm.sh` + `blur-damage.js`, recipe and failure modes in `dev-workflow.md`, because
it had been rebuilt from these notes twice (damage 1600x700 at 480,200; empty workspace;
`gpu_busy_percent` at 20 Hz × 20 s; shell restarted per arm; **the only variable is
`IslandWindow.ts`**, so dock and bar declare in both arms; every arm held 144.0 fps):

| | GPU |
|---|---|
| island CLOSED (the floor) | 1.0 % |
| Assistant open, surface handed back (old) | 5.9 / 6.1 % |
| Assistant open, rect declared (new) | **1.1 / 1.2 %** |
| overview open, surface handed back (old) | 4.3 % |
| overview open, rect declared (new) | **1.8 %** |

🔑 **The Assistant lands on the CLOSED floor**: opening it no longer costs anything measurable, the
same result the bar got for the CC. The overview keeps a real cost (1.8 vs 1.0) and that is correct
rather than disappointing — its declared band genuinely overlaps the damage rect, and §46's cost
model is the *intersection* of the damage with the region. ⚠️ Which is also the caveat on all six
numbers: they are specific to where this harness puts its damage. A mode whose region does not
overlap the damage reads as free; move the damage under it and it will not.

#### ✅ 2026-08-10: the overview RE-MEASURED after #95 — real thumbnails cost nothing to hold

The open item this section carried since #95 (real window captures in the Workspace Overview): the
overview "now paints MUCH more", and its region lives on the island's surface, so its numbers were
assumed stale. They were not. Same harness, plus a no-damage variant for the questions the harness
cannot ask, with `NIDARA_WINDOW_CAPTURE=0` (placeholders) as the only variable:

| | GPU |
|---|---|
| **with damage** — floor, nothing open | 1.0 / 1.1 % |
| with damage — overview open, PLACEHOLDER thumbnails | 1.9 % |
| with damage — overview open, REAL thumbnails | **1.8 %** |
| **idle desktop** — nothing open | 0.1 % |
| idle desktop — overview OPENING (3 s transient), placeholders | 2.0 % (max 26) |
| idle desktop — overview OPENING (3 s transient), real | 2.2 / 2.4 / 2.5 % (max 29-35) |
| idle desktop — overview HELD OPEN | **0.0 %** (3 rounds) |

🔑 **Blur is charged by AREA, not by what is painted under it** — which is why real textures and flat
placeholders measure the same (1.8 vs 1.9, and 0.0 vs 0.0 held open). The intuition that drove this
item — "it paints much more, so it must cost more" — is the wrong model for a compositor effect, and
it is the same confusion as expecting the region to shape the blur (see the squircle entry below).

🔑 **An open overview on an idle desktop costs NOTHING continuously: 0.0 %.** Its ~0.8 points with
damage are entirely the intersection of its declared band with someone else's damage — i.e. the
overview is not a load, it is a surface that other people's repaints have to go through.

The captures appear only in the OPENING transient, +0.2-0.5 points over 3 s against placeholders,
inside the morph's own cost — which is `WindowCapture.ts`'s "one render pass, one-shot, never polls"
claim measured rather than trusted. ⚠️ One round showed a 0.1 % / max 16 blip while held open; rounds
2 and 3 read a flat 0.0 % / max 0, so it was a late-landing capture, not a load. A single round of a
number this small says nothing.

**Nothing to fix, and nothing left to tighten**: the overview's band is 2543 px of a 2560 px monitor
because the panel genuinely is that wide. It stays the most expensive island mode, and it is the
cheap kind of expensive — paid only while it is open, which is seconds.

#### Also dead: shaping the region to the squircle's curve

`wl_region` takes rectangles, but a region is a SET of them, so a curve IS expressible as a
staircase — that is how pixman represents any shape. It is still not worth doing, twice over.

**The area is noise.** What sits between the bounding rect and the squircle is `4r²(1−π/4)`: for the
CC's 356x610 panel that is ~494 px² at `RADIUS.lg` (0.23 %) and ~879 px² at the island radius
(0.40 %). The 16px safety pad we add ON PURPOSE is +14.7 % of the same panel — 35-65× more than the
corners could ever return. And §46 measured that you pay for *the region expanded by the blur
radius* anyway, so the kernel hands the corners straight back.

**And it would cost.** Hyprland iterates the clip region's rects when drawing (`OpenGL.cpp`, the same
behaviour that makes a declared region cheap), so a ~30-rect staircase per corner is ~120 extra
iterations per panel per frame. Worse, the scissor is hard: a staircase off by 1px eats the squircle's
antialiased Cairo edge — reintroducing a fixed artefact to optimise 0.3 %.

🔑 **And it would not help an EFFECT either, which is the usual reason someone asks.** The shape of a
compositor effect is driven by the surface's per-pixel ALPHA, not by the region — that is exactly
what `ignore_alpha` does, which is why today's blur already follows the curve including its AA edge.
The region decides what is COMPUTED, `ignore_alpha` decides what is SEEN. For refraction specifically
a tight region is actively wrong: refraction displaces pixels from OUTSIDE the drawn shape inward, so
it samples past the edge and a curve-hugging clip would cut the samples it needs — that direction
needs MORE pad, not less.

**Refraction itself is settled and CLOSED (2026-06-12) — do not re-explore it either.** True
Liquid-Glass refraction needs the backdrop pixels, which by Wayland's design only the compositor has:
there is no client-side path (GTK4 has no `backdrop-filter`, SVG filters cannot touch the backdrop,
and `GskGLShader` is deprecated and non-functional on the current renderers). A Hyprland **plugin**
could do it per drawn element, alpha-mask-driven exactly like blur — hyprglass's whole-window look
was that plugin's limitation, not the mechanism's — but the plugin route was rejected before
publication: the plugin API breaks every Hyprland release and a crash takes the whole session down.
The `if hl.plugin.hyprglass ~= nil then … end` block in `hyprland.lua` is **inert by design**; it is
not a missing install, and do not wire `hyprpm` into `install.sh` for it. The only sustainable route,
if this is ever revisited, is proposing it upstream to Hyprland's blur engine the way `vibrancy` was.
A client-side "fake lens rim" (a Cairo/CSS specular edge over the existing compositor blur) was
offered and declined — the compositor blur is good enough.

---

## Meta: how to interpret "tech debt" here

Not a bug list — conscious tradeoffs to pay down opportunistically:
1. If you're already in a file, prefer the "right fix" direction — but only if small and
   self-contained.
2. If it would balloon your change, leave it and add a comment linking here.
3. **Don't refactor as a side-effect of an unrelated change** — drive-by fixes tend to be
   partial and create drift.

### 47. Design-token audit — CLOSED for `ui/shell` (2026-08-03)
Raised by the user reviewing the scroll bar: *"parece que hemos puesto un valor distinto cada
vez que hemos hecho algo"* — the specific catch was the bar-expansion capsule at radius **20**
while windows are **24**. Correct.

**✅ Radii — closed, TS/TSX *and* SCSS.** One ladder in `ui/lib/tokens.ts` mirrored by
`--nidara-radius-*`; **zero radius literals in `ui/shell`** (`64 → 32` Workspace Overview,
`20 → 24` bar expansion + CC context menu, `18 → md` app-grid tiles, `14 → md` popover,
`12 → md` ws-strip tile, `8 → xs` calendar cell, new `xl: 32`). Two literals turned out to be
**stadiums, not rungs** (`pill`, no pixels changed), and two entries were rounding nothing and
were deleted: the `--nidara-radius-squircle: 28%` token (zero consumers, ever) and
`.prism-result-icon` (`border-radius` on a background-less `Gtk.Image`). Rationale — why the
ladder is deliberately NOT on the 4px spacing scale, why `sm` is derived from the card inset,
and the stadium rule — is in `design-system.md` under "Radii — ONE ladder".

**✅ Spacing — closed.** SCSS margins (8 of 43 off-scale) in the first pass; then the TSX side,
**164 off-scale values down to 4**, all derived and commented; then SCSS container padding.
The structural fix underneath it: **row heights are declared** (48 one-line / 72 two-line via
`min-height` on the kit component's own classes, which is why the same row measured 43px on
Network and 47px on Appearance), and container padding sits on three tiers — dense panel 8/12,
window row 12/16, island 16/20.

**The rule that governs any future sweep here: the token for a control is the HEIGHT (24 compact
/ 32 control / ~48 row), not the padding.** `nidara-kit/row.ts`'s `margin_top/bottom: 14` is
what lands a `$fs-small` row at 48; `button.nidara-btn`'s `padding: 5px 14px` and the alert
footer's `14px` are the same shape; the switch's `slider { margin: 3px }` is (24 trough − 18
slider)/2. Snapping those to the 4px scale resizes the shell instead of tidying it.

Untouched on purpose and still correct: optical nudges on text (`_bar.scss` `margin-top: 5px`,
`.rec-elapsed-big` 6/2), derived sizes (`.accent-circle-btn` 30 = 24 swatch + 3+3 border), and
alignment axes (Prism's `22`).

**What is genuinely left:**
- **The bar capsule** — `Bar.tsx`'s `margin 14` and `_bar.scss`'s `padding: 6px 14px` are one
  unit; they move together or not at all, and moving them changes the bar's height.
- ~~**The greeter and lockscreen bundles**, which carry standalone stylesheets that never
  import the token layer.~~ **DONE 2026-08-09 — see #57.** The prediction that it was "only
  verifiable in a VM" was wrong twice over, and both corrections are worth carrying: the
  *shell* half is verifiable by DIFFING the compiled CSS (a pure extraction must move zero
  declarations, and it did), and the *greeter/lock* half by rendering the surface offscreen
  (`scripts/dev/lock-probe.js`). The VM is still the gate for blur, the painted glass and the
  session-lock protocol — but not for type, colour and spacing, which is what had drifted.

### 48. Art rounding is three unrelated numbers (2026-08-03)
Found while closing #47, and deliberately NOT swept with it (see rule 3 above — don't refactor as
a side-effect). The radius ladder governs container corners; **rounding a bitmap is a different
job**, done in Cairo by `squircleThumb(pixbuf, w, h, radius, cssClass)` because GTK4's
`border-radius` does not clip a child's rendering. Those radii are art proportions, not rungs —
but right now they do not agree with each other either:

- `widgets/clipboard.ts` — `THUMB_RADIUS 8` on a 32px thumb = **25 %**, the macOS icon ratio.
- `NotificationCenter.tsx:75` — `12` on a hero whose `size` is a **parameter**, so the ratio
  changes with the caller.
- `NotificationCenter.tsx:103` — `16` on the big hero, width and height variable.

The likely answer is one exported ratio (~25 %) applied to the art's short side, with a floor so
a small thumb does not go nearly-circular. Low priority: it is visible only on notification art
and clipboard image rows, and changing it moves how every notification looks — worth doing when
something else is already touching that surface.

### 49. The bubble menu is copy-pasted three times (2026-08-03)
`DockItem.tsx`, `AppGrid.tsx` and `widgets/media.ts` each build the same popover by hand:
`new Gtk.Popover` → `Gtk.Grid` → a `DrawingArea` painted by `paintGlassBubble(…, { radiusMax: 16 })`
→ a `nidara-menu` rows `Gtk.Box` → a `Theme.connect("changed")` redraw (plus its disconnect
bookkeeping) → `set_child`/`set_parent` → `sideFor(position)` for the arrow side → a layout
function putting `BUF + PAD (+ ARROW_H on the arrow side)` on four margins.

**The evidence it should be one component: the `PAD` line had to be hand-edited in all three files**
when the dense-panel halo became `rowInsetFor()`. Nothing links them, so a fourth bubble menu would
start from a copy of whichever one its author found first.

The extraction is `GlassBubbleMenu({ anchor, position, buildRows })` in `ui/shell/common/` (shell,
not the kit — it needs `Theme` and `GlassBubble`). What differs per call site and has to stay
parametric: when the rows are rebuilt (dock and app grid rebuild per show, media on source change),
whether the side is recomputed on move, and the destroy-time signal cleanup. Deliberately NOT done
inside the token audit — refactoring three interactive surfaces belongs on its own branch with its
own live check (rule 3 at the top of this file).

### 50. The dock froze its reconciliation under any overlay — FIXED (2026-08-04)
`DockCore.update()` began with `if (menuState.openCount > 0 || status.isAnyOverlayOpen) { needsUpdate
= true; return }`. The menu half is real (rebuilding the item row under an open context menu shifts
the tree the menu is anchored to — the "ghost menu"). The overlay half was a **perf guess from April
2026** ("skips full update() cycle when isAnyOverlayOpen to reduce GPU/CPU load", commit `0484c5c7`)
resting on the premise that an overlay consumes the screen. That premise was never true: CC, NC,
search, the system menu, the island and a bar expansion all live in the BAR's window and none of them
covers the dock — while the app grid, which does cover it, lives in the dock's own window and was
never in this guard (§18).

It became a user-visible bug the moment an overlay could stay open for minutes. `island_mode` counts
as an overlay, and the Assistant holds it for a whole conversation, so **every app the agent launched
got no dock icon until the user closed the island** (user-reported). Measured before the fix: open
the CC → `nidara-ipc launchApp org.gnome.Calculator` → window on screen, no dock icon; close the CC
→ icon appears. There was also a hidden 100ms retry loop for the whole time an overlay was open
(`update()`'s `finally` re-arms whenever `needsUpdate` is set, and the re-run hit the same guard).

Fixed by dropping the overlay clause; the `notify::cc-open`/`nc-open`/`prism-open`/`system-menu-open`/
`island-mode` listeners went with it, since they existed ONLY to flush the update the guard had
deferred. **Don't re-add an overlay guard here.** If dock rebuild cost ever needs paying down, the
lever is the rebuild itself (`widgetCache`, create-before-destroy), not suppressing correctness while
a surface the user is looking at is open.

### 51. The island↔bar tracking is accepted as INTERIM — the owner wants a mechanical fix (2026-08-04)
The watch in `Bar.tsx` is correct, costs nothing in a healthy session and is verified end to end
(`architecture.md`), but the owner's call after seeing it is explicit: **it is still too much logic
for what it buys**, and the direction to aim at is a mechanism that holds the island level *by
construction* rather than shell code that notices and corrects. Recorded so nobody mistakes the
current state for the intended end state.

What has already been tried and must not be re-proposed as-is (measured, `architecture.md`):
sharing the bar's `exclusive_zone`; `zone = 0` + `margin_top = -40` (perfect vertically, **50px
off-centre horizontally with a side dock** — half the dock's own reservation, demoed live).

The two avenues that are actually still open:

1. **Upstream Hyprland: an event when a monitor's reserved area changes.** This is the missing
   primitive and the honest fix — `arrangeLayersForMonitor` already knows the usable area changed,
   and today nothing on the IPC socket says so, which is the ONLY reason the shell polls. With it,
   the watch collapses into one `hs.connect(...)`. Nidara has landed upstream work before
   (Aylur/astal#451), so this is a realistic PR rather than a wish.
2. **`zone = 0` + negative margins cancelling OUR OWN reservations on all four edges.** Foreign
   reservations (the error bar) then come for free from the compositor and only our own dock needs
   bookkeeping — which the shell sets itself, so it is an event we own, not a poll. Two known
   catches, both real: it relies on the bar being arranged BEFORE the dock (creation order, not
   something Hyprland promises), and with `zone = 0` the compositor never tells the client where it
   put the surface, so `occupiedRect` loses the position it exists to report.

Considered and dead: making the island a Wayland **subsurface** of the bar (it would track the parent
perfectly and for free, but a subsurface is composited as part of its parent's layer surface, which
costs the island its own blur pass — the entire reason it is a separate surface at all).

### 52. IDEA (owner, 2026-08-04, NOT a plan): split the bar into left/centre/right surfaces
Floated as a possible future layer restructuring, also hoped to help the window-title truncation and
the capsule count on the right. Recorded with the analysis so it is re-opened with the numbers rather
than from scratch.

**The blur win is in the HEIGHT, not in the split.** `nidara-bar` is 2560x1440 only because the
overlays live inside its window (commandment 5). Evict them and the bar becomes a static 2560x48
strip — which captures nearly all of the win §46 measures (full-screen blurred layer +5.9 pts vs
+0.4 for one sized to its content). Cutting that strip into three adds almost nothing on top. **So
the two changes are independent, and only one of them pays: "overlays out of the bar's window" (with
their surface MAPPED only while something is open — unmapping drops the blur pass entirely) is the
move with measurable return; the three-way split has to justify itself on layout grounds alone.**

**On layout it does not currently justify itself.** The three groups still share one 2560px row and
still cannot overlap, so nothing about the title limit or `measureOverflow` gets easier — the
arbitration merely moves from GTK (`CenterBox` + the `SizeGroup` that absorbs slack when the title
grows) into shell code we write. That is trading mechanism for logic, against the owner's stated
direction (§51). Letting a long title run under the island is already possible today inside one
window via the bar's `masterOverlay`.

**The strongest objection is the one the July island split already paid for: there is no ATOMIC
COMMIT across two Wayland surfaces.** That is what killed splitting the island into capsule + modes
(`handoff.c`, 2026-08-02): the small surface always presented first, so the handover showed a gap on
open and doubled glass on close, and no ordering fixed it — the two commits land in different frames.
Three bar surfaces have no *handover*, so that exact failure does not apply; what does apply is any
change that must land in all three AT ONCE. And that is precisely the coupling this idea was meant to
improve: truncating the window title requires knowing where the centre capsule ends, and the capsule's
width moves on its own (a media title of a different length reshapes the pill with no page change).
Today that is atomic — GTK allocates all three groups in one pass into one buffer. Split, the island
would resize in one frame and the title's new limit in another, so the two would visibly collide or
gap for a frame every time the music changes track. **The coupling that motivates the split is the
coupling that makes it unsafe.**

**Two further inherited hazards, both already paid for once.** (1) Only ONE of the three could hold the
exclusive zone, so the other two would have to follow it — today's island↔bar divergence (§51),
twice over. (2) Any of the three that sizes to its content (title length, tray count) resizes, and
§46 established that a resizing layer surface produces a visible grow artefact that is
compositor-side and unfixable from the widget tree. Fixed-width surfaces avoid it and remove the
flexibility that motivated the idea.

### 53. ✅ CLOSED — every modal surface is on the focus grab, and it is the ONLY mechanism (2026-08-05)

`hyprland-focus-grab-v1` landed via `lib/nidara-wl` + `common/FocusGrab.ts`. **Migrated:** every
overlay in the bar's window (CC, notification centre, system menu, Prism, bar expansion) under ONE
grab on that surface, the Activity Island under its own, and the app grid under the dock's — and the
bar and island **whitelist each other's surface**, so capsule switching stays one click in both
directions. **Both catchers are GONE, and so is the layer-shell `EXCLUSIVE`/`ON_DEMAND` path they
backed** (2026-08-05): the protocol + libnidara-wl are a HARD REQUIREMENT, and their absence is a
loud `console.error` rather than a silent degrade — the user's call, so that a failure is seen
instead of being quietly covered up. Mechanism and traps in `architecture.md` → "Focus grab".

⚠️ **Deleting the fallback was a second pass, and the half-migrated state in between was misleading**
(2026-08-05). With the catchers gone but `EXCLUSIVE` still wired, the "fallback" gave the keyboard
and no dismissal — working enough to look intentional. It also hid a real defect: `Bar.tsx`'s
`islandGrabbing` still read `island.needsKeyboard()`, correct under `EXCLUSIVE` (only typing modes
took input) and wrong under a grab (every mode takes one, and a grab clamps POINTER focus), so an
ambient island mode held the pointer while `inputYield` reported no holder and computer-use clicks
would land on the island. 🔑 **When a mechanism is replaced, the leftover branch is not free
insurance — it is a second set of assumptions that stops being audited.**

The first live round produced three bugs worth knowing about, all fixed (2026-08-05) and all from the
same two roots: **the single grab had two independent owners** (fixed with ownership tokens +
notifying the evicted owner) and **removing the catcher removed the accidental full-screen input rect
that was covering panels GTK had not laid out yet** (fixed with `onAllocated` on both revealers).
Neither is a focus-grab quirk as such — they are what the catcher had been hiding.

**What is left, and why it is not just more of the same:**

- **Workspace switching from a shell surface goes through ONE method**,
  `HyprlandState.focusWorkspaceFromShell` — the app grid's strip and the island's workspace overview
  both call it, so they cannot drift apart again. It now just forwards to `focusWorkspace`, and is
  kept as the single door rather than inlined. The history is worth having: under `EXCLUSIVE`
  Hyprland refused to move window focus at all, so switching first landed you on a workspace with
  nothing focused, and the surface's later release made `refocusLastWindow` answer with the window
  you came from — dragging that workspace back over you (measured closing the grid from the dock
  button: `5 → 1 @425ms → 5 @454ms`). ⚠️ **A window on the target did not save you** (the "only empty
  targets bite" read predates the grid), and correcting it afterwards is what the user saw as the
  workspace animation setting off and changing its mind. 🔑 The fix was ORDER — hand the grab over,
  then switch — and a compositor focus grab has nothing to hand over, because it never refused focus
  moves in the first place. That is why the `drop`/`retake` lending pair is gone.
- ✅ **The app grid was the last surface to migrate.** It was held on layer-shell `EXCLUSIVE` by its
  `Gtk.Popover` context menus, which take the same single compositor grab slot — unblocked once
  `FocusGrab` learned to SUSPEND a lease for the life of a popup. Verified by injection: the grid
  takes the keyboard with the surface at NONE (`wtype` lands in its search entry), a right-click menu
  no longer dismisses it and the lease is retaken when the menu closes, an outside press dismisses
  and hands the window back, and the workspace strip switches cleanly.
- **All three surfaces now set layer-shell keyboard interactivity exactly ONCE, to `NONE`, at init**
  (bar, island, dock). If you find yourself calling `set_keyboard_mode` anywhere else, that is the
  bug: `EXCLUSIVE` re-adds the surface to `m_exclusiveLSes` and hands back the focus refusal the
  grab exists to remove.
- `core/InputYield` and `HyprlandState.afterGrabRelease` **do not die with the fallback**. A grab
  clamps POINTER focus to the grabbed surface, so computer-use still cannot reach the app it was
  aimed at until every holder lets go; all three surfaces route through `inputYield`, and a yield
  now drops the grab outright (with its dismissal) for the length of the truce. `afterGrabRelease`
  stays because `refocus()` runs on the compositor's clock, not ours — a focus-grab release is not
  double-buffered, so what it waits for is the announcement, not the old ~12 ms commit race.
- `cc_edit_mode` deliberately takes NO grab: it is the one open state that leaves the desktop
  interactive, and a grab would take that away. Do not "fix" the inconsistency.

**Do not migrate the dock's own menus.** They are popovers by design (the `#14` glass rows), so they
are the *other* side of the slot collision, not a candidate.

### 54. ✅ CLOSED — the overview's tile geometry was STALE while its capture was FRESH (2026-08-06)

Real thumbnails landed (`WindowCapture` + `WindowThumbnail`) and exposed a pre-existing bug the flat
schematic tiles had been hiding: resize a window under tiling and its thumbnail came back
**squashed**, because the capture reflects reality and the tile it was painted into did not.

**This entry asked which of two causes it was — a stale cache, or a "changed" that never fires. It is
neither, and both: they have one root, and it is that Hyprland emits NO event for a resize.** Not
one. The whole `socket2` list (0.56) carries `movewindow` (a *workspace* change), `openwindow`,
`closewindow`, `changefloatingmode`, `windowtitle`… and nothing geometric. So there was no signal to
re-sync on, and the cached list held whatever the last unrelated event happened to leave behind.
Measured, not reasoned: closing a third window on a tiled workspace left Telegram cached at **858 px**
wide against a real **1722** — `closewindow` is the one window event AstalHyprland handles *without*
re-reading the rest of the list.

**Fix:** `HyprlandState.readGeometry()` — a coalesced one-shot `hyprctl clients -j` — handed to
`SchematicHandle.sync(geom)` for that pass only, and awaited *before* the captures are requested (the
tile size is what a capture is sized to). Deliberately not cached anywhere; the reasoning, including
why a stored snapshot would eventually be *worse* than the cache it was meant to correct, is in
`architecture.md` → "Window GEOMETRY is the one piece of window state that no event announces".

Fixed alongside it: the overview's startup layout pass was firing a capture per window for a surface
nobody was looking at, and every one failed with `buffer_constraints` — the shell was starting, its
bar and dock were claiming their exclusive zones, and those windows were being resized underneath a
session that had just advertised the old size. `refresh()` now arms capturing, so nothing captures
until a surface says it is opening.

⚠️ **Residual, not worth fixing until something asks for it:** a capture taken *while* a window is
being resized can still fail with `buffer_constraints`, and the shim does not retry. Nothing in
flight resizes windows any more; a live switcher would.

### 55. ✅ CLOSED — the wallpaper IS the workspace backdrop (2026-08-06)

`WorkspaceSchematic`'s canvas painted a flat `rgba(0,0,0,0.3)`; it now paints the wallpaper actually
in use, dimmed by `WP_SCRIM` and clipped to a proportional rounded rect. Mechanism and rules in
`architecture.md` (the schematic's backdrop). Answering the cost question this entry opened with:

- **One decode for the whole shell**, shared by five overview cards and the app grid strip —
  `WallpaperManager.preview`, bounded to 960px = **2.07 MB measured** (vs ~33 MB for the 4K
  original), decoded **in a worker thread in 47 ms**. The naive per-tile decode was indeed the wrong
  version; reusing awww's image was not possible (awww paints in the compositor, it hands nothing
  back), so a bounded decode of our own is the answer.
- **One-shot, so the continuous-GPU rule is not engaged**: it is a pixbuf painted by an existing
  Cairo `draw_func`, not an animation.
- Because it costs nothing *per surface*, it is deliberately **not opt-in** the way captures are.

### 56. ✅ DONE (2026-08-07 → 2026-08-10) — unscoped partials; commandment 2 was never two-thirds kept

✅ **Follow-up closed the same day: the misleading `cc-*` vocabulary is renamed.** Three families
whose prefix claimed the Control Center owned them are now `nidara-atomic-*`, `nidara-media-*` and
`nidara-detail-*` — the rule and the survivors are in `design-system.md` ("A class prefix names its
OWNER"). It is worth knowing WHY this was debt and not tidying: the `cc-` prefix is what made
`.cc-media-*` look at home inside `_control-center.scss`'s `#nidara-bar` block, which is the bug
below that ran for months. **A name that misfiles a rule in a reader's head eventually misfiles it
in the sheet.** Verified by a compiled diff (new names normalised back → `style.css` byte identical),
`scope-audit` green on all six windows, and typecheck.

✅ **And `_dock.scss`'s `&>box` closed the same day** — measured dead, deleted, and the note that
warned about it corrected (see the sixth-dead-selector entry below; it was wrong).

✅ **And the last item closed 2026-08-10 too**: the four kit classes with no consumer turned out to
be TWO things, not one — three opt-in aliases whose element half is fully live (zero consumers is
their expected state), and `.nidara-tile`, an unfinished increment, now deleted. **§1 is the entry;
this line used to lump all four together and point at a list §1 no longer has.**

⚠️ **The scoping work left a casualty of its own, found 2026-08-10: the kit's alert dialog.**
`showNidaraAlert` builds its own toplevel `Gtk.Window` (transient, therefore a SIBLING root), and
its rules sat at column 0 in `_settings.scss` from 2026-05-24. #97 wrapped that sheet and swept them
inside, compiling `window.nidara-settings-window window.nidara-alert-dialog` — unmatchable — so
Bluetooth pairing, the Display resolution confirm and Delete user rendered as raw GTK for three days
(footer buttons `4 9` against their declared `14 16`, heading at weight 400 not 600; the entry alone
looked passable because the global `entry` rule in `_components.scss` caught it). Now `_alert.scss`
with its own root, the same shape `.about-*` got in the same sweep.

🔑 **Both casualties of #97 are the same lesson from opposite sides: wrapping a file changes the
meaning of what was inside it.** `_app-grid.scss` was an `&` that re-expanded; this was a second
WINDOW that happened to be filed in the sheet. And this one hid better — `.about-*` was in
`_bar.scss` "only by position", obviously misfiled, while the alert dialog is *called only from
Settings*, so filing it there looked correct. **Ask which window a widget IS, never which window
opens it.** `scope-audit.mjs` grew a pass 2 for the shape (a window scope root in non-initial
position is impossible by construction) precisely because pass 1 could not see it: it attributes
every `nidara-kit` class to Settings, so it read the dead rule as reachable and passed.

**Closed 2026-08-10 with `_bar.scss` + `_dock.scss`, the last two.** Earlier stages:
`_control-center` and `_prism` → the bar's window; `_settings` → its own; `_workspace` → **split
across two** windows (see below); `_app-grid` on 2026-08-09, by a route this entry did not foresee —
the grid got a WINDOW of its own (§18), so it is scoped to `#nidara-app-grid,
.nidara-app-grid-window`, not to `#nidara-dock` as planned here.

**"~10 rules" was wrong — measured 2026-08-09 at ~37** (`_bar.scss` 34, `_dock.scss` 3), and the
count was the least interesting part. What the final pass actually found:

🔑 **The window a class lands in is not the folder its TSX lives in.** `Bar.tsx` builds the capsule
row and hands it to `islandWin.mount()`, so `.bar-center` renders **only** in `#nidara-island`;
`.bar-centerbox` is built twice and needs both scopes (deliberately — `islandRow` reuses the class
so the 8px top margin and 40px row height come from one rule instead of a constant duplicated across
two windows); `.workspace-dot` is island-only, since `makeWorkspaceDot` is called from the island and
from the overview, which is mounted inside the island. Filing any of them under `#nidara-bar` on the
strength of the filename would have unstyled the capsule and every workspace dot, silently. The
method is grep the class → grep where its widget is `append`ed/`mount`ed.

🔑 **Two more DEAD selectors, bringing the total to five**: `#the-dock-bar` (`_dock`; no widget in the
shell carries that name) and `.bar-capsule` (`_bar`; survives only in a comment at
`surfaces/bar/capsule.ts` — it was the dead half of the tray focus-kill rule).

🔑 **A live bug fell out of the audit, in a file that was already "done".** `_app-grid.scss` had
`.app-grid-search-box:focus-within &` written inside `.app-grid-search-icon`. Correct while that rule
was top-level; after #102 wrapped the file in the window scope, `&` expanded to `#nidara-app-grid
.app-grid-search-icon` and the rule compiled to `.app-grid-search-box:focus-within #nidara-app-grid
.app-grid-search-icon` — a window nested inside a search box. The icon had stopped turning accent on
focus and nothing reported it. **Scoping a file is not a wrapper you can add without reading it**:
every parent-referencing `&` inside changes meaning. Cheap detector: grep the compiled `style.css`
for `#nidara-` anywhere other than the start of a selector.

🔑 **The reverse failure was live too, and older.** Scoping a sheet to a window it does not fully own
is the same bug pointed the other way, and `_control-center.scss` had it since #97: `.nidara-media-*`
sat inside its `#nidara-bar` block, but `widgets/media.ts`'s `buildMediaDetailPanel` is shown by the
bar pill expansion, the CC detail page **and the island's PLAYER mode** (`PlayerIsland.tsx:42`).
From the day the island became its own window the transport buttons and the source selector rendered
with raw GTK defaults, for months, silently (user-caught 2026-08-10). Fixed by giving the block both
scopes — kept window-scoped rather than made global on purpose, so the specificity balance is the
same in both windows (`.cc-island button` and `.bar-center button` are (1,1,1) and would beat a bare
`.nidara-media-*`). **Instrument, reusable:** for every class used by code that renders into a given
window, check the compiled `style.css` for at least one selector that is unscoped or scoped to that
window; classes with no CSS are Cairo-painted, classes whose only selectors name another window are
the bug. Found it in one pass over 54 classes.

**Two relocations rather than scopes**, both because the class had no surface to belong to:
`.nidara-confirm-*` (a `nidara-*` name = kit) and `.bar-popover-key/-val/-value/-icon-btn` (worn by
`widgets/`, which the USER places — bar today, CC grid today, plugin-placed tomorrow) → `_components`.
`.about-*` came out into its own `_about.scss` scoped to `window#nidara-about, .about-floating-window`:
it is a separate toplevel and was never part of the bar in anything but file position.

✅ **`_dock.scss`'s `&>box` was the SIXTH dead selector — measured and deleted 2026-08-10.** The dock
window's direct child is a `Gtk.Overlay` (`DockCore.tsx`: `win.set_child(windowOverlay)`), so
`window.nidara-dock-window > box` never matched.

🔑 **The warning this entry used to carry was WRONG, and the way it was wrong is the lesson.** It
said the redundant `windowOverlay` was tempting to remove and that removing it would make the
selector START matching — a silent behaviour change in the opposite direction. It would not:
`layout` is a `Gtk.Overlay` too (`DockAxis.ts`, both axes), so the direct child stays an overlay
either way, and that cleanup was safe the whole time. **The note was reasoned from one level of the
tree and guarded nothing for a day.** A caution written from a source read is a hypothesis, and it
gets the same burden of proof as the claim it cautions against.

🛠️ **How to settle "does this selector match anything?" — ask it, don't derive it.** Declare the
selector with a sentinel value nothing else uses (`padding: 37px`), rebuild the widget nesting on the
broadway backend (`gtk4-broadwayd :5`, `GDK_BACKEND=broadway`), walk the tree and print which nodes
came back with it. ~50 lines, no permanent script — the tree is bespoke per question, which is why
this is a technique in `dev-workflow.md` rather than a committed tool like `scope-audit.mjs`.
**Always run a control variant whose child really IS the node you are asking about**: 0 hits means
nothing until something has produced 1. Result here — control 1, today's tree 0, wrapper-removed 0.

⚠️ **A plain `Gtk.Window` probe does not stand in for a layer-shell surface**, so it was confirmed
against the running shell: `nidara-ipc queryUI .cd-layout` → `path: "GtkWindow.fullscreen >
GtkOverlay"`. `queryUI` reports ancestry for exactly this kind of question.

⚠️ **Only half the rule was provable.** `decoration, &>box { … }` kept its `decoration` half:
`decoration` is a GTK-internal **CSS node, not a widget**, so no widget-tree walk — probe or
`queryUI` — can see it, and nothing here says whether it is live. Deleting what you measured and
leaving what you did not is the honest split (same shape as `.bar-capsule`, where half a rule was
dead and half was not).

⚠️ **Nothing mechanical proves a scoping pass correct.** Compiled class coverage comes out identical
either way; a misfiled rule stays in the sheet and just stops matching. The 2026-08-10 pass diffed
old vs new `style.css` selector-by-selector (every old selector must reappear with a scope prefix and
the same body) — that catches deletions and typos, **not** a rule scoped to the wrong window. Only
looking at the running shell does. Live human validation is part of "done" for this kind of change,
as it was for #97.

**The original entry was wrong on three counts, and the corrections are the useful part:**

1. **Two of the six named files must STAY global, and are not debt.** `_base.scss` declares tokens on
   `*` — scoping breaks custom-property inheritance into every other window and popover.
   `_components.scss` is the shared widget kit (`entry`, `.nidara-*`) used by every shell window;
   scoping means duplicating it per window name. Same for `_reset.scss` and any `@keyframes` (not
   scopable in CSS at all). Commandment 2 now says so explicitly — it read as violated in six files,
   which teaches an agent to ignore one of the ten rules.
2. **The stated failure mode cannot happen.** It claimed a rule could leak "into the greeter or
   lockscreen sheets". `ui/greeter/style.scss` had **zero** `@use`/`@import` — it was standalone, and
   the lockscreen compiles that same file. No path existed. The real (and only preventive) risk is
   collision *between shell surfaces*.
   ⚠️ **Re-check this if you rely on it: since 2026-08-09 that sheet DOES `@use`** —
   `ui/lib/styles/_tokens.scss` (see #57). The conclusion still holds, because that file emits
   no CSS of its own (variables plus one mixin the consumer includes), but "standalone, no path
   exists" is no longer the reason. The reason is now that the shared file is output-free, which
   is an invariant somebody has to keep.
3. **The scoped/unscoped split was inaccurate.** `_app-grid` and `_dock` were listed as scoped; both
   have top-level global rules, and `_app-grid` is almost entirely global.

**No live collision — verified rather than assumed.** Cross-referencing every class selector across
the 11 partials, the only names declared in more than one file (`.linked`, `.nidara-row-title`,
`.nidara-row-subtitle`) are all nested under a distinctive parent (`.nidara-detail-panel`,
`scrolledwindow.apps-list-scroll`). Nothing was overriding anything.

🔑 **Three DEAD selectors fell out of mapping classes to windows** — each named a window that does not
exist, so none had ever matched: `window#nidara-app-launcher` (`_app-grid`, plus two entries in
`_reset`'s neutralization lists) and `window#nidara-dock-vertical` (`_dock`; both dock orientations
are one window, `name: "nidara-dock"`). Also `.wo-schematic-win`, a rule for a class no widget
carries. **The app grid had no window of its own** — its panel was a child of the DOCK's window —
which is why its scope was going to be `#nidara-dock`. ⚠️ **That stopped being true on 2026-08-09**
(§18): the window exists now, `nidara-app-grid`, and `window#nidara-app-launcher` was never it. A
dead selector deleted here and a live one that appeared later are the same lesson twice — **the
window a partial belongs to is a fact about the TSX, and it can change under the sheet without a
single error.**

⚠️ **`_workspace.scss` needs TWO scopes and that is load-bearing.** `common/WorkspaceSchematic.ts`
renders into the island (overview) *and* the app grid (workspace strip). A `.wo-schematic-*` rule
left in the island-only block silently stops painting in the strip. The second scope was
`#nidara-dock` until 2026-08-09 and is `#nidara-app-grid` now — this warning caught its own rename.

⚠️ **What scoping silently changes, and the fix that shipped with it**: CSS resolved on an unrooted
widget *because* these rules were global. Anything reading a styled value from a widget outside a
matching window (`get_style_context().get_padding()` on a probe) now returns 0 — **no error**.
`scripts/dev/gtk-probe.js` therefore takes `SCOPE=settings|bar|island|dock|appgrid` and prints it.
Measured proof the hook is not cosmetic: the same dropdown row is **29px** under `SCOPE=settings` and
**28px** anywhere else, because Settings re-anchors control text to the relative `$fse-*` ramp.


### 57. ✅ CLOSED — the design system reaches the greeter and the lockscreen (2026-08-09)

The debt closed by #47's leftover bullet. `ui/greeter/style.scss` (shared by both bundles) had
its own `* { }` re-typing the radii and the palette, plus eleven freehand `font-size` values.
The mechanism and the rules now live in `design-system.md` → "The design system reaches the
greeter and the lockscreen"; what belongs HERE is what it cost and what it left open.

**Shape of the change:** `ui/lib/styles/_tokens.scss` holds the mode-independent half of the
system (type ramp, weights, line heights, spacing, motion, radius ladder).
`ui/shell/styles/_base.scss` `@forward`s it — so every `@use 'base' as *` is untouched — and the
greeter sheet `@use`s it. `ui/lib/tokens.ts` grew `LOCK_GLASS`, the numeric half of the glass
mirror the lockscreen's painter needs. `ui/lib/icons.ts` gives the two `core/`-less bundles the
shipped icon set. New instrument: `scripts/dev/lock-probe.js`.

**Verified:** shell `style.css` diffed before/after → identical but for comments, zero
declarations moved. Both bundles build; `ui/shell` typechecks. Offscreen renders of the greeter
surface, dark and light backdrop, before and after.

🔑 **The lesson worth keeping is about the SHAPE of the drift, not the fix.** Nothing here was
broken and nothing had regressed — the surface had simply stopped moving, one shell decision at
a time, for as long as arriving required somebody to re-type the value by hand. It was invisible
in every individual diff and obvious in one ratio (13px date under an 88px clock). **When a
surface has its own copy of a shared decision, "it looks fine" is not evidence; compare it to
the system it is supposed to belong to.**

**What this deliberately did NOT touch, and why:**
- **Control-internal padding stayed literal.** Eleven of them, and they are height arithmetic
  toward a target box (`min-height` + border + line box), not gaps — the two-layer rule in
  `design-system.md`. Snapping them to `$space-*` would resize every control on both screens.
- **The `450ms` card entrance stayed off the `$dur-*` ladder**, with a comment saying so: those
  three time a control's state change, and this is a full-screen surface arriving. Only the
  CURVE was freehand (plain `ease`, now `$ease`).
- **The power bar's `4px 6px` inset stayed put.** It is the fill margin that keeps the buttons
  inside the bar, and it was fixed by hand the day before after being briefly removed.

**Left open (all pre-existing, now with evidence):**
1. ~~**The greeter's capsules should be PAINTED.**~~ ✅ **DONE 2026-08-09** — the painter moved
   to `ui/lib/glass-capsule.ts` with the backdrop OPTIONAL, and both bundles use it (entry,
   primary button, power bar, plus the greeter's locale bar). The `window.nidara-lock-window`
   CSS block is gone: there are no lock-only rules left. Doing it surfaced a real bug the lock
   could never have shown — see `design-system.md`, "the rim has to be a RING".
2. ~~**Bare text over a light wallpaper is illegible.**~~ ✅ **CLOSED 2026-08-09** — a
   `.greeter-scrim` gradient plus a shadow on the three bare labels, everything peaking at 0.28
   so the greeter's `ignore_alpha = 0.3` never triggers and both screens render the same. The
   candidates were rendered rather than argued (`lock-probe.js`, 87 %-luminance backdrop), and
   that settled it against the intuition: **the shadow alone was the WEAKEST of the five** — it
   outlines the glyph without lifting the contrast under it, so the hero went from invisible to
   ghostly. Mechanism and the 0.3 ceiling in `design-system.md`.
3. **`ui/greeter/style.css.map` is tracked while `style.css` is gitignored**
   (`.gitignore:110`), so every build dirties the tree with the `.map`. Cosmetic, but it makes a
   `git status` after a build look like it contains a change it does not.
4. ~~The greeter and lockscreen still **duplicate** `PowerBar.ts`, `Clock.ts` and their i18n
   scaffolding~~ — **RESOLVED 2026-08-10** for the widgets: `ui/lib/power-bar.ts`,
   `ui/lib/clock.ts` and `ui/lib/date-names.ts` (the last one had THREE copies — the shell's
   too). The **i18n catalogs stay per bundle on purpose** and that is now load-bearing rather
   than incidental; see §60.


### 59. NTK — the kit's stylesheet is out of the shell; the other bundles do not import it YET (2026-08-10)

`ui/lib/nidara-kit/` has been importable from any bundle for a long time; its LOOK was not.
Every rule for it lived in `ui/shell/styles/_components.scss`, which only the shell compiles —
`.nidara-btn` appeared **16 times in the shell's compiled sheet and 0 times in the greeter's**,
so a greeter that imported `NidaraButton` would have rendered it as raw GTK. The code was
shared and the appearance was not.

**Done:** the kit's half is now `ui/lib/styles/_components.scss`, with the mixins it needs in
`ui/lib/styles/_mixins.scss` and the relative `$fse-*` ramp in `_tokens.scss`. `_base.scss`
`@forward`s both, so `@use 'base' as *` is unchanged. The split rule and the bundle-import
caveat are in `design-system.md` ("The kit's stylesheet").

🔑 **The verification could NOT be "byte identical", and pretending otherwise would have hidden
the risk.** Splitting one file in two necessarily reorders the output — 572 lines moved. What
was proved instead is stronger for this shape of change, in two steps: (1) the compiled sheet
holds **exactly the same 534 selector→body pairs**, none lost, none added; (2) of the 1892
pairs whose relative order flipped, **zero** could apply to the same element at equal
specificity with a shared property — so no cascade outcome can have changed. Keep that script
shape for any future extraction; a rule-set diff alone would have missed a real reorder bug.

**Left open, in the order the NTK plan wants them:**
1. **The greeter's three raw `Gtk.DropDown` → `NidaraDropDown`.** This is what earns the kit
   import, and it must bring the TOKEN CONTRACT with it (17 of the 23 `--nidara-*` properties
   the kit reads are undefined there). ⚠️ Two of the three known selector collisions ARE the
   dropdown, so this migration removes them rather than fighting them. ⚠️ greeter/lock have no
   dev mode — fixed path to `/usr/share`, silent failure — so this one needs a VM pass.
2. **Deduplicate greeter↔lock** (`Clock.ts`, `PowerBar.ts`, the card) — see §57.4 above.
3. ✅ **DONE — `common/Slider.ts` → `nidara-kit/slider.ts` (2026-08-15).** 419 Cairo lines, and
   the first kit component that needed something only the BUNDLE knows. Three dependencies had
   to be resolved rather than carried: `safeDisconnect` and `hexToFloatRgb` were pure and simply
   moved down to `ui/lib/` (both re-exported from their old shell paths, so 46 import sites did
   not churn) — but `ThemeManager` could not move and could not be imported, which is what
   produced the **appearance seam** (`nidara-kit/appearance.ts`, see architecture.md). CSS: the
   mechanical test moved exactly ONE rule, `.slider-fill-value`, because `makeVerticalFillTile`
   builds that label; `.slider-text-endpoint` stayed in the shell's sheet because Settings'
   Accessibility page builds those. (`.slider-value-label` stayed too — until step 4 moved the
   slider ROW a day later and took it along.) No new token entered the kit's contract.
4. ✅ **DONE — the composed rows (2026-08-16).** `toggleRow` / `dropdownRow` / `sliderRow` are
   now `NidaraToggleRow` / `NidaraDropDownRow` / `NidaraSliderRow` in `nidara-kit/rows.ts`.
   (The counts written here — 29/20/32/91 — had drifted; measured on the day, they were
   21/17/14/81. Re-measure before quoting a number from this file.)

   🔑 **The blocker was real but smaller than it read.** `createRow` did not build anything —
   `NidaraRow` has been in the kit for a long time. What `createRow` added was three lines:
   pushing the row's label into Settings' **search index**, via an ambient page context that
   `Settings.tsx` opens and closes around each page's (synchronous, eager) construction. Every
   composed row ended there, so all of them were welded to a side effect only Settings wants.

   🔑 **The split is a PARAMETER, not another seam: `mkRow`.** A composed row now builds its
   control and hands it to whatever row builder it was given (default `plainRow`). Settings
   passes its own `createRow`, which registers then delegates — so all ~130 call sites are
   untouched and the search index behaves exactly as before (verified in the live session: a
   `toggleRow` label typed into Settings' search still resolves to its page).

   ⚠️ **Why a parameter and not a module-level seam like `appearance.ts`.** Appearance is
   per-BUNDLE — one accent per process. Registration is per-CALLER: the same shell has Settings
   rows that must be indexed and `widgets/screenrecord.ts` rows that must not. A global would
   have to be pushed and popped around every build, which is the ambient context being escaped.

   `bindWhileRealized` went to `nidara-kit/lifetime.ts` with them (the rows re-arm their
   external sync through it); `SettingsHelpers` re-exports it. What stayed in Settings:
   `createRow`/`createStackedRow` (they ARE the registration), `listGroup`, `pageBox`,
   `presetRow` (one consumer, and its `settings-*` classes are Settings') and `imagePickerRow`.

   🔑 **The proof that the move was real: `widgets/screenrecord.ts` stopped importing from
   `surfaces/settings/`.** A Control Center widget had been reaching into another surface for
   `pageBox`/`listGroup`/`createRow`/`toggleRow`/`dropdownRow`; it now calls the kit. Its
   `pageBox` was decoration in the CC anyway — `.settings-page` is scoped inside
   `window.nidara-settings-window`, so the class it added styled nothing there.

   CSS: `.slider-value-label` followed to the kit's sheet — `NidaraSliderRow` builds one, so a
   non-shell window would otherwise get an unstyled readout. It is now worn on BOTH sides, and
   that is fine: the shell compiles both sheets, a lone bundle does not. And
   `.nidara-atomic-scale-native` was DELETED rather than promoted: it suppressed the background
   of "the native Gtk.Scale trough", and there has been no `Gtk.Scale` since `d9dca37f` — the
   class rode along in `cssClasses` and spent months being applied to a `Gtk.DrawingArea`.
5. **`_alert.scss` stayed in the shell** even though `alert-dialog.ts` is in `ui/lib/` — it is a
   window-SCOPED block (`window.nidara-alert-dialog`), a different animal from the kit's global
   layer, and no other bundle shows a dialog yet. Revisit when one does.

🔑 **The rule that governs all five: a component enters the kit when its SECOND real consumer
appears, and it enters migrating in the SAME change.** Never declared ahead. The proof is
inside one commit, `69cce101`: the half that promoted `createRow`/`listGroup` and migrated
every call site at once has 23 consumers today; the half that declared `.nidara-tile` and
deferred the migration to "increments 2-3" was never applied and was deleted in #111.

**Amended 2026-08-15 — a second, equally valid trigger, stated out loud rather than smuggled
in as an exception.** The slider had ten import sites and **all ten were inside `ui/shell/`**;
greeter and lockscreen had none, so by the letter of the rule it could not move, and it moved
anyway. The reason it is not a violation: what the rule protects against is designing an API
for consumers you are IMAGINING — and an API that ten real call sites have been exercising for
months is the opposite of imagined. So the trigger is either of:

- a **second consumer in another bundle**, migrated in the same change (the dropdown, the card);
  or
- **many real consumers in one bundle plus an API nothing is asking to change** — proven, not
  predicted.

What does NOT count, under either reading, is "we will need this later". `.crystal-tile` is
still the counter-example, and the ⚠️ that came with this amendment is that the second trigger
gives no free evidence about OTHER bundles: nothing in the ten shell call sites would have
revealed that the greeter cannot supply an accent. The seam exists because the move was done,
not because the consumers predicted it.


### 58. ✅ CLOSED — `GlassCapsule` stopped owning what it should never have owned (2026-08-09)

`ui/lib/glass-capsule.ts` extended `Gtk.Widget` and parented its child by hand
(`child.set_parent(this)`), which in GTK4 obliges you to unparent it on disposal. Nothing did,
so every capsule logged a line per surface teardown — six per greeter render:

```
Gtk-WARNING: Finalizing NidaraGlassCapsule 0x…, but it still has children left:
   - GtkPasswordEntry 0x…
```

**Both halves of the answer are measured, and that is the point of the entry.**

1. The documented fix, a `dispose` override, really is unavailable — the old comment asserted
   it and it is now *verified*: GJS refuses to run a JS vfunc during garbage collection and
   says so out loud, `"Attempting to run a JS callback during garbage collection … The
   offending callback was dispose(), a vfunc … it has been blocked"`. Reproduced in a
   twenty-line specimen, with and without the override; identical warning either way.
2. Which is why the fix is **not to clean up better but to stop hand-parenting**. A `Gtk.Box`
   owns its children's lifetime. The class extends it now, `append()` replaces `set_parent()`,
   and `vfunc_measure` / `vfunc_size_allocate` / the never-called `destroyCapsule()` are gone
   with it — a one-child box already measures and allocates to the child. `vfunc_snapshot` is
   untouched.

Verified: **6 warnings → 0**, and the rendered surface is **byte-identical** (`compare -metric
AE` → 0 differing pixels, same bounds for card, entry and power bar). A pure lifecycle change
with no visual consequence, which is what it had to be.

🔑 **The generalisable part: when a cleanup hook is unavailable, ask why you needed one.** The
entry sat open because the search was for a way to run teardown code, and the answer was to
have nothing to tear down. It also *removed* code — the debt was paying for a container GTK
already ships.

⚠️ The CSS node is now `box`. Nothing in `ui/greeter/style.scss` selects a bare `box` (checked),
but a rule added there later would reach inside every capsule on both screens.


### 60. Greeter ↔ lockscreen: the widgets are one copy now, and injection is the shape (2026-08-10)

Step 2 of the NTK plan. `Clock.ts` and `PowerBar.ts` existed twice, and `dateNames.ts` **three
times** — the shell's copy carried a header naming the other two. Now: `ui/lib/clock.ts`,
`ui/lib/power-bar.ts`, `ui/lib/date-names.ts`. Net −71 lines, and three consumers for the date
formatter.

🔑 **THE DUPLICATION HAD ALREADY DRIFTED, which is the argument for doing the rest.** The
lockscreen's `PowerBar` still carried a comment describing the buttons as "accent and opaque" —
a design deleted in #99/#100 the day before, when accent went back to meaning state only. The
CODE was fixed in both copies and the EXPLANATION in one. That is the cheap version of the
failure; the expensive version is [the dropdown](design-system.md) — same disease, one
generation of unfixed bugs deep.

**The shape for anything promoted to `ui/lib/` that needs to speak: INJECT the bundle's i18n,
never reach for it.** `t()` lives in each bundle's `lib/i18n.ts` and stays there — the catalogs
are deliberately different sizes (greeter 12 keys, lockscreen 7) and read different config
paths — so `NidaraPowerBar({ t, onLocaleChange? })` takes them as parameters. Two details worth
copying:

- **`onLocaleChange` is optional, and that optionality IS the whole divergence.** Every
  difference between the two old copies came from one fact: the greeter can change language
  while it is on screen (a dropdown calling `setlocale()` live) and the lockscreen cannot. Pass
  the hook where it exists; omit it and the labels are simply built once.
- **Name the keys, do not take `any`.** `PowerBarKey = "suspend" | "restart" | "shutdown"` is
  what makes a future catalog missing one a break at the call site instead of three buttons
  quietly labelled with their own key.
- **`readRegion` is injected for a PRIVILEGE reason, not a preference.** The lockscreen runs as
  the user and reads its own config dir; the greeter is a system user that owns no such file, so
  it tries the last user's home and then the world-readable `/var/tmp/nidara` mirror.

🔑 **How it was verified, because none of these surfaces has a dev loop.** Three separate
answers for three shapes of risk, and the middle one is the reusable trick:

1. `formatDatePart` is PURE → old and new bundled side by side and run over 5 dates × 7 formats
   × **10 locales** (including the year-first CJK path and day-first vs month-first): **350/350
   identical strings**.
2. The widgets → built from the OLD bundle and the NEW one and their **CSS node trees dumped and
   diffed** (`scripts/dev/` harness, kept out of the repo): identical, 3/3 nodes for the clock
   and 14/14 for the power bar, same geometry, classes and strings. ⚠️ **Run the two sides in
   SEPARATE PROCESSES**: each esbuild bundle embeds its own `glass-capsule.ts`, and GObject
   refuses to register the type name `NidaraGlassCapsule` twice.
3. The greeter's live re-string → `setLocale()` on the built widget, asserting all three labels
   change. ⚠️ **The first two attempts at this test measured NOTHING** and both looked like a
   pass/fail about the code: once because the process locale was already the target language, and
   once because the widget bundle and the i18n bundle were two module instances, so `setLocale`
   ran against a different copy of the state. **A shared-module test has to be ONE module
   graph** — one esbuild entry re-exporting both.

**The CARD followed immediately** (`ui/lib/auth-card.ts`) — see §61, which also fixes the
backlog defect that lived in both copies.


### 61. The card is shared, and the failure message finally expires (2026-08-10)

Step 2b of NTK, and the backlog's defect #1, in one change because they are the same
change: `ui/lib/auth-card.ts` now builds the avatar / name / password field / primary
button / failure message column for both login screens, and the feedback logic that
lives there is what was broken in both copies.

**The split is CHROME vs ATTEMPT, and it is where it is on purpose.** The greeter talks
to greetd and starts a session; the lockscreen talks to PAM and lifts a session lock.
Those are different protocols with different failure shapes, so the shared component owns
the chrome and the feedback and hands back `onSubmit` / `setLoading` / `showError`. A
parameter that switched between the two auth flows would be two functions in a trench
coat.

🔑 **The message never expired because nothing watched the keyboard.** No `changed`, no
`notify::text`, on either surface — the only thing that ever hid "Wrong password" was
starting another attempt, so you retyped with the screen still contradicting you. Now
TYPING clears it (the one that matters; GNOME's lock screen does the same) and an 8s timer
covers the other case, a failure left on a screen nobody is at.

⚠️ **THE TRAP IN THAT FIX, which was written and only caught by testing it.**
`notify::text` fires for PROGRAMMATIC writes too, and a failed attempt ends by emptying the
field — so `showError(); passwordEntry.set_text("")` cleared the message about a
millisecond after showing it, and the user got a flicker instead of a reason. The card owns
that distinction now: **`card.resetPassword()`, never `passwordEntry.set_text("")`.** The
guard lives in the component so no caller has to remember an ordering rule to keep its own
error on screen. `showError` also cancels the previous timer, or a second failure inherits
the first one's countdown.

🔑 **Every assertion was proved able to FAIL, by mutation.** Removing the `resetPassword`
guard breaks assertions 3 and 4; removing the timer breaks 5. That step is not ceremony —
the FIRST attempt at the timer mutation was a no-op, because esbuild renames `GLib` to
`GLib2` in the bundle and the `sed` never matched, so a green run "proved" a timer that was
never exercised. Same failure mode as §60's locale test. **If a test has not been seen to
fail, it has not been seen to work.**

**Structural check:** both cards' node trees were dumped before and after. Two intentional
differences, both benign and both verified rather than waved through:
- the error LABEL lost a redundant `visible: false` (its WRAPPER is what governs, and the
  lockscreen never had the extra);
- the lockscreen's button gains GTK's `.text-button`, because the shared card passes a
  `Gtk.Label` as `child` instead of setting `label:` — in the old code `css_classes:` in the
  same constructor clobbered it. Nothing in `ui/greeter/style.scss` selects `.text-button`
  (checked), and the button measures 280×40 either way.

**Left for the VM**, along with everything else on these two surfaces: whether the timer
and the shake read right at real size, and greetd/PAM actually driving the failure path.

### 62. Settings scales its TEXT with the accessibility slider but not its BOXES (2026-08-11)

The accessibility text scale is honest again — the fonts are stored in points, so GTK applies
the factor through the dpi and the slider is continuous (design-system.md, "the font SIZE is not
part of this"). What is NOT honest yet is the geometry it scales into. Chrome is safe by design
(`_reset.scss` pins `font-size` on bar/dock/island/app-grid, and CC/NC/Prism inherit it from the
bar's window), so this is about the surfaces that are SUPPOSED to reflow: **Settings, About and
the alert dialog**, which take the `$fse-*` em ramp.

There, the text grows and the box does not:

- `NidaraSplitView`'s sidebar is `width_request: sidebarWidth` (250 in Settings) — a fixed
  column. Its label overflowing that column was the sharpest failure and is fixed mechanically
  (`ellipsize: END`, see architecture.md — it was already overflowing in Russian at factor 1.0),
  but ellipsized nav text at a large scale is a workaround, not the design.
- ~~the auto-collapse breakpoint is derived from the content's natural width, so a large scale
  collapses the sidebar in a window that has plenty of room~~ — **settled by #63**: the
  breakpoint is a constant, and the text scale cannot move it.
- `_settings.scss` `min-width: 210px`, the 30×30 icon boxes, `min-height: 36/50px` in the kit:
  all px. Row min-heights are the benign case (a row grows past its minimum); a min-WIDTH is not.

**What this needs**, when it is picked up: the reflowing windows express their geometry in `em`
(or a token derived from the interface font) rather than px, so the box scales with what it
contains. That is the real fix and it belongs to the kit, not to Settings alone.

**Until then the slider's range is the honest limit, and it was set from looking** (2026-08-11,
live session, Accessibility / Appearance / Control center / Display / Top bar at factor 2.0):
nothing overflows any more once the sidebar label ellipsizes — the two remaining symptoms are the
nav truncating to `Notificatio…` and a row with TWO trailing controls (Top bar → Custom icon)
squeezing its subtitle into four lines. So the cap is **`TEXT_SCALE_MAX = 1.5`** in
`core/ThemeManager.ts` (one constant, also used by `applyAll` to clamp a factor stored by the
older build whose slider went to 2.0 — a value above the max is a state the UI cannot represent).
Raise it when the geometry scales too, and look again before you do.

### 63. Settings geometry: the law exists now; the pages have not been walked (2026-08-11)

The window's geometry is a single rule — `WINDOW_LAYOUT` in `ui/lib/tokens.ts`, spelled out in
design-system.md ("The Settings window has ONE geometry law"). The content pane is a constant
800 px, the sidebar's breakpoint is `sidebar + content` instead of the active page's natural
width, the window has a floor, and `NidaraRow`'s title is one ellipsised line. Verified with
`scripts/dev/settings-geometry.mjs`: every page rendered the pane at exactly the width the law
predicts, at every window width tested, with nothing cut.

⚠️ The floor is the DISTRESS width (560), not the pane, and that cost two tries — both worth
knowing before touching it again. `set_size_request` reaches Hyprland as
`xdg_toplevel.set_min_size` and **Hyprland tiles at the layout's size regardless**: with the floor
at the pane's 802 and Settings in a 673px tile, GTK laid out at 802 and the compositor cut the last
129px, taking a row's trailing button. And the floor cannot be made conditional on being tiled —
**Hyprland never clears the `tiled` toplevel state**, so a window it had just floated and resized to
600×800 still carried `tiled-top/left/right/bottom` and `maximized`.

⚠️ **This overlaps #62 and settles one of its bullets.** That entry lists "the auto-collapse
breakpoint is derived from `sidebarWidth + content.naturalWidth + collapseMargin`, so a large
text scale collapses the sidebar in a window that has plenty of room" as a symptom of Settings
scaling text but not boxes. That mechanism is gone — the breakpoint is a constant now, so the
text scale cannot move it. The REST of #62 stands untouched: the pane is 800 px whatever the
text scale, so a large factor still means more text in the same box, and `TEXT_SCALE_MAX = 1.5`
is still the honest limit. (That bullet is struck through in #62 above, done while rebasing this
branch onto the merged font work.)

**What is deliberately NOT done** — this was scoped as the geometry law plus the row contract,
not the page-by-page pass:

- ~~**~20 rows are hand-rolled**, a bare `Gtk.ListBoxRow` wearing `.nidara-row` for the chrome
  rather than built by `NidaraRow`.~~ ✅ DONE 2026-08-11 — see #65 for what the pass found and
  which rows deliberately stayed hand-rolled.
- **The page-by-page pass itself**: hierarchy, grouping, what belongs on which page. The
  instrument reports geometry, not editorial judgement — see #64.
- **Fixed-width widgets inside pages** (Appearance/Gaming's 320 px preview, Network's 260 px
  popover, the Users avatar) fit the 800 px pane comfortably and were left alone. They are the
  reason the OLD breakpoint differed per page, so they are worth remembering, not changing.

### 64. ⬒ HALF DONE — the locale sweep exists and gates CI; the live half does not (2026-08-11)

`scripts/dev/settings-geometry.mjs` asserts that every page renders the same pane width and that
the window's floor holds. What it does not do is the part that keeps reopening this surface: run
the same sweep across **locales** (`ru` was already overflowing the sidebar at factor 1.0 before
the label ellipsised — see #62) and across **text scales**, and report what overflows or wraps
past a sensible budget rather than what merely differs.

That is the missing half of "discovering", and it is why Settings keeps coming back with a new
symptom: a human opening the window in one locale at one size cannot see it. The extension is
small — the sweep already walks all 18 pages and reads `bounds`; it needs a locale switch per
run and a per-node overflow check (child wider than the box it sits in) instead of the current
row-height count.

**✅ The deterministic half shipped 2026-08-11: `scripts/dev/text-budget.js`.** It measures every
sidebar string in all 12 locales at scales 1.0→1.5 with real GTK labels, the real compiled sheet and
the shipped font pinned, and runs inside the headless smoke job — so this is a **CI gate**, not a
thing someone remembers. Full write-up in `dev-workflow.md`. What it caught on its first run:

- **Russian shipped TRUNCATED.** "Специальные возможности" needed 200px of a 170px budget at the
  DEFAULT text size — the escape this whole line of work started from, confirmed and now fixed
  (abbreviated to "Спец. возможности" in `ru.ts`, 143px, keeping the term users know from
  GNOME/Windows/Android rather than swapping in a shorter synonym).
- **The documented budget was wrong by 6px** — 176 claimed, 170 real. See #66.
- **The column is tight for accessibility scaling generally**: at 1.25 four locales truncate
  (ja, ru, de, pl) and at 1.5 all twelve do, English included. That is #62's "text scales, boxes
  do not" with a number on it, and it is reported rather than failed on purpose.

**What is still missing — the LIVE half.** Row titles inside the 800px pane are not covered. They
ellipsise rather than push, so they lose information silently instead of breaking the layout, and
their budget is not a constant: it is the row's 688px content minus the leading icon minus the
trailing control, and that control is often a button whose own label is localised, so the budget
moves with the locale under test. Covering it honestly needs allocated widths harvested from a live
session per locale — which, because the locale is read from `$LANG` at startup, means a shell
restart per locale. That is the part worth designing before building.

### 65. ✅ CLOSED — the hand-rolled rows are the component now (2026-08-11)

Twelve rows across Settings wore `.nidara-row` for the chrome while building their own box, so
they got the LOOK of a row and none of its contract. They are `NidaraRow` / the new
`NidaraEmptyRow` now. What the pass turned up, measured with `nidara-ipc queryUI .nidara-row`
on the live session before the change:

- **Settings → Sound: all six rows carried NO height class**, so their height was whatever
  `12 + content + 12` summed to (92 px).
- **Settings → Power: the three profile rows measured 44 px** — four pixels UNDER the 48 px
  `--single` token — sitting in a page whose other rows measured 72. That is exactly the "lists
  breathe differently from page to page" the height tokens were introduced to end, still present
  in a shipped page a week after the tokens landed.
- **Four titles had no `ellipsize`** (Apps → App icons' app name, Users' `displayName`, Power's
  profile label, the search result's label). `displayName` is free text the user types into the
  field one group above, so it is a row title with no upper bound at all.
- **The search result's subtitle used `max_width_chars: 50`** — the same character stub that had
  been removed from Sound three commits earlier for cutting strings the row had room for.
- **Three subtitles sat at `halign: START`**, which allocates a wrapping label its NATURAL width
  — the line-balancing heuristic that made descriptions break at 310–589 px at no consistent edge
  (the measurement in `row.ts`).

🔑 **And the find that was not a row at all: `.settings-placeholder` had been a dead class since
March.** `0307adf2` (2026-03-25) renamed it to `.settings-page-subtitle` **in the stylesheet
only**, leaving six TSX call sites asking for a class that no longer existed; the renamed rule was
then deleted along with `pageHeader()`. So every page-level empty state — Bluetooth's no-adapter
banner, Sound's no-hardware banner, Display's no-monitors, search's no-results — rendered as a
plain default label at full body size and undimmed, beside empty-list rows built with
`nidara-row-subtitle` that rendered small and dim. **Nothing errored and nothing logged: a CSS
class GTK cannot resolve is a silent no-op**, which is why a rename that touches only the
stylesheet is invisible until someone greps for the class. The rule is restored (scoped, in
`_settings.scss`) and the row-level cases moved to `NidaraEmptyRow`.

`NidaraEmptyRow(text)` is new in the kit. Five places built "this list is empty" by hand and had
already drifted three ways: dimmed-and-indented (Network, Users) vs centered-and-full-size
(Autostart, Bluetooth), with and without a height class. It is also **not selectable and not
activatable** — every hand-rolled copy was a plain row and took the hover state, so a message
claimed to be a control.

**Deliberately still hand-rolled** — each is a different widget wearing row chrome, not a row:

- `wallpaper-preview-row` (Appearance, Gaming) and the two `users-avatar-row`s: a `Gtk.Picture`
  as the row's DIRECT child, because wrapping it in a box makes its height-for-width natural
  explode (the reason is in Users.tsx and predates this pass).
- `settings-adv-revealer-row` (Appearance): a `Gtk.Revealer` holding more rows.
- Users' "Add user" row: a real `Gtk.Button` (`.settings-action-row`) filling a row, so the click
  works regardless of the list's `SelectionMode`.
- Autostart's custom-command row: an entry plus its Add button and **no title at all**. A row
  with no title is not a `NidaraRow`; if this shape recurs, it wants its own kit primitive.
- The dense bar/CC panel rows (`widgets/volume.ts`, `bluetooth.ts`, `vpn.ts`) — already documented
  in `row.ts` as opting out with their own tighter 10/14 padding.

⚠️ Rows built from live hardware or accounts use `NidaraRow` **directly, never `createRow`**:
`createRow` also registers the row in the Settings SEARCH INDEX, and a headset, an installed app
or a user account is not a setting. The index is built at page-construction time anyway, so a
device row would enter it only sometimes.

### 66. The sidebar's rows never opted out of the theme's padding (2026-08-11)

`.nidara-row` carries `padding: 0` for a documented reason: `nidara-reset` clears background, border,
shadow and outline but NOT padding, and Adwaita gives every `list > row` 2px of it. The **sidebar's**
rows are bare `Gtk.ListBoxRow`s (`ui/lib/nidara-kit/sidebar.ts`) with no such class, so they still
pay it — 4px across, on the one column in the product that is a hard fixed width and already one
string over budget.

Measured with `--verify` (that is how it was found): capsule 240 → list 228 → item 200 → label 170,
against a derivation that predicted 176. The other 2px of the gap is the capsule's `material-card`
border, which is legitimate.

Reclaiming the 4px is a one-line rule and would give every locale that much more headroom, but it
was NOT bundled with the instrument that found it: it shifts the sidebar's layout, and the honest
order is to land the measurement first and the change against it second. Whoever takes it should run
`text-budget.js --verify` before and after — the budget is derived in that script and must move with
the fix, or the gate starts checking a number that no longer exists.

### 67. ✅ FIXED — the input yield was eating the focus its own caller had just set (2026-08-13)

Computer-use refused legitimate clicks from inside the Assistant. The model did everything right —
`focusWindow org.gnome.TextEditor`, confirmed by the compositor, by title — and 3.2 s later
`click_app` came back *"refused: … is not the focused window (active: kitty)"*. The terminal had
never been touched: the **pointer** was resting over it.

🔑 **We took the focus away ourselves, in `yieldInput begin`.** Hyprland 0.56.1
`CSeatManager::setGrab(nullptr)` branches on `input:follow_mouse` — `0 || 2 || 3` →
`refocusLastWindow`, **else (1) → `refocus()`**, i.e. the window under the cursor. `hyprland.lua`
shipped `follow_mouse = 1` at the time, so this was every install, not a local setting. (It ships
**`2`** since 2026-08-15 → the `refocusLastWindow` branch, which happens to hand the focus back on its
own; the fix below stays regardless, because a user override puts `1` back in one line.) Fixed in
`core/InputYield._restoreFocus`: read `focusedClient` before the notify, re-focus it in the
`afterGrabRelease` callback (the `activewindow` event it waits for IS the wrong focus arriving), and
await the dispatch before answering so the helper's own `hyprctl` cannot race it. Full write-up in
`state-and-ipc.md`.

⚠️ **The knowledge was already in this repo and stayed unconnected for a week.** `architecture.md`
has described "dropping a grab refocuses by POINTER" since 2026-08-05, and
`HyprlandState.restoreFocusAfterGrab` was written for the null-focus half of the very same sentence.
What was missing was noticing that the dismissal's policy ("the compositor found someone — leave it")
is exactly wrong for a caller that had already chosen the window. Cheap to have seen; nobody looked,
because the symptom was in a helper and the cause was in a compositor call two modules away.

Two things went with it:

- **A CRITICAL that could only fire when nothing was wrong.** `syncIslandGrab` in `Bar.tsx` logged
  *"island modality: NO compositor focus grab"* whenever `setModal` returned false with a mode open —
  but `setModal` itself applies `!inputYield.active`, so during the truce a DELIBERATE release read as
  a broken desktop. Five CRITICALs in one log, under two PIDs, next to a real bug they made look like
  one symptom. `syncKeyboardMode` had carried the yield term all along; the island's check had not.
- **The loop guard in `bin/nidara-agent` blamed the user** — *"try rewording what you asked for"* —
  for a desktop refusal. It now names the failing call and quotes what refused it, and prescribes
  nothing. A guard is well placed to report the reason it saw twice and badly placed to guess whose
  fault it is.

⛔ **Rejected: moving the pointer to the target before the focus check** (the obvious helper-side
fix). It does nothing for `nidara-type`, which never moves the pointer; it makes the agent-pointer
choreography's job visible in the wrong order; and it treats our defect as their ordering problem.

**Still open, and possibly next door:** the intermittent report that the island's inactive-mode icons
stop taking pointer input while only the closed active island responds. `updateInputRegion` +
`islandWin.updateInputRegion` hang off the same `notify::active` handler this entry is about, so a
region left stamped after a yield is the standing suspicion — unverified, and it needs a repro before
any code. Related: #40, #38.

### 68. The island losing pointer input — the WHOLE-region half is FIXED; the chip-level half is still open (2026-08-13)

Two failures wearing one symptom. The trap armed for the second one caught the FIRST.

#### ✅ Fixed: the island goes fully dead on resume from suspend

Reported by the owner 2026-08-13: *"coming back from sleep the activity island was left with no input
until I reloaded the UI"*. The trap had it on the first occurrence:

```
05:16:56  stamp #421 rects=3 hitTargets=6      ← last before suspend (05:33)
09:20:15  stamp #422 rects=0 hitTargets=6      ← 8s after resume: an EMPTY region
[09:53:24] nidara-ui: DEV mode                  ← the owner's reload, 33 minutes later
```

🔑 **Six live targets, zero measurable, and an empty region stamped over a good one.** `boundsOf`
returns null for a widget that is not mapped or has no allocation, so the union came out empty and
`set_input_region` was handed nothing — which is not "click-through pending a correction", it is the
terminal state. **The capsule is permanent furniture that had no re-stamp trigger of its own:** the
revealers have `onAllocated`, the morph has `onDone`, and neither runs when no mode is open. Nothing
was ever going to correct it.

⚠️ **Why only this surface can die this way.** `Bar.tsx` unions an unconditional
`{0,0,monGeo.width,BAR_H}` strip — a constant that cannot fail to measure, so the bar always stamps
*something*. The island's capsule is CENTRED and changes width, so it has no such constant; it is
measured, and measurement has an unmeasurable state. Same file, same job, opposite failure mode.

**The numbers that sized the fix** (2435 stamps of the owner's log): only 7 stamps ever had
`rects=0`, and **6 of them are `stamp #1`** — the first of a session, before any layout, each
corrected milliseconds later. The 7th is #422. So the condition is real but never benign
mid-session, which is exactly what `everStamped` keys on.

**The fix** (`IslandWindow.ts`): `paintedBounds` now reports `targetsLive`/`targetsMeasured`, and
`updateInputRegion` **holds the region already on the surface** instead of blanking it when targets
are live but none measurable — plus a backing-off re-stamp ladder (`holdRegion`) and a
`row.connect("map")` hook, the trigger the permanent furniture never had.

🔑 **Holding is only correct because there is something to hold.** Before the first successful stamp
there is no region, and a Wayland surface with none takes input across its whole buffer — this one is
monitor-sized, so it would swallow every click on screen. That is why `everStamped` gates the guard
and why those six `stamp #1`s must keep stamping empty.

#### 🟡 The chips alone losing input — REPRODUCED AND MEASURED on a live session (2026-08-13), one cause fixed, root cause not yet proven

The original 2026-08-12 report — *"sometimes the inactive island's icons stop taking mouse input, only
the closed active island responds"* — describes the chips going dead while the capsule still works.
The resume bug kills the capsule too, so it is **not** established that they are the same thing.

🔑 **It was finally caught IN THE ACT** (user reported it live, 2026-08-13 15:24). What made that
possible was measuring the SYMPTOM instead of the suspected mechanism — see the probe below. On the
user's dead island:

- both chips: **0 pixels changed** on hover, at every pointer position — no input at all;
- the capsule: **19 pixels changed** on hover, and its response spanned exactly `[1091, 1385]`, i.e.
  **its stamped rect matched its painted rect perfectly** while the chips beside it were unreachable;
- the island had been at rest for ~3 minutes with **no stamp** since `#355 rects=3 hitTargets=6`;
- forcing a re-stamp revived them (**30.7 px** response) — which also proved the probe can fire, so
  the zeros before it were real and not a dead detector.

▶️ **The probe (reusable, and the thing to reach for next time).** Hover a chip with the RAW injector
and diff its pixels: `nidara-input move <x> <y> 2560 1440`, screenshot, `magick compare -metric AE`
on a crop of that chip. Alive = the chip repaints its hover border; dead = pixel-identical.
⚠️ **`nidara-click` cannot be used for this**: it yields the island's input region click-through
before acting, so it would test nothing. ⚠️ **And gate the probe on a SETTLED island**:
`islandBounds` unions the REVEALER rects, so a closing panel still reads as "the island" — a 474px
player panel sailed through a `<600` gate and got hovered at its edge, producing two false DEADs
before the gate was tightened to "geometry unchanged across 0.7 s AND no stamp in flight".

✅ **Fixed: the PARTIAL-measurement hole** (`IslandWindow.updateInputRegion`). `holdRegion` from the
whole-region half only engages when NOTHING measures — `targetsMeasured === 0`. The moment ONE target
survives, the region goes out **missing the others, with no retry and no trigger that would ever
re-cut it**. That is not theoretical: instrumented on this session, **116 stamps in ten minutes went
out dropping a chip the island was showing, two of them dropping the CAPSULE itself**, every one with
`measured > 0` so the guard stayed quiet. Now a stamp with any `missing` target keeps its stamp (the
best region describable that instant) and climbs the same retry ladder.

✅ **Fixed: the chips had no re-stamp trigger of their own.** The capsule re-stamps from its glass
`resize`, a mode from its revealer's `onAllocated` — the chips had only a fixed **400 ms** guess
(`Bar.tsx` → `onBackgroundChanged`), which has to be wrong only once, since nothing else re-cuts the
region for them. `ActivityIsland.onChipsSettled` now fires on each chip revealer's
`notify::child-revealed` — the frame the slide actually ends and the row's final rects exist. Both are
kept: the timer covers a reveal that never animates, the signal one that outlasts it.

✅ **Fixed: the row re-entering the hit set had no trigger either.** The `STALE` check fired
**organically for the first time** at 2026-08-13 04:38 — *"stamped 1 target(s), 6 are live now and
nothing re-stamped"* — which is a DIFFERENT path from the one above: `hitTargets()` returns the
capsule alone while the row is faded out, so every stamp taken with a mode open drops the chips' rects
**deliberately**, and the symptom appears the moment nothing re-stamps once they ramp back. That
re-stamp comes from `MorphRevealer.reveal`'s `onDone`, which does not run when the morph is
INTERRUPTED (a mode switched mid-close). `Bar.tsx` now also re-stamps when `indicatorRow.opacity`
crosses back off zero: opacity does not affect `compute_bounds`, so that crossing is already a
measurable layout, and it costs one stamp per morph. Note this path is invisible to both guards above
— the chips are not `missing`, they are legitimately *excluded*, so neither the retry ladder nor
`onChipsSettled` would ever have covered it.

⚠️ **None of the three was the cause**, and the trap said so within minutes of them landing — worth
keeping as the record of what "the fix is in, the bug is not fixed" looks like when the instrument is
good enough to tell you.

✅ **THE CAUSE: the stamp reads a TORN layout, and measuring more carefully cannot help.** Caught
2026-08-13 16:55, minutes after the triggers above were merged:

```
#61  capsule=1091 297x32   agent=1396  dots=1436     healthy
#62  capsule=1174 132x32   agent=1479  dots=1519     impossible
     MOVED, 600 ms later:  agent is at 1314, dots at 1354
#63  7.6 SECONDS later, still wrong          #64  correct again
```

🔑 **#62 is geometrically impossible and that is the whole proof.** A 132-wide capsule at 1174 IS a
212-wide group centred on 1280, so the chips belonged at 1314/1354 — the stamp recorded 1479/1519, a
**173 px gap** between the capsule and a chip the layout puts **8 px** apart. One pass of
`paintedBounds` read the capsule with its NEW allocation and the chips with their OLD one, because the
`glassArea "resize"` hook fires from **inside `size-allocate`**, before the row's siblings have been
re-allocated. Then nothing re-stamped for 7.6 s, and for 7.6 s the chips took no input.

None of the three triggers can see this: nothing is `missing` (everything measured), `child-revealed`
does not fire (the chips are not revealing, they MOVED), and the opacity crossing already happened.
**The measurement was wrong, not incomplete** — which is why every guard aimed at absence missed it.

**Fix**: after every stamp, re-measure once the tree is still and re-stamp if the geometry moved
(`scheduleVerify` in `IslandWindow.ts`). **DEBOUNCED, not merely coalesced**: during an animation
stamps arrive every ~7 ms, and verifying per stamp would double the work on a path the blur region
also pays for. Pushing the timer forward on each stamp buys **one** extra measurement per animation
instead of ~20, taken where it matters — after the last frame, on the state that will persist. The
yield path records an empty `stampedRects` and cancels the pending verify, so a yielded (deliberately
click-through) surface is never read as torn and stamped back over the agent's own clicks.

**Verified**: `TORN` fires (13 times over 32 cycles, i.e. the condition is real and frequent), and
after it **0 `MOVED` and 0 `STALE` survive** where `MOVED` had been reporting the stale region before.
32 cycles, 0 deaths, against a pre-fix reproduction that hit within 2 cycles. Cost measured in stamps
per cycle: overview ~13 before and after, agent ~93–106 before and after.

⚠️ 32 clean cycles is evidence, not proof — the pre-fix rate varied between 1-in-2 and 1-in-25. If it
returns, the trap now has a fourth column to check (`TORN` firing but the geometry still wrong would
mean the verify's own 50 ms window is too short).

🔑 **The mechanism it would have to be.** `ActivityIsland.hitTargets()` returns the capsule ALONE
while `indicatorRow.opacity === 0` — deliberately: leaving faded chips' rects stamped puts an
invisible dead patch in the bar, which under a grab is read as a press INSIDE and neither dismisses
nor passes through. So any stamp taken while a mode is open drops the chips, correctly, and becomes
the reported symptom **only if nothing re-stamps once they ramp back**. And nothing has to: the morph
ramps opacity in `applyProgress` without a relayout, so `onAllocated` never fires on the way out. The
one thing that re-stamps is `MorphRevealer.reveal`'s `onDone` (wired in `syncIslandModes`).

⚠️ **The blur region survives this same premise only because of `BLUR_PAD_X = 200`.** Its own comment
says so — *"a re-stamp mid-morph measures a union without them, and on the way back OUT they ramp up
again with no relayout to re-measure. They land inside the pad"*. **The input region has no pad.**
Same premise, no net. If this turns out to be the bug, that asymmetry is where to look first.

**Ruled out by measurement (2026-08-13), ~460 stamps, 99 of them capsule-only:** clean open/close of
all four modes; mode switches at 100 ms (mid-morph); close-then-reopen inside the closing morph;
computer-use yield with a mode open AND with the island closed; a chip changing while a mode is open
(the `onBackgroundChanged` 400 ms deferred stamp). **0 stale regions.** In every one of those the
`onDone` re-stamp arrives. So the failure is not in the deterministic paths, which is consistent with
"sometimes" and is why guessing at code next would be wrong.

▶️ **What is armed:** `NIDARA_ISLAND_REGION_TRACE=1` (`IslandWindow.traceStamp`) logs every stamp
**with the actual rect it put in the region, per named target** (`capsule=1091,8 297x32 agent=1396,8
32x32 …`; a trailing `-` on the name means the chip is deliberately collapsed, so its `NULL` is the
healthy resting state), plus `measured=` and `MISSING=`. It fires a CRITICAL on `STALE` (target count
later exceeded), on **`MOVED`** (the targets are at different coordinates 600 ms later with no stamp
in between — the region is at the old numbers), and logs `HELD` / **`PARTIAL`** whenever the guards
above decline to blank or complete the region.

🔑 **Why the counts alone could never have caught this, and the shape of the mistake.**
`hitTargets()` returns all five chips always, and three of them are legitimately collapsed at any
moment — so `hitTargets=6 measured=3` is BOTH the healthy resting state and the broken one. "Live but
unmeasurable" and "deliberately absent" are the same number. That is why every count-based check read
healthy while the chips took no input, and it is why the chips now carry `islandTargetId` /
`islandRevealed` tags: the trap needs the island's INTENT for each target, which no count can supply.
This is the third time in this bug that the detector was watching the wrong column (see the lesson
below, and the STALE check that missed #422). Off by default, no cost when off
(the trace call is guarded, not just the body). **Proven to fire** by disabling the `onDone` re-stamp
for one run; a silent trap nobody has seen trip proves nothing. Arm it with
`systemctl --user set-environment NIDARA_ISLAND_REGION_TRACE=1 && systemctl --user restart nidara.service`.

🔑 **The lesson from how it paid off: it was aimed at the wrong column.** The STALE check compares
`hitTargets()` counts, and on #422 that number was 6 on both sides — the trap never fired. What
caught the bug was the raw `rects=` it happened to log next to it. A detector narrowed to the
mechanism you suspect will miss the one you don't; log the neighbouring quantity too.

⚠️ **And the mirror lesson, from MOVED's first evening: 17 alarms, 17 of them false.** Its first
version compared the whole trace STRING across 600 ms. Opening a mode fades `indicatorRow` to nothing
and `hitTargets()` then correctly returns the capsule ALONE — so the strings differ for a reason that
is not a stale region at all. It now compares each target against ITSELF by id (`byId`), over the
targets present in both samples: **a target that left the set is not a target that moved.** A trap
that cries wolf is worse than no trap, because the real line arrives in a column of noise nobody
reads any more.

⚠️ **Reading the HELD/FORCE volume in this log correctly.** 661 `HELD` lines look alarming and are
not organic: they are all inside 10:07–10:16 on 2026-08-13, the window where a throwaway `FORCE`
harness (since removed — do not look for it in the source) deliberately held the island unmeasurable
for 120 s / 180 s to prove the #136 guard fires. Sessions since: **0**. Check the timestamps before
treating a count in this log as a rate.

⛔ **Do not "fix" the chip-level half on the strength of the reasoning above.** The next step is a log
line, not a patch: the mechanism explains the symptom but so did the `syncIslandGrab` CRITICAL, which
turned out to be a false alarm (#67).

### 69. ✅ FIXED — every `*-app` verb of `nidara-click` was dead on arrival (2026-08-13)

`nidara-click`'s node-targeting modes passed an **undefined variable** as the app filter —
`resolveNode(a, app, …)` at three call sites — so `app` / `rclick-app` / `hover-app` /
`scroll-app` / `drag-app` all threw `ReferenceError: a is not defined` before touching AT-SPI.
That is the whole pointer half of computer-use aimed BY NAME: MCP's `click_app`, `hover_app`,
`scroll_app`, `drag_app`, and the same tools inside the Assistant. Fixed to
`app.toLowerCase()` (the filter `findNodeCentres` expects — it compares against
already-lowercased AT-SPI application names; `app` stays as the original for error messages,
the same split `nidara-act`'s `findMatches` uses).

⚠️ **How it stayed hidden, and the debt that remains.** The `*-at` (coordinate) half shares the
whole pipeline — yield, focus check, injector, cursor choreography, JSON envelope — and works
perfectly, so every smoke of "does nidara-click work" passed. **Nothing exercises the `*-app`
half**: the CI smoke boots the shell and drives IPC, and these CLIs are not in it. Three
failures sat in the user's log for weeks as
`[nidara-agent] tool click_app … → FAIL nidara-click produced no output`, i.e. the agent
reported the failure faithfully and nobody read the log.

▶️ The cheap coverage that would have caught it: run each verb once against a node name that
does NOT exist and assert the output is the structured `no showing node named …` envelope
rather than empty output. It needs no real click, no focused app for the resolve step, and it
fails loudly on any ReferenceError — the entire class of "this code path was never executed".

### 70. ✅ FIXED — the bar and the island never heard the monitor change shape (2026-08-15)

Switching to 1080p live cut the Activity Island off, cut the bar's capsules, and opened the
AppTitle panel somewhere else (user-caught 2026-08-10). A clean 2×2, not a hypothesis: the dock
rebuilds on `notify::geometry` and the app grid refreshed on it — those two were fine; the bar and
the island each captured `const monGeo = gdkmonitor.get_geometry()` at build time and subscribed to
nothing. The surfaces resize for free (four anchors); what went stale are the numbers they cut with.

🔑 **The interesting part is WHY two of four forgot: subscribing was optional.** `get_geometry()` is
available to anyone holding the monitor, so caching it is the path of least resistance and nothing
ever says otherwise — the warning was even written out twice already (`app.ts:892` for the dock,
`AppGridWindow.ts:73` for the grid) and generalised neither time. Fixed with `createRegionStamper`
in `common/VisibleRegion.ts`: the stamper owns the geometry and CALLS the surface's producer with
the box to fit its rects in, so a surface that cannot reach the geometry cannot cache it. Full
contract in `architecture.md` → "Who owns the monitor's geometry".

⚠️ **Three numbers were not covered by a live `geo()`** and each needed its own answer — the bar's
solved-then-stored budgets (notification height, icon overflow count, app-title char cap), the
overview's card width baked into every card, and the island's INPUT region (the capsule is CENTRED,
so a width change MOVES it without resizing it — the one case its `resize` hook cannot see).

▶️ **What is left, deliberately.** `AppGrid.tsx:234` still solves its panel width from the monitor
at build time (`max(920, min(w*0.50, 950))`). It is a no-op for any monitor wider than ~1840 (both
ends clamp to 950), so it only misses on a change that crosses that line — e.g. 2560 → 1366, where
the panel stays 30px wider than intended and still fits. Fixing it means the same `onMonitorResized`
treatment; it was left out to keep this change to the surfaces that actually broke.

⚠️ **CI cannot catch this class at all.** The headless smoke boots at one resolution and never
changes it, exactly like the wallpaper-restore path. The bed is a VM (or a live mode switch), and
the A/B is worth re-running whenever a surface starts deriving a new number from the monitor.

### 71. ✅ CLOSED — AstalNetwork picked its devices ONCE, so the shell dropped it (2026-08-16 → 2026-08-17)

Found while auditing Settings → Network. `AstalNetwork.Network` resolved its `Wifi`/`Wired` wrappers
in `construct` — one `client.get_devices()` scan — and never re-scanned: it connected to
`primary-connection`, `activating-connection`, `state` and `connectivity`, but **not** to NM's
`device-added` / `device-removed`. So a USB dongle plugged in after login stayed invisible for the
rest of the session, in Settings AND in the bar AND in the Control Center, and no consumer could
repair it from outside (`internal Wifi(NM.DeviceWifi)` — GJS cannot build the missing wrapper;
`notify::wifi` / `notify::wired` exist in the API but nothing ever assigns them, so they cannot fire).
This closes **#22** as well — same bug, found twice.

**The fix was to stop wrapping the wrapper.** `core/NetworkService.ts` reads `libnm` (`gi://NM`)
directly now — the same C library Astal's Vala was wrapping, already installed as its own transitive
dependency, and already typed (`@girs/nm-1.0.d.ts`, present in the CI snapshot too). What made that
cheap rather than a rewrite:

- the **write half was never Astal's**: `connectAp`/`rescan`/`setWifiEnabled`/`forgetProfile`/VPN were
  always `nmcli`, so only the READ half moved;
- of the read half we used maybe a third — grep found **zero** uses of Astal's `is_hotspot`,
  `scanning`, `scan()`, `state_changed`, `primary`, `connectivity` or `icon_name` (icons are ours);
- `AstalNetwork.AccessPoint` was **pure pass-through** (`get { return ap.X; }`), so `bssid`,
  `strength`, `frequency`, `max_bitrate`, `flags`, `wpa_flags`, `rsn_flags` are read straight off
  `NM.AccessPoint` and the call sites did not change. The ONE thing NM gives rawer is `ssid`, which is
  `GLib.Bytes` (an SSID is arbitrary bytes) → `Net.apSsid()`.

⚠️ **Two things about the new module that are not obvious.**

1. **Presence is a subscription, not a fact.** `watchDevices()` re-resolves on every NM
   device-added/device-removed and notifies **only when the SELECTION changed**. That guard is
   correctness, not optimisation: NM emits device-added for every tun/bridge/veth, so a VPN going up
   or Docker starting would otherwise re-arm every network subscription in the shell. Every other
   watcher (`watchWifi`, `watchWifiEnabled`, `watchWifiNetwork`, `watchAccessPoints`, `watchWired`)
   is built on `rebindable()`, so it tears down and re-arms itself across a hot-plug — a caller
   subscribes once and stays correct.
2. **The watchers are deliberately granular**, which the old blunt `notify` could not be. The bar
   icon takes `watchWifiEnabled` (radio flag only — a wider one re-blurred the whole bar every frame
   during a scan), a CC capsule takes `watchWifiNetwork` (flag + SSID, no bitrate churn), an info
   panel showing an IP takes the full `watchWifi`.

Settings → Network is now built WHOLE with its sections switched live (the Bluetooth banner shape),
armed through `bindWhileRealized` — which also fixed a leak and a freeze the old page had: its
handlers were connected at build and never disconnected, so after the user left the page once it
never re-armed. **Do not put a device behind an `if` in that page again.**

Verified on a host with no wireless hardware at all, `mac80211_hwsim` as the dongle (2026-08-17):
A→B→A with the window open and no shell reload — placeholder → live Wi-Fi group on `wlan0` →
placeholder back; then `fake-wifi.sh` for a real WPA2 AP → the AP row rendered with its lock, `100%
• 2437 MHz`, and a real connect filled SSID / IP `10.42.0.19` / `54 Mbps` in place and flipped the row
to Disconnect. Log clean throughout. The bar icon tracked every step, which was the point: this was
never a Settings bug.

Left deliberately: `isAvailable` / `watchAvailable` on `AtomicWidget` are declared in
`surfaces/control-center/Types.ts` and **consumed by nothing** — the wifi/ethernet widgets have always
declared them (against `notify::wifi`, a signal that could not fire). They now point at
`Net.watchDevices`, so wiring the registry to them would work; that is a separate change.

Upstream note: **Aylur/astal#449** ("fix(network): network device hot-plugging", ScarsTRF, opened
2026-06-03) fixes the same bug in Vala and has sat without a human review since. It is a thorough
patch — it also adds the `disconnect_signals()` the wrappers never had — but it flips `wifi`/`wired`
from nullable to permanent wrappers plus an `is_active`, i.e. an API break we would have had to
absorb at the same five call sites. We did not need it in the end; if it lands, nothing here depends
on it.

### 72. ✅ FIXED — a cursor theme/size never reached the cursor already on screen (2026-08-17)

Reported as *"cursor style and size only change when I leave the window"*. One bug, not two — the
earlier write-up here split it into size (working) and theme (out of reach) and **both halves were
wrong**, each from a contaminated instrument. Fixed in `ui/shell/common/CursorRefresh.ts` (67 lines
of code across four files).

🔑 **The law, which is the only thing worth remembering.** Hyprland redraws the pointer **only when
it sees a different shape NAME**: `IHyprRenderer::setCursorFromName` opens with
`if (name == m_lastCursorData.name && !force) return;`, and `changeTheme()` reloads the theme and
schedules frames without ever re-issuing the shape. Read in 0.56.2 and byte-identical on `main`, so
no version bump fixes it. Measured, pointer parked and never moved:

| action | cursor px on screen |
|---|---|
| Adwaita on screen | 112 |
| `hyprctl setcursor Qogir-Dark` | 112 ← the bug |
| toggle `cursor:invisible` off and on | 112 ← does **not** repaint |
| a crossing that changes the NAME | 147 ← the only thing that does |

**The fix**: name a different shape and name the old one straight back, in one main-loop iteration —
the compositor applies both in one pass, nothing is composited between them, no flicker. A name is
exactly what `wp_cursor_shape_v1` carries, so this is the protocol's own vocabulary, not a trick.

**The hard half.** Only the client holding pointer focus may name a shape
(`InputManager.cpp:68-72`), and the cursor THEME is only reachable through a `Gtk.DropDown` — whose
popover is a real Wayland surface that is DESTROYED when you pick an item. Hyprland then hands focus
to nobody (it re-runs that pass on pointer motion only, and the pointer has not moved), so for a
while **no client on the desktop can repaint the pointer**. Verified on the wire across three
scripted selections: no `enter` ever arrives while the mouse is still. Closed by
`HyprlandState.reevaluatePointerFocus()` — `hl.dsp.cursor.move` to the position the pointer is
already at, which is `warpTo(pos, true)` + `simulateMouseMovement()` and therefore a pure focus
re-evaluation: the pointer does not move, no libinput event is generated, keyboard focus is untouched.

⛔ **Do not re-propose these**, all closed by measurement, not by taste:
- **`cursor:invisible` hide/show.** Hides fine, but restores the OLD picture — it does not repaint.
- **Settling timers** after the popover closes. There is no `enter` to wait for.
- **Waiting for the user to move the mouse.** Works, but one pixel is not enough on its own (GTK
  re-names `default`, which the dedupe drops), and the `Gtk.EventControllerMotion` used to make it
  one-shot had to be removed from inside its own handler — which **segfaulted the shell**.
- **Dropping the native dropdown for an in-window list.** `NidaraSelect` was deleted 2026-08-03
  (61c3e75c) precisely because a real popover gets compositor blur. That trade is what creates the
  focus gap; the user re-affirmed the blur is worth keeping.
- **Patching Hyprland.** It is genuinely the compositor's bug (a surface holding pointer focus is
  destroyed and focus is not reassigned), but out of scope for this project.

📌 `hyprctl setcursor` is documented as hyprcursor-only since 0.37.0 and every theme on a normal Arch
install is XCursor — it falls back and works, and converting with `hyprcursor-util` does **not** fix
the repaint. A note, not a fix.

⚠️ Before any further work here, read the cursor section of `dev-workflow.md`. **Five** separate
instruments lie about this and all of them lie in the direction of "your change did nothing".

### 73. App search dropped "most used first", and putting it back means counting our OWN launches (2026-08-17)
AstalApps broke ties by **launch frequency**, cached in `~/.cache/astal/apps-frequents.json` and
incremented inside `Application.launch()`. Nidara never launches that way — every surface goes
through `AppService.getLaunchCommand()` under `uwsm app` — so the counter only advanced on the
rare FALLBACK path. After months of daily use, this machine's cache held **two** entries out of 80
apps (`antigravity-ide: 7`, `nvtop: 1`), which is not a frequency ranking, it is a log of when
`gtk-launch` failed. `core/app-search.ts` therefore breaks ties on the app NAME, which is at least
total and repeatable (a GTK sort function is keyed on it).

Carrying it over properly is a real, wanted feature and it is **not** a port: the counter has to
live where the launches actually happen (`getLaunchCommand`, or the dock/grid/Prism call sites),
persist under `~/.config/nidara/`, and decay — a launcher that ranks by all-time count freezes
whatever you used most in your first week. Until then, do NOT reintroduce a frequency term by
reading Astal's file: it is stale, it belongs to a removed dependency, and it counts the wrong
event. Note the empty-query order is unaffected either way — the app grid sorts A→Z by design.

Second, smaller thing found in the same pass and left alone: `gtk-launch` genuinely fails for some
entries (that is what those 7 fallbacks were). The grid now logs a warning and falls back to
spawning `Exec=` under `uwsm app` — still inside the systemd slice, unlike the `AppInfo.launch()`
fallback it replaced, which spawned the app as a child of the shell. **Nobody has diagnosed WHY
gtk-launch fails for those entries**; the warning is there so the next person has a thread to pull.

### 74. Tray context menus don't draw checkmarks or row icons (deferred, 2026-08-18)
`core/dbusmenu.ts` reads `toggle-type`/`toggle-state` and builds STATEFUL actions for them, and it
reads `icon-name` per row — but `common/NidaraMenu.ts` renders labels, actions and links only, so a
checked "Mute notifications" looks exactly like an unchecked one. **Not a regression**:
`appmenu-glib-translator` produced the same state and NidaraMenu ignored it just the same, so this is
older than the replacement. It is deferred rather than done because drawing a check is a design
decision about the menu row (where the mark sits, whether a row icon is allowed at all, how it reads
against the glass), not a plumbing one — the state is already there when someone wants it.

Same file, same class: `disposition` (`informative`/`warning`/`alert`) is not requested and not drawn.
No app Nidara ships with has ever sent one.

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
libadwaita that AGS force-loads defines the named color → GNOME's palette flavor of the
accent, not our exact token; on an Adwaita-free system it breaks silently. Now they use
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
Gtk.Calendar, `combo`), and live names that look stale (`notif-win`). Deliberately KEPT
with zero direct consumers: the `entry, .nidara-input` / `switch, .nidara-switch` API
aliases, `.nidara-tile` (canonical tile recipe, referenced by the
`nidara-tile-states` docs), and `.is-selected` (paired with the live `:selected` GTK
pseudo in `_base.scss` — an opt-in alias for our own widgets, same policy as the input/switch aliases).
**Re-run 2026-06-23 (271 classes):** removed 2 newly-confirmed dead blocks —
`.settings-icon-btn--danger` (`_components.scss`, a never-wired "danger tint" modifier; the base
`.settings-icon-btn` is only ever added plain/`+flat`) and `.is-danger` (`_control-center.scss`, the
only live `is-*` toggle is `.is-active` in `StatusIndicators.tsx`). The other 24 candidates are all
accounted-for traps: the 9 dynamic `.accent-*` swatches, `.nidara-btn--ghost` (variant `"ghost"` IS
used, Audio.tsx), the 4 GTK-internal nodes (`combo`/`day-name`/`other-month`/`week-number`), the 2 GTK
overlay-scrollbar nodes (`hovering`/`overlay-indicator`, #15), the 4 kept aliases above, and 4
tombstone *comments* the extractor matches inside `/* … */` (`bar-ws-dot`/`cc-resize-btn`/
`cc-media-progress`/`settings-page-title` — the CSS is already gone, the comment documents why the
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

### 9. One Adwaita-WARNING per boot is unavoidable (don't chase it)
The shell is libadwaita-free, but **AGS's runtime calls `Adw.init()` whenever libadwaita
exists on the system** (`/usr/share/ags/js/lib/gtk4/app.ts` — unconditional, `catch`-guarded).
Two consequences: (a) in-process dark/light MUST go through `setPreferDark()` in
`ThemeManager.ts` (routes via `AdwStyleManager` when Adw is initialized, plain
`Gtk.Settings` otherwise — writing `gtk_application_prefer_dark_theme` directly logs
`Adwaita-WARNING` and risks being overridden); (b) exactly **one** warning per boot remains,
fired inside `Adw.init()` itself when GTK loads `~/.config/gtk-4.0/settings.ini` (which we
legitimately write so third-party plain-GTK4 apps follow dark mode). That one is framework
noise — harmless, not fixable from our side, don't burn time on it. It also means the
Adwaita stylesheet IS loaded in-process, which is why the anti-Adwaita resets (#2) are
still needed despite the Adwaita removal.
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
is resolved. **Residual (separate, low-priority):** ~40–60% of fresh instances still wake the
main thread ~120/s from an **AstalHyprland busy IO-watch on socket2** (it re-emits `"event"`
spuriously even though Hyprland sends ~4 real events/s). That's now HARMLESS — the fix makes
those events produce no `"changed"`/repaint — costing only ~0.2% CPU and **zero GPU**. A real
cure needs fixing/replacing AstalHyprland (already the #1 facade-replacement candidate, see
[[project_astal_dependency]]); not worth it for 0.2% CPU.

**The fix (3 parts, all in `core/HyprlandState.ts` + `surfaces/overview/WorkspaceOverview.tsx`):**
- **Dirty-check** (the load-bearing one): `_refresh()` computes a structural `_stateSignature()`
  (focus + per-client addr/class/geometry/workspace + workspace list; **excludes titles** —
  AppTitle tracks those via its own `notify::title`) and only `emit("changed")` when it differs.
  Spurious re-emits see identical state → no `"changed"` → no repaint.
- **Throttle**: `_scheduleRefresh()` floors the interval between refreshes at
  `REFRESH_MIN_INTERVAL_MS = 60` (real events are sparse, so imperceptible; caps the loop if it
  ever self-feeds via the getters).
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
(`widgets/media.ts buildBarContent`, guarded the play/pause `gicon` — AstalMpris polls position
every 1 s while PLAYING via `player.vala init_position_poll` → `notify::position`, so it re-blurred
at **1 Hz** while music played, commit d1803e2). **Rule:** guarding the `gicon` assignment
(`if (img.gicon !== want) img.gicon = want`; `Icons.*` are module-load cached refs so `===` holds)
is enough and is *safer* than narrowing — the generic `notify` stays robust to all metadata
changes, and with the only redraw-triggering setter guarded the 1 Hz wakeup queues no draw
(repaints are the cost, not wakeups — same principle as (A)). `label`/`sensitive`/`visible` are
already GTK equality-guarded. **Deferred items CLOSED in the 2026-07-02 optimization pass:**
- **Cover-art decode churn fixed** (`media.ts` rich panel + `MediaIsland.tsx`): `loadArt` now
  guards on the `cover_art` PATH (decode only when it changes), `MediaState` carries an
  `artVersion` and every tile's `update()` gates `queue_draw` on it, and the play/pause `gicon`
  reassigns are identity-guarded. Before: 1 decode + full redraw per second while music played
  (AstalMpris position poll), even with nothing visible — the media tile ships in the CC default.
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

### 12. Sporadic double-disconnect CRITICALs — RESOLVED (helper + full sweep 2026-06-23)
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
`common/Slider.ts` and once-guarded the `onExt` cleanup in `SettingsHelpers.ts` toggleRow/dropdownRow.
**Full sweep done 2026-06-23.** Every remaining disconnect-in-cleanup site now goes through
`safeDisconnect` — both the useless `try{disconnect}catch{}` guards AND the bare unguarded
`obj.disconnect(id)` calls on `unrealize`/`destroy` (which were the actual repro pattern: `unrealize`
fires on every realize/unrealize cycle, so the second run disconnected a stale id). Migrated 21 files:
`core/{NetworkService,AudioService,BluetoothService}.ts`, `surfaces/bar/{Bar,AppTitle,Tray}.tsx`,
`surfaces/control-center/{Toggles,NotificationCenter}.tsx`, `surfaces/dock/{DockCore,DockItem}.tsx`,
`surfaces/overview/{WorkspaceOverview,WorkspacePreview}.tsx`, `surfaces/app-grid/AppGrid.tsx`,
`surfaces/about/AboutWindow.tsx`, `widgets/wifi.ts`, and the Settings pages
(Appearance, Display, Region, Input, Network, Bluetooth). Verified: zero `try{…disconnect…}catch`
left tree-wide, the only `.disconnect(` call is inside `safeDisconnect` itself; typecheck + build green.
**Rule still stands:** use `safeDisconnect` for ALL disconnect-in-cleanup code — never bare
`try{disconnect}catch{}` (it doesn't catch the C-level critical) and never a bare `obj.disconnect(id)`
in an `unrealize`/`destroy` handler.

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

### 15. The NC overlay scrollbar still widens on hover — can't be defeated by CSS (don't chase it)
The notification-center list uses a GTK overlay scrollbar in an **8px lane** to the right of
the cards (so cards stay flush with the bar capsules — see `state-and-ipc.md`). GTK widens
the overlay slider on pointer **proximity** (it adds `.hovering`/`.dragging` itself, NOT the
CSS `:hover`), and **Adwaita's `scrollbar.overlay-indicator.hovering slider` rule wins
despite higher-specificity overrides** in `_control-center.scss` — the size-pin there is NOT
load-bearing (verified: the slider still grows). What largely keeps it off the cards' close
buttons is **anchoring the scrollbar flush to the right edge** (`trough` margin/padding reset
+ a 1px slider side margin), so it grows toward the wall, not left over the cards. `set_can_target(false)`
on the scrollbar does NOT help — proximity-expand is independent of event targeting.
**Residual (accepted, low priority):** on hover the widened slider still steals a *few px* of
input from the close button's right edge — nearly imperceptible in use, left as possible
polish/optimization. If the hover growth ever truly must stop, it needs a structural change
(custom Cairo indicator or non-overlay reserved scrollbar with its own reflow tradeoff), not
more specificity. Same root as #9 (the Adwaita stylesheet is loaded in-process).

### 17. Status-indicator subsystem: extension points deliberately not wired (2026-06-19)
`surfaces/bar/StatusIndicators.tsx` is a declarative registry (`INDICATORS`, three states
hidden/armed/active) rendered as a small **badge on the bar's Control-Center button**
(`ccBadge`) + a **status banner inside the CC** above the widgets (`ccStatusBanner`, where the
Stop/kill-switch lives). It currently hosts only recording + AI-control but is the intended home for
**privacy/activity indicators** (mic, camera, screen-share, location). Those are **not wired** (no
source detection yet); adding one = a new `INDICATORS` entry with `state()` + `subscribe()` + `onClick`.
Also deferred by product decision: **drag-reorder of bar widgets** (bar order is category-derived via
`barOrder`; the CC has its own Edit-mode reorder). The AI "active" signal depends on the tools pinging
`notifyComputerAction` — an action path that bypasses `nidara-act/type/click` would stay "armed", not
"active"; fine today (those are the only action tools), re-check if a new path is added.

### 18. App grid lives in the dock BY DESIGN (Super-launch reveals the dock) — not a Status overlay
The fullscreen app grid is implemented **inside the dock window** (`DockCore.tsx` — closure var
`appGridPanelOpen`, exposed on the window as `toggleAppGridPanel` / `isAppGridPanelOpen`), **not**
as a `Status.ts` overlay like CC/NC/Prism/Overview. This is **deliberate** (owner, 2026-06-20):
launching the grid (Super) also **reveals the dock**, so the user can reach the dock when it's
hidden (autohide) or out of the way (games / fullscreen). **Don't "fix" this by moving the app grid
into Status** — you'd break the dock-reveal coupling.
**Accepted consequence:** the app grid is **outside Status's mutual exclusion**, so it can be open
at the same time as another overlay (verified live: app grid + Control Center both `true`). Left
as-is by owner decision — low impact, and forcing exclusion would fight the dock coupling.
**Observability fixed (2026-06-20):** `dumpState.overlays.appGrid` now reports its real state —
`app.ts` reads it from the dock via the window's `isAppGridPanelOpen()` (through a module-level
`isAppGridOpen` accessor populated in `main()`), instead of mirroring in Status. Agents can now see
whether the launcher is open while the architectural special-case stays intact.

### 19. Shipped default config was a personal snapshot — RESOLVED
The seeded `defaults/*.json` were a dump of the maintainer's personal config, not curated
defaults (caught by the clean-VM first-run test, 2026-06-20). **PR #27 curated `appearance.json`**
(accent → blue, iconTheme → Papirus, transparency → a deliberate 0.5 — was a slider-derived float)
and added the packaging that made it resolve: `papirus-icon-theme`/`adwaita-icon-theme`/`xdg-utils`,
the default file-manager association (`xdg-mime` `inode/directory` → nautilus, else the dock's Files
item `xdg-open`ed a terminal), and a wallpaper-on-first-run fallback in `hyprland.lua` (awww-daemon's
cache is empty on a fresh box).
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
deps (appmenu + 16 Astal + ags), GitHub Pages (`https://nidara-project.github.io/nidara-repo/$arch`,
repo name `nidara`, **GPG-signed since 2026-07-05**: CI signs packages + db, clients use
`SigLevel = Required DatabaseOptional`, key bundled at `packaging/nidara-repo.gpg`, imported/lsigned
by install.sh which also migrates unsigned-era `Optional TrustAll` entries). **`install.sh` now consumes it**
(validated E2E in a clean VM 2026-06-21): §1 registers `[nidara]` + `pacman -S`'s the 18 explicitly
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
the refs). **Still deferred at the repo:** tightening `depends=()` + `provides`/`conflicts` (a
`nidara-keyring` package could later replace the bundled-key import, but the current
`pacman-key --add` path works and ships). **Since the packaging switch (2026-07) the repo also
ships `nidara` itself**: built LAST by `build-repo.sh` from the `NIDARA_REF` tag in `pins.env`,
with the PKGBUILD found INSIDE the tag (`packaging/nidara/`); `install.sh --system` consumes it
(prebuilt or local makepkg fallback) and `nidara-update` goes through `pacman -Syu` +
`nidara-setup` on package installs. See
`packaging/README.md` and `references/dev-workflow.md`. Next link of the distribution track:
`nidara-repo → archiso → Calamares` ([[project_installer]]).

### 22. Settings → Network doesn't hot-detect a Wi-Fi adapter added after boot (low impact)
Found in the clean-VM nivel-3 sweep (2026-06-22, fake-wifi.sh with `mac80211_hwsim`): if the shell
starts with **no** Wi-Fi device and one appears later, the Network page stays on the "No compatible
adapter found / Wi-Fi hardware not detected" empty state until the shell is reloaded — then it binds
correctly (detect → scan → connect, and the detail row updates reactively on connect, all verified).
Cause is almost certainly init-time device binding in `libastal-network`/`core/NetworkService` rather
than a `device-added` subscription. **Not a first-boot bug**: real Wi-Fi adapters exist at boot, so the
common case works; the only gap is a **USB Wi-Fi dongle hot-plugged after login** (reload the shell to
pick it up). Low priority; if fixed, watch NM's device list reactively in NetworkService, not just at
construction. Same shape would apply to Bluetooth controllers hot-added after boot.

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
  `isDark`); `common/Slider.ts` track uses it. Redraws on `Theme "changed"` (slider already subscribes).

**Residual (NOT Phase 3 — product decision / cosmetic, left as-is):**
- **Tray icon coherence (partly unsolvable).** Symbolic tray icons follow the theme/pin; pixmap-only ones
  can't (inherent to SNI). A uniform policy is a product decision, not a bug.
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

### 29. Ghost descenders on list mutation — line-height workaround is PROVISIONAL and PARTIAL (2026-07-09, extended 07-11)
NOT just filtering: the same descender ghosts appear when ROWS ARE REMOVED from a plain
settings list — user-confirmed 07-11 deleting entries in Settings → Apps → Autostart, whose
entries list is a regular `.nidara-list` where the `.apps-list`-scoped line-height fix does
NOT apply. Treat this as one bug with two triggers (filter-hide and row-removal); the user
wants a **robust, definitive fix for all list-mutation cases** eventually, instead of chasing
it list by list — that likely means resolving the underlying GTK repaint bug (options (b)/(c)
below) or applying the line-height metric globally after a visual pass (option (a)).
App Icons / Installed Apps and the Autostart app picker (same `.apps-list` classes, same filter
idiom) are the Settings lists that filter in place; on `invalidate_filter`
GTK4 (4.22.4, default renderer, Wayland) leaves the descender ink of `y/g/j/p` behind hidden rows
(ghost) and clips it on the visible ones — a GskGL damage/re-raster bug (hover row-state re-render
and window resize both clear it; `queue_draw()` after `invalidate_filter()` does NOT).
Current fix: `.apps-list .nidara-row-subtitle { line-height: 1.35 }` (grows the line box so the ink
is inside it → drawn full AND repainted on filter). It **works but is provisional**: scoped to App
Icons, so its subtitles are slightly looser than the shared `.nidara-row-subtitle` elsewhere — a
design-system inconsistency the user flagged and chose to live with for now, to revisit. A proper
fix is either (a) apply the metric globally (changes every list's density — needs a visual pass), or
(b) a geometry-neutral fix of the actual GTK repaint (every attempt failed or clipped: queue_draw at
any scope, swaps, rebuild-fresh-rows, opacity toggle, padding→clips; see design-system.md "Ghost
descenders"), or (c) bisect `GSK_RENDERER` (cairo vs ngl/vulkan) and file upstream. **Also:
screenshot/agent-driven verification is masked here** (interaction re-renders and hides it) — verify
with a human. Same latent bug in `AppGrid.tsx`.

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
  the bus). Cover art goes through `resolveCoverArt` — chain: `cover_art` (AstalMpris's cache)
  → `file://` → `data:` (decoded once into `~/.cache/nidara/media-art/`) → `http(s)` (async
  curl into the same cache, negative-cached on failure so a dead URL isn't retried at the 1 Hz
  position poll). Known upstream noise: AstalMpris logs 2× `player.vala … Failed to cache
  cover art … not supported` per `data:` track before our fallback renders it (GIO has no
  `data:` support) — harmless, don't chase. `MediaIslandContent` shares ONE `MediaState`
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
- **Sliders** — one Cairo `makeSlider` (`common/Slider.ts`); no native `Gtk.Scale`,
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
  Banners never expand.

---

## Meta: how to interpret "tech debt" here

Not a bug list — conscious tradeoffs to pay down opportunistically:
1. If you're already in a file, prefer the "right fix" direction — but only if small and
   self-contained.
2. If it would balloon your change, leave it and add a comment linking here.
3. **Don't refactor as a side-effect of an unrelated change** — drive-by fixes tend to be
   partial and create drift.

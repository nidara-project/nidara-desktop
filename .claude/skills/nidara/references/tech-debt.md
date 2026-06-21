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
pre-commandment-5 separate overlay windows, the old Tahoe sidebar, deleted Resources.tsx,
and the pre-context-menu CC edit chrome. **False-positive traps for the next run:** classes
built dynamically (`accent-${key}` in Appearance.tsx, `nidara-btn--${variant}` in
nidara-kit/button.ts), GTK-internal node classes (`day-name`/`other-month`/`week-number` =
Gtk.Calendar, `combo`), and live names that look stale (`notif-win`). Deliberately KEPT
with zero direct consumers: the `entry, .nidara-input` / `switch, .nidara-switch` API
aliases and `.nidara-tile` (canonical tile recipe, referenced by the
`nidara-tile-states` docs).

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
already GTK equality-guarded. **Still deferred (all transient surfaces — only churn while open,
lower priority):** the same generic `notify` in the CC wifi toggle (`Toggles.tsx:198`), battery
(`battery.ts:112`, UPower is low-freq anyway), ethernet (`ethernet.ts:69`, low-freq); and the
media **rich panel** (`media.ts buildBarExpanded` ~L216) + `MediaIsland.tsx:36`, which go further
and **re-decode the cover-art PNG from disk every notify** (`GdkPixbuf.new_from_file_at_scale` +
unconditional `artDa.queue_draw()`) — guard `loadArt` on a changed `cover_art` path when touched.

### 12. Sporadic double-disconnect CRITICALs — FIXED (helper + reproducing cluster); rest opportunistic
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
**Remaining ~25 bare `try{disconnect}catch{}` sites migrate opportunistically** (when already editing
the file): `core/{NetworkService,AudioService,BluetoothService}.ts`, `surfaces/control-center/Toggles.tsx`,
`widgets/wifi.ts`, and several `surfaces/settings/pages/*.tsx` (Appearance, Display, Region, Input,
Network, Bluetooth). Use `safeDisconnect` for all new disconnect-in-cleanup code — never bare
`try{disconnect}catch{}`.

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
`NidaraMenu.ts` `makeRow` (renders Gio menu models — tray menus; different shape: model
iteration, submenus flattened to headers) and `Bar.tsx` `buildOverflowList` rows. Migrate
opportunistically if already editing those files; not worth a standalone pass.

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

### 16. `install.sh` never refreshes `/etc/greetd` on update (greetd-is-our-own-DM blind spot)
`_detect_dm()` (install.sh, the DM block) iterates `sddm gdm lightdm lxdm xdm slim ly greetd` and
**includes `greetd`**. Because the installer itself enables greetd, every later `--update`/reinstall
detects `ACTIVE_DM=greetd`, so `if [ "$ACTIVE_DM" = "none" ]` is false and the **entire `/etc/greetd`
block is skipped** — `config.toml` and `hyprland-greeter.lua` are never re-copied. This is silent until a
path/name in those templates changes: the **Nidara rename shipped a new `nidara-greeter` binary but left
`/etc/greetd/hyprland-greeter.lua` calling the deleted `crystal-greeter`**, so the greeter died on boot
(`greetd: greeter exited without creating a session` → start-limit-hit → error screen before login).
Recovered by hand: `cp config/greetd/{hyprland-greeter.lua,config.toml} /etc/greetd/` +
`systemctl reset-failed greetd` + `restart`. **Fix (deferred) — gate on a fingerprint, NOT on the bare
`greetd` enabled-state.** The naive fixes (drop `greetd` from `_detect_dm`, or
`[ "$ACTIVE_DM" = "none" ] || [ "$ACTIVE_DM" = "greetd" ]`) are WRONG: greetd is the go-to minimal DM for
many Wayland WM users running a *different* greeter (tuigreet/gtkgreet/ReGreet), and both naive forms would
**clobber that user's `/etc/greetd` on install/update** — greetd is not necessarily *ours*. Instead, re-sync
`/etc/greetd` only when it is recognizably ours: `ACTIVE_DM = none` (fresh, no DM) **OR** the existing config
is the Nidara one — our `config.toml` runs `HYPRLAND_CONFIG=/etc/greetd/hyprland-greeter.lua` and that `.lua`
launches `nidara-greeter`, both unmistakable (`grep -q hyprland-greeter.lua /etc/greetd/config.toml` or
`grep -q nidara-greeter /etc/greetd/hyprland-greeter.lua`). A foreign DM (sddm/gdm/…) **or a foreign greetd**
is left untouched, same as today. Bonus: today a greetd+tuigreet box silently never gets the Nidara greeter
installed (detected as active DM → block skipped); the fingerprint branch can warn instead ("greetd already
set up with a different greeter — point it at /etc/greetd/hyprland-greeter.lua to use Nidara's"). The block is
already idempotent (`systemctl enable greetd` is a no-op if enabled). NB the kb-layout `sed` in that block is now a no-op too
(the template sets `kb_layout = readKbLayout()`, no literal `"us"` to match) — copying the template verbatim
is correct. Related gotcha: greeter prefs live under the **HOME-relative** path baked into the `.lua`
(`/var/lib/greeter/.config/nidara/greeter-prefs.json`); a rename of that subdir orphans the saved kb layout
(falls back to `"us"`), cosmetic.

### 17. Status-indicator subsystem: extension points deliberately not wired (2026-06-19)
`surfaces/bar/StatusIndicators.tsx` is a declarative registry (`INDICATORS`, three states
hidden/armed/active) rendered the **macOS way**: a small **badge on the bar's Control-Center button**
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

### 21. `nidara-repo` — install.sh consumes it (DONE); residual = signing + permanent pin lockstep
`github.com/nidara-project/nidara-repo` (public, 2026-06-21) is a pacman binary repo serving the 18
deps (appmenu + 16 Astal + ags), GitHub Pages (`https://nidara-project.github.io/nidara-repo/$arch`,
repo name `nidara`, unsigned → `SigLevel = Optional TrustAll`). **`install.sh` now consumes it**
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
the refs). **Still deferred at the repo:** GPG signing (a `nidara-keyring` package, `SigLevel = Required`)
before any wide/ISO distribution, and tightening `depends=()` + `provides`/`conflicts`. See
`packaging/README.md` and `references/dev-workflow.md`. Next link of the distribution track:
`nidara-repo → archiso → Calamares` ([[project_installer]]).

## Resolved — rules that still apply

These were paid down; the *rule* remains:
- **Stable updates are STATELESS (2026-06-19).** There is NO per-user source clone. The old
  model kept a managed `~/.local/share/nidara/src` per user while `/usr/share` was shared →
  divergent src, "last sudoer-updater wins" globally. `nidara-update` now shallow-clones the
  newest release tag (default branch pre-release) to a throwaway temp, builds, installs,
  discards (~6 MB clone, negligible). **Rule:** never reintroduce a persistent per-user source
  copy as the update source; the runtime is system-wide, so the source of truth is the git
  remote + `/usr/share`. Dev installs are the one exception (they update from the developer's
  own registered clone via `.dev`/`.source`). `install.sh` system mode migrates away any
  legacy `src`/`.source`.
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
- **Greeter ↔ lockscreen** share `ui/lib/accent.ts` + `ui/lib/users.ts`; `lib/i18n.ts` stays
  separate per bundle on purpose (different config paths / superset).
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

---

## Meta: how to interpret "tech debt" here

Not a bug list — conscious tradeoffs to pay down opportunistically:
1. If you're already in a file, prefer the "right fix" direction — but only if small and
   self-contained.
2. If it would balloon your change, leave it and add a comment linking here.
3. **Don't refactor as a side-effect of an unrelated change** — drive-by fixes tend to be
   partial and create drift.

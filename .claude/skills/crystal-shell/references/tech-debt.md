# Crystal Shell — Known tech debt

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
`--crystal-accent` directly), `--crystal-accent-10` unified (5 sites), orphaned
`.bar-ws-dot` and `.cc-resize-btn` CSS deleted (the latter was the pre-context-menu tile
resize UI). For dark badges over imagery, don't hardcode rgba blacks — add scrim tokens
when a real user appears (a `--crystal-scrim` trio existed briefly; removed as speculative
once its only consumer turned out to be dead CSS). Rules that stand: **new code uses the
mixins/tokens**
(`glass()`, `material-*`, `crystal-row-states`/`-tile-states`, scrims); two accent-button
hover conventions coexist (`rgba(accent, .82/.85)` translucent vs `color-mix(… white 15%)`
lightened) — they look intentional per-material, don't blind-unify without a visual pass.
Sweep-verification recipe: compile `style.scss` before/after and diff — a pure refactor
must produce an identical (or fully-accounted) CSS diff.
**Systematic orphan purge done 2026-06-10:** a detector script (extract every `.class` from
`styles/*.scss`, `grep -rF` each against `surfaces/ widgets/ common/ core/ app.ts ../lib`) found and removed
~45 dead classes (−459 compiled lines, −13%) — remnants of the dock pre-DockCore, the
pre-commandment-5 separate overlay windows, the old Tahoe sidebar, deleted Resources.tsx,
and the pre-context-menu CC edit chrome. **False-positive traps for the next run:** classes
built dynamically (`accent-${key}` in Appearance.tsx, `crystal-btn--${variant}` in
crystal-ui/button.ts), GTK-internal node classes (`day-name`/`other-month`/`week-number` =
Gtk.Calendar, `combo`), and live names that look stale (`notif-win`). Deliberately KEPT
with zero direct consumers: the `entry, .crystal-input` / `switch, .crystal-switch` API
aliases and `.crystal-tile` (canonical tile recipe, referenced by the
`crystal-tile-states` docs).

### 2. Anti-Adwaita resets still dense in two files
`_control-center.scss` (~33 reset rules) and `_settings.scss` (~24). High reset counts signal
these surfaces are fighting Adwaita widgets they shouldn't use. **Don't add more resets** —
use `@mixin crystal-reset` or switch the widget to base GTK4 / `ui/lib/crystal-ui/`.

### 3. CC row typography doesn't scale with the font picker
`_control-center.scss` overrides `.crystal-row-title` / `.crystal-row-subtitle` to fixed
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
`CRYSTAL_SHELL_ARCHITECTURE.md` and `docs/crystal-shell-skill-brief.md` are local-only by the
owner's decision. Record architectural decisions there and/or in this skill's `references/`,
not in a tracked repo doc.

### 7. `pageHeader()` removed — RESOLVED
Settings page titles live in the **window header** as a breadcrumb (driven by
`Settings.tsx`, shown via `CrystalWindow`'s `headerTitle`). The in-body `pageHeader()`
stub, all ~19 `page.append(pageHeader(...))` call sites + their imports, and the
`.settings-page-title`/`-subtitle` CSS have been swept. The dead `settings.*.subtitle`
i18n keys were purged 2026-06-10 along with 13 other dead keys (32 total, both locales) —
detector: keys in `en.ts` minus literal `t("…")` uses; **dynamic lookups are the trap**
(`t(TIER_LABEL[tier])` keeps `cc.menu.size.*` alive), and the typecheck (`keyof typeof en`)
is the authoritative safety net: a wrongly-removed live key fails `npm run typecheck`.
Asset sweep verdict, same date: do NOT prune `assets/fluid-crystal/scalable/` by grep —
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

### 11. Sometimes the main thread wakes at ~monitor refresh (~137/s) — UNREPRODUCED Heisenbug
Idle baseline is **0 wakeups/s** (genuinely event-driven — keep it that way; measure with
`awk '/voluntary/{s+=$2} END{print s}' /proc/$PID/task/$PID/status` deltas, or
`crystal-shell-doctor` which now reports it). On 2026-06-09 several instances armed to a
permanent ~137/s (≈144 Hz refresh) during real desktop use — but an exhaustive controlled
hunt **failed to reproduce it**: all five overlay open/closes, Settings window, AppGrid,
dock context menus, grouped notifications + NC, workspace overview, system menu + power
menu, MPRIS media actively playing, tooltips, smooth + coarse cursor sweeps across dock and
bar, and the cursor parked on every interactive element — every one left 0/s.
**Methodology trap that created a false lead:** measurements taken while the user's cursor
sat wherever they left it (or mid-interaction) read 130–450/s and made it look like "opening
the CC leaks" — always park the cursor in a dead zone (`hyprctl dispatch movecursor`) before
sampling. CPU stays ~0.2% — battery concern, not perf.
**The spinning surface IS identified: `crystal-bar-zone`** (the invisible 40 px
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

### 12. Sporadic double-disconnect CRITICALs — unreproduced, capture recipe ready
Rare bursts (≈2 in 30 h) of `GLib-GObject-CRITICAL … instance has no handler with id` (3–4
ids at once, 2 instances) and `GLib-CRITICAL … Source ID not found when attempting to
remove it`. Some cleanup path disconnects handlers / removes sources twice. Ruled out by
direct exercise (no critical emitted): all five overlay toggles, window open/close churn,
notifications (incl. `-r` replacement + NC open), DPMS off/on. Next occurrence: don't
theorize — run the shell once under `G_DEBUG=fatal-criticals` while reproducing the user's
action of that moment and read the coredump backtrace (recipe in `dev-workflow.md`).

### 13. Lockscreen GTK4 segfault when a wl_output vanishes — upstream, mitigated by watchdog
On wake-from-suspend the DP link re-trains and the wl_output disappears for ~1 s; GTK
destroys the session-lock window bound to that output and segfaults inside
`gtk_window_destroy` (stack is pure libgtk-4/libwayland — our JS is not in it; coredump
2026-06-10 11:53). With the lock client dead, Hyprland showed its red "lock app crashed"
screen. Mitigation shipped: `bin/crystal-lock` relaunches the bundle on abnormal exit
(≤5 attempts) and `misc.allow_session_lock_restore = true` lets the new instance take the
lock over. Real fix is upstream (GTK4 / gtk4-layer-shell `Gtk4SessionLock`); if a clean
reproducer emerges, file it there. Don't try to "handle" output removal in lockscreen JS —
the crash happens below us, during Wayland event dispatch.

### 14. Two more flat-menu row implementations could migrate to `MenuRow.ts`
`common/MenuRow.ts` (2026-06-11) is the shared builder for flat `crystal-menu-row`
lists; the CC context menu and the bar window menu use it. Two hand-rolled siblings remain:
`CrystalMenu.ts` `makeRow` (renders Gio menu models — tray menus; different shape: model
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

## Resolved — rules that still apply

These were paid down; the *rule* remains:
- **(was #16) Settings is a normal window.** `openSettings` opens/raises it — NOT a toggle
  (re-invoking just raises; it closes only via its own close button). Don't turn it into a
  toggle-hide. **Raising across workspaces:** `gtk_window_present()` alone does NOT jump to the
  window when it's on another workspace — its Wayland activation is ignored by Hyprland
  (`misc:focus_on_activate=false`). So `raiseSettings()` (app.ts) present()s *and* dispatches an
  explicit `hyprlandState.focusWindow(addr)` (found by class `io.Astal.ags` + title
  `Crystal Shell Settings`), which switches to its workspace like clicking any running dock app.
  Same pattern applies to any normal (non-layer-shell) window the shell wants to summon.
  `toggleSettings` is kept as a **compat alias** (the `hyprland.lua` Super+S
  keybind / user scripts) — don't drop it without updating those. `status.settings_open`
  (→ `dumpState.overlays.settings`) is wired to the window's `notify::visible` in
  `Settings.tsx` — keep it honest. There's deliberately **no IPC to CLOSE** Settings: restart
  the shell to reset state in a verification run, and use `queryUI` (a `crystal-settings-window`
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
  `/usr/bin/crystal-shell-ui` PREPENDS `/usr/lib:/usr/local/lib` to `GI_TYPELIB_PATH`, so a
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
  commit binaries beyond the 3 release bundles; verify pngs / build artifacts stay git-ignored.
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

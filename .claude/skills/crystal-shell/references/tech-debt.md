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
eradicated (`@accent_bg_color` in `_workspace.scss`/`_app-grid.scss` rendered Adwaita BLUE
instead of the user's accent — real visible bug), scrim tokens added
(`--crystal-scrim/-strong/--crystal-on-scrim` — use them for dark badges over imagery,
never hardcoded rgba blacks), `--crystal-accent-10` unified (5 sites), orphaned
`.bar-ws-dot` CSS deleted. Rules that stand: **new code uses the mixins/tokens**
(`glass()`, `material-*`, `crystal-row-states`/`-tile-states`, scrims); two accent-button
hover conventions coexist (`rgba(accent, .82/.85)` translucent vs `color-mix(… white 15%)`
lightened) — they look intentional per-material, don't blind-unify without a visual pass.
Sweep-verification recipe: compile `style.scss` before/after and diff — a pure refactor
must produce an identical (or fully-accounted) CSS diff.

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
`.settings-page-title`/`-subtitle` CSS have been swept. Only leftover: the
`settings.*.subtitle` i18n keys are now dead (left in place per the bulk-i18n workflow).

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

### 10. Known log noise: one boot-time `g_list_store_remove` CRITICAL (upstream astal-tray)
`GLib-GIO-CRITICAL … g_list_store_remove: assertion '!g_sequence_iter_is_end (it)'` fires
once ~0.5 s after every shell boot. **It is NOT our code** — captured backtrace (2026-06-09,
via the recipe in `dev-workflow.md`) lands in `libastal-tray.so`: `Tray.on_item_unregister`
in Astal's `lib/tray/src/tray.vala` ignores `_items_store.find()`'s boolean and calls
`remove(pos)` with an undefined `pos` when a tray item unregisters before its `ready`
callback ever appended it (boot-time registration churn). Fix proposed upstream:
**https://github.com/Aylur/astal/pull/451** (2026-06-09; verified locally — patched lib =
0 CRITICALs across boots). Until it merges and the `ASTAL_REF` pin in `install.sh` advances
past it, the once-per-boot CRITICAL remains expected noise. Don't chase this in shell code.
The lazy tray-menu in `widget/bar/Tray.tsx` fixed a *different* (menu-parsing) instance —
this one is inside the library itself.
**Testing a patched Astal lib gotcha:** the installed typelib embeds the **absolute** `.so`
path, so `LD_LIBRARY_PATH` alone won't load your build. Point `GI_TYPELIB_PATH` at the
build dir's typelib — and if that one embeds a prefix you can't write to (`/usr/local/lib`),
binary-patch a copy with a same-length `/tmp` path (python `bytes.replace`, assert equal
lengths) and place the patched `.so` there.

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

### 13. Bluetooth pairing has no agent (passkey/PIN UI missing)
Settings → Bluetooth pairs via a bare `device.pair()`, with **no `org.bluez.Agent1`
registered**, so it's "just works" only: devices that need a 6-digit passkey confirmation
or a PIN have no UI and will pair blind or fail. AstalBluetooth offers no agent helper —
implementing it means raw Gio D-Bus: register an `Agent1` (capability `KeyboardDisplay`)
via `AgentManager1.RegisterAgent` + `RequestDefaultAgent`, handle `RequestConfirmation` /
`RequestPasskey` / `RequestPinCode` / `DisplayPasskey` / `DisplayPinCode` → drive a Crystal
dialog. Agent registration belongs in `BluetoothService`, the dialog in the page. **Testing
caveat:** the python-dbusmock bluez5 template's `Pair` never calls back into the agent, so
the passkey flow can't be exercised with the fake-bluetooth mock — needs real hardware or
manual D-Bus invocation of the agent methods.

## Resolved — rules that still apply

These were paid down; the *rule* remains:
- **Dock H/V** is deduplicated — fix dock logic in `DockCore.tsx` / `DockAxis.ts`, never the
  7-line wrappers.
- **Accent colors** live only in `ui/lib/accent.ts` — add/change them there.
- **Greeter ↔ lockscreen** share `ui/lib/accent.ts` + `ui/lib/users.ts`; `lib/i18n.ts` stays
  separate per bundle on purpose (different config paths / superset).
- **`Status.ts` exclusion** — add a new overlay's `_field → notify` to `EXCLUSIVE` and call
  `closeExclusive(...)`; don't touch the other setters.
- **Repo weight** — history was rewritten (.git 342→95 MiB); old clones must re-clone. Don't
  commit binaries beyond the 3 release bundles; verify pngs / build artifacts stay git-ignored.
- **Sliders** — one Cairo `makeSlider` (`widget/common/Slider.ts`); no native `Gtk.Scale`,
  no `PillSlider`. See `design-system.md`.
- **Monitor config** — applies via `hyprctl eval "hl.monitor({...})"`, NOT `hyprctl keyword`
  (rejected by the Lua parser). See `architecture.md`.

---

## Meta: how to interpret "tech debt" here

Not a bug list — conscious tradeoffs to pay down opportunistically:
1. If you're already in a file, prefer the "right fix" direction — but only if small and
   self-contained.
2. If it would balloon your change, leave it and add a comment linking here.
3. **Don't refactor as a side-effect of an unrelated change** — drive-by fixes tend to be
   partial and create drift.

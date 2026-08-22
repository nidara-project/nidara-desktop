# Nidara — Resolved tech debt (archive)

Everything here is **DONE**. It was split out of `tech-debt.md` on 2026-08-23, when that file
had grown to ~317 KB and more than half of it was items that no longer owed anything — an
agent looking for what is broken was paying to read what had already been fixed.

**Read `tech-debt.md` first.** Come here only when you are chasing a specific number, or when
you want to know how something was fixed and why. Nothing in this file is a task.

⚠️ **Item numbers are preserved and are never reused.** A cross-reference elsewhere in the skill
that says "tech-debt #71" means the number, not the file — if `tech-debt.md` does not have the
body, it has an index line pointing here. Do not renumber anything in either file.

⚠️ **Resolved does not always mean deletable.** Several of these carry a rule that still binds
(why a thing is shaped the way it is, or a trap that would be re-introduced by an innocent-looking
change). That is why they were archived rather than dropped. If you are about to undo something
one of these describes, read it first.

---

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
numbers by reading the bundle's decoded JS in `$XDG_RUNTIME_DIR` (the wrapper names it
`nidara-<hash>.js`; `scripts/run.sh` writes `nidara-run-app.js`).

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

### 14. Flat-menu row implementations migrated to `MenuRow.ts` (2026-06-11 → 2026-08-20)
`common/MenuRow.ts` (2026-06-11) is the shared builder for flat `nidara-menu-row`
lists; the CC context menu, the bar window menu, the bar overflow list (`Bar.tsx` `buildOverflowList`),
and widget menus (clipboard, media) use it. `NidaraMenu.ts` renders Gio menu models with its own dynamic
model iteration (`makeRow`), submenus, and section headers.

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

### 20. ✅ CLOSED — AstalHyprland was removed (2026-06-20 → 2026-08-17)
AstalHyprland was completely eliminated from the codebase on 2026-08-17, replaced by native
`core/hypr-ipc.ts` and `core/HyprlandState.ts`. The startup assertion noise is gone with the library.
On a clean boot into an empty workspace, `libastal-hyprland` previously logged at startup `Json-CRITICAL …
json_node_get_string` + `astal_hyprland_hyprland_get_client`. With native socket communication,
this dependency failure mode no longer exists.

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

### 30. ✅ FIXED — Form-dialog primitive in nidara-kit (2026-07-10 → 2026-08-20)

Built `showNidaraFormDialog` (`FormDialogHandle`, `FormResponse`, `NidaraFormDialogOpts`) in
`ui/lib/nidara-kit/form-dialog.ts`. Encapsulates undecorated floating-glass `Gtk.Window` chrome,
heading + optional subtitle, arbitrary content slot, horizontal separator, and `.nidara-alert-buttons`
footer with dynamic response sensitivity and labels (`setResponseSensitive`, `setResponseLabel`).
Migrated both Add User and Change Password dialogs in `Settings → Users` (`ui/shell/surfaces/settings/pages/Users.tsx`)
from unstyled raw `Gtk.Window`s onto `showNidaraFormDialog`.

### 35. ✅ RESOLVED — Focus & Tab-Aware Island Media Mutation (2026-07-19 → 2026-08-21)
Implemented in `surfaces/island/IslandActivities.tsx` (`mediaActivity`, `isPlayerForeground`, `isBrowserClass`).

The capsule's compact content only fronts the media player when playback is active AND the player
is running in the background. If the user focuses the native media app (e.g. Spotify, VLC), or focuses
the active playing tab in a web browser (matching `player.title`/`player.artist` against the browser's
window title), the capsule leaves the front for the workspace dots. When playing in a background browser
tab (e.g. YouTube while browsing PRs), the capsule recognizes the tab divergence and presents the compact
widget. Re-arbitrates live on `HyprlandState` "changed" and "title-changed" signals.

### 36. ✅ RESOLVED — Built-in Assistant v1 (2026-07-20 → 2026-08-20)
Brain (`bin/nidara-agent` + Settings → AI picker + keyring) and face (`core/AgentService.ts`
+ island **Agent mode** `surfaces/island/AgentIsland.tsx` `ISLAND_AGENT`, `agent` activity priority 25,
`Super+A → toggleAgent`, SCSS in `_bar.scss`, `island.agent.*` i18n) are both implemented and verified.
Residual items resolved:
- (a) Per-provider model memory in `ai.json` (`brainModels`).
- (b) Conversation context cap and transcript persistence (`MAX_PERSISTED = 120`).
- (c) Tool failure chip styling (`.agent-tool-fail`) and error dots (`.agent-error-dot`).
- (d) User turn alignment (`halign: Gtk.Align.END`) and bubble wrapping.

### 37. ✅ RESOLVED — `NidaraScrolled` in nidara-kit (2026-07-21 → 2026-08-20)
Built in `ui/lib/nidara-kit/scrolled.ts` (`NidaraScrolled`), owning the reserved hit lane (12px), stationary
DrawingArea painting (gesture drag coordinates are stable; zero layout looping), corner insets (`cornerRadius` +
`cornerInset`), and Adwaita hover growth suppression. Adopted across all scrollable surfaces in the desktop
(`AppGrid`, `NotificationCenter`, `AgentIsland`, `Settings`, `AppIcons`, `Autostart`, `clipboard`, `window`, and
`IslandGrid` detail panels).

### 41. ✅ FIXED — Keyring write timeout in Settings → AI (2026-07-26 → 2026-08-20)
Fixed in `surfaces/settings/pages/Ai.tsx` (`storeKey`, `clearKey`).

`storeKey` and `clearKey` now wrap asynchronous libsecret operations in a 12-second timeout guard
(`GLib.timeout_add` / `GLib.source_remove`). If `gcr-prompter` or the Secret Service hangs on an unlock
prompt or fails to respond, the operation is safely aborted, the UI (`saveBtn` / `clearBtn`) is re-enabled,
and a failure message is displayed in `keyStatus` instead of leaving the button disabled forever.

### 45. ✅ RESOLVED — `sameApp()` consistency enforced in CI (2026-08-01 → 2026-08-20)

`bin/nidara-{a11y,act,click,type}` each carry standalone copies of `sameApp`/`nameTokens`, and
`ui/shell/core/app-search.ts` implements the TypeScript counterpart for launcher search.

To prevent silent drift, `scripts/ci/same-app-check.mjs` was added to CI: it extracts the live
implementations directly from all four helper scripts and `app-search.ts`, asserts source and logic
parity, and executes a canonical test matrix of application name pairs (camelCase, digit seams,
reverse-DNS, packaging prefixes, and negative non-matches) across every implementation.

---

### 48. ✅ RESOLVED — Art rounding unified as THUMB_RADIUS_RATIO in squircleThumb (2026-08-03 → 2026-08-20)
Unified in `ui/shell/common/DrawingUtils.ts` (`squircleThumb`).

`squircleThumb` now defaults `radius` to `THUMB_RADIUS_RATIO = 0.25` (25% macOS squircle ratio applied
to `Math.min(w, h)`, with a 6px floor and `RADIUS.md` (16px) ceiling). Callers across `widgets/clipboard.ts`
and `NotificationCenter.tsx` (`createHeroWidget`, `createExpandedHeroWidget`) consume the default ratio
instead of hardcoding disparate pixel radii.

### 49. ✅ FIXED — The bubble menu is unified as GlassBubbleMenu (2026-08-03 → 2026-08-20)

Extracted into `common/GlassBubbleMenu.ts` (`GlassBubbleMenu`), encapsulating popover chrome,
Cairo glass bubble drawing, margin/halo calculations (`rowInsetFor(RADIUS.lg)`), and Theme
invalidation tracking. Adopted across all three surfaces: `DockItem.tsx`, `AppGrid.tsx`, and
`widgets/media.ts`.

`DockItem.tsx`, `AppGrid.tsx` and `widgets/media.ts` previously built the same popover by hand:
`new Gtk.Popover` → `Gtk.Grid` → a `DrawingArea` painted by `paintGlassBubble(…, { radiusMax: 16 })`
→ a `nidara-menu` rows `Gtk.Box` → a `Theme.connect("changed")` redraw (plus its disconnect
bookkeeping) → `set_child`/`set_parent` → `sideFor(position)` for the arrow side → a layout
function putting `BUF + PAD (+ ARROW_H on the arrow side)` on four margins. Unifying this into
`GlassBubbleMenu` ensures any future bubble menu reuses the shared component and tokens.

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

### 66. ✅ FIXED — The sidebar's rows opt out of theme padding (2026-08-11 → 2026-08-20)

Fixed in `ui/lib/styles/_components.scss` (`.nidara-sidebar > row { padding: 0 }`), reclaiming the 4px
across the sidebar column and raising the text budget from 170px to 174px (verified in `sidebar.ts` and
`scripts/dev/text-budget.js`).

`.nidara-row` carries `padding: 0` for a documented reason: `nidara-reset` clears background, border,
shadow and outline but NOT padding, and Adwaita gives every `list > row` 2px of it. The **sidebar's**
rows were bare `Gtk.ListBoxRow`s (`ui/lib/nidara-kit/sidebar.ts`) with no such class, so they previously
paid 4px across on the one fixed-width column. Reclaiming the 4px gives every locale more headroom.

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

### 73. ✅ FIXED — App search frequency ranking with temporal decay (2026-08-17 → 2026-08-20)

Fixed in `core/AppFrequency.ts` (`appFrequency`), `core/app-search.ts` (`scoreApp`, `rankApps`), and
`core/AppService.ts` (`recordLaunch`, `queryApps`, `search`).

- **Persistence & Decay**: Launches are recorded in `~/.config/nidara/app-frequency.json` and decayed with
  an exponential 14-day half-life ($S(t) = \text{count} \times 2^{-\Delta t / 1209600}$). Old/stale entries
  below $0.05$ are automatically pruned on save.
- **Search Scoring**: Frequency provides a bounded boost within matching tiers ($\le 0.45$ points) so frequently
  used apps take precedence over rarely used apps with slightly shorter names, while strictly preserving tier
  hierarchy (EXACT > PREFIX > WORD_PREFIX > SUBSTRING > ACRONYM).
- **Tie Breaking**: Equal match scores tie-break by frequency first, then alphabetically by name. Empty-query
  sort in `listApps()` remains strictly A→Z.
- **Instrumented Launch Sites**: Integrated at all launch origins: `AppGrid.tsx`, `Prism.tsx`, `DockItem.tsx`,
  `DockCore.tsx`, and `app.ts` (`launch_app` IPC). Tested in `scripts/dev/apps-probe.ts`.

### 74. ✅ FIXED — Tray context menus draw checkmarks, row icons and sensitivity (2026-08-18 → 2026-08-20)

Fixed in `core/dbusmenu.ts` (propagates `icon-name`, `toggle-type`, `toggle-state`, and `enabled` attributes
onto `Gio.MenuItem`) and `common/NidaraMenu.ts` (renders trailing `Icons.check` when `toggle-state` is true,
leading icons when provided, and sets row sensitivity from `enabled`).

`core/dbusmenu.ts` reads `toggle-type`/`toggle-state` and builds stateful actions for them, and it
reads `icon-name` per row. `common/NidaraMenu.ts` now reads these attributes and draws trailing checkmarks
and optional leading icons matching the universal menu design convention in `MenuRow.ts`.

Same file, same class: `disposition` (`informative`/`warning`/`alert`) is not requested and not drawn.
No app Nidara ships with has ever sent one.

### 75. ✅ FIXED — `readShellVersion()` fallback returns "unknown" instead of inventing "0.1.0" (2026-08-18 → 2026-08-20)

Fixed in `core/Paths.ts` (returns `"unknown"`) and `About.tsx`'s `isNewerVersion()` (guards against `"unknown"` / missing versions, declining update notifications when version is unresolvable).

Noticed from the CI smoke's own log line — `IPC OK — shell version 0.1.0` — which was correct
fallback behaviour and still read like a defect because the number was plausible.

`core/Paths.ts` resolves the shell's version in three steps: the `.dev` marker → the repo's
`VERSION` (0.7.2 on a dev box); then `/usr/share/nidara/VERSION`, written by `install.sh` §685 and
by the PKGBUILD's `install -Dm644 VERSION`; then `return "unknown"`. The smoke boots the bundle from
the committed tree with neither, so it lands on the third — and the gate is honest about it, since
it asserts the field EXISTS (`jq -e '.shell.version'`) and only prints the value.

**Why it was changed:** `"0.1.0"` was a lie that looked like an answer, and two things
consumed it. `surfaces/settings/pages/About.tsx` shows it as the version row, and — the one that
bit — line 98 fed it to `isNewerVersion(latest, readShellVersion())`, so a shell that fell
through would believe it is 0.1.0 and advertise an update **permanently**. `"unknown"` costs nothing, makes
`isNewerVersion` decline to compare, and tells the truth.

⚠️ Related and separate, found in the same look: **a dev box's `/usr/share/nidara/VERSION` goes
stale silently.** It is written only by an `install.sh --dev` run, and dev mode never reads it (the
`.dev` marker wins), so it sits at whatever version was current the last time the installer ran —
0.4.0 on the author's machine against a repo at 0.7.2. Harmless until someone flips back to system
mode and the shell starts reporting a version from months ago.

### 77. Native PAM Authentication & Zero-Astal State (2026-08-20)

`libastal-auth` was the very last external Astal dependency. It was vendored and replaced by **`lib/nidara-auth/`** (our own native C library + GObject Introspection typelib `NidaraAuth-1.0.typelib` / `gi://NidaraAuth`).

- **Architecture:** `NidaraAuthPam` runs PAM authentication in a background worker `GThread`, marshals conversation prompt callbacks via GLib `g_idle_add` to ensure thread-safe GJS signal delivery, blocks on `GMutex`/`GCond` until `supply_secret` is called, wipes secrets with `explicit_bzero`, and auto-resolves between `/etc/pam.d/nidara-lock` and `system-auth`.
- **Packaging:** `packaging/nidara/PKGBUILD` and `install.sh` compile and install `libnidara-auth` directly (via `build.sh`) alongside `libnidara-wl`.
- **Result:** Astal is 100% eliminated from the desktop environment — 0 external git clones, 0 external AUR packages, 0 pinned ASTAL_REF SHAs. All runtime services are pure TypeScript, native C, and standard Arch packages.

### 78. ✅ RESOLVED — GTK4 Height-for-Width Layout Safety & BlueZ Pairing Resilience (2026-08-21)

- **`ScaleRevealer` Height-for-Width Protection:** Added `Math.max(for_size, minW)` clamping in `vfunc_measure` and `vfunc_size_allocate` (`common/ScaleRevealer.ts`) so GTK4 never receives an undersized width constraint during vertical size allocation passes. In `NotificationCenter.tsx`, added `ellipsize: 3, lines: 1, max_width_chars: 24` to `GroupControlHeader`'s application name label, preventing notification cards from requesting widths beyond the notification column.
- **BlueZ Pairing Agent Resilience:** In `core/BluetoothService.ts`, handled `org.bluez.Error.AlreadyExists` by calling `UnregisterAgent` on `/org/bluez` for `/org/nidara/bluetooth/agent` and retrying registration automatically. Chained `RequestDefaultAgent` sequentially after `RegisterAgent` succeeds to avoid race conditions upon UI restarts (`Super+Shift+R`).
- **Build Cleanliness & Property Collisions:** Decoupled `ui/greeter` and `ui/lockscreen` build scripts from `../shell` directory hops, allowing each bundle to build and bundle cleanly in isolation. Renamed internal `GlassCapsule.hasFocus()` to `isFocused()` (`lib/glass-capsule.ts`) to avoid conflicting with `Gtk.Widget`/`Gtk.Box`'s `hasFocus` property accessor.
- **GTK4 CSS Syntax:** Removed invalid `margin: 0 auto;` declarations from `_settings.scss` (wallpaper preview and thumbnails box; centering is handled via `Gtk.CenterBox` and `halign`), keeping startup logs completely clean with 0 warnings.

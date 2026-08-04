# Nidara — Architecture

Read this when adding/editing widgets, changing how overlays attach, modifying any `core/` service, or trying to understand how the shell actually boots.

## Tech stack at a glance

| Layer | Tech |
|---|---|
| Language | TypeScript / TSX → compiled to GJS |
| UI framework | AGS v3 (Astal + Gnim JSX) |
| Toolkit | GTK4 (pure — libadwaita fully removed) |
| Wayland surfaces | gtk4-layer-shell (layer-shell protocol), `Gtk4SessionLock` (ext-session-lock-v1) |
| Compositor | Hyprland ≥ 0.55 (config in **Lua**) |
| Session manager | **uwsm** (manages the session as systemd units/scopes) |
| Display manager | greetd (default; only installed if no other DM is enabled) |
| Astal system services | AstalHyprland, AstalNetwork, AstalWp, AstalMpris, AstalNotifd, AstalBluetooth, AstalTray, AstalBattery, AstalApps, AstalGreet, AstalAuth |
| Styling | SCSS → `style.css` |
| Build | `ags bundle` → standalone binary |
| Wallpaper | `awww` (swww fork) |
| Idle / night light | hypridle, hyprsunset |
| Qt look | Kvantum + qt5ct/qt6ct (synced from the theme engine) |

`@girs/` (≈58 MB of auto-generated GI typings) is **git-ignored**; it only powers local typecheck and editor IntelliSense.

## Boot sequence

1. Display manager (greetd by default) runs `/usr/bin/nidara` via `/usr/share/wayland-sessions/nidara.desktop`.
2. `nidara` (session wrapper script) sets Wayland/GI env, then:
   `exec uwsm start -e -D Hyprland hyprland.desktop -- -c /usr/share/nidara/config/hypr/hyprland.lua`.
   uwsm runs the session as systemd units → activates `graphical-session.target`, clean teardown on exit.
3. `hyprland.lua` on `hyprland.start` launches daemons via `uwsm app -- <daemon>` (independent systemd scopes):
   `nidara-ui`, `awww-daemon`, polkit agent, `hypridle`, and `wl-paste --watch cliphist store`
   **twice** — once `--type text`, once `--type image` (see the clipboard widget notes below;
   one untyped watcher silently never captures an image).
4. **`nidara-ui`** (UI launcher in `/usr/bin/`): kills stale `gjs`, then —
   - **Dev mode:** if `~/.config/nidara/.dev` exists, `cd` to its path and `ags run app.ts`.
   - **Prod mode:** exec the bundle at `/usr/share/nidara/ui/shell/build/nidara`.
   - Log: `${XDG_RUNTIME_DIR:-/tmp}/nidara-ui.log` (per-user — see tech-debt "Resolved" rule on log paths).
5. **`app.ts`** (`ui/shell/app.ts`): sets dark/light via `Gtk.Settings.gtk_application_prefer_dark_theme` (pure GTK4 — no `Adw.init()`); registers the `nd-*-symbolic` icon search path; `app.start({ applicationId: "org.nidara.desktop", main, requestHandler })`. In `main()`: iterates monitors → `createUI(monitor)` (Bar + Dock per monitor), wires the dock-rebuild debounce, and populates `core/ShellActions` + the IPC registry (the bar/dock blur layer rules live in `hyprland.lua` as `hl.layer_rule` — the old `hyprctl keyword layerrule` calls were dead under the Lua parser and were removed).
6. Reload in dev: **`Super+Shift+R`** re-runs `nidara-ui` (the old `start_ui.sh`/`reload_ui.sh` no longer exist).

### Wallpaper at login: never trust awww's cache

`~/.config/nidara/wallpaper` is the **single source of truth** (written by `WallpaperManager`,
shown in Settings, resolved by greeter/lockscreen via `ui/lib/wallpaper.ts`). `awww-daemon` keeps a
per-output cache of its own (`~/.cache/awww/<ver>/<OUTPUT>`), but it is **shadow state, not
authority**: it records the last `awww img` and nothing else, and the restore is **asynchronous** —
the daemon literally builds and *spawns* `awww img --outputs=<out> --transition-type=none <path>`
once each output is configured, so it lands well **after** the socket starts answering `awww query`.

That gap is a trap. The original startup line ("apply the shipped default only if nothing is being
displayed") raced it, and when it won it wrote the **shipped default into the cache** — which every
later boot then faithfully restored, so the user's wallpaper was gone for good while Settings still
showed it. Self-perpetuating, and it looked like the shell had "forgotten" the setting (2026-07-26).

The rule for anything that paints the wallpaper at session start: **wait until every output reports
`image:` in `awww query`** (that's the daemon's own restore having landed), bounded by a timeout for
the fresh-install case where the cache is empty and no restore is ever coming (`misc:background_color`
covers that window), **then apply the resolved path from the config file over it** — one
authoritative apply, no conditional, `--transition-type none`. The Lua side owns this (helpers
`readWallpaperCfg`/`resolveWallpaper`/`shquote` near the top of `hyprland.lua`), **not** the shell:
the shell restarts mid-session (`Restart=on-failure`, `Super+Shift+R`) and would stomp the gaming
hero-art swap, whose "previous wallpaper" state lives in the compositor process.

Do **not** "simplify" this by passing `--no-cache` to the daemon: the cache is also what paints a
monitor hot-plugged mid-session, which nothing else currently handles.

## Directory map (`ui/shell/`)

Five pillars by responsibility (UI split renamed from the old `widget/` dir 2026-06-11):

- **`core/`** — singleton services. **Never touch the UI directly.** (Detailed below.)
- **`styles/`** — all SCSS, compiled to one `style.css`.
  - `_base.scss` holds design tokens + `@mixin glass` + `@mixin nidara-reset`.
  - `_reset.scss` neutralizes Adwaita residue.
  - Per-component modules are scoped with `window#id { … }`.
- **`surfaces/`** — whole TSX surfaces that consume `core/` state. Each surface is a function that takes a `Gdk.Monitor` and returns a `Gtk.Widget`:
  - `bar/`, `dock/`, `control-center/`, `app-grid/`, `island/` (the Activity Island: the bar-center capsule as a multi-purpose morphing surface. COMPACT state = a `Gtk.Stack` (crossfade + `interpolate_size`, so the pill's width animates) whose pages MUTATE by activity: one page per registered activity, **including the workspace dots** (which absorbed the old `bar/Workspaces.tsx`). **Activities are DATA** (`IslandActivity` in `ActivityIsland.tsx`; the concrete ones in `IslandActivities.tsx`): each declares `{compact form, priority, watch/isLive liveness, expandMode?, autoExpand?, makeGhost?/artSource? morph continuity}` and OWNS its liveness policy; the engine only arbitrates — highest-priority live activity fronts the compact. Current activities: **dots** 0 (`isLive: () => true` — the FLOOR, so "nothing running" is not a special case but the dots winning, and there is no `else` branch. They used to BE that else branch, and it was a bug: with any activity live the capsule's click opened THAT mode and the workspace overview became unreachable by mouse. `expandMode: overview`, no `makeGhost` — their morph continuity is the traveling `MorphPair` set, not a dissolving twin) < **media** 10 (`PlayerCompact`: mini art + title + 10fps Cairo EQ; pause holds a 12s grace, the open player panel holds liveness, player leaving the bus drops it instantly) < **recording** 20 (STEADY danger dot + elapsed, mirrors `status.recording`; the shell's ONE live-capture display since the CC banner row was dropped — the elapsed text comes from `recordingElapsed()` in `core/Status.ts`, off the single `recordingStartedAt` stamp, so no two surfaces can disagree and one built mid-capture never restarts at 0:00. `expandMode: ISLAND_RECORDING` → `RecordingIsland.tsx`, a statement card of clock + Stop, so the island answers for the capture end to end and stopping never depends on where the user put a widget. Its two earlier destinations were both wrong and both user-caught: the workspace overview (leftover from when the overview was the capsule's default identity, 2026-08-01) and then `onExpand → toggleCC` (fine only while the CC banner held the only Stop — with that row gone and the screenrecord widget placeable in the BAR ONLY, the click could open a Control Center with nothing about the recording in it, 2026-08-02). The FAST Stop is the bar pill, one click, see the `barClick` contract below) < **battery-critical** 30 (`≤5%` discharging, clears `>7%` or charging — hysteresis because UPower ticks are coarse; **the auto-expand prototype**: takes the front AND opens its alert once per takeover; the agent's "needs confirmation" will ride the same `autoExpand` flag) — and **agent** 25 (the built-in Assistant, between recording and battery: live while a turn runs (`agentService.busy`, the "working pill") or its panel is open; does NOT use the engine `autoExpand` — `AgentService` opens the island itself when a BACKGROUND turn finishes, since the flag fires on taking the front, not on finishing; closing the island mid-turn does not cancel). EXPANDED modes morph out of the capsule via one MorphRevealer per mode, driven by `status.island_mode` — `overview` (keyboard nav), `player` (the shared media detail panel from `widgets/media.ts`, no keyboard grab), `battery` (`BatteryIsland.tsx`, a plain statement card), `agent` (`AgentIsland.tsx`, the Assistant chat: header + streaming transcript + text entry; `needsKeyboard:true`, its `handleKey` claims only Escape so the entry types — the island's first TEXT mode). Cross-activity rules live in the engine's `arbitrate()`: a DEAD activity's open surface closes (player left the bus, battery recovered); auto-expand fires only when the activity TAKES the front (closing the island while the condition persists must not re-open it). **A chip click PROMOTES: it pins its activity to the front (`pinned`) AND opens its mode** — priority is a guess about what matters and a click is not, so the pin outlives every ordinary change and ends only when the user picks something else or the pinned activity dies. ONE exception: an `autoExpand` activity (a critical battery) takes the front anyway because interrupting is its whole purpose — and it does NOT clear the pin, so what the user chose comes back when the interruption passes. Both auto-expand and a chip click open through `openAfterSwap`, never in the click's own tick (see the phantom-% gotcha above). An activity with no `expandMode` opens its `onExpand` instead — the destination where it can actually be acted on (recording used to point here before it got a mode of its own) — and nothing at all if it has neither. **`onExpand` fires only from an EXPAND click (the capsule), never from promotion**: `openAfterSwap` handles island modes only, because switching the capsule to an activity is not the same act as asking to be taken to another surface, and one click must not do both (user call 2026-08-01). Promoting a capture puts the timer in the capsule and stops; its second click makes the jump. **There is no fall-back to the workspace overview**: that existed only while the overview was the capsule's default identity, and once the dots became an activity with a mode of their own it just meant an unrelated surface answering the click (user-caught 2026-08-01, on the recording pill). **Only a LIVE activity can be pinned**: a merely-indicated chip (the idle assistant) has nothing to hold the capsule with, so clicking it just opens its mode — which is what makes it live — exactly as Super+A does; pinning it would either be cleared on the spot by the liveness check or park an idle activity in the capsule forever. The LOSERS are no longer discarded — `arbitrate()` publishes every live-but-not-fronting activity as `background()` (+ `onBackgroundChanged()`) on the island handle, **ordered by priority, never by arrival** (an arrival-ordered row would swap icons under the cursor). Note the front can hold steady while the background changes, so the background is computed BEFORE `arbitrate()`'s no-front-change early-out. That list is painted by the **INDICATOR ROW** (`indicatorRow` on the handle, appended to the bar's centre box right of the capsule — the iOS split: a pill for the current thing, circles for the rest, and **the GROUP centres**, so the capsule leaves the monitor axis while anything else runs). A chip is shown for everything INDICATED that isn't fronting, which is WIDER than "live": the optional `isIndicated()` (default = `isLive`) lets an activity earn a chip without competing for the capsule. Only the Assistant uses it — a configured provider is always one click away — and it MUST stay out of `isLive`, or the agent (25) would outrank the music (10) and hold the capsule for a session that never used it. Each activity supplies its own glyph via the REQUIRED `indicator()` (dots → a frozen `.workspace-dot.active` pill, `makeActiveDotGlyph`; media → a music glyph; rec → the steady danger dot; battery → the Cairo glyph; agent → `sparkles`), max `INDICATOR_MAX` = 3 chips. **A chip's usable interior is ~17px, and a chip glyph is 16px:** the chip is a 24px circle (28px bar row height less `SquircleContainer`'s 2px technical inset per side, `perfect` → radius h/2) and the largest square that fits INSIDE a 24px circle is 24/√2 ≈ 17. Media used to stack the compact's 20px cover art over its music glyph and the square poked out of the glass on all four sides (user-caught 2026-08-03); shrinking it to 17 would have filled the circle edge to edge and eaten the glass ring that makes a chip read as a chip. **Cover art is not chip material** — it lives where it is legible (the compact's 20px slot beside the title, the panel's 96px). Nor is the compact's EQ: an animated chip damages the island's OWN layer at its frame rate, and Hyprland charges blur by the layer BOX, so a 24px flourish costs a full-screen re-blur per frame for as long as the music plays (the compact's EQ is 10fps AND `map`-gated for exactly this reason). Chips are static monochrome glyphs on glass. Three traps this cost: (1) chips are built ONCE and packed in DESCENDING priority so the visible subset is always in priority order with no reordering and every rect stays put; (2) the gap is each chip's `margin_start`, NOT box spacing — a collapsed `Gtk.Revealer` still counts as a visible child, so spacing would reserve its 8px forever and leave the capsule off-centre in an idle session; (3) the chips use `Gtk.Revealer`+`SLIDE_RIGHT` (the bar's existing idiom, `widgets/bar-helpers.ts`), NOT `ScaleRevealer`, which animates the measured HEIGHT only and passes width straight through. `IslandWindow.mount` therefore takes `hitTargets: Gtk.Widget[]` (capsule + every chip; hidden ones fall out on the visible/mapped guard), and Bar.tsx re-stamps the input region on `onBackgroundChanged` — a chip appearing MOVES the capsule without resizing it, so the `glassArea` resize hook never fires for it. Capsule click expands whatever fronts the compact; Super+W always reaches the overview. Battery E2E on a desktop: `scripts/dev/fake-battery.sh` (sudo, dev-workflow.md)), `overview/`, `prism/`
  - `island/IslandWindow.ts` — the **whole** Activity Island (compact capsule
    included) is the **second deliberate exception to commandment 5** (the agent
    pointer is the first): its own layer-shell window per monitor, namespace
    `nidara-island`, on the **OVERLAY** level (one above the bar's TOP).
    **Why it has to be a separate surface:** Hyprland's layer blur samples
    what was composited BEHIND a surface, once. Everything drawn inside one GTK
    window is one buffer, and Cairo has no backdrop-filter, so the island could
    never blur the bar capsules it grows over — at the default `overlayOpacity`
    of 0.05 they read through it sharp, which is exactly what it looked like.
    A higher layer level is composited after the bar, so the blur pass sees it.
    Verified live before building (2026-07-25, Hyprland 0.55.4). A `Gtk.Popover`
    would also be blurred, but under `popups_ignorealpha = 0.30` — a different
    knob from a layer's `ignore_alpha`, and unlowerable without haloing the
    popup's own shadow — so it would have forced the glass to ≈0.38 and broken
    the user's opacity setting. The layer keeps 0.05.
    **The COMPACT CAPSULE moved here too, and that is the design, not a detail.**
    The island is meant to be ONE object changing shape. A first cut left the
    capsule on the bar's surface and only moved the expanded modes; it cost a
    cross-window coordinate bridge in `MorphRevealer`, and — worse — mid-morph
    BOTH surfaces painted glass over the same pixels, so their blurs stacked and
    the transition showed a visible seam (user-caught 2026-07-26). One surface
    owning the shape end to end removes both. `Bar.tsx` still owns the capsule's
    GEOMETRY: it builds the row and hands it over, reusing the very same
    `.bar-centerbox`/`.bar-center` classes so the 8px top margin and 40px row
    height come from one CSS rule instead of a constant duplicated per window.
    Geometry: anchored on all four edges with `exclusive_zone = -1`, so the
    surface is EXACTLY the monitor rect regardless of what the bar and dock
    reserve (with zone 0 the bar's own 40px reservation would push the surface —
    and therefore the capsule — off the bar row).
    **The island FOLLOWS the bar's top edge** (`setTopOffset`, fed by
    `HyprlandState.layerTop("nidara-bar", connector)` on startup, on
    `config-reloaded`, and then on a 400ms watch that runs ONLY while displaced).
    The two surfaces answer to different rules on purpose — the bar's `zone = 40`
    both reserves space AND respects everyone else's reservations, the island's
    `-1` does neither — and that is right for each alone and wrong together: let
    anything reserve space ABOVE the bar (Hyprland's own config-error bar is the
    case in the wild) and the bar slides down while the island stays, leaving the
    capsule floating over the row it belongs to. Reproduced with a 60px reserving
    layer created before the shell; `zone = 0` is NOT the fix (it would respect the
    full 100px and land 40px BELOW the bar instead of 60px above). Mirroring where
    the bar actually is needs no model of who reserves what. **Anything converting
    root-relative bounds to monitor-relative must add the offset** —
    `occupiedRect` does, and it is what stops the agent clicking under the island.

    **Why it POLLS while displaced, and why that is not laziness** (2026-08-04, the
    first version of this fix became its own bug: fix the config and the island
    stayed down forever). Reading the position once per `configreloaded` is wrong
    because the reservation is not released on that event. Hyprland's
    `src/errorOverlay/Overlay.cpp` (v0.56.0): creating the error overlay calls
    `updateReservedArea(true)` → `arrangeLayersForMonitor` immediately, but
    `destroy()` only sets `m_queuedDestroy`; the release runs inside `draw()` and
    only once the **fadeOut animation has ENDED** — an unknown number of frames
    later, announced by no event, at a delay the user's animation config decides.
    Nor is there anything client-side to hook: a layer surface is told about its
    SIZE only, and the bar's never changes (anchored top/left/right with no bottom
    anchor → client-chosen height), so a pure vertical move produces no `configure`.
    Hence: measure on the event (twice — the overlay is CREATED from `draw()`, a
    frame after the event, so the immediate read can legitimately still be stale),
    then watch every 400ms **only while offset > 0**, stopping the moment the bar
    comes home. A healthy session polls zero times; a broken-config session — by
    definition degraded and being fixed right now — pays one `hyprctl layers` per
    400ms. Verified end to end with a BOTTOM-layer surface reserving 60px:
    bar 60 / island 0 → `hyprctl reload` → island 60 → kill the surface (no event
    at all) → island back at 0 within 300ms.

    **"Why not just share the bar's exclusive zone?" — TESTED AND REJECTED, with
    numbers (2026-08-04, owner's question).** Two variants, both tried:
    (a) *the same zone as the bar* (40) does not share anything — two surfaces
    asking for 40 reserve 80 between them, and the island, arranged after the bar,
    is positioned against a usable area the bar's own 40 has already been applied
    to, so it lands 40px BELOW the bar rather than level with it.
    (b) *`zone = 0` + `margin_top = -40`* (respect everyone, reserve nothing, then
    cancel the bar's own reservation) is genuinely elegant on the vertical axis and
    **works**: measured with a 60px reserving surface, the island tracked the bar to
    y=60 and back to 0 with **no event, no polling and no shell code at all** — the
    compositor did it. It dies on the HORIZONTAL axis. `zone = 0` means "respect ALL
    reservations", and there is no way to say "respect only foreign ones" — so our
    OWN dock counts. Measured with `dock.position = left`: `nidara-bar` at x=0
    w=2560 (zone > 0, arranged before the dock, unaffected), `nidara-island` at
    **x=100 w=2460**, capsule centre at 1053 instead of 1103 — **50px off the bar's
    centre, permanently, for every side-dock user**. That is the same bug being
    fixed here, moved to the other axis and from a rare state into the normal one.
    Compensating with a negative left margin would mean tracking the dock's own
    reservation (which changes with position, size and auto-hide) — more coupling
    than the watch, and it fails in the NORMAL state when it drifts. A secondary
    cost: with `zone = 0` the compositor never tells the client where it put the
    surface, so `occupiedRect` would lose the truth it exists to report.
    **Don't re-propose either variant.**

    **Which layer can displace the bar** (cost an hour on 2026-08-04 — a probe on
    OVERLAY, then on TOP, moved nothing). `arrangeLayersForMonitor` iterates the
    four layer vectors in index order — BACKGROUND, BOTTOM, TOP, OVERLAY — running
    the exclusive pass over each in turn, and each surface is positioned against
    the `usableArea` **as it stands when its own vector's turn comes**. So only a
    surface on a LOWER level (or an earlier entry within the same one) can push the
    bar (TOP) down; a reserving OVERLAY surface reserves for windows but arrives
    too late to move it. Hyprland's error bar is not a layer surface at all — it is
    a monitor `RESERVED_DYNAMIC_TYPE_ERROR_BAR`, subtracted in
    `logicalBoxMinusReserved()` before any layer is arranged, which is why it moves
    the bar when a same-level layer surface would not.

    **Do not "optimise" this into a surface that resizes.** It was tried and
    reverted on 2026-08-02: shrinking it to a capsule-height strip when collapsed
    is worth a measured −6.1 pts of GPU, but every grow produced a visible
    artefact (workspace dots rising and stretching, indicator chips narrowing
    upward) that could not be tuned away. See `tech-debt.md` §46 for the full
    attribution and what was ruled out — the short version is that GTK is provably
    innocent and the cost is compositor-side, so it is not a scheduling bug you
    can fix from here.
    **The layer-shell rule worth memorising, because a wrong guess about it cost
    real time:** a surface requesting `exclusive_zone > 0` is arranged against
    the FULL output area; only surfaces asking for **zone 0** get pushed into the
    remaining usable area; `-1` ignores everything. So the bar (zone 40) and the
    island (zone -1) are BOTH the full monitor rect, always, whatever the dock
    reserves — a side dock covers the bar, it never displaces it. Verify with
    `hyprctl layers -j` against `hyprctl monitors -j`'s `reserved` rather than
    reasoning from the anchors: on DP-1 that reads `reserved [0,40,0,100]` with
    `nidara-bar` still at `0 0 2560 1440`. This is also why `syncPanelMargins`
    dodges a side dock by hand. Always mapped: the
    capsule is permanent furniture, so there is no "closed" state to unmap into.
    It follows the bar out of sight instead — fullscreen hide and lock BOTH have
    to name `nidara-island` explicitly (`lockScreen`/`unlockScreen` in `app.ts`
    filter by window name; forget it and the capsule floats over the lockscreen).
    Consequences you inherit when touching it (two input regions, keyboard-grab
    collision, CSS scoped to BOTH windows, layer-order re-assertion) are listed
    in `state-and-ipc.md` under "Overlay placement".
  - `settings/` (+ `settings/pages/`, 18 pages), `about/`
  - `agent-pointer/` — the fake AI cursor that visualizes computer-use pointer
    actions (accent arrow + "AI" badge, Cairo-painted, click-through). A
    **deliberate exception to commandment 5**: its OWN layer-shell window per
    monitor on the **OVERLAY** layer, because it must paint above the bar itself
    and above fullscreen windows. Cost at rest is zero — created **unmapped**,
    `present()`ed only while an action plays, hidden after the fade-out (an
    always-mapped empty layer once cost 30–47% GPU — tech-debt §11; never
    regress). Its visibility lives outside `Status.ts` (not a user overlay):
    `isAgentPointerActive()` → `dumpState.flags.agentPointer` (app-grid
    precedent). Driven only via the `agentPointer` IPC command (land→confirm
    protocol — see `state-and-ipc.md`); no ShellActions entry (no widget consumes it).
- **`common/`** — shared UI pieces used across surfaces and widgets
  (`Slider`, `SquircleContainer`, `ScaleRevealer`, `MenuRow`, `widget-kit`, `DrawingUtils`…).
- **`widgets/`** — atomic CC/bar widgets, **auto-registered**: one file that
    default-exports a `const w: AtomicWidget = {...}` is ALL it takes —
    `scripts/gen-widget-index.mjs` scans the dir and regenerates the committed
    `widgets.gen.ts` (imports + `ALL_WIDGETS`; runs on npm build/dev hooks, on
    the dev launcher before `ags run`, and CI job `widgets-gen` fails if stale).
    Rules: widgets-only directory (anything else is a codegen hard-error; new
    helpers go in `common/` — `bar-helpers.ts` is grandfathered in EXCLUDE);
    unique `id`; no module-scope dependency on another widget (import order is
    alphabetical). Each widget declares a required `category` (`"media"` |
    `"utilities"` | `"system"`) + optional `barOrder`; `BAR_ORDER` is **derived**
    from those in `widgets/index.ts` (category order `[media, utilities, system]` =
    left→right, system nearest the tray — no hand-maintained list).
    `CC_DEFAULT_ORDER` stays editorial. The CC factories in `Toggles`/`Sliders`/
    `MediaIsland` return `CCWidgetSpec` (= `Omit<AtomicWidget,"category">`): they
    build content, not registry metadata, so they carry no category.
    **Zero-layout contract (2026-06-11)**: a widget never does host-geometry math.
    `buildContent(size, budget)` receives a `ContentBudget` (inner px the host
    guarantees: tile span − island padding, computed in `IslandGrid` from
    `islandPadding()` exported by `BaseIsland`) — size content from it, never
    from `UNIT`/`GAP`/padding knowledge (cpu-memory's ring derives from it; a
    widget's own intrinsic sizes — icon circles, buttons, its caption height —
    are fine). Panel widths (bar expansions / CC details) come from the
    **`PANEL_W` tier vocabulary** in `common/widget-kit.ts`
    (sm 200 / md 220 / lg 240 / xl 280 / full 356), never hardcoded px.
    GOTCHA: widget-kit MUST stay a leaf module — importing `CCLayoutManager`
    from it closes the cycle CCLayoutManager → widgets/index → widget →
    widget-kit → CCLayoutManager and **crashes the shell at boot**
    (CC_DEFAULT_ORDER undefined mid-cycle; typecheck does NOT catch module
    cycles — only a runtime boot does).
    **Bar-pill click**: the pill opens `buildBarExpanded` (or, with none, the CC
    detail). A widget can intercept that click with **`barClick(): boolean`** —
    return true and no panel opens. It is asked on EVERY click, not cached at
    build time, so the answer can depend on live state: `screenrecord` returns
    true only while `status.recording`, making the pill a one-click **Stop** (and
    its expansion panel pure setup, with no "recording" page and therefore no
    homogeneous `Gtk.Stack` sizing it to the setup page — that was the "Stop
    floating in a big empty panel" bug, 2026-08-01). Reserve it for an action that
    is UNAMBIGUOUS in that state; anything offering a choice belongs in the panel.
    **`execAsync` CANNOT read a command whose output may contain a NUL byte, and
    it fails silently by truncating.** Astal's `execAsync` (like Gio's
    `communicate_utf8`) marshals stdout through a NUL-terminated C string, so
    everything after the first NUL is gone before any JS runs — no error, no
    warning, just a short string, and no amount of sanitising in JS can recover
    it. `cliphist list` prints the raw bytes it stored, so ONE clip saved as
    UTF-16 (an app publishing its selection that way: ASCII interleaved with
    NULs) truncated the WHOLE listing: **49151 bytes / 750 lines arrived as the
    six characters `1035\th`**, and the clipboard panel showed a single mystery
    entry named "h" with the rest of the history apparently wiped — which is why
    it was reported as data loss rather than as a display bug (user-caught
    2026-08-03; the first fix attempt sanitised the label and did nothing,
    because the bytes never reached it). `widgets/clipboard.ts` reads stdout as
    BYTES via `Gio.Subprocess.communicate_async` and drops the C0 controls before
    decoding (keeping tab/newline — cliphist's field and record separators).
    Reach for the same shape for any command that can emit arbitrary bytes.
    The write path had the mirror of the same problem: cliphist stores no MIME
    type, so `decode | wl-copy` re-offered the UTF-16 bytes as plain text and the
    entry pasted as NOTHING. `copyEntry` now sniffs UTF-16 by NUL parity (all
    NULs at odd offsets = LE, all at even = BE, ≥80% of the pairs) and re-encodes
    to UTF-8; anything not positively identified — every image — is copied back
    byte for byte.
    **The capture side needs TWO `wl-paste` watchers, one per generic type** —
    `--type text` and `--type image` (`hyprland.lua`, `hyprland.start`), never one
    untyped watcher. With no `--type`, wl-paste chooses the mime type itself and its
    order (`src/wl-paste.c`, `mime_type_to_request`) is `text/plain;charset=utf-8`
    → `text/plain` → **ANY `text/*`** → only then anything else. A browser's "Copy
    image" offers `image/png` next to a `text/html`/`text/plain` flavour of the
    source URL, so `try_any_text` won and cliphist stored the URL — making "copy
    image" and "copy image address" produce the same entry, forever (user-caught
    2026-08-03; measured: **0 binary entries in an 82 MB, 750-item db**). The image
    path itself was never broken — an image-ONLY offer stored fine, which is why the
    bug reads as an app quirk instead of a config one. `--type text` reproduces the
    old order exactly for text offers and skips offers with no text; a copy carrying
    both now lands twice (one text row, one image row), which is cliphist's
    documented setup. Reading back needs nothing special: `wl-copy` runs `xdg-mime`
    over its stdin, so a decoded PNG is re-offered as `image/png`.
    An image row's preview is cliphist's literal
    `[[ binary data 24 KiB jpeg 1920x1080 ]]` (0.7.0) — never show it raw; the row
    becomes `Image · JPEG · 1920×1080` **plus a real thumbnail** via the shared
    `squircleThumb` (see design-system.md), decoded lazily per row and cached by
    cliphist id. The text alone identifies nothing: five screenshots of the same
    monitor are five identical rows, which is why Win+V and Klipper both show art.
    Non-image binary is NOT wrapped that way, it arrives raw, so matching the exact
    shape is safe.
    **Retention is set at the CAPTURE end** — `cliphist -max-items 50 store` on both
    watchers, not cliphist's default 750, and not a config file (one place to read,
    nothing to sync). 750 is tuned for cliphist's own fuzzel-searchable CLI; our panel
    is a scroll list with no search, so the panel shows EVERYTHING retained and nothing
    is kept that cannot be reached (prior art: Win+V 25, Klipper 20). It is a size
    decision too: measured on a real 750-item history, 549 rows were under 1 KB but
    **eighteen were over 1 MB and ate 50 of the 60 MB** — the tail is what costs, and
    per-item size is unbounded (cliphist has no max-size flag). ⚠️ cliphist trims to
    the limit on the NEXT store, **all at once** — lowering it deletes the surplus
    immediately, it does not age out. ⚠️ And the bolt db **never shrinks**: freed pages
    are reused, so the file sits at its high-water mark (79 MB for 0.9 MB of content
    here). Reclaiming it means rebuilding the db — dump each entry oldest-first, store
    into a NEW db path, verify byte-for-byte (sha256 per entry), then swap.
    Deletion is `cliphist delete` (id on stdin, tab-terminated, matches on the id
    ALONE — verified, including entries whose content holds NULs, which matters because
    our `line` went through the C0 filter and is not byte-identical to cliphist's
    output) and `cliphist wipe` for all of it. The panel puts a hover-revealed ✕ on
    each row (allocated at rest via `opacity`/`can_target`, never `visible`, so the
    reveal cannot reflow the row under the pointer) and a "Clear history" footer that
    swaps in place into a cancel/confirm pair — **a modal is wrong over a popover**,
    it dismisses the very surface it is asking about.
    Both the visible pill and the overflow-menu row honour it, or an overflowed
    widget would behave differently from a shown one.
    **Per-widget settings (`buildSettings`)**: a widget with real preferences
    declares `buildSettings(): Gtk.Widget` and Settings → Widgets grows a
    **"Configure" control on a second line INSIDE the widget's row** (the new
    `footer` slot of `NidaraRow`, ghost+compact, `margin_start: 34` to line up
    with the widget name), which pushes the page as a subpage
    (`nav.pushSubpage`, id `widgets/<id>`). It took three shapes in one day
    (2026-08-02), and the two rejected ones are the lesson: **(1)** a chevron in
    the row's TRAILING slot — the slot is for ONE control and it then held three,
    and because only SOME widgets have settings the chevron pushed just those
    rows' switches left, so the Bar/Center columns stopped lining up down the
    page. **An OPTIONAL control in the trailing slot misaligns the whole column;
    "it fits" is not the test.** **(2)** A sibling row underneath, indented. That
    fixed the alignment but read as another ITEM in the list — *"como si fuese
    otro widget"* — because an indent alone cannot say "this belongs to the row
    above" when every row in a list looks alike. Inside the row the two lines
    share one cell and one hover, so ownership is structural rather than a hint.
    It reuses the existing `settings.widgets.configure` key (already in all 12
    catalogues, it used to label the chevron's tooltip), so moving the control
    cost no translation debt. The hook existed unused until
    **`screenrecord` became its first user (2026-08-02)** — it is the "mini-app"
    contract: a widget's options live WITH the widget, not in a Settings page
    that would have to know what a screen recorder needs. Split the two kinds of
    choice: what you decide **at the moment of acting** stays in the capture
    panel (screen-or-region, audio-on-or-off), what is a **preference** goes in
    the subpage and is persisted by a `core/` config module (screenrecord →
    `core/RecordingConfig.ts`). The page is built with the ordinary
    `SettingsHelpers` vocabulary (`pageBox`/`listGroup`/`createRow`/
    `dropdownRow`/`toggleRow`), so a widget page is indistinguishable from a
    first-class Settings page — and importing those helpers from `widgets/` is
    fine (widget → surfaces is the normal direction; only `core/` is forbidden
    from reaching up).
    **Hardware gate**: a widget tied to hardware declares `isAvailable()` (+
    optional `watchAvailable(cb)` for hotplug) — when false it's hidden from
    bar + CC (filtered in `Bar.rebuildBarWidgets` and `IslandGrid.syncCCLayout`,
    at the layout level so edit-mode cells stay coherent) and its Settings card
    renders off+disabled with a "no hardware" hint. Placement config is NEVER
    mutated by availability. battery/wifi/bt/ethernet/brightness implement it;
    a fallback "not present" buildContent branch is no longer the mechanism for
    hiding (battery keeps one only as defense in depth).
  - `common/` — shared: `SquircleContainer`, `DrawingUtils`, `Slider.ts` (the ONE Cairo slider — no `Gtk.Scale`, no PillSlider), `ManagedWindow`, `WorkspaceSchematic`, `ScaleRevealer.ts` (the ONE show/hide animation — overlays + banners, see design-system.md), `MorphRevealer.ts` (capsule→island geometry morph: island modes grow out of the bar-center capsule — real interpolated Cairo squircle + traveling element ghosts (`MorphPair`: dots→card headers, cover art→panel artwork) + a dissolving source-content twin so the glass is never empty mid-flight, see design-system.md. Source and target both live on the ISLAND's surface (`IslandWindow.ts` — the capsule moved there with the modes precisely so this stays a plain same-window `compute_bounds`; a version that split them across two surfaces needed a coordinate bridge AND made both surfaces paint glass over the same pixels mid-morph, whose blurs stacked into a visible seam), `WorkspaceDot.ts` (`makeWorkspaceDot` + `WS_COUNT` — the ONE workspace state dot, shared by the bar capsule, the overview card headers and the morph's ghosts; all three must render identically for the morph's endpoint swaps to be invisible), `BatteryGlyph.ts` (`makeBatteryGlyph` + `batteryPresent`/`batteryFrac` — the ONE Cairo battery glyph: bar widget, CC tiles and the island's battery activity all render through it; semantic danger/success fill, never the accent. It is `battery.svg` redrawn in Cairo on the same 24-unit Lucide grid, and its argument is the **icon box in px = `Gtk.Image.pixel_size`**, not a glyph height: pass 16 in the bar and its capsule is exactly as wide as every icon widget's, 28 in CC tiles where siblings use `pixel_size: 28`. Sizing it by eye is what once made the bar's battery capsule 9px wider than its neighbours. Matching the set means matching INK WEIGHT too: the chrome strokes at 0.9 because `.bar-left image` attenuates nothing — a half-alpha stroke at true icon scale reads as a washed-out hairline and the glyph looks smaller than icons whose ink box is the same width. Painter and `battery.svg` are ONE drawing on one grid — edit both or neither, or the shell ends up with two batteries (the SVG is what Settings, the widget picker and the no-battery state show). Its ink deliberately spends Lucide's 22-unit content box out to the full 24 so the charge cavity stays legible at 16px; the 1.5-unit gap before the terminal nub is the floor, below which the two shapes antialias into one smudge at bar size), `poll.ts` (`pollWhileMapped` — ANY recurring widget poll must gate on map/unmap: built-once-hidden surfaces like CC tiles must not keep session-long timers; idle baseline is 0 wakeups/s and we keep it that way), `MenuRow.ts` (`menuRow`/`menuSeparator`/`menuHeader`/`setRowChecked` — the shared row builder for flat `nidara-menu-*` lists; used by the CC context menu and the bar window menu. New flat menus use it, not hand-rolled rows)
  - `bar/WindowMenu.ts` — the **window-options menu**: any-button click on the AppTitle capsule opens it in the bar's shared expansion capsule (`openCustomExpansion`, same system as tray menus — glass/fade/anchoring/outside-click for free). Anchoring defaults to **centered** under the pill (fine for right-side tray menus), but left-edge capsules pass `align: "start"` so the panel's left edge sits flush with the pill's — AppTitle does, because a centered panel there spills off the left screen edge. Sections: window actions (float/pseudo/fullscreen + center/pin when floating; all checks from the one `hs.getClientJson` read), inline move-to-workspace strip (1..5, current disabled), **group/tabs (v2, 2026-06-11)**, workspace actions (float all). The group section reads `grouped` (member addresses in tab order) from the same json read: one `menuRow` per member (checked = the menu's window, i.e. the active tab; clicking another member = `hs.focusWindow` — focusing a member IS the tab switch), plus "Move Out of Group" (`hs.moveOutOfGroup`, only when ≥2 members) and "Ungroup" (`hs.toggleGroup(addr)`, dissolves the whole group); ungrouped windows get a single "Create Group" row (lone group → groupbar appears, others join by drag/keybind). Astal clients are used for tab LABELS only (identity: wordmark/title) — never state. Deliberately absent: "move into group" (`into_group` ignores the window selector — acts on the focused window only — and needs a direction, meaningless in a menu) and group-lock (`lock_active` dispatches fine but its state is not readable anywhere, and a check you can't read is bad menu UX).
  - `bar/Tray.tsx` — the **system tray** (AstalTray/SNI). **Per-icon capsules (2026-07-15)**: each item is its OWN `SquircleContainer` with the exact bar-capsule params (`gloss`+`chrome`+`opacityRole:"bar"`+`CAPSULE_BORDER`+`hoverBorderAccent`+`perfect`), so tray icons read as first-class bar icons, NOT one grouped pill. `Tray.tsx` returns a plain `spacing:8` container (Bar appends it raw — no outer capsule — and it self-hides while empty). The icon carries `margin_start/end:16` → the button is 48px and fills the capsule, so the whole capsule left/right-clicks. **Right-click** → the app's DBus `menu_model` rendered by us via `openCustomExpansion` (same glass expansion as the window menu, never a native GTK popup; built + parsed **lazily on first open** — see the long comment on the appmenu-glib-translator crash). **Left-click** → raise the app's OWN window. Why NOT just `item.activate()`: SNI Activate means "raise your window", but a Wayland client CAN'T self-focus or pull you to its workspace (compositor blocks self-activation), so `activate()` returns OK yet nothing happens for a window parked on another workspace. Nidara IS the compositor's shell, so it raises the window itself, matching tray-item→window best link first: **(1) PID** — `GetConnectionUnixProcessID(busName)` on the item's bus (`item_id` is `<busname>/<objectpath>`) vs each `hs.clients[].pid`; deterministic, verified exact for Telegram + Antigravity; misses only proxied/legacy X11 icons whose bus owner is the proxy. **(2) name heuristic** — normalise the item's `id`/`icon_name`/`title` AND the window `class` to bare alphanumerics, accept when one contains the other (`org.telegram.desktop-attention-symbolic` ⊇ `org.telegram.desktop`; `Antigravity_status_icon_1` ⊇ `antigravity`). **(3) `item.activate()`** — only when no window matches (app truly minimised to tray with no surface → let it restore). Items flagged `is_menu` (no activate action — most Electron/appindicator trays) open the menu on left-click too. The PID is resolved async once per item and cached; a click before it resolves just falls through to the heuristic.

Other top-level dirs: `ui/lib/nidara-kit/` (pure-GTK4 primitives lib — see end of file) and the greeter/lockscreen bundles. `ui/lib/` itself holds small modules shared ACROSS bundles: `users.ts` (user enumeration + avatar path resolution — used by greeter, lockscreen AND Settings → Users; its displayName falls back GECOS→username. Never use `GLib.get_real_name()` for a display name: it returns the literal string "Unknown" when GECOS is empty, which is how archinstall creates users, and it caches at process start so it goes stale after a rename), `avatar.ts` (circular avatar for greeter+lockscreen — Gtk.Picture + center-crop pixbuf + pill radius, the same recipe as Settings → Users; plain Gtk.Image can't clip to a circle), `accent.ts`, `status-colors.ts`.

## `core/` services (singletons)

These are GObject singletons. Widgets subscribe to them via `notify::prop`. **None of them ever import a widget or call UI code directly** — state flows out, never in.

| File | LOC | Role |
|---|---|---|
| `Status.ts` | 202 | Central GObject state machine for overlays. Mutually-exclusive setters (opening one closes the others). Props: `cc/nc/prism/system-menu/about/settings-open`, `island-mode` (Activity Island mode string, "" = collapsed; replaced `overview-open`), `recording`, `cc-edit-mode`, `bar-expanded-id`, `cc-detail-id`. Exports island mode ids (`ISLAND_OVERVIEW`, `ISLAND_PLAYER`, `ISLAND_BATTERY`). **See `state-and-ipc.md`.** |
| `InputYield.ts` | ~125 | The shell **stepping out of the way** so computer-use can reach a real window. Hyprland's `rawWindowFocus` refuses to move window focus at all while any layer surface holds an EXCLUSIVE keyboard grab, and routes the pointer to that surface regardless of its input region — so from inside the Assistant island (always grabbing) `focus_window` was a no-op and clicks were swallowed. `begin()` makes every grabbing surface drop to `NONE` **and** stamp an empty input region, resolves only once the compositor has ANNOUNCED the release (`HyprlandState.afterGrabRelease`), `end()` restores. Driven by the HELPERS via the `yieldInput` IPC (so external MCP clients are covered too), re-entrant, with a 15 s watchdog so a helper that dies mid-action cannot leave the shell keyboard-less. Surfaces opt in with `registerHolder()` + a `notify::active` handler: Bar (Prism), IslandWindow, DockCore (app grid). **See `state-and-ipc.md`.** |
| `AppService.ts` | 685 | `.desktop` discovery, icon resolution + fallbacks, WM-class → Desktop-ID mapping. Backs Dock + AppGrid. **Launching: ALWAYS go through `getLaunchCommand(id)`** (wrapped in `uwsm app -- sh -c 'cd "$HOME" && exec <cmd>'`): it picks `flatpak run` for flatpak entries (gtk-launch's D-Bus activation dies silently for them when the session bus indexed its service dirs without the flatpak exports) and `gtk-launch` for everything else. Never parse `Exec=` by hand. Flatpak/Snap *discovery* requires `XDG_DATA_DIRS` set **before gjs starts** — done in `bin/nidara-ui`; GLib caches data dirs at first use, so patching the env in-process cannot fix it (verified 2026-06-12). **Icon LOOKUP is centralized here; app IDENTITY is the step surfaces keep skipping** (both bugs below found 2026-08-02, from one user report). `getIconName` answers "what art is this icon name", never "which app is this thing" — so a surface holding a foreign identity string must normalize it FIRST, and there are three entry points depending on what you hold: **`resolveWindowApp(class)`** for a Hyprland window, **`iconForAppName(name)`** for a human display name, **`isGenericIconName(n)`** to test whether a name you were handed is a placeholder rather than an answer. Skipping the step doesn't error — it renders the generic glyph, so the only symptom is two surfaces drawing the same thing differently. Concretely: the workspace overview fed `c.class` straight in, and since no theme has an icon called `io.Astal.ags`, **Settings drew the generic glyph in the overview and its registry icon in the dock** (the dock normalizes; the overview didn't). And the CC/Settings audio rows took AstalWp's `stream.icon` at face value — but that property is NEVER empty: a client declaring no `application.icon-name` gets `application-x-executable-symbolic`, a perfectly resolvable name for the generic glyph, so **GNOME Clocks played audio under a gear**. Same rows also had the app name wrong: on an AstalWp stream `name` is the STREAM ("Playback Stream") and `description` is the client ("Clocks"). The notification centre survives both only because it asks the registry FIRST (`getResolvedApp(desktop_entry || app_name)`) — its no-match fallback was hardened the same day. **The audit behind those fixes is done: every icon call site in the shell is listed by `grep -rn "getIconName(\|iconForAppName(\|resolveIconChain(\|resolveWindowApp("`, and all of them now normalize. `surfaces/bar/Schematic.tsx` was deleted in the same pass** — 195 dead lines nothing imported, superseded by `common/WorkspaceSchematic.ts`, still carrying both bugs plus `nd-icon` on app icons. Dead code that models the wrong pattern is worse than none; it is what a grep finds first. For ordered icon-name fallback chains use `resolveIconChain(names)` (theme-first: any name in the ACTIVE theme beats earlier names that only exist in deep fallbacks or shipped assets; absolute-path entries = final custom fallback) — plain `getIconName(array)` exhausts deep fallbacks per name. Icon resolution NEVER mixes themes: per-app override (`~/.local/share/icons/nidara/`) → active theme (+ its `Inherits`) → hicolor (the app's own installed icon) → pixmaps. An icon the active theme lacks is fixed via the Settings → Apps per-app override, never by borrowing from another installed theme. When nothing resolves, app surfaces (dock, app grid, Prism, overview) fall back to `application-x-executable` (the active theme's generic app icon) — never GTK's broken-image `image-missing`. **Per-app override GOTCHA:** overrides are stored under the basename key (`iconOverlayKey`, e.g. `/opt/foo/bar.png` → `bar`), and `AppData.icon` is **canonicalized to the resolved override PATH** once one exists — so callers usually hold a *path*, not a name. Any override lookup (`getIconOverridePath`/`removeIconOverride`) must normalize through `iconOverlayKey` (idempotent on keys), or Restore/badge/delete silently no-op on path-valued icons (bit App Icons for Antigravity, fixed 2026-07-04). After `set/removeIconOverride` (which call `reload()` **synchronously**) re-read fresh state via `getAppData(id)` — the caller's own `AppData` is a stale snapshot whose `.icon` may point at a just-deleted overlay file. |
| `TrashService.ts` | ~125 | Watches the trash (gvfs `trash:///` + `trash::item-count`, aggregates all volumes; falls back to a FileMonitor on `~/.local/share/Trash/files`). Exposes `isEmpty`/`itemCount` + `subscribe`. Drives the dock trash icon (full ↔ empty, swapped in place by DockItem). |
| `ThemeManager.ts` | 534 | GTK/icon/cursor theme, dark mode, CSS providers (main/font/tokens/tint), hot-reload of `style.css` in dev. Also pushes the accent into Hyprland's **groupbar** active-tab color (`syncHyprlandGroupAccent`, at boot + on accent change, via `hs.evalLua`) — the one place accent enters compositor chrome; the rest of the group styling is static in `hyprland.lua`'s `group` block (glass borders like windows). Gotcha: a groupbar **bakes its colors at group creation** — config changes only affect groups made afterwards. **Font gotcha:** the interface font is the one appearance prop NOT in `appearance.json` — it's delegated to the GNOME `font-name` gsetting (`syncFont`/`setFont`/`settings.ini` all read it). `applyAll` **seeds it to `Inter 11` on first boot**, but only when `get_user_value("font-name") === null` (factory default, not an explicit pick) — otherwise a fresh Arch + GTK ≥4.22 leaves it at `Adwaita Sans 11`. `monospace-font-name` is seeded the same way to `JetBrainsMono Nerd Font 11` (the schema default names Adwaita Mono, a font Nidara doesn't install; the JetBrains nerd font ships with every install). |
| `NidaraTheme.ts` | 436 | Token engine: `generateTokensCss()` emits `@define-color` + `--nidara-*` for accent, transparency, materials, shadows, tint. Holds the canonical `ACCENT_PALETTE`. Syncs Kvantum/qt. |
| `RegionConfig.ts` | 218 | Time/date format, timezone (`region.json`). |
| `InputConfig.ts` | 194 | Keyboard/mouse/touchpad → writes `nidara-settings.lua`. |
| `HyprlandState.ts` | ~290 | Reactive wrapper over AstalHyprland (clients/workspaces/monitors + dispatch helpers) **and the ONLY door to hyprctl**. `focusedClient` is a **reconciled** accessor, not a proxy — it enforces one invariant, *the focused window is always on the focused workspace*, against two opposite compositor lies: the null Hyprland announces when one of our layer surfaces releases an EXCLUSIVE grab, and the stale non-null it keeps returning while a grab is HELD (it refuses to move window focus at all then, so the app grid's workspace strip left the title naming the workspace you left). Fallback chain and the scratchpad exception in `state-and-ipc.md`; read it, never `hl.focused_client` — services/widgets never shell out to hyprctl directly; they call (or add) a method here. Vocabulary: dispatch helpers (`focusWindow`/`closeWindow`/`floatWindow`/`togglePseudo`/`togglePin`/`toggleFullscreen`/`centerWindow`/`sendToWorkspace`/`toggleGroup`/…, all `hl.dsp.*` Lua via a private `_dispatch` that logs the offending call), `getClientJson(addr)` (one-shot raw `clients -j` read for fields AstalHyprland.Client lacks: `pinned`, `grouped` — on demand only, never in `_refresh`), `evalLua(call)` (live config changes — the Lua parser rejects `keyword`), `getOptionInt(name)` (sync) / `getOptionJson(name)` (async batch re-syncs), `setCursor(theme, size)`, `setRealCursorVisible(visible)` (`cursor:invisible`; rendering only, input unaffected — sole caller is the agent-pointer overlay, which hides the real pointer for the length of an AI action because the hardware cursor plane paints above every layer surface; **whoever hides it owns restoring it on every exit path**), `setGlow(enabled)` + `supportsGlow()` (`decoration:glow`, driven only by `AgentGlow.ts`), `version()`. **`focusWorkspaceOnGrabRelease(id)` is not a variant of `focusWorkspace` you may skip**: a surface that switches workspace *while closing* must use it, or the grab release it just triggered refocuses the last window and drags the workspace back (`state-and-ipc.md` — measured; ordering the calls differently does NOT fix it). Caches **effective** config AstalHyprland doesn't expose (`availableModesByName` — `Monitor.available_modes` is always null) and emits `config-reloaded` on Hyprland's `configreloaded` IPC event (effective-config consumers re-sync on it). Exempt from the single-door rule: config text *written for other daemons* (the hypridle config generated by Power.tsx — those lines execute outside the shell; the before/after-sleep hooks themselves are static scripts in `bin/`). |
| `NightLightManager.ts` | 174 | Blue-light filter via hyprsunset (`night-light.json`). |
| `WallpaperManager.ts` | 127 | Wallpaper + transitions via `awww` (`wallpaper`). Reads/merge-writes the JSON through `ui/lib/wallpaper.ts` (shared with the lockscreen, which paints its own copy — the schema reserves a per-surface `surfaces` block; see tech-debt "Wallpaper resolution is centralized"). |
| `MonitorConfig.ts` | ~120 | Per-monitor mode/scale/rotation + VRR → `nidara-monitor.lua`. Applies at runtime via **`hyprctl eval "hl.monitor({...})"`** (see the Lua-parser note below). `applyMode`/`applyTransform` apply without persisting; `commit()` writes the .lua — used for the revert-safety dialog on resolution/rotation changes. |
| `Icons.ts` | 92 | `nd-*-symbolic` icon catalog. |
| `WidgetConfig.ts` | 88 | CC widget metadata/registry (`widgets.json`). |
| `GamingManager.ts` | 79 | Game-mode state + `gaming.json`. |
| `NotifConfig.ts` | 60 | Notification DND default. |
| `RecordingConfig.ts` | ~250 | Screen-recording preferences (`recording.json`) **and the wf-recorder command they build** — `buildCaptureCommand({region, audio})` returns `{argv, outFile, audioDevice}` so the widget owns only screen-or-region and audio-on-or-off. Everything here was measured against wf-recorder 0.6.0, not assumed, because each one silently produces a plausible file instead of an error: **(1)** `--audio` with no device records the default PulseAudio **source** — a microphone, never the desktop — which is why `audioSource` exists and defaults to the `@system` sentinel (resolved at capture time to `<default sink>.monitor`). This was the "recording has no sound" bug: on a machine whose default source was a webcam's unconnected S/PDIF port, "include audio" meant "record silence". **(2)** The long option's argument is *optional* (getopt), so it only binds as `--audio=NAME`; `["--audio", name]` as two argv entries drops the device and falls back to the default source. **(3)** An unknown device name does **not** fail — pipewire-pulse substitutes the default source — so `resolveAudioDevice()` verifies a saved name is still on the bus before using it. **(4)** VAAPI encodes H.264 fine, but `vp9_vaapi` returns "Function not implemented" on Navi 10, so hardware encoding is offered for the H.264 containers only (`CODECS` table; webm is always software VP9). Quality presets are spelled out per encoder (x264/VP9 take `crf`, VAAPI takes `qp` — same polarity, different scales), and libvpx-vp9 needs `b=0` alongside `crf` or it ignores the crf entirely. Surfaced in Settings via `widgets/screenrecord.ts` `buildSettings`, and to agents as `recording.*` in `config-entries.ts`. |
| `MediaService.ts` | ~230 | **Facade with selection state** over the reactive `AstalMpris` singleton: owns WHICH MPRIS player the shell shows (widgets must never call `get_players()[0]`). Auto heuristic — a PLAYING player beats paused ones, ties go to the most recent playback-status change; manual pin `pinPlayer(busName\|null)` (session-scoped, auto-resumes when the pinned player leaves the bus); `subscribe(cb)` fires on selection change AND async cover-art arrival; `playerLabel`/`playerAppIcon` (desktop-entry GIcon for the selector menu); `resolveCoverArt` — art chain `cover_art` → `file://` → `data:` decode → `http(s)` curl into `~/.cache/nidara/media-art/` (pruned past ~150 files, failures negative-cached so a dead URL isn't retried at the 1 Hz position poll). Consumed by `widgets/media.ts` (the shared detail panel incl. the source-selector glass menu — exported as `buildMediaDetailPanel`, also the content of the island's player mode. **No bar variant since 2026-08-02**: the island already carries the player as an activity the moment an MPRIS player is live, so a bar pill with its own transport buttons stated the same service twice, one capsule apart — `locations: ["cc"]`, `buildBarContent`/`buildBarExpanded` deleted. A widget losing its bar variant leaves a `"bar": true` behind in every existing `widgets.json`, which is why `WidgetConfig.barWidgetIds()` now intersects with `BAR_ORDER` instead of appending unknown ids: a stale flag used to consume one of the bar's limited icon slots before the render loop skipped it for having no `buildBarContent`), `MediaIsland.tsx` (CC tile — ONE shared `MediaState` singleton across tile rebuilds) and `surfaces/island/` (`PlayerCompact` + the `ActivityIsland` activity controller; note `subscribe()` fires on SELECTION change, not on a playback-status flip of the same player — anyone tracking play/pause must also connect `notify::playback-status` on the current player, as all three consumers do). Test with `scripts/dev/fake-mpris.js` (dev-workflow.md). Never imports Gtk. |
| `AudioService.ts` | ~120 | **Stateless facade** over the reactive `AstalWp` singleton (PipeWire/WirePlumber). `volumeIcon`/`targetVolumeIcon` (the volume-level icon ladder that used to live in FOUR copies), `streamIconName` (per-app stream icon), `setDefault` (`wpctl set-default`), `toggleMute`, endpoint/stream/default accessors, and `watchDevices`/`watchStreams`/`watchVolume`. Consumed by Settings → Audio + the CC volume tile/detail (`Sliders.tsx`, `widgets/volume.ts`) + the bar volume widget. Returns Gio icons via `core/Icons` (core→core); the volume *slider widget* is `makeVolumeSlider` in `common/Slider.ts` (UI layer). Never imports Gtk. |
| `BluetoothService.ts` | ~330 | **Stateless facade** over the reactive `AstalBluetooth` singleton (same pattern as NetworkService): power (`isPowered`/`setPowered`/`togglePower`), device categorisation (`pairedDevices`/`nearbyDevices`/`deviceName`), guarded command wrappers (`connectDevice`/`disconnectDevice`/`pairDevice`/`removeDevice`/`startDiscovery`/`stopDiscovery`), and `watchPower`/`watchDevices` notify helpers. `watchDevices` also wires each device's own `notify::paired/connected/name` (re-wiring on set change) — `notify::devices` alone misses in-place pairing/connection changes. Also owns the **BlueZ pairing agent** (`org.bluez.Agent1`, capability `KeyboardDisplay`, raw Gio D-Bus on the SYSTEM bus — AstalBluetooth has no agent support): `registerPairingAgent(handler)`/`unregisterPairingAgent()`; the Settings → Bluetooth page supplies the dialog handler (`PairingPrompt` kinds: `confirm`/`display`/`enter-passkey`/`enter-pin`/`authorize`), so core stays UI-free. The agent registers when the page is built (first Settings open; effectively session-lifetime since Settings hides rather than closes). `pairDevice` sets `trusted=true` on successful pairing so reconnections skip authorization; `RequestAuthorization`/`AuthorizeService` auto-accept trusted/paired devices. **Testing gotcha:** D-Bus policy only lets root call `Agent1` methods, so exercise dialogs with `sudo busctl --system call <shell-unique-bus-name> /org/nidara/bluetooth/agent org.bluez.Agent1 RequestConfirmation ou /org/bluez/hci0/dev_00_11_22_33_44_55 123456` (find the bus name by matching the gjs PID in `busctl --system list`; the python-dbusmock bluez5 template never calls back into agents). Consumed by Settings → Bluetooth (full management: scan/pair/forget) + the bar/CC bt tile, whose
CC detail panel (`widgets/bluetooth.ts`, split-target capsule — see design-system.md) drives a
compact paired-device connect/disconnect list with the same `pairedDevices`/`connectDevice`/
`disconnectDevice`. **Gotcha:** `setPowered` drives `adapter.powered`, NOT the read-only `is_powered`. Never imports Gtk. |
| `NetworkService.ts` | ~190 | **Stateless facade** (a plain function module, *not* a GObject — AstalNetwork is already a reactive singleton) for all network domain logic: nmcli command vocabulary (`connectAp`/`disconnectIface`/`forgetProfile`/`rescan`/`setWifiEnabled`/`toggleWifi`/`listSavedWifiSsids`/VPN), NM-flag + frequency derivations (`isSecured`/`securityLabel`/`freqBand`/`freqChannel`), `getIp`/`wiredConnected`/`wifiEnabled`, and `watchWifi`/`watchWired` notify-subscription helpers. Consumed by Settings → Network, the CC wifi/ethernet tiles (`Toggles.tsx`), and the bar widgets (`widgets/wifi.ts`, `widgets/ethernet.ts`) — they used to each re-derive `getIp` and toggle WiFi three different ways. Never imports Gtk. |
| `PowerManager.ts` | 43 | hypridle hooks (screen-off/lock/suspend). |
| `ShellActions.ts` | 21 | Typed action registry populated by `app.ts main()`; consumed by Dock/Bar/AppGrid (replaces `globalThis`). |
| `AgentConfig.ts` | ~120 | Governance of the agent-facing surface (`ai.json`): `allowConfigWrite` gates `setConfig` writes; `allowScreenshot` gates the `screenshot` IPC; `allowComputerUse` gates third-party perception (`query_app`/`nidara-a11y`); `allowComputerControl` gates third-party action — AT-SPI `do_action` (`do_app_action`/`nidara-act`), synthetic keyboard (`type_text`/`press_key`/`nidara-type`, focus-verified), synthetic pointer — left/right click + hover + scroll + drag (`click_app`/`click_at`/`hover_app`/`hover_at`/`scroll_app`/`scroll_at`/`drag_app`/`drag_at`/`nidara-click`+`nidara-input`) — and window focus (`focus_window`/`focusWindow`) — and **requires perception** (enabling it implies `allowComputerUse`). The two computer-use gates **default OFF** (they reach outside the shell; enabling either flips on `toolkit-accessibility`, otherwise the a11y tree is empty). Separate toggles — each capability is sensitive on its own. Toggled from Settings → AI. It is a **consent layer over the official door, not a security boundary** (any local process can still edit config files / drive the a11y bus directly) — keep that framing in docs/UI copy. Reading the shell's *own* state is never gated (doctor/diagnostics depend on it). Also holds the **built-in Assistant's brain config** (`brainBackend`/`brainModel`/`brainEndpoint` in `ai.json`) — NOT a gate, just which BYOK LLM `bin/nidara-agent` talks to; the API **key is never in `ai.json`** (DE keyring, see below). |
| `AgentService.ts` | ~180 | Facade over `bin/nidara-agent` (the Assistant's brain). Owns the daemon subprocess (spawned LAZILY on first `send`, resolved PATH-first then the dev checkout's `bin/` via `SHELL_ROOT`; respawned on death), parses its JSON-lines events into a `transcript` (`{role,text,tools[]}`) + `busy`/`state`/`usage`/`lastError`; API `send`/`cancel`/`reset` + `subscribe`. Drives visibility only through `Status` (expand-on-finish: opens `ISLAND_AGENT` when a background turn ends on an otherwise-idle desktop). Consumed by `surfaces/island/AgentIsland.tsx` (the chat UI) and the `agent` island activity. Never imports Gtk. See `state-and-ipc.md`. |
| `AgentGlow.ts` | ~70 | The "the Assistant is working in THIS window" signal — the one piece of agent feedback painted outside our own pixels, because the thing it points at is a third-party window. Subscribes to `AgentService` and flips **only** `decoration:glow:enabled` (`hs.setGlow`) while `busy`; the look (range, violet→cyan gradient, and the **transparent `color_inactive` that limits the glow to the FOCUSED window** — the glow has no window rule, and `color_inactive` defaults to `color`, so leaving it out makes every window glow) is static in `hyprland.lua`. Deduped, because `AgentService` notifies on every streamed token. Gated by `ai.assistantGlow` (Settings → AI) and by `hs.supportsGlow()` (Hyprland ≥ 0.56 — `getoption` answers an unknown option with the bare string `no such option`, so the JSON parse failing IS the probe). Forces the glow **off** at boot: a shell that died mid-turn left it on in the live config and nothing else would ever clear it. Re-asserts on `config-reloaded` (a reload re-reads `enabled = false` and would silently drop the signal mid-turn). **No focus guard on purpose** — every daemon tool acts on the focused window and refuses otherwise, so whatever is focused IS what the next action touches. **The sweep is not configured here and cannot be:** the `glowangle` animation is armed **at window creation**, so it lives permanently enabled in `hyprland.lua` (measured free while the glow is off; arming it live leaves already-open windows unable to ever sweep). Never `style = "loop"` — see the `hyprland.lua` comment. |
| `ConfigRegistry.ts` | ~120 | Typed registry of agent-readable/-writable settings — the data half of `describeConfig`/`getConfig`/`setConfig` (see `state-and-ipc.md`). Same pattern as ShellActions: core defines the registry; **entries are registered from `config-entries.ts`** (app level, NOT core) because dock settings live in `surfaces/dock/state.ts` and core must never import widget code. Each entry is self-describing (desc/type/enum/min/max) and delegates `set` to the owning service, so validation/persistence/notify behave exactly as if Settings had been used. NB: result types use optional fields, not discriminated unions — tsconfig has `strict:false`, under which tsc doesn't narrow `r.ok ? r.value : r.error`. |
| `UITree.ts` | ~160 | Serializer behind the `queryUI` IPC command (see `state-and-ipc.md`): walks every **mapped** toplevel and returns a flat list of on-screen widgets carrying signal (test-id / CSS class / visible text / interactive GType) + ancestor `path` + `bounds`, for read-only UI **assertions** (screenshot → programmatic check). Redacts password/masked entry text. Read-only/ungated like dumpState. Tier 1 = structure+text; the node model is source-agnostic — `bin/nidara-a11y` now fills the **same shape** for third-party apps via AT-SPI2 (the computer-use layer's `query_app`; see `state-and-ipc.md`). |

### Gotcha: changing Hyprland config at runtime → `hyprctl eval`, not `keyword`

This shell configures Hyprland through the **Lua parser** (`config/hypr/hyprland.lua`, `hl.*`).
Under it, **`hyprctl keyword …` is rejected** (`"can't work with non-legacy parsers. Use eval."`).
To change config live, use **`hyprctl eval "hl.<call>(...)"`** — e.g.
`hl.monitor({...})`, `hl.config({ general = { layout = '…' } })`, `hl.config({ misc = { vrr = 1 } })`.
`hyprctl getoption …` still works. **`hyprctl dispatch` only takes Lua expressions** —
the argument is wrapped as `hl.dispatch(<arg>)`, so legacy dispatcher strings are Lua
syntax errors: `hyprctl dispatch dpms on` ✗ → `hyprctl dispatch 'hl.dsp.dpms({ action = "enable" })'` ✓
(actions `enable`/`disable`/`toggle`), `hyprctl dispatch exit` ✗ → `'hl.dsp.exit()'` ✓.
**LUA DISPATCHERS IGNORE UNKNOWN FIELDS SILENTLY, AND THEN RUN WITH DEFAULTS.** Only a
Lua *syntax* error comes back as an error; a misspelt or guessed key inside a valid
table is accepted and the dispatcher executes anyway. This has bitten twice, both times
on the user's live session: `cycle_next({ prev = … })` — there is no `prev`, the field
is `next = false` — ran with defaults and cycled the user's focus (2026-07-02); and the
window-selector case below.
**For a selector, "ignored" means IT FALLS BACK TO THE ACTIVE WINDOW.** The dispatcher
finds no selector and acts **on whatever is focused**, so a dispatch that names window A
fires on window B, with `ok` as the only feedback.
`hl.dsp.window.close({ address = "0x…" })` — wrong key — tried to close the **focused
terminal**, and was stopped only by that terminal's own close confirmation (2026-07-27,
hit for real while cleaning up after a live test; the user saw the dialog). Measured
afterwards on two throwaway windows: `float({ action = 'toggle', address = "<inactive
window>" })` left the named window alone and floated the **active** one.
The selector key is `window`, and its value carries the `address:` prefix:
`hl.dsp.window.close({ window = 'address:0x…' })`. **`HyprlandState._winSel()` is the
canonical spelling — copy it, never retype it**, and never read `ok` as "it happened":
verify the effect on the window you meant.
Never guess a field name. The authority is
`src/config/lua/bindings/LuaBindingsDispatchers.cpp` at the exact tag (`hyprctl version`).
For dispatchers with REQUIRED args there is a probe that constructs without dispatching —
`hyprctl eval "return (function() local ok, err = pcall(function() return <expr> end);
return ok and 'OK' or tostring(err) end)()"` — but note its limit, which is exactly the
hole both incidents fell through: an unknown key on an OPTIONAL arg constructs fine, so
the probe answers `OK` for a call that will still fire on the wrong window.
This is not cosmetic: legacy dpms strings in `hypridle.conf` failed silently for months and
left the screen unrecoverable-black after wake-from-suspend (2026-06-10 incident — the
after-sleep hook is the ONLY thing that re-enables displays, so treat its syntax as critical
and never "verify" dpms commands by running them live). Two safety rules from the
second 2026-06-10 incident (screen dark, input wouldn't wake it): **(1)** `misc` sets
`mouse_move_enables_dpms`/`key_press_enables_dpms = true` so the compositor itself wakes
the screen on input — hypridle's `on-resume` is NOT reliable (its idle tracking resets on
daemon restart/inhibitor churn and then never fires). **(2)** hypridle has exactly ONE
owner: the session exec line (`uwsm app -s b -- hypridle`). Never start/restart it via
`systemctl --user … hypridle` — the package ships a user unit, and using it spawns a second
instance that fights over `org.freedesktop.ScreenSaver` and silently drops app idle
inhibitors (videos no longer keep the screen on). The Settings Power page restarts it with
stop-unit + pkill + wait-until-dead + uwsm relaunch. A full audit (2026-06-08)
migrated every remaining `keyword` caller — they were all silently broken on the Lua parser:
- `InputConfig` live-apply → `hl.config({ input = { … } })` (incl. nested `touchpad`, and
  `kb_layout`/`kb_variant`). The whole Input page was a no-op live until this.
- `AboutWindow` float/center → a static `hl.window_rule` in `hyprland.lua` (matched by the
  "About Nidara" title; the `windowrulev2` keyword calls were removed).
- greeter `LocaleBar` kb_layout → eval (the greeter runs its OWN Lua config,
  `config/greetd/hyprland-greeter.lua`, so it's the same parser).
- `app.ts` bar-blur layerrules → **deleted** (dead duplicates of the `hl.layer_rule`
  already in `hyprland.lua`).
Only `dispatch`/`getoption`/`monitors`/`eval` callers remain (all valid). Also: a fractional
monitor scale must divide the native resolution into whole logical pixels or Hyprland snaps
it — the Display page filters scale presets to exact-valid per monitor.

The same sweep applies to **dispatch strings**: classic dispatcher syntax is forbidden
everywhere, `hl.dsp.*` Lua only. Four HyprlandState methods (`sendToWorkspace`,
`floatWindow`, `toggleGroup`, `sendToSpecial`) shipped with classic strings and were
silently broken (the `.catch` swallowed the Lua error) until 2026-06-11. The
`{ window = 'address:0x..' }` selector is verified on `window.float/pin/move/close`.
The full dispatcher surface is documented in `/usr/share/hypr/stubs/hl.meta.lua`
(`hl.dsp.window.*`, `hl.dsp.group.*`, `hl.dsp.workspace.*`) — check it before assuming a
dispatcher doesn't exist. The stubs type args as `fun(...)`; when the exact table shape
matters, the binary's error strings are authoritative (`strings /usr/bin/Hyprland | grep
'expected a table'`). Group vocabulary verified live 2026-06-11: `hl.dsp.group.toggle()`
takes the window selector; `hl.dsp.group.active({ index, window })` (1-based) switches
tabs (so does plain focus on a member address); `hl.dsp.window.move` accepts `out_of_group
= true` + selector, and `into_group = '<dir>'` but **selector-less** (focused window
only). Group membership/order reads from `grouped` in `clients -j`; group-lock state is
not readable anywhere. Gotcha: pseudo-tile **state** is not readable anywhere
(no `pseudo` field in `hyprctl clients -j` nor `HL.Window`) — `togglePseudo` is fire-only.
Bigger gotcha: **`AstalHyprland.Client` window-state props go stale** — `floating` can
read true on a tiled window (observed live 2026-06-11: wrong menu checks, float-all
skipping windows), and `pinned`/`grouped` aren't exposed at all. Authoritative window
state = `hs.getClientJson(addr)` / `hs.getClientsJson()` (one-shot `hyprctl clients -j`,
on demand only — never in the `_refresh` hot path). Never build UI checks or filter bulk
window ops from Astal Client props.

**Since 2026-06-10 all of this goes through `HyprlandState`** (single-door sweep): use
`hs.evalLua(...)` / `hs.getOptionJson(...)` / `hs.setCursor(...)` / `hs.version()` instead of
shelling out to hyprctl — add a method to HyprlandState if the vocabulary is missing. The
shell itself (greeter excluded — separate bundle, own Lua config) has zero direct hyprctl
calls outside HyprlandState.

## `ui/lib/nidara-kit/`

Pure-GTK4 primitives + Nidara tokens, **no Adwaita, no resets**. Consumed only by the shell's Settings pages today:

- `NidaraSplitView` — replaces `Adw.OverlaySplitView` + `Breakpoint`
- `NidaraClamp` — replaces `Adw.Clamp`
- `NidaraButton` — suggested/destructive/pill variants
- `NidaraDropDown` — the native `Gtk.DropDown` with our scroll bar swapped into its popup list. The native widget is deliberate: its popover is a real Wayland surface, so Hyprland's popup blur frosts it, which an in-window overlay list cannot get. (`NidaraSelect`, the overlay version, and its `NidaraOverlayManager` were deleted 2026-08-03 — consumer-less since Settings moved here.)
- `NidaraSidebar` — single-select nav list; items take an optional `groupStart` to draw a thin **title-less divider** before them (thematic clusters, no group labels). The Settings sidebar uses this for its 3 clusters (connectivity · look/shell/behaviour · system & devices).
- `showNidaraAlert` — replaces `Adw.AlertDialog`; optional `entry` (single-line input, `digitsOnly`/`maxLength`, text reaches `onResponse` as 2nd arg, Enter fires the suggested response) and returns an `AlertHandle` whose `close(id?)` responds programmatically (used by the BlueZ pairing agent to honor `Cancel()`)

### Settings information architecture

The Settings sidebar (`Settings.tsx` `categories[]`) is **ordered into 3 unlabelled clusters** via `NidaraSidebar`'s `groupStart` dividers; the array order *is* the IA, so reorder there. The window opens on **Appearance** by default (not the first item). The **AI page** (`pages/Ai.tsx`, third cluster) governs the agent surface — its rule: every row must gate or report something REAL (no placeholder toggles); it grows with the AI-native roadmap (assistant model picker…). Its IA (2026-07) is four groups, one concept each: **Desktop Access** (shell-scoped capabilities, default on) · **Other Apps** (computer-use perception/control, escalating, default off) · **MCP Server** (the CHANNEL: enable toggle + `.mcp.json` connect row — a transport, not a permission; capability toggles gate `ags request` and MCP alike) · **Agent Interface** (read-only facts). Don't fold the MCP toggle back among the capability toggles. Pages that contain sub-screens use the **parent-page + `pushSubpage` pattern**: e.g. **Apps** is a landing (`pages/Apps.tsx`) with three navigable rows that push **Default Apps** (`pages/DefaultApps.tsx`), **App Icons** (`pages/AppIcons.tsx`) and **Autostart** (`pages/Autostart.tsx` — moved off the sidebar 2026-07; Windows Apps→Startup prior art). Subpages can nest: Autostart pushes its own installed-apps picker (`apps/autostart/add`), like App Icons' per-app detail (`apps/icons/{id}`). Caveat: subpage rows aren't in the search index (subpages build lazily), so a parent's landing rows should carry searchable labels.

**Page lifetime — the trap.** Category pages are built ONCE into `pageCache` and swapped by
`remove()` + `append()`, so navigating away **unrealizes a page without destroying it** and coming
back re-realizes the same widget. `unrealize` here means *"taken out for a moment"*, not *"being
destroyed"*: anything the page needs in order to stay CURRENT — service watches, signal handlers,
GLib timers — must go through **`bindWhileRealized(widget, subscribe)`** (`SettingsHelpers.ts`),
which re-subscribes on every realize and disposes on every unrealize. Do the initial refresh inside
`subscribe` too, so a page you return to re-reads the world. A bare `connect("unrealize", dispose)`
silently freezes the page after the user's first departure (that was tech-debt #12b: frozen device
lists, a dead pairing agent, a stopped clock preview). Subpages are exempt — `pushSubpage` rebuilds
them on every push.

Naming note (2026-07): the page with id `widgets` (`pages/Widgets.tsx`) is titled **"Control
Center"** in the UI and its copy says "controls", since it manages bar + CC
placement in a single Settings page. `AtomicWidget`, the `widgets/` dir
and all ids/keys keep the internal name; only user-facing strings changed.

This is the right place for new shared, Adwaita-free primitives.

## Game mode

- **`hyprland.lua` (compositor side):** on `window.open`, detects Steam windows (`class = steam_app_<id>` or by reading `SteamAppId` from `/proc/<pid>/environ`, walking parent PIDs). Moves them to the special `gamespace` workspace (no blur/anim/shadow, `immediate`, `opaque`, `idle_inhibit`). Optionally swaps wallpaper to Steam library hero-art (`awww`) and sets power profile to `performance`. On last-game close: returns to previous workspace, restores wallpaper + `balanced`.
- **`nidara-game-mode` script (`Super+Shift+G`)** + **`GamingManager.ts` + Settings → Gaming (`gaming.json`):** `wallpaperMode` (artwork/custom/none), transition, `performanceProfile`.
- **`Super+B` → `toggleBarOverlay`** (alias `toggleGameOverlay`): promotes **only the Bar** to OVERLAY layer over any fullscreen window (requires an active fullscreen window to activate; deactivation always allowed). Not game-specific — it lives here because games are the main fullscreen use case.

# Nidara — Architecture

Read this when adding/editing widgets, changing how overlays attach, modifying any `core/` service, or trying to understand how the shell actually boots.

## Tech stack at a glance

| Layer | Tech |
|---|---|
| Language | TypeScript (files carry a `.tsx` extension; see the JSX note below) → compiled to GJS |
| UI framework | none — GTK4 directly. The application host is `ui/lib/host.ts` and the bundler is `scripts/bundle.sh`; **nothing of AGS is left** (see below) |
| Toolkit | GTK4 (pure — libadwaita fully removed) |
| Wayland surfaces | gtk4-layer-shell (layer-shell protocol), `Gtk4SessionLock` (ext-session-lock-v1) |
| Raw Wayland from GJS | **`lib/nidara-wl/`** — the project's own C+GIR shim (see below) |
| Compositor | Hyprland ≥ 0.55 (config in **Lua**) |
| Session manager | **uwsm** (manages the session as systemd units/scopes) |
| Display manager | greetd (default; only installed if no other DM is enabled) |
| Astal system services | **None — 100% eliminated.** All services (Network, Battery, Bluetooth, Hyprland, MPRIS, Apps, WirePlumber, Notifd, Tray, Greet) are native TypeScript, and PAM authentication is native C (`lib/nidara-auth/`, `gi://NidaraAuth`). ⚠️ **Before writing anything that talks to `NidaraAuthPam`, read the conversation contract in `lib/nidara-auth/nidara-auth.h`.** PAM messages come in two kinds and are answered differently — PROMPTS block and must get exactly one `supply_secret()`, MESSAGES (`auth-info`/`auth-error`) must get NONE. That is **not** AstalAuth's contract, which required answering all four, and porting its consumer across unchanged is how #200 shipped a lockscreen that answered the next password prompt with an empty string (fixed 2026-08-23; `scripts/dev/auth-probe.js` fails without the fix). Two more signals qualify the verdict — `password-expired` before `success`, `account-denied` before `fail` — and a consumer that ignores the second tells the user "wrong password" for a denial no password can fix, sending them to retry until `pam_faillock` locks them out for real. |
| Styling | SCSS → `style.css` |
| Build | `scripts/bundle.sh` (esbuild) → standalone binary |
| Wallpaper | `awww` (swww fork) |
| Idle / night light | hypridle, hyprsunset |
| Qt look | Kvantum + qt5ct/qt6ct (synced from the theme engine) |

`@girs/` (≈58 MB of auto-generated GI typings) is **git-ignored**; it only powers local typecheck and editor IntelliSense.

### ⚠️ There is no JSX in this repo, and the `.tsx` extension is a fossil

Measured 2026-08-17 across all three bundles: **zero JSX elements**. Every widget is built
imperatively (`new Gtk.Box({…})`, `.append()`, `set_child()`), and Gnim's reactivity
(`createState`/`Accessor`/`createBinding`) appears **only** in the `.d.ts` shims — no runtime use.
State is ours (`core/Status.ts` + the `core/` facades). The 53 `.tsx` files are `.tsx` by
extension only; renaming them was judged churn, so the extension stays and this note explains it.

What that means when you write code here: **do not introduce JSX** (nothing wires a pragma any
more — `jsxFactory` pointed at an `astal` import that was itself dead and was removed), and do not
reach for AGS's widget helpers or reactive primitives — match the imperative code around you.

### The application host is OURS (2026-08-18)

AGS was a thinner dependency than it looked, and at runtime it is now gone. What the shell used to
consume was ~810 lines across four imports, and all four have in-repo replacements:

| was | is | size |
|---|---|---|
| `ags/gtk4` (125 imports) | `gi://Gtk?version=4.0` / `gi://Gdk?version=4.0`, directly | — |
| `ags/gtk4/app` | **`ui/lib/host.ts`** — a `Gtk.Application` subclass with `start`/`apply_css`/`reset_css`/`quit` | ~170 |
| `ags/process` | `ui/lib/process.ts` — `exec` + `execAsync`, the only two ever imported | ~65 |
| `ags/file` | `ui/lib/file.ts` — `readFile` + `writeFile`, likewise | ~50 |

`Astal` was imported in four files and **used in none**; those imports went with the barrel.

**Read `ui/lib/host.ts`'s header before changing anything about startup.** Three things it does are
load-bearing and each fails silently if lost: `Gtk.init()` at MODULE scope (import declarations run
before any statement, so a widget built during another module's import needs GTK up already);
`GLib.unsetenv("LD_PRELOAD")` (the bundle's launcher sets `libgtk4-layer-shell.so`, and without this
every app the dock launches inherits it); and `hold()` (the app grid and the agent pointer are never
mapped, so window count is not a liveness signal).

Two things came back with it:

- **`Adw.init()` is gone.** AGS called it whenever libadwaita existed on the system, with no opt-out
  — which is why `core/ThemeManager` routed dark/light through `AdwStyleManager`. Verified on the
  live shell: the `Adwaita-WARNING … gtk-application-prefer-dark-theme … is unsupported` line that
  appeared at every boot no longer does.
- **The app-id is ours**, and with it the seventh commandment (see below).

### The toolchain is ours too (2026-08-18, same day)

Nothing of AGS is installed any more. What the CLI actually was, and what replaced it:

| was | is | notes |
|---|---|---|
| `ags bundle app.ts out` | `scripts/bundle.sh app.ts out` | esbuild + a bash wrapper carrying the JS |
| `ags run app.ts` | `scripts/run.sh app.ts` | bundles to `$XDG_RUNTIME_DIR`, execs `gjs` |
| `ags types -d .` | `scripts/gen-types.sh` | `npx @ts-for-gir/cli generate '*'` — literally what it wrapped |
| `ags request <cmd>` | `nidara-ipc <cmd>` | gone since #185; the bus name lives on as a compat door |

`bundle.sh` does not *approximate* `ags bundle` — it transcribes its options out of AGS v3.1.2
(`cli/lib/esbuild.go`, `cli/cmd/bundle.go`) and the transcription was checked the only way that
means anything: **all three bundles come out byte-identical to AGS's output.** Two flags are
load-bearing in a way that would not be obvious from reading them:

- **`--tsconfig=…`** — through `target: ES2020` it sets `useDefineForClassFields: false`, so a class
  field lowers to a constructor ASSIGNMENT. With define-semantics (the modern default) a class field
  on a GObject subclass would shadow the GObject property accessor — silently, at runtime.
- **`--target=es2022,firefox115`** — GJS is SpiderMonkey. This is why private fields and static
  blocks survive untouched while `\p{…}` regexes get rewritten.

⚠️ And the piece that bites hardest: **the wrapper sets
`LD_PRELOAD=/usr/lib/libgtk4-layer-shell.so`** around the base64'd JS (`scripts/run.sh` sets it for
the dev loop). That is where the preload comes from — not `bin/nidara-ui`. A bundler that only emits
JS produces a shell with no bar and no dock, and nothing in the log about why.

The system `esbuild` package (Arch `extra`) is now a build dependency: `PACMAN_DEPS` in
`install.sh`, `makedepends` in `packaging/nidara/PKGBUILD`, and the smoke's pacman list. `go` left
`PACMAN_DEPS` at the same time — building AGS's Go CLI was the only thing that needed it.

### Identity: one window, one app-id (the seventh commandment, retired)

`AstalIO.Daemon` used to OVERWRITE the `applicationId` passed to `app.start()` with
`io.Astal.<instance>`, and GTK4 hands the GApplication id to the compositor as the Wayland app-id.
That is the whole reason Hyprland filed the Settings window as `io.Astal.ags`, no icon theme had art
for that name, and `AppService.resolveWindowApp` carried a remap every surface had to remember.

Measured 2026-08-18, three ways, because the answer decides the design: with an `application-id` set,
GTK hands the compositor **exactly that** and IGNORES `prgname`; with no id it falls back to
`prgname` (which GJS leaves as `"gjs"`). And a **per-toplevel override wins over both**.

So: the process is `org.nidara.desktop`, and the shell's own regular windows — Settings, About and
Settings' three modal dialogs — declare **`nidara-settings`** for themselves via
`setWindowAppId()` in **`ui/lib/app-id.ts`** (`NidaraWindow` takes an `appId` option). That name is a
real entry in the desktop registry (`config/applications/nidara-settings.desktop`), so identity
resolution is a plain lookup and **the remap is deleted, not renamed**. About shares the class on
purpose: it has no desktop entry, and under the old remap it already resolved to Settings' icon.

⚠️ Two traps in `app-id.ts`, both silent, both measured:
1. **The `gi://GdkWayland?version=4.0` import is load-bearing.** Without the typelib loaded GJS sees
   the surface as `unknown_GdkWaylandToplevel` with **no methods**, so a `typeof` guard turns the
   whole feature into a no-op that logs nothing.
2. **Apply it at `map`, not `realize`.** GTK creates the `xdg_toplevel` — and stamps the process-wide
   id on it — inside the first `present()`, which happens at map; an override set at realize is
   undone a moment later.

Also gone with the remap: its guard was `key.includes("ags") && rawClass !== "io.Astal.ags"`, a
SUBSTRING test that silently dropped any third-party window whose class contained those letters.

## `lib/nidara-wl/` — the Wayland shim (the project's only native library)

**Why it exists:** GJS cannot speak raw Wayland. `libwayland-client` has no introspection, and
`gdk_wayland_surface_get_wl_surface` is `introspectable="0"` in `GdkWayland-4.0.gir`. Several things
the shell needs are unreachable from TypeScript without a C shim, and they are the *same* shim, which
is why one library carries all of them — the packaging cost is paid once:

| Capability | Protocol | What it unlocks |
|---|---|---|
| `capture_window()` → `GdkTexture` | `ext-image-copy-capture` + `ext-foreign-toplevel-image-capture-source` + `hyprland-toplevel-mapping` | Real window thumbnails (Overview, window switcher) |
| `visible_region_*()` | `hyprland-surface-v1` **v2** | The layer-blur cost in `tech-debt.md` §46 |
| `focus_grab_*()` | `hyprland-focus-grab-v1` | Keyboard without layer-shell EXCLUSIVE + compositor-side outside-click dismissal |

Built by `lib/nidara-wl/build.sh` — plain `cc` + `wayland-scanner` + `g-ir-scanner`, deliberately no
build system, same reasoning as `bin/nidara-input.c`. Installed to `/usr/lib/libnidara-wl.so*` with
the typelib on the **default** girepository path, so all three bundles just `import NidaraWl from
"gi://NidaraWl"` with no `GI_TYPELIB_PATH`.

**Facts worth not rediscovering** (all verified in Hyprland 0.56's source and on real hardware):

- **Capturing a window that is NOT visible works, and costs one render pass.** Hyprland re-renders
  the window on demand into an export framebuffer (`ScreenshareFrame.cpp`: `RPT_EXPORT` +
  `renderWindow(...)`); it does **not** copy the client's last buffer, and it does **not** check
  visibility. So a window on another workspace captures its last committed content. `misc:render_
  unfocused_fps` is **not** needed — do not turn it on for thumbnails, that is continuous GPU work.
- **Identity is exact, not guessed.** `hyprland-toplevel-mapping` returns the same window address
  `hyprctl clients` reports, so a capture never has to be matched by title or class.
- **Capture is async and parallel-friendly**: ~8-20 ms each, 4 windows in ~68 ms wall-clock. Each
  capture runs on a worker thread with its **own** Wayland connection — it never touches GDK's event
  queue. The visible-region side is the opposite: it rides GDK's connection (the surfaces are GDK's)
  on a private `wl_event_queue`, and only ever sends requests.
- **Captures come back at the window's real size** (~14 MB for 2560×1440). Always pass
  `max_width`/`max_height`; the shim scales with cairo and hands back only the thumbnail.
- ⚠️ **The visible region only applies on the next real `wl_surface.commit`.** A surface whose
  content does not change may never commit, and `queue_draw()` alone is not enough — GTK skips the
  frame when the render node is identical. `visible_region_commit()` returning `TRUE` means
  *delivered*, not *in effect*. Declare the region as part of a change that repaints.
- ⚠️ **Anything outside a declared region is not drawn at all** (hard GL scissor; an empty
  intersection cancels the element). The failure mode is "the surface vanished". `visible_region_
  clear()` is the escape hatch.

**From the shell, do not import the shim directly** — go through `common/VisibleRegion.ts`, which
owns three decisions:

- It imports the module **lazily and through a variable specifier**, never a string literal. A
  literal makes `tsc` resolve `gi://NidaraWl` at compile time, and `@girs/` only has it once the
  library is installed — so a literal would turn "optional at runtime" into "typecheck fails on any
  machine that has not installed it", CI included until its `@girs/` snapshot is refreshed.
- A missing or too-old shim degrades to full surfaces instead of taking the shell down.
- `NIDARA_VISIBLE_REGION=0` disables the optimisation everywhere. Keep this working: the failure
  mode above is a missing piece of desktop, so a user who hits it needs a bootable shell before they
  can report anything, and `systemctl --user set-environment` is reachable from a TTY.
- It speaks **many rects** (`setVisibleRects`; `setVisibleRect` is the one-rect convenience).
  `wl_region_add` is additive and Hyprland iterates the clip region rather than its bounding box, so
  N rects cost their own area, not their union's — which is what lets the bar declare "strip PLUS
  the open panel" instead of giving the surface back. ⚠️ **`[]` and `null` both mean CLEAR, on
  purpose, and that is NOT what the protocol says**: a genuinely empty `wl_region` is a surface that
  draws nothing. Nobody wants that as the answer to "I could not measure anything", so the wrapper
  will not produce it — say `null` to mean "I don't know" and get the whole surface.

**Every blurred layer declares a region today** — `DockAxis.ts` (both axes), `IslandWindow.ts`,
`Bar.tsx` and `AppGridWindow.ts` — and they split into **four rules**, one per shape of the
question "do I know what I paint before I paint it?".

- **The dock knows its silhouette before it paints**, so it declares in every state, hidden
  included. Since 2026-08-09 that is literally every state: the two branches that used to hand the
  whole surface back — an open app grid, and a yield — are gone, the first because the grid moved
  out and the second because it was only ever justified by the grid.
- **The island declares `capsule + whatever mode is live`** (2026-08-10). It used to declare only at
  rest — "its modes arrive through a `MorphRevealer`, which has no allocation until the morph lands"
  — and that was true for exactly ONE frame, written as if it held for as long as a mode stayed
  open. `MorphRevealer` fires `onAllocated` from inside `size_allocate` just like `ScaleRevealer`,
  and `IslandWindow.mount` had wired it since the focus-grab migration, so a mode's rect lands on
  the frame that first paints it. Measured live: 1.3 % of its box at rest, 3.1 % with the Assistant
  open, 31.7 % with the (full-width by design) overview — against 100 % before. In GPU points, with
  `IslandWindow.ts` as the only variable: the Assistant open goes **5.9 → 1.1**, which is the
  island-CLOSED floor (1.0) — opening it costs nothing measurable; the overview goes 4.3 → 1.8.
  🔑 **The morph itself needs no per-frame region**: `applyProgress` only touches opacity, never
  layout, so the allocation is final from the first pass — one stamp per open, one per close — and
  the travelling shape is `lerp(capsule, glass)`, both ends inside the rect already declared. The
  only clear left is the frame in which a just-revealed mode has no allocation yet (`pending` →
  whole surface). ⚠️ `get_visible()` is not enough on the way out; `tickId` is what says "still
  moving". ⚠️ The indicator chips leave `hitTargets()` when they fade at 35 % of the morph, so they
  live inside `BLUR_PAD_X = 200`, not inside a rect of their own — tighten that pad and they blink.
- **The bar declares `strip + one rect per open panel`** (2026-08-09). It used to follow the
  island's rule, and that was the island's answer to a question the bar does not have: its five
  panels are `ScaleRevealer` + `OVERLAY_POP` with `animateLayout: false`, so — exactly like the app
  grid below — the allocation is FINAL from the first laid-out frame and the pop paints inside it.
  🔑 **What makes per-panel rects safe is `onAllocated`**, which `ScaleRevealer` fires from inside
  `size_allocate`, i.e. before the snapshot of the same frame: however stale the bounds were when
  the open path stamped, the panel's real rect lands on the very frame that first paints it. That
  hook is now wired by **walking `masterOverlay`**, like the rect predicate itself — a hand-list that
  missed a panel added later used to cost a late click and would now cost a panel that is not drawn.
  The one path that still hands the whole surface back is the notification banners, and only between
  `onContentAppeared` (synchronous, on append) and the deferred stamp that follows their grow-in —
  the window in which the box's bounds describe the *previous* stack. Their band is declared
  **full monitor width** because a swipe-to-dismiss flips the revealer to `overflow: VISIBLE` and
  flings the card clear off screen: it is the one thing in that window that paints outside its own
  box, everywhere else GTK's `overflow: HIDDEN` on the revealer clips for us before the compositor
  sees anything.
- **The app grid is the third case: it declares only while OPEN, and does not exist otherwise.** It
  has the same no-allocation-yet problem, and two properties that let it stop watching for the
  answer. Its revealer is `OVERLAY_POP` with `animateLayout: false`, so the allocation is the FINAL
  one from the first laid-out frame and the 0.97→1.0 pop paints strictly inside it; and the panel is
  centred, so it does not slide sideways under a late stamp. It therefore rides the frame clock only
  until the first measurable stamp (`add_tick_callback`, `settled >= 2`, then removed) instead of
  re-declaring per frame — a region that changes every frame can cost more than the box it saves.
  ⚠️ **Stopping is only safe because a hook re-starts it, and the first version had no hook.**
  "Centred" was read as "fixed size", and the panel is not fixed: `filterApps` swaps the
  fixed-height scroller for the short no-results box, so a search that matches nothing shrinks it
  from ~738px to ~280px. The frozen INPUT rect then swallowed clicks over ~630px of visibly empty
  screen — where every other pixel dismisses — while the blur rect merely stayed too big, which is
  the harmless direction. The fix is a `resize` hook on the squircle's own `glassArea`
  (`SquircleContainer` exposes it; `Bar.tsx` uses the same one for the island capsule), chosen over
  hooking the no-results toggle because it fires for every cause including later ones, plus a
  key-dedupe on BOTH regions so a stamp that changes nothing never reaches `queue_draw`.
  🔑 **A region you stop maintaining needs a stated reason it can never go stale — and "it looks
  fixed" is not one.**
  Closed, it is UNMAPPED, and an unmapped surface has no blur pass at all.
  ⚠️ Its two regions default in OPPOSITE directions while it cannot measure: **null (whole surface)
  for blur**, because a wrong rect there ERASES the grid, and **empty for input**, because a wrong
  rect there makes a monitor-sized surface eat every click on screen. Same principle both times —
  fail towards invisible.

#### Who owns the monitor's geometry: `createRegionStamper` (2026-08-15)

**A surface must never hold a `Gdk.Rectangle` it got from `get_geometry()`.** Switching to 1080p
live cut the Activity Island off the screen entirely, cut the bar's capsules, and opened the
AppTitle panel somewhere else; a UI reload fixed all three, because a fresh build reads fresh
geometry. It was a clean 2×2 — the dock (rebuilds on `notify::geometry`) and the app grid
(refreshed on it) were fine; the bar and the island each captured `const monGeo` at build time and
subscribed to nothing. The surfaces themselves resize for free (anchored on four edges); what goes
stale are the NUMBERS they cut with.

🔑 **Two of four forgot BECAUSE subscribing was optional.** So the fix is not two more handlers:
`common/VisibleRegion.ts` grew a stamper that OWNS the geometry, and the surface hands over a
producer that returns rectangles and is CALLED with the box to fit them in. A surface that cannot
reach the geometry cannot cache it. (Prior art: GNOME Shell's `LayoutManager` — what is central is
not where the number lives, it is *who does the arithmetic*.)

```ts
const visibleRegion = createRegionStamper({
    monitor: gdkmonitor,
    tag: "bar",
    surface: () => win.get_native()?.get_surface() ?? null,   // resolved per stamp, never captured
    rects: (box) => paintedRects(box),                        // UNCLIPPED; null = "I don't know"
    box: (geo) => …,          // only the island: its surface is the monitor MINUS its top offset
    onStamped: () => win.queue_draw(),                        // fires only when the stamp CHANGED
})
visibleRegion.geometry()        // live, read per use
visibleRegion.onGeometryChanged(cb)   // for what you SOLVED from those numbers, not the rects
```

It owns the geometry, the clip (an **intersection**, so a rect starting left of the box loses the
overhang rather than sliding right by it), the dedupe and the Wayland call. It deliberately does
NOT own the CONTENT of the rects — there is no duplication there (the island has `pending`, the
dock answers `null` with its menu open, the app grid unmaps, the bar seals several) — nor the
**input region**, which is the same numbers through a different call with the opposite safe state.

- ⚠️ **The dock stays on the raw `setVisibleRect`, on purpose.** Its blur rect is fused into the
  same key/apply cycle as its input region so the two cannot drift, it speaks buffer coordinates,
  and `app.ts` already rebuilds the whole window on `notify::geometry`.
- 🔑 **The dedupe is keyed on the SURFACE, not just the rects.** A window that is unmapped and
  presented again is realized onto a new `Gdk.Surface` with no region at all, and a key carried
  over from the old one would suppress the stamp that gives it back. The app grid was clearing its
  key by hand for this; the island and the bar were not.
- ⚠️ **A live `geo()` does not fix a number you SOLVED and then stored in a widget.** Three needed
  their own answer: the bar's notification-height budget / icon-overflow count / app-title char cap
  (re-derived on `onGeometryChanged`, debounced 100 ms to match the dock rebuild's own debounce —
  the overflow count is the "capsules cut off" half, a bar still fitting 2560px of icons into
  1920); the workspace overview's card width (`previewWidthFor` bakes its answer into every card —
  stale, that is a panel *wider than the screen* it is centred on, 1903px on a 1280 display), fixed
  with `SchematicHandle.setWidth` + an `onMonitorResized` duck-typed hook routed **through
  `ActivityIsland`**, because a mode subscribing to the monitor itself is the optional subscription
  all over again; and the island's INPUT region, since the capsule is CENTRED and a new width MOVES
  it without resizing it — the one case its `glassArea "resize"` trigger cannot see.
- **Verified in the VM, both directions** (2026-08-15, 1920↔1280 live): before, the island capsule
  simply vanished; after, the trace shows the immediate stamp landing stale (`capsule=899`), #138's
  `TORN` verify firing 50 ms later, and the re-stamp landing on `capsule=579` = the new centre. The
  overview's `islandBounds` track the monitor both ways (1903 on 1920, 1263 on 1280, i.e. the 8px
  `WO_EDGE_MARGIN` each side). ⚠️ **CI cannot see any of this** — the smoke boots at one resolution
  and never changes it.

#### Deciding the shape of a FIFTH blurred surface

Those four are what exists, not a menu. For a new one, **do not start from "should this layer be
full-screen"** — once a surface declares a region that question stopped being about performance.
§46 measured the cost as tracking the *intersection* of the damage with the declared region,
monotonically: a full-screen blurred layer is +5.9 pts, the same layer declaring a 400x60 region is
**+0.7**. The box became a layout decision. Ask these three, in order:

1. **Can it be UNMAPPED most of the time?** Then give it its own surface and unmap it. An unmapped
   surface has no blur pass at all — **zero beats small**, and no region can match that. This is the
   app grid, and it is why the grid's own answer is not "declare better" but "not be there".
2. **Can it always answer "what am I painting" before it paints it?** Then full-screen is fine;
   declare a region and move on. Dock, bar, app grid, island.
   🔑 The answer is usually yes even when the surface animates, and the reason is `size_allocate`:
   both revealers call `onAllocated` from inside it, so "I don't know yet" lasts the single frame
   between revealing a widget and laying it out — not the lifetime of whatever is open. The island
   spent four months in case 3 on the strength of that confusion, and the bar copied it there.
3. **Can it NOT answer?** This is the only case where the surface's BOX is still the cost, because
   an unanswerable frame hands the whole box back. Then — and only then — ask whether a **fixed**
   smaller box is possible. ⚠️ **Fixed, never resizing**: §46 ruled out dynamic sizing, and the
   artefact tracked the RESIZE, so a box set once at map time and never changed does not hit it.
   Nobody has tried it, and since 2026-08-10 **no surface of ours is in this case** — so treat a
   candidate landing here as a reason to re-check step 2 first.

Two things the region does not buy, so do not plan around them:

- **A floor of ~1 pt per mapped blurred layer**, however small the region — the blur samples past
  its edge, so what you pay for is the region expanded by the radius. The lever there is the NUMBER
  of mapped blurred layers, not their size. Five namespaces carry a `blur` rule today (bar, island,
  dock, app grid, lock); at rest only three are mapped.
- **Nothing, if the surface really does paint everything.** `nidara-lock` is full-screen and blurred
  and should declare nothing at all. Declaring is for surfaces that paint far less than they occupy.

🔑 **Before wiring a region to the same call sites that stamp the input
region, re-read each one asking "can this arrive late?"** — a late input stamp costs a late click, a
late visible stamp is a frame that is never drawn. That question is what found the notification
banners' deliberately-deferred stamp in `NotificationPopups.tsx` (§46).

🔑 **What the 2026-08-09 measurement settled beyond GPU points:** the bar is full-screen *only*
because commandment 5 puts every overlay inside its window. Until the panels were declared, the
honest reading was that the commandment carried a real GPU price every time anything opened. It does
not any more — an open Control Center measures at the no-panel baseline. Weigh that before treating
the coupling as debt.

### Window capture — real thumbnails, one render pass each

`capture_window()` is consumed through **`core/WindowCapture.ts`** (same lazy-import contract as
`VisibleRegion.ts`; the kill switch is `NIDARA_WINDOW_CAPTURE=0`). It adds the two things a raw
async call does not have: **de-duplication** (concurrent asks for one address share a capture) and a
**concurrency cap of 4**, because each capture is a worker thread with its own Wayland connection and
past four the compositor schedules them on its frame clock anyway.

The painting side is **`common/WindowThumbnail.ts`** — a `Gtk.Widget` with `vfunc_snapshot` that
does `append_texture()` inside a `Gsk.RoundedClipNode`. 🔑 **Do not paint captures in a Cairo
`draw_func`**: `Gtk.DrawingArea` is CPU-side, so it would `download()` the texture out of the GPU on
every draw — the exact cost the capture design exists to avoid. Rounding is a GSK clip, never a
post-process, and the radius is passed per-sync because the schematic's is *derived*
(Hyprland rounding × minimap scale); a fixed CSS radius drifts from the Cairo tile beneath as soon as
the resolution changes, and the mismatch shows as tile colour at the corners.

**The consumer today is the Workspace Overview**, via `common/WorkspaceSchematic.ts` — which already
owned the per-window geometry, so thumbnails were an insertion, not a rewrite. Two rules that are
easy to get wrong there:

- **Capture on OPEN, never on a timer or on `changed`.** MEASURED 2026-08-10 rather than assumed: an
  open overview holding real thumbnails costs **0.0 %** on an idle desktop, the captures show up only
  as +0.2-0.5 points in the 3 s opening transient, and with the screen being damaged real textures
  and flat placeholders are indistinguishable (1.8 vs 1.9 % — blur is charged by area, not by what is
  painted under it). Full table in `tech-debt.md` §46. `sync()` runs on every HyprlandState
  "changed" while the surface is open; a capture per event would turn a window drag into a render
  pass per window per motion event. `SchematicHandle.refresh()` marks stale, the overview calls it on
  `notify::island-mode`, and `sync()` consumes the flag once. Continuous refresh would also be the
  continuous GPU draw the animation budget bans (~40 %, see the agent-glow finding).
  `refresh()` also **arms** capturing: nothing is captured until a surface says it is opening. The
  overview lays its cards out once at startup (so the first Super+Tab has content to morph into) and
  that pass used to fire a capture per window for a surface nobody was looking at — all of which
  failed with `buffer_constraints`, because the shell was starting, its bar and dock were claiming
  their exclusive zones, and every tiled window was being resized underneath the session that had
  just advertised the old size.
- **The app icon is the placeholder AND the identity mark, and the texture lands BEHIND it** (the
  tile is a `Gtk.Overlay`: thumbnail as child, icon as overlay). So a slow or failed capture leaves
  the tile exactly as it opened — nothing swaps in, nothing jumps. When a texture does arrive the
  icon **does not disappear — it shrinks to a badge on the bottom edge** (`applyIconLayout`).
  Removing it was the first cut and it was wrong: at thumbnail scale the content tells you which
  DOCUMENT a tile is and only the icon tells you which APP (two Chrome windows are indistinguishable
  at 150 px). GNOME, macOS Mission Control and KDE all keep it. Do not "clean it up".
- **Thumbnails are opt-in per surface** (`SchematicOptions.thumbnails`, default OFF). The app grid
  draws the same schematic for its workspace strip at ~80 px, where a capture is mush and costs a
  render pass for nothing. Only the overview turns them on.

**The schematic's backdrop is the real wallpaper** (2026-08-06), dimmed by `WP_SCRIM` (0.35) and
clipped to a proportional rounded rect — same call GNOME, Mission Control and KDE's overview all
make, and the tiles only read as *foreground* if the background is the desktop they sit on. Note the
asymmetry with captures: this one is **not** opt-in, because unlike a capture it costs nothing per
surface. There is exactly ONE decode in the shell, shared by all five overview cards and the app
grid strip:

- **`WallpaperManager.preview`** is a decoded copy bounded to `PREVIEW_MAX_W` (960 px) — a 4K
  wallpaper is ~33 MB of pixels to draw something 300 px wide; the bound makes it ~2 MB (measured).
  `warmPreview()` loads it through `Gio.File.read_async` → `Pixbuf.new_from_stream_at_scale_async`
  (**decoded in a worker thread**: the synchronous loader is a ~50–100 ms main-loop stall, i.e. a
  visible hitch in whatever animation is running when a surface opens), then emits **`"preview"`** —
  a separate signal from `"changed"` precisely because the decode lands long after the wallpaper did.
- `warmPreview()` **re-resolves the path from disk** (`resolveWallpaper("shell")`) on every call and
  no-ops when path and cache agree, so it is safe to call anywhere. It has to work that way: the
  wallpaper also changes behind this manager's back — gaming hero-art swaps it through
  `hyprland.lua`, and `_current` is only a hint (awww owns the live one). Called at schematic build
  time, from `SchematicHandle.refresh()` (surface opening), and by `WallpaperManager` itself after it
  emits `"changed"`.
- Cover-fit scaling goes through **`makeCoverFit()` in `common/DrawingUtils.ts`** — a closure holding
  ONE painter's cached scaled copy. `scale_simple` allocates a new pixbuf, so scaling straight from a
  `draw_func` re-allocates the image every frame; every consumer needs that guard, which is why it is
  a shared primitive rather than a helper (`squircleThumb` uses the same one).
- ⚠️ Painting a *pixbuf* in a Cairo `draw_func` is fine and does not contradict the rule above about
  captures: the ban is on downloading a GPU **texture** back to the CPU per draw. A pixbuf is already
  CPU-side, and the schematic's backdrop shares the canvas that paints the tiles.

🔴 **The overview's card size is solved from the MONITOR, never hardcoded (2026-08-06).** It used to
be a flat 300px preview — which made the panel a flat 1798px: only 70 % of a 2560 screen, and *wider
than a 1600px laptop*, where it would simply have overflowed. `previewWidthFor(gdkmonitor)` in
`WorkspaceOverview.tsx` solves `2·margin + 2·pad + (n−1)·gap + n·(preview + chrome) = monitorWidth`
so the panel lands `WO_EDGE_MARGIN` (8px) from each edge. It stays a floating glass panel — this is
deliberately *not* a full-bleed Mission Control mode (user, 2026-08-04).

- The monitor comes down the constructor chain — `Bar(gdkmonitor)` → `ActivityIsland(gdkmonitor)` →
  `WorkspaceOverview(gdkmonitor)` — because the bar and its island are already built **once per
  monitor** (`createUI` in `app.ts`). Use `Gdk.Monitor.get_geometry()`: logical px, the same space
  the panel is laid out in.
  ⚠️ **And SOLVE IT AGAIN when the monitor changes shape** (2026-08-15). The answer is baked into
  every card (`createSchematicMap(i, previewWidth)` + `width_request`), so a build-time solve leaves
  a panel *wider than the screen* it is centred on — 1903px of cards on a 1280 display. Hence
  `onMonitorResized` on the returned widget, called by the bar **through `ActivityIsland`**; a mode
  must not watch the monitor itself (see "Who owns the monitor's geometry").
- 🔑 **The spacing it solves with is NOT declared in CSS — that is the point, do not "restore" it.**
  `.workspace-overview` and `.wo-item` carry no padding; `WO_PANEL_PAD` / `WO_CARD_PAD` are applied
  as GTK margins from `WorkspaceOverview.tsx`, which is also the file doing the arithmetic. A margin
  inside a styled parent *is* a padding, so nothing moved (re-measured: 1348 / 1903 / 2543 / 3823,
  identical to the CSS-padding version). **The general shape**: when a layout has to *solve* for a
  spacing value, that value cannot live in the stylesheet — CSS keeps what it is uniquely good at
  (fill, border, radius, states) and TS owns the number outright. Only `.wo-item`'s `border: 1px`
  is still read from CSS, as `WO_CARD_BORDER`: a border is not a spacing token and does not move.
- ⚠️ **The obvious alternative is a trap, and it was measured before being rejected.**
  `get_style_context().get_padding()` resolves correctly *even on an unrooted, unrealized widget*
  (verified 2026-08-06: returns 16/1 for `.wo-item` with no window at all), so "just ask GTK" looks
  like the clean answer. It only works because `_workspace.scss` is currently **unscoped**. Scope it
  under `window#…` — which commandment 2 says it should be — and a not-yet-rooted probe stops
  matching, the read returns **0**, and the layout silently falls back to a stale constant. Giving
  the probe the real ancestry only trades a mirror of numbers for a mirror of structure. Prefer
  owning the number to querying for it whenever the query depends on selectors matching.
- ⚠️ **The win is not uniform, so do not sell it as a scale factor**: 2560 → preview 449 (panel 2543),
  but 1920 → 321, barely above the old 300. Wide screens are where it pays; on a 1080p laptop the
  point is that it now *fits*. Verified against the real widget tree with an offscreen GTK probe
  (Broadway backend, real `style.css`) at 1366/1920/2560/3840 — all land at 8.5px per side.

🔴 **Window GEOMETRY is the one piece of window state that no event announces — ask for it, do not
listen for it (2026-08-06).** Hyprland's IPC has **no resize event, and none for a move inside a
workspace either**: the whole `socket2` event list (0.56) carries `openwindow`, `closewindow`,
`movewindow` (a *workspace* change, not a geometric one), `changefloatingmode`, `fullscreen`,
`windowtitle`… and nothing for x/y/width/height. AstalHyprland therefore re-reads the client list on
the events it *does* get, and `hs.clients` carries whatever geometry that last read happened to see.
Two ways it goes wrong, and both were measured, not reasoned:

- **Resize a window** and nothing at all fires — the cache keeps the old size until some unrelated
  event (a title change is the usual one) re-syncs it by accident. That is why the symptom is
  intermittent: with a spinner in a terminal the cache self-heals every second, without one it never
  does.
- **Close a window in a tiled workspace** and AstalHyprland removes that one client *without*
  re-reading the rest (`hyprland.vala`, `case "closewindow"`), so every survivor keeps the size it
  had while the closed window was still taking up room. Measured 2026-08-06: closing a third window
  left Telegram cached at **858 px** wide when it was really **1722** — a thumbnail squashed into
  half its width.

**`HyprlandState.readGeometry()`** is the answer: one coalesced `hyprctl clients -j` returning
`Map<bareAddress, {x,y,width,height}>`, passed into `SchematicHandle.sync(geom)` for that pass only.
It is deliberately **not** cached state — a snapshot held anywhere would eventually be *older* than
the cached objects it was meant to correct. `hs.clients` stays the right source for identity (class,
`initialTitle`) and workspace, which do arrive by event. The overview re-asks on every pass it makes
while open, and the read has to **land before the captures are requested**: the tile size is what the
capture is sized to, and a capture is taken once per open.

🔴 **Window addresses do not have one format.** `hyprctl clients` and `nidara-ipc listWindows`
report `"0x555b0a0cad80"`; the AstalHyprland client objects behind `hs.clients` report the same
address as bare `"555b0a0cad80"`. `BigInt()` accepts the first and throws on the second, so feeding
the shim from the wrong source captures **nothing, silently**. `WindowCapture.parseAddress()`
normalises, and `HyprlandState.ts` has `bareAddr()` for the comparison direction — use them rather
than parsing an address by hand.

⚠️ **Never send a diagnosable failure to `console.debug` in GJS** — it is suppressed unless
`G_MESSAGES_DEBUG` is set, which turns a broken feature into a silent one. `console.warn`.

### The app grid has no focused search box — and its Enter has a HINT, not a cursor

Worth reading before touching `surfaces/app-grid/AppGrid.tsx`'s keyboard, because the obvious
mental model is wrong. The grid holds a focus grab, so **every key arrives at one window-level
`handleKey`**; the search box never receives a keystroke. Characters are pushed into its buffer by
hand (`searchInsert`/`searchBackspace`, and they must also `set_position(-1)` — a GtkEntryBuffer
has no caret, so writes to it leave the cursor at column 0 forever). There is therefore **no focus
to move between the search box and the grid**: what decides where a key goes is the plain variable
`navIdx` (-1 = nobody is arrowing) plus `wsNav` for the workspace strip.

That is why "Enter opens the top result" (2026-08-18) is not a focus change. `filterApps` ends by
ringing the first result with `flowbox.select_child` — and **deliberately leaves `navIdx` at -1**,
because it is a hint, not a cursor: were it a cursor, the very next character typed would hit
`handleKey`'s `if (navIdx >= 0) returnToSearch()` branch (which exists to leave the grid when you
start typing again) and every keystroke would tear down the highlight it had just placed. Arrow
keys set `navIdx` through `focusAt` and take over from there, which is why `highlightTopResult`
bails while somebody is navigating. The two states are visually distinct and were verified on
screen: `:selected` paints the plate's accent ring (the hint), `:focus` adds the button fill on top
(you are standing here) — see `_app-grid.scss`.

Two edges that only exist because of the hint, and both are handled: the ring is dropped when the
workspace strip takes the cursor (`focusWsSlot`), since Enter there switches workspace and a ringed
app would be advertising the wrong key; and it is restored by `returnToSearch`, whose ws-strip
Backspace caller never touches the buffer and so would otherwise strand a query with no hit marked.
The Enter fallback is gated on a non-empty query: with the grid unfiltered "the first one" is
whatever sorts first alphabetically, and a stray Enter opening Add/Remove Software is worse than an
Enter that does nothing.

### Focus grab — modality that the compositor enforces

`focus_grab_*()` speaks `hyprland-focus-grab-v1`. From the shell go through
**`common/FocusGrab.ts`** (same lazy-import contract as `VisibleRegion.ts`; the kill switch is
`NIDARA_FOCUS_GRAB=0`). **Every modal surface is on it: the bar's overlays, the island, and the app
grid.**

🔴 **It is a HARD REQUIREMENT, not an enhancement (2026-08-05).** The full-screen `overlay-catcher`
buttons that used to fake "click outside closes" are deleted, and so is the layer-shell
`EXCLUSIVE`/`ON_DEMAND` path that used to carry the keyboard. There is nothing to degrade to: no
grab means no dismissal and nothing typable, and each surface says so on stderr rather than
half-working. `install.sh` fails the install if libnidara-wl builds without `focus_grab_*`, and
`NIDARA_FOCUS_GRAB=0` is a debugging escape hatch for a STUCK grab, not a supported mode. When
adding a modal surface: acquire, and treat a 0 as broken — do not invent a fallback.

🔑 **A grab whitelists a SET of surfaces, and you must pass every surface of yours that has to stay
clickable — not just the modal one.** On an outside press the compositor delivers the button to
whatever holds pointer focus, the grab CLAMPS pointer focus to itself, and only then clears. So a
press outside the set dismisses and *does nothing else* — it never reaches what you clicked. **The
bar and the island each whitelist the other**, symmetrically: the island's capsule lives on the
island's surface (commandment #5's exception), so a bar panel grabbing only itself makes the whole
island unclickable, and vice versa. Capsule-to-capsule switching has to stay one click, and nothing
else is arranging it.

🔑 **One grab, two owners → `acquireFocusGrab` returns an ownership TOKEN and `releaseFocusGrab(token)`
no-ops for anyone else.** The shim holds a single grab (the compositor has a single slot) but the bar
and the island ask for it independently, so a bare `release()` destroys *whatever grab exists*: island
mode open → bar panel opens and legitimately evicts it → the island's own close handler then runs and
takes down the BAR's fresh grab, leaving the bar convinced it is modal while holding nothing.
Acquiring while someone holds also **invokes the previous owner's `cleared`** — an eviction is
indistinguishable from a popup stealing the slot, and an owner left believing it is still modal never
re-acquires.

🔑 **The bar strip is INSIDE the grab, so dismissing there is GTK's job.** The whole point of
whitelisting the bar is that a press on it is accepted — which also means the compositor will never
dismiss for a press on the empty space between capsules. (The catchers could not cover that space
either: one full-window button covering the strip would have swallowed the capsule presses that make
switching one click. Same dead zone, unreachable by both mechanisms.) Only GTK can tell a capsule
from the bar around it, via a **bubble-phase `GestureClick` on `masterOverlay`** that calls
`dismissOverlays()`. Keep both dismissal paths (`cleared`, strip gesture) sharing that one body so
they cannot drift. Two traps in it:

- ⚠️ **It cannot assume the control "claimed" the press.** `SquircleContainer`'s click gesture fires
  on `pressed` and deliberately does NOT claim the sequence (a competing `GestureDrag` must be able
  to cancel it — that is how banners swipe). So a bubble gesture runs **in addition to** the
  capsule's, and dismissing unconditionally closes the panel the capsule opened one event earlier.
  It has to ask what it hit: `pick()` the point and walk up to the overlay, skipping if anything on
  the way carries a `Gtk.Gesture`. Asking the widget beats an allowlist of "the bar's background",
  which rots silently every time the bar grows a widget.
- ⚠️ **`masterOverlay`, not `barBox`.** `.bar-centerbox` carries `margin-top: 8px`, and a CSS margin
  lies OUTSIDE the allocation: the bar window is 40px tall and `barBox` measures **y=8, h=32, x=8**
  (`query_ui`), so the 8px bands above it and at both ends belong to the overlay behind it. They are
  inside the input region and read as bar to the user.
- 🔑 **It asks nothing about coordinates.** A `y < BAR_H` test works — GTK and layer-shell both speak
  logical pixels, so display scaling does not move it — but it states the bar's height in the one
  place with no business knowing it. The overlay structure already says what we mean: masterOverlay's
  **child** is the bar, its **overlays** are the panels. So the walk records the last widget before
  masterOverlay and dismisses when that is `barBox` or nothing at all. Geometry-free, and correct
  wherever the bar sits or however tall it grows.

⚠️ **Anything of ours covering the desktop defeats the grab, including the OTHER surface's.** A
whitelisted surface that accepts a press the compositor needed to see OUTSIDE the grab silently
becomes the dismissal mechanism, and a broken one. This bit as a catcher first: the bar's was keyed
off the bar's own grab, but `isAnyOverlayOpen` includes `island_mode`, so while an island mode was
open the bar still covered the desktop — and since the island whitelists the bar, every "outside"
press landed on a whitelisted surface. The compositor never dismissed and never ran its refocus, and
it read as "the island restores focus and bar panels do not" (measured 2026-08-05). The catchers are
gone, but **the input region is the same hazard**: stamp only what you PAINT, never a screen-sized
rect, and never leave a panel's inflated invisible bounds in it (see §46 and the NC's
`propagate_natural_height`).

🔑 **A press outside the grab is delivered to the GRABBED SURFACE first.** Under a grab the compositor
clamps pointer focus, so our window receives button presses at coordinates far outside anything we
own — before the grab is cleared. Any "did the user press our chrome?" test must therefore be bounded
by GEOMETRY as well as by widget identity: "the press hit no control of ours" is true of every
outside click. Getting this wrong makes us dismiss the panel ourselves, which looks correct and is
not: it takes the dismissal away from the compositor, and with it the refocus.

🔑 **Dropping a grab refocuses by itself, so give the keyboard back explicitly.**
`CSeatManager::setGrab(nullptr)` honours `input:follow_mouse` (1 → `refocus()`, i.e. the window under
the cursor; `0 || 2 || 3` → `refocusLastWindow` on the monitor under the cursor). ⚠️ **The repo ships
`2` since 2026-08-15**, so the pointer branch below is no longer the default install — but it is one
`hyprland-user.lua` line away, both repairs stay, and the paragraph is kept because it is the only
written record of what the pointer branch does. Measured 2026-08-05 (under `1`): dismiss onto a
window and that window is focused; dismiss with the pointer over the wallpaper — by clicking there OR
by pressing Esc while it merely sits there — and the session is left with NO active window. A plain
desktop click with nothing open does not do that, so it is specific to dropping a grab, and working
from the keyboard it costs you the window you were typing in on every dismissal. `FocusGrab.ts` calls
`HyprlandState.restoreFocusAfterGrab()` whenever our machinery ends up holding nothing, with two
guards that are the whole design: only when the compositor was left with **nothing** focused (never
over the top of a window the user just clicked), and only on the workspace the user is **looking at**
(focusing elsewhere drags the workspace along, so an empty workspace is allowed to stay empty). Timed
off the compositor's own announcement via `afterGrabRelease`, not a delay.
🔑 **The SAME sentence broke computer-use, and it took until 2026-08-12 to connect them.** The
guards above make a dismissal leave the pointer's choice alone — correct there, fatal for the input
yield, whose caller has *already* chosen the window. `core/InputYield.begin()` therefore restores
focus with the opposite policy; the reading of `setGrab(nullptr)` that settles which branch each
`follow_mouse` value takes is in `state-and-ipc.md`. Two callers of one mechanism, deliberately
different policies — do not "unify" them.

⚠️ **Scope each `cleared` handler to what its own surface owns.** The bar closes only its overlays,
the island only `island_mode`; a handler reaching further would shut whatever the other surface just
opened. The wider "close everything" belongs to `dismissOverlays()`, which runs off a REAL click on
the bar strip rather than off an eviction.

⚠️ **An input region stamped in the same turn as `reveal(true)` describes the panel as ABSENT** — a
widget just made visible has no allocation until the next layout pass. This is invisible without a
grab (the catcher's hand-written full-screen rect covered it by accident) and fatal with one: the
press misses our surface, the compositor sees a surface outside the whitelist, and the panel dismisses
as you click into it. Both revealers therefore expose **`onAllocated`**, fired from
`vfunc_size_allocate`, and the bar's panels + the island's modes re-stamp from it. Mechanical, not a
deferred timeout hoping layout happened.

⚠️ **Never stamp an EMPTY region over a good one — the same hazard with nothing coming to fix it.**
The paragraph above is about one widget being unmeasurable for one frame, with `onAllocated` already
on its way. The sibling failure is EVERY target unmeasurable at once (widgets between an unmap and
their first layout pass: `present()` stamping in its own turn, a surface the compositor re-configured
after a suspend or a lock). The union comes out empty, and an empty region is not "click-through
until something corrects it" — it is the terminal state, because the thing that would correct it is
the very layout pass that has not happened. That is how the island came back from suspend taking no
input at all until the UI was reloaded (`tech-debt.md` #68, stamp #422).

🔑 **The asymmetry to carry: the two regions have OPPOSITE safe states.** For the VISIBLE (blur)
region, unmeasurable → hand the whole surface back; a region that is too big only costs performance.
For the INPUT region the same answer would swallow every click on screen, and the empty one takes
them all away — so its safe state is neither, it is **the region already on the surface**. Hold it and
re-stamp (`IslandWindow.holdRegion`). The one moment holding is wrong is before the first successful
stamp, when there is nothing to hold: a Wayland surface with no region takes input across its whole
buffer, so a monitor-sized surface must stamp empty until it has measured something once.

🔑 **A surface whose region is measured needs a re-stamp trigger for its PERMANENT furniture, not
just its transient parts.** The island's revealers had `onAllocated` and its morph had `onDone`; the
always-present capsule had nothing, which is exactly why its failure lasted the whole session. Note
the bar does not have this problem for a structural reason worth copying where you can: it unions an
unconditional `{0,0,monGeo.width,BAR_H}` strip, a constant that cannot fail to measure.

What a grab replaces, all three verified in Hyprland 0.56's source:

- **Keyboard without `EXCLUSIVE`.** `CFocusGrab` drives `CFocusState::rawSurfaceFocus` directly and
  `setKeyboardFocus` never looks at layer interactivity, so a surface at `NONE` gets the keyboard.
  🔑 That matters far beyond convenience: `EXCLUSIVE` is what puts a surface in
  `m_exclusiveLSes`, and **that list makes Hyprland refuse to move window focus at all** — the sole
  reason `core/InputYield` exists.
- **Outside-click dismissal.** A press outside sets `m_hardInput` and re-runs the hit test
  (`InputManager.cpp`); a surface the grab does not accept clears it. That was the whole job of the
  invisible full-screen `overlay-catcher` buttons, now deleted — so a grabbing surface must **stop
  covering the desktop with its input region**, or the press lands on us, the grab accepts it, and
  nothing dismisses.
- **Release is not double-buffered.** Layer-shell interactivity applies on the surface's next commit
  (the ~12 ms race `HyprlandState.afterGrabRelease` exists for). Destroying a grab takes effect when
  the compositor reads the request. On release the compositor also refocuses by itself, honouring
  `input:follow_mouse` — we no longer do that by hand. ⚠️ Read that as "the compositor's choice", not
  "the window the user came from": `setGrab(nullptr)` takes `refocus()` (the window under the cursor)
  on `1`, and `refocusLastWindow` (monitor under the cursor) on `0 || 2 || 3`. The repo ships **`2`**
  since 2026-08-15, so it is the second branch — but never assume the value, a user override flips it.

⚠️ **There is exactly ONE grab slot compositor-wide** (`CSeatManager::m_seatGrab`) **and xdg-shell
popups use the same one.** A `Gtk.Popover` with `autohide` opening anywhere evicts the grab. So
`cleared` has three indistinguishable causes — outside press, popup grab, or a layer surface mapping
with interactivity ≠ NONE (`LayerSurface.cpp`, which still carries upstream's `TODO: use the new
superb really very cool grab`). **Treat `cleared` as "I no longer hold input", never as "the user
dismissed me".**

🔑 **`FocusGrab.ts` separates the popup cause itself, and callers never see it.** The protocol says
nothing about why, but our own widget tree does: a `Gtk.Popover` is a CHILD of the widget it is
parented to, so on `cleared` it walks the lease's windows for a mapped popover. If it finds one the
lease is **suspended** — not closed — and retaken on the popover's `closed`. Without that, opening a
menu inside a surface dismisses the surface the menu belongs to: the island's media source selector
(`widgets/media.ts`, `autohide: true`) and GTK's own right-click menu on the assistant's `Gtk.Text`
both did exactly that. It also means `acquireFocusGrab` takes **`Gtk.Window`s, not `Gdk.Surface`s** —
it needs the widget tree, and `get_native()?.get_surface()` is untyped from the GIR anyway (passing a
bare surface where the set was expected once type-checked cleanly and threw at runtime).

⚠️ **The grab takes the pointer too** (`m_keyboard` *and* `m_pointer` are hardcoded true) — there is
no pointer-only mode. Any surface that adopts it starts taking keyboard focus from the user's window,
which is fine for Prism and a real behaviour change for a panel like the CC. It is also **not
enforced during DnD** (`!dndActive()`), which matters for the dock's drag.

🔑 **There is no catcher left anywhere, including the ones that had stopped running.** Two remnants
outlived the 2026-08-05 deletion by hiding as unreachable code, and were removed 2026-08-16:
`Bar.tsx`'s catcher REGION sat behind an `if (false)` (a later PR then updated the geometry inside a
block that could not execute — the residue was actively misleading maintenance), and the kit's
`NidaraSplitView` kept a transparent full-area `backdrop` + `GestureClick` for the collapsed sidebar,
selected only when no `floatAnchor` was passed, which no caller has done since the popover mode
landed. Its `floatAnchor` parameter went with it: the popover parents to the split view's own root
`Gtk.Overlay` (window-space `pointing_to`), so the anchor was never the popup's parent — it was a
mode flag that read like a position. **A catcher and a grab must never both be live**: the catcher
sits above the thing you clicked and eats the very press the grab is waiting to be given.

**The Settings window is not part of any of this, and never was.** It is an xdg TOPLEVEL, so the
compositor owns its focus by construction — there is nothing outside it to catch. Everything popup-
shaped inside it is a real xdg_popup with `autohide` (`NidaraDropDown`/`Gtk.DropDown`, Network's
password `Gtk.Popover`, the collapsed sidebar) and therefore takes the same single seat grab through
GTK, and `showNidaraAlert` is a real `modal: true` + `transient_for` toplevel. If you are auditing
"does surface X still fake its modality", toplevels are not candidates: only layer surfaces are.

⚠️ **Our objects live on a private `wl_event_queue`, so nothing dispatches `cleared` for us.** The
shim pumps `wl_display_dispatch_queue_pending` on a 50 ms timer **while a grab is held** — it never
reads the fd (GDK owns it, and `wl_display_read_events` already distributes to every queue). The
interval is how long a dismissal can lag; it is not a polling loop for state.

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
   - **Dev mode:** if `~/.config/nidara/.dev` exists, `cd` to its path and run `scripts/run.sh app.ts`.
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

### The lockscreen: who draws it, and what the shell is actually hiding from

Under `ext-session-lock-v1` the compositor still composites, but the lockscreen's **content** comes
from our own `nidara-lock` process (`ui/lockscreen/`): one GTK4 window per monitor, handed to
`Gtk4SessionLock`'s `monitor` signal (`Lock.ts:52-56`). That is also why the lock paints its own
`Gtk.Picture` wallpaper — awww's layer is not on screen behind it.

**The protocol is stronger than it looks, and assuming otherwise has already cost a wrong comment**
(verified against Hyprland 0.56 sources, 2026-08-07):

- **Render**: `renderAllClientsForWorkspace` (`Renderer.cpp`) returns *before* drawing ANY layer —
  background, bottom, top, overlay and popups alike — as soon as the lock client confirms
  (`clientLocked()`) and `misc:session_lock_xray` is off. `renderLockscreen` then draws primer →
  lock surface → and only layers whose `above_lock` rule is set, filtered in `renderLayer`.
- **Input**: `ViewHitTester::layerSurfaceAt` skips every layer without **`above_lock == 2`** while
  locked, and `InputManager` forces keyboard focus onto the lock surface *"regardless of layers"* —
  so an interactive above-lock layer gets the pointer but never the keyboard.
- Nidara sets `above_lock` **nowhere**. No layer of ours can appear over, or be clicked through,
  a confirmed lockscreen. A layer being on OVERLAY buys it nothing here.

So `hideForLock`/`showAfterLock` (`app.ts`) exist for the two gaps the protocol does *not* cover:
the window **before** the lock surface is committed on every monitor (`bin/nidara-lock` calls
`hideForLock` before it even launches the bundle — until then the session renders whole), and the
**OVERLAY fallback** in `Lock.ts:59-80`, taken only when `Gtk4SessionLock.is_supported()` is false,
where the lockscreen really is just another layer. Note the `nidara-lock` blur `layer_rule` in
`hyprland.lua` applies to that fallback ONLY — a session-lock surface has no namespace.

Also compositor-side, and easy to forget: **keybinds stay live while locked**, which is why
`bin/nidara-lock` switches to the empty `lock` submap and why the media/brightness binds are
explicitly marked `locked = true`. There is **no lockspace**: the workspace switch that used to
precede the lock was dropped in `5c72f2c4` (2026-05-24) as redundant.

#### The lockscreen's glass is blurred BY US, and that is not a shortcut

`widget/GlassBackdrop.ts` paints a blurred copy of the wallpaper behind the password field and
the power bar. Compositor blur is **unreachable** on a lock surface, and each escape route is
closed by a different piece of Hyprland (0.56 sources; the third leg measured in a VM 2026-08-09,
not deduced):

- `misc:session_lock_blur` exists, but `renderdata.blur = PSESSIONLOCKBLUR && PSESSIONLOCKXRAY` —
  and `xray` renders the **whole workspace** behind the lock (windows included) and disables the
  black primer. It also blurs the *entire* surface: restricting blur to one widget needs
  `ignore_alpha`, which is a LAYER rule a lock surface cannot carry.
- Marking the wallpaper layer `above_lock` puts it **on top of** our UI: above-lock layers are
  drawn *after* the lock surface (`Renderer.cpp:1655-1668`). There is no "below_lock".
- Moving the UI onto an `above_lock = 2` layer renders and takes the pointer, but
  `CFocusState::rawSurfaceFocus` (`FocusState.cpp:227`) refuses keyboard focus to every surface
  that is not the lock surface — **measured**: the layer logged zero keys while locked, hyprlock
  received all of them. `above_lock = 2` means render + pointer, never keyboard (arguably an
  upstream inconsistency: the rule advertises input).

hyprlock, swaylock and gtklock all blur their own copy for the same reason. Ours mirrors the
compositor's pipeline so the material matches rather than resembles: `push_blur` for the gaussian,
`push_color_matrix` for `contrast`/`brightness`/`vibrancy`, constants kept in lockstep with
`blur { … }` in `hyprland.lua`. The blurred image is rendered **once** into a texture (blurring
inside `vfunc_snapshot` would re-blur the wallpaper on every clock tick), and it is sampled in
window coordinates so what shows through registers with the sharp wallpaper around it. The
Kawase→gaussian radius mapping is an approximation between two algorithms — `BLUR_RADIUS` is the
one constant to trim by eye if the lock's glass ever reads heavier than the bar's.

## Directory map (`ui/shell/`)

Five pillars by responsibility (UI split renamed from the old `widget/` dir 2026-06-11):

- **`core/`** — singleton services. **Never touch the UI directly.** (Detailed below.)
- **`styles/`** — all SCSS, compiled to one `style.css`.
  - `_base.scss` holds design tokens + `@mixin glass` + `@mixin nidara-reset`.
  - `_reset.scss` neutralizes Adwaita residue.
  - Per-component modules are scoped with `window#id { … }`.
- **`surfaces/`** — whole TSX surfaces that consume `core/` state. Each surface is a function that takes a `Gdk.Monitor` and returns a `Gtk.Widget`:
  - `bar/`, `dock/`, `control-center/`, `app-grid/`, `island/` (the Activity Island: the bar-center capsule as a multi-purpose morphing surface. COMPACT state = a `Gtk.Stack` (crossfade + `interpolate_size`, so the pill's width animates) whose pages MUTATE by activity: one page per registered activity, **including the workspace dots** (which absorbed the old `bar/Workspaces.tsx`). **Activities are DATA** (`IslandActivity` in `ActivityIsland.tsx`; the concrete ones in `IslandActivities.tsx`): each declares `{compact form, priority, watch/isLive liveness, expandMode?, autoExpand?, makeGhost?/artSource? morph continuity}` and OWNS its liveness policy; the engine only arbitrates — highest-priority live activity fronts the compact. Current activities: **dots** 0 (`isLive: () => true` — the FLOOR, so "nothing running" is not a special case but the dots winning, and there is no `else` branch. They used to BE that else branch, and it was a bug: with any activity live the capsule's click opened THAT mode and the workspace overview became unreachable by mouse. `expandMode: overview`, no `makeGhost` — their morph continuity is the traveling `MorphPair` set, not a dissolving twin) < **media** 10 (`PlayerCompact`: mini art + title + 10fps Cairo EQ; pause holds a 12s grace, the open player panel holds liveness, player leaving the bus drops it instantly) < **recording** 20 (STEADY danger dot + elapsed, mirrors `status.recording`; the shell's ONE live-capture display since the CC banner row was dropped — the elapsed text comes from `recordingElapsed()` in `core/Status.ts`, off the single `recordingStartedAt` stamp, so no two surfaces can disagree and one built mid-capture never restarts at 0:00. `expandMode: ISLAND_RECORDING` → `RecordingIsland.tsx`, a statement card of clock + Stop, so the island answers for the capture end to end and stopping never depends on where the user put a widget. Its two earlier destinations were both wrong and both user-caught: the workspace overview (leftover from when the overview was the capsule's default identity, 2026-08-01) and then `onExpand → toggleCC` (fine only while the CC banner held the only Stop — with that row gone and the screenrecord widget placeable in the BAR ONLY, the click could open a Control Center with nothing about the recording in it, 2026-08-02). The FAST Stop is the bar pill, one click, see the `barClick` contract below) < **battery-critical** 30 (`≤5%` discharging, clears `>7%` or charging — hysteresis because UPower ticks are coarse; **the auto-expand prototype**: takes the front AND opens its alert once per takeover; the agent's "needs confirmation" will ride the same `autoExpand` flag) — and **agent** 25 (the built-in Assistant, between recording and battery: live while a turn runs (`agentService.busy`, the "working pill") or its panel is open; does NOT use the engine `autoExpand` — `AgentService` opens the island itself when a BACKGROUND turn finishes, since the flag fires on taking the front, not on finishing; closing the island mid-turn does not cancel). EXPANDED modes morph out of the capsule via one MorphRevealer per mode, driven by `status.island_mode` — `overview` (keyboard nav), `player` (the shared media detail panel from `widgets/media.ts`, no keyboard grab), `battery` (`BatteryIsland.tsx`, a plain statement card), `agent` (`AgentIsland.tsx`, the Assistant chat: header + streaming transcript + text entry; `needsKeyboard:true`, its `handleKey` claims only Escape so the entry types — the island's first TEXT mode). Cross-activity rules live in the engine's `arbitrate()`: a DEAD activity's open surface closes (player left the bus, battery recovered); auto-expand fires only when the activity TAKES the front (closing the island while the condition persists must not re-open it). **A chip click PROMOTES, and promotion is NOT expansion: it pins its activity to the front (`pinned`) and stops there** — the chip swaps into the capsule so the thing you picked is the thing the bar is showing, and a SECOND click, on the capsule, expands it. It used to do both in one click; `promote()` dropped its `openAfterSwap` call on 2026-08-22 (#226). A chip is a "show me this" control, not a "take me there" one — the same separation `onExpand` already had, now applied to the mode too. Priority is a guess about what matters and a click is not, so the pin outlives every ordinary change and ends only when the user picks something else or the pinned activity dies. ONE exception: an `autoExpand` activity (a critical battery) takes the front anyway because interrupting is its whole purpose — and it does NOT clear the pin, so what the user chose comes back when the interruption passes. Auto-expand opens through `openAfterSwap` and is its ONLY caller since #226, never in arbitration's own tick (see the phantom-% gotcha above); a chip click does not open anything. An activity with no `expandMode` opens its `onExpand` instead — the destination where it can actually be acted on (recording used to point here before it got a mode of its own) — and nothing at all if it has neither. **`onExpand` fires only from an EXPAND click (the capsule), never from promotion**: `openAfterSwap` handles island modes only, because switching the capsule to an activity is not the same act as asking to be taken to another surface, and one click must not do both (user call 2026-08-01). Promoting a capture puts the timer in the capsule and stops; its second click makes the jump. **There is no fall-back to the workspace overview**: that existed only while the overview was the capsule's default identity, and once the dots became an activity with a mode of their own it just meant an unrelated surface answering the click (user-caught 2026-08-01, on the recording pill). **Only a LIVE activity can be pinned**: a merely-indicated chip (the idle assistant) has nothing to hold the capsule with, so clicking it just opens its mode — which is what makes it live — exactly as Super+A does; pinning it would either be cleared on the spot by the liveness check or park an idle activity in the capsule forever. The LOSERS are no longer discarded — `arbitrate()` publishes every live-but-not-fronting activity as `background()` (+ `onBackgroundChanged()`) on the island handle, **ordered by priority, never by arrival** (an arrival-ordered row would swap icons under the cursor). Note the front can hold steady while the background changes, so the background is computed BEFORE `arbitrate()`'s no-front-change early-out. That list is painted by the **INDICATOR ROW** (`indicatorRow` on the handle, appended to the bar's centre box right of the capsule — the iOS split: a pill for the current thing, circles for the rest, and **the GROUP centres**, so the capsule leaves the monitor axis while anything else runs). A chip is shown for everything INDICATED that isn't fronting, which is WIDER than "live": the optional `isIndicated()` (default = `isLive`) lets an activity earn a chip without competing for the capsule. Only the Assistant uses it — a configured provider is always one click away — and it MUST stay out of `isLive`, or the agent (25) would outrank the music (10) and hold the capsule for a session that never used it. Each activity supplies its own glyph via the REQUIRED `indicator()` (dots → a frozen `.workspace-dot.active` pill, `makeActiveDotGlyph`; media → a music glyph; rec → the steady danger dot; battery → the Cairo glyph; agent → `sparkles`), max `INDICATOR_MAX` = 3 chips. **A chip's usable interior is ~20px, and a chip glyph is 16px:** the chip is a 28px circle (`CHIP_W` = 32 = the bar row height, less `SquircleContainer`'s 2px technical inset per side; `perfect` → radius h/2) and the largest square that fits INSIDE a 28px circle is 28/√2 ≈ 19.8. **Measured, not derived** (2026-08-23, `nidara-ipc queryUI` on a live shell): `bar-centerbox` is h=32, and the indicator row is 80×32 with two chips up — `CHIP_W` 32 + `CHIP_GAP` 8, twice. ⚠️ This paragraph said 24px/28px/≈17 until then, arithmetic from a 28px bar row that had since grown; if the row height moves again, re-measure with `queryUI` rather than trusting the numbers written here. Media used to stack the compact's 20px cover art over its music glyph and the square poked out of the glass on all four sides (user-caught 2026-08-03); shrinking it to the inscribed square would have filled the circle edge to edge and eaten the glass ring that makes a chip read as a chip. **Cover art is not chip material** — it lives where it is legible (the compact's 20px slot beside the title, the panel's 96px). Nor is the compact's EQ: an animated chip damages the island's OWN layer at its frame rate, and Hyprland charges blur by the layer BOX, so a 24px flourish costs a full-screen re-blur per frame for as long as the music plays (the compact's EQ is 10fps AND `map`-gated for exactly this reason). Chips are static monochrome glyphs on glass. Three traps this cost: (1) the row is `INDICATOR_MAX` FIXED SLOTS, not one revealer per activity — slot `i` shows `background[i]`, and each slot is a `Gtk.Revealer` (SLIDE_RIGHT) wrapping a `Gtk.Stack` (CROSSFADE, `COMPACT_SWAP_MS`) holding one named glyph per activity, crossfading between them IN PLACE. One revealer per activity was the first design and two of them cross-slid over each other whenever activities swapped rank (fixed 2026-08-22, #226); with slots the geometry is positional and constant — every rect stays put and only the glyph inside it changes, so priority order still falls out for free from the order `arbitrate()` publishes; (2) the gap is each chip's `margin_start`, NOT box spacing — a collapsed `Gtk.Revealer` still counts as a visible child, so spacing would reserve its 8px forever and leave the capsule off-centre in an idle session; (3) the chips use `Gtk.Revealer`+`SLIDE_RIGHT` (the bar's existing idiom, `widgets/bar-helpers.ts`), NOT `ScaleRevealer`, which animates the measured HEIGHT only and passes width straight through. `IslandWindow.mount` therefore takes `hitTargets: Gtk.Widget[]` (capsule + every chip; hidden ones fall out on the visible/mapped guard), and Bar.tsx re-stamps the input region on `onBackgroundChanged` — a chip appearing MOVES the capsule without resizing it, so the `glassArea` resize hook never fires for it. Capsule click expands whatever fronts the compact; Super+W always reaches the overview. Battery E2E on a desktop: `scripts/dev/fake-battery.sh` (sudo, dev-workflow.md)), `overview/`, `prism/`
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

    🔑 **"One level above the bar" stops being true in the game overlay, and there is
    no call that fixes it.** Super+B under a fullscreen window moves the BAR to
    OVERLAY too — the bar's own level, TOP, renders below a fullscreen window — and
    inside a level Hyprland stacks by COMMIT ORDER: last to commit is on top. The
    bar's layer change reaches the compositor after the island's `present()` in the
    same turn, so the bar lands above. Two things break at once: the island stops
    blurring the bar (the reason it is a separate surface at all), and it goes
    **completely dead to the pointer while looking perfectly fine** — `Bar.tsx`
    unconditionally claims `{0,0,width,BAR_H}` of input and the capsule is painted
    at y=8..40, inside that strip, so the bar eats every click meant for it. The
    input region is correctly stamped the whole time, which is what makes it such a
    bad one to chase (owner-caught 2026-08-24).

    ⚠️ **There is no raise in layer-shell, and `set_layer` to the value you already
    have is a NO-OP** — which is what `IslandWindow.raise()` was. Measured with
    `scripts/dev/layer-order-probe.ts`, two throwaway surfaces on one level:
    baseline (B mapped last) → B on top; `set_layer(OVERLAY)` again → **B still on
    top**; bounce TOP → OVERLAY across separate commits → A on top; unmap + remap →
    A on top. The only lever is to leave the level and come back, and it needs TWO
    commits: both requests inside one commit collapse to a final value equal to the
    current one, i.e. the no-op again.
    ⚠️ The half-done state is worse than the bug — a surface parked on TOP is under
    the fullscreen window, i.e. gone — so the return leg is armed twice (frame clock
    AND timeout) and never made conditional on a signal arriving. And because this is
    ordering we do not control, `raise()` asks the compositor whether it worked
    (`HyprlandState.isLayerAbove`) and logs when it did not.
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
    filter by window name; forget it and the capsule stays up through the
    fullscreen hide, and through the window BEFORE the lockscreen confirms the
    lock — not over the lockscreen itself, which no layer of ours can reach; see
    the lockscreen note below).
    Consequences you inherit when touching it (two input regions, keyboard-grab
    collision, CSS scoped to BOTH windows, layer-order re-assertion) are listed
    in `state-and-ipc.md` under "Overlay placement".
  - `app-grid/AppGridWindow.ts` — the **third exception to commandment 5**
    (2026-08-09), and the only one whose reason is a BILL rather than a visual
    impossibility. Its own layer-shell window per monitor, namespace
    `nidara-app-grid`, OVERLAY level, anchored on four edges with
    `exclusive_zone = -1` (so the panel centres on the SCREEN, not on what is left
    after the bar and dock reserve theirs) and `KeyboardMode.NONE` like everything
    else — the compositor focus grab carries the keyboard.
    **Why it moved.** The panel used to be a `Gtk.Overlay` child of the DOCK's
    window. Hyprland charges layer blur by the surface's BOX, and the dock's
    surface is the whole monitor while it only PAINTS a pill — which is the entire
    reason it declares a region (§46). A guest that can paint anywhere made that
    impossible: every open handed the full 2560×1440 box back, so the saving
    evaporated exactly when the screen was busiest. Split apart, the dock keeps its
    pill rect in **every** state and this surface declares the panel's
    (**measured on the real shell: 1110×834 of 2560×1440**, ~25%).
    **What was traded away, deliberately** (owner, 2026-08-09): opening the grid no
    longer REVEALS the dock. That coupling was the whole justification for the
    old placement (`tech-debt.md` §18). Two things soften it and both are
    verified: this monitor's other shell chrome (**bar, island and dock**) goes into the
    grid's focus grab as **peers**, so the dock's icons still launch with the grid
    open, and with auto-hide on, an edge hover still slides it in **while the grid
    stays open**.
    ⚠️ **The peer list is not a nicety — a grab CLAMPS pointer focus, so a surface
    left out of it stops receiving even MOTION.** Shipping with only the dock as a
    peer left the bar's capsules inert: no hover, no click (user-caught 2026-08-09,
    same day). The bar and the island already whitelist each other for exactly this;
    the grid simply joins the set. Whitelisting the bar then obliges
    `dismissOverlays()` to close the grid, because a peer is by definition a surface
    the compositor will NOT dismiss on — otherwise the empty bar strip becomes the
    one press on screen that does nothing.
    **What that unlocked**: with the dock coupling gone there was nothing keeping
    the grid out of `Status.ts`, so it is now `status.app_grid_open` — a normal
    mutually-exclusive overlay, and `dumpState` reads the property instead of
    scanning windows for the dock's `isAppGridPanelOpen()`.
    Its region rules are the third case in the visible-region section above.
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
  - `CursorRefresh.ts` — **a new cursor theme or size never reaches the cursor already
    on screen.** `hyprctl setcursor` → `changeTheme()` reloads the theme and schedules
    frames but never re-issues the shape, so those frames repaint the OLD picture. 🔑 The
    law that governs everything here: **Hyprland redraws the pointer only when it sees a
    different shape NAME** (`IHyprRenderer::setCursorFromName` opens with
    `if (name == m_lastCursorData.name && !force) return;`). A name is what
    `wp_cursor_shape_v1` carries, so the fix is the protocol's own vocabulary: name a
    different shape and name the old one straight back, in one main-loop iteration —
    the compositor applies both in one pass, nothing is composited in between, and
    nothing flickers. Only the client holding pointer focus may name a shape, so this
    covers Nidara's surfaces; the case where NOBODY holds it (right after a
    `Gtk.DropDown`'s popover is destroyed under a motionless pointer) goes through
    `HyprlandState.reevaluatePointerFocus()`. Before touching any of it, read the cursor
    section of `dev-workflow.md` — five separate instruments lie about this, all in the
    direction of "your change did nothing".
- **`widgets/`** — atomic CC/bar widgets, **auto-registered**: one file that
    default-exports a `const w: AtomicWidget = {...}` is ALL it takes —
    `scripts/gen-widget-index.mjs` scans the dir and regenerates the committed
    `widgets.gen.ts` (imports + `ALL_WIDGETS`; runs on npm build/dev hooks, on
    the dev launcher before `scripts/run.sh`, and CI job `widgets-gen` fails if stale).
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
    `core/RecordingConfig.ts`). The page is built with the ordinary row
    vocabulary, so a widget page is indistinguishable from a first-class Settings
    page — but since 2026-08-16 that vocabulary comes from **`ui/lib/nidara-kit`**
    (`NidaraList`/`NidaraRow`/`NidaraDropDownRow`/`NidaraToggleRow`), not from
    `surfaces/settings/SettingsHelpers`. ⚠️ This paragraph used to say the reverse
    — that importing the Settings helpers from `widgets/` was fine because
    widget → surfaces is the normal direction. The direction was never the
    problem; the coupling was. Those helpers carry Settings' search-index
    registration, which a CC widget neither wants nor should depend on being
    inert, and `pageBox`'s `.settings-page` is scoped inside
    `window.nidara-settings-window`, so it styled nothing out here anyway. A
    widget that wants a preferences page takes the kit's rows.
    **Hardware gate**: a widget tied to hardware declares `isAvailable()` (+
    optional `watchAvailable(cb)` for hotplug) — when false it's hidden from
    bar + CC (filtered in `Bar.rebuildBarWidgets` and `IslandGrid.syncCCLayout`,
    at the layout level so edit-mode cells stay coherent) and its Settings card
    renders off+disabled with a "no hardware" hint. Placement config is NEVER
    mutated by availability. battery/wifi/bt/ethernet/brightness implement it;
    a fallback "not present" buildContent branch is no longer the mechanism for
    hiding (battery keeps one only as defense in depth).
  - `common/` — shared: `SquircleContainer`, `DrawingUtils` (which since 2026-08-15 only RE-EXPORTS `hexToFloatRgb` — the implementation moved to `lib/accent.ts` so the kit's slider could reach it), `ManagedWindow`, `WorkspaceSchematic`, `ScaleRevealer.ts` (the ONE show/hide animation — overlays + banners, see design-system.md), `MorphRevealer.ts` (capsule→island geometry morph: island modes grow out of the bar-center capsule — real interpolated Cairo squircle + traveling element ghosts (`MorphPair`: dots→card headers, cover art→panel artwork) + a dissolving source-content twin so the glass is never empty mid-flight, see design-system.md. Source and target both live on the ISLAND's surface (`IslandWindow.ts` — the capsule moved there with the modes precisely so this stays a plain same-window `compute_bounds`; a version that split them across two surfaces needed a coordinate bridge AND made both surfaces paint glass over the same pixels mid-morph, whose blurs stacked into a visible seam), `WorkspaceDot.ts` (`makeWorkspaceDot` + `WS_COUNT` — the ONE workspace state dot, shared by the bar capsule, the overview card headers and the morph's ghosts; all three must render identically for the morph's endpoint swaps to be invisible), `BatteryGlyph.ts` (`makeBatteryGlyph` + `batteryPresent`/`batteryFrac` — the ONE Cairo battery glyph: bar widget, CC tiles and the island's battery activity all render through it; semantic danger/success fill, never the accent. It is `battery.svg` redrawn in Cairo on the same 24-unit Lucide grid, and its argument is the **icon box in px = `Gtk.Image.pixel_size`**, not a glyph height: pass 16 in the bar and its capsule is exactly as wide as every icon widget's, 28 in CC tiles where siblings use `pixel_size: 28`. Sizing it by eye is what once made the bar's battery capsule 9px wider than its neighbours. Matching the set means matching INK WEIGHT too: the chrome strokes at 0.9 because `.bar-left image` attenuates nothing — a half-alpha stroke at true icon scale reads as a washed-out hairline and the glyph looks smaller than icons whose ink box is the same width. Painter and `battery.svg` are ONE drawing on one grid — edit both or neither, or the shell ends up with two batteries (the SVG is what Settings, the widget picker and the no-battery state show). Its ink deliberately spends Lucide's 22-unit content box out to the full 24 so the charge cavity stays legible at 16px; the 1.5-unit gap before the terminal nub is the floor, below which the two shapes antialias into one smudge at bar size), `poll.ts` (`pollWhileMapped` — ANY recurring widget poll must gate on map/unmap: built-once-hidden surfaces like CC tiles must not keep session-long timers; idle baseline is 0 wakeups/s and we keep it that way), `MenuRow.ts` (`menuRow`/`menuSeparator`/`menuHeader`/`setRowChecked` — the shared row builder for flat `nidara-menu-*` lists; used by the CC context menu and the bar window menu. New flat menus use it, not hand-rolled rows)
  - `bar/WindowMenu.ts` — the **window-options menu**: any-button click on the AppTitle capsule opens it in the bar's shared expansion capsule (`openCustomExpansion`, same system as tray menus — glass/fade/anchoring/outside-click for free). Anchoring defaults to **centered** under the pill (fine for right-side tray menus), but left-edge capsules pass `align: "start"` so the panel's left edge sits flush with the pill's — AppTitle does, because a centered panel there spills off the left screen edge. Sections: window actions (float/pseudo/fullscreen + center/pin when floating; all checks from the one `hs.getClientJson` read), inline move-to-workspace strip (1..5, current disabled), **group/tabs (v2, 2026-06-11)**, workspace actions (float all). The group section reads `grouped` (member addresses in tab order) from the same json read: one `menuRow` per member (checked = the menu's window, i.e. the active tab; clicking another member = `hs.focusWindow` — focusing a member IS the tab switch), plus "Move Out of Group" (`hs.moveOutOfGroup`, only when ≥2 members) and "Ungroup" (`hs.toggleGroup(addr)`, dissolves the whole group); ungrouped windows get a single "Create Group" row (lone group → groupbar appears, others join by drag/keybind). Astal clients are used for tab LABELS only (identity: wordmark/title) — never state. Deliberately absent: "move into group" (`into_group` ignores the window selector — acts on the focused window only — and needs a direction, meaningless in a menu) and group-lock (`lock_active` dispatches fine but its state is not readable anywhere, and a check you can't read is bad menu UX). **Stale-focus guard (2026-08-15)**: every row closes over the address captured at open, so the menu CLOSES ITSELF if the focused window changes while it is up — it watches `hs` `"changed"` and compares `bareAddr(hs.focusedClient.address)` against the captured one, bracketed by the root widget's `map`/`unmap` (the expansion rebuilds its content per open, so that is exactly one showing; a re-map re-checks what it slept through, deferred to an idle so the first map cannot re-enter `showExpansion`). The gap it fills is that **the bar's focus grab is only cleared by an outside PRESS** — Alt+Tab, a keybind, or the window simply closing move focus with no click at all, so nothing dismissed the panel and the AppTitle capsule renamed itself to the new window while the menu kept acting on the old one: one label naming two windows. Read the RECONCILED `hs.focusedClient`, never `hl.focused_client` — acquiring the grab can make the compositor announce "no active window", and `"changed"` only fires when the structural signature actually moved, so neither opening the panel nor a churning title can close it. This is also why `input:follow_mouse` is **2** in `hyprland.lua` (pointer focus detached from keyboard focus): under `1`, merely travelling to the capsule re-focused every window on the way.
  - `bar/Tray.tsx` — the **system tray** (SNI, over `core/tray.ts` since 2026-08-18). **Per-icon capsules (2026-07-15)**: each item is its OWN `SquircleContainer` with the exact bar-capsule params (`gloss`+`chrome`+`opacityRole:"bar"`+`CAPSULE_BORDER`+`hoverBorderAccent`+`perfect`), so tray icons read as first-class bar icons, NOT one grouped pill. `Tray.tsx` returns a plain `spacing:8` container (Bar appends it raw — no outer capsule — and it self-hides while empty). The icon carries `margin_start/end:16` → the button is 48px and fills the capsule, so the whole capsule left/right-clicks. **Right-click** → the app's DBus `menu_model` rendered by us via `openCustomExpansion` (same glass expansion as the window menu, never a native GTK popup; built **lazily on first open**, which used to be a workaround for the appmenu-glib-translator crash and is now plain economy — N items would otherwise mean N `GetLayout` round trips at boot, waking every tray app to build a menu nobody asked for. `about_to_show()` now runs on EVERY open (the spec's point: the app refreshes its rows), and it is async, so a wedged app costs a stale menu instead of a frozen bar). **Left-click** → raise the app's OWN window. Why NOT just `item.activate()`: SNI Activate means "raise your window", but a Wayland client CAN'T self-focus or pull you to its workspace (compositor blocks self-activation), so `activate()` returns OK yet nothing happens for a window parked on another workspace. Nidara IS the compositor's shell, so it raises the window itself, matching tray-item→window best link first: **(1) PID** — `GetConnectionUnixProcessID(busName)` on the item's bus (`item_id` is `<busname>/<objectpath>`) vs each `hs.clients[].pid`; deterministic, verified exact for Telegram + Antigravity; misses only proxied/legacy X11 icons whose bus owner is the proxy. **(2) name heuristic** — normalise the item's `id`/`icon_name`/`title` AND the window `class` to bare alphanumerics, accept when one contains the other (`org.telegram.desktop-attention-symbolic` ⊇ `org.telegram.desktop`; `Antigravity_status_icon_1` ⊇ `antigravity`). **(3) `item.activate()`** — only when no window matches (app truly minimised to tray with no surface → let it restore). Items that **declare** `ItemIsMenu` (no activate action) open the menu on left-click too — note the property defaults to FALSE per spec and `core/tray.ts` honours that, where AstalTray defaulted it to true and sent every app that omits it (most of them) down this branch. The PID is resolved async once per item and cached; a click before it resolves just falls through to the heuristic.

Other top-level dirs: `ui/lib/nidara-kit/` (pure-GTK4 primitives lib — see end of file) and the greeter/lockscreen bundles. `ui/lib/` itself holds small modules shared ACROSS bundles: `users.ts` (user enumeration + avatar path resolution — used by greeter, lockscreen AND Settings → Users; its displayName falls back GECOS→username. Never use `GLib.get_real_name()` for a display name: it returns the literal string "Unknown" when GECOS is empty, which is how archinstall creates users, and it caches at process start so it goes stale after a rename), `avatar.ts` (circular avatar for greeter+lockscreen — Gtk.Picture + center-crop pixbuf + pill radius, the same recipe as Settings → Users; plain Gtk.Image can't clip to a circle), `accent.ts` (the 9 accent hexes — and, since 2026-08-15, `hexToFloatRgb`, because the kit's slider fills with the accent in Cairo and `common/DrawingUtils.ts` is the shell's), `signals.ts` (`safeDisconnect` — moved here the same day for the same reason; `core/signals.ts` re-exports it so the shell's 40 import sites did not have to churn), `status-colors.ts`.

## `core/` services (singletons)

These are GObject singletons. Widgets subscribe to them via `notify::prop`. **None of them ever import a widget or call UI code directly** — state flows out, never in.

| File | LOC | Role |
|---|---|---|
| `Status.ts` | 202 | Central GObject state machine for overlays. Mutually-exclusive setters (opening one closes the others). Props: `cc/nc/prism/system-menu/about/settings-open`, `island-mode` (Activity Island mode string, "" = collapsed; replaced `overview-open`), `recording`, `cc-edit-mode`, `bar-expanded-id`, `cc-detail-id`. Exports island mode ids (`ISLAND_OVERVIEW`, `ISLAND_PLAYER`, `ISLAND_BATTERY`). **See `state-and-ipc.md`.** |
| `InputYield.ts` | ~125 | The shell **stepping out of the way** so computer-use can reach a real window. A grabbing surface CLAMPS pointer focus to itself, so from inside the Assistant island (always grabbing) clicks were swallowed and `focus_window` was a no-op. (Under the old layer-shell path the reason was different and stronger — `rawWindowFocus` refuses to move window focus at all while a surface is in `m_exclusiveLSes` — which is why this module survived the focus-grab migration rather than dying with it.) `begin()` makes every grabbing surface RELEASE its focus grab **and** stamp an empty input region, resolves only once the compositor has ANNOUNCED the release (`HyprlandState.afterGrabRelease`), `end()` restores. Driven by the HELPERS via the `yieldInput` IPC (so external MCP clients are covered too), re-entrant, with a 15 s watchdog so a helper that dies mid-action cannot leave the shell keyboard-less. Surfaces opt in with `registerHolder()` + a `notify::active` handler: Bar (Prism), IslandWindow, AppGridWindow. (It was DockCore until 2026-08-09 — the grid was the only thing on the dock's window that ever grabbed, and it left with its own surface, so the dock now holds nothing and asks for nothing.) **See `state-and-ipc.md`.** |
| `AppService.ts` | 855 | `.desktop` discovery, icon resolution + fallbacks, WM-class → Desktop-ID mapping. Backs Dock + AppGrid + Prism. **Two catalogues, and picking the wrong one is a silent bug**: `getAllApps()` is the WHOLE registry including `NoDisplay`/`Hidden` entries (24 of 80 on a normal Arch box) because a hidden entry is still what names a window and owns its icon — that is the IDENTITY catalogue. `listApps()` is the launchable subset (`AppData.visible`, from `g_app_info_should_show()`) and is what a launcher may put on screen. `queryApps(q)` ranks the launchable subset (app grid, uncapped); `search(q)` ranks the WHOLE registry capped at 8 (Prism, the agent's `launch_app`) because a name somebody TYPED is evidence they want that specific thing — the agent run that motivated the ranker's rescue tier was asking for GTK Widget Factory, a `NoDisplay=true` entry. Both rank through `core/app-search.ts`, so the two surfaces can never disagree about what "files" means. `AppData.icon` is the CANONICALIZED icon (what you draw); `AppData.rawIcon` is the `Icon=` field verbatim (the key an override is filed under). **Launching: ALWAYS go through `getLaunchCommand(id)`** (wrapped in `uwsm app -- sh -c 'cd "$HOME" && exec <cmd>'`): it picks `flatpak run` for flatpak entries (gtk-launch's D-Bus activation dies silently for them when the session bus indexed its service dirs without the flatpak exports) and `gtk-launch` for everything else. Never parse `Exec=` by hand. Flatpak/Snap *discovery* requires `XDG_DATA_DIRS` set **before gjs starts** — done in `bin/nidara-ui`; GLib caches data dirs at first use, so patching the env in-process cannot fix it (verified 2026-06-12). **Icon LOOKUP is centralized here; app IDENTITY is the step surfaces keep skipping** (both bugs below found 2026-08-02, from one user report). `getIconName` answers "what art is this icon name", never "which app is this thing" — so a surface holding a foreign identity string must normalize it FIRST, and there are three entry points depending on what you hold: **`resolveWindowApp(class)`** for a Hyprland window, **`iconForAppName(name)`** for a human display name, **`isGenericIconName(n)`** to test whether a name you were handed is a placeholder rather than an answer. Skipping the step doesn't error — it renders the generic glyph, so the only symptom is two surfaces drawing the same thing differently. Concretely: the workspace overview fed `c.class` straight in, and since no theme has an icon called `io.Astal.ags`, **Settings drew the generic glyph in the overview and its registry icon in the dock** (the dock normalizes; the overview didn't). And the CC/Settings audio rows took the audio stream's `icon` at face value — but that property is NEVER empty (a rule `core/wireplumber.ts` deliberately kept when it replaced AstalWp, because the UI depends on the placeholder being resolvable): a client declaring no `application.icon-name` gets `application-x-executable-symbolic`, a perfectly resolvable name for the generic glyph, so **GNOME Clocks played audio under a gear**. Same rows also had the app name wrong: on an audio stream `name` is the STREAM ("Playback", from `media.name`) and `description` is the client ("Clocks"). ⚠️ **A stream has NO `node.description` at all** (measured 2026-08-18 against a live Chrome and a `pw-cat`), so that client name reaches the UI only through the fallback chain `node.description → node.nick → node.name`; drop the chain and every per-app row goes blank. The notification centre survives both only because it asks the registry FIRST (`getResolvedApp(desktop_entry || app_name)`) — its no-match fallback was hardened the same day. **The audit behind those fixes is done: every icon call site in the shell is listed by `grep -rn "getIconName(\|iconForAppName(\|resolveIconChain(\|resolveWindowApp("`, and all of them now normalize. `surfaces/bar/Schematic.tsx` was deleted in the same pass** — 195 dead lines nothing imported, superseded by `common/WorkspaceSchematic.ts`, still carrying both bugs plus `nd-icon` on app icons. Dead code that models the wrong pattern is worse than none; it is what a grep finds first. For ordered icon-name fallback chains use `resolveIconChain(names)` (theme-first: any name in the ACTIVE theme beats earlier names that only exist in deep fallbacks or shipped assets; absolute-path entries = final custom fallback) — plain `getIconName(array)` exhausts deep fallbacks per name. Icon resolution NEVER mixes themes: per-app override (`~/.local/share/icons/nidara/`) → active theme (+ its `Inherits`) → hicolor (the app's own installed icon) → pixmaps. An icon the active theme lacks is fixed via the Settings → Apps per-app override, never by borrowing from another installed theme. When nothing resolves, app surfaces (dock, app grid, Prism, overview) fall back to `application-x-executable` (the active theme's generic app icon) — never GTK's broken-image `image-missing`. **Per-app override GOTCHA:** overrides are stored under the basename key (`iconOverlayKey`, e.g. `/opt/foo/bar.png` → `bar`), and `AppData.icon` is **canonicalized to the resolved override PATH** once one exists — so callers usually hold a *path*, not a name. Any override lookup (`getIconOverridePath`/`removeIconOverride`) must normalize through `iconOverlayKey` (idempotent on keys), or Restore/badge/delete silently no-op on path-valued icons (bit App Icons for Antigravity, fixed 2026-07-04). After `set/removeIconOverride` (which call `reload()` **synchronously**) re-read fresh state via `getAppData(id)` — the caller's own `AppData` is a stale snapshot whose `.icon` may point at a just-deleted overlay file. **A theme change is a TWO-STEP, and the order is load-bearing** (fixed 2026-08-18): GTK announces it via `GtkIconTheme::changed`, `AppService` re-resolves the whole registry on a 2 s debounce (the delay exists to avoid a GListStore conflict during start-up) and only THEN `emit()`s — so a surface that caches ART must rebuild on that emit, never on the raw signal, or it re-reads the pre-change registry. The dock is the surface that caches: every `DockItem` rasterizes its icon into a 128 px `GdkPixbuf` once and paints that, so nothing repaints by itself. It used to invalidate on `Theme.iconTheme` — OUR appearance.json value — which cannot see either case that matters, because in both of them it does not move: on a virgin account it already reads "Papirus" while GTK is still on the schema default, and a theme changed from outside (gsettings, another DE's control panel) never passes through it at all. It compares the live `Gtk.IconTheme.get_theme_name()` now. The same ordering decides the FIRST frame, one layer down: GTK resolves icons through the value the settings portal serves from **gsettings** (`settings.ini` loses to it), while `ThemeManager` only pushes appearance.json's `iconTheme` about two seconds into the session — so on a clean install everything drawn before that kept the schema default until the shell was restarted. `bin/nidara-setup` now seeds the gsetting BEFORE the first login (never overwriting a key the user has set). Instrument for both: `scripts/dev/icon-theme-probe.js`. |
| `TrashService.ts` | ~125 | Watches the trash (gvfs `trash:///` + `trash::item-count`, aggregates all volumes; falls back to a FileMonitor on `~/.local/share/Trash/files`). Exposes `isEmpty`/`itemCount` + `subscribe`. Drives the dock trash icon (full ↔ empty, swapped in place by DockItem). |
| `ThemeManager.ts` | 534 | GTK/icon/cursor theme, dark mode, CSS providers (main/font/tokens/tint), hot-reload of `style.css` in dev. Also pushes the accent into Hyprland's **groupbar** active-tab color (`syncHyprlandGroupAccent`, at boot + on accent change, via `hs.evalLua`) — the one place accent enters compositor chrome; the rest of the group styling is static in `hyprland.lua`'s `group` block (glass borders like windows). Gotcha: a groupbar **bakes its colors at group creation** — config changes only affect groups made afterwards. **Font gotcha:** the interface font is the one appearance prop NOT in `appearance.json` — it's delegated to the GNOME `font-name` gsetting (`syncFont`/`setFont`/`settings.ini` all read it). ⚠️ **That value is a PANGO font string and must be parsed with `Pango.FontDescription.from_string`, never a regex** — only its simplest form is `Family <int>`; a style word (`Inter Variable Medium 11`), a fractional size or a variation axis (`… @wght=500`) are all legal and all come out of the Settings font button. A `/^(.*?) (\d+)$/` here silently resolved to `sans-serif`, so picking such a font dropped the whole desktop onto fontconfig's default with no error anywhere but the `Font Sync:` log line (found 2026-08-11; a dev machine had been rendering Noto Sans for months). `applyAll` **seeds it to `Inter 15px` on first boot**, but only when `get_user_value("font-name") === null` (factory default, not an explicit pick) — otherwise a fresh Arch + GTK ≥4.22 leaves it at `Adwaita Sans 11`. `monospace-font-name` is seeded the same way to `JetBrains Mono 11` (the schema default names Adwaita Mono, a font Nidara doesn't install; JetBrains Mono ships with every install — as the plain typeface plus `ttf-nerd-fonts-symbols-mono`, never the 232 MiB patched `ttf-jetbrains-mono-nerd`). ⚠️ **Sizes are stored in absolute PIXELS** (`snapFontToWholePixels`, one door on the way in), which has a consequence worth knowing before touching anything font-related: an absolute size is immune to dpi, and `text-scaling-factor` works by multiplying dpi — so the accessibility slider only moves text because `syncFontsToScale` applies the factor in TypeScript, from an unscaled `state.fontBase` kept in `appearance.json`. The getters split accordingly: `interfaceFont`/`monoFont` return the BASE (what the picker edits), `effectiveFont` returns base × factor (what `settings.ini` must carry, since a GTK3 app won't apply the factor to an absolute size itself). |
| `NidaraTheme.ts` | 436 | Token engine: `generateTokensCss()` emits `@define-color` + `--nidara-*` for accent, transparency, materials, shadows, tint. Holds the canonical `ACCENT_PALETTE`. Syncs Kvantum/qt. |
| `RegionConfig.ts` | 218 | Time/date format, timezone (`region.json`). |
| `configFile.ts` | 44 | `loadKnown(DEFAULTS, parsedJson)` — the one way a settings JSON is loaded. See the rule below. |
| `InputConfig.ts` | 194 | Keyboard/mouse/touchpad → writes `nidara-settings.lua`. |
| `HyprlandState.ts` | ~290 | Reactive wrapper over AstalHyprland (clients/workspaces/monitors + dispatch helpers) **and the ONLY door to hyprctl**. `focusedClient` is a **reconciled** accessor, not a proxy — it enforces one invariant, *the focused window is always on the focused workspace*. It was built against two opposite EXCLUSIVE-era lies (the null Hyprland announced when a layer surface released an EXCLUSIVE grab, and the stale non-null it kept returning while one was HELD, which left the app grid's workspace strip naming the workspace you had just left) — **both causes are gone with the focus-grab migration, and the accessor stays anyway, because it is now the INPUT to the root fix rather than a patch over it**: the remembered window is who `restoreFocusAfterGrab` hands the keyboard back TO, and validating the live answer is that repair's correctness guard (focusing a window on another workspace DRAGS THAT WORKSPACE over the user). Audited 2026-08-07; don't simplify it back. Fallback chain and the scratchpad exception in `state-and-ipc.md`; read it, never `hl.focused_client` — services/widgets never shell out to hyprctl directly; they call (or add) a method here. Vocabulary: dispatch helpers (`focusWindow`/`closeWindow`/`floatWindow`/`togglePseudo`/`togglePin`/`toggleFullscreen`/`centerWindow`/`sendToWorkspace`/`toggleGroup`/…, all `hl.dsp.*` Lua via a private `_dispatch` that logs the offending call), `getClientJson(addr)` (one-shot raw `clients -j` read for fields AstalHyprland.Client lacks: `pinned`, `grouped` — on demand only, never in `_refresh`), `evalLua(call)` (live config changes — the Lua parser rejects `keyword`), `getOptionInt(name)` (sync) / `getOptionJson(name)` (async batch re-syncs), `setCursor(theme, size)`, `setRealCursorVisible(visible)` (`cursor:invisible`; rendering only, input unaffected — sole caller is the agent-pointer overlay, which hides the real pointer for the length of an AI action because the hardware cursor plane paints above every layer surface; **whoever hides it owns restoring it on every exit path**), `setGlow(enabled)` + `supportsGlow()` (`decoration:glow`, driven only by `AgentGlow.ts`), `version()`. **`focusWorkspaceFromShell(id)` is the single door for a workspace switch driven by one of OUR surfaces** (the app grid's strip, the island's overview) — it forwards to `focusWorkspace` today, and exists so those two cannot drift apart; its predecessor `focusWorkspaceOnGrabRelease` is DELETED, along with the EXCLUSIVE-era grab-lending it did (`tech-debt.md` §53). `restoreFocusAfterGrab()` is the one that still does real work: after our machinery lets go of a focus grab, the compositor refocuses by POINTER, so a dismissal with the cursor over the wallpaper leaves the session with no active window — it hands the keyboard back, guarded to fire only when nothing is focused and only on the workspace being looked at. Caches **effective** config AstalHyprland doesn't expose (`availableModesByName` — `Monitor.available_modes` is always null) and emits `config-reloaded` on Hyprland's `configreloaded` IPC event (effective-config consumers re-sync on it). Exempt from the single-door rule: config text *written for other daemons* (the hypridle config generated by Power.tsx — those lines execute outside the shell; the before/after-sleep hooks themselves are static scripts in `bin/`). |
| `NightLightManager.ts` | 174 | Blue-light filter via hyprsunset (`night-light.json`). |
| `WallpaperManager.ts` | 170 | Wallpaper + transitions via `awww` (`wallpaper`). Reads/merge-writes the JSON through `ui/lib/wallpaper.ts` (shared with the lockscreen, which paints its own copy — the schema reserves a per-surface `surfaces` block; see tech-debt "Wallpaper resolution is centralized"). Two-way synchronized with GNOME's `org.gnome.desktop.background` (`picture-uri` / `picture-uri-dark`) for seamless compatibility with Nautilus, Loupe, and GNOME apps, plus desktop portal integration via `nidara-ipc setWallpaper`. |
| `MonitorConfig.ts` | ~120 | Per-monitor mode/scale/rotation + VRR → `nidara-monitor.lua`. Applies at runtime via **`hyprctl eval "hl.monitor({...})"`** (see the Lua-parser note below). `applyMode`/`applyTransform` apply without persisting; `commit()` writes the .lua — used for the revert-safety dialog on resolution/rotation changes. |
| `Icons.ts` | 92 | `nd-*-symbolic` icon catalog. |
| `WidgetConfig.ts` | 88 | CC widget metadata/registry (`widgets.json`). |
| `GamingManager.ts` | 79 | Game-mode state + `gaming.json`. |
| `NotifConfig.ts` | ~90 | Popup auto-dismiss timeout **and Do Not Disturb** (`notif-config.json`). DnD moved here on 2026-08-18 with `core/notifd.ts`: it was never daemon behaviour — AstalNotifd's own docs say the property "does not have any effect on its own; it is merely a value shared between the daemon process and proxies", and it sat in GSettings so several Astal processes could read one bit. Nidara is one process, and what consults the flag is the BANNER layer, which is UI policy. 🔑 Listeners are told WHICH key moved (`onChange(key => …)`): DnD has four faces watching it and the timeout slider one, so an untyped callback made every face repaint on the other's change. `setDoNotDisturb` is guarded on equality — the Settings switch and the CC tile both write on every interaction. What must NOT come back is a SECOND copy of the flag (the retired `dndDefault` was one). |
| `RecordingConfig.ts` | ~250 | Screen-recording preferences (`recording.json`) **and the wf-recorder command they build** — `buildCaptureCommand({region, audio})` returns `{argv, outFile, audioDevice}` so the widget owns only screen-or-region and audio-on-or-off. Everything here was measured against wf-recorder 0.6.0, not assumed, because each one silently produces a plausible file instead of an error: **(1)** `--audio` with no device records the default PulseAudio **source** — a microphone, never the desktop — which is why `audioSource` exists and defaults to the `@system` sentinel (resolved at capture time to `<default sink>.monitor`). This was the "recording has no sound" bug: on a machine whose default source was a webcam's unconnected S/PDIF port, "include audio" meant "record silence". **(2)** The long option's argument is *optional* (getopt), so it only binds as `--audio=NAME`; `["--audio", name]` as two argv entries drops the device and falls back to the default source. **(3)** An unknown device name does **not** fail — pipewire-pulse substitutes the default source — so `resolveAudioDevice()` verifies a saved name is still on the bus before using it. **(4)** VAAPI encodes H.264 fine, but `vp9_vaapi` returns "Function not implemented" on Navi 10, so hardware encoding is offered for the H.264 containers only (`CODECS` table; webm is always software VP9). Quality presets are spelled out per encoder (x264/VP9 take `crf`, VAAPI takes `qp` — same polarity, different scales), and libvpx-vp9 needs `b=0` alongside `crf` or it ignores the crf entirely. Surfaced in Settings via `widgets/screenrecord.ts` `buildSettings`, and to agents as `recording.*` in `config-entries.ts`. |
| `app-search.ts` | 268 | **How a typed query becomes a ranked list of apps** — pure functions, no GObject, called only by `AppService`. Replaced AstalApps' `fuzzy_query` on 2026-08-17. A query is scored against four fields (name, desktop id, executable BASENAME, keywords) and the app's score is the **best** field, not the sum, so three weak matches cannot beat one strong one. Five tiers — exact, prefix, word prefix, substring, acronym — and a sixth rescue tier for a query with a word too many ("GTK Widget Factory" for a .desktop called "Widget Factory"). Tiers never overlap: the length tie-break is <1 point. **Three rules that exist because a live run broke without them**, all measured 2026-08-17: (a) the executable is the BASENAME — AstalApps matched the whole `Exec=` line, and every Chrome web app's `--profile-directory=Default` spells f-i-r-e, so typing "fire" in the launcher returned five PWAs and nothing else; (b) the substring and acronym tiers need ≥2 characters — one character is a substring of almost everything (AstalApps returned 56 of 56 apps for "f", because its single-char branch dropped an app only at score exactly 0 and a total miss scores −30); (c) the field weights (name 1, id 0.85, exec 0.78, kw 0.65) are chosen so the 4×5 table has no collisions and two specific orderings hold — an id PREFIX cannot beat a name WORD_PREFIX (every PWA's id begins "chrome-", so at 0.9 the query "chrom" put Google Chrome SIXTH behind its own web apps), and a PARTIAL keyword cannot beat a match inside a name (Micro declares keyword "terminal" and was jumping XTerm). Matching is accent-folded, and `fold()` is deliberately 1:1 per character so word-start indices stay valid. Probe: `scripts/dev/apps-probe.ts`. |
| `bluez.ts` | ~410 | **The shell's ONLY door to BlueZ**, and the layer under `BluetoothService`. Replaced AstalBluetooth on 2026-08-18: that was 681 Vala lines over `Gio.DBusObjectManagerClient` on `org.bluez`, and there is no library beneath it — same shape as MPRIS. One `GetManagedObjects` seed plus `InterfacesAdded`/`InterfacesRemoved`, a `Gio.DBusProxy` per adapter and per device (so property caching and `g-properties-changed` come free), and a name watcher so a bluetoothd restart empties and refills the roster instead of leaving dead proxies. Devices stay **GObjects with real properties** because consumers listen per object (`watchDevices` wires `notify::paired/connected/name` on each). Same snake_case-accessor rule as `mpris.ts` — declare the PAIR or the ParamSpec gets auto-generated storage and reads stale forever. **Three traps this file paid for, all found by RUNNING it, and all of them the same mistake in different clothes — a property whose setter has a side effect:** (1) `_sync` assigned `this.trusted = …` from `PropertiesChanged`, and that setter WRITES to BlueZ, so every notification echoed back onto the bus and the throw aborted the seed loop — the shell saw one adapter and zero devices. Reading from the bus needs its own internal path (`_setTrusted`), and `_add` now try/catches per object so one bad device cannot cost the roster. (2) `Gio.DBusProxy.call()` takes a METHOD name and speaks the proxy's own interface, so writing a property through it fails with "Expected an object of type GVariant for argument 'parameters'" — properties go through the CONNECTION (`setProp`), naming object, interface and method. (3) Seeding only from the name watcher looks right and is not: `appeared` arrives through the main loop, so anything reading `devices()` in the same tick as `get_default()` got an empty roster. Seed synchronously, guarded by `NameHasOwner` — that guard is also what stops a machine with no radio logging a CRITICAL at every boot. Probe: `scripts/dev/bluez-probe.ts`. |
| `notifd.ts` | ~470 | **The shell's OWN notification server** — it owns `org.freedesktop.Notifications`, so every `notify-send`, browser toast and chat message on this desktop arrives here. Replaced AstalNotifd on 2026-08-18: same shape as `mpris.ts`/`bluez.ts` (a freedesktop spec with no library beneath it), and the Vala it replaces was a `Gio.DBusExportedObject` doing exactly this. Notifications are **plain objects, not GObjects** — no consumer listens to a single notification, they listen to the daemon (`onNotified`/`onResolved`) and re-read — which skips the ParamSpec accessor trap `mpris.ts` documents. 🔑 **`app.ts` starts it explicitly (`startNotifServer()`), not lazily**: the first caller used to be the bar's bell widget, so deleting or reordering that widget would have quietly stopped the desktop receiving notifications at all. Being the server is not a widget's responsibility. 🔑 **`GetCapabilities` is a PROMISE to the sender**, and AstalNotifd shipped the spec's example list wholesale — including `sound` (obliges the server to play `sound-file`; a client that believes it suppresses its OWN sound, so the notification just arrives silent), `body-hyperlinks` (the card strips tags, so an `<a href>` loses its URL whereas a sender told otherwise writes it out as text) and `action-icons`. Nidara answers only the six it honours. **Store and decoded images live in `~/.cache/nidara/notifd/`, NOT `~/.config/nidara/`, for privacy rather than tidiness**: the config dir is a READ ROOT of the assistant's file layer (`allowFileRead` defaults ON), so a notification store there would hand every chat message that ever popped up to the model by default. `image-data` (raw pixels) is decoded to a PNG named by content hash and re-hinted as `image-path`, so the card only ever reads one shape; the legacy `image_path` spelling is read too (Chrome sends BOTH, and AstalNotifd read only the modern one). `transient` is excluded from the store, per spec. What did NOT come across: `dont_disturb` (never daemon behaviour → `NotifConfig`), proxy mode (half of AstalNotifd exists so a second Astal process can client the first), and `ignore_timeout`/`default_timeout` (no UI ever set either). Probe: `scripts/dev/notifd-probe.ts`. |
| `mpris.ts` | ~410 | **The shell's ONLY door to MPRIS**, and the layer under `MediaService`: one `NameOwnerChanged` subscription (server-filtered with `MATCH_ARG0_NAMESPACE`) for the roster, two `Gio.DBusProxy` per player (root interface for `Identity`/`DesktopEntry`, Player interface for the rest). Players are **GObjects with real properties** because the media consumers do listen per object (`connect("notify")`, `notify::playback-status`) — the accessors are declared in snake_case (`playback_status`, `can_go_next`) since that is what the call sites use AND what GJS binds to the ParamSpec; a getter without its setter fails at registration, and a ParamSpec with no accessor of ours gets an auto-generated one backed by separate storage that reads stale forever. **`position` is deliberately NOT a GObject property**: the MPRIS spec excludes `Position` from `PropertiesChanged` and tells clients to extrapolate at `Rate`, so it is a plain accessor computed from an anchor (re-anchored on status/track change, `Seeked`, our own seeks, and a lazy async resync at most every 10 s, only when somebody reads it). AstalMpris polled it at 1 Hz instead — that is where every "notify storm" guard in the media widgets came from. Seeking prefers `SetPosition` and falls back to a relative `Seek` when the track has no `mpris:trackid` (where `SetPosition` is a spec no-op). Probe: `scripts/dev/mpris-probe.ts`. |
| `tray.ts` | ~470 | **The shell's OWN StatusNotifierItem watcher AND host** — it owns `org.kde.StatusNotifierWatcher`, so every app that puts an icon in the bar registers here. Replaced AstalTray on 2026-08-18, the LAST Astal service: another D-Bus spec with no library beneath it, same shape as `mpris.ts`/`bluez.ts`/`notifd.ts`. Items are **plain objects, not GObjects** (`onChanged`/`onIconChanged` return unsubscribe functions) — there is one consumer, and AstalTray's churny items are exactly where `notify::` closures on a soon-to-be-freed GObject fed a `g_param_spec_unref` UAF that segfaulted the UI minutes later. A plain object has no ParamSpecs to over-unref. **Four deliberate departures from AstalTray, each one a bug it had:** (1) **`ItemIsMenu` defaults to FALSE**, per spec — AstalTray defaulted it true, turning left-click into a menu open for every app that omits the property, which is most of them. (2) **Items are keyed by bus name AND object path.** AstalTray's watcher kept one entry per bus name, so an app publishing two icons from one connection had the second overwrite the first and one icon stayed in the bar, dead, until the shell restarted. (3) **Signals invalidate only what they name** (`SIGNAL_PROPS`) — AstalTray answered every signal with a full `GetAll`, and its `update_gicon` re-walked `IconThemePath` RECURSIVELY, uncached, up to seven times per refresh, on the main loop. The walk is cached here and consulted only when the icon changed. (4) **It also claims `org.kde.StatusNotifierHost-<pid>` and calls `RegisterStatusNotifierHost`** — libappindicator checks for that owner before publishing, and AstalTray never claimed one (it forced `IsStatusNotifierHostRegistered` true instead, which only works while IT is the watcher; that hack is kept, for the apps that never re-register). Pixmaps are ARGB32 in network byte order and are rotated to RGBA before `GdkPixbuf`. Falls back to FOLLOWING a foreign watcher (plasmashell, a stray astal-tray) rather than going empty. Probe: `scripts/dev/tray-probe.ts`. |
| `dbusmenu.ts` | ~210 | **`com.canonical.dbusmenu` → a live `Gio.Menu` + `Gio.SimpleActionGroup`**, the client half of tray context menus. It replaced `appmenu-glib-translator` — a hand-pinned GitLab dependency that existed for `libastal-tray` alone — on 2026-08-18. 🔑 **Why ~210 lines replace ~2100 of C:** the translator keeps a GMenuModel in sync item-by-item (one model object per submenu, `GetLayout` at recursionDepth=1 per level, section diffing, `items-changed` at the right index). Nidara's ONE consumer, `common/NidaraMenu.ts`, FLATTENS the whole model into a `Gtk.Box` on every render — so all of that machinery was being paid for and thrown away. Here it is one `GetLayout(0, -1, …)` for the entire tree, rebuilt into the SAME `Gio.Menu` (`remove_all()` + re-append emits `items-changed` for free, which is the signal the bar already listens to). That also deletes the code that was crashing: the translator's `layout_parse`/`get_layout_idle` is what the coredump showed behind a ~140 TB `g_malloc`, and there is no incremental parser here to corrupt. Two more fixes fall out: `visible: false` rows are DROPPED (the translator drew them — verified on screen), and `Event` is sent ASYNC (`dbus_menu_xml_call_event_sync` ran on the main loop at the default 25 s timeout, so one wedged tray app froze the shell). ⚠️ Parity gap kept on purpose: `toggle-state` becomes stateful actions but nothing draws a checkmark, because NidaraMenu reads labels/actions/links only — that was already true with the translator. |
| `MediaService.ts` | ~235 | **Facade with selection state** over `core/mpris.ts` (it re-exports `PlaybackStatus`, so a surface never imports the D-Bus layer): owns WHICH MPRIS player the shell shows (widgets must never call `get_players()[0]`). Auto heuristic — a PLAYING player beats paused ones, ties go to the most recent playback-status change; manual pin `pinPlayer(busName\|null)` (session-scoped, auto-resumes when the pinned player leaves the bus); `subscribe(cb)` fires on selection change AND async cover-art arrival; `playerLabel`/`playerAppIcon` (desktop-entry GIcon for the selector menu); `resolveCoverArt` — art chain `file://` → a bare path → `data:` decode → `http(s)` curl into `~/.cache/nidara/media-art/` (pruned past ~150 files, failures negative-cached so a dead URL isn't retried at the 1 Hz position poll). Consumed by `widgets/media.ts` (the shared detail panel incl. the source-selector glass menu — exported as `buildMediaDetailPanel`, also the content of the island's player mode. **No bar variant since 2026-08-02**: the island already carries the player as an activity the moment an MPRIS player is live, so a bar pill with its own transport buttons stated the same service twice, one capsule apart — `locations: ["cc"]`, `buildBarContent`/`buildBarExpanded` deleted. A widget losing its bar variant leaves a `"bar": true` behind in every existing `widgets.json`, which is why `WidgetConfig.barWidgetIds()` now intersects with `BAR_ORDER` instead of appending unknown ids: a stale flag used to consume one of the bar's limited icon slots before the render loop skipped it for having no `buildBarContent`), `MediaIsland.tsx` (CC tile — ONE shared `MediaState` singleton across tile rebuilds) and `surfaces/island/` (`PlayerCompact` + the `ActivityIsland` activity controller; note `subscribe()` fires on SELECTION change, not on a playback-status flip of the same player — anyone tracking play/pause must also connect `notify::playback-status` on the current player, as all three consumers do). Test with `scripts/dev/fake-mpris.js` (dev-workflow.md). Never imports Gtk. |
| `hypr-ipc.ts` | ~230 | **The shell's ONLY door to Hyprland's sockets**, and the lowest layer in `core/`: `.socket.sock` takes a command and answers JSON, `.socket2.sock` streams `EVENT>>DATA`. No caching and no derived state — `HyprlandState` owns all of that and is the only module that may import this one. Exposes `getClients`/`getWorkspaces`/`getMonitors`/`getActiveClientAddress` plus `subscribeEvents`, and the `HyprClient`/`HyprWorkspace`/`HyprMonitor` types the whole shell annotates against. **Reads are SYNC on purpose**: the four a refresh needs cost 1.1 ms over the socket (a `hyprctl` spawn each is an order of magnitude worse), which is what lets `_refresh` stay synchronous — every consumer reads `hs.clients` straight after "changed". 🔑 **Addresses come out BARE, no `0x`**, because that is what AstalHyprland handed out and the dispatchers build `address:0x${a}` from it — a prefixed one yields `address:0x0x…`, which Hyprland answers by doing nothing. Never imports Gtk. |
| `BatteryService.ts` | ~95 | **The shell's ONLY door to UPower**, on `UPowerGlib` directly (the typelib ships with `upower`, already a dependency). Holds `present`/`fraction`/`charging`/`charged`/`timeToFull`/`timeToEmpty` over UPower's composite DisplayDevice, plus `watch` (any change) and `watchPresence` (`notify::is-present` only — the widget registry's hardware gate, narrow because it re-evaluates availability). **Two conversions you must not lose**: UPower's percentage is 0..100 and every consumer wants the 0..1 FRACTION; and Astal's `charging` was true at FULLY_CHARGED too, a conflation that hid a real bug (see dev-workflow.md). Consumed by `common/BatteryGlyph.ts`, `widgets/battery.ts` and the island's battery activity — none of which may import `gi://UPowerGlib` themselves. Never imports Gtk. |
| `NotifService.ts` | ~95 | **Stateless facade** over TWO layers, and the split is the point: `core/notifd.ts` is the SERVER (receive, persist, expire) and `core/NotifConfig.ts` holds Do Not Disturb, because DnD suppresses BANNERS — the notification still arrives and still lands in the NC. `notifications()` (a SNAPSHOT — the clear-all cascade holds its list while rows fly out), `getNotification(id)`, `isCritical(n)`, the DnD trio (`dontDisturb`/`setDontDisturb`/`toggleDontDisturb`) and `watchDnd`/`watchNotified`/`watchResolved`. Added 2026-08-18; notifications were the last domain with NO facade at all — **sixteen** bare `AstalNotifd.get_default()` calls across the NC, the popups, the bar's bell, the focus tile, Settings → Notifications and `config-entries.ts`, each re-deriving the same three questions. 🔑 `watchDnd` is narrow (one key); the focus tile used to listen on bare `notify` — EVERY property of the daemon — to watch one boolean. Never imports Gtk. |
| `AudioService.ts` | ~145 | **Stateless facade** over `core/wireplumber.ts` (PipeWire/WirePlumber; ours since 2026-08-18, it replaced AstalWp). `volumeIcon`/`targetVolumeIcon` (the volume-level icon ladder that used to live in FOUR copies), `streamIconName` (per-app stream icon), `setDefault` (`wpctl set-default`), `toggleMute`, endpoint/stream/default accessors, and `watchDevices`/`watchStreams`/`watchVolume`/**`watchDefaultSpeaker`**. Consumed by Settings → Audio + the CC volume tile/detail (`Sliders.tsx`, `widgets/volume.ts`) + the bar volume widget. 🔑 **A widget that draws the CURRENT default output subscribes with `watchDefaultSpeaker`, never with `watchVolume(defaultSpeaker(), …)`** — the latter resolves the endpoint once, and four widgets wrote it by hand with three of them broken by it (see tech-debt, "CC widget capture"). Returns Gio icons via `core/Icons` (core→core); the volume *slider widget* is `makeVolumeSlider` in `nidara-kit/slider.ts` (UI layer). Never imports Gtk. |
| `BluetoothService.ts` | ~330 | **Stateless facade** over the reactive singleton in `core/bluez.ts` (same pattern as NetworkService): power (`isPowered`/`setPowered`/`togglePower`), device categorisation (`pairedDevices`/`nearbyDevices`/`deviceName`), guarded command wrappers (`connectDevice`/`disconnectDevice`/`pairDevice`/`removeDevice`/`startDiscovery`/`stopDiscovery`), and `watchPower`/`watchDevices` notify helpers. `watchDevices` also wires each device's own `notify::paired/connected/name` (re-wiring on set change) — `notify::devices` alone misses in-place pairing/connection changes. Also owns the **BlueZ pairing agent** (`org.bluez.Agent1`, capability `KeyboardDisplay`, raw Gio D-Bus on the SYSTEM bus — no Bluetooth library offers agent support, which is why this half was ours long before the read half was): `registerPairingAgent(handler)`/`unregisterPairingAgent()`; the Settings → Bluetooth page supplies the dialog handler (`PairingPrompt` kinds: `confirm`/`display`/`enter-passkey`/`enter-pin`/`authorize`), so core stays UI-free. The agent registers when the page is built (first Settings open; effectively session-lifetime since Settings hides rather than closes). `pairDevice` sets `trusted=true` on successful pairing so reconnections skip authorization; `RequestAuthorization`/`AuthorizeService` auto-accept trusted/paired devices. **Testing gotcha:** D-Bus policy only lets root call `Agent1` methods, so exercise dialogs with `sudo busctl --system call <shell-unique-bus-name> /org/nidara/bluetooth/agent org.bluez.Agent1 RequestConfirmation ou /org/bluez/hci0/dev_00_11_22_33_44_55 123456` (find the bus name by matching the gjs PID in `busctl --system list`; the python-dbusmock bluez5 template never calls back into agents). Consumed by Settings → Bluetooth (full management: scan/pair/forget) + the bar/CC bt tile, whose
CC detail panel (`widgets/bluetooth.ts`, split-target capsule — see design-system.md) drives a
compact paired-device connect/disconnect list with the same `pairedDevices`/`connectDevice`/
`disconnectDevice`. **Gotcha:** `setPowered` drives `adapter.powered`, NOT the read-only `is_powered`. Never imports Gtk. |
| `NetworkService.ts` | ~430 | **The shell's ONLY door to NetworkManager**, and since 2026-08-17 it owns the read half directly on `libnm` (`gi://NM`) rather than through AstalNetwork — see tech-debt #71 for why the wrapper had to go (it resolved its devices once, in `construct`, so a hot-plugged adapter was invisible session-wide). Still a plain function module, not a GObject. It holds: the nmcli command vocabulary (`connectAp`/`disconnectIface`/`forgetProfile`/`rescan`/`setWifiEnabled`/`toggleWifi`/`listSavedWifiSsids`/VPN — this half was never Astal's), the NM-flag + frequency derivations (`isSecured`/`securityLabel`/`freqBand`/`freqChannel`), `apSsid` (an SSID arrives as `GLib.Bytes`, so it goes through NM's decoder — the one place NM is rawer than the old wrapper), `getIp`/`wiredConnected`/`wifiEnabled`/`available`, the `wifi()`/`wired()` handles (live getter views over the current NM device, null when absent), and the watchers. **Hardware presence is a subscription here, not a build-time fact**: `watchDevices` re-resolves on NM's `device-added`/`device-removed` and fires only when the SELECTION changed (NM emits device-added for every tun/bridge/veth — a VPN or Docker would otherwise re-arm the whole shell). Every other watcher — `watchWifi` (SSID+IP+speed+state), `watchWifiEnabled` (radio flag only, the bar-icon one), `watchWifiNetwork` (flag+SSID, no bitrate churn), `watchAccessPoints`, `watchWired` — re-arms itself across a hot-plug, so callers subscribe once. **Pick the narrowest watcher that covers what you redraw**; the old blunt `notify` cost the bar a full re-blur per frame during a scan. Consumed by Settings → Network, the CC wifi/ethernet tiles (`Toggles.tsx`) and the bar widgets (`widgets/wifi.ts`, `widgets/ethernet.ts`) — none of which may import `gi://NM` themselves. Never imports Gtk. |
| `PowerManager.ts` | 43 | hypridle hooks (screen-off/lock/suspend). |
| `SystemInfo.ts` | ~150 | **The ONE reader of "what is this computer"** — hostname, os-release `PRETTY_NAME`, CPU model, installed RAM, GPU, kernel, uptime, GTK/GJS versions, windowing system. Added 2026-08-25 with tech-debt #94: the About WINDOW and Settings → About each had their own copy of the same regexes over /proc and /etc, and the same machine reported **31 GB** in one and **31.3 GB** in the other. ⚠️ **A surface asks, it never reads — and FORMATTING lives here too**, because the duplication that produced 31 vs 31.3 was in the formatting, not in the file access. Unknown is the empty string, never a human word (a reader returning "Unknown" puts untranslated English on a translated page); the surfaces render `settings.about.unavailable`. Machine values are humanised at the source: lspci's 89-character device line → "AMD Radeon RX 5700 XT" (ask Intel BEFORE AMD and anchor with `\b` — an unanchored `/ati/` matches inside "Corpor**ati**on"), RAM ceilinged to the whole GiB so the desktop reports INSTALLED memory rather than what the kernel kept. `uptime()` is ours and synchronous (/proc/uptime + `Intl`), because `uptime -p` speaks the process's locale, not the desktop's. Never imports Gtk except for its version. |
| `ShellActions.ts` | 21 | Typed action registry populated by `app.ts main()`; consumed by Dock/Bar/AppGrid (replaces `globalThis`). |
| `AgentConfig.ts` | ~120 | Governance of the agent-facing surface (`ai.json`): `allowConfigWrite` gates `setConfig` writes; `allowScreenshot` gates the `screenshot` IPC; `allowComputerUse` gates third-party perception (`query_app`/`nidara-a11y`); `allowComputerControl` gates third-party action — AT-SPI `do_action` (`do_app_action`/`nidara-act`), synthetic keyboard (`type_text`/`press_key`/`nidara-type`, focus-verified), synthetic pointer — left/right click + hover + scroll + drag (`click_app`/`click_at`/`hover_app`/`hover_at`/`scroll_app`/`scroll_at`/`drag_app`/`drag_at`/`nidara-click`+`nidara-input`) — and window focus (`focus_window`/`focusWindow`) — and **requires perception** (enabling it implies `allowComputerUse`). The two computer-use gates **default OFF** (they reach outside the shell; enabling either flips on `toolkit-accessibility`, otherwise the a11y tree is empty). Separate toggles — each capability is sensitive on its own. Toggled from Settings → AI. It is a **consent layer over the official door, not a security boundary** (any local process can still edit config files / drive the a11y bus directly) — keep that framing in docs/UI copy. Reading the shell's *own* state is never gated (doctor/diagnostics depend on it). Also holds the **built-in Assistant's brain config** (`brainBackend`/`brainModel`/`brainEndpoint` in `ai.json`) — NOT a gate, just which BYOK LLM `bin/nidara-agent` talks to; the API **key is never in `ai.json`** (DE keyring, see below). |
| `AgentService.ts` | ~180 | Facade over `bin/nidara-agent` (the Assistant's brain). Owns the daemon subprocess (spawned LAZILY on first `send`, resolved PATH-first then the dev checkout's `bin/` via `SHELL_ROOT`; respawned on death), parses its JSON-lines events into a `transcript` (`{role,text,tools[]}`) + `busy`/`state`/`usage`/`lastError`; API `send`/`cancel`/`reset` + `subscribe`. Drives visibility only through `Status` (expand-on-finish: opens `ISLAND_AGENT` when a background turn ends on an otherwise-idle desktop). Consumed by `surfaces/island/AgentIsland.tsx` (the chat UI) and the `agent` island activity. Never imports Gtk. See `state-and-ipc.md`. |
| `AgentGlow.ts` | ~70 | The "the Assistant is working in THIS window" signal — the one piece of agent feedback painted outside our own pixels, because the thing it points at is a third-party window. Subscribes to `AgentService` and flips **only** `decoration:glow:enabled` (`hs.setGlow`) while `busy`; the look (range, violet→cyan gradient, and the **transparent `color_inactive` that limits the glow to the FOCUSED window** — the glow has no window rule, and `color_inactive` defaults to `color`, so leaving it out makes every window glow) is static in `hyprland.lua`. Deduped, because `AgentService` notifies on every streamed token. Gated by `ai.assistantGlow` (Settings → AI) and by `hs.supportsGlow()` (Hyprland ≥ 0.56 — `getoption` answers an unknown option with the bare string `no such option`, so the JSON parse failing IS the probe; and when it *does* answer, a **gradient comes back as `AARRGGBB`, not `RRGGBBAA`** — read a colour back in the order you write it and the alpha lands in the red channel). Forces the glow **off** at boot: a shell that died mid-turn left it on in the live config and nothing else would ever clear it. Re-asserts on `config-reloaded` (a reload re-reads `enabled = false` and would silently drop the signal mid-turn). **No focus guard on purpose** — every daemon tool acts on the focused window and refuses otherwise, so whatever is focused IS what the next action touches. **The sweep is not configured here and cannot be:** the `glowangle` animation is armed **at window creation**, so it lives permanently enabled in `hyprland.lua` (measured free while the glow is off; arming it live leaves already-open windows unable to ever sweep). Never `style = "loop"` — see the `hyprland.lua` comment. |
| `ConfigRegistry.ts` | ~120 | Typed registry of agent-readable/-writable settings — the data half of `describeConfig`/`getConfig`/`setConfig` (see `state-and-ipc.md`). Same pattern as ShellActions: core defines the registry; **entries are registered from `config-entries.ts`** (app level, NOT core) because dock settings live in `surfaces/dock/state.ts` and core must never import widget code. Each entry is self-describing (desc/type/enum/min/max) and delegates `set` to the owning service, so validation/persistence/notify behave exactly as if Settings had been used. NB: result types use optional fields, not discriminated unions — tsconfig has `strict:false`, under which tsc doesn't narrow `r.ok ? r.value : r.error`. |
| `UITree.ts` | ~160 | Serializer behind the `queryUI` IPC command (see `state-and-ipc.md`): walks every **mapped** toplevel and returns a flat list of on-screen widgets carrying signal (test-id / CSS class / visible text / interactive GType) + ancestor `path` + `bounds`, for read-only UI **assertions** (screenshot → programmatic check). Redacts password/masked entry text. Read-only/ungated like dumpState. Tier 1 = structure+text; the node model is source-agnostic — `bin/nidara-a11y` now fills the **same shape** for third-party apps via AT-SPI2 (the computer-use layer's `query_app`; see `state-and-ipc.md`). |

### The rule for settings JSON: a config file must be able to FORGET

Every config module here is the same shape — a `DEFAULTS` object naming the settings that exist, a
JSON file under `~/.config/nidara/`, and a `save()` that writes the in-memory object back. The
obvious load, `{ ...DEFAULTS, ...data }`, is **a one-way ratchet**: a key RETIRED from `DEFAULTS` is
still in the user's file, the spread carries it into the live object, and the next save writes it out
again. It never leaves. `region.json` still carried `weekStartsMonday` months after that setting was
reverted (`4212a3e5`), and the only reason it did no harm is that nothing read it. That is worse than
clutter, because the same mechanism resurrects MEANING: a retired key that later comes back with new
semantics reads a value the user never chose in the new sense, out of a file it has been sitting in
for months. **The file is user state; the SHAPE of it belongs to the code.**

So loading goes through **`loadKnown(DEFAULTS, JSON.parse(...))`** (`core/configFile.ts`), which keeps
only keys the current shape declares and only where the type still matches. `RegionConfig`,
`NotifConfig`, `AgentConfig` and `RecordingConfig` all use it; `ThemeManager` predates it and does the
same thing by hand (field-by-field load, explicit save object) — either is fine, a spread is not.

⚠️ **`WidgetConfig` is the exception and its spread must stay**: its keys ARE the data (widget ids),
so `DEFAULTS` seeds them rather than enumerating the valid ones, and `loadKnown` there would drop
every widget the shipped defaults don't happen to name — third-party ones included. **The test is
whether `DEFAULTS` enumerates the valid keys or merely seeds them.**

🔑 The cheap instrument that finds these: for every key in each `~/.config/nidara/*.json`, count
references in the codebase. Zero = orphan. But an orphan on disk is not the same as a resurrected one
— what decides is whether the module's **save** is explicit. `appearance.json` also carried orphans
(`fontBase`, `monoFontBase`, from #126) and they were inert, because `ThemeManager.saveSettings`
builds an explicit object and would have dropped them on the next write.

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
  **One setting, one owner: the keyboard layout belongs to Settings → Devices** (`Input.tsx`),
  and nothing else may write it. Language & region carried a second control for it until
  2026-08-16 — a text entry whose Apply called `inputConfig.setKbLayout(kb)` with ONE
  argument, so `variant` fell back to its `= ""` default and silently wiped a
  Dvorak/Colemak choice made in Devices. A defaulted trailing parameter is exactly how a
  duplicate control goes wrong quietly: the call typechecks, applies, and destroys half
  the state. macOS and GNOME both put the layout under Keyboard/Devices, not under
  Language; keep it there.
- `AboutWindow` float/center → a static `hl.window_rule` in `hyprland.lua` (matched by the
  "About Nidara" title; the `windowrulev2` keyword calls were removed).
- greeter `LocaleBar` kb_layout → eval (the greeter runs its OWN Lua config,
  `config/greetd/hyprland-greeter.lua`, so it's the same parser).
- `app.ts` bar-blur layerrules → **deleted** (dead duplicates of the `hl.layer_rule`
  already in `hyprland.lua`).
Only `dispatch`/`getoption`/`monitors`/`eval` callers remain (all valid). Also: a fractional
monitor scale must divide the native resolution into whole logical pixels or Hyprland snaps
it — the Display page filters scale presets to exact-valid per monitor.

**The same rule from the other side: a GLOBAL option must not be rendered per monitor.**
VRR is `misc:vrr`, one global int (`MonitorConfig` says so and writes one
`hl.config({ misc = { vrr = N } })` line), but its dropdown was built inside
`buildMonitorSection` — i.e. once per monitor. One monitor hid it completely; two put the
same setting under two monitor headings, each implying a scope it does not have, with no
sync between them, so changing one left the other reading the old value. Fixed 2026-08-16
by a page-level "All displays" group (`buildGlobalSection`), built ONCE outside `render()`
and re-appended by it — the per-monitor sections are rebuilt on a topology change, and a
re-read registered from inside a later `render()` would land outside the page's build
context where `onPageShown` is a no-op. 🔑 The test that catches this class: for each
control, ask what the KEY it writes is scoped to, then check the widget is built exactly
that many times.

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
Bigger gotcha: **`HyprlandState`'s CACHED `HyprClient` window-state props go stale** —
`floating` can read true on a tiled window (observed live 2026-06-11: wrong menu checks,
float-all skipping windows), and `grouped` isn't in the cache at all. Authoritative window
state = `hs.getClientJson(addr)` / `hs.getClientsJson()` (one-shot `hyprctl clients -j`,
on demand only — never in the `_refresh` hot path). Never build UI checks or filter bulk
window ops from the cached client. This was first hit on `AstalHyprland.Client` and it is
**not a bug we inherited and could have dropped**: any event-sourced cache of compositor
state drifts between events, so `core/HyprlandState.ts` (ours since 2026-08-18) has exactly
the same property, which is why `getClientJson` exists beside it.

**Since 2026-06-10 all of this goes through `HyprlandState`** (single-door sweep): use
`hs.evalLua(...)` / `hs.getOptionJson(...)` / `hs.setCursor(...)` / `hs.version()` instead of
shelling out to hyprctl — add a method to HyprlandState if the vocabulary is missing. The
shell itself (greeter excluded — separate bundle, own Lua config) has zero direct hyprctl
calls outside HyprlandState.

## `ui/lib/nidara-kit/`

Pure-GTK4 primitives + Nidara tokens, **no Adwaita, no resets**. Mostly consumed by the shell's Settings pages, plus what the greeter/lockscreen adopted (the dropdown, the login card, the clock):

- `makeSlider` (`slider.ts`) — the ONE slider, Cairo end to end; `makeHSlider` is the horizontal wrapper, `makeVolumeSlider` binds one to an audio endpoint, `makeVerticalFillTile` is the 1×2 CC gauge. Details in design-system.md, "Sliders — one component". It moved here from `ui/shell/common/` on 2026-08-15 (NTK step 3) and it is the first kit component that needed something the bundle owns → the seam below.
- **The composed rows** (`rows.ts`): `NidaraToggleRow`, `NidaraDropDownRow`, `NidaraSliderRow` — "label + subtitle + the control that edits it", which is most of what a preferences pane is. They take the row BUILDER as a parameter (`mkRow`, default `plainRow`), which is how **building a row and registering it are two different jobs** (NTK step 4, 2026-08-16). Settings hands in its own `createRow`, which pushes the label into the search index and then delegates; nobody else does, and nobody else has to know the index exists. ⚠️ **Contrast with the appearance seam below: that one is a module-level global because it is per-BUNDLE; this one is a parameter because it is per-CALLER.** The same shell has Settings rows that must be indexed and `widgets/screenrecord.ts` rows that must not — a global would have to be pushed and popped around every build. `lifetime.ts`'s `bindWhileRealized` came along with them (the rows re-arm their external sync through it).
  🔑 **`NidaraDropDownRow` ADDS a value it does not know rather than falling back to item 0** (2026-08-16).
  The list is what you may PICK; the selection is what you HAVE, and the second is not a subset of the
  first. `GtkSingleSelection` cannot hold "nothing selected", so an unknown value used to land on index 0
  and the row then displayed, with full confidence, something nobody had chosen. Settings → Devices is
  where it drew blood: 28 named layouts, while `kb_layout` accepts a comma-separated SET (`es,us` — how
  you have two layouts and a switch key) and any XKB variant, so an ordinary hyprland-user.lua read back
  as "English (US)" with the row's own callback one click from making that lie true. Measured pre-fix
  with the effective layout staged to `es,us`.
- **`appearance.ts` — the kit's appearance seam. Read this before adding any Cairo-painted kit component.** Everything else in the kit needs nothing but GTK from its host. A Cairo painter does: Cairo cannot read a CSS token, so the accent must arrive as a real `#rrggbb` and "is the surface under me dark?" must be answered by whoever knows what that surface is (in the shell, `core/ThemeManager` — which the kit may not import, or it stops being usable from the greeter). So the BUNDLE injects it: `setKitAppearance({ accent, surfaceIsDark, onChange })`, once, at module scope in its `app.ts`, before `main()` builds anything. Same shape as injecting the greeter's `t()` into the shared login card. ⚠️ **An unregistered bundle does not fail — it renders the fallback (blue, light surface).** That is the silent-default trap the token contract warns about, so the fallback logs a warning on first use; the greeter/lock have no dev mode to notice it in otherwise. Only the shell registers today, because only the shell has sliders. Measured A/B on 2026-08-15, same widget: registered → fill `#D45A94` (pink accent) and no warning; unregistered → `#017BE9` and the warning.

- `NidaraSplitView` — replaces `Adw.OverlaySplitView` + `Breakpoint`. Its `collapseAt` is a **fixed px breakpoint**, never derived from the content: a breakpoint computed from the active page's natural width is a different window on every page (2026-08-11 — see design-system.md, "The Settings window has ONE geometry law"). Collapsed, the sidebar is REPARENTED into a `Gtk.Popover` (xdg_popup → compositor blur behind it, and `autohide` does the dismissing). There is exactly ONE collapsed mode since 2026-08-16: the Overlay + click-catching `backdrop` alternative, and the `floatAnchor` parameter that selected between them, are gone — see the focus-grab section for why a catcher must not coexist with a grab.
- `NidaraClamp` — replaces `Adw.Clamp`. Takes a `minWidth` as well as a max; passing the same value for both is how a pane gets a CONSTANT width (what Settings does).
- `NidaraWindow` — the glass window shell. It owns the geometry law: from one `contentWidth` it derives the split view's breakpoint (`sidebar + content`), the window's minimum size and the width it opens at (always wide enough to show the sidebar docked).
- `NidaraButton` — suggested/destructive/pill variants
- `NidaraDropDown` — the native `Gtk.DropDown` with our scroll bar swapped into its popup list. The native widget is deliberate: its popover is a real Wayland surface, so Hyprland's popup blur frosts it, which an in-window overlay list cannot get. (`NidaraSelect`, the overlay version, and its `NidaraOverlayManager` were deleted 2026-08-03 — consumer-less since Settings moved here.)
- `NidaraSidebar` — single-select nav list; items take an optional `groupStart` to draw a thin **title-less divider** before them (thematic clusters, no group labels). The Settings sidebar uses this for its 3 clusters (connectivity · look/shell/behaviour · system & devices). ⚠️ **Its label is `ellipsize: END` for a structural reason, not a cosmetic one**: the label carries no `font-size`, so it grows with the interface font, while the capsule around it is a FIXED column (`sidebarWidth`, 250px in Settings) whose scroll view is `hscrollbar_policy: NEVER`. Without ellipsizing, a label's minimum width *is* its natural width, so a long string makes the capsule demand more than its column reserves and it overruns the content pane. Measured 2026-08-11: the label budget is **176px** (250 − 8 capsule margin − 12 list padding − 24 row margins − 18 icon − 12 spacing), and the Russian "Специальные возможности" needs **204px at the default font size** — i.e. it was already overflowing in a shipped locale before any accessibility scaling, and English "Language & region" joined it at text-scale factor 1.39. Any new fixed-width text box in the kit needs the same treatment; the general rule is that a text widget in a reserved column must not be allowed to set that column's width.
- `showNidaraAlert` — replaces `Adw.AlertDialog`; optional `entry` (single-line input, `digitsOnly`/`maxLength`, text reaches `onResponse` as 2nd arg, Enter fires the suggested response) and returns an `AlertHandle` whose `close(id?)` responds programmatically (used by the BlueZ pairing agent to honor `Cancel()`)

### Settings information architecture

The Settings sidebar (`Settings.tsx` `categories[]`) is **ordered into 3 unlabelled clusters** via `NidaraSidebar`'s `groupStart` dividers; the array order *is* the IA, so reorder there. The window opens on **Appearance** by default (not the first item). The **AI page** (`pages/Ai.tsx`, third cluster) governs the agent surface — its rule: every row must gate or report something REAL (no placeholder toggles); it grows with the AI-native roadmap (assistant model picker…). Its IA (2026-07) is four groups, one concept each: **Desktop Access** (shell-scoped capabilities, default on) · **Other Apps** (computer-use perception/control, escalating, default off) · **MCP Server** (the CHANNEL: enable toggle + `.mcp.json` connect row — a transport, not a permission; capability toggles gate `nidara-ipc` and MCP alike) · **Agent Interface** (read-only facts). Don't fold the MCP toggle back among the capability toggles. Pages that contain sub-screens use the **parent-page + `pushSubpage` pattern**: e.g. **Apps** is a landing (`pages/Apps.tsx`) with three navigable rows that push **Default Apps** (`pages/DefaultApps.tsx`), **App Icons** (`pages/AppIcons.tsx`) and **Autostart** (`pages/Autostart.tsx` — moved off the sidebar 2026-07; Windows Apps→Startup prior art). Subpages can nest: Autostart pushes its own installed-apps picker (`apps/autostart/add`), like App Icons' per-app detail (`apps/icons/{id}`). Caveat: subpage rows aren't in the search index, so a parent's landing rows should carry searchable labels. ⚠️ **And "not yet" is the wrong reading** — visiting a subpage does not index it either. `pushSubpage` (`Settings.tsx`) calls its `build()` outside the `beginPage`/`endPage` pair that wraps the top-level `categories.forEach`, so `createRow`'s `_pageCtx.id` is empty for the whole subtree and the rows are dropped no matter which row builder made them. Measured 2026-08-16 in a live session (open the subpage, then search a label only it has → *No results*). The corollary is worth knowing before reaching for the search box as evidence: a row built outside Settings is unindexed for the SAME reason as a subpage row, so **the search index cannot tell the `mkRow` seam apart** — the proof that a widget's rows left `surfaces/settings/` is its import graph, not the searcher.

**Every page's body runs when the WINDOW opens, not when the page is visited.** `categories.forEach`
builds all 21 top-level pages eagerly into `pageCache`, so whatever a page does while constructing —
spawn a process, read a file, apply a value — happens on every open of Settings, on behalf of a user
who asked for some other page. Two consequences:

- **Showing a value must never write it.** A dropdown told what the config already says emits
  `notify::selected`, its handler calls the setter, and the setter persists. Settings → Region did
  exactly that: opening the window on *any* page rewrote `region.json` **and
  `~/.config/environment.d/nidara-locale.conf`**, a file the systemd user manager reads at login
  (measured 2026-08-16 by mtime, both files, every open). Guard the programmatic assignment with a
  `syncing` flag — Power's profile selection does the same for `powerprofilesctl set` — and give the
  setter the unchanged-guard its siblings have. Note what hid it: the write was *idempotent*, so
  nothing ever looked wrong.
- **Falling back to index 0 is a claim, not a default.** `indexOf(saved)` returning −1 and selecting
  0 makes the row report a setting the config does not hold. Show the saved value instead — append it
  to the model if the system stopped listing it. ⚠️ That case happens to write nothing, but only
  because index 0 is where the dropdown already sat and GObject emits no notify for an unchanged
  property; the same fallback with any other value writes.

**Page lifetime — the trap.** Category pages are built ONCE into `pageCache` and swapped by
`remove()` + `append()`, so navigating away **unrealizes a page without destroying it** and coming
back re-realizes the same widget. `unrealize` here means *"taken out for a moment"*, not *"being
destroyed"*: anything the page needs in order to stay CURRENT — service watches, signal handlers,
GLib timers — must go through **`bindWhileRealized(widget, subscribe)`** (`nidara-kit/lifetime.ts`,
re-exported by `SettingsHelpers.ts`),
which re-subscribes on every realize and disposes on every unrealize. Do the initial refresh inside
`subscribe` too, so a page you return to re-reads the world. A bare `connect("unrealize", dispose)`
silently freezes the page after the user's first departure (that was tech-debt #12b: frozen device
lists, a dead pairing agent, a stopped clock preview). Subpages are exempt — `pushSubpage` rebuilds
them on every push.

⚠️ **A hook that only SUBSCRIBES is the same bug wearing the fix's clothes.** The composed rows and
`makeHSlider` arm their `onExt`/`onExtChange` through `bindWhileRealized`, so the caller's hook is what
decides whether coming back re-reads: one that connects and returns a disposer is armed and blind — it
learns nothing that happened while the widget was away, which is exactly the interval it exists to
cover. **Prime it: `apply(read())` BEFORE connecting.** Settings → Appearance had five controls on this
shape (measured 2026-08-16: `setConfig appearance.shellAppearance dark` moved the bar and the dock
while the dropdown two inches away still read "Follow system", for the rest of the session; the four
advanced glass sliders live in a Revealer that starts closed, so they are unrealized until it opens and
came back showing the value they were BUILT with, contradicting the master right above them). The
question that finds it is not *does this control have an external-sync hook?* but *does that hook
answer the question, or only promise to?*

⚠️ **`bindWhileRealized` is only half the answer, and the half it misses is the common one.** Realize
tracks NAVIGATION between pages; it does **not** track the window's own show/hide. Hiding the Settings
window leaves its pages REALIZED (measured 2026-08-16: close the window on Power, change the profile
from a terminal, reopen → a realize-bound read does not run and the page still shows the old profile).
Since Settings *hides* on close, closing and reopening is how a user returns to a page most of the
time, so a re-read hung off realize misses precisely the case it exists for. The complement is
**`onPageShown(read)`** (`SettingsHelpers.ts`): it registers the read against the page being built —
the same `_pageCtx` seam `createRow` indexes through — runs it once immediately, and `Settings.tsx`
re-runs it from BOTH triggers, `showPage` (navigation) and the window's `notify::visible` (reopen).
The split between the two is what each one owns, not when it fires: **`bindWhileRealized` for a
subscription whose lifetime must match the widget's — it has something to dispose; `onPageShown` for
a question that has to be re-asked — it has nothing to dispose.**

This distinction is the whole of a bug family found by the 2026-08-16 sweep, and the question that
finds it is *what did this page have to GO AND ASK for?* An `execAsync`, a file read, a one-shot
`powerprofilesctl get`: answered once, then frozen for the life of the shell, and a frozen value looks
exactly like a correct one. Three were live — Power's profile selection (which game mode swaps behind
its back), About's uptime (a clock, wrong within the minute), and About's update check (lost to a
network that wasn't up yet at login, then silent about an available update all day). Note the update
check's shape: a re-read that APPENDS must be idempotent, so it retries only until it answers.

Verifying one of these needs no screenshot, but it does need the state to be READABLE: Power's
selection checkmark is a bare `Gtk.DrawingArea`, and `queryUI` drops nodes with no id, class or text
(`UITree`'s `interesting`) and only walks MAPPED ones. Giving it the class `power-profile-check` — not
for styling, Cairo paints it — makes the single mapped node the machine-readable answer to "which
profile does the page believe is active". That is the general move when a custom-painted state needs
proving: name it so the instrument can see it.

Naming note (2026-07): the page with id `widgets` (`pages/Widgets.tsx`) is titled **"Control
Center"** in the UI and its copy says "controls", since it manages bar + CC
placement in a single Settings page. `AtomicWidget`, the `widgets/` dir
and all ids/keys keep the internal name; only user-facing strings changed.

This is the right place for new shared, Adwaita-free primitives.

## Game mode

- **`hyprland.lua` (compositor side):** on `window.open`, detects Steam windows (`class = steam_app_<id>` or by reading `SteamAppId` from `/proc/<pid>/environ`, walking parent PIDs). Moves them to the special `gamespace` workspace (no blur/anim/shadow, `immediate`, `opaque`, `idle_inhibit`). Optionally swaps wallpaper to Steam library hero-art (`awww`) and sets power profile to `performance`. On last-game close: **restores the wallpaper and the profile that were in effect before the game**, then returns to the previous workspace.

  🔑 **Entering a session is a thing that has to be UNDONE, so it is a capture, not a constant.** Exit used to hard-code `powerprofilesctl set balanced`, which is right for exactly one of the three profiles: a session started from Power saver ended in Balanced and the Settings choice was silently gone (2026-08-16). The wallpaper two lines below always did this correctly (`prevWallpaper`), which is the shape to copy. Three consequences worth keeping straight, each of which was a bug:
  - **The "already in a session" guard needs its own flag** (`inGameSession`), not `prevWallpaper` — that one is only set when a wallpaper was actually swapped, so with `wallpaperMode = none` a second game window re-ran the entry block and would re-capture the profile it had itself just changed.
  - **Restore only if the profile is still the one we set.** A profile the user picked mid-game is a newer decision than ours.
  - **Undoing the session and putting the user back are different jobs.** They used to share one condition (`the user is standing on gamespace right now`), so quitting a game after wandering to another workspace left the game wallpaper up, the machine on performance, and the session flags set — which meant the NEXT game got no entry either. Undoing is unconditional; only the focus return is conditional.

  These handlers have a **test harness** that needs neither Hyprland nor Steam — `scripts/dev/hypr-game-mode-test.lua`, a CI gate; see `dev-workflow.md`.
- **`nidara-game-mode` script (`Super+Shift+G`)** + **`GamingManager.ts` + Settings → Gaming (`gaming.json`):** `wallpaperMode` (artwork/custom/none), transition, `performanceProfile`.
- **`Super+B` → `toggleBarOverlay`** (alias `toggleGameOverlay`): promotes **only the Bar** to OVERLAY layer over any fullscreen window (requires an active fullscreen window to activate; deactivation always allowed). Not game-specific — it lives here because games are the main fullscreen use case.

## Planned Enhancements & Roadmap

Backlog of designed desktop enhancements to prioritize for upcoming iterations:

### 1. UI & Lockscreen Enhancements
1. **Lockscreen Media Player Controls (`ui/lockscreen/widget/Media.ts`)**:
   - Compact glass capsule rendered on `nidara-lock` below the clock when an MPRIS player (Spotify, browser, etc.) is active.
   - Album artwork, track title, artist name, and touch/click Play/Pause, Next, and Previous track controls.
2. **Lockscreen Battery & Charging State Indicator (`ui/lockscreen/widget/Battery.ts`)**:
   - Subtle battery percentage and AC charging status indicator integrated into the lockscreen bottom power bar or header.
3. **Settings Visual Keyboard Shortcuts Explorer (`pages/Shortcuts.tsx`)**:
   - Categorized and searchable visual explorer in Settings for all Hyprland and Nidara keybindings (Windows, Launchers, Media, Screenshots, AI/Agent).
4. **Config Backup & Restore Manager (`nidara-backup` / Settings UI)**:
   - One-click export/import bundle (`.tar.gz` or JSON) of user preferences (`~/.config/nidara/`: appearance, wallpapers, dock pins, widget layout, autostart).

### 2. Structural & Core System Architecture
1. **Native GTK4 Polkit Authentication Agent (`nidara-polkit` / `ui/polkit/`)**:
   - Replace legacy GTK3 `polkit-gnome` daemon with a native Nidara GTK4 glass-styled elevation prompt.
   - Seamless identity: displays the user's avatar (`~/.face`), real name, action description, and fluid shake/error feedback for password validation.
2. **Hardware OSD & Dynamic Island Feedback (Volume, Brightness, Mic Mute, CapsLock)**:
   - Animated visual feedback pill via Dynamic Island / OSD overlay whenever hardware keys (`XF86Audio*`, `XF86MonBrightness*`, CapsLock) are triggered, replacing silent shellouts.
3. **Extensible D-Bus Search Providers in Prism (`org.gnome.Shell.SearchProvider2`)**:
   - Enable Prism to query D-Bus search providers and extensible plugins for instant indexing of calendar events, calculator results, browser bookmarks, and notes.
4. **Automatic Solar / Geolocation Night Light Scheduling**:
   - Automatic sunrise/sunset calculation or scheduled transitions for `hyprsunset` blue light filtering in `NightLightManager.ts` and `pages/Display.tsx`.
5. **System Mime & Protocol Associations Manager**:
   - Deep two-way synchronization of protocol handlers (`mailto:`, `webcal:`, `tg:`, `magnet:`) and default mime associations in `DefaultApps.tsx`.

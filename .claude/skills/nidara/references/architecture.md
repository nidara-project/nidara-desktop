# Nidara — Architecture

Read this when adding/editing widgets, changing how overlays attach, modifying any `core/` service, or trying to understand how the shell actually boots.

## Tech stack at a glance

| Layer | Tech |
|---|---|
| Language | TypeScript (files carry a `.tsx` extension; see the JSX note below) → compiled to GJS |
| UI framework | none — GTK4 directly. The application host is `ui/lib/nidara-kit/platform/host.ts` and the bundler is `scripts/bundle.sh`; **nothing of AGS is left** (see below) |
| Toolkit | GTK4 (pure — libadwaita fully removed) |
| Wayland surfaces | gtk4-layer-shell (layer-shell protocol), `Gtk4SessionLock` (ext-session-lock-v1) |
| Raw Wayland from GJS | **`lib/nidara-wl/`** — the project's own C+GIR shim (see below) |
| Compositor | Hyprland ≥ 0.55 (config in **Lua**) |
| Session manager | **uwsm** (manages the session as systemd units/scopes) |
| Display manager | greetd (default; only installed if no other DM is enabled) |
| Astal system services | **None — 100% eliminated.** Services are native TypeScript except notifications, owned by the Rust session daemon (`session/`), and PAM authentication is native C (`lib/nidara-auth/`, `gi://NidaraAuth`). ⚠️ **Before writing anything that talks to `NidaraAuthPam`, read the conversation contract in `lib/nidara-auth/nidara-auth.h`.** PAM messages come in two kinds and are answered differently — PROMPTS block and must get exactly one `supply_secret()`, MESSAGES (`auth-info`/`auth-error`) must get NONE. That is **not** AstalAuth's contract, which required answering all four, and porting its consumer across unchanged is how #200 shipped a lockscreen that answered the next password prompt with an empty string (fixed 2026-08-23; `scripts/dev/auth-probe.js` fails without the fix). Two more signals qualify the verdict — `password-expired` before `success`, `account-denied` before `fail` — and a consumer that ignores the second tells the user "wrong password" for a denial no password can fix, sending them to retry until `pam_faillock` locks them out for real. |
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
| `ags/gtk4/app` | **`ui/lib/nidara-kit/platform/host.ts`** — a `Gtk.Application` subclass with `start`/`apply_css`/`reset_css`/`quit` | ~170 |
| `ags/process` | `ui/lib/process.ts` — `exec` + `execAsync`, plus `spawn()`: THE door for every child process of the desktop bundles, which starts it without our `GTK_THEME=Empty` (SKILL.md commandment 11; `child-env-check.mjs`) | ~100 |
| `ags/file` | `ui/lib/nidara-kit/platform/file.ts` — `readFile` + `writeFile`, likewise | ~50 |

`Astal` was imported in four files and **used in none**; those imports went with the barrel.

**Read `ui/lib/nidara-kit/platform/host.ts`'s header before changing anything about startup.** Three things it does are
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

### Linux process names

The host's optional `processName` sets Linux's main-thread `comm` by opening
`/proc/self/comm` directly through Gio (`platform/process-name.ts`). This is the
name `ps -o comm`, `pgrep -x`, and monitors that use `comm` see: `nidara-shell`, `nidara-settings`,
`nidara-lock`, `nidara-greeter`, and `nidara-install`. Linux allows 15 bytes, so
names are validated as ASCII and never silently truncated. The installer uses
`nidara-install` because `nidara-installer` is too long.

`GLib.set_prgname`, `GLib.set_application_name`, GApplication IDs, and per-window
Wayland app-ids remain separate. Changing
`comm` does not replace the executable or change a child's identity after exec.
Mission Center 1.2.0's process rows prefer the executable basename over `comm`
(`src/table_view/models.rs` in its v1.2.0 source), so a GJS-console process shows
`gjs-console` even after renaming `comm`. A script wrapper or
changing `argv[0]` alone cannot change the executable basename it reads.
Do not use atomic file replacement on procfs. If procfs is unavailable, the host
logs a warning and continues. External kit applications may omit `processName`.
The standalone `nidara-ui` launcher kills only the current user's `nidara-shell`,
with a command-line fallback scoped to old shell bundles; other GJS services
are left running. For stale shell processes use `killall nidara-shell`; old builds still use `gjs`,
so identify those by PID instead of killing every GJS service in the session.

### Every GJS program has a native executable identity

`lib/nidara-host/nidara-host.c` embeds GJS through its public context API; it
does not exec the GJS console. It accepts a local ESM file followed by application
arguments, preserving module imports, ARGV, `system.programArgs`, `programPath`
and explicit `system.exit()` codes. It is not a replacement for the full GJS CLI
(debugger, REPL and profiling flags). In the bundles, the TypeScript
Gtk.Application host still owns GTK initialisation, application/window IDs,
`comm`, appearance and child environments.

`lib/nidara-host/hosts` is THE list of runners — five bundles (shell, Settings,
greeter, lock, installer) and the GJS helpers in `bin/` (a11y, act, agent, click,
mcp, portal, share-chooser, type). `lib/nidara-host/build.sh` produces one ordinary
file per name from the same source; `scripts/bundle.sh`, the package, `install.sh`
and the smoke harnesses all read the list or the files it produced, so a new GJS
program is one line there. They are installed to `/usr/lib/nidara/`; the
installer's runner ships with the `nidara-installer` package and only there.
Never replace them with symlinks to one shared binary: `/proc/PID/exe` would
resolve to that shared filename, which would lose the identity Mission Center
reads. Rebuilds replace changed files atomically and leave identical binaries in
place, so opening Settings does not mark an unchanged running shell executable
`(deleted)`. `gjs` remains a runtime dependency for libgjs, probes and dev paths.

Executable bundles keep their base64-carrying wrapper and hashed JS extraction.
Each opts in with `--native-host=<name>` on `scripts/bundle.sh`; those wrappers run
the private host instead of `gjs -m`. `NIDARA_NATIVE_HOST_DIR` overrides the
installed host directory for isolated tests and uninstalled builds. A missing host
fails explicitly; no silent GJS fallback. `--js` output is unchanged.

The `bin/` helpers have no wrapper: their shebang IS the runner,
`#!/usr/lib/nidara/<name>`. The kernel then starts the host with the script's path
as its first argument, `exe` is the host and `comm` the script's name (truncated
to 15 bytes: `nidara-share-ch`). ⚠️ Consequence: a checkout whose runners were never
installed cannot start `./bin/nidara-mcp` directly ("bad interpreter") — run
`install.sh` once, or `gjs -m bin/<name>`, which every probe and the agent-loop
test do and which ignores the shebang. A new GJS helper with a `gjs` shebang
fails `native-host-check.py`.

In dev, `scripts/run.sh` selects the native shell ONLY for this checkout's
`ui/shell/app.ts`; probes and other entrypoints (the lock in dev mode included)
retain GJS. `bin/nidara-settings` builds/runs the native Settings host and still
cleans up its own temporary JS. Both paths compile the hosts from the checkout,
without installing anything. The gtk4-layer-shell preload is retained in every
bundle path and removed by the TypeScript host before any child is launched.
Native runner semantics, every listed host, the generated wrappers and the
helpers' shebangs are checked by `scripts/ci/native-host-check.py`; both smoke
harnesses install the hosts and the Settings lifecycle check asserts their actual
`exe`/`comm` identities.

### The toolchain is ours too (2026-08-18, same day)

Nothing of AGS is installed any more. What the CLI actually was, and what replaced it:

| was | is | notes |
|---|---|---|
| `ags bundle app.ts out` | `scripts/bundle.sh app.ts out` | esbuild + a bash wrapper carrying the JS |
| `ags run app.ts` | `scripts/run.sh app.ts` | bundles to `$XDG_RUNTIME_DIR`; shell → native libgjs host, other entries → `gjs` |
| `ags types -d .` | `scripts/gen-types.sh` | `npx @ts-for-gir/cli generate '*'` — literally what it wrapped |
| `ags request <cmd>` | `nidara-ipc <cmd>` | gone since #185; its bus name was served as a compat door until 2026-09-23 (closed, users' keybinds migrated) |

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

⚠️ **Since 2026-09-23 (#108 phase 3) the esbuild step is `scripts/bundle.mjs`**, esbuild's JS API
(shipped by the same pacman `esbuild` package at `/usr/lib/node_modules/esbuild`), called by
`bundle.sh`. Same flags — listed there now — and without `--kit-external` the output was checked
**byte-identical** to the CLI's on all four bundles and on a probe using `--alias:`. It moved only
because leaving the kit out of an app takes an esbuild PLUGIN, which the CLI cannot load. Extra args
`bundle.sh` passes through are parsed there: `--alias:`, `--define:`, `--external:` and
`--kit-external=`; anything else is refused rather than silently dropped.

The system `esbuild` package (Arch `extra`) is now a build dependency: `makedepends` in
`packaging/nidara/PKGBUILD`, and the smoke's pacman list. `go` left at the same time — building
AGS's Go CLI was the only thing that needed it.

⚠️ **There is no second dependency list to add it to, since 2026-09-02.** `install.sh` used to
carry its own hand-kept `PACMAN_DEPS` of 80 names beside the PKGBUILD's arrays, and the two had
drifted in both directions at once (#379): three real dependencies the script never installed —
the desktop worked because they arrived transitively — and eight names it did install that had no
use anywhere in the tree, left from the Astal build toolchain. `PACMAN_DEPS` is now DERIVED by
sourcing `depends=()` + `makedepends=()`, so a dependency is declared in the PKGBUILD and nowhere
else. Two consequences worth knowing before touching either file:

- **Both arrays must close with `)` in column 1.** The extraction ends its range on `/^)/`, and
  `depends=()` contains a comment line that ends in `)` — a looser pattern ends the range there and
  silently yields an EMPTY array. `install.sh` refuses to continue below 40 names for that reason,
  and the `pkgbuild` CI job checks both arrays source as real arrays.
- **Version constraints are stripped** on the way through: `hyprland>=0.56` is valid dependency
  syntax and is not a valid `pacman -S` target. The floor stays enforced by the package.

The only names NOT derived are `base-devel` and `glib2-devel`, and they are build tools rather than
dependencies — the package's `build()` runs under makepkg, which supplies the first; this script
compiles the same C without it. Adding a third is a claim that the dev path needs something the
package does not.

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
`setWindowAppId()` in **`ui/lib/nidara-kit/platform/app-id.ts`** (`NidaraWindow` takes an `appId` option). That name is a
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
| `visible_region_*()` | `nidara-material-v1` `set_drawn_region` (Hyalo) · `hyprland-surface-v1` **v2** (Hyprland) | Hyalo: drawing the bar and the dock only where they paint (#761, `hyalo.md` → "Where a surface draws"); Hyprland: the layer-blur cost in `tech-debt.md` §46 |
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
- 🔑 **The region is in BUFFER pixels, not surface (logical) ones** — "specified in buffer-local
  coordinates" (hyprland-surface-v1), and Hyprland intersects it with the buffer size. Identical at
  scale 1, which is why every surface declared logical rects for months; at 1.25 each rect covered
  the top-left 80 % of what it meant and the dock, the bar's right end and part of the island were
  not drawn (owner-caught 2026-09-26). `setVisibleRects` converts ONCE for every caller: ×
  `Gdk.Surface.get_scale()` (fractional), rounded outward, re-sent on `notify::scale`. Callers keep
  speaking logical coordinates — never pre-multiply. The INPUT region stays logical (wl_surface
  semantics).

- (A region capture, `capture_region()` over `zwlr_screencopy_v1`, fed the adaptive glass until
  #762, which deleted both.)
- ⚠️ **Every window capture starts and stops a Hyprland screencast session**, and its
  `screencast` / `screencastv2` IPC events do NOT name the client that asked (for a window, its
  title). A privacy indicator built on those events (#646) must discount the captures the shell
  itself makes — the overview's thumbnails — or it lights up for them.

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
- A declaration made while the module is still loading is KEPT (the last per surface) and sent
  once it is ready. It used to be dropped, and a caller that dedupes on its own key — the dock —
  never declared at rest again (found on Hyalo, #761: the bar re-stamps, the dock did not).
- It speaks **many rects** (`setVisibleRects`; `setVisibleRect` is the one-rect convenience).
  `wl_region_add` is additive and Hyprland iterates the clip region rather than its bounding box, so
  N rects cost their own area, not their union's — which is what lets the bar declare "strip PLUS
  the open panel" instead of giving the surface back. ⚠️ **`[]` and `null` both mean CLEAR, on
  purpose, and that is NOT what the protocol says**: a genuinely empty `wl_region` is a surface that
  draws nothing. Nobody wants that as the answer to "I could not measure anything", so the wrapper
  will not produce it — say `null` to mean "I don't know" and get the whole surface.

**Every blurred layer declares a region today** — `DockAxis.ts` (both axes) and `Bar.tsx`. Until
#708 point 3 the island (`IslandWindow.ts`) and the app grid (`AppGridWindow.ts`) were layers of
their own and declared too; both are panels of the bar now, and their rules below are the ones the
bar's walk applies to them. They split into **four rules**, one per shape of the question "do I
know what I paint before I paint it?".

- **The dock knows its silhouette before it paints**, so it declares in every state, hidden
  included. Since 2026-08-09 that is literally every state: the two branches that used to hand the
  whole surface back — an open app grid, and a yield — are gone, the first because the grid moved
  out and the second because it was only ever justified by the grid.
- **The island declares `capsule + whatever mode is live`** (2026-08-10; on its own layer then —
  in the bar since #708 point 3, where the capsule is inside the strip's rect and each mode is a
  `masterOverlay` child the walk covers, with the same `onAllocated`). It used to declare only at
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
  moving". (The chips needed a 200px pad on the island's own layer; inside the bar's full-width
  strip they need nothing.)
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
- **The app grid is the third case: it declares only while OPEN.** (Written for its own layer,
  2026-08-09 to #708 point 3, which was also UNMAPPED while closed. In the bar it is a
  `masterOverlay` child: the walk gives it `onAllocated` — which also covers the no-results shrink
  below — and pads its rect by `GRID_PAD` = 48 for the shadow outside its allocation.) It
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
  same key/apply cycle as its input region so the two cannot drift, it speaks its own surface
  coordinates (`WIN_W`/`WIN_H`, converted to buffer pixels by `setVisibleRects` like everyone's),
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
owned the per-window geometry, so thumbnails were an insertion, not a rewrite. Three rules that are
easy to get wrong there:

- **The thumbnails are clipped by the OVERLAY (`overflow: HIDDEN`), not by the `Gtk.Fixed` that
  holds them.** A Fixed's minimum size is its children's extent and GTK allocates an overlay child
  at least its minimum, so a floating window hanging off the screen grows the Fixed — and a clip on
  the Fixed grows with it. Owner-caught 2026-09-26 at scale 2: floating windows' captures spilled out
  of the bottom of the card. The overlay is sized by the canvas alone. That clip is RECTANGULAR, so
  each thumbnail also clips itself to the backdrop's ROUNDED corner (`WindowThumbnail.setFrame`, the
  preview's rect in the thumbnail's own coordinates, radius from the same `backdropRadius` the
  canvas paints with) — else a window at a corner poked a few square pixels past it.

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
  wallpaper also changes behind this manager's back — anyone can run `awww` — and `_current` is
  only a hint (awww owns the live one). Game mode does NOT change it behind its back: it goes
  through `showForGame`/`restoreAfterGame`, which save nothing and announce nothing. Called at schematic build
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
`NIDARA_FOCUS_GRAB=0`). **Every modal surface is on it: the bar — ONE grab for all of its panels,
the island's modes and the app grid included (`barModal`, since #708 point 3) — and the dock's
keyboard walk.**

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
press outside the set dismisses and *does nothing else* — it never reaches what you clicked. While the
island was a surface of its own, **the bar and the island had to whitelist each other** or a bar panel
made the whole island unclickable; one surface removed that. What is left: **with the app grid open
the bar's grab carries the DOCK** (`gridPeers`), so its icons still launch in one click, and only
then — a press on the dock closes the CC like a press anywhere else. The set changing under a held
grab (CC → grid) re-acquires: the same owner re-acquiring is not an eviction.

🔑 **One grab, several owners → `acquireFocusGrab` returns an ownership TOKEN and `releaseFocusGrab(token)`
no-ops for anyone else.** The shim holds a single grab (the compositor has a single slot) but the bar
and the dock ask for it independently (and, until #708 point 3, the island and the grid did too), so a bare `release()` destroys *whatever grab exists*: island
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
- ⚠️ **`masterOverlay`, not `barBox`.** `.bar-centerbox` carries `margin-top: 4px` (8px until
  2026-09-25, when the strip was 40), and a CSS margin lies OUTSIDE the allocation: the bar window was 40px tall and `barBox`
  measured **y=8, h=32, x=8** with the old margin (`query_ui`), so the bands above it and at both ends
  belong to the overlay behind it. They are
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

⚠️ **Scope each `cleared` handler to what its own surface owns.** The bar closes its panels (the
island's modes and the grid among them), the dock its walk; a handler reaching further would shut
whatever the other surface just opened. The wider "close everything" belongs to `dismissOverlays()`, which runs off a REAL click on
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
re-stamp (the island did, `holdRegion`, while it had a surface of its own). The one moment holding is wrong is before the first successful
stamp, when there is nothing to hold: a Wayland surface with no region takes input across its whole
buffer, so a monitor-sized surface must stamp empty until it has measured something once.

🔑 **A surface whose region is measured needs a re-stamp trigger for its PERMANENT furniture, not
just its transient parts.** The island's revealers had `onAllocated` and its morph had `onDone`; the
always-present capsule had nothing, which is exactly why its failure lasted the whole session. Note
the bar does not have this problem for a structural reason worth copying where you can: it unions an
unconditional `{0,0,monGeo.width,BAR_H}` strip, a constant that cannot fail to measure — and since
#708 point 3 the island's capsule and chips are inside it, which is what ended this family of bugs.

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

## The session notification daemon

`session/` is a Cargo workspace independent of `hyalo/`, with one crate in
`session/daemon`, binary `nidara-sessiond` (Rust, zbus + Tokio; GLib only for GSettings, on a
thread of its own — `Config1` below).
It owns `org.freedesktop.Notifications` at `/org/freedesktop/Notifications` for
the whole session. Killing/reloading `nidara-shell` leaves the owner, history,
sender timers and incoming notifications alive. NM/BlueZ agents and SNI remain
where they were; this split moves only notifications.

The shell connects to `org.nidara.Session`, `/org/nidara/Notifications`, interface
`org.nidara.Notifications1`: `List() → s` (JSON array), `Dismiss(u)` (reason 2),
`InvokeAction(us)`, signals `Notified(ubs)` and `Resolved(uu)`. Every JSON record
has the old `Notification.serialize()` shape. The client subscribes before `List`
and silently merges signals buffered during that call. Calls target the unique
owner and stale replies are rejected by generation, so a daemon restart cannot
resurrect an older snapshot. **Hydration never calls onNotified**: existing banners
subscribe to it and would flood the screen. A local `onResolved(0, UNDEFINED)`
invalidates the roster after hydration so an already-open NC rereads it through
its existing subscription; id 0 is reserved and is never a real notification or a
D-Bus resolution. Without a daemon the client warns once and presents an empty
NC; it never claims a bus name or starts a replacement server.

The compatibility rules now live in `session/daemon/src/{model,store,main}.rs`:

- Capabilities are exactly `actions`, `body`, `body-markup`, `body-images`,
  `icon-static`, `persistence`. Never add `sound` (senders suppress their own),
  `body-hyperlinks` (cards discard anchor URLs), or `action-icons` (buttons draw labels).
  Server information stays `nidara`, `nidara-project`, `1.0`, `1.2`.
- Adopt nonzero `replaces_id` through `0x7fffffff` even after it was resolved;
  preserve insertion order for a live replacement, advance the sequence, and
  wrap into unused lower ids at the bound rather than overflowing uint32.
- Only a positive **sender** timeout expires a notification (reason 1); 0 and
  negative values keep the card. Replacing cancels its old timer. Restored
  history has no rearmed timers, as with the GJS server. The user's banner timeout
  and Do Not Disturb stay shell policies in `NotifConfig`.
- Invoke emits `ActionInvoked` before resolving (reason 3), unless `resident`.
  Dismiss resolves with reason 2; sender close with 3. Already-gone ids are no-ops.
- The debounced, atomically replaced store is still
  `~/.cache/nidara/notifd/state.json`, `{version:1, notifications:[…]}`;
  `transient` is live but excluded from disk. Graceful termination flushes the
  pending burst. Hints in JSON remain scalars, so old history survives directly.
- Modern `image-data` RGB/RGBA pixels (8 bps, padded rowstride allowed) become
  `images/<first 32 SHA256 hex chars>.png` and an `image-path` hint. Deprecated raw
  `image_data`/`icon_data` are dropped; the legacy path hint `image_path` remains
  readable. Encode into a temporary file inside `images/`, finish the PNG and
  sync it before renaming to the hash filename: a failed write must never become
  a permanent cache hit. Errors remove the temporary file and keep the notification,
  so a later arrival can retry. The cache prunes oldest files to 150. Directories
  are created 0700, state files 0600. **Never move this into
  config**: `~/.config/nidara` is a read root of the assistant's file layer and
  notification bodies contain private mail/chat/2FA codes.

`bin/nidara-sessiond.service` is `Type=dbus`, `Restart=on-failure`,
`PartOf=graphical-session.target`, ordered before `nidara.service`, which Wants it.
Both compositor configs explicitly start both units; systemd waits for the daemon's
private name before starting the shell. Neither unit has `[Install]`: the generic
graphical target also belongs to other desktops. There is deliberately **no D-Bus
activation file** for the public notification name. Shell reloads restart only
`nidara.service`; logout stops both. See dev-workflow.md for builds and integration.

### `Config1` in the session daemon (`--config`, the Rust session)

`nidara-sessiond --config` serves `org.nidara.Config1` (`session/daemon/src/config/`) with the
interface, members and rules of the TypeScript shell's `ConfigService.ts`: `Snapshot`/`Apply`/
`Updated` with epoch and revision, `Describe`/`Get`/`Set`/`Changed`, the native Settings'
owner trusted, any other sender gated by `ai.allowConfigWrite`, errors `Denied`/`Invalid`/
`Failed`. Without the flag it serves notifications only, and with it a name already owned
(the TS shell's, in its session) is left alone — the daemon keeps running.

- **The keys are a table** (`registry.rs`): type, enum (re-read at every `Describe`), bounds,
  validation and canonical value, its home, what announces it, how to draw it. Today Appearance's
  (D1 [A2]) plus `accessibility.reduceTransparency` and the read-only `ai.allowConfigWrite`.
- **Homes, not effects.** Each key reads and writes where the desktop already keeps it —
  GSettings (`org.gnome.desktop.*`, `org.nidara.*`), the wallpaper's JSON file — and is announced
  from that home, so a change by ANY writer (`gsettings`, a script, the TS shell) is heard.
  Applying a change (the wallpaper drawn, the screen warmed, the cursor in Hyalo) is the job of
  what follows the key, not of this table.
- **GLib on its own thread** (`store.rs`): `gio::Settings` is not `Send`. The D-Bus side calls
  into it (`Handle::call`), and the thread pushes every change BEFORE answering the call that
  caused it, so `Apply` announces its own change and answers the revision that includes it.
- **No strings.** `ui` carries i18n keys (`ui.i18n`, an option's `i18n`); the native Settings
  fills `title`/`subtitle`/`label` from its own catalogue when a server leaves them out
  (`session::set_translator`, D4). A server that sends labels (the TS one) is left as it is.
- `session/daemon/tests/config.rs` runs it on a private bus with GSettings on the keyfile
  backend in a temporary directory: trust gate, canonical answers, errors, a no-op, and a change
  by another writer (`gsettings`, the wallpaper file) announced.

## Boot sequence

1. Display manager (greetd by default) runs `/usr/bin/nidara` via `/usr/share/wayland-sessions/nidara.desktop`.
2. `nidara` (session wrapper script) sets Wayland/GI env, then:
   `exec uwsm start -e -D Hyprland hyprland.desktop -- -c /usr/share/nidara/config/hypr/hyprland.lua`.
   uwsm runs the session as systemd units → activates `graphical-session.target`, clean teardown on exit.
3. `hyprland.lua` on `hyprland.start` explicitly starts `nidara-sessiond.service`
   then `nidara.service` (systemd orders them and waits for the daemon's private name).
   The Hyalo session does the same from `config/hyalo/hyalo.toml`. Background helpers
   use `uwsm app -- <daemon>` (independent systemd scopes):
   `awww-daemon`, polkit agent, `hypridle`, and `wl-paste --watch cliphist store`
   **twice** — once `--type text`, once `--type image` (see the clipboard widget notes below;
   one untyped watcher silently never captures an image).
4. **`nidara-ui`** (UI launcher in `/usr/bin/`): kills stale `gjs`, then —
   - **Dev mode:** if `~/.config/nidara/.dev` exists, `cd` to its path and run `scripts/run.sh app.ts`.
   - **Prod mode:** exec the bundle at `/usr/share/nidara/ui/shell/build/nidara`.
   - Log: `${XDG_RUNTIME_DIR:-/tmp}/nidara-ui.log` (per-user — see tech-debt "Resolved" rule on log paths).
5. **`app.ts`** (`ui/shell/app.ts`): sets dark/light via `Gtk.Settings.gtk_application_prefer_dark_theme` (pure GTK4 — no `Adw.init()`); registers the `nd-*-symbolic` icon search path; `app.start({ applicationId: "org.nidara.desktop", main, requestHandler })`. In `main()`: iterates monitors → `createUI(monitor)` (Bar + Dock per monitor), wires the dock-rebuild debounce (⚠️ the old dock is `close()`d AND `run_dispose()`d: in GTK4 `close()` only drops GTK's own reference, and `"destroy"` — which is where the dock releases its HyprlandState/Theme/glass subscriptions — comes at dispose, which those very subscriptions prevented. Until 2026-09-29 every position/auto-hide change left the old dock alive, unmapped and still listening), and populates `core/ShellActions` + the IPC registry (the bar/dock blur layer rules live in `hyprland.lua` as `hl.layer_rule` — the old `hyprctl keyword layerrule` calls were dead under the Lua parser and were removed).
6. Reload in dev: **`Super+Shift+R`** re-runs `nidara-ui` (the old `start_ui.sh`/`reload_ui.sh` no longer exist).

### The greeter's entry waits for a GPU, and the wait has a ceiling

`bin/nidara-greeter-session` is what greetd runs, and it does one thing before starting Hyprland:
it waits for a DRM card that belongs to a **real** driver. greetd is ordered after
`systemd-user-sessions` and `plymouth-quit-wait` and after nothing at all to do with the graphics
card, so on a machine whose GPU takes a moment to probe it starts the greeter too early, Hyprland's
aquamarine backend cannot start, and it aborts with an uncaught `std::runtime_error` — six boots
out of six on a Navi 10 box, always by less than a second (#477). greetd's restart is what put the
login screen up, ~2 s later, which is why the only symptom was a black screen nobody could name.

⚠️ **"A DRM card exists" is the wrong condition, and it is the one you will reach for.** `simpledrm`
has already claimed `/dev/dri/card0` from the firmware framebuffer by then, and the real driver
evicts it when it takes over — so waiting for *a* card returns instantly and fixes nothing. The
predicate is: a `card[0-9]*` whose `device/driver` is not one of the framebuffer shims
(`simple-framebuffer`, `ofdrm`, `efi-framebuffer`, `vesa-framebuffer`), with at least one connector
and a node in `/dev/dri`.

The wait is capped at 5 s (100 × 50 ms) and then starts the compositor **anyway**, logging through
`logger` because the script discards stdout/stderr to keep boot messages off the TTY. Verified in
the VM by forcing the predicate to never succeed: the warning appears, the login screen still comes
up one second later, nothing aborts. A login screen that never arrives would be a far worse bug
than the one being fixed — same rule as the teardown below.

### The greeter's exit is a teardown, not a cut

The greeter is its own Hyprland instance, and `config/greetd/hyprland-greeter.lua` is the whole of
it: line 14 starts `awww-daemon` by hand, and the last line exits the compositor when
`nidara-greeter` returns. **Whatever that file starts, that file has to stop — before it drops the
compositor.** Exiting first pulls the Wayland socket out from under everything still connected, and
a client that is mid-read does not shut down, it panics: `awww-daemon` dumped core on *every* login
until 2026-09-07 (#479), and `xdg-desktop-portal-gtk` logged `Error reading events from display:
Broken pipe` and failed its unit in the same second.

Why the desktop side never had this: there, every daemon is a systemd unit (`uwsm app -s b -- …`),
so logout stops them in order and the compositor goes last. The greeter has no uwsm and no units, so
the ordering is written out by hand — `awww kill`, a bounded wait, `systemctl --user stop` for the
portal stack, and only then `hl.dsp.exit()`. Two rules for anything added there:

- **bound every wait.** This is the path a login is standing on; a daemon that refuses to die must
  never be able to strand a machine on the login screen (hence the ~2 s cap and the `timeout` on the
  systemctl call, whose units default to a 90 s stop timeout).
- **measured cost: ~150 ms** of the handoff, and the handoff as a whole stayed at 1 s. The seam was
  never slow — it was a collapse. "Smoother" here means "nothing crashes", not "faster".

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
the shell restarts mid-session (`Restart=on-failure`, `Super+Shift+R`), and a shell that painted the
wallpaper as it started would stomp a running game's artwork (`core/GameSession.ts`).

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
  - `bar/`, `dock/`, `control-center/`, `app-grid/`, `island/` (the Activity Island: the bar-center capsule as a multi-purpose morphing surface. COMPACT state = a `Gtk.Stack` (crossfade + `interpolate_size`, so the pill's width animates) whose pages MUTATE by activity: one page per registered activity, **including the workspace dots** (which absorbed the old `bar/Workspaces.tsx`). **Activities are DATA** (`IslandActivity` in `ActivityIsland.tsx`; the concrete ones in `IslandActivities.tsx`): each declares `{compact form, priority, watch/isLive liveness, expandMode?, autoExpand?, makeGhost?/artSource? morph continuity}` and OWNS its liveness policy; the engine only arbitrates — highest-priority live activity fronts the compact. Current activities: **dots** 0 (`isLive: () => true` — the FLOOR, so "nothing running" is not a special case but the dots winning, and there is no `else` branch. They used to BE that else branch, and it was a bug: with any activity live the capsule's click opened THAT mode and the workspace overview became unreachable by mouse. `expandMode: overview`, no `makeGhost` — their morph continuity is the traveling `MorphPair` set, not a dissolving twin) < **media** 10 (`PlayerCompact`: mini art + title + 10fps Cairo EQ; pause holds a 12s grace, the open player panel holds liveness, player leaving the bus drops it instantly) < **recording** 20 (STEADY danger dot + elapsed, mirrors `status.recording`; the shell's ONE live-capture display since the CC banner row was dropped — the elapsed text comes from `recordingElapsed()` in `core/Status.ts`, off the single `recordingStartedAt` stamp, so no two surfaces can disagree and one built mid-capture never restarts at 0:00. `expandMode: ISLAND_RECORDING` → `RecordingIsland.tsx`, a statement card of clock + Stop, so the island answers for the capture end to end and stopping never depends on where the user put a widget. Its two earlier destinations were both wrong and both user-caught: the workspace overview (leftover from when the overview was the capsule's default identity, 2026-08-01) and then `onExpand → toggleCC` (fine only while the CC banner held the only Stop — with that row gone and the screenrecord widget placeable in the BAR ONLY, the click could open a Control Center with nothing about the recording in it, 2026-08-02). The FAST Stop is the bar pill, one click, see the `barClick` contract below) < **battery-critical** 30 (`≤5%` discharging, clears `>7%` or charging — hysteresis because UPower ticks are coarse; **the auto-expand prototype**: takes the front AND opens its alert once per takeover; the agent's "needs confirmation" will ride the same `autoExpand` flag) — and **agent** 25 (the built-in Assistant, between recording and battery: live while a turn runs (`agentService.busy`, the "working pill") or its panel is open; does NOT use the engine `autoExpand` — `AgentService` opens the island itself when a BACKGROUND turn finishes, since the flag fires on taking the front, not on finishing; closing the island mid-turn does not cancel). EXPANDED modes morph out of the capsule via one MorphRevealer per mode, driven by `status.island_mode` — `overview` (keyboard nav), `player` (the shared media detail panel from `widgets/media.ts`, no keyboard grab), `battery` (`BatteryIsland.tsx`, a plain statement card), `agent` (`AgentIsland.tsx`, the Assistant chat: header + streaming transcript + text entry; `needsKeyboard:true`, its `handleKey` claims only Escape so the entry types — the island's first TEXT mode). Cross-activity rules live in the engine's `arbitrate()`: a DEAD activity's open surface closes (player left the bus, battery recovered); auto-expand fires only when the activity TAKES the front (closing the island while the condition persists must not re-open it). **A chip click PROMOTES, and promotion is NOT expansion: it pins its activity to the front (`pinned`) and stops there** — the chip swaps into the capsule so the thing you picked is the thing the bar is showing, and a SECOND click, on the capsule, expands it. It used to do both in one click; `promote()` dropped its `openAfterSwap` call on 2026-08-22 (#226). A chip is a "show me this" control, not a "take me there" one — the same separation `onExpand` already had, now applied to the mode too. **The rule since 2026-10-07 (owner): a chip NEVER opens a panel — it always flows into the capsule, and the capsule is what becomes the panel.** The capsule as a mere indicator is a use of its own (the dots without the overview, what is playing without the player). The setting `bar.island.chipOpensPanel` (GSettings `org.nidara.bar chip-opens-panel`, default false) brings the panel up ONCE THE FUSION HAS LANDED, through `openAfterSwap` — island modes only; it has no Settings row yet, the owner is designing the Activity Island's own entry on the Top bar page. On Hyalo the swap is visible as one: a front change or a chip born/gone/changed calls `pulseFusion` on the island's fusion group, so the chip and the capsule become one capsule during the swap (`references/hyalo.md` → "Fusion"). Priority is a guess about what matters and a click is not, so the pin outlives every ordinary change and ends only when the user picks something else or the pinned activity dies. ONE exception: an `autoExpand` activity (a critical battery) takes the front anyway because interrupting is its whole purpose — and it does NOT clear the pin, so what the user chose comes back when the interruption passes. Auto-expand opens through `openAfterSwap` and is its ONLY caller since #226, never in arbitration's own tick (see the phantom-% gotcha above); a chip click does not open anything. An activity with no `expandMode` opens its `onExpand` instead — the destination where it can actually be acted on (recording used to point here before it got a mode of its own) — and nothing at all if it has neither. **`onExpand` fires only from an EXPAND click (the capsule), never from promotion**: `openAfterSwap` handles island modes only, because switching the capsule to an activity is not the same act as asking to be taken to another surface, and one click must not do both (user call 2026-08-01). Promoting a capture puts the timer in the capsule and stops; its second click makes the jump. **There is no fall-back to the workspace overview**: that existed only while the overview was the capsule's default identity, and once the dots became an activity with a mode of their own it just meant an unrelated surface answering the click (user-caught 2026-08-01, on the recording pill). **A live OR indicated activity can be pinned** (since 2026-10-07; until then only a live one, and the idle assistant's chip opened its panel directly — the one chip that did, which is what the owner's rule above ended). The pin's liveness check is `isLive() || isIndicated()`, so the idle assistant parks in the capsule until the user picks something else — that is what the click asked for, not a leak. The LOSERS are no longer discarded — `arbitrate()` publishes every live-but-not-fronting activity as `background()` (+ `onBackgroundChanged()`) on the island handle, **ordered by priority, never by arrival** (an arrival-ordered row would swap icons under the cursor). Note the front can hold steady while the background changes, so the background is computed BEFORE `arbitrate()`'s no-front-change early-out. That list is painted by the **INDICATOR ROW** (`indicatorRow` on the handle, appended to the bar's centre box right of the capsule — the iOS split: a pill for the current thing, circles for the rest, and **the GROUP centres**, so the capsule leaves the monitor axis while anything else runs). A chip is shown for everything INDICATED that isn't fronting, which is WIDER than "live": the optional `isIndicated()` (default = `isLive`) lets an activity earn a chip without competing for the capsule. Only the Assistant uses it — a configured provider is always one click away — and it MUST stay out of `isLive`, or the agent (25) would outrank the music (10) and hold the capsule for a session that never used it. Each activity supplies its own glyph via the REQUIRED `indicator()` (dots → a frozen `.workspace-dot.active` pill, `makeActiveDotGlyph`; media → a music glyph; rec → the steady danger dot; battery → the Cairo glyph; agent → `sparkles`), max `INDICATOR_MAX` = 3 chips. **A chip's usable interior is ~20px, and a chip glyph is 16px:** the chip is a 28px circle (`CHIP_W` = 32 = the bar row height, less `SquircleContainer`'s 2px technical inset per side; `perfect` → radius h/2) and the largest square that fits INSIDE a 28px circle is 28/√2 ≈ 19.8. ⚠️ Since 2026-09-25 `CHIP_W` is `BAR_CAPSULE_H` (still 32, `surfaces/bar/capsule.ts`) and `CHIP_GAP` is `BAR_GAP` = 4 (not 8 as measured below) — **not re-measured with `queryUI` yet**. **Measured, not derived** (2026-08-23, `nidara-ipc queryUI` on a live shell): `bar-centerbox` is h=32, and the indicator row is 80×32 with two chips up — `CHIP_W` 32 + `CHIP_GAP` 8, twice. ⚠️ This paragraph said 24px/28px/≈17 until then, arithmetic from a 28px bar row that had since grown; if the row height moves again, re-measure with `queryUI` rather than trusting the numbers written here. Media used to stack the compact's 20px cover art over its music glyph and the square poked out of the glass on all four sides (user-caught 2026-08-03); shrinking it to the inscribed square would have filled the circle edge to edge and eaten the glass ring that makes a chip read as a chip. **Cover art is not chip material** — it lives where it is legible (the compact's 20px slot beside the title, the panel's 96px). Nor is the compact's EQ: an animated chip damages its layer at its frame rate, and Hyprland charges blur by the layer BOX, so a 24px flourish costs a full-screen re-blur per frame for as long as the music plays (the compact's EQ is 10fps AND `map`-gated for exactly this reason). Chips are static monochrome glyphs on glass. Three traps this cost: (1) the row is `INDICATOR_MAX` FIXED SLOTS, not one revealer per activity — slot `i` shows `background[i]`, and each slot is a `Gtk.Revealer` (SLIDE_RIGHT) wrapping a `Gtk.Stack` (CROSSFADE, `COMPACT_SWAP_MS`) holding one named glyph per activity, crossfading between them IN PLACE. One revealer per activity was the first design and two of them cross-slid over each other whenever activities swapped rank (fixed 2026-08-22, #226); with slots the geometry is positional and constant — every rect stays put and only the glyph inside it changes, so priority order still falls out for free from the order `arbitrate()` publishes; (2) the gap is each chip's `margin_start`, NOT box spacing — a collapsed `Gtk.Revealer` still counts as a visible child, so spacing would reserve its 8px forever and leave the capsule off-centre in an idle session; (3) the chips use `Gtk.Revealer`+`SLIDE_RIGHT` (the bar's existing idiom, `common/widget-kit/bar.ts`), NOT `ScaleRevealer`, which animates the measured HEIGHT only and passes width straight through. A chip appearing MOVES the capsule without resizing it, so Bar.tsx re-lays the flanks out on `onBackgroundChanged`/`onChipsSettled` as well as on the capsule's `glassArea` resize. (No input region to re-cut: the row is inside the bar strip.) Capsule click expands whatever fronts the compact; Super+W always reaches the overview. Battery E2E on a desktop: `scripts/dev/fake-battery.sh` (sudo, dev-workflow.md)), `overview/`, `prism/`
  - **Where the island and the app grid live: in the BAR's window** (`Bar.tsx`),
    like every other panel — #708 point 3, owner's decision 2026-10-06 (commandment
    5, no exceptions). Both had layer surfaces of their own until then
    (`nidara-island`, 2026-07-26; `nidara-app-grid`, 2026-08-09), deleted whole with
    `IslandWindow.ts` and `AppGridWindow.ts`; their reasons were Hyprland's (a layer
    blurs only what was composited before it; layer blur is charged by the BOX) and
    neither holds on Hyalo, which paints each surface's glass from its declared
    shapes. What it bought:
    - **The capsule and the chips are inside the bar strip**, which is always in the
      input region as a constant rect. The whole family of "the island stops taking
      clicks" bugs (a stamp that measured nothing, a torn stamp, chips missing from
      a stamp — tech-debt #68) had no cause left, and the machinery against it
      (`holdRegion`, `scheduleVerify`, the region trap) went with the file.
    - **One focus grab for every panel** (`barModal` in `Bar.tsx`): no second owner
      to evict, no peer windows to whitelist except the DOCK while the app grid is up
      (`gridPeers`, from `app.ts`, re-acquired when the set changes).
    - No raise above the bar, no mirroring of the bar's top edge, no yielding to the
      overflow by unmapping: the row (`islandHost`) simply rises out of the way.
    **What replaced the island's reason — no glass on glass.** A surface's glass is
    drawn under ALL of its content, so a mode growing over the bar's row would show
    the row's groups sharp through its pane. A mode big enough to reach a group —
    or the notification banners below the right group — fades it out with the
    capsule's content: `MorphRevealer`'s `companions` is a getter asked on every
    open (AFTER `set_visible(true)` — a hidden widget measures 0, which is how the
    first cut faded nothing), and `ActivityIsland.coveredBy` returns the neighbours
    (`setNeighbours`) the mode's centred natural rect reaches. The banners' box is
    0 tall while it holds none, so the test is inclusive vertically: a banner that
    arrives under the open overview stays hidden until it closes (it showed through
    the overview's glass in #758, caught in the harness the same night). Only the
    overview is that big today. The island's own pieces do the opposite: they
    FUSE (hyalo.md → "Fusion").
    **The row is centred, never full-width**: it sits ABOVE barBox in the overlay,
    and GTK picks a `Gtk.Box` anywhere in its allocation — a full-width row would
    take every press meant for the left and right groups.
    **The app grid over a fullscreen window** still opens (owner, 2026-10-06): the
    bar's surface rises to OVERLAY while it is up, with the row, the island and the
    banners at opacity 0 and untargetable, and the strip left out of the input
    region (`liftForGrid`). It goes back under the window once the grid has shrunk
    away. Super+B's overlay mode already has the surface there and shows the row.
    **The layer-shell rule worth memorising, because a wrong guess about it cost real
    time:** a surface requesting `exclusive_zone > 0` is arranged against the FULL
    output area; only surfaces asking for **zone 0** get pushed into the remaining
    usable area; `-1` ignores everything. So the bar (zone 40) is the full monitor
    rect, always, whatever the dock reserves — a side dock covers the bar, it never
    displaces it. That is why `syncPanelMargins` dodges a side dock by hand.
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
  (`Slider`, `SquircleContainer`, `ScaleRevealer`, `MenuRow`, `widget-kit/`, `DrawingUtils`…).
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
    Rules: widgets-only directory with NO exceptions left (anything else is a
    codegen hard-error; helpers go in `common/widget-kit/` — `bar-helpers.ts` was
    the last grandfathered file and joined the kit as `bar.ts` on 2026-09-01, so
    EXCLUDE now holds only the registry's own two files); unique `id`; no
    module-scope dependency on another widget (import order is alphabetical).
    **The whole of writing one is `references/writing-a-widget.md`.** Each widget declares a required `category` (`"media"` |
    `"utilities"` | `"system"`) + optional `barOrder`; `BAR_ORDER` is **derived**
    from those in `widgets/index.ts` (category order `[media, utilities, system]` =
    left→right, system nearest the tray — no hand-maintained list). That is only the
    DEFAULT: since 2026-09-26 the person orders widgets, tray icons and search as one
    list (`core/BarOrder.ts`; design-system.md → "The right group's order").
    `CC_DEFAULT_LAYOUT` stays editorial, and it is PACKED, not stored, until the person
    moves or resizes a tile (`CCLayoutManager` "Two modes", 2026-09-28): a tile whose
    hardware is missing is skipped and the rest move up, so hardware tiles can sit
    anywhere in it — Wi-Fi is at the top. A PERSONALISED grid moves tiles only by the
    owner's rules (same day): a growing tile keeps its place and pushes what it covers,
    like a drop (it used to jump alone to the first free cell); a tile that leaves or
    shrinks lets what is below it, in its columns, fall up (`liftInto`) — never sideways,
    never above the freed row — and a gap nothing fits stays, as iOS allows gaps.
    Mixed sizes mean NO rule closes every hole: do not promise one. `CCWidgetSpec` (= `Omit<AtomicWidget,
    "category">`) is what a spec factory returns — it builds content, not registry
    metadata, so it carries no category; `tile.ts`'s `roundToggleSpec` is the only
    one left. ⚠️ A spec's own `defaultSize`/`supportedSizes` are advisory and mostly
    unread, which is how each of the surface-resident factories came to carry a
    second, silent copy of its widget's metadata; do not write a new one that
    restates what its widget already declares.
    **The vocabulary is `common/widget-kit/`, and `widgets/` imports NOTHING from
    `surfaces/` — 28 such imports on 2026-09-01, zero the same day.** The contract (`AtomicWidget`, `WidgetSize`, `ContentBudget`,
    `CCWidgetSpec`) is `widget-kit/contract.ts`; the tile shapes are
    `widget-kit/tile.ts`; the panel width tiers are `widget-kit/panel.ts`;
    `widget-kit/index.ts` is the single import a widget file needs besides `core/`.
    Until 2026-09-01 both the contract and the tile shapes were
    `surfaces/control-center/{Types,Toggles}.tsx`, so declaring a widget meant
    importing the Control Centre — a vocabulary the bar speaks too, owned by one of
    its two hosts. Moving them is what makes the boundary statable, and the boundary
    is the contract: **a widget declares what it is, never where it is drawn.**
    **The tile vocabulary is seven words**, and picking one is the whole of laying a
    tile out: at 1×1 `makeIconTile` (a status icon, no click target — the tile-level
    tap opens the detail, and a toggle here would be a second invisible hit-region on
    top of it) or `makeRoundTile` (a round toggle button); at 2×1 `makeCapsuleTile`
    (icon circle + title/subtitle, nothing clickable — the overwhelmingly common
    case) or `makeSplitCapsuleTile` (the icon badge toggles, the rest opens the
    detail); at 4×1 `makeHSliderTile` (low icon, slider, high icon, live %, and
    everything in it speaks 0..100 — a service storing 0..1 converts at ITS edge);
    and `makeCapsuleInner` + `wrapCapsuleTile` underneath, for a tile that
    needs the refs (screenrecord ticks its subtitle's digits without re-reading the
    icon) or builds its own box (battery's glyph row). The 1×2 slider deliberately
    has NO word here: it is `makeVerticalFillTile` in `ui/lib/nidara-kit`, because
    there the fill IS the tile — `Sliders.tsx` wrapped it in five lines that added
    nothing, which is why volume and brightness looked like two vertical sliders. A whole-capsule button exists
    but is PRIVATE: it swallows the tile-level tap, so it is only correct for a widget
    with no detail panel — and that widget is a **`roundToggleSpec`**, the
    `CCWidgetSpec` factory for a widget that is nothing but an on/off toggle (dark
    mode, calculator). Every maker takes an optional `SubscribeFn` — hand it the
    service's own watcher and the tile re-reads its getters and disposes on
    `unrealize`; do not wire that by hand.
    **Zero-layout contract (2026-06-11)**: a widget never does host-geometry math.
    `buildContent(size, budget)` receives a `ContentBudget` — inner px the host
    guarantees (tile span − island padding, computed in `IslandGrid` from
    `islandPadding()` exported by `BaseIsland`) plus `pitch`, the host's cell
    pitch, for content that must land on the host's rhythm (cpu-memory spaces its
    two rings `pitch − ring` apart so each sits on a cell centre). Size content
    from the budget, never from `UNIT`/`GAP`/padding knowledge — those live with
    `CCLayoutManager` now and are unreachable from `widgets/`; a widget's own
    intrinsic sizes (icon circles, buttons, its caption height) are fine. Panel
    widths (bar expansions / CC details) come from the **`PANEL_W` tier
    vocabulary** (sm 200 / md 220 / lg 240 / xl 280 / full 368), never hardcoded px,
    and the rows inside them from the three words beside it in `widget-kit/panel.ts`:
    **`panelRow`** (label + a control — a switch, a button; was written out five times
    across bluetooth, wifi, focus and night light twice), **`panelInfoRow`** (label +
    a live value + an `update()`; was `infoRow`, duplicated BYTE FOR BYTE in `wifi.ts`
    and `ethernet.ts`) and **`panelSeparator`**. What is deliberately NOT a word is
    the panel COLUMN: a bar expansion sizes itself (`spacing: 12` + a PANEL_W tier)
    and a CC detail fills what it is given (`spacing: 0`, hexpand), and one word for
    both would be a word that lies. Nor are a row's outer margins — a `margin_bottom:
    4` in these panels means "a separator follows" and a `margin_top: 4` means one
    precedes, context the row cannot know, so the caller sets them on what it gets
    back. Same reason `panelSeparator` carries 2px of its own air and the bare
    `new Gtk.Separator()` inside screenshot's and screen recording's `spacing: 12`
    columns is CORRECT there: that column already provides the room. Those two are not
    drift; do not "fix" them into the word.
    GOTCHA: every module in widget-kit/ MUST stay a leaf — importing
    `CCLayoutManager` from one closes the cycle CCLayoutManager → widgets/index →
    widget → widget-kit → CCLayoutManager and **crashes the shell at boot**
    (CC_DEFAULT_LAYOUT undefined mid-cycle; typecheck does NOT catch module
    cycles — only a runtime boot does). That cycle is also why UNIT/GAP were
    parked in the shared leaf: the fix was to stop widgets needing them at all.
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
    An overflowed widget honours it too for free: since 2026-09-25 the overflow unfolds
    the SAME pills in line (design-system.md → "The bar's overflow") instead of listing
    them as menu rows, so there is no second click path to keep in step.
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
  - `common/` — shared: `SquircleContainer`, `DrawingUtils` (which since 2026-08-15 only RE-EXPORTS `hexToFloatRgb` — the implementation moved to `lib/nidara-kit/platform/accent.ts` so the kit's slider could reach it), `ManagedWindow`, `WorkspaceSchematic`, `ScaleRevealer.ts` (the ONE show/hide animation — overlays + banners, see design-system.md), `MorphRevealer.ts` (capsule→island geometry morph: island modes grow out of the bar-center capsule — real interpolated Cairo squircle + traveling element ghosts (`MorphPair`: dots→card headers, cover art→panel artwork) + a dissolving source-content twin so the glass is never empty mid-flight, see design-system.md. Source and target both live on the ISLAND's surface (`IslandWindow.ts` — the capsule moved there with the modes precisely so this stays a plain same-window `compute_bounds`; a version that split them across two surfaces needed a coordinate bridge AND made both surfaces paint glass over the same pixels mid-morph, whose blurs stacked into a visible seam), `WorkspaceDot.ts` (`makeWorkspaceDot` + `WS_COUNT` — the ONE workspace state dot, shared by the bar capsule, the overview card headers and the morph's ghosts; all three must render identically for the morph's endpoint swaps to be invisible), `BatteryGlyph.ts` (`makeBatteryGlyph` + `batteryPresent`/`batteryFrac` — the ONE Cairo battery glyph: bar widget, CC tiles and the island's battery activity all render through it; semantic danger/success fill, never the accent. It is `battery.svg` redrawn in Cairo on the same 24-unit Lucide grid, and its argument is the **icon box in px = `Gtk.Image.pixel_size`**, not a glyph height: pass 16 in the bar and its capsule is exactly as wide as every icon widget's, 28 in CC tiles where siblings use `pixel_size: 28`. Sizing it by eye is what once made the bar's battery capsule 9px wider than its neighbours. Matching the set means matching INK WEIGHT too: the chrome strokes at 0.9 because `.bar-left image` attenuates nothing — a half-alpha stroke at true icon scale reads as a washed-out hairline and the glyph looks smaller than icons whose ink box is the same width. Painter and `battery.svg` are ONE drawing on one grid — edit both or neither, or the shell ends up with two batteries (the SVG is what Settings, the widget picker and the no-battery state show). Its ink deliberately spends Lucide's 22-unit content box out to the full 24 so the charge cavity stays legible at 16px; the 1.5-unit gap before the terminal nub is the floor, below which the two shapes antialias into one smudge at bar size), `CoverArt.ts` (`makeCoverArt` + `PANEL_ART`/`PANEL_ART_RADIUS` — the ONE album-artwork painter: the three CC media tiles, the media detail panel, the island's compact player and the morph ghost. Squircle at a given radius or `"circle"`; a fixed `size` sets the widget's box AND the decode size, omitting it fills the allocation and scales per draw. It owns the DECODE (guarded by art PATH identity — a player's `notify` fires for every property it touches, and an unguarded decode re-read the PNG every second for the whole session, tech-debt #11C) and the SUBSCRIPTION (MPRIS selection + the selected player's notify + `Theme` changed, on `bindWhileRealized` — the CC builds its tiles once and hides them, so a one-shot unrealize cleanup freezes the art at whatever played when the panel first closed). It ALSO re-checks the path at DRAW time, which is what lets the morph ghost carry the current track into a flight it was not subscribed for — but the `onArt` callback does NOT fire from there: it flips another widget's visibility (the 1×1 tile's play glyph) and doing that inside a snapshot queues a resize mid-draw. It was written SIX times before this, and the drift is the reason it exists: three different placeholder alphas, and only the island's two followed `Theme.chromeIsDark` — the four on the CC side painted a fixed white, which on light-pinned chrome is white on white. `PANEL_ART` also retires a hand-maintained "MUST match buildMediaDetailPanel's ART_SIZE" in PlayerIsland), `poll.ts` (`pollWhileMapped` — ANY recurring widget poll must gate on map/unmap: built-once-hidden surfaces like CC tiles must not keep session-long timers; idle baseline is 0 wakeups/s and we keep it that way), `MenuRow.ts` (`menuRow`/`menuSeparator`/`menuHeader`/`setRowChecked`/`menuDisclosure` — the shared row builder for flat `nidara-menu-*` lists; used by the CC context menu and the bar window menu. New flat menus use it, not hand-rolled rows. `menuDisclosure` is our menus' submenu: a row with a chevron that slides its rows down IN PLACE, because the bar's shared expansion has no nested-submenu machinery and no room beside it — the panel grows with them and re-stamps its regions on allocation)
  - `common/WorkspaceModeControl.ts` — the workspace's **mode** (#513): its vocabulary (`modeIcon`,
    `modeLabel`) and the badge on each overview card. 🔑 **The mode belongs to the DESKTOP, so it
    lives where the desktops are** — the overview the dots open, and Settings → Desktop. It was in the
    bar's window menu too until 2026-10-05 and left it when that menu became the APP's (owner): a menu
    hanging from an app's name is no place to re-tile a whole desktop. One module still, so the
    surfaces cannot disagree about what "tiling" looks like. Icons: `grid` for tiling, `app-window`
    for floating. ⚠️ **The badge lives inside the card's `Gtk.Button`, so its `Gtk.GestureClick`
    runs in the CAPTURE phase and CLAIMS the sequence** — without that the card's own click wins and
    the badge silently switches workspace instead of switching mode.
  - `bar/AppTitle.tsx` — the bar's **app name** (owner, 2026-10-05): the focused window's APP as the
    app grid names it (`appService.appNameForWindow` — the entry's `Name=`, localized, through the
    dock's own lookup), never the window's title: every window carries that in its own title bar now.
    No title filters, no hand-kept class→name table (both went — the table was Spanish-only). No
    window: "Desktop N" (`overview.workspace` + the number; game mode's workspace says "Gaming"), and
    no menu opens. No tooltip — a deliberate exception to "every bar capsule has one"
    (design-system.md → tooltips). It listens to `"changed"` (focus, workspace, class) and to the app
    registry, NOT to `"title-changed"`.
  - `bar/WindowMenu.ts` — the **window-options menu**: any-button click on the AppTitle capsule opens it in the bar's shared expansion capsule (`openCustomExpansion`, same system as tray menus — glass/fade/anchoring/outside-click for free). Anchoring defaults to **centered** under the pill (fine for right-side tray menus), but left-edge capsules pass `align: "start"` so the panel's left edge sits flush with the pill's — AppTitle does, because a centered panel there spills off the left screen edge. It is the APP's menu since 2026-10-05 (owner), with no header — the capsule above it already names the app. Top to bottom: SIZE — Minimize (`caps.minimize`), Maximize, Fullscreen; a separator; PLACEMENT — Floating / Tiling as two rows with the check on the one the window is (owner, 2026-10-05; the words are the desktop mode's, `modeLabel`), + Center / Pin to all desktops when floating. Not a lone "Float" row: that was Hyprland's tiling-first habit, and on a floating desktop it is checked on every window and, pressed, tiles it without saying so. A floating desktop takes a window into its mosaic and leaves the rest free. All checks come from the one `readWindow` read, Maximize checking fullscreen MODE 1 and Fullscreen mode 2; then **group/tabs** (Hyprland only, `caps.groups`); "Move to another desktop ›", a `menuDisclosure` listing every desktop but the current one, built when it opens; "App settings…" (`shellActions.openAppSettings` → Settings' `navigateToApp`: Apps › Installed apps › <app>, walked as a click would so the list row keeps its own `syncRow`; only for an entry the app grid lists); Close window; Quit <app> — every window of the app, the dock's Quit. Gone: Pseudo-tiling (Hyprland jargon, still on `Super+P`) and the desktop's mode (see `WorkspaceModeControl.ts`). The group section reads `grouped` (member addresses in tab order) from the same json read: one `menuRow` per member (checked = the menu's window, i.e. the active tab; clicking another member = `hs.focusWindow` — focusing a member IS the tab switch), plus "Move Out of Group" (`hs.moveOutOfGroup`, only when ≥2 members) and "Ungroup" (`hs.toggleGroup(addr)`, dissolves the whole group); ungrouped windows get a single "Create Group" row (lone group → groupbar appears, others join by drag/keybind). Clients are used for tab LABELS only (a tab is labelled by its window's title) — never state. Deliberately absent: "move into group" (`into_group` ignores the window selector — acts on the focused window only — and needs a direction, meaningless in a menu) and group-lock (`lock_active` dispatches fine but its state is not readable anywhere, and a check you can't read is bad menu UX). **Stale-focus guard (2026-08-15)**: every row closes over the address captured at open, so the menu CLOSES ITSELF if the focused window changes while it is up — it watches `hs` `"changed"` and compares `bareAddr(hs.focusedClient.address)` against the captured one, bracketed by the root widget's `map`/`unmap` (the expansion rebuilds its content per open, so that is exactly one showing; a re-map re-checks what it slept through, deferred to an idle so the first map cannot re-enter `showExpansion`). The gap it fills is that **the bar's focus grab is only cleared by an outside PRESS** — Alt+Tab, a keybind, or the window simply closing move focus with no click at all, so nothing dismissed the panel and the AppTitle capsule renamed itself to the new window while the menu kept acting on the old one: one label naming two windows. Read the RECONCILED `hs.focusedClient`, never `hl.focused_client` — acquiring the grab can make the compositor announce "no active window", and `"changed"` only fires when the structural signature actually moved, so neither opening the panel nor a churning title can close it. This is also why `input:follow_mouse` is **2** in `hyprland.lua` (pointer focus detached from keyboard focus): under `1`, merely travelling to the capsule re-focused every window on the way.
  - `bar/Tray.tsx` — the **system tray** (SNI, over `core/tray.ts` since 2026-08-18). **Items of the right group (2026-09-26)**: each tray icon is a `barItem(…)` with `barOpen(() => isBarCustomAnchor(btn))`, exactly like search and the widgets — first-class bar icons inside the bar's one right-hand glass (design-system.md → "Bar groups"). It was one `SquircleContainer` capsule per icon from 2026-07-15 until then. Since 2026-09-26 `Tray.tsx` returns a `TraySource` (`keys()` + `widget(key)`), not a container: the bar places each icon wherever the right group's ORDER puts it (`core/BarOrder.ts`), between the widgets, and re-parents the same widget on every rebuild. The key is the SNI `Id` (`tray:<Id>`), recorded in `tray-known` for Settings. The icon carries `BAR_ITEM_PAD` a side → the button is 32px and fills the item, so the whole item left/right-clicks. **Right-click** → the app's DBus `menu_model` rendered by us via `openCustomExpansion` (same glass expansion as the window menu, never a native GTK popup; built **lazily on first open**, which used to be a workaround for the appmenu-glib-translator crash and is now plain economy — N items would otherwise mean N `GetLayout` round trips at boot, waking every tray app to build a menu nobody asked for. `about_to_show()` now runs on EVERY open (the spec's point: the app refreshes its rows), and it is async, so a wedged app costs a stale menu instead of a frozen bar). **Left-click** → raise the app's OWN window. Why NOT just `item.activate()`: SNI Activate means "raise your window", but a Wayland client CAN'T self-focus or pull you to its workspace (compositor blocks self-activation), so `activate()` returns OK yet nothing happens for a window parked on another workspace. Nidara IS the compositor's shell, so it raises the window itself, matching tray-item→window best link first: **(1) PID** — `GetConnectionUnixProcessID(busName)` on the item's bus (`item_id` is `<busname>/<objectpath>`) vs each `hs.clients[].pid`; deterministic, verified exact for Telegram + Antigravity; misses only proxied/legacy X11 icons whose bus owner is the proxy. **(2) name heuristic** — normalise the item's `id`/`icon_name`/`title` AND the window `class` to bare alphanumerics, accept when one contains the other (`org.telegram.desktop-attention-symbolic` ⊇ `org.telegram.desktop`; `Antigravity_status_icon_1` ⊇ `antigravity`). **(3) `item.activate()`** — only when no window matches (app truly minimised to tray with no surface → let it restore). Items that **declare** `ItemIsMenu` (no activate action) open the menu on left-click too — note the property defaults to FALSE per spec and `core/tray.ts` honours that, where AstalTray defaulted it to true and sent every app that omits it (most of them) down this branch. The PID is resolved async once per item and cached; a click before it resolves just falls through to the heuristic.

Other top-level dirs: `ui/lib/nidara-kit/` (pure-GTK4 primitives lib — see end of file) and the greeter/lockscreen bundles. `ui/lib/` itself holds small modules shared ACROSS bundles: `users.ts` (user enumeration + avatar path resolution — used by greeter, lockscreen AND Settings → Users; its displayName falls back GECOS→username. Never use `GLib.get_real_name()` for a display name: it returns the literal string "Unknown" when GECOS is empty, which is how archinstall creates users, and it caches at process start so it goes stale after a rename), `avatar.ts` (circular avatar for greeter+lockscreen — Gtk.Picture + center-crop pixbuf + pill radius, the same recipe as Settings → Users; plain Gtk.Image can't clip to a circle), and, since 2026-09-23, NOTHING the kit needs: `accent.ts` (the 9 accent hexes + `hexToFloatRgb`), `signals.ts` (`safeDisconnect`; `core/signals.ts` re-exports it), `status-colors.ts` and the rest of the platform moved into `ui/lib/nidara-kit/platform/` — see "The kit is a package" at the end of this file.

## `core/` services (singletons)

These are GObject singletons. Widgets subscribe to them via `notify::prop`. **None of them ever import a widget or call UI code directly** — state flows out, never in.

| File | LOC | Role |
|---|---|---|
| `Status.ts` | 202 | Central GObject state machine for overlays. Mutually-exclusive setters (opening one closes the others). Props: `cc/nc/prism/system-menu/about/settings-open`, `island-mode` (Activity Island mode string, "" = collapsed; replaced `overview-open`), `recording`, `cc-edit-mode`, `bar-expanded-id`, `bar-overflow-open`, `cc-detail-id`. Exports island mode ids (`ISLAND_OVERVIEW`, `ISLAND_PLAYER`, `ISLAND_BATTERY`). **See `state-and-ipc.md`.** |
| `InputYield.ts` | ~125 | The shell **stepping out of the way** so computer-use can reach a real window. A grabbing surface CLAMPS pointer focus to itself, so from inside the Assistant island (always grabbing) clicks were swallowed and `focus_window` was a no-op. (Under the old layer-shell path the reason was different and stronger — `rawWindowFocus` refuses to move window focus at all while a surface is in `m_exclusiveLSes` — which is why this module survived the focus-grab migration rather than dying with it.) `begin()` makes every grabbing surface RELEASE its focus grab **and** stamp an empty input region, resolves only once the compositor has ANNOUNCED the release (`HyprlandState.afterGrabRelease`), `end()` restores. Driven by the HELPERS via the `yieldInput` IPC (so external MCP clients are covered too), re-entrant, with a 15 s watchdog so a helper that dies mid-action cannot leave the shell keyboard-less. Surfaces opt in with `registerHolder()` + a `notify::active` handler: Bar (Prism), IslandWindow, AppGridWindow. (It was DockCore until 2026-08-09 — the grid was the only thing on the dock's window that ever grabbed, and it left with its own surface, so the dock now holds nothing and asks for nothing.) **See `state-and-ipc.md`.** |
| `AppService.ts` | 855 | `.desktop` discovery, icon resolution + fallbacks, WM-class → Desktop-ID mapping. Backs Dock + AppGrid + Prism. **Two catalogues, and picking the wrong one is a silent bug**: `getAllApps()` is the WHOLE registry including `NoDisplay`/`Hidden` entries (24 of 80 on a normal Arch box) because a hidden entry is still what names a window and owns its icon — that is the IDENTITY catalogue. `listApps()` is the launchable subset (`AppData.visible`, from `g_app_info_should_show()`) and is what a launcher may put on screen. `queryApps(q)` ranks the launchable subset (app grid, uncapped); `search(q)` ranks the WHOLE registry capped at 8 (Prism, the agent's `launch_app`) because a name somebody TYPED is evidence they want that specific thing — the agent run that motivated the ranker's rescue tier was asking for GTK Widget Factory, a `NoDisplay=true` entry. Both rank through `core/app-search.ts`, so the two surfaces can never disagree about what "files" means. `AppData.icon` is the CANONICALIZED icon (what you draw); `AppData.rawIcon` is the `Icon=` field verbatim (the key an override is filed under). **Launching: ALWAYS go through `getLaunchCommand(id)`** (wrapped in `uwsm app -- sh -c 'cd "$HOME" && exec <cmd>'`): it picks `flatpak run` for flatpak entries (gtk-launch's D-Bus activation dies silently for them when the session bus indexed its service dirs without the flatpak exports) and `gtk-launch` for everything else. Never parse `Exec=` by hand. Flatpak/Snap *discovery* requires `XDG_DATA_DIRS` set **before gjs starts** — done in `bin/nidara-ui`; GLib caches data dirs at first use, so patching the env in-process cannot fix it (verified 2026-06-12). **Icon LOOKUP is centralized here; app IDENTITY is the step surfaces keep skipping** (both bugs below found 2026-08-02, from one user report). `getIconName` answers "what art is this icon name", never "which app is this thing" — so a surface holding a foreign identity string must normalize it FIRST, and there are three entry points depending on what you hold: **`resolveWindowApp(class)`** for a Hyprland window, **`iconForAppName(name)`** for a human display name, **`isGenericIconName(n)`** to test whether a name you were handed is a placeholder rather than an answer. Skipping the step doesn't error — it renders the generic glyph, so the only symptom is two surfaces drawing the same thing differently. Concretely: the workspace overview fed `c.class` straight in, and since no theme has an icon called `io.Astal.ags`, **Settings drew the generic glyph in the overview and its registry icon in the dock** (the dock normalizes; the overview didn't). And the CC/Settings audio rows took the audio stream's `icon` at face value — but that property is NEVER empty (a rule `core/wireplumber.ts` deliberately kept when it replaced AstalWp, because the UI depends on the placeholder being resolvable): a client declaring no `application.icon-name` gets `application-x-executable-symbolic`, a perfectly resolvable name for the generic glyph, so **GNOME Clocks played audio under a gear**. Same rows also had the app name wrong: on an audio stream `name` is the STREAM ("Playback", from `media.name`) and `description` is the client ("Clocks"). ⚠️ **A stream has NO `node.description` at all** (measured 2026-08-18 against a live Chrome and a `pw-cat`), so that client name reaches the UI only through the fallback chain `node.description → node.nick → node.name`; drop the chain and every per-app row goes blank. The notification centre survives both only because it asks the registry FIRST (`getResolvedApp(desktop_entry || app_name)`) — its no-match fallback was hardened the same day. **The audit behind those fixes is done: every icon call site in the shell is listed by `grep -rn "getIconName(\|iconForAppName(\|resolveIconChain(\|resolveWindowApp("`, and all of them now normalize. `surfaces/bar/Schematic.tsx` was deleted in the same pass** — 195 dead lines nothing imported, superseded by `common/WorkspaceSchematic.ts`, still carrying both bugs plus `nd-icon` on app icons. Dead code that models the wrong pattern is worse than none; it is what a grep finds first. For ordered icon-name fallback chains use `resolveIconChain(names)` (theme-first: any name in the ACTIVE theme beats earlier names that only exist in deep fallbacks or shipped assets; absolute-path entries = final custom fallback) — plain `getIconName(array)` exhausts deep fallbacks per name. Icon resolution NEVER mixes themes: per-app override (`~/.local/share/icons/nidara/`) → active theme (+ its `Inherits`) → hicolor (the app's own installed icon) → pixmaps. An icon the active theme lacks is fixed via the Settings → Apps per-app override, never by borrowing from another installed theme. When nothing resolves, app surfaces (dock, app grid, Prism, overview) fall back to `application-x-executable` (the active theme's generic app icon) — never GTK's broken-image `image-missing`. **Per-app override GOTCHA:** overrides are stored under the basename key (`iconOverlayKey`, e.g. `/opt/foo/bar.png` → `bar`), and `AppData.icon` is **canonicalized to the resolved override PATH** once one exists — so callers usually hold a *path*, not a name. Any override lookup (`getIconOverridePath`/`removeIconOverride`) must normalize through `iconOverlayKey` (idempotent on keys), or Restore/badge/delete silently no-op on path-valued icons (bit App Icons for Antigravity, fixed 2026-07-04). After `set/removeIconOverride` (which call `reload()` **synchronously**) re-read fresh state via `getAppData(id)` — the caller's own `AppData` is a stale snapshot whose `.icon` may point at a just-deleted overlay file. **A theme change is a TWO-STEP, and the order is load-bearing** (fixed 2026-08-18): GTK announces it via `GtkIconTheme::changed`, `AppService` re-resolves the whole registry on a 2 s debounce (the delay exists to avoid a GListStore conflict during start-up) and only THEN `emit()`s — so a surface that caches ART must rebuild on that emit, never on the raw signal, or it re-reads the pre-change registry. The dock is the surface that caches: every `DockItem` rasterizes its icon into a 128 px `GdkPixbuf` once and paints that, so nothing repaints by itself. It used to invalidate on `Theme.iconTheme` — OUR appearance.json value — which cannot see either case that matters, because in both of them it does not move: on a virgin account it already reads "Papirus" while GTK is still on the schema default, and a theme changed from outside (gsettings, another DE's control panel) never passes through it at all. It compares the live `Gtk.IconTheme.get_theme_name()` now. The same ordering decides the FIRST frame, one layer down: GTK resolves icons through the value the settings portal serves from **gsettings** (`settings.ini` loses to it), while `ThemeManager` only pushes appearance.json's `iconTheme` about two seconds into the session — so on a clean install everything drawn before that kept the schema default until the shell was restarted. The theme therefore has to be right BEFORE the first frame, and since 2026-08-30 that is a **system dconf default**, not a per-user write: the package ships `/etc/dconf/db/local.d/00-nidara-appearance` (generated at build time from `defaults/appearance.json`, so there is one source of truth) plus `/etc/dconf/profile/user`, and a pacman hook runs `dconf update`. ⚠️ **Both halves are load-bearing and each is invisible to the other's failure** — dconf's built-in profile is `user-db:user` and nothing else, so with the profile file missing the compiled database is simply never consulted (measured: virgin account reads `Adwaita`; put the file back, `Papirus`). `user-db` first is also what makes this a DEFAULT: a person who picked Adwaita keeps it. ⚠️ **What this replaced, because the lesson generalizes:** `nidara-setup` used to `gsettings set` the user's own dconf before first login, and on the installer's path — `arch-chroot`, an account that has never logged in, no `/run/user/$uid` — dconf could not commit. **`gsettings set` exits 0 while failing and reports it only on stderr, which the script discarded**, so it printed "seeded before first login" and wrote nothing, for months. A check whose command cannot fail is not a check. `nidara-setup` now VERIFIES instead of writing, and tests both halves separately for the same reason. Instrument: `scripts/dev/icon-theme-probe.js`. |
| `TrashService.ts` | ~125 | Watches the trash (gvfs `trash:///` + `trash::item-count`, aggregates all volumes; falls back to a FileMonitor on `~/.local/share/Trash/files`). Exposes `isEmpty`/`itemCount` + `subscribe`. Drives the dock trash icon (full ↔ empty, swapped in place by DockItem). |
| `ThemeManager.ts` | ~800 | Appearance from its two homes (`org.gnome.desktop.interface` + `org.nidara.appearance`, followed live through `changed::`) — what ANY process needs to look like the desktop: the state, setters that only WRITE keys, and this process's own CSS providers (main/font/tokens), `Gtk.Settings` theme + prefer-dark, font sync, `style.css` hot-reload in dev (recompile the SCSS and the running shell reloads it — no Super+Shift+R; ⚠️ the `Gio.FileMonitor` lives on the instance: as a local it was collected at the first GC and the reload silently stopped working, `scripts/dev/style-hot-reload-probe.ts`). ⚠️ **No file write, subprocess or compositor call belongs here** (#571): a second process would do it a second time — those live in `AppearanceSync.ts`. **Font gotcha:** the interface font is delegated to the GNOME `font-name` gsetting, and that value is a PANGO font string — parse it with `Pango.FontDescription.from_string`, never a regex (a `/^(.*?) (\d+)$/` silently resolved style words, fractional sizes and variation axes to `sans-serif`; a dev machine rendered Noto Sans for months, found 2026-08-11). Sizes are POINTS (`fontToPoints`, see design-system.md) so GTK applies `text-scaling-factor` itself. |
| `AppearanceSync.ts` | ~260 | **Shell-only** (#571): what an appearance change does to the rest of the desktop, once, whoever wrote the key — `settings.ini` (GTK3), the Xcursor default + `hyprctl setcursor` (then emits Theme's `cursor-applied`), the groupbar accent via `hs.evalLua` (a groupbar **bakes its colors at group creation** — only later groups change), the greeter's `appearance.json` mirror; and at start the first-boot font seeds (`Inter 11`, `JetBrains Mono 11` — only when `get_user_value` is null), the px→pt migration and the text-scale clamp. Effects run on the next idle turn, reading `Theme.snapshot()`, because GTK promises no order between Theme's handler and this one. Proof: `scripts/dev/appearance-sync-probe.sh` (two processes; `CONTROL=1` must show duplicates, `SOLO=1` is today's one-process shape). |

⛔ **It does NOT restart `xdg-desktop-portal-gtk`, and must not start again.** That ran on every
mode change until 2026-09-20, because the GTK3 file chooser that backend serves reads the dark flag
once at process start. Measured: killing the backend while a `FileChooser.OpenFile` is in flight
makes the dialog vanish and hands the client `Message recipient disconnected from message bus
without replying` — whatever the person was typing is gone, and the same goes for a `Secret`, a
screenshot or a consent prompt. No desktop does this (GNOME's backend is GTK4 and reacts live,
KDE's is Qt6). The chooser's staleness is left unsolved on purpose: one dialog against a restart
that can eat somebody's work. The reasoning sits in the file where the function used to be.
| `NidaraTheme.ts` | 436 | Token engine: `generateTokensCss()` emits `@define-color` + `--nidara-*` for accent, transparency, materials, shadows, tint. Holds the canonical `ACCENT_PALETTE`. Syncs Kvantum/qt. |
| `RegionConfig.ts` | ~200 | Clock format (GSettings `org.nidara.region`, mirrored to `/var/tmp/nidara/region.json` for the greeter). The timezone is READ from the system and set with timedatectl; the regional format is `~/.config/environment.d/nidara-locale.conf` — neither is stored, each already had a home. |
| `configFile.ts` | ~340 | `defineSettings(name, DEFAULTS, validators?, {computed?})` — every plain Nidara preference, stored in GSettings `org.nidara.<name>` (#573): per-key validation on every read, equality guard, per-key subscription, drift report against the installed schema. `loadKnown` survives for the stores still on JSON by hand. See "Where a setting lives" below. |
| `InputConfig.ts` | ~110 | Keyboard/mouse/touchpad: the Input page's cache of the compositor's EFFECTIVE values and its door to change them, through `settings` (CompositorState). Where each option lives, how it applies and the file it is kept in are the backend's: one `INPUT` table in `hyprland-settings.ts` (re-sync, live apply and `nidara-settings.lua` all derive from it — it used to be three hand-maintained lists), one in `hyalo-settings.ts` (paths in Hyalo's config). |
| `hyprland-settings.ts` / `hyalo-settings.ts` | ~260 / ~150 | **The two sides of `CompositorSettings`** (#682): input, displays, workspace modes, reduce motion, the glass's blur, the groupbar accent, the effective layout for `dumpState`. Hyprland: live `hl.config`/`hl.monitor` evals + the `nidara-*.lua` files `hyprland.lua` requires + the baselines (state-and-ipc.md). Hyalo: `settings` patches that Hyalo writes into `hyalo-settings.toml` itself, `config` to read back (hyalo.md). `settings.caps` says what Hyalo lacks yet. |
| `CompositorState.ts` + `compositor-types.ts` | ~50 + ~210 | **The ONLY door to the compositor, since #682** — Hyprland and Hyalo alike. `Compositor` is the interface (state: `clients`/`workspaces`/`monitors`/`focusedClient`…; fresh reads: `readWindows`/`readWindow`/`readWorkspaces`/`readGeometry`/`layerTop`/`isLayerAbove`/`cursorPosition`; every window-manager verb; `applyWorkspaceModes`; `screenshot`), `caps` says what one compositor has and the other does not (`groups`, `layouts`, `glow`) so a surface ASKS before it offers, and the default export is the backend for this session (`HYALO_SOCKET` in the environment → Hyalo). The shapes are the ones the shell was written against (bare hex addresses, `fullscreen` as a mode number), so no surface changed what it reads. The named export `settings` (`CompositorSettings`) is the same door for what Settings chooses for the compositor (row below). `scripts/ci/compositor-boundary-check.mjs` (with a control) fails any file outside the compositor modules that imports a backend, its settings side or spawns `hyprctl` — no allowlist since #682 emptied it. |
| `HyaloState.ts` | ~400 | **Hyalo's backend** of `CompositorState`, over its IPC (`hyalo-ipc.ts`): the state comes whole in Hyalo's `windows_changed`/`workspaces_changed`/`focus_changed`/`outputs_changed` events (nothing to re-read, no focus to reconcile — Hyalo's answer is the truth), titles on their own event, commands sent as `{"request":"do","command":…}` in the language of Hyalo's key bindings (`hyalo/compositor/src/wm/actions.rs`). A window's address is Hyalo's numeric id in bare hex. `restoreFocusAfterGrab` is a no-op: Hyalo hands the keyboard back itself. |
| `HyprlandState.ts` | ~290 | **Hyprland's backend** of `CompositorState` (clients/workspaces/monitors + dispatch helpers) **and the ONLY door to hyprctl**. `focusedClient` is a **reconciled** accessor, not a proxy — it enforces one invariant, *the focused window is always on the focused workspace*. It was built against two opposite EXCLUSIVE-era lies (the null Hyprland announced when a layer surface released an EXCLUSIVE grab, and the stale non-null it kept returning while one was HELD, which left the app grid's workspace strip naming the workspace you had just left) — **both causes are gone with the focus-grab migration, and the accessor stays anyway, because it is now the INPUT to the root fix rather than a patch over it**: the remembered window is who `restoreFocusAfterGrab` hands the keyboard back TO, and validating the live answer is that repair's correctness guard (focusing a window on another workspace DRAGS THAT WORKSPACE over the user). Audited 2026-08-07; don't simplify it back. Fallback chain and the scratchpad exception in `state-and-ipc.md`; read it, never `hl.focused_client` — services/widgets never shell out to hyprctl directly; they call (or add) a method here. Vocabulary: dispatch helpers (`focusWindow`/`closeWindow`/`floatWindow`/`togglePseudo`/`togglePin`/`toggleFullscreen`/`centerWindow`/`sendToWorkspace`/`toggleGroup`/…, all `hl.dsp.*` Lua via a private `_dispatch` that logs the offending call), `readWindow(addr)` (one-shot raw `clients -j` read for fields the cached client lacks: `pinned`, `grouped` — on demand only, never in `_refresh`), `evalLua(call)` (live config changes — the Lua parser rejects `keyword`), `getOptionInt(name)` / `getOptionBool(name, fallback)` (sync) and `getOptionIntAsync` / `getOptionBoolAsync` / `getOptionFloatAsync` / `getOptionStrAsync` (async batch re-syncs) — one reader per option TYPE, because a `getoption -j` payload carries only its own type's field and naming the wrong one is a silent `undefined` (#338); raw `getOptionJson(name)` stays for anything they don't cover, `setCursor(theme, size)`, `setRealCursorVisible(visible)` (`cursor:invisible`; rendering only, input unaffected — sole caller is the agent-pointer overlay, which hides the real pointer for the length of an AI action because the hardware cursor plane paints above every layer surface; **whoever hides it owns restoring it on every exit path**), `setGlow(enabled)` + `supportsGlow()` (`decoration:glow`, driven only by `AgentGlow.ts`), `version()`. **`focusWorkspaceFromShell(id)` is the single door for a workspace switch driven by one of OUR surfaces** (the app grid's strip, the island's overview) — it forwards to `focusWorkspace` today, and exists so those two cannot drift apart; its predecessor `focusWorkspaceOnGrabRelease` is DELETED, along with the EXCLUSIVE-era grab-lending it did (`tech-debt.md` §53). `restoreFocusAfterGrab()` is the one that still does real work: after our machinery lets go of a focus grab, the compositor refocuses by POINTER, so a dismissal with the cursor over the wallpaper leaves the session with no active window — it hands the keyboard back, guarded to fire only when nothing is focused and only on the workspace being looked at. Caches **effective** config AstalHyprland doesn't expose (`availableModesByName` — `Monitor.available_modes` is always null) and emits `config-reloaded` on Hyprland's `configreloaded` IPC event (effective-config consumers re-sync on it). Exempt from the single-door rule: config text *written for other daemons* (the hypridle config generated by Power.tsx — those lines execute outside the shell; the before/after-sleep hooks themselves are static scripts in `bin/`). |
| `NightLightManager.ts` | ~90 | Night light's store (GSettings `org.nidara.night-light`) — setters only write. `isInSchedule` is a pure export. |
| `NightLightSync.ts` | ~90 | **Shell-only** (#571): owns hyprsunset (enable/disable, restart 300 ms after a temperature settles) and the schedule timer, the one automatic writer of `enabled`. Reacts to the keys, so `gsettings set` from a terminal works — it did not before. Proof: `scripts/dev/night-light-sync-probe.sh` (fake hyprsunset, PIDs checked). |
| `WallpaperManager.ts` | 170 | Wallpaper + transitions via `awww` (`wallpaper`). Reads/merge-writes the JSON through `ui/lib/wallpaper.ts` (shared with the lockscreen, which paints its own copy — the schema reserves a per-surface `surfaces` block; see tech-debt "Wallpaper resolution is centralized"). Two-way synchronized with GNOME's `org.gnome.desktop.background` (`picture-uri` / `picture-uri-dark`) for seamless compatibility with Nautilus, Loupe, and GNOME apps, plus desktop portal integration via `nidara-ipc setWallpaper`. |
| `MonitorConfig.ts` | ~95 | Per-monitor mode/scale/rotation + VRR, through `settings` (CompositorState): on Hyprland `hl.monitor({...})` evals and `nidara-monitor.lua` (see the Lua-parser note below), on Hyalo `set_output` and its settings layer. `applyMode`/`applyTransform` apply without persisting; `commit()` persists — used for the revert-safety dialog on resolution/rotation changes. |
| `Icons.ts` | 92 | `nd-*-symbolic` icon catalog. |
| `WidgetConfig.ts` | ~100 | Which widgets show in the bar / CC (GSettings `org.nidara.widgets placement`, id → (bar, cc), merged OVER the registry's first-run placement). |
| `BarOrder.ts` | ~140 | The ORDER of the bar's right group — widgets, tray icons and search as one list (`org.nidara.widgets bar-order`, plus `bar-hidden` and `tray-known`) — and its rules (`resolveOrder`: empty = derived; what the list does not name goes to the LEFT end). A leaf: the bar and Settings → Top bar both call it, which is what keeps the page showing the bar's own order. design-system.md → "The right group's order". |
| `GamingManager.ts` | ~55 | Game-mode preferences (GSettings `org.nidara.gaming`): wallpaper, power profile, silencing notifications. Read by `GameSession.ts`. |
| `GameSession.ts` + `game-session-logic.ts` | ~160 + ~170 | SHELL-ONLY: game mode around a game, on both compositors (#682) — the artwork or an image as the wallpaper, the performance profile, notifications held back, the way back. The logic file is pure (no GTK, no compositor) so the CI probe drives it; `GameSession.ts` is the world it acts on. Started from `app.ts`. See "Game mode". |
| `DevLogWatch.ts` | ~120 | SHELL-ONLY, DEVELOPMENT MODE ONLY (`.dev` marker present AND stderr is a regular file, i.e. nidara-ui is writing `nidara-ui.log`): a CRITICAL in the shell's own log becomes ONE critical notification per run (never expires, cuts through DND), replaced in place when a new KIND appears — never one per line. Monitors the file, scans only appended bytes, and asks the checkout's `bin/nidara-doctor --log` for the grouping (one implementation of "which kinds"). Its own failures are `console.warn`, never `console.error` — an error there is a CRITICAL in the file it watches and would wake it forever. It also hooks GLib's log handler for the toolkit domains (Gtk/Gdk/Gsk/GLib/GLib-GObject/GLib-GIO/Pango) so every CRITICAL is followed by `[DevLogWatch] <message> ← <JS frame>` plus the stack — a toolkit CRITICAL names only the C function that refused; "no JS on the stack" means GTK raised it from its own event/frame processing. GLib's own line is written unchanged first. The handler never throws (an exception inside a log handler is reported as recursion). Started from `app.ts` right after the notification client. |
| `NotifConfig.ts` | ~90 | Popup auto-dismiss timeout **and Do Not Disturb** (GSettings `org.nidara.notifications`). DnD moved here on 2026-08-18 with `core/notifd.ts`: it was never daemon behaviour — AstalNotifd's own docs say the property "does not have any effect on its own; it is merely a value shared between the daemon process and proxies", and it sat in GSettings so several Astal processes could read one bit. What consults the flag is the shell BANNER layer, which is UI policy. 🔑 Listeners are told WHICH key moved (`onChange(key => …)`): DnD has four faces watching it and the timeout slider one, so an untyped callback made every face repaint on the other's change. `setDoNotDisturb` is guarded on equality — the Settings switch and the CC tile both write on every interaction. What must NOT come back is a SECOND copy of the flag (the retired `dndDefault` was one). |
| `RecordingConfig.ts` | ~250 | Screen-recording preferences (GSettings `org.nidara.recording`) **and the wf-recorder command they build** — `buildCaptureCommand({region, audio})` returns `{argv, outFile, audioDevice}` so the widget owns only screen-or-region and audio-on-or-off. Everything here was measured against wf-recorder 0.6.0, not assumed, because each one silently produces a plausible file instead of an error: **(1)** `--audio` with no device records the default PulseAudio **source** — a microphone, never the desktop — which is why `audioSource` exists and defaults to the `@system` sentinel (resolved at capture time to `<default sink>.monitor`). This was the "recording has no sound" bug: on a machine whose default source was a webcam's unconnected S/PDIF port, "include audio" meant "record silence". **(2)** The long option's argument is *optional* (getopt), so it only binds as `--audio=NAME`; `["--audio", name]` as two argv entries drops the device and falls back to the default source. **(3)** An unknown device name does **not** fail — pipewire-pulse substitutes the default source — so `resolveAudioDevice()` verifies a saved name is still on the bus before using it. **(4)** VAAPI encodes H.264 fine, but `vp9_vaapi` returns "Function not implemented" on Navi 10, so hardware encoding is offered for the H.264 containers only (`CODECS` table; webm is always software VP9). Quality presets are spelled out per encoder (x264/VP9 take `crf`, VAAPI takes `qp` — same polarity, different scales), and libvpx-vp9 needs `b=0` alongside `crf` or it ignores the crf entirely. Surfaced in Settings via `surfaces/settings/pages/ScreenRecording.tsx`, and to agents as `recording.*` in `config-entries.ts`. |
| `app-search.ts` | 268 | **How a typed query becomes a ranked list of apps** — pure functions, no GObject, called only by `AppService`. Replaced AstalApps' `fuzzy_query` on 2026-08-17. A query is scored against four fields (name, desktop id, executable BASENAME, keywords) and the app's score is the **best** field, not the sum, so three weak matches cannot beat one strong one. Five tiers — exact, prefix, word prefix, substring, acronym — and a sixth rescue tier for a query with a word too many ("GTK Widget Factory" for a .desktop called "Widget Factory"). Tiers never overlap: the length tie-break is <1 point. **Three rules that exist because a live run broke without them**, all measured 2026-08-17: (a) the executable is the BASENAME — AstalApps matched the whole `Exec=` line, and every Chrome web app's `--profile-directory=Default` spells f-i-r-e, so typing "fire" in the launcher returned five PWAs and nothing else; (b) the substring and acronym tiers need ≥2 characters — one character is a substring of almost everything (AstalApps returned 56 of 56 apps for "f", because its single-char branch dropped an app only at score exactly 0 and a total miss scores −30); (c) the field weights (name 1, id 0.85, exec 0.78, kw 0.65) are chosen so the 4×5 table has no collisions and two specific orderings hold — an id PREFIX cannot beat a name WORD_PREFIX (every PWA's id begins "chrome-", so at 0.9 the query "chrom" put Google Chrome SIXTH behind its own web apps), and a PARTIAL keyword cannot beat a match inside a name (Micro declares keyword "terminal" and was jumping XTerm). Matching is accent-folded, and `fold()` is deliberately 1:1 per character so word-start indices stay valid. Probe: `scripts/dev/apps-probe.ts`. |
| `bluez.ts` | ~410 | **The shell's ONLY door to BlueZ**, and the layer under `BluetoothService`. Replaced AstalBluetooth on 2026-08-18: that was 681 Vala lines over `Gio.DBusObjectManagerClient` on `org.bluez`, and there is no library beneath it — same shape as MPRIS. One `GetManagedObjects` seed plus `InterfacesAdded`/`InterfacesRemoved`, a `Gio.DBusProxy` per adapter and per device (so property caching and `g-properties-changed` come free), and a name watcher so a bluetoothd restart empties and refills the roster instead of leaving dead proxies. Devices stay **GObjects with real properties** because consumers listen per object (`watchDevices` wires `notify::paired/connected/name` on each). Same snake_case-accessor rule as `mpris.ts` — declare the PAIR or the ParamSpec gets auto-generated storage and reads stale forever. **Three traps this file paid for, all found by RUNNING it, and all of them the same mistake in different clothes — a property whose setter has a side effect:** (1) `_sync` assigned `this.trusted = …` from `PropertiesChanged`, and that setter WRITES to BlueZ, so every notification echoed back onto the bus and the throw aborted the seed loop — the shell saw one adapter and zero devices. Reading from the bus needs its own internal path (`_setTrusted`), and `_add` now try/catches per object so one bad device cannot cost the roster. (2) `Gio.DBusProxy.call()` takes a METHOD name and speaks the proxy's own interface, so writing a property through it fails with "Expected an object of type GVariant for argument 'parameters'" — properties go through the CONNECTION (`setProp`), naming object, interface and method. (3) Seeding only from the name watcher looks right and is not: `appeared` arrives through the main loop, so anything reading `devices()` in the same tick as `get_default()` got an empty roster. Seed synchronously, guarded by `NameHasOwner` — that guard is also what stops a machine with no radio logging a CRITICAL at every boot. Probe: `scripts/dev/bluez-probe.ts`. |
| `notifd.ts` | ~250 | **Client of the Rust session daemon**, `session/daemon` → `nidara-sessiond` (#819). `app.ts` starts it explicitly with `startNotifClient()`, independently of the bell widget. Plain `Notification` objects and the facade API stay unchanged. `NotifService.ts` and the surfaces are consumers only. See "The session notification daemon" below. |
| `mpris.ts` | ~410 | **The shell's ONLY door to MPRIS**, and the layer under `MediaService`: one `NameOwnerChanged` subscription (server-filtered with `MATCH_ARG0_NAMESPACE`) for the roster, two `Gio.DBusProxy` per player (root interface for `Identity`/`DesktopEntry`, Player interface for the rest). Players are **GObjects with real properties** because the media consumers do listen per object (`connect("notify")`, `notify::playback-status`) — the accessors are declared in snake_case (`playback_status`, `can_go_next`) since that is what the call sites use AND what GJS binds to the ParamSpec; a getter without its setter fails at registration, and a ParamSpec with no accessor of ours gets an auto-generated one backed by separate storage that reads stale forever. **`position` is deliberately NOT a GObject property**: the MPRIS spec excludes `Position` from `PropertiesChanged` and tells clients to extrapolate at `Rate`, so it is a plain accessor computed from an anchor (re-anchored on status/track change, `Seeked`, our own seeks, and a lazy async resync at most every 10 s, only when somebody reads it). AstalMpris polled it at 1 Hz instead — that is where every "notify storm" guard in the media widgets came from. Seeking prefers `SetPosition` and falls back to a relative `Seek` when the track has no `mpris:trackid` (where `SetPosition` is a spec no-op). Probe: `scripts/dev/mpris-probe.ts`. |
| `tray.ts` | ~470 | **The shell's OWN StatusNotifierItem watcher AND host** — it owns `org.kde.StatusNotifierWatcher`, so every app that puts an icon in the bar registers here. Replaced AstalTray on 2026-08-18, the LAST Astal service: another D-Bus spec with no library beneath it, same shape as `mpris.ts`/`bluez.ts`/`notifd.ts`. Items are **plain objects, not GObjects** (`onChanged`/`onIconChanged` return unsubscribe functions) — there is one consumer, and AstalTray's churny items are exactly where `notify::` closures on a soon-to-be-freed GObject fed a `g_param_spec_unref` UAF that segfaulted the UI minutes later. A plain object has no ParamSpecs to over-unref. **Four deliberate departures from AstalTray, each one a bug it had:** (1) **`ItemIsMenu` defaults to FALSE**, per spec — AstalTray defaulted it true, turning left-click into a menu open for every app that omits the property, which is most of them. (2) **Items are keyed by bus name AND object path.** AstalTray's watcher kept one entry per bus name, so an app publishing two icons from one connection had the second overwrite the first and one icon stayed in the bar, dead, until the shell restarted. (3) **Signals invalidate only what they name** (`SIGNAL_PROPS`) — AstalTray answered every signal with a full `GetAll`, and its `update_gicon` re-walked `IconThemePath` RECURSIVELY, uncached, up to seven times per refresh, on the main loop. The walk is cached here and consulted only when the icon changed. (4) **It also claims `org.kde.StatusNotifierHost-<pid>` and calls `RegisterStatusNotifierHost`** — libappindicator checks for that owner before publishing, and AstalTray never claimed one (it forced `IsStatusNotifierHostRegistered` true instead, which only works while IT is the watcher; that hack is kept, for the apps that never re-register). Pixmaps are ARGB32 in network byte order and are rotated to RGBA before `GdkPixbuf`. Falls back to FOLLOWING a foreign watcher (plasmashell, a stray astal-tray) rather than going empty. Probe: `scripts/dev/tray-probe.ts`. |
| `dbusmenu.ts` | ~210 | **`com.canonical.dbusmenu` → a live `Gio.Menu` + `Gio.SimpleActionGroup`**, the client half of tray context menus. It replaced `appmenu-glib-translator` — a hand-pinned GitLab dependency that existed for `libastal-tray` alone — on 2026-08-18. 🔑 **Why ~210 lines replace ~2100 of C:** the translator keeps a GMenuModel in sync item-by-item (one model object per submenu, `GetLayout` at recursionDepth=1 per level, section diffing, `items-changed` at the right index). Nidara's ONE consumer, `common/NidaraMenu.ts`, FLATTENS the whole model into a `Gtk.Box` on every render — so all of that machinery was being paid for and thrown away. Here it is one `GetLayout(0, -1, …)` for the entire tree, rebuilt into the SAME `Gio.Menu` (`remove_all()` + re-append emits `items-changed` for free, which is the signal the bar already listens to). That also deletes the code that was crashing: the translator's `layout_parse`/`get_layout_idle` is what the coredump showed behind a ~140 TB `g_malloc`, and there is no incremental parser here to corrupt. Two more fixes fall out: `visible: false` rows are DROPPED (the translator drew them — verified on screen), and `Event` is sent ASYNC (`dbus_menu_xml_call_event_sync` ran on the main loop at the default 25 s timeout, so one wedged tray app froze the shell). ⚠️ Parity gap kept on purpose: `toggle-state` becomes stateful actions but nothing draws a checkmark, because NidaraMenu reads labels/actions/links only — that was already true with the translator. |
| `MediaService.ts` | ~235 | **Facade with selection state** over `core/mpris.ts` (it re-exports `PlaybackStatus`, so a surface never imports the D-Bus layer): owns WHICH MPRIS player the shell shows (widgets must never call `get_players()[0]`). Auto heuristic — a PLAYING player beats paused ones, ties go to the most recent playback-status change; manual pin `pinPlayer(busName\|null)` (session-scoped, auto-resumes when the pinned player leaves the bus); `subscribe(cb)` fires on selection change AND async cover-art arrival; `playerLabel`/`playerAppIcon` (desktop-entry GIcon for the selector menu); `resolveCoverArt` — art chain `file://` → a bare path → `data:` decode → `http(s)` curl into `~/.cache/nidara/media-art/` (pruned past ~150 files, failures negative-cached so a dead URL isn't retried at the 1 Hz position poll). Consumed by `widgets/media.ts` (the shared detail panel incl. the source-selector glass menu — exported as `buildMediaDetailPanel`, also the content of the island's player mode. **No bar variant since 2026-08-02**: the island already carries the player as an activity the moment an MPRIS player is live, so a bar pill with its own transport buttons stated the same service twice, one capsule apart — `locations: ["cc"]`, `buildBarContent`/`buildBarExpanded` deleted. A widget losing its bar variant leaves a `"bar": true` behind in every existing `widgets.json`, which is why `WidgetConfig.barWidgetIds()` now intersects with `BAR_ORDER` instead of appending unknown ids: a stale flag used to consume one of the bar's limited icon slots before the render loop skipped it for having no `buildBarContent`), `widgets/media.ts`'s CC tile (ONE shared `MediaState` singleton across tile rebuilds; it was `surfaces/control-center/MediaIsland.tsx` until 2026-09-01) and `surfaces/island/` (`PlayerCompact` + the `ActivityIsland` activity controller; note `subscribe()` fires on SELECTION change, not on a playback-status flip of the same player — anyone tracking play/pause must also connect `notify::playback-status` on the current player, as all three consumers do). Test with `scripts/dev/fake-mpris.js` (dev-workflow.md). Never imports Gtk. |
| `hypr-ipc.ts` | ~230 | **The shell's ONLY door to Hyprland's sockets**, and the lowest layer in `core/`: `.socket.sock` takes a command and answers JSON, `.socket2.sock` streams `EVENT>>DATA`. No caching and no derived state — `HyprlandState` owns all of that and is the only module that may import this one. Exposes `getClients`/`getWorkspaces`/`getMonitors`/`getActiveClientAddress` plus `subscribeEvents`, and the `HyprClient`/`HyprWorkspace`/`HyprMonitor` types the whole shell annotates against. **Reads are SYNC on purpose**: the four a refresh needs cost 1.1 ms over the socket (a `hyprctl` spawn each is an order of magnitude worse), which is what lets `_refresh` stay synchronous — every consumer reads `hs.clients` straight after "changed". 🔑 **Addresses come out BARE, no `0x`**, because that is what AstalHyprland handed out and the dispatchers build `address:0x${a}` from it — a prefixed one yields `address:0x0x…`, which Hyprland answers by doing nothing. Never imports Gtk. |
| `BatteryService.ts` | ~95 | **The shell's ONLY door to UPower**, on `UPowerGlib` directly (the typelib ships with `upower`, already a dependency). Holds `present`/`fraction`/`charging`/`charged`/`timeToFull`/`timeToEmpty` over UPower's composite DisplayDevice, plus `watch` (any change) and `watchPresence` (`notify::is-present` only — the widget registry's hardware gate, narrow because it re-evaluates availability). **Two conversions you must not lose**: UPower's percentage is 0..100 and every consumer wants the 0..1 FRACTION; and Astal's `charging` was true at FULLY_CHARGED too, a conflation that hid a real bug (see dev-workflow.md). Consumed by `common/BatteryGlyph.ts`, `widgets/battery.ts` and the island's battery activity — none of which may import `gi://UPowerGlib` themselves. Never imports Gtk. |
| `NotifService.ts` | ~95 | **Stateless facade** over TWO layers, and the split is the point: `core/notifd.ts` is the SERVER (receive, persist, expire) and `core/NotifConfig.ts` holds Do Not Disturb, because DnD suppresses BANNERS — the notification still arrives and still lands in the NC. `notifications()` (a SNAPSHOT — the clear-all cascade holds its list while rows fly out), `getNotification(id)`, `isCritical(n)`, the DnD trio (`dontDisturb`/`setDontDisturb`/`toggleDontDisturb`) and `watchDnd`/`watchNotified`/`watchResolved`. Added 2026-08-18; notifications were the last domain with NO facade at all — **sixteen** bare `AstalNotifd.get_default()` calls across the NC, the popups, the bar's bell, the focus tile, Settings → Notifications and `config-entries.ts`, each re-deriving the same three questions. 🔑 `watchDnd` is narrow (one key); the focus tile used to listen on bare `notify` — EVERY property of the daemon — to watch one boolean. Never imports Gtk. |
| `AudioService.ts` | ~145 | **Stateless facade** over `core/wireplumber.ts` (PipeWire/WirePlumber; ours since 2026-08-18, it replaced AstalWp). `volumeIcon`/`targetVolumeIcon` (the volume-level icon ladder that used to live in FOUR copies), `streamIconName` (per-app stream icon), `setDefault` (`wpctl set-default`), `toggleMute`, endpoint/stream/default accessors, and `watchDevices`/`watchStreams`/`watchVolume`/**`watchDefaultSpeaker`**. Consumed by Settings → Audio + the CC volume tile/detail (`widgets/volume.ts`, `widgets/volume.ts`) + the bar volume widget. 🔑 **A widget that draws the CURRENT default output subscribes with `watchDefaultSpeaker`, never with `watchVolume(defaultSpeaker(), …)`** — the latter resolves the endpoint once, and four widgets wrote it by hand with three of them broken by it (see tech-debt, "CC widget capture"). Returns Gio icons via `core/Icons` (core→core); the volume *slider widget* is `makeVolumeSlider` in `nidara-kit/slider.ts` (UI layer). Never imports Gtk. |
| `BluetoothService.ts` | ~330 | **Stateless facade** over the reactive singleton in `core/bluez.ts` (same pattern as NetworkService): power (`isPowered`/`setPowered`/`togglePower`), device categorisation (`pairedDevices`/`nearbyDevices`/`deviceName`), guarded command wrappers (`connectDevice`/`disconnectDevice`/`pairDevice`/`removeDevice`/`startDiscovery`/`stopDiscovery`), and `watchPower`/`watchDevices` notify helpers. `watchDevices` also wires each device's own `notify::paired/connected/name` (re-wiring on set change) — `notify::devices` alone misses in-place pairing/connection changes. Also owns the **BlueZ pairing agent** (`org.bluez.Agent1`, capability `KeyboardDisplay`, raw Gio D-Bus on the SYSTEM bus — no Bluetooth library offers agent support, which is why this half was ours long before the read half was): `registerPairingAgent(handler)`/`unregisterPairingAgent()`; the Settings → Bluetooth page supplies the dialog handler (`PairingPrompt` kinds: `confirm`/`display`/`enter-passkey`/`enter-pin`/`authorize`), so core stays UI-free. The agent registers when the page is built, for the Settings application's lifetime; closing Settings releases its bus connection and cancels its pending pairing dialogs. `pairDevice` sets `trusted=true` on successful pairing so reconnections skip authorization; `RequestAuthorization`/`AuthorizeService` auto-accept trusted/paired devices. **Testing gotcha:** D-Bus policy only lets root call `Agent1` methods, so exercise dialogs with `sudo busctl --system call <shell-unique-bus-name> /org/nidara/bluetooth/agent org.bluez.Agent1 RequestConfirmation ou /org/bluez/hci0/dev_00_11_22_33_44_55 123456` (find the bus name by matching the gjs PID in `busctl --system list`; the python-dbusmock bluez5 template never calls back into agents). Consumed by Settings → Bluetooth (full management: scan/pair/forget) + the bar/CC bt tile, whose
CC detail panel (`widgets/bluetooth.ts`, split-target capsule — see design-system.md) drives a
compact paired-device connect/disconnect list with the same `pairedDevices`/`connectDevice`/
`disconnectDevice`. **Gotcha:** `setPowered` drives `adapter.powered`, NOT the read-only `is_powered`. Never imports Gtk. |
| `NetworkService.ts` | ~1240 | **The shell's ONLY door to NetworkManager**, and since 2026-08-17 it owns the read half directly on `libnm` (`gi://NM`) rather than through AstalNetwork — see tech-debt #71 for why the wrapper had to go (it resolved its devices once, in `construct`, so a hot-plugged adapter was invisible session-wide). Still a plain function module, not a GObject. It holds: the command vocabulary — joining/leaving/forgetting a Wi-Fi network on **libnm** since 2026-09-14 (`connectAp`/`disconnectWifi`/`forgetNetwork`/`savedWifiSsids`/`apLinkState`; saved profiles matched by SSID BYTES, never by profile name; `connectAp` passes NO password — NM asks `core/NetworkAgent.ts` for it; an enterprise AP (`needsSetupDialog`) or a hidden network gets libnma's form first and is joined with the connection it returns) and still `nmcli` for `rescan`/`setWifiEnabled`/`toggleWifi`/VPN, the NM-flag + frequency derivations (`isSecured`/`securityLabel`/`freqBand`/`freqChannel`), `apSsid` (an SSID arrives as `GLib.Bytes`, so it goes through NM's decoder — the one place NM is rawer than the old wrapper), `getIp`/`wiredConnected`/`wifiEnabled`/`available`, the `wifi()`/`wired()` handles (live getter views over the current NM device, null when absent), and the watchers. **Hardware presence is a subscription here, not a build-time fact**: `watchDevices` re-resolves on NM's `device-added`/`device-removed` and fires only when the SELECTION changed (NM emits device-added for every tun/bridge/veth — a VPN or Docker would otherwise re-arm the whole shell). Every other watcher — `watchWifi` (SSID+IP+speed+state), `watchWifiEnabled` (radio flag only, the bar-icon one), `watchWifiNetwork` (flag+SSID, no bitrate churn), `watchAccessPoints`, `watchWired` — re-arms itself across a hot-plug, so callers subscribe once. **Pick the narrowest watcher that covers what you redraw**; the old blunt `notify` cost the bar a full re-blur per frame during a scan. **The Ethernet switch** (`wiredEnabled`/`setWiredEnabled`/`wiredState`/`wiredStateText`, owner 2026-09-28: a switch as GNOME's Wired toggle) persists across a reboot, unlike GNOME's `nm_device_disconnect`, whose block lives in /run: off clears `autoconnect` on each profile that had it and MARKS it in NM's `user` setting (`org.nidara.wired-off`), on restores exactly the marked ones, so a profile the user set not to autoconnect stays that way. **IP and DNS of a profile** — the cable's and every saved Wi-Fi network's, macOS's TCP/IP + DNS tabs — go through an `IpTarget` (the profile, and the device it is live on): `ipForm` (what is saved), `ipLive` (what DHCP handed out), `applyIp`, `renewDhcp`. Every write clones the profile, `verify()`s the clone and sends it with `update2(TO_DISK)`, then NM's Reapply when the profile is up (no drop; re-activation only if Reapply refuses). A remote profile carries no secrets and NM keeps the stored ones on such an update — measured on a WPA-PSK profile. The form is `surfaces/settings/pages/network-ip.ts`. ⚠️ **Three GJS traps in libnm, all measured 2026-09-28:** `nm_device_filter_connections` is marshalled wrongly — it answers twice, then throws `Unhandled GType (null)` and leaves the client's profile objects finalized under JS (ask `connection_compatible` per profile instead); `nm_client_dbus_set_property` is NOT promisified — without its callback it throws; and **`NMDevice.get_path()` is NOT the D-Bus path** — NMDevice shadows NMObject's with the udev ID_PATH (`pci-0000:2a:00.0`), so a D-Bus call built on it makes GLib assert and its callback never runs (the Ethernet switch hung that way): use `NM.Object.prototype.get_path.call(dev)`. Consumed by Settings → Network, the CC wifi/ethernet tiles (`widgets/wifi.ts + widgets/ethernet.ts`) and the bar widgets (`widgets/wifi.ts`, `widgets/ethernet.ts`) — none of which may import `gi://NM` themselves. Never imports Gtk. |
| `NetworkAgent.ts` | ~300 | **NetworkManager's secret agent** — the process NM asks for a Wi-Fi secret, over the system bus, when a connection needs one: first join, a refused key (flag REQUEST_NEW), a router whose password changed during autoconnect — and the keeper of "this user only" (AGENT_OWNED) secrets in the keyring, with gnome-shell's libsecret schema attribute for attribute so either desktop finds the other's. D-Bus + libsecret only; the dialogs are **libnma's** (`libnma-gtk4`, the library GNOME Settings uses), driven from `common/WifiSecretsAgent.ts` (the agent's prompts, shell-only, started from app.ts) and `common/WifiSecretsDialog.ts` (joining a network — Settings and the CC; takes a `beforePresent` hook instead of importing Status, #571) — personal, enterprise/802.1X, WEP, hidden networks ("Other network…"). Decided 2026-09-14: one set of upstream forms rather than ours for the common case; their LOOK is an open follow-up. ⚠️ **Never go back to `nmcli … password X`**: argv is readable by every local user, and nmcli cannot be re-asked, which is how a wrong password failed silently and left a key-less "saved" profile. ⚠️ **Raw D-Bus, not `NM.SecretAgentOld`** — GJS refuses that class's vfuncs ("accepts another callback as a parameter"). ⚠️ `GetSecrets` is callable by ANY process on the system bus (the path is fixed by NM), so it answers only NM's current UNIQUE name. ⚠️ **NM gives up on a `GetSecrets` after 120 s and does NOT send `CancelGetSecrets`** — the agent withdraws the request itself at that point, or one unanswered dialog blocks every later join (dev-workflow.md → Testing Wi-Fi). ⚠️ **libnma from GJS has three traps, the third crashes the SHELL** — read the header of `WifiSecretsDialog.ts` before calling anything on `NMA.WifiDialog`: `new_for_secrets` hints (string vs strv → SIGSEGV), non-nullable constructor args, and `get_connection()` returning its `device`/`ap` out-params BORROWED while the GIR says transfer full, so GJS over-unrefs the shell's own `NM.DeviceWifi` and libnm later dies on a finalized object (VM: 2 shell crashes in 6 rounds without the compensation, 0 in 18 with it). A cancelled dialog ends NM's activation with reason DEVICE_DISCONNECTED, not NO_SECRETS — `takeUserCancel(uuid)` (`core/NetworkCancels.ts`, a leaf so Settings does not import the agent) is how `connectAp` tells a cancel from a failure — The joining Settings process consumes the cancellation from the shell over D-Bus (`consumeUserCancel`, #571). |
| `PowerManager.ts` | 43 | hypridle hooks (screen-off/lock/suspend). |
| `SystemInfo.ts` | ~150 | **The ONE reader of "what is this computer"** — hostname, os-release `PRETTY_NAME`, CPU model, installed RAM, GPU, kernel, uptime, GTK/GJS versions, windowing system. Added 2026-08-25 with tech-debt #94: the About WINDOW and Settings → About each had their own copy of the same regexes over /proc and /etc, and the same machine reported **31 GB** in one and **31.3 GB** in the other. ⚠️ **A surface asks, it never reads — and FORMATTING lives here too**, because the duplication that produced 31 vs 31.3 was in the formatting, not in the file access. Unknown is the empty string, never a human word (a reader returning "Unknown" puts untranslated English on a translated page); the surfaces render `settings.about.unavailable`. Machine values are humanised at the source: lspci's 89-character device line → "AMD Radeon RX 5700 XT" (ask Intel BEFORE AMD and anchor with `\b` — an unanchored `/ati/` matches inside "Corpor**ati**on"), RAM ceilinged to the whole GiB so the desktop reports INSTALLED memory rather than what the kernel kept. `uptime()` is ours and synchronous (/proc/uptime + `Intl`), because `uptime -p` speaks the process's locale, not the desktop's. Never imports Gtk except for its version. |
| `ShellActions.ts` | 21 | Typed action registry populated by `app.ts main()`; consumed by Dock/Bar/AppGrid (replaces `globalThis`). |
| `AppearanceHooks.ts` | ~50 | SHELL-ONLY: fires the `accent-changed` / `dark-mode-changed` user hooks from the gsettings change itself, once per real change, whoever wrote it. Started from `app.ts`. See user-hooks.md. |
| `AgentConfig.ts` | ~120 | Governance of the agent-facing surface (GSettings `org.nidara.ai`): `allowConfigWrite` gates `setConfig` writes; `allowScreenshot` gates the `screenshot` IPC; `allowComputerUse` gates third-party perception (`query_app`/`nidara-a11y`); `allowComputerControl` gates third-party action — AT-SPI `do_action` (`do_app_action`/`nidara-act`), synthetic keyboard (`type_text`/`press_key`/`nidara-type`, focus-verified), synthetic pointer — left/right click + hover + scroll + drag (`click_app`/`click_at`/`hover_app`/`hover_at`/`scroll_app`/`scroll_at`/`drag_app`/`drag_at`/`nidara-click`+`nidara-input`) — and window focus (`focus_window`/`focusWindow`) — and **requires perception** (enabling it implies `allowComputerUse`). The two computer-use gates **default OFF** (they reach outside the shell; enabling either flips on `toolkit-accessibility`, otherwise the a11y tree is empty). Separate toggles — each capability is sensitive on its own. Toggled from Settings → AI. It is a **consent layer over the official door, not a security boundary** (any local process can still edit config files / drive the a11y bus directly) — keep that framing in docs/UI copy. Reading the shell's *own* state is never gated (doctor/diagnostics depend on it). Also holds the **built-in Assistant's brain config** (`brainBackend`/`brainModel`/`brainEndpoint` in `ai.json`) — NOT a gate, just which BYOK LLM `bin/nidara-agent` talks to; the API **key is never in `ai.json`** (DE keyring, see below). |
| `AgentService.ts` | ~180 | Facade over `bin/nidara-agent` (the Assistant's brain). Owns the daemon subprocess (spawned LAZILY on first `send`, resolved PATH-first then the dev checkout's `bin/` via `SHELL_ROOT`; respawned on death), parses its JSON-lines events into a `transcript` (`{role,text,tools[]}`) + `busy`/`state`/`usage`/`lastError`; API `send`/`cancel`/`reset` + `subscribe`. Drives visibility only through `Status` (expand-on-finish: opens `ISLAND_AGENT` when a background turn ends on an otherwise-idle desktop). Consumed by `surfaces/island/AgentIsland.tsx` (the chat UI) and the `agent` island activity. Never imports Gtk. See `state-and-ipc.md`. |
| `AgentGlow.ts` | ~70 | The "the Assistant is working in THIS window" signal — the one piece of agent feedback painted outside our own pixels, because the thing it points at is a third-party window. Subscribes to `AgentService` and flips **only** `decoration:glow:enabled` (`hs.setGlow`) while `busy`; the look (range, violet→cyan gradient, and the **transparent `color_inactive` that limits the glow to the FOCUSED window** — the glow has no window rule, and `color_inactive` defaults to `color`, so leaving it out makes every window glow) is static in `hyprland.lua`. Deduped, because `AgentService` notifies on every streamed token. Gated by `ai.assistantGlow` (Settings → AI) and by `hs.supportsGlow()` (Hyprland ≥ 0.56 — `getoption` answers an unknown option with the bare string `no such option`, so the JSON parse failing IS the probe; and when it *does* answer, a **gradient comes back as `AARRGGBB`, not `RRGGBBAA`** — read a colour back in the order you write it and the alpha lands in the red channel). Forces the glow **off** at boot: a shell that died mid-turn left it on in the live config and nothing else would ever clear it. Re-asserts on `config-reloaded` (a reload re-reads `enabled = false` and would silently drop the signal mid-turn). **No focus guard on purpose** — every daemon tool acts on the focused window and refuses otherwise, so whatever is focused IS what the next action touches. **The sweep is not configured here and cannot be:** the `glowangle` animation is armed **at window creation**, so it lives permanently enabled in `hyprland.lua` (measured free while the glow is off; arming it live leaves already-open windows unable to ever sweep). Never `style = "loop"` — see the `hyprland.lua` comment. |
| `ConfigRegistry.ts` | ~120 | Typed registry of agent-readable/-writable settings — the data half of `describeConfig`/`getConfig`/`setConfig` (see `state-and-ipc.md`). Same pattern as ShellActions: core defines the registry; **entries are registered from `config-entries.ts`** (app level, NOT core) because dock settings live in `surfaces/dock/state.ts` and core must never import widget code. Each entry is self-describing (desc/type/enum/min/max) and delegates `set` to the owning service, so validation/persistence/notify behave exactly as if Settings had been used. NB: result types use optional fields, not discriminated unions — tsconfig has `strict:false`, under which tsc doesn't narrow `r.ok ? r.value : r.error`. |
| `UITree.ts` | ~160 | Serializer behind the `queryUI` IPC command (see `state-and-ipc.md`): walks every **mapped** toplevel and returns a flat list of on-screen widgets carrying signal (test-id / CSS class / visible text / interactive GType) + ancestor `path` + `bounds`, for read-only UI **assertions** (screenshot → programmatic check). Redacts password/masked entry text. Read-only/ungated like dumpState. Tier 1 = structure+text; the node model is source-agnostic — `bin/nidara-a11y` now fills the **same shape** for third-party apps via AT-SPI2 (the computer-use layer's `query_app`; see `state-and-ipc.md`). |

### The rule for stored settings: a store must be able to FORGET

The obvious load for a settings JSON, `{ ...DEFAULTS, ...data }`, was **a one-way ratchet**: a key
RETIRED from `DEFAULTS` stayed in the user's file, the spread carried it into the live object, and the
next save wrote it out again. `region.json` still carried `weekStartsMonday` months after that setting
was reverted (`4212a3e5`). That is worse than clutter, because the same mechanism resurrects MEANING:
a retired key that later comes back with new semantics reads a value the user never chose in the new
sense. **Stored values are user state; their SHAPE belongs to the code.** A GSettings schema enforces
that by construction — a key it does not declare cannot be read or written — and the migrations drop
retired fields on the way in. (`loadKnown`, the JSON-era guard, was deleted with its last caller.)

**The form for a preference is `defineSettings(name, DEFAULTS, validators?)`**, which owns the whole
lifecycle and not just the load step: storage, validation, an equality guard so an unchanged value
touches neither storage nor a listener, and **per-key subscription with a disposer**. A module on it
declares its shape and its behaviour and nothing else. Its JSON predecessor `defineConfig` had the
same interface (`GamingManager` went from 66 lines to 32 on it) and was deleted on 2026-09-14 once
its last two users moved: `NotifConfig`, `barState`, `NightLightManager`, `RecordingConfig`,
`WorkspaceModes`, the dock's `state.ts`, `AgentConfig` and `GamingManager` are all on
`defineSettings` now. What is left off it is off it on purpose, or not moved yet (see the exceptions
below, and #573).

### Where a setting lives: GSettings, `org.nidara.*` (#573)

**Every Nidara setting is moving to GSettings** — schema in `config/gsettings/org.nidara.gschema.xml`,
store `defineSettings(name, DEFAULTS, validators?, {computed?})` in `core/configFile.ts`, SAME
interface as the JSON store it replaced, so a module moves by changing one line. It is phase 0 of splitting the
desktop into shell / applications / session daemons (#571 makes Settings its own process, #574 moves
the agents and the notification server out): a JSON file that one process holds in memory and
rewrites wholesale cannot have a second writer, and dconf notifies every process that reads a key.
The owner chose GSettings over "JSON + a file watcher" on 2026-09-14 — #534 had already put the
accent and the mode there, and a watcher would have been a second model to leave later.

Field names are camelCase in TypeScript and kebab-case in the schema (`iconSize` ↔ `icon-size`).
`gsettings list-recursively org.nidara` is how a person or an agent reads them now.

What was MEASURED before the store was written, because each one decides a line of it:

| fact (GJS, 2026-09-14) | consequence in `defineSettings` |
|---|---|
| `changed` is emitted SYNCHRONOUSLY inside `set_value` in the writing process | `set` updates `state` BEFORE writing, so the echo finds nothing to do and a subscriber runs once |
| writing a value equal to the stored one emits no `changed` anywhere | nothing to deduplicate across processes |
| **`delay()` is PERMANENT** — `apply()` commits and leaves the object in delay mode | `update()` batches on a SECOND `Gio.Settings` kept delayed; on the store's own object it silently lost every write after the first batch (the probe caught it) |
| another process hears a change ≈12 ms later | fine for live preview from a Settings process |
| a missing schema: `new Gio.Settings({schema_id})` THROWS; **`Gio.Settings.new(id)` ABORTS** | the store looks the schema up first and falls back to an in-memory store — the desktop starts |
| `gsettings set` with no session bus exits 0 while writing nothing (#295, reproduced) | the migration pings dconf's writer and checks every value with `dconf read` |

🔑 **The TS `DEFAULTS` and the schema defaults must agree, and CI makes them.** `defineSettings`
compares them at construction (and the key's type), records any disagreement in
`settingsSchemaProblems()` and logs `[defineSettings] …`; the headless smoke FAILS on that log line
(step 7b), so drift cannot merge. A default only known at run time (recording's `hardware` and
`saveDir`) goes in `computed`: its schema default is a placeholder, and while the user has never set
the key the store answers with the TypeScript value. `gsettings reset` brings it back.

⚠️ **A subscriber runs in EVERY process that built the store.** Updating a widget from it is right.
A side effect that must happen once for the desktop — writing a Lua file Hyprland reads, restarting
a daemon, pushing to the compositor, firing a user hook — must only be wired in the shell, in a
`core/*Sync.ts` module started from `app.ts` that reacts to the keys: `NightLightSync`,
`AppearanceSync`, `RegionSync` (plus `AppearanceHooks` for user hooks, and `GameSession`, which acts
on game mode's keys when a game runs). The store's setters only
write. The closure check forbids Settings from importing any of them. **Not split, on purpose:**
`WallpaperManager.setWallpaper` and `MonitorConfig` are ACTIONS. In the Settings application,
wallpaper writes and display changes are requests to the shell; only the shell starts the
`picture-uri` listener and applies the wallpaper. Re-picking the same path still applies it.
The shell owns each temporary display change and its rollback — see "Settings is its own application".
`WorkspaceModes` is no longer reached from Settings at all.

🔑 **What a Settings process would import is checked, not remembered** (#571). A process runs the top
level of every module it imports, and on 2026-09-14 `surfaces/settings/Settings.tsx` alone reached
192 of the shell's 216 modules — almost all through ONE edge: `custom/bar.ts` imported a constant
from `Bar.tsx`, and with it came the bar, the Control Centre, the island, Prism and the notification
server (the launcher-mark catalogue now lives in `bar/barState.ts`). `scripts/ci/settings-closure-check.mjs`
walks the imports transitively and fails on any other surface's module, any `widgets/` module, or a
module that makes a process THE shell (`Status`, `ShellActions`, `notifd`/`NotifService`, `tray`,
`NetworkAgent`, `AgentService`). **Settings reaches none of them since #571's first PR** (the count grows with Settings pages; 135 on 2026-10-14);
`settings-closure-allowlist.txt` is empty, and a line added to it may only SHRINK away again — a listed module no longer reached fails too. `--print` gives the shortest import chain
to each: cut its first edge, delete the line. A value Settings needs from a surface goes in that
surface's store (`barState.ts`, `dock/state.ts` — both exempt), never imported from the window.

**Settings → Widgets reads the widgets as DATA** (`core/WidgetCatalog.ts`). It used to import
`widgets/index` and `CCLayoutManager` — every widget's implementation and every service they start.
It now calls `widgetCatalog().list()` (id, name, icon, category, hardware present, placement, "fits in
the CC") and `setBar`/`setCc`; the shell registers the answer once in `app.ts`
(`setWidgetCatalog(widgetCatalogSource)`, the same module-scope seam as `setKitAppearance`), and a
Settings process will get the same interface over `org.nidara.Shell`. `WidgetCatalog.ts` must stay a
leaf; `WidgetCatalogSource.ts` is shell-only. Configure builders live on Settings' side,
in `surfaces/settings/widgetSettings.ts`, keyed by widget id; `pages/ScreenRecording.tsx`
reads `RecordingConfig` without importing the capture widget. Both Widgets and Top bar
resolve the same builder, and an unknown id has no Configure button. No GTK builder
travels through the catalogue; the icon is still a `Gio.FileIcon` that a future wire
adapter serializes with `Gio.Icon.to_string()` and reconstructs with `Gio.Icon.new_for_string()`.
See `writing-a-widget.md`. `scripts/dev/widgets-page-probe.sh` proves the catalogue equals the page's old
computation field for field, round-trips both switches, and screenshots the page in a nested
Hyprland (every `hyprctl` lands on the nested instance; HOME/XDG/mirror dirs are scratch).

### Widget catalogue over IPC (#571, 2026-10-14)

`nidara-ipc widgetCatalog [list | bar <id> <true|false> | cc <id> <true|false> |
mode <id> <always|active> | editBarOrder]` uses the existing `Request(as) → s`
door and `ShellActions.widgetCatalog`. `WidgetCatalogWire.ts` owns the version-1
snapshot and validation. The shell refuses unknown ids, malformed arguments,
unsupported locations/modes, enabling absent hardware, removing fixed CC widgets
and adding to a full grid before writing. It returns the full resulting catalogue
and verifies the requested placement; a refusal follows Request's `error:` convention.
Icons cross as strings, never GI objects. This is the local Settings control plane,
like GSettings, not the Assistant's permission boundary; agent configuration writes
continue through the gated `setConfig` door: `widgetCatalog` is hidden from the
built-in Assistant's action resolver, and MCP's `run_action` requires
`allow-config-write` for its mutating verbs (reads remain available). The agent-loop
suite checks both routes with throwaway settings and an IPC stub.

`startWidgetCatalogNotifications` watches placement, grid and availability for the
shell lifetime and emits `WidgetCatalogChanged` on the existing interface/path.
An idle coalesces the placement flag and grid-cell update, so clients read settled
state. Hardware watches have the registry's existing session-lifetime contract.

The Settings entry point calls `createRemoteWidgetCatalog()`, awaits `ready`,
then registers it with `setWidgetCatalog`. `list()` reads a cache; all reads and writes
on D-Bus are async, ordered and bounded to three seconds. Await mutations and handle
rejections in the UI; `lastError` also exposes refusals. `watch()` returns a disposer
for `bindWhileRealized`; `dispose()` releases the owner watch, signal subscription and
pending calls. Bind page controls to changes without writing them back or rebuilding
an active control mid-interaction. Widgets and Top bar bind their controls for each realized
lifetime; placement changes update controls in place, topology changes rebuild the list.
The shell retains its local source for its own configuration API.

Owner loss clears the cache and marks it disconnected. Reconnection fetches fresh
state. Each queued call captures a unique D-Bus owner and generation: a write queued
for a dead shell cannot land on its replacement. Failed writes are never retried;
a caller must read the fresh state before deciding what to do. A malformed snapshot
keeps the last validated cache and records an error.

`scripts/dev/widget-catalog-ipc-probe.sh` runs the real transport between fixture
processes on a private bus, with no GTK, dconf or live shell. It covers icon round-trip,
mutations, refusals, invalidation, malformed replies, restart without replay, queued
writes and disposal. `CONTROL=1` removes the actual fixed-widget refusal from the
bundled temporary copy and must fail at that assertion. Both runs are in `widgets-gen`.

### Settings is its own application (#571, 2026-10-14)

The fifth bundle is `ui/settings/app.ts`, launched by `bin/nidara-settings`. The launcher
sets `NIDARA_SETTINGS_PROCESS=1` BEFORE GJS evaluates imports, pins GTK to Wayland and
supplies the shell asset root plus the application's own CSS root. A bare invocation
without the role is unsupported: shared services would run their shell paint path.
`spawn()` strips this role from children, as it strips `GTK_THEME`; the launcher of
another Nidara application owns its own role. The installed desktop entry executes the
launcher. PKGBUILD, install.sh and both smoke harnesses build the fifth executable.

The application is `org.nidara.Settings` (D-Bus); its window remains `nidara-settings`
with title `Nidara Settings` (desktop identity). It exports `Request(as) → s` at
`/org/nidara/Settings` for open, page/app navigation and queryUI. The shell's
`SettingsAppClient` starts it on demand, under `uwsm app` when a user manager is present
so a nidara.service restart does not kill it. Concurrent opens share a launch. Calls
address the UNIQUE owner; only UnknownMethod during registration is retried, never a
timeout or applied action. `openSettings`/`toggleSettings`, `settingsPage`, `settingsApp`
keep their existing names and replies. `queryUI` merges the application's redacted tree
with the shell's without starting a closed Settings instance. The kit host now runs main
once, with an optional activate callback for later invocations. Settings exits on close,
releasing its memory; its single window and cached pages last only for that process.

`ThemeManager` remains a preference reader/writer, but in this role installs NO CSS
providers, font provider, style watcher or Gtk mode override. `initAppearance()` paints
through the Settings portal and registers the kit's own appearance source. Its setters
write shared GSettings; AppearanceSync, RegionSync, NightLightSync and user hooks still
run only in the shell. Delayed appearance persistence is flushed immediately in the
application so closing it cannot discard the last choice. WorkspaceModes does not
persist/reapply the workspace table at Settings startup. The configuration registry
uses NotifConfig directly, never the notification server. The closure check starts at
the fifth application's entry point, not just the Settings window factory.

Wallpaper actions travel through `settingsWallpaper`; a file monitor updates Settings'
preview from the shell's saved state. The application installs no background-key
listener and fires no wallpaper hook. A strict failed apply returns an error and
restores the previous saved preference. This preserves re-picking the same image.
Network joins read the shell secret agent's cancellation outcome through
`takeNetworkCancel`, consuming it once — no second empty process-local map.

`settingsMonitor` applies monitor changes in the shell. Mode/rotation previews are
leased to the calling connection, with a 15-second deadline (the confirmation dialog
counts 12). Another client cannot confirm a lease. Client death, cancel or deadline
restores the prior mode; commit persists only confirmed state. Other outputs' pending
modes are excluded from saves. A private atomic runtime journal records the previous
configuration BEFORE applying the preview, and the shell restores interrupted previews
from it on startup. The journal is not user configuration and is removed on successful
confirmation/revert. Scale/VRR writes respect outstanding previews. The application
awaits the apply before showing its confirmation and reports failures on its page.
Hyalo's monitor apply/VRR and save paths propagate compositor refusals (including
unreachable IPC) instead of logging them and returning apparent success. Disconnected
outputs need no runtime rollback; their persisted baseline was never changed.
These Settings control-plane commands are hidden from the built-in Assistant; MCP
mutations still require allow-config-write.

Validation: `settings-process-check.sh` is called by both private compositor smoke
sessions. It verifies distinct PIDs, single-instance navigation and queryUI, a Settings
crash leaving the same shell alive, and reopening with the remote catalogue. The D-Bus
fixture walk covers invalidation/reconnection without replay plus network cancellation;
`display-lease-probe.ts` checks preview/commit, foreign-client refusal, timeout and death.
The sandboxed-shell harness pins GDK_BACKEND=wayland (Hyalo also exports Xwayland's
DISPLAY) and places greeter mirrors under its scratch HOME, so an appearance walk
cannot write the real login screen's mirror.

**Moving a store** is three parts in one change: its schema (defaults, and `<range>`/`<choices>`
where the validator has them, so `gsettings set` refuses what the store would), the one-line switch,
and its file in `migrations/2026-09-14-settings-to-gsettings.sh`'s list — or a new unit of the same
shape. The unit imports each field once, drops retired fields and values the schema refuses, does
NOT import values equal to the default (the old store saved every field, so a file is mostly
defaults the user never chose) — including a `computed` default, which the unit's
`computed_default` recomputes with the store's own expression, so a store that gains or changes a
computed field must change it there too — and renames the file to `<name>.migrated`. What stays a FILE on
purpose: `greeter-prefs.json` and the `/var/tmp/nidara/` mirrors (read by the greeter, another user,
outside the session), `app-frequency.json` and other state that is written often, and every OUTPUT
another program reads (`nidara-*.lua`, `hypridle.conf`, `settings.ini`).

`update(patch)` is the form for a setting with an INVARIANT: `allowComputerControl` implies
`allowComputerUse`, `allowFileWrite` implies `allowFileRead`, and picking a brain provider derives
three more fields. Each lands as one write and one notification pass, so no reader — including
`bin/nidara-agent`, which re-reads `org.nidara.ai` every turn from another process — can catch the
settings with half the invariant applied. (It batches on a dedicated delayed `Gio.Settings`, so the
keys reach dconf in one change set.)

🔑 **A migrated module still owns its notification contract.** `NightLightManager` keeps its
`changed` GObject signal because a consumer re-reads two fields at once, but it now emits it from
ONE `subscribeAll` on the store instead of from each setter — so the signal fires per real change
rather than per call. `GamingManager` dropped its signal entirely: after the migration its only
subscriber was `config-entries.ts` re-reading all four fields whenever any one moved.

⚠️ **The third argument, `validators`, runs on every READ — at start and on every change another
process makes — and never on `set`, and that line is deliberate.** The schema's type already refuses
a value of the wrong kind; the validator catches the other half — right type, wrong shape — which is the case every module used to hand-code (night-light's
`/^\d{2}:\d{2}$/` on its schedule times; recording's `format`, a plain string that survives the
typeof check and then indexes `CODECS` to `undefined`). Stored values are user state we do not control, so
an unusable value falls back to its default and the desktop starts. A bad value passed to `set`
comes from OUR code, and swallowing it there would hide the bug instead of the call site fixing it.

🔑 **Renaming or retiring a key means writing a MIGRATION, not a compatibility read.**
`migrations/<YYYY-MM-DD>-<slug>.sh` — a bash fragment sourced by `bin/nidara-migrate`, which runs
each unit once per machine and records it under
`${XDG_STATE_HOME:-~/.local/state}/nidara/migrations/<name>`. Units get a `json_edit <file> <jq>`
helper that writes atomically and only when something actually changed. Because the machine now
carries a record of what it has taken, **the old name is DELETED from the reader in the same
commit** instead of being read forever — which is what the `transparency` → `windowOpacity`
conversion in `ThemeManager` used to be. A legacy name that is still read is a name that can still
WIN, quietly overruling a value the user can see in Settings with one they cannot.

⚠️ **`nidara-setup` is NOT the load-bearing trigger, despite being the obvious one.**
`nidara.install` only PRINTS on `post_install`/`post_upgrade`, so a plain `sudo pacman -Syu` — the
upgrade path the README documents — never runs setup at all. The trigger that always fires is
`ExecStartPre=/usr/bin/nidara-migrate` on `nidara.service`: the session user, every session start,
and **before the shell has read any config**, which is the only ordering in which a migration
cannot race the process it is migrating for. `nidara-setup` calls it too; the marker makes the
second call free. The runner ALWAYS exits 0 — a broken migration must cost a log line, never the
user's session — and a failure stops the CHAIN so a later unit never runs against a state its
predecessor failed to produce.

🔑 **Leave a stamp alone unless you mean to skip what it gates.** The `transparency` unit writes
the raw `1 - t` and deliberately does not touch `glassModel`, because a file predating the glass
rescale still has to be rescaled by the reader — stamping the model in the migration would silently
skip a conversion the old code performed. The bench caught exactly that, and only on a mid-range
value: the clamp (`clampGlass`, gone with the glass sliders in #674) hid the error at both ends of the range.

`scripts/ci/migrations-check.mjs` (a step in the `pkgbuild` job) holds the properties that make a
unit survivable: valid bash, a no-op on a fresh install, and idempotent **with the marker deleted
between runs** — the marker is what makes it run once in production, the unit being idempotent
underneath is what makes a lost marker survivable, and only one of those is a property of the code.

⚠️ **An object-valued key must be REPLACED, never mutated in place.** The store decides whether
anything moved before it writes, and for objects it compares by value (`JSON.stringify`). Handing
`set`/`update` back the same reference it already holds therefore reads as "unchanged" and persists
NOTHING. `AgentConfig`'s per-provider maps (`brainModels`, `brainEndpoints`) are the case in the
tree: they build `{ ...current, [provider]: value }` rather than assigning into the stored object.

⚠️ **A file migration writes the DECLARED SHAPE, not a byte copy.** The dock's settings file moved
out of the bare `~/.config/` root, and copying it across carries retired keys to the new path, where
they sit until the user happens to change a dock setting — the one-way ratchet again, just relocated.
Game mode's settings have ONE reader since #682, the shell (`core/GameSession.ts`). Until then
`readGamingCfg()` in `hyprland.lua` read them inside the compositor when a game opened, first by
pattern-matching `gaming.json`'s raw text and then from a `NIDARA_GAMING` table the shell generated —
a second reader that could not read GSettings, and a contract `hypr-lua-check.mjs` had to run end to
end. The session moved to the shell and the table went with it.

⚠️ **`WidgetConfig`'s merge must stay a spread**: its keys ARE the data (widget ids), so the registry's
`DEFAULT_PLACEMENT` SEEDS them rather than enumerating the valid ones — the stored `placement` map is
merged over it, and a key filter there would drop every widget the shipped defaults don't happen to
name, third-party ones included. **The test is whether `DEFAULTS` enumerates the valid keys or merely
seeds them.** The CC layout (`org.nidara.control-center`) is keyed by widget id the same way.
`app-frequency.json` stays a FILE for a different reason — a hot cache rather than a preference,
written on every app launch, which dconf is not for.

⚠️ **Maps of tuples need spelling on the way into dconf.** `a{s(bb)}` and `a{s(ii)}` are written from
TypeScript as `{ id: [a, b] }` (GJS packs a JS array into a tuple), but GVariant TEXT reads `[a, b]`
as an ARRAY, so `gsettings set … "{'x': [true, false]}"` is refused. `settings_import`
(bin/nidara-migrate) spells them `(…)`; its CI case failed before it did.

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
  "About Nidara" title; the `windowrulev2` keyword calls were removed). ⚠️ **The title match is
  not a leftover from About borrowing Settings' app-id** — About has its own (`nidara-about`,
  2026-08-31) and the rule still cannot use it. `float`/`center` are STATIC effects, matched once
  at open against `initialClass`, and every window this process opens is born `org.nidara.desktop`;
  the birth title is the only thing that tells About from Settings at that instant. Enforced by
  `scripts/ci/hypr-rule-check.mjs`; see `dev-workflow.md` → "A window rule matches an IDENTIFIER,
  and a static rule only ever sees the one the window was BORN with".
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

## The appearance contract — how ANY process learns what the user picked (2026-09-13, #534)

🔑 **ONE Settings backend for READS, since 2026-09-20 — and the routing itself used to break the
contract.** `config/portal/hyprland-portals.conf` said `org.freedesktop.impl.portal.Settings=nidara;gtk`.
The gtk backend was in that list for a reason: it served `org.gnome.desktop.interface` — `gtk-theme`,
`icon-theme`, `font-name` — which we did not. But it ALSO serves `org.freedesktop.appearance`, and
so do we, so **every appearance change put two identical `SettingChanged` on the bus** (measured
with `gdbus monitor`). That is exactly the "a client that can read one value two ways will read two
different values" the contract is written against — broken by our own routing rather than by an
application.

⚠️ **Naming us alone did NOT fix the duplicate, and this file said it did for a day.** Measured
live on 2026-09-21, one mode change, each bus name listened to separately: our backend emits 2
(one per namespace, as the code says), **the gtk backend still emits 2 although `portals.conf`
does not name it**, and the frontend relays all 4. A backend is loaded from its `.portal` file,
not from `portals.conf`: xdg-desktop-portal 1.22.1 **aggregates Settings across every backend
whose `.portal` declares the interface** and relays all of their signals, while `portals.conf`
only orders them for CALLS. `gtk.portal` declares it and ships in a foreign package, so silencing
it means shadowing that file and re-breaking on every gtk update. Left alone deliberately: both
backends read the same gsettings and answer the same value, so the duplicate is redundancy, not
conflict. **What `Settings=nidara` buys is precedence for reads, which is what Rule 1 needs.**

`bin/nidara-portal` now serves all three namespaces: `org.freedesktop.appearance`,
`org.nidara.appearance` and `org.gnome.desktop.interface`. The GNOME keys are **enumerated from the
schema**, not listed by hand — a key somebody forgets is a setting that silently stops reaching
every GTK3, Qt and Chromium application. `portals.conf` names us alone for Settings; `default` still
falls back to `hyprland;gtk` for everything else (FileChooser, Print, Notification…).
Verified on a private bus (`dbus-run-session` + our daemon): `gtk-theme` → `Adwaita`, `icon-theme` →
`Papirus`, `font-name` → `Inter Variable 11`, `color-scheme` → `uint32 1`, `ReadAll` returns the
three namespaces, and a key that does not exist still answers `NotFound` — the control that proves
the probe can fail.
✅ The `SettingChanged` for the GNOME namespace — the one thing a private bus could not test, since
firing it needs a real dconf write and dconf is user-global — was verified in a live session on
2026-09-21: a mode change puts `('org.gnome.desktop.interface', 'color-scheme', 'prefer-light')` on
the bus alongside the `org.freedesktop.appearance` one.

Nidara is a desktop, so it does what GNOME does, and the rule is the same for our own windows as
for anybody else's app. This section is the reference; the code-side copy is the header of
`ui/lib/nidara-kit/platform/appearance.ts`. **Read it before a new window, app or surface needs the accent, the mode
or an opacity** — every earlier attempt to wire one "just for this window" produced a second
channel, and the second channel is where the bugs lived.

**Rule 1 — every setting has exactly ONE home.** `ThemeManager` (the shell) is the only writer.

| key | home | reaches apps as |
|---|---|---|
| accent | gsettings `org.gnome.desktop.interface accent-color` | `org.freedesktop.appearance accent-color` `(ddd)` |
| dark / light | gsettings `…interface color-scheme` | `org.freedesktop.appearance color-scheme` `u` (0 none · 1 dark · 2 light) |
| high contrast | gsettings `org.gnome.desktop.a11y.interface high-contrast` | `org.freedesktop.appearance contrast` |
| reduced motion | gsettings `…interface enable-animations` (inverted) | `org.freedesktop.appearance reduced-motion` |
| fonts, icon theme, cursor | gsettings `…interface` | `org.gnome.desktop.interface` (served by the gtk backend) |
| reduce transparency / window transparency (#674; the glass material choice is retired, 2026-10-11) | gsettings `org.nidara.appearance` (#573) | `org.nidara.appearance` (same kebab-case names), served ONLY there — the four glass opacities are DERIVED by each reader from the kit's tables, never served |

Every key in this table is read by `ThemeManager` FROM its home and followed through `changed::`, so
`gsettings set … accent-color pink`, `… icon-theme Adwaita` or `org.nidara.appearance
reduce-transparency true` from a terminal or an agent changes the whole desktop live — as in GNOME. There is no
`appearance.json` any more: until #534 (accent, mode) and #536 (icon / cursor / GTK theme) every
start copied that file OVER gsettings, which made the file the real home and silently reverted such
a change at the next login; its Nidara-only keys were imported into `org.nidara.appearance` once
(migrations/2026-09-14c, which also applies the old glass rescale the reader used to run on every
load). A fresh account's GNOME-key values come from the system dconf default generated from
`defaults/appearance.json` (`/etc/dconf/db/local.d/00-nidara-appearance`) — icon, GTK and cursor
theme, accent, colour scheme. The cursor's listener does more than restyle: `setCursorTheme` pushes
it to Hyprland and the Xcursor default too (tech-debt #72). ⚠️ And it refuses a name that is not an installed cursor theme
(`cursorThemeInstalled`): theme names are case-sensitive directory names, and `gsettings set …
cursor-theme qogir` for the installed `Qogir` handed Hyprland a theme it could not load — it drew its
own fallback, the Hyprland logo. The key keeps what was written; the desktop keeps its cursor and the
log says why. The only FILE left is the greeter's
mirror (rule 3), written by the shell from these homes. The accent / dark-mode USER HOOKS fire from
the change itself (`core/AppearanceHooks.ts`, see user-hooks.md). The rest of the portal beyond
appearance — what is served, what has no backend, the GTK3 dialogs — is audited in #535.

**Rule 2 — an application reads the Settings portal, and nothing else.** The installer, the lock
screen, any future Nidara app and every third-party app are the same kind of client. Most of it
comes free, from libraries we do not own:

- **GTK ≥ 4.20 reads `color-scheme`, `contrast` and `reduced-motion` from the portal by itself**
  (`gtk-interface-color-scheme` & co.) and exposes them to CSS as `@media (prefers-color-scheme:
  dark)`, `(prefers-contrast: more)`, `(prefers-reduced-motion: reduce)`. Checked in the 4.22.4
  binary: `org.freedesktop.appearance`, `ReadAll`, `SettingChanged` and the three `prefers-*`
  names are all in `libgtk-4.so`.
- **libadwaita reads the accent** from the same namespace and maps the RGB to its nearest named
  accent — which is exactly what `rgbToClosestAccent` does for us.
- **Our own processes** call `initAppearance()` (`ui/lib/nidara-kit/platform/appearance-css.ts`), which reads BOTH
  namespaces in one `ReadAll`, applies each `SettingChanged` from its payload (no re-read, no
  blocking call per key), coalesces a burst into one restyle per frame, and re-reads in full when
  the portal's name appears (a cold session). Nothing in it is private to Nidara: a third-party
  developer can do exactly the same with any D-Bus binding, and a sandboxed Flatpak can too.

There is **no fallback to another channel**. A portal that does not answer — or answers with no
backend serving the namespaces — gives the shipped defaults and a `[appearance] …` warning, and
`appearanceSource()` says `defaults`. libadwaita falls back to gsettings when unsandboxed; we
deliberately do not, because a quiet second answer is how #533's bugs stayed invisible.

**Rule 3 — the one exception is a surface OUTSIDE any session: the greeter.** It runs as the
`greeter` system user in its own compositor; no portal exists there, and one would answer for the
wrong person. It declares `initAppearance({ channel: "mirror" })` and reads
`/var/tmp/nidara/appearance.json`, an EXPORT the shell writes for it, mode **0644**. The lock screen
is NOT this exception — it runs inside the user's own session, where the portal answers for exactly
the person it is locking.

⚠️ **`writeFile(path, content, mode)` only applies `mode` to a file it CREATES.** Replacing an
existing file keeps the old permissions (measured: a 0600 file rewritten with 0644 stays 0600), so
`writeFile` now `chmod`s explicitly whenever the mode is not the 0600 default. Without that, every
machine that already had a 0600 mirror from 0.11.0 on (#488) would have kept a greeter stuck on blue.

**The shell is the writer, not a client.** It keeps its live `ThemeManager` (per-surface skin
pinning, icon filters, GTK theme) and does not read the portal — like gnome-shell, which owns its
settings rather than asking a portal for them.

### What #533 did, so it is not tried again

It read the portal, then the file, then let **gsettings override both**. In the greeter gsettings
answers with the SCHEMA default (blue, "no preference") — measured with `env -i HOME=<empty> gjs`
against a real green + dark account — so the login screen ignored the user entirely. Everywhere
else one click arrived through three channels (portal signal, gsettings signal, two directory
monitors) as ≥7 full restyles, each starting with a synchronous `ReadAll`. It also subscribed to
`SettingChanged` from ANY sender, served `accent`/`is-dark` under a second name in our namespace,
and made `NidaraWindow` call `initAppearance()` silently — which turned a missing line in an
`app.ts` into a window that looked right by accident. All four are gone; a bundle that forgets
`initAppearance()` gets the kit's loud fallback warning again.

### Adding an appearance key

1. Decide its home FIRST. If the desktop standard (gsettings / the portal spec) already names it,
   that is the home and nothing Nidara-specific is added. Only a key nobody else has goes into
   the `org.nidara.appearance` schema (`config/gsettings/`), and into `NidaraAppearance` in
   `ThemeManager`.
2. `bin/nidara-portal` serves it — in `org.freedesktop.appearance` only if the spec defines it,
   otherwise in `org.nidara.appearance` (add it to `NIDARA_KEYS` there) — and emits
   `SettingChanged` when it moves: gsettings `changed::` in both cases, which fires only for a value
   that actually changed.
3. `applyPortalKey()` in `ui/lib/nidara-kit/platform/appearance.ts` folds it in. That one function serves the first
   read AND every signal, so the two cannot interpret a key differently.
4. Never serve one value under two names.
5. Prove it with `scripts/dev/appearance-contract-probe.sh` (below).

### `scripts/dev/appearance-contract-probe.sh` — the chain, off-screen

Builds a private session bus with its own dconf, the real `xdg-desktop-portal` frontend, THIS
checkout's `bin/nidara-portal` and the real client code, then moves settings underneath it and
prints what an application receives: the first read, a dconf change, a file change whose
`accent`/`isDark` must be ignored, and a two-key burst that must arrive as one state. A control
with the frontend up and no backend of ours must report `defaults`. Measured 2026-09-13: all pass,
and the real `~/.config/dconf/user` is byte-identical before and after.

🔴 **The isolation is the part that bit.** The first version exported `XDG_CONFIG_HOME` inside
`dbus-run-session -- bash -c '…'`. A D-Bus-ACTIVATED service inherits the DAEMON's environment,
not the caller's: `dconf-service` wrote the real database and the maintainer's desktop changed
colour mid-test; the "no backend" control silently activated the INSTALLED `/usr/bin/nidara-portal`.
Hence: variables on the daemon's command line, a dconf canary that must land in the private
database before anything else is written, and the backend started explicitly and checked to be
the owner of its bus name.

### Launching an app: the scope IS the app's identity to the portal (2026-09-13)

Every launch path — dock click and menu, app grid, Prism, `launchApp` — goes through ONE argv,
`AppService.getLaunchArgv(id)` = `sh -c 'cd "$HOME" && exec uwsm app -t service -- <id>.desktop'`. Do
not build a launch command anywhere else (the Super+E / Super+T binds in `hyprland.lua` use the same
`uwsm app -t service -- <id>.desktop`).

🔑 **A SERVICE, not uwsm's default scope (2026-09-27, #654).** "Service" is systemd's word for "a unit
systemd started", not "a daemon": a scope runs the app IN PLACE, so it was the shell's child, got the
shell's environment and handed its stdout/stderr back to the launcher. Measured, all of it:

| | scope (until 2026-09-27) | service |
|---|---|---|
| launch latency (10 runs, request → process runs) | 88 ms | 92 ms |
| environment | the shell's — `GTK_THEME=Empty` (every app unthemed, #653), the shell's own `INVOCATION_ID`/`MEMORY_PRESSURE_WATCH`, `GDK_BACKEND=wayland` | the SESSION's (systemd manager) + uwsm's session-specific vars |
| stdout/stderr | pipes to the shell's `execAsync`, which ACCUMULATES them in the shell's memory until the app exits | the journal |
| parent | `gjs` | `systemd --user` |
| portal app id | from `…-<rand>.scope` | from `app-Hyprland-<id>@<rand>.service`, same id (probe backend, anonymous control `''`) |

uwsm makes it `Type=exec` + `ExitType=cgroup`: the unit lives while ANY process of the app does
(fork-and-exit wrappers are safe) and ends with the app. Checked live: a D-Bus-activatable entry
(Calendar) lands in its own `app-Hyprland-org.gnome.Calendar@….service`; a Flatpak (Clocks) makes
its own `app-flatpak-…scope`, as Flatpak always does; a `Terminal=true` entry opens in the terminal
uwsm's lookup picks (same in both modes).

**That terminal is kitty by default**, through a SYSTEM list the package ships:
`config/xdg-terminal-exec/Hyprland-xdg-terminals.list` → `/usr/share/xdg-terminal-exec/` (PKGBUILD +
install.sh). A user's own `~/.config/xdg-terminals.list` still wins — which is why it is a packaged
default and not something `nidara-setup` writes into every home. Measured against uwsm's own
`find_terminal_entry()` (2026-09-27): with no list at all it picked
`org.gnome.Terminal.Preferences.desktop` — GNOME Terminal's PREFERENCES app — on a machine that had
GNOME Terminal installed. Two traps a probe falls into: the desktop prefix is `XDG_CURRENT_DESKTOP`
verbatim (`Hyprland-…`; a lowercase `hyprland-xdg-terminals.list` is never read), and uwsm SKIPS any
data dir under `$HOME` — so testing with the repo's `config/` on `XDG_DATA_DIRS` silently tests
nothing; copy the file somewhere outside home.

🔑 **Why it matters beyond "the window opens":** the XDG portal does not ask an unsandboxed app who it
is. It reads the systemd unit the process lives in, accepts `app-<launcher>-<id>@<random>.service`
or `app-<launcher>-<id>-<random>.scope`, and only when `<id>.desktop` exists; anything else is the anonymous app
`''`. Per-app portal decisions are keyed by that id — permissions, Background, and GlobalShortcuts,
which refuses an empty id outright. Measured with a probe impl backend on a private bus:

| unit | app_id the backend receives |
|---|---|
| `app-Hyprland-sh-…scope` — what `uwsm app -- sh -c "gtk-launch …"` produced for EVERY app | `''` |
| `app-Hyprland-kitty-…scope` | `kitty` |
| `app-Hyprland-google\x2dchrome-…scope` | `google-chrome` |
| `app-Hyprland-nonexistent.app.Id-…scope` (control, no .desktop) | `''` |
| `dbus-:1.1-org.gnome.Nautilus@….service` — D-Bus activation | `''` |

`uwsm app -- <id>.desktop` names the unit after the entry AND runs `Exec=` itself, ignoring
`DBusActivatable=true` (measured as a scope on 2026-09-13: Text Editor landed in
`app-Hyprland-org.gnome.TextEditor-….scope`; as a service on 2026-09-27: Calendar in `…@….service`).
`gtk-launch` D-Bus-activated those entries (12 on the maintainer's machine, Nautilus included), which
put them in a `dbus-:1.1-…` unit — anonymous again, whatever the outer scope was called. The same
property sidesteps the Flatpak activation trap described on `getLaunchCommand`. The keybinds in
`hyprland.lua` use desktop ids for the same reason (`kitty.desktop`, `org.gnome.Nautilus.desktop`).

⚠️ Apps a user starts some other way (a terminal, `xdg-open`, D-Bus activation by another app) can
still be anonymous; Chrome escapes it by creating its own `app-com.google.Chrome-<pid>.scope`. Check a
running app with `cat /proc/<pid>/cgroup`.
### Consent prompts: the portal asks, the shell draws (2026-09-13, #535)

When an app asks for the camera, the microphone, location… `xdg-desktop-portal` calls
`org.freedesktop.impl.portal.Access` on its backend. Nidara's backend is `bin/nidara-portal`, a GJS
script with NO GTK — so it forwards the prompt to the shell, which draws it:

    app ─portal─▶ xdg-desktop-portal ─impl.Access─▶ bin/nidara-portal ─org.nidara.Shell.Consent─▶ ui/shell/surfaces/consent/ConsentService.ts

Same split as GNOME (xdg-desktop-portal-gnome hands Access to gnome-shell), and for the same reason:
the shell already has the kit, the glass, the twelve catalogs, and — for Settings → Apps — the same
decisions. The prompt is `showNidaraAlert` with options added for this case: `icon` (who is asking,
resolved from the app id), `choices` (check boxes; the spec's `a(ssa(ss)s)` with an empty option
list), `parentWindow` (the portal's `wayland:<handle>`, applied with `nidara-kit/wayland-parent.ts`
→ `set_transient_for_exported`) and `appId`. It declares app-id `nidara-consent` and uses the heading
as its window title.

Rules, all load-bearing:
- **`org.nidara.Shell.Consent` is NOT an IPC command.** `IPC_COMMANDS` are listed by
  `nidara-ipc listActions` and driven by the agent and the MCP server; nothing that can answer a
  consent prompt may be reachable from there. The interface serves exactly one caller — the current
  owner of `org.freedesktop.impl.portal.desktop.nidara`, looked up at call time — and answers anyone
  else `AccessDenied`.
- **Never grants by default** (tech-debt #89): closing the dialog, the app's `Request.Close`, the
  shell missing or failing all answer denied (1 or 2). Only the user pressing Allow answers 0.
- **Remembering is the frontend's job**, not ours: for the interfaces that persist a decision,
  xdg-desktop-portal reads the PermissionStore before calling the backend and writes the answer
  after. Settings → Apps edits that same store.
- **Pack a reply tuple from its children** (`GLib.Variant.new_tuple`): re-packing an existing
  `a{sv}` Variant with `new GLib.Variant("(ua{sv})", …)` throws inside the reply callback, the
  invocation is never answered, and the app hangs until its D-Bus timeout. Found by the probe below.

Two probes, both isolated (private bus with env on the daemon line + dconf canary; nested Hyprland
without the session bus and with `sync_gsettings_theme = false`), both asserting:
- `scripts/dev/consent-portal-probe.sh` — the forwarding, with a fake shell: grant → `(0, {choices})`,
  the app closing the request → `1`, no shell → `2` without hanging. Proven able to fail: with the
  packing bug reintroduced, case (a) fails.
- `scripts/dev/consent-dialog-probe.sh` — the REAL ConsentService drawn in a nested Hyprland: the
  prompt maps centred on the requesting window (xdg-foreign), a foreign caller is refused, Close
  dismisses it; leaves `consent-dialog.png`.

### Sharing the screen: xdpw asks, the shell draws the picker (2026-10-13, #683)

A call that shares the screen asks the portal's ScreenCast. In the Nidara session (Hyalo,
`XDG_CURRENT_DESKTOP=Nidara`) `config/portal/nidara-portals.conf` routes it, and Screenshot, to
`xdg-desktop-portal-wlr` (a dependency of the package), which captures through Hyalo's
`ext-image-copy-capture` (`references/hyalo.md` → "Sharing the screen"). What is shared, the user
picks in NIDARA's picker:

    app ─portal─▶ xdg-desktop-portal ─impl.ScreenCast─▶ xdpw ─chooser─▶ bin/nidara-share-chooser
        ─org.nidara.Shell.ScreenShare─▶ ui/shell/surfaces/screenshare/ScreenShareService.ts

- **xdpw's own chooser contract** (`config/portal/xdpw-nidara.conf`, installed as
  `/etc/xdg/xdg-desktop-portal-wlr/Nidara` — xdpw's per-desktop file, so it applies to this session
  alone): `chooser_type = dmenu`, so xdpw writes one line per source it may share on stdin —
  `Monitor: <connector> <description>`, `Window: <title> (<identifier>)`, only the kinds the app asked
  for — and accepts back only one of those lines; nothing printed = declined. The window identifier
  is Hyalo's, i.e. the shell's ADDRESS for the window, so a tile gets the overview's thumbnail
  (`captureWindow`). The title can hold parentheses: the identifier is the LAST group.
- **The picker** is `showNidaraAlert` with `content` (the tiles), `width` and `cssClasses`
  (`nidara-share-picker`, its rules in `ui/shell/styles/_screenshare.scss`). Tiles are grouped
  `ToggleButton`s, the first screen selected; each picture sits in an `AspectFrame` at the
  capture's own proportions (`WindowThumbnail` paints whatever bounds it is given, so without it
  every window came out stretched to 160×100). A screen's picture is a grim capture taken BEFORE
  the picker is shown, or the picture would contain the picker. The window list scrolls, and the
  selected tile takes the focus: left to GTK, focus went to the LAST tile and scrolled the list to
  its bottom (owner-seen). It declares app-id `nidara-share`; `[rules.share-picker]` in
  `config/hyalo/hyalo.toml` centres it (it has no parent window: the chooser is its own process).
- **Not an IPC command, never shares by default** — the consent prompt's rules. The chooser has no
  bus name of its own to compare, so the caller is checked by its process ANCESTRY: a process up to
  four levels above it must be `xdg-desktop-portal-wlr` (`/proc/<pid>/exe`); anyone else gets
  `AccessDenied` (checked: the chooser run by hand is refused). Closing or Cancel answer -1 and the
  portal returns 1 (cancelled by the user).
- **Verified live, 2026-10-13**, xdpw 0.8.4 run from its package against the owner's session with
  the repo's chooser: Share → a PipeWire stream of DP-1; Cancel → SelectSources answers 1.

**Settings → Apps edits those decisions** through `ui/shell/core/PermissionStore.ts` (a D-Bus client of
`org.freedesktop.impl.portal.PermissionStore`, no UI): three states as the store has them — no entry =
*Ask*, `["yes"]` = *Allow*, `["no"]` = *Deny* — and *Ask* DELETES the entry rather than storing a third
value. The rows follow the store's `Changed` signal, so answering a prompt with Settings open moves them
(the store also emits for a delete that removed nothing; a row applies that as a no-op). Which
permissions exist is MEASURED, not recalled — requests made from inside the Flatpak `org.gnome.clocks`
against a private store (xdg-desktop-portal 1.22.1): `Camera.AccessCamera` → `devices/camera`;
`Wallpaper.SetWallpaperURI` without preview → `wallpaper/wallpaper`; `Background.RequestBackground` →
`background/background` (but no Background backend is routed on Nidara, tech-debt #89);
non-interactive `Screenshot` stores nothing. The microphone is not a portal permission: a Flatpak
reaches it through its static `pulseaudio` socket. Probes: `scripts/dev/permission-store-probe.sh`
(asserting, including that *Ask* leaves no entry — the check a stored `["ask"]` would otherwise pass)
and `PERM_SEED=… scripts/dev/app-page-probe.sh` to render seeded decisions.

**What a Flatpak got at INSTALL is a second, separate layer** — network, the `pulseaudio` socket (sound
AND microphone: one socket), the GPU, the home folder — never prompted, held from the next launch.
`ui/shell/core/FlatpakPermissions.ts` edits it through `flatpak override --user` (the interface Flatseal
drives too, so each sees the other's changes); the app page shows one switch each, whether the app
asked for it, and *Restore* = `--reset`. Three measured traps: `flatpak info --show-permissions` prints
the MERGED set, so "what the app asked" is read from its `metadata` and the override keyfiles are
layered on top (`!name` removes; system global → system app → user global → user app); `!home` does
NOT take away a declared `host`, so revoking the home folder writes both (and GPU revokes `dri` and
`all`); and a `Gio.FileMonitor` on a MISSING `overrides/` directory never fires when flatpak creates
it, so the watcher creates it first. Probe: `scripts/dev/install-permissions-probe.sh` (a fake
installation under `FLATPAK_USER_DIR`, fails if the real overrides directory changes);
`INSTALL_SEED="<app> <flags>" scripts/dev/app-page-probe.sh <app>` renders it, also on a scratch
installation.

⚠️ Per-app permissions only BIND sandboxed apps: an unsandboxed app is unconfined and can open a
device without asking. The portal still records and shows decisions for it, and Settings → Apps
must say which case an app is in rather than show switches that promise what they cannot enforce.

## `ui/lib/nidara-kit/`

### The kit is a package (tech-debt #108, 2026-09-23)

`nidara-kit` is the platform library of every Nidara application — what libadwaita is to a GNOME
app — INSTALLED once on the system, as its own pacman package `nidara-kit`, and loaded by each app
at start (the owner's option B), so that one update reaches every app. An app published outside this repo
will have the kit and nothing else of this tree. So the directory is the package, and everything
the package needs lives inside it:

| path | what |
|---|---|
| `nidara-kit/*.ts` | the widgets, and `index.ts`, the widget API |
| `nidara-kit/platform/` | what the widgets and an app's start-up need: `host` (the `Gtk.Application`), `gtk-theme` (`useNoGtkTheme`), `appearance` + `appearance-css` + `theme-tokens` (the appearance engine), `font-rendering`, `icons`, `app-id`, and the drawing/token helpers (`tokens`, `accent`, `cairo-draw`, `glass-paint`, `glass-capsule`, `signals`, `file`, `status-colors`) |
| `nidara-kit/styles/` | the kit's sheet: `_tokens`, `_mixins`, `_base-layer`, `_components` |
| `nidara-kit/package.json` | the package's name and ITS version — the kit's API version, separate from the desktop's `VERSION`, because consumers outside this repo pin it |
| `nidara-kit/gi-cairo.d.ts` | the kit's one type shim (`gi://cairo`). It moved in from `ui/lib/` in phase 4: whoever typechecks the kit's sources needs it, and outside the repo that is every app |
| `nidara-kit/README.md` | the guide for app authors OUTSIDE this repo — the public specifier, the minimal app, the tsconfig, the version rule |

🔑 **The kit imports nothing from outside itself** — only its own modules, `gi://…`, GJS built-ins
and `sass:…`. `scripts/ci/kit-boundary-check.mjs` enforces it (widgets-gen job, with a control that
plants `import … from "../process"` and must be caught). It is not a compile error and never will be:
every bundle in this tree can resolve a path the kit should not have reached for. If the kit needs
something that lives outside, it MOVES in, or the caller passes it in — the appearance seam is the
model for the second.

🔑 **The kit is LGPL-3.0-or-later; the rest of the repo is GPL-3.0-or-later** (owner's decision,
2026-09-23). An app that loads the kit may carry any licence — the reason GTK and libadwaita are
LGPL, and the reason a platform library under the GPL would keep outside authors away. Every file
under `ui/lib/nidara-kit/` starts with `// SPDX-License-Identifier: LGPL-3.0-or-later`, and
`kit-boundary-check.mjs` fails on one that does not: code MOVED into the kit changes licence, so
moving GPL code in is a relicensing, which only its copyright holders may do (on 2026-09-23 every
line was the owner's, checked in `git log`; with outside contributors that stops being free).

⚠️ `ui/lib/` outside the kit is NOT the platform: it is code shared by bundles in THIS repo (the
greeter's cards, `process.ts`, `users.ts`…). Nothing in the kit may import it, and it is free to
import the kit.

#### The kit's sheet is loaded, not compiled in (#108 phase 2, 2026-09-23)

`styles/kit.scss` (the base layer, then the components) compiles once to `ui/lib/nidara-kit/kit.css`
— git-ignored, built wherever `style.css` is built (`npm run build`/`dev` in `ui/shell`, install.sh,
the PKGBUILD, the CI `styles` job, the headless smoke) and installed at `/usr/share/nidara-kit/kit.css`.
An app's own sheet no longer contains it: the shell's lost ~47 KB (156 → 110 KB), the greeter's went
from 54 KB to 7.

🔑 **ONE provider, never two — measured.** GTK does NOT compare specificity across providers: a rule in
a later (or higher-priority) provider beats a MORE specific rule in an earlier one (probe: `.a label
{color:red}` in one provider lost to `label {color:blue}` added after it; in one sheet, red won). The
kit and each app were one compiled sheet, where specificity decides, so they stay one provider:
`withKitSheet(appCssPath)` returns two `@import url(...)` lines — kit first — and the app loads that
string (`app.start({ css: withKitSheet(p) })`, or `load_from_string` in `ThemeManager`, whose hot
reload re-reads both). Parse errors still name their file. A second `Gtk.CssProvider` for the kit
would have changed which rule wins wherever the app's rule is the less specific one — silently.

Where `kitSheetPath()` looks: `$NIDARA_KIT_DIR`, then a SOURCE TREE (`<repo>/ui/<app>/style.css` →
`<repo>/ui/lib/nidara-kit/kit.css`; a checkout wins over the system copy, which may be a release
behind), then `/usr/share/nidara-kit`. A probe that compiles its sheets into a temp dir must compile
`kit.css` there too and export `NIDARA_KIT_DIR`, or it silently measures the INSTALLED kit.

Measured, not assumed: the greeter's compiled rules are identical and in the same order (kit + own =
the old sheet); the shell's are the same set with only `base`/`reset` now after the kit, and the one
real tie that creates (`window.nidara-settings-window` vs `window.nidara-app-window`, background)
sets `transparent` on both sides. `shell-gallery-probe` (which now enumerates `kit.css` + `style.css`)
gave **0 changed pixels** on all four scopes, and a control run with an empty `kit.css` gave 27 158 /
192 286 — the instrument sees the kit.

⚠️ In dev, `ui/shell/style.css` is the LIVE shell's sheet (`ThemeManager` hot-reloads it). A sheet
compiled from a branch whose loading code differs from what the running shell executes breaks the
shell on screen within a second — compile experiments into a scratch copy.

#### The kit's CODE is loaded, not bundled (#108 phase 3, 2026-09-23)

`node scripts/bundle.mjs kit <dir>` compiles the kit as ES modules — one per source module plus
shared chunks (esbuild `splitting`), so a module's state (the host's `app`, the appearance seam, every
registered GType) exists ONCE however many modules import it. `bundle.sh … --kit-external=<dir>`
then turns every import that RESOLVES into `ui/lib/nidara-kit/` into
`import … from "file://<dir>/<module>.js"` and copies none of the kit into the bundle.

| who | kit from | where |
|---|---|---|
| shell (release), greeter, lock | `/usr/share/nidara-kit/js` | install.sh (both modes) and the PKGBUILD compile + install it; replaced WHOLE (chunk names are content hashes) |
| shell in dev (`run.sh`) | `ui/lib/nidara-kit/build/js` (git-ignored) | rebuilt on every run — the checkout's kit, never the installed one |
| headless smoke | the checkout's `build/js` | same modules a release installs |
| **installer** | **bundled in, as before** | until the ISO is published: the one program no update can fix |
| probes | bundled in | self-contained on purpose |

🔑 An **absolute `file://` URI**, not a relative import: the bundle runs from `$XDG_RUNTIME_DIR`
(bundle.sh's wrapper unpacks it there), so nothing relative to it would resolve. And a bare
`nidara-kit/…` specifier is not an option: GJS resolves no bare names but its own built-ins.

Measured: a gallery probe built both ways — same pixels, ~210 ms start-up both; the greeter under a
headless `cage`, both ways — **0 changed pixels**, identical logs; a control pointing the external
greeter at a missing dir fails with `ImportError: Unable to load file` (so the external build really
loads the installed modules). No kit source is left in the external bundles (read out of their
source maps): the shell imports 17 kit modules, the greeter 8, the lock 7. Bundle sizes (JS with
inline source map): shell 8.2 → 7.4 MB, greeter 561 → 233 KB, lock 443 → 172 KB.

⚠️ This makes the kit's module paths and exports a RUNTIME contract: an app built against one kit
and run against another resolves `file:///usr/share/nidara-kit/js/<module>.js` by NAME. Renaming or
removing a kit module, or an export, breaks already-built apps — which is exactly what the package's
version (`package.json`) is for from phase 4 on.

#### The kit's own package, and how an app outside the repo reaches it (#108 phase 4, 2026-09-23)

`packaging/nidara/PKGBUILD` builds THREE packages: `nidara-desktop`, `nidara-kit` and
`nidara-installer`. `nidara-kit` holds `/usr/share/nidara-kit/{js,kit.css,src,package.json}` plus
its README and `COPYING.LESSER`; `nidara-desktop` depends on it pinned to the same build
(`nidara-kit=$pkgver-$pkgrel` — its bundles were compiled against those exact module names).
install.sh's local-package fallback installs both in ONE `pacman -U`, because files that change
owner between packages only do so cleanly inside a single transaction.

The public face, all of it in `ui/lib/nidara-kit/README.md` (which is the canonical text — do not
copy it here):

- **The specifier is the absolute URI** `file:///usr/share/nidara-kit/js/<module>.js`. Not a
  stand-in: GJS resolves no bare names but its own built-ins, and a URI needs no bundler at all.
- **The types are the sources** (`/usr/share/nidara-kit/src/`), mapped onto that URI with
  tsconfig `paths`. No `.d.ts` generation: declaration emit needs the GI typings, which a package
  build does not have, and a declaration built without them is `any` where it matters.
- **Two versions.** pkgver is the release's (a split PKGBUILD cannot give one package its own);
  the API version is `package.json`'s, provided as `nidara-kit-api=<x.y.z>`, and that is what an
  outside app depends on. ⚠️ It is ALSO a literal (`_kitapi`) at the top of the PKGBUILD, because
  makepkg reads `provides` before `package()` runs — computed inside it, `--printsrcinfo` fails
  with `pkgver in provides cannot be empty` (measured). `package_nidara-kit()` refuses to build on
  a mismatch and the CI `pkgbuild` job checks it. Bump both when the API changes.

Measured, with an app written in the scratchpad and never inside this tree: `package_nidara-kit()`
run into a scratch root; the app typechecked against that root's `src/` (0 errors; a control with
a wrong `variant` caught as TS2322); bundled by plain esbuild, not ours; run under a headless
`cage` with the scratch root bound onto `/usr/share/nidara-kit` — portal read, kit sheet found,
window presented. Without the bind: `ImportError: Unable to load file from:
file:///usr/share/nidara-kit/js/platform/host.js`.

⚠️ The INSTALLER keeps bundling its own copy until the ISO is published — changing how the one
non-updatable program starts, before the ISO, is the risk this sequencing avoids.

### The widgets

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

- **`ui/lib/nidara-kit/platform/appearance.ts` + `ui/lib/nidara-kit/platform/appearance-css.ts` — how a NON-shell bundle wears the desktop.** `initAppearance()` is the one call: it loads the full `--nidara-*` ramp as CSS (from the engine at `ui/lib/nidara-kit/platform/theme-tokens.ts`), registers the kit's Cairo seam, sets the glass rim, and re-does all three when the user changes their mind. WHERE the values come from is the appearance contract — see "The appearance contract" above: an application reads the Settings portal and nothing else, and only the greeter reads the mirror (`{ channel: "mirror" }`). ⚠️ It is imported from `ui/lib/nidara-kit/platform/appearance-css.ts`, NOT from the kit's index: the kit stays a toolkit that is handed its appearance through the seam, and knows nothing about portals. ⚠️ The SHELL does not use it — it is the writer.

- **`NidaraWindow` — THE window of this desktop, sidebar OPTIONAL (2026-08-26).** A window here is a fixed set of decisions: undecorated; the glass painted by a BOX inside the toplevel (so the toplevel stays transparent and the compositor has a low-alpha region to blur); a draggable header because there is no titlebar; its own app-id; and ONE close path. Slots: `header` ({start, center, end} — `start` takes an ARRAY, because a header start is a row and wrapping two widgets in a second box would double the spacing), `content`, `footer`. Pass `sidebar: { widget, toggleIcon, top?, width?, contentWidth? }` and you additionally get the full-height capsule, the split view, the docking breakpoint and a toggle button prepended to the header row; omit it and the header simply crosses the card. ⚠️ **`onClose` returning `true` REFUSES the close**, and the header button, the compositor's close-request and Escape all go through it — which is what makes "the installer cannot be quit mid-install" one rule instead of three places to remember. `closeMode` is `"hide"` for a window reused across toggles (Settings: rebuilding its 21 eagerly-built pages on every open is visible) and `"destroy"` otherwise (About: a hidden window keeps the application alive). `ui/lib/nidara-kit/app-window.ts` is the layer underneath — the toplevel, the glass, the close policy — and is deliberately NOT exported.

  ⚠️ **The sidebar is an option, not a second component, and that took two attempts.** For one afternoon the kit exported a base AND a sidebar version, and the split looked principled because the layouts really do differ (with a sidebar the header sits over the CONTENT beside a full-height capsule; without one it crosses the card). It was wrong for the same reason the old `NidaraWindow` had exactly ONE consumer: "does this app have a sidebar" is a per-app choice — Finder and System Settings differ on it, and the installer will want a step list the day it stops being a two-button wizard. With two names, adding a sidebar meant migrating a window to a different component. **The header placement is DERIVED from whether there is a sidebar, not exposed** — a parameter nobody uses today is a third way for two windows to drift; add the axis when a real case wants Finder's spanning toolbar.

  ⚠️ **A default that belongs to ONE layout must not become everyone's.** `defaultHeight = 760` is the two-pane window's (one that opens short looks broken); About is 429 tall because that is its content. Defaulting it in the unified signature made About 760 — caught on screen the same afternoon, which is the only place it was visible.

- `NidaraSplitView` — replaces `Adw.OverlaySplitView` + `Breakpoint`. Its `collapseAt` is a **fixed px breakpoint**, never derived from the content: a breakpoint computed from the active page's natural width is a different window on every page (2026-08-11 — see design-system.md, "The Settings window has ONE geometry law"). Collapsed, the sidebar is REPARENTED into a `Gtk.Popover` (xdg_popup → compositor blur behind it, and `autohide` does the dismissing). There is exactly ONE collapsed mode since 2026-08-16: the Overlay + click-catching `backdrop` alternative, and the `floatAnchor` parameter that selected between them, are gone — see the focus-grab section for why a catcher must not coexist with a grab.
- `NidaraClamp` — replaces `Adw.Clamp`. Takes a `minWidth` as well as a max; passing the same value for both is how a pane gets a CONSTANT width (what Settings does).
- `NidaraWindow` — the glass window shell. It owns the geometry law: from one `contentWidth` it derives the split view's breakpoint (`sidebar + content`), the window's minimum size and the width it opens at (always wide enough to show the sidebar docked).
- `NidaraButton` — suggested/destructive/pill variants
- `NidaraCircleButton` — the round glass icon button (close / remove / collapse), and its `.nidara-circle-btn` rule. Moved out of the shell's `common/IconButton.ts` on 2026-08-26 when the installer needed the same control; that file is now a wrapper adding the two things the kit cannot reach (the glass tooltip, which needs `ThemeManager`, and the capture-phase click that stops a clickable parent from also firing). ⚠️ It puts `nd-icon` on the image, so a bundle using it owes an `.nd-icon` filter rule in its sheet — see design-system.md, "The installer is the FOURTH bundle".
- `NidaraDropDown` — the native `Gtk.DropDown` with our scroll bar swapped into its popup list. The native widget is deliberate: its popover is a real Wayland surface, so Hyprland's popup blur frosts it, which an in-window overlay list cannot get. (`NidaraSelect`, the overlay version, and its `NidaraOverlayManager` were deleted 2026-08-03 — consumer-less since Settings moved here.)
- `NidaraSidebar` — single-select nav list; items take an optional `groupStart` to draw a thin **title-less divider** before them (thematic clusters, no group labels). The Settings sidebar uses this for its 3 clusters (connectivity · look/shell/behaviour · system & devices). ⚠️ **Its label is `ellipsize: END` for a structural reason, not a cosmetic one**: the label carries no `font-size`, so it grows with the interface font, while the capsule around it is a FIXED column (`sidebarWidth`, 250px in Settings) whose scroll view is `hscrollbar_policy: NEVER`. Without ellipsizing, a label's minimum width *is* its natural width, so a long string makes the capsule demand more than its column reserves and it overruns the content pane. Measured 2026-08-11: the label budget is **176px** (250 − 8 capsule margin − 12 list padding − 24 row margins − 18 icon − 12 spacing), and the Russian "Специальные возможности" needs **204px at the default font size** — i.e. it was already overflowing in a shipped locale before any accessibility scaling, and English "Language & region" joined it at text-scale factor 1.39. Any new fixed-width text box in the kit needs the same treatment; the general rule is that a text widget in a reserved column must not be allowed to set that column's width.
- `NidaraBadge(label, icon?)` — a neutral status pill beside a row's text ("Isolated", "Not isolated"). A FACT, never a control: no hover, not focusable, no accent (the accent marks selection). Born for Settings → Apps (#535), where the same fact shows in the list, on each app's page and later in a Privacy view — one component so the three cannot drift. Its icon is a `Gio.Icon` tinted by `.nd-icon`.
- **Dialog responses are `NidaraButton`s** (`nidara-kit/dialog-buttons.ts`, shared by `showNidaraAlert` and `showNidaraFormDialog`): equal widths, the suggested action `primary`, a destructive one `danger`, the rest `secondary`. Until 2026-09-13 both dialogs drew flat full-bleed text cells split by a hairline — a macOS-alert idiom no other surface used, reported on the first live consent prompt. Do not give a dialog its own button again; extend this row.
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
shape (measured 2026-08-16: `setConfig appearance.shellAppearance dark` — the shell pin, removed since, #676 — moved the bar and the dock
while the dropdown two inches away still read "Follow system", for the rest of the session; the four
advanced glass sliders — gone since #674 — lived in a Revealer that started closed, so they are unrealized until it opens and
came back showing the value they were BUILT with, contradicting the master right above them). The
question that finds it is not *does this control have an external-sync hook?* but *does that hook
answer the question, or only promise to?*

⚠️ **`bindWhileRealized` and `onPageShown` have different jobs.** The first tracks
subscriptions across navigation (dispose on unrealize, re-arm on realize); the second
re-asks values when a cached page is shown. Before #571, Settings hid on close and its
pages stayed realized: close → change externally → reopen was the stale-value case.
Settings now exits on close and reopening builds fresh pages, but navigation still
uses the cache. `onPageShown(read)` remains the complement for one-shot questions,
registered while a page is built and called by `showPage` plus `notify::visible`.
Use `bindWhileRealized` when there is a subscription to dispose, and `onPageShown`
when there is only a value to re-read.

This distinction is the whole of a bug family found by the 2026-08-16 sweep, and the question that
finds it is *what did this page have to GO AND ASK for?* An `execAsync`, a file read, a one-shot
`powerprofilesctl get`: answered once, then frozen for the life of the shell, and a frozen value looks
exactly like a correct one. Three were live — Power's profile selection (which game mode swaps behind
its back, today from the shell), About's uptime (a clock, wrong within the minute), and About's update check (lost to a
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

Two halves, split by who owns what (#682, the owner's decision of 2026-10-01):

- **The compositor recognises a game and gives it a workspace of its own, `gamespace`** (a NAMED
  workspace: negative id, not special, outside the numbered row). The signs, the same in both: the
  class `steam_app_<id>`; a Steam app id (`SteamAppId`, `SteamGameId`, `STEAM_APP_ID`) in the
  environment of the window's process or one of its parents (Steam starts a game through a reaper
  and a launcher or two); a surface whose content type is "game" (wp-content-type-v1). Hyprland:
  `hyprland.lua` (a `window.open` handler + two rules), plus `gamespace-perf` — immediate, no
  blur/animation/shadow, `idle_inhibit`. Hyalo: the `[rules.games]` rule, `match = { game = true }`
  (`wm/games.rs`, hyalo.md); immediate presentation, VRR and idle inhibition there are #683.
- **The shell does everything around it, once for both** (`core/GameSession.ts`, decisions in
  `core/game-session-logic.ts`), from Settings → Gaming (`org.nidara.gaming`): the game's Steam
  library hero image (or a chosen image) as the wallpaper of the game's output, the performance
  power profile, notification banners held back (`silence-notifications`, on by default; a critical
  one still shows, all of them wait in the notification centre), and, when the last game window has
  been gone for 3 s, the session undone and the user taken back. A game is "a window on `gamespace`"
  — the shell reads it from `CompositorState`, so it needs no event of its own from either
  compositor; a window the user moves onto `gamespace` counts, a game moved off it does not.

🔑 **Entering a session is a thing that has to be UNDONE, so it is a capture, not a constant.** Exit
used to hard-code `powerprofilesctl set balanced`, which is right for exactly one of the three
profiles: a session started from Power saver ended in Balanced and the Settings choice was silently
gone (2026-08-16). Each of these was a bug in the Lua the shell's logic replaced, and the probe holds
all of them:
- **The "already in a session" guard is its own state**, not "did we swap a wallpaper" — with
  `wallpaperMode = none` a second game window re-ran the entry and re-captured the profile it had
  itself just changed.
- **Restore only if the profile is still the one we set.** A profile the user picked mid-game is a
  newer decision than ours.
- **Undoing the session and putting the user back are different jobs.** They used to share one
  condition (`the user is standing on gamespace right now`), so quitting a game after wandering to
  another workspace left the game wallpaper up and the machine on performance. Undoing is
  unconditional; only the focus return is conditional.
- **What a session changed is recorded as it goes** (`$XDG_RUNTIME_DIR/nidara-game-session.json`),
  so a shell that restarts mid-game (`Super+Shift+R`, a crash) ADOPTS the session — it does not
  capture "performance" as the profile to go back to, and it undoes the session if the game closed
  while no shell was running.

The wallpaper goes through `WallpaperManager.showForGame`/`restoreAfterGame`: per output, never
saved or announced, no transition on the way in (the game covers it at once, and an awww transition
running under a fullscreen game froze halfway until the game closed), the user's transition on the
way back to the wallpaper as it is on disk NOW.

The test: `scripts/dev/game-session-probe.ts`, a CI gate with a control (dev-workflow.md). Measured
end to end on Hyalo nested (2026-10-01): a window carrying `SteamAppId=440` lands on `gamespace` and
takes the user there; the fake artwork shows, a notification is held back, the profile goes
power-saver → performance → power-saver (a fake `powerprofilesctl`), and after the window closes the
user is back on workspace 1 with their wallpaper.

- **`nidara-game-mode` script (`Super+Shift+G`)**: a manual toggle of the performance profile, apart
  from all of the above.
- **`Super+B` → `toggleBarOverlay`** (alias `toggleGameOverlay`): promotes **only the Bar** to OVERLAY layer over any fullscreen window (requires an active fullscreen window to activate; deactivation always allowed). Not game-specific — it lives here because games are the main fullscreen use case. Banners live in the bar's window, so this is also the one way a notification shows over a fullscreen window — and a game's silence still holds it back.

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


## Native toolkit range values

A range control (`Slider`, `SpinButton`) publishes `nk_a11y::ValueInfo` (min, max, current,
step, the spoken text) and the provider serves AT-SPI `Value` from it. The provider NEVER writes
the value: `CurrentValue` set from outside becomes `Request::SetValue`, offered only with
`Action::SetValue`, and the app clamps and steps it exactly as its keys do before publishing.
A tree with a value outside its range fails `validate()`, so a widget bug surfaces as a refused
publication, not as a reader saying a number the control cannot show (#882, toolkit/CONTRACT.md).

## Native toolkit radio groups

One component, two looks (#882): the segmented/preset choice and the accent swatches are both
`Kind::Choices` holding `Kind::Choice`s, built by `Tree::choices` as a row's control. What
differs is only `ChoiceKind` and the exported `ChoiceStyle` (`toolkit/tokens/choices.json` →
`components.json` `choices`, read by the app; no compiled defaults). Keyboard semantics are the
radio group's: one Tab stop (the chosen option, `tab_stop` in `focus_order`), arrows/Home/End
move focus AND choice (`Tree::control_key`, called first in `Composition::event`; later range
controls hook their keys there too). AT-SPI: the group is a Panel labelled by its row, each
option a RadioButton. Trap found building it: the keyboard ring drawn ON a shape is invisible
on the chosen segment (accent on accent); a choice's ring is offset outside it
(`choice_focus_shape`), as the kit's `nidara-focus-ring` is. Its libatspi gate is
`scripts/ci/nk-choices-check.py` (demo `--choices`), run in the hyalo job's real-gates block;
its real Orca walk is `scripts/ci/nk-choices-orca-check.py`, beside it, sharing Orca's set-up
(speech server, private registry, Num Lock observed off) with phase 0's through
`nk-real-common.py`'s `start_reader` — one Orca for the run, the demo restarted per fault.

Range controls (`ranges.rs`: `Slider`, `Fields` of `Spin`s) keep ONE clamp-and-step for every
source — model, keys, pointer, AT-SPI SetValue — and report `Effect::Changed`. Two traps met
while testing them through libatspi: in Python, `node.get_value_iface().get_text()` is
`Atspi.Accessible.get_text` (the Text interface, None), not the value's text — call
`Atspi.Value.get_text(iface)`; and a row is itself a Panel named by its label, so the fields'
Panel "From" must be found by its spin-button children, not by name.

## Native toolkit text geometry

`nk-text::Layout::cluster_boxes` caches logical shaped-cluster bounds and leading
caret edges in one visual pass per reflow, using the retained Parley runs that are painted.
The app translates them by the actual content origin into `TextInfo.geometry`, a plain
UTF-8 span partition; `nk-a11y` owns neither fonts nor layout. Scalars in one shaped cluster
share its real box, including combining marks and emoji sequences. AT-SPI ranges convert
scalar offsets to bytes only at the provider edge, then union the intersecting boxes and
round outward for integer `GetRangeExtents` / `GetCharacterExtents` results. Collapsed ranges
use the cluster's leading edge (AT-SPI has no affinity); the end uses the layout's final caret.

The coordinate contract is WINDOW, the coordinate type real Orca requests. Missing geometry
or other coordinate types return `NotSupported`; a field-wide fallback fabricates text bounds
and breaks flat review. A committed buffer replaced by IME preedit has no matching geometry
until it is painted again; never attach the replacement layout's byte ranges to the committed
string. Password redaction removes the entire TextInfo, including geometry, before validation.
The authentic KP_Up full-line speech assertion and wrong-extents control live in
`scripts/ci/nk-orca-check.py`; evidence and scope are `toolkit/phase0/EVIDENCE-846.md` (#846).


## Native toolkit structural widgets (#873)

`toolkit/crates/nk-widgets` is the retained structural layer over `nk-text`,
`nk-render`, `nk-a11y` and `nk-wayland`; phase0 remains beside it. `Tree::group` and
`row` create headers/labels and controls in one tree. Semantics, label relations,
focus order, hit-testing and paint derive from it. Never build a parallel AT-SPI
hierarchy in an app. Hidden rows leave semantics; scrolled-away rows remain VISIBLE
but not SHOWING. Targets include the tree generation; stale/hidden/disabled actions
are rejected on the app thread. Pointer release belongs to the pressed node and its coordinate space. A layer's
input is already inverse-transformed by Hyalo at its presented position; never
clip it again at its model endpoint. The public AT-SPI attributes
`nidara-node-id`/`nidara-tree-generation` identify each snapshot's targets.

Layout measures into retained nk-text Layouts, then places; the renderer consumes
those same Layouts. Invalidation separates layout, paint and semantics. Font/text
scale changes keep ids, focus and scroll. `window::Composition` uses the existing
nk-wayland host, creates synchronized sidebar/title layers and repaints those only
when the panes change. The sidebar scrolls independently below its header; focus
reveals even the last page. Pane vertical scroll goes to sidebar/content for
sidebar/title; horizontal scroll on either goes to content via nk-wayland.
D7 collapse releases the leading inset on the pane curve, remeasuring content
and moving/resizing the title pane. The fixed breakpoint is `Metrics.sidebar +
Metrics.content` from WINDOW_LAYOUT, never page content. Narrow windows open an
overlay (zero inset); page choice, Escape and outside click dismiss it. Crossing
back to the breakpoint docks it again. `Tree::sidebar_button` registers its
title button; other title buttons remain application actions.
D7 content spans the whole window; focus/SHOWING excludes
the leading/top insets. D5 (no material OR layers) paints opaque panes in the root
and clips content to the insets. Its client animation has one sampled timeline
shared by paint, hit-testing and focus; AT-SPI bounds stay model values. Reduced
motion omits the transition independently of transparency. Never add another
app-owned Wayland host.

D7's native title uses an explicit `TitlebarStyle` (blur-only graded bands and a
client background fade); it does not reuse the sidebar's panel glass. The demo's
provisional recipe is identified in `titlebar-provisional.json`, not in transport.
The sidebar's margin/radius come from `Tree::set_sidebar_frame` with app tokens.
Native Settings supplies that title style explicitly from `toolkit/tokens/header.json`
(via components.json), including reduced-transparency fallback. Its 48px band,
32px header controls and 60×32 navigation are distinct from 72×24 window controls
at y12. A sidebar icon keeps its full accessible name without painting that name.
`Composition::sync_with_layout` positions floating controls on the same sampled
sidebar timeline before painting. A SearchInput inside ControlCapsule uses that
capsule's text-input surface and local caret coordinates; selection pixels stay
outside the adaptive ink coverage. Identical placement must leave Tree clean.
Native apps opt into `Application::window_controls` before configure; Hyalo owns
window controls whenever its protocol supplies a layout. `Tree::window_controls`
registers ordinary titlebar fallbacks. Native Settings instead registers its existing
vector capsule with `Tree::window_controls_capsule`: the whole fallback panel and
its children leave paint, focus/capture and AT-SPI on server layout, and return
with the same IDs without it. Placement reserves the announced side/size, not the
client's fallback metrics or a stale Config1 side. The registered capsule's root-local
position feeds `Tree::server_controls_bounds` and Composition's compositor request;
keep the kit's 12/12 position independent of content/sidebar insets and SSD margins.
The existing protocol is bound in nk-wayland, never in a second app host.

Container accessible names are not visual labels: the native Sidebar/Scroll names
stay in AT-SPI; visible text needs a Label, Page, Button or TitleBar. Painting a
container name centres it over its children (the misplaced “Pages” in #898).

The demo is `toolkit/widgets-demo`, not Settings. Its palette is selected only from
the appearance portal and exported tokens. `tokens/glass.json` is required: select
`variants[]` by `dark`/`reduceTransparency`, then the last `pieces.panel[]` step
with `fromSide` at or below each pane's rounded shorter side. The composition
resolves material separately for sidebar/title on resize; the export's wash is an
object, not an array. Every token becomes a style in `nk_settings::styles` (the switch too: `components.json` `switch`), shared with the native Settings. Hyalo's own
layer glass and its window-layer IPC listing are Claude's separate work. The
libatspi acceptance is `scripts/ci/nk-widgets-check.py`; each assertion has its own
logged, applied fault, and timeouts/crashes never count as caught controls. New
builds/logs/evidence use target/ or ~/Nidara/ChatGPT/, never /tmp. nk-widgets and its
demo trigger the full fcitx5/Orca matrices in ci-scope.sh.

D7 graded-title bands share edges snapped to physical pixels at the current output
scale: separate antialiased shapes meeting inside a pixel can expose sharp content
between them. Keep these edges shared when changing title height or scale.

D8's `focus_visible` is input modality, not semantic focus. Do not use `tab()` for
automatic focus recovery: it marks keyboard input; internal recovery traverses
without changing modality. Pointer input in root or layer coordinates hides the
ring even on empty space. The retained focused node and selection remain intact.

D8 `highlight_shape` is the single source for selection/hover/focus geometry; do
not compute a separate focus radius or draw a ring on the full row bounds.
Ordinary buttons keep Metrics.radius; only an explicit ButtonShape::Capsule uses
half-height rounding. Base, hover and ring all follow that declared shape.
Rows holding controls do not hover as a whole. Separators use visible neighbors
and text origins. Root pointer leave is forwarded by nk-wayland just like layer
leave, so retained hover cannot remain after the pointer exits the surface.

D8 page width is a named policy on the retained content region (`set_page_width`),
not a number picked by each page. A Group card is placed at its constraint width;
its measured width may include an explicitly wide child for scroll extent and
must not expand the card. Form aliases WINDOW_LAYOUT's existing preferred
width and floor. Apply the policy before the measure-cache key is recorded;
changing the named kind must not reuse a wider/narrower stale layout. Centre in
the current content viewport (after the sampled sidebar inset), not the window.

D8's provisional list source is `toolkit/tokens/list.json` (`default` plus whole
field `variants`, like control.json). The exporter attaches the resolved `list`
object to each components.json mode variant. Native readers select the portal variant from the
installed export; never compile fallback visual numbers into an application.
settings-tokens-check requires each field and its CI control removes highlight
from one mode variant. Form width still aliases the existing WINDOW_LAYOUT tokens.

Keep material and component exports separate (owner, 2026-10-21): glass.json is
only glass/tone/blur/shadow/backdrop response, including control.json. Common
geometry, focus/hover/separators and named content widths are components.json
mode variants. Lists apply on ordinary window backgrounds too, not only panels.

For native client title dragging, use Composition::event_with_window rather than
reconstructing pointer coordinates in an app. Root/layer Button events carry the
serial and millisecond timestamp of that event; do not use Window's general last
serial after draining input. nk-wayland owns xdg_toplevel.move and its seat.
Blank title excludes controls even when disabled, server reservations and the
blur-only region below the title. The application supplies double-click policy
(the demo mirrors Hyalo's existing400ms); maximize/restore stays WindowAction.

The native #889 material payload is validated before Wayland mutation. Fixed
arguments are truncated by wayland-scanner at 1/256 logical pixel, so float-only
non-overlap/positive-size checks are insufficient; touching float rectangles can
overlap on the wire. `ControlMaterial` checks wire geometry and sends response
and ink tone before the capsule shape, in the same synchronized transaction.

#889's retained ControlCapsule owns ordered existing button nodes; captions
(glyphs) and accessible names are separate. Never add per-button surfaces or
parallel focus/action machinery. Placement and metric changes preserve node IDs;
visible bounds are clipped to the window. Capsule geometry is a component export
(capsule.json), not glass material; pitch derives from button + gap (independent of outer edge). Hyalo will
retain a usable layout mirror checked against that source, so close works even
without exported data.

Window-control capsule glyphs (#936) are `WindowGlyph` kinds, never font
characters. The shared strict reader in nk_settings::styles loads capsule.glyph
from components.json into WindowGlyphStyle; the app calls
Tree::set_window_glyph_style before painting (and on appearance changes).
nk-render strokes the paths; both capsule layer coverage and D5 use that painter.
Caption-based toolbar actions remain separate from window controls. The existing
Hyalo capsule mirror unit test checks glyph geometry too; keep shader uniforms
and the export together. Glyph-style changes must invalidate the capsule panes,
not only the root, or a cached layer will keep its old coverage.

A live capsule metric change invalidates each child measurement too: its width
constraint can stay identical while button_min changes. Invalidating only the
parent reused stale button widths; the retained geometry oracle catches this.

The capsule export requires independent edge and gap; neither is a fallback for
the other. Hyalo keeps the default geometry mirror, unit-checked against the
component source. Width and hit boundaries derive from the gap; current values
remain unchanged by this schema repair. Missing either field fails export checks.

For the #889 native demo control reader, retain the exact installed portal variant
and rounded short-side step. `inkTone: null` explicitly reuses `tone` (Hyalo's
Shape semantics); missing inkTone is an error. Response null is the reduced-
transparency variant, and reduced motion zeros response settling and wash fading.
Capsule geometry is in components.json, not the material export. The current
reader is local and not yet connected to the demo's layer manager. A state ink
override that is absent or explicitly null uses the shared material ink; no fixed
colour is substituted. Reader tests also require generated exports when
NK_REQUIRE_EXPORT is set, keeping fixture-only checks distinct from that path.

The capsule reader requires gap independently from edge, including when zero.
Missing/negative gap is an error; selected variants retain the exact exported
separation. Toolkit CI passes absolute NK_SETTINGS_DATA to mandatory export
tests, pointing at the actual exports generated earlier in the same job.

Capsule geometry is in components.json, not the material export. The demo's --capsules mode connects the reader to CapsuleComposition: one
synchronized layer per panel, monochrome glyph/ring coverage, stable alpha-zero
idle state IDs and root/layer input through the existing retained Tree. Repaint
signatures include pane epoch, scale, style revision and reduced-motion mode;
call invalidate() after appearance changes. D5 requests the exported opaque
variant separately. Capsule input is offered to CapsuleComposition first; other
input still uses Composition::event_with_window so client title dragging survives.
The --capsules demo opts out of server window controls, preventing two sets.
Compositor/idle acceptance remains pending; D5 state fading is described below.
A state ink override that is absent or explicitly null uses shared material ink;
no fixed colour is substituted. Reader tests require generated exports when
NK_REQUIRE_EXPORT is set, separate from source-fixture checks.
The #921 visual change must update capsule.json's default in the same change
as Hyalo's geometry mirror. Land the independent gap schema first, then keep
server layout and generated native component data synchronized. The mirror
unit test rejects leaving the previous export dimensions behind.


For opaque capsule fallback, CapsuleComposition::sync samples a finite linear RGBA
wash timeline using the exported states.fadeMs (the same law as Hyalo's Ease).
First appearance is immediate; interrupted hover/press/out retargets from the
sample currently shown. Reduced motion snaps any in-flight fade. The Tree painter
consumes the stored wash, with geometry/input/semantics unchanged. Settled updates
stop invalidating paint; is_animating() exposes the need for further samples. The
foundations demo still polls at 16 ms in this cut; do not claim idle scheduling
from the API or a settled no-op test. D5 uses client monotonic time since first
sync, not presentation time or a clock shared with D7. D7 never starts this client
timeline. Tests must inspect painted midpoint
pixels, not just the stored alpha.
Idle washes retain the matching hover RGB with alpha zero, including destructive
controls, as Hyalo server controls do. Transparent black would change the straight
RGBA interpolation and therefore the visible fade.


The #889 diagnostic `--capsule-lab=white|text|dark|sweep` is a separate app mode
using the same Appearance reader, Bridge, retained Tree and CapsuleComposition.
Its root paints explicit diagnostic stimuli; `Tree::paint_capsules_fallback` adds
opaque capsules to that existing canvas using the ordinary retained painter.
Server controls are deliberately enabled here for comparison, unlike --capsules.
Sweep needs an explicit positive --capsule-sweep-ms; after one cycle it stops.
Reduced motion prevents/cancels that sweep. The lab alone consumes is_animating()
for a 16 ms active / 1000 ms inactive poll interval; portal/AT-SPI work still runs
in idle. This is not integration into the foundations demo's constant 16 ms poll,
nor proof of native wakeup latency, idle CPU or zero compositor frames.
`paint_count()` increments after a successful client layer-buffer paint; it does
not count compositor work or presentations. External-backdrop harnesses and
native acceptance on rebuilt heads remain separate work.


The lab custom-root painter filters ownership per capsule with
paint_capsules_fallback_where: panels with a CapsuleComposition layer are excluded
individually, never inferred from panels[0]. Ordinary opaque content still paints
all its capsules. A layer allocation error still propagates out of sync; this
filter is not silent allocation recovery. The mixed-ownership pixel oracle is
CPU-only with a synthetic panel-ID predicate, not a native allocation test.
Reduced-motion sweep selection/cancellation prints its stationary level explicitly.


The capsule external-backdrop diagnostic is an independent nk-wayland application
mode, --capsule-backdrop=<command-file>, not a second transport or provider.
Commands white/text/dark/sweep [level0..1] are explicit stimuli; external overlay
commands are refused. The backdrop has no material and shares paint_scene with
the lab; lab scene overlay leaves its root background transparent. Changing the
file changes only the external client. Unchanged input does not call redraw from
Backdrop::idle; its inherited poll interval is1000ms, not a file-notification
wakeup. A sweep command is a stationary grayscale level here, not a timed sweep.
CPU painting checks do not prove native constant capsule commits, ink response,
settling, performance or idle CPU. External harness/evidence and rebuilt-head
native acceptance remain separate work; never reuse the invalid source-RGB curve
estimator as a compositor oracle.


The local external-capsule harness reuses check-headless.sh's private bus/runtime
and caller-selected absolute fixed binaries; capsule-fixture.toml applies only
to the two diagnostic app IDs. It captures white/dark/white at scale1 or1.25.
Every command publication (initial and changes) MUST use a neighboring pending
file plus same-directory rename, via capsule_capture.publish_command. Never
truncate the visible command file: Backdrop::idle correctly treats invalid bytes
as a fatal input error. A filesystem test reads the old command during a partial
pending write, then the complete new command after rename; errors preserve old
bytes. This is atomic visibility, not crash-durability or multiple-writer support.
Before each change the harness records all three material answer revisions; it
requires a new backdrop commit and strictly newer, measured, settled answers for
every capsule and server controls. Offline checks repeat that metadata guard.
The fixed-light-ink control must complete setup and fail its own glyph assertion;
timeouts/setup failures never count. The extracted harness has no intermediate
RGB estimator, curve/states/idle/Orca branches or CI job. Guard tests and compiled
lab code do not prove this rebuilt native matrix; log exact binary hashes when
running it, and keep source verification distinct from prior fixed-binary proof.


External PNG acceptance brackets screenshot with two material-ready snapshots.
After the first ready snapshot, capture, then require identical per-panel answer
revisions and still-settled fresh answers in the second snapshot; retry otherwise.
Save the second as stage.json and the first as stage-capture-before.json. Offline
validation checks both, so it cannot pair an older PNG with a later settled JSON.
A post-screenshot-only readiness test has a settling race and is insufficient.


Settings and the diagnostic widgets demo share one installed material reader in
nk_settings::material::{panel,control}. The demo modules only re-export it; no
application-specific copy of ControlRecipe/PanelMaterial/capsule_metrics remains.
Source-fixture and mandatory generated-export tests live with the shared reader
in settings/tests/fixtures and settings/src/material. Null/absent state ink and
all exact variant/size/validation rules are preserved. This ownership move does
not assemble Settings chrome or add its native main loop. Settings export tests
honor the caller's absolute NK_SETTINGS_DATA with NK_REQUIRE_EXPORT=1; a token-only
export cannot satisfy manifest/i18n tests and must not be reported as complete.


### Native Settings window assembly (#915)

`toolkit/settings/src/window.rs` assembles retained sidebar Page nodes, title bar,
one content Scroll for Rendered and one control capsule. It reuses the existing
Composition/CapsuleComposition and shared installed material readers. No second
host/provider or material parser. Window labels and capsule metrics are caller
inputs. Titlebar/transition policy must be supplied explicitly before sync.
Sidebar activation reports a page ID to Router and restores the previous selection
until routing and mounting succeed; only selected() commits the new title/page.
The app mounts Rendered under Shell::content. Keep the shell separate from the
native main loop: this assembly alone does not claim live routing, portal updates,
AT-SPI/Orca, presentation or performance acceptance. Main still needs to supply
window policies and integrate service/portal/routing/mount lifetimes.


🔑 **The takeover is dropped (owner, 2026-10-26, PHASE1.md revision 3):** the Rust desktop
grows as its own session and never routes to the GJS Settings. The routing below stays as
code until it is in the way; nothing is added to it.

Native Settings exports the Request object in Native mode too, before acquiring
its native bus name. Only EntryPoint mode acquires org.nidara.Settings; pre-takeover
second native instances must still reach Request at org.nidara.SettingsNative.
Propagate handoff errors instead of reporting AlreadyRunning without delivery.
Routing tests use explicit private dbus-daemon socket paths under toolkit/target
and explicit connections, without changing DBUS_SESSION_BUS_ADDRESS. A test-only
RoutingReady endpoint confirms the real object server responds before a missing-
Request control is tested; it implements no Request and no UI/provider behavior.
The control must fail its handoff assertion with UnknownInterface, not a timeout.


Native-mode forwarding goes directly to org.nidara.Settings (ENTRY), with no
legacy launcher or LEGACY_START wait: the existing legacy process is still the
entry point, or D-Bus activates it, or the call returns a clear error. Pass Mode
into Service; do not route pre-takeover pages/apps to the post-takeover LEGACY
name. EntryPoint mode retains LEGACY plus launcher. Private routing tests omit
activation service directories so missing-entry cases cannot start installed apps;
each Bus Drop stops its daemon then removes only its own target/rb runtime.

The native Settings window capsule uses components.json capsule.windowInset for both
corner axes, independently of generic row padding/gap. The owner #921 geometry is
72 by 24 at 12/12; generated-export window tests check both sides and D5/D7 layouts.

Settings positions its three window-control buttons from the current exported
CapsuleMetrics before one layout pass. Tree::capsule_metrics returns the current
metrics, including portal updates staged before layout; no cached measured bounds
or second layout is needed just to compute the capsule's horizontal placement.


The native popup seam is nk-wayland::run_popup: standard xdg_popup on the parent's
connection, not a D7 layer or new toplevel. Positive integer anchor/size are
validated before positioner requests; optional grab serial comes from physical
input. Key::serial is Some on physical presses and None on repeats/synthetic keys.
PopupDone closes the nested host; reposition requires xdg-shell v3 and publishes
its acknowledgement token. Ordinary close advances the parent's input floor and
resets keyboard state; Window Drop destroys child roles/surfaces on error too.
Closed windows get no idle callback. The transport probe/harness belongs in a
separate cut; compilation/placement unit tests are not a native popup or Dropdown,
AT-SPI/Orca, output-edge/fractional or timing acceptance.

While this nested loop is open, the parent does not repaint or service its
configure, scale or appearance changes. Keep it bounded to short menus; a
long-running child needs parent servicing that this primitive does not provide.

The popup diagnostic reuses widgets-demo/check-headless.sh through
nk-wayland/check-popup-headless.sh, with evidence/runtime under target. The
checker requires completed lifecycle setup before its role-substitution assertion,
and verifies destruction before return on callback error. Compilation and syntax
checks do not establish native role/grab/reposition/cleanup acceptance; keep older
fixed-binary evidence attributed to its original source and hashes.


`nk-widgets::Tree::dropdown` is the retained ComboBox/Selection model (#882/#915).
Its selected option remains an accessible child while collapsed, with zero
paint/hit area and no independent Tab stop. Option activation emits Changed on
the combo through the ordinary stale/hidden/disabled guard; combo activation
only requests opening. Expanded state and selection are independent. Popup list
painting/input, final closed-control look and Settings builder remain separate
pending work; model tests do not prove real Orca speech.

The closed Dropdown trigger now uses `DropdownStyle`, exported once from
`toolkit/tokens/dropdown.json` as components.json's `dropdown.trigger`; shared
`nk-settings::Styles::apply` installs it. The source is the current kit CSS,
including the reserved 2px focus border, relative Settings font/weight and
shared-theme down chevron. Missing style/arrow is an error. The trigger's
paint/geometry no longer reuse Button defaults. This does not implement the
open popup list or accept its native look/Orca behavior.


`Tree::menu_list` and `MenuStyle` now provide the retained Dropdown list over
standard xdg_popup (#882/#915). MenuOption semantics use Option/selected; hover
and keyboard focus are independent of the chosen check. Up/Down/Home/End reveal
focus while skipping unavailable rows; Activate is returned to the controlled
parent. Menu tokens come from the current CSS/factory, with one row inset and
a permanently reserved trailing check slot. `set_menu_style` keeps IDs/focus.
The native diagnostic source belongs to a separate cut. The production popup
controller, shared accessibility publication/ID-generation safety across parent
and popup, and Settings builder remain to integrate before any real AT-SPI/Orca
acceptance claim. Current evidence is CPU component proof only.

Menu keyboard navigation clears hover before focus/reveal: stationary pointer
state must not paint a second highlighted row after arrows/Home/End or scrolling.
The standalone menu remains a menu_style-controlled Tree mode across layout,
measure, viewport and paint; preserve this explicit boundary until builder
integration extracts it. Trigger visual debt: the kit's 0.15s hover/active
transition has not been ported. The arrow text-dim token still needs live queryUI
verification against the GTK arrow node (image CSS does not establish its ink).

The MenuList diagnostic source is separately available: Settings dropdown-probe,
check-dropdown-headless.sh and nk-dropdown-check.py reuse the private widgets
host. Forced opaque D5 composition and prepared select/cancel faults are not
native proof until executed against exact binaries; current extraction is
compile/static-only. Do not import original fixed-binary PASS into new heads.

The Dropdown's `DropdownPopup` adapter borrows the controlled parent Tree and
projects its separate MenuList view onto the parent's existing ComboBox option
IDs. Publish that merged snapshot through the SAME provider, not two independently
numbered Trees/providers. ComboBox/Selection/LabelledBy stay in place; menu focus
and configured parent-relative bounds attach to the existing options. Other
parent actions are suspended. The returned process-unique publication revision,
plus captured menu generation, guards request routing across reopenings; the
bridge must tag requests with its actual published revision. `finish` uses guarded
parent selection; cancellation/Drop only collapse and restore available focus.
This is CPU-tested groundwork: host/controller publication with the actual popup
configure origin, builder integration and real Orca speech still need validation.

The short-menu adapter intentionally holds an exclusive parent Tree borrow:
parent repaint/configure/scale/appearance servicing cannot run concurrently.
Revise that ownership contract before building a controller that needs it.
An unavailable chosen option retains its check but initial focus falls back to
the first available option, or none if all options are unavailable; opening and
cancellation must still work without changing the chosen value.

For that modal snapshot, `nk-wayland::Window::popup_geometry()` now exposes the
compositor's actual `[x,y,width,height]` relative to parent window geometry. It is
None on toplevels/before first configure, and latches the pending popup rectangle
with size only at xdg_surface.configure acknowledgement. A reposition request is
not evidence of a new origin. Use the configured origin for semantic bounds;
flip/slide can differ from the requested anchor, including negative coordinates.


The separate popup-geometry diagnostic logs Window::popup_geometry on each
Configure and compares it with received xdg_popup wire rectangles, including
reposition, while requiring toplevel None. Its source is compiled/static-checked
on extraction; checker execution remains pending. Do not substitute historical
fixed-binary results for native evidence of a rebuilt head.

`nk-a11y::bridge::Bridge` now owns the reusable provider worker. Requests carry a
snapshot-bound publication revision via `Backend::new_versioned/update_versioned`:
node/action/availability validation and revision capture share the semantic Tree
lock. The callback queues that captured token, even if delayed across publication.
Do not reintroduce a separate Atomic token in a worker before/after update: both
orders can mislabel an old-snapshot request. Application-side target/revision
checks still apply. `published` acknowledges successful updates; `check` reports
fatal worker errors. Widgets-demo reexports this worker; the Settings popup controller consumes it.
Builder integration remains pending. This does not replace real Orca validation.

`nk-settings::dropdown::show` now supplies the reusable popup controller over
DropdownPopup, configured origin and the application's existing Bridge. The host
lends text/styles/Window and a keep_open hook that stages external notices while
the parent Tree is borrowed. False closes before input/selection acceptance;
apply staged notices after return. `DropdownPopup::invalidate` suppresses stale
trigger focus restoration and rejects subsequent actions/snapshots/choices. An
ordinary dismissal preserves value and restores available focus. Parent snapshots
use `PopupSnapshot::new` so restored and modal tokens share one namespace. Optional
exported panel material resolves at actual size; no recipe forces opaque paint.
This controller does not write Config1; the manifest builder below owns that mapping.
The provider diagnostic is extracted separately; compilation/CPU tests of this
controller do not prove real libatspi, Orca speech or owner live parity.


The separate `dropdown-provider-probe` composes nk-settings::dropdown::show with
its one Bridge and the nk-wayland host in opaque fallback. Its wrapper reuses
widgets-demo/check-headless.sh with private bus/runtime; evidence stays under
target or the owner's task directory. The checker waits for completed input,
a new parent commit and provider publication before its value/focus/identity
assertions. Three faults must fail their own selected-value assertion after
setup, never a timeout. This extraction builds/static-checks the diagnostic;
the checker is NOT EXECUTED here. It does not establish current native/provider,
Config1 builder, Orca speech or performance acceptance. Keep historical fixed
binary evidence attributed to its original source/hash. The exclusive parent
Tree borrow remains bounded to short menus, with no concurrent parent servicing.


The real Dropdown manifest builder is `nk-settings::dropdown_builder::register`:
ui.options value/label pairs and Session::shown drive the same retained component.
Canonical reads/notices never Apply; Selection Changed and accepted popup changes
map back to Cx.apply. Unknown current strings appear as an additional option.
Reconciliation keeps the combo/surviving option IDs, retires obsolete options and
atomically reorders the remaining children through reorder_dropdown_options.
Failed notices are delivered after Changed within the same batch, retaining the
error rather than immediately replacing it with the normal subtitle. Availability
hides all builder rows; writability disables them. Wrong-mount/hidden/unmounted
operations do not write. The builder has no independently asynchronous work.

Renderer Host.modal lends a Modal only for effect/idle; Cx.open_dropdown requires
it and a parent Window. dropdown::Native owns the single application's Bridge,
text backend, panel recipe, revision and staged notices. Editor::poll delegates
to Client::poll in production; any notice closes the modal before choices apply.
The app drains Native.notices into Rendered after return. Its owned external hook
stages portal/routing/visibility changes as well. No second provider or default
replacement widget is created when context is missing: opening returns an error.

Settings Config1 bus tests bind dbus-daemon with an explicit unix:dir under
`toolkit/target/config-bus-<pid>-<counter>`, clean it after daemon termination, and
pass the private connection to Client::start. Client::connect would contact the
live session; neither the session address nor its accessibility bus is changed.


For native Dropdown builder diagnostics, reuse the provider check's registry and
private Cage/Hyalo runtime with NK_DROPDOWN_BUILDER=1 and dropdown-builder-probe.
Its Config1 fixture is a separate real bus service; the probe consumes Client,
Rendered and dropdown::Native. A Settings proxy filters signals by their owner:
emitting SettingChanged from the checker connection does not simulate the portal.
The private portal-fixture.py exposes org.nidara.TestPortal.ChangeScale only to this
isolated test so the actual fixture owner updates ReadAll and emits SettingChanged.
Reset scale before each case to ensure baseline and control both change it.
Private test code is never installed. Preserve failed EGL/context-loss runs;
a missing post-input parent commit is setup failure, not acceptance/control evidence.

The accessibility Bridge keeps one pending (revision, tree), replacing it when
the app outpaces the backend. The worker diffs the last published tree against
the latest pending snapshot; skipped revisions are not published acknowledgments.
An in-flight backend update completes, then the newest snapshot is consumed.
Requests remain bound to the actual published revision. The app never blocks
on a full notification channel, and superseded full trees are released promptly.

FontChooser's metadata catalogue lives in nk-settings::font_catalog. Do not call
Fontconfig while building a page: default Load is idle and start is for opening
the chooser only. It uses one worker and at most one queued enumeration, with no
font file/renderer/provider access. Carry BOTH mount and per-open request tokens;
poll retires a result when either differs, cancel/Drop retires the receiver, and
queued canceled work is skipped. No worker callback may touch the UI or Apply.
Keep Fontconfig's full face index, including named-instance bits. An empty style
name is valid (observed on installed Adwaita variable faces); retain it as unnamed,
never invent Regular. Enumeration/search are metadata only; the chooser below
consumes them for the controlled font builders.


SearchInput is now a real nk-widgets kind backed by one nk-text::Editor. Reuse it
for Settings search and FontChooser filtering; do not build another text buffer or
provider. Its SearchStyle comes from toolkit/tokens/search.json (Settings search
box CSS/TSX, shared selection accent30/text, pill radius from the resolved CSS
--nidara-radius-pill dimension). Name/placeholder are not the editable value.
Canonical set_search_text emits nothing; committed user changes emit Changed once.
SetText/SetSelection validate the current tree target as well as availability.
Applications must first validate the Bridge publication revision; do not pass that
revision as a structural tree generation. During preedit, export the committed
single line and omit display geometry, never index committed text with preedit spans.

Use Composition::event_with_window for native clipboard commands and sync after
layout for surrounding text/caret. A paste result is tied to target/focus/generation;
stale delivery is ignored. IME uses nk-wayland's existing cause tracking and D7
layer cursor association, resets when input identity changes even if text is equal,
and disables context when the last input is removed. Focus loss cancels preedit and
repaints the steady caret; there is no input-owned idle timer. Editor::set_style
preserves history and preedit atomically; Alignment::Left keeps bidi text on the
scrolling canvas's physical left instead of the end of its unbounded measurement.
The new paths still need real native IME/clipboard/AT-SPI/Orca acceptance.


For user-font shaping, reuse nk-text's opt-in system-fonts feature and
ParleyBackend::with_system_fonts, rather than copying the Settings slice's
independent glyph export into each chooser. Its Fontique collection enables system
fonts; ParleyBackend::new remains isolated for the corpus. Actual system-face bytes
are copied once per blob per retained layout and shared across runs/reflows; no
global cache pins every previewed font. The normal export preserves collection
index and normalized variation axis tags. The installed-face byte/lifetime test
requires DejaVu Sans and fails if system resolution is bypassed. This is shaping
acceptance only, not FontChooser UI, native publication, startup or Orca evidence.


FontChooser's family viewport uses Tree::list, a real embedded LIST in the parent
Tree, with MenuOption children and MenuStyle resolved by the existing style map.
It shares dropdown row shaping/paint/check/keyboard code; do not create another
list renderer or use sidebar pages/radios as families. Each embedded list owns its
style, height constraint and scroll; set_list_style/set_list_height preserve IDs.
Canonical set_list_selected emits nothing; user activation emits Changed(list)
only when selection changes. Arrows focus/reveal without committing, and one Tab
stop follows current focus, then selected/first available. Filtering hides rows
without unmounting them; offscreen rows stay semantic children with SHOWING false.
Composition routes vertical wheel input in the viewport, including blank insets,
to that list. Paint, hit testing and semantics intersect the viewport with ancestor
clips. Root-only menu_list retains its popup behavior and same row implementation.
This is a widget primitive reused by the modal consumer below; real FontChooser
AT-SPI/Orca acceptance remains separate.


Settings' font_chooser::choose consumes SearchInput, font_catalog,
embedded LIST and the shared system-font backend in an nk-wayland modal dialog.
It returns Selection { family, points, attributes } and never writes Config1. The existing
SpinButton edits unscaled points; its range and portal text_scale are supplied by
the caller. Initial sizes that the range would clamp are refused. A translated
sample uses Tree::set_label_style and one retained system-font Layout, with size
points * 96/72 * text_scale. Filtering out a family prevents acceptance. The second
embedded LIST selects supported catalogue style attributes; exact face/named-instance
selection remains pending. The controlled font builders below reuse this consumer.
Supply labels,
window/list constraints, actual icon theme preparation and the external-notice hook.
Enumeration starts on this call, with the existing mount/request token and bounded
worker. Errors stay in the loading/status row; Cancel/close returns None. Escape
first cancels the one Editor's preedit via SearchInput before closing the dialog.

DialogTree borrows its parent, allocates the view above the parent's next unused
ID and retires all transient IDs on Drop, even on error. Publish its snapshots
through the ONE existing Bridge: original root/parent IDs remain, their actions
and focus are suspended, and a real DIALOG child holds the modal controls. The
existing provider already maps DIALOG to MODAL; do not add another provider or
modality protocol. PopupSnapshot tokens cover ordinary/modal/restored publications.
Requests require that snapshot and current view generation and cannot target
parent controls. Stage external changes, invalidate/close first, apply after borrow
ends; invalidation suppresses launcher focus restoration. Normal close restores
only an available/showing/focusable launcher. run_dialog_with_options inherits the
parent's connection/app-id and accepts caller size/title; legacy run_dialog uses
the same implementation. Window-local bounds are not a screen/parent-origin claim.
CPU tests and compiled transport are not native FontChooser/IME/Orca acceptance.

Dialog entry clears the borrowed parent's widget focus. A dialog snapshot masks
its view's focus until the real host Focus(true), preserving activation-before-focus
publication rather than announcing an Entry inside an inactive modal. This ordering
is tested in semantic snapshots; real Orca speech remains a separate gate.

The family picker accepts runtime translated labels, including its title. It calls
Window::set_title on Configure before the first frame; do not leak a translation
into a static string to satisfy the older Options title field. No geometry/provider
publication is made before Configure. Dynamic title transport is compiled here;
native title/chooser behavior is still unverified.

TextStyle carries slant, width percentage and explicit design-space axis settings.
Only distinct printable four-byte axis tags and finite values are valid. Parley's
actual normalized coordinates remain the render input. A requested oblique style
may resolve to an upright font plus the engine's synthesis skew: GlyphRun preserves
that degree value and nk-render applies it to each glyph, not the whole line.
Never advertise exact-face selection from a family/style request. Synthetic
emboldening currently returns an export error instead of silently painting upright
regular outlines. Exact catalogue face/named-instance selection remains pending.

Config1 font descriptions now share nk-settings::font_description with Styles.
It parses a single family, standard weight/slant/stretch words, positive point or
absolute px size and explicit axes; canonical output is an unambiguous Pango point
description (1/1024-point precision), not a byte-for-byte copy of Pango to_string.
Unsupported family lists, variants, gravity, color directives and features fail
explicitly; never treat those words as a guessed family or paint a fake regular
preview. Production still shapes only through Parley; an installed-Pango metadata
oracle is test-only and creates no font map.

The real chooser Selection includes these attributes. Its style LIST shares the
same MenuOption machinery as the family list and uses raw catalogue labels. Empty
style labels use the caller's translated unnamed label, not invented Regular.
Unknown style names and named-instance records (high index bits) are disabled
until exact face/axis selection exists. An unrepresented initial style is preserved
with no selected style, no preview and no acceptance; opening must never substitute
the first style silently. An explicit supported style/family change can choose a
new draft. Initial axes survive until such a change. No Config1 Apply in the chooser.

System-font mode must not register a required regular file over an already known
installed family: that hides its other faces. Check the declared families per blob;
if all are installed use the system collection, if none register the private blob.
A blob mixing installed/private families is refused instead of shadowing installed
faces. This retains isolated corpus registration and does not invoke chooser fc-list.
Actual installed Noto Sans Bold bytes/index are checked against Fontconfig separately
from the CPU chooser test's synthetic catalogue. Exact named instances, native/Orca
acceptance and main integration remain pending.

Register nk-settings::font_builder for interfaceFont and monoFont: one factory per
item, fixed Config1 registry keys from PHASE1, row labels/help from the actual
manifest i18n. Session.shown is displayed verbatim (unknown strings included);
parsing only styles a supported launcher caption or prepares an explicit opening.
A real Button retains its row LabelledBy title; set_button_description exposes the
current raw font plus help/error, while set_button_text_style uses the same retained
layout override as Label previews. No new button renderer or visual constants.
Styles retains the actual portal text_scale. Mounted builders refresh caption
styles on scale/line-height changes during idle, never Apply and never repeatedly
invalidate while appearance is unchanged.

Cx.open_font/Modal::font route to dropdown::Native's existing Bridge/revision and
notice queue. Configure its font option with FontsArc, owned translated DialogLabels,
caller window/list/point constraints and actual interface icon-theme preparation.
Title is the item's translated row label, as in the legacy builder. Configuration
has no invented defaults, static translation leak, second provider or startup
catalogue enumeration. The real native implementation requires a parent Window;
only headless decision-fixture tests pass None. stage_modal_notices is shared with
Dropdown: Client.poll notices stage/cancel before input/acceptance, then the app
must drain them and apply routing/appearance/visibility changes after return.
Font Operation combines the mount with a process-wide nonwrapping open counter.

Accepted drafts are canonicalized and compared semantically: same font, cancel and
invalidation write nothing; a changed accepted draft calls Cx.apply once after
fresh availability/writability/hidden/mount guards. The canonical reply wins and
Failed-last preserves its error. Builders do not mutate GTK/dconf or encode font
setting logic. Private-bus tests use real Client/Config1 and the actual exported
fonts group, with a test-only modal decision seam (no Window/provider/chooser is
fabricated). That is data-path acceptance, not native chooser/portal/Orca proof.
Main font Configuration/i18n/constraint preparation and native end-to-end gates
remain pending.

Description changes now have a real semantic diff event and the existing provider
emits PropertyChange/accessible-description, so a focused font launcher's current
value/error can update without renaming the row. Unchanged descriptions emit
nothing, and activation-before-focus ordering is retained. The event unit test and
compiled emitter are not native AT-SPI signal or Orca SPEECH OUTPUT acceptance.

All local split diagnostic extractions remain compile/static-only unless their
own EVIDENCE entry explicitly records a current execution. No native/EGL checker
was executed while extracting cuts23–33. Historical fixed-binary results do not
establish rebuilt-head acceptance. The short-menu parent ownership limit,
hover/active transition and provisional arrow ink, adaptive real polling caller
and causal-test debt remain as documented above.

The font chooser uses Fontconfig for installed family/style metadata only, and
Fontique in Parley for rendering. Bad catalogue records (including bad UTF-8) are
skipped, counted and logged by line; failed enumeration/no usable family remains
an error. Before a native selected family reaches Apply, the same rendering
collection must resolve and load a valid face without fallback substitution.
Catalogue timing/count logs describe each lazy enumeration; there is no second
shaper or silent family fallback acceptance.

Native Settings page replacement uses page::Mounted, never an untracked set of
rows. Build the replacement first, then consume the old mount and commit sidebar
selection. Rendered::build now rolls back newly-created content on any error and
unmounts the failing builder plus every completed builder. Cleanup callbacks run
before nodes are removed; one callback error does not skip the others. Existing
content/chrome survive failed construction. Mounted owns its content roots and
retires them even when unmount reports an error. This lifecycle does not supply a
Window/provider or bypass Config1; full Appearance still requires every named
builder, with missing builders remaining explicit construction errors.


Use Tree::image for decoded pictures: one retained IMAGE, accessible name separate
from pixels, explicit logical size/ImageStyle, no file loading in paint/layout.
ImageStyle supplies Contain/Cover, background, border and radius; the application
resolves those from the exported specification. nk-render::Raster validates RGBA8
and retains one premultiplied raster; Canvas paints it with the existing CPU engine.
set_image preserves IDs and avoids repaint for the same Arc. Removal releases the
raster. Builders own decode jobs/loading/error names and reject obsolete results.
This primitive is not wallpaper loading, thumbnail selection or native/Orca proof.


Wallpaper jobs use image_load::Load, not file IO in a widget or painter. Start
only for visible work with mount/request identity and explicit target/budgets.
One worker has four queued slots; Busy is retryable. Cancel hidden/unmounted or
replaced work; wrong-token poll retires even an already-completed result. Canceled
queued jobs never decode. Output stores only target-size Raster pixels, with Exif
orientation applied before Contain/Cover. Five codecs match Config1 formats; AVIF
uses system dav1d (libdav1d-dev in the existing Ubuntu toolkit job; Arch's ffmpeg
already depends on dav1d). GIF is static first-frame here. Byte budgets reject
oversized input/output but are not a hard process/codec-internal memory bound;
full PSS/startup validation is still pending. ICC/HDR colour management is not
claimed by this loader and needs explicit validation before wallpaper parity.


Thumbnail galleries use Tree::thumbnail_strip, a horizontal layout of the existing
Choice radio model. ThumbnailStyle is explicit; pictures reuse Image/Raster, not
a second painter. Canonical selection can be None for an unknown file. Existing
Choice keyboard/activation and one Tab stop apply; focused options reveal in the
strip's own scroll viewport, and wheel input over it scrolls horizontally without
moving the page. Paint/hit/SHOWING share the ancestor-clipped viewport. Offscreen
options remain RadioButton children. Style/reflow clamp scroll while preserving
IDs/selection; removal drops pixels. Decode/visibility scheduling and Config1
mapping belong to builders, and geometry/visual/native acceptance stays separate.

reorder_thumbnails accepts an exact permutation only, preserving IDs/pixels and
selection while invalidating layout and old action targets. Invalid input is atomic.

Native wallpaper decorations are wallpaper::register(Builders, Budget). They consume
wallpaper.current and its catalogue from Config1; no UI-thread directory discovery
or second catalogue is introduced. Only wallpaperPreview/wallpaperGallery register
here; wallpaperPicker still requires its real parented portal path. Surviving
catalogue options keep IDs/order, exact paths define canonical selection, unknown
paths select none, and changed guarded activation uses Cx.apply. Preview follows
Session::shown during idle too, so a request from another builder replaces pixels
before its asynchronous reply. Failed notices restore canonical state and keep
visible error text; image decode errors never write settings.

Loading starts only after layout says an image is showing. Hidden/offscreen,
unavailable, replaced and unmounted requests are canceled through image_load.
Host supplies byte budgets. Wallpaper component exports carry the current legacy
picture dimensions, borders, colours and radius references for every portal mode;
missing values are errors. CSS border transition150ms and ICC/HDR accuracy remain
explicit debts; this is not whole-window/native wallpaper parity.

Builder::row_visible adds content visibility to renderer-owned availability,
predicates and disclosures; it cannot override them. Renderer refreshes after idle
so asynchronous errors/empty content do not leave blank visible rows. A newly
built builder starts shown (the renderer's initial state); shown(false) is sent
when its renderer predicates hide it. Do not wait for an initial shown(true) call
to begin eligible work. Private test buses use an explicit short target/cb-*/bus
socket; dbus-daemon's generated socket name can exceed Unix's limit in long worktrees.

nk-wayland Window::portal_parent is the lazy xdg-foreign-v2 path for portal dialogs.
Unsupported alone permits an empty parent string. Pending must wait without blocking
or unparented fallback; Ready borrows the received opaque wayland: identifier. It
exports only a configured real xdg_toplevel, once per Window, handles the event on
that Window's existing queue, and destroys the export before role/surface cleanup.
Empty protocol handles are explicit errors. This API's unit capability/state checks
are not a native parenting/portal acceptance run; actual file chooser integration
and native verification remain separate. No compositor/backend change is required
for D5's no-exporter fallback.

The file_chooser transport borrows Editor's existing connection and runs one
cancelable portal worker per process. It pins the unique portal owner, subscribes
to bounded Response traffic before OpenFile, filters by the actual returned path
(including older paths), and checks owner continuity before accepting it. Initial
protocol calls are bounded; user dialog duration is not. Cancel/Drop/retirement
requests Close on the captured owner/request; failure is best-effort cleanup,
not a native closed-dialog guarantee. Random handle_token bytes avoid other
libraries' requests. Multiple/remote/malformed file URIs are errors. Success returns
one local absolute UTF-8 PathBuf; it never Applies or decodes. Mounted picker/main
must still enforce availability/write/visibility/baseline guards and restore focus/
parent accessibility. Its private-bus fixture is a synthetic portal and parent
identifier, not native chooser/Wayland parenting proof. No blocking signal-forwarder
thread is left behind; async streams and worker retire together.

wallpaper_picker::register supplies the wallpaperPicker custom builder. It uses
wallpaper.current, the existing Button/description/subtitle, ready real Window
portal_parent and the Editor's same trusted connection. Epoch/value/mount and
process-wide per-open tokens guard completion; no dialog fabricated when Window
is absent. Repeated activation while pending is ignored; parent Pending waits,
Unsupported alone allows empty parent. Cancel/same/invalidation do not Apply;
accepted changed path calls Cx.apply once, with canonical refusal/error retained.
Hidden/unmounted/schema/key/owner changes cancel without restoring launcher focus;
normal completion may restore it if still eligible. HOME is suggested with the
portal's filesystem-byte current_folder terminated by NUL; no environment mutation.

For asynchronous completion, Rendered::idle now polls the real Editor FIRST and
applies these notices before any builder idle callback. It returns Vec<Notice>;
the app must process them for dependencies outside its rows, not discard them.
This is also how a queued Config1 change retires a completed file choice before
acceptance. The app must stage external portal/routing/visibility first.
Builder/Rendered::external_modal_active tells the host to suppress parent
accessibility actions and publish parent inactivity during an external chooser.
No growing staging queue or extra provider. The local nk-settings executable now
consumes this flag and these returned notices (application.rs); actual native
execution/parent modality is still pending. CPU/private-bus proofs do not establish it.
Full exported Appearance now mounts/layouts with the real five registration modules
(including separate wallpaper preview/gallery and picker), no substitute builders;
that CPU check neither opens a native window nor validates all wallpaper pixels.
Existing native Button is reused; exact secondary/pill appearance remains visual debt.

Settings wallpaper JPEG thumbnails select IDCT reduction before allocating the
RGB pixels (`image_load::jpeg_thumbnail`). Preserve the source/encoded budgets
and EXIF-aware Cover/Contain sizing when changing it; other codecs still use
bounded full decode. The ignored `real_wallpaper_decode_timing` test accepts an
absolute `NK_THUMB_BENCH` JPEG path for local timing, never as a CI speed threshold.

The local nk-settings executable assembles Shell, Mounted, the five real builder
registrations, Client, Portal, Router in Native mode, and one shared Bridge/Native
context. All use the same bus connection. There is no installed launcher or ENTRY
takeover. No snapshot fixture is a production fallback. Loading/error rows precede
the authoritative Snapshot; CONTENT_READY is emitted only by a successful root
commit after the page is mounted and the Client available. The provider/layers
are not created before a real Configure. This milestone is not presentation time.

Stage portal and native queued routes before input/idle acceptance; consume both
Native.notices and Rendered::idle's returned notices. New Ready snapshots rebuild
Mounted roots transactionally so previously unavailable generic rows can appear.
Ordinary Changed updates retain IDs. Portal/native-route invalidation retires an
external picker before accepting its reply. Its pending flag masks parent semantic
actions/focus and physical input. A queued request requires current publication
revision AND current Tree generation. Bridge acknowledgements are drained.

Icon theme comes from canonical Config1 appearance.interfaceIconTheme; portal
values alone pick paint. Material recipes are rebuilt on appearance changes,
not every idle. The owned font configuration uses actual translated labels,
System-font Parley, the same Bridge, current interface icons and exported form
geometry. Its precision/range/layout remain local caller policy, not GTK parity.
Image budgets are 64/256 MiB input/output policies, not hard decoder memory limits.
NK_ICON_REFERENCE selects a development reference directory; installed reference
and existing icon search paths are used otherwise. All new labels are translated
in the twelve locales and both real exporters must be regenerated.

This first executable still polls at16ms, uses provisional loose controls/panel
titlebar and opens at the exported WINDOW_LAYOUT minHeight (not GTK's760 default).
No adaptive scheduling or final chrome acceptance is claimed. Nested font/popup
hosting still suspends parent servicing. Tokenized Raise now uses the standard
activation consumer below; missing tokens/protocol remain explicit and focus is
not guaranteed. queryUI still refuses until agent-view policy/serialization is integrated.
Undrawn sidebar requests forward to ENTRY on a worker without changing native
selection; those directly forwarded Router calls do not currently enter the
nested-modal staging queue. Search/sidebar results, this forwarding/modal edge,
real Window/dialog/provider/Orca and installed performance/live gates remain owed.

Standard activation consumption lives in nk-wayland Window::activate(String): one
optional xdg_activation_v1 proxy on the existing queue sends the caller's opaque
token to this root surface. Requested means sent, never compositor acknowledgement
or focus proof. Unsupported remains explicit; malformed tokens, non-toplevels and
requests before a configured painted buffer are errors. No token creation, fake
input serials, alternate host, repaint-as-raise or environment access. Proxy is
destroyed with Window. Caller owns real initiating-token handoff/retirement.


Native Request(as) can carry trailing --xdg-activation-token plus an opaque token;
routing::with_activation attaches it. Existing verb/positional arguments remain
unchanged; Incoming.activation belongs only to queued native requests. Metadata
is validated without echoing tokens. Forwarded legacy requests retain the old
argument shape; tokenized legacy activation is not implemented by this addition.
The binary consumes/removes XDG_ACTIVATION_TOKEN at its single-threaded main entry
before creating a bus, library worker or font job, then either hands it to the
already-running Native owner or holds it for the first painted root. Never move
that process-env mutation into a library callback or a threaded test. Launch
metadata and subsequent Incoming tokens are taken once, not logged or minted.
Window::activate is called after the buffer and replies only request submitted,
unsupported or error. Bare open cannot promise raise without an initiator token.
Native queued routes invalidate modals before the request; compositor focus,
environment retirement and actual startup/modal timing still need native proof.

NK_SETTINGS_OPAQUE_PREVIEW=1 is a local diagnostic opt-in on the same nk-settings
binary. Options.material=false uses nk-wayland's existing material/layer mask;
root paint uses the existing opaque D5 fallback and App sends no background
protocol declaration. No setting writes, new host, synthetic schema or compositor
manager is introduced by opening this mode. Native visual inspection of it does
not accept the normal D7/material path. Never enable HYALO_A11Y_MANAGER on a nested
compositor connected to the live session bus: it can replace that session's manager
name, and quitting the nested instance does not restore the original ownership.

Native Tree activation staging is idempotent. Apps may stage their current physical
focus state before ordinary input, but Tree::set_active must add no invalidation
when it is unchanged. Otherwise every pointer sample forces whole-tree semantic
publication and can delay servicing subsequent Wayland input/configures. A real
activation transition still invalidates root semantics and search caret paint;
no-op staging preserves any prior unpublished invalidation. This does not solve
the separate fixed16ms polling debt or establish responsiveness/native acceptance.

Availability setters also check an unchanged hidden/disabled value BEFORE collecting
focus order. Renderer refresh repeats these setters for the page's rows during
input staging; collecting the full tree for each unchanged row makes staging
quadratic. Real transitions still capture the old order before mutation and use
that order for focus repair; an unknown id still returns an error.
The new Settings search and font-search real-IME rows live in
`nk-settings-ime-check.py` and `toolkit/settings/IME.md`. The `ime-gates` feature
and binary are opt-in: CI builds/runs them only with the existing
schedule/workflow_dispatch flag `HYALO_ANIMATION_CHECKS`, never for a PR. Reuse
`nk-real-common.start_ime` for profile/theme isolation. Hangul may commit then
forward Escape: preserve SearchInput's one-shot finished-composition boundary
and FontChooser's matching close guard; otherwise one Escape also erases/closes.


### Editable search suggestions (#915)

`nk_widgets::suggestions::Suggestions` attaches to an existing SearchInput before
its first semantic publication. That field remains an editable ComboBox throughout
its lifetime; one ListBox and bounded option slots live under it in the same tree.
MenuList supplies layout, pointer handling, scrolling and keyboard highlight.
SearchInput retains the editor, clipboard and IME. Up/Down choose an active option,
Enter activates it, Escape dismisses without clearing committed text. Preedit and
the finished-composition Escape boundary have priority. Programmatic page navigation
must dismiss the model. Identical idle samples must not republish semantics.

The list uses `nk-wayland::Window::open_popup_overlay`, an xdg popup on the existing
parent queue (same positioner rules as Dropdown), without a nested modal loop or a
keyboard grab. Parent input/IME, Config1 notices, frame callbacks and buffer releases
continue while open. Popup IDs reject stale events; fractional scale and configured
geometry belong to that popup. Reposition tracks the actual header anchor. Suggestions cap their width to the parent and shift left at its right edge. Its option
bounds use acknowledged popup coordinates even outside the parent window's rectangle.
The editable field keeps focus; AT-SPI receives expanded, ListBox Selection and
ActiveDescendantChanged with actual option references. Do not substitute an attribute
string or focused=true on a second node for the active descendant.

`settings::search` folds case and strips only U+0300–U+036F after NFD decomposition on queries and labels; script-specific marks such as Japanese dakuten remain significant. Icon-theme dependencies are refreshed on both content and results pages. It supplies localized pages, available Config1 rows and manifest
custom/disclosure labels. Eight suggestions plus View all (N) are bounded independently
of the full match set. The ordinary results page uses existing rows and explicit page
routing; typing never replaces its current content. Builder-owned runtime objects
without registry/manifest labels are not indexed yet. Both new labels are translated in
all twelve catalogs with their ledger. No workflow step or PR gate was added.

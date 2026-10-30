# Shell surfaces in nk-wayland (T1)

**Status: DESIGN for review, 2026-10-30.** This is step T1 of
[`session/design/APPLICATIONS1-DOCK.md`](../session/design/APPLICATIONS1-DOCK.md) §9–§10
(contract closed by the owner, relayed in Palomar #959 #688). T1 adds only the transport
primitives the Rust dock (D1/D2) consumes. It adds no dock, no shell process, no policy and
no new CI job. T2 (drag and drop) is a separate step.

## What exists, what is missing

`nk_wayland::run` hosts exactly one root surface per connection: an `xdg_toplevel` (or an
`xdg_popup` for the modal `run_popup`). Same-queue nonmodal popups (`popup_overlay`, the
bounded action menus from #971) take that root's `xdg_surface` as parent. Activation tokens
are only *consumed* (`activation.rs`). No `zwlr_layer_shell_v1` and no capture client exist.

Hyalo already serves what T1 needs: `WlrLayerShellState`, `xdg_activation_v1` (a token is
honoured when its serial came after the maker got keyboard **or pointer** focus, which is
exactly the dock's case: layer surfaces never take the keyboard on a click),
`ext_foreign_toplevel_list_v1` with the hex window ID as identifier, and
`ext_image_copy_capture_v1` over `ext_image_capture_source_v1`. T1 changes no Hyalo code; §2 names one Hyalo fix that waits for the owner.

## 1. Layer root

`Options` gains `role: Role`, defaulting to `Role::Toplevel` (every existing caller keeps
its behaviour unchanged).

```rust
pub enum Role { Toplevel, Layer(LayerSpec) }
pub struct LayerSpec {
    pub namespace: &'static str,          // fixed at creation (protocol)
    pub output: Option<OutputId>,         // fixed at creation (protocol); None = compositor's choice
    pub layer: LayerLevel,                // Background | Bottom | Top | Overlay
    pub placement: LayerPlacement,        // everything below may change on the SAME surface
}
pub struct LayerPlacement {
    pub anchor: Edges,                    // bitflags TOP|BOTTOM|LEFT|RIGHT
    pub size: (u32, u32),                 // 0 on an axis anchored to both sides = stretch
    pub exclusive_zone: i32,
    pub margin: [i32; 4],                 // top, right, bottom, left
    pub keyboard: KeyboardMode,           // None | OnDemand | Exclusive
}
```

- `Window::set_layer_placement(LayerPlacement)` sends set_anchor/set_size/
  set_exclusive_zone/set_margin/set_keyboard_interactivity and commits **the same
  `wl_surface`**. The app keeps painting the previous frame until the matching configure;
  the new size arrives as `Event::Configure`. This is what makes contract row 25 true:
  bottom↔left↔right is one reconfiguration, never destroy-and-recreate.
- `Window::set_input_region(Option<&[[i32; 4]]>)`: logical rectangles, `None` = whole
  surface. The dock uses it for its resting/magnified shape; input and paint use the same
  model (contract §8).
- `Window::set_layer_level(LayerLevel)` uses `set_layer` (v2+); older servers report
  Unsupported rather than recreating the surface.
- `zwlr_layer_surface_v1.closed` (output removed, compositor decision) becomes
  `Event::Closed`; the run loop ends cleanly after the app sees it. Output identity is
  fixed by the protocol, so a dock per output is one surface per output and hotplug creates
  a new one (contract §8: no reuse of stale handles).
- Required globals for a layer root: `zwlr_layer_shell_v1` v3+ instead of `xdg_wm_base`
  for the root (xdg_wm_base still required for its popups). Missing → `run` refuses with a
  clear message, like `require_material`.
- Material: `nidara-material-v1` attaches to any `wl_surface`; Hyalo paints the dock's
  glass exactly as it does for toplevels (the app never imitates it).
- Scale, fractional scale, presentation feedback, nidara-layers content layers and
  pointer/keyboard handling are the existing root code, unchanged.

## 2. Several outputs: one connection per surface

The dock needs one surface per output, and outputs come and go. The Window host is one
connection, one queue, one root. T1 keeps that model and runs **one `run_layer` per
output, on its own thread and its own connection**, with:

- `nk_wayland::outputs(timeout) -> Result<OutputWatch>`: a small connection that binds
  `wl_output` v4 (name, description, scale, logical geometry via `xdg_output` when present)
  and reports `OutputEvent::{Added, Changed, Removed, Lost}` keyed by `OutputId`.
- **The registry number is not identity.** Hyalo's server backend (wayland-backend's Rust
  implementation, no `server_system`) gives a new global the first free slot, so an
  output removed and plugged back in can return with the SAME number (Codex found the
  ABA in #704; the number-only fix was wrong, #712). Nothing in the protocol tells two
  instances apart except the `wl_output` object a client bound.
- `OutputId` = number + a generation never repeated in this process (across watches
  too): a re-added output never compares equal to the one it replaces, so a late stop
  or `Removed` for the old one cannot be taken for the new one. Its fields are private:
  an `OutputId` cannot be made up.
- `watch.bind_output(id, timeout) -> Result<LayerOutput, BindFailure>`, on the
  watcher's thread (Codex's handshake, #713/#719):
  1. a new connection for the dock binds global N and syncs (syncA: the bind was
     processed);
  2. only then the watcher syncs (syncB): every removal that happened before the bind
     is now in the watcher's events, which stay queued for `next`;
  3. if the SAME generation is still present, the bound object is that instance;
     otherwise `Gone`.
  One deadline covers the connect and both syncs (`Timeout`, never a hang). The
  connect is our own nonblocking one, retried while the compositor's backlog is full:
  `UnixStream::connect` blocks there (Codex, #722). `outputs(timeout)` uses the same.
  The dock connection has no event queue during the check: its registry, output and
  sync callback have handlers that keep only what the check needs, so no orphaned
  queue fills while the dock lives. The dock releases its `wl_output` once the layer
  surface exists. A failed watcher connection
  is `Lost`, and `next` still reports `Lost` once. Every failure closes the dock
  connection; nothing partial is returned.
- `LayerOutput` is neither `Clone` nor `Copy`: one binding opens one root. It moves into
  `LayerSpec.output` and `run_layer` runs alone on that connection, so input, IME and
  cleanup are those of any root. When the dock ends, its connection closes and the
  compositor frees everything.
- A removal AFTER the check: the dock's object stays the old instance. The surface must
  then close, not move. **Hyalo today moves it** (`shell/layer.rs`: an explicit output
  that no longer resolves falls back to the output under the pointer). A one-line Hyalo
  fix (close instead) is a separate commit, outside T1's "toolkit only" scope, and waits
  for the owner's decision. Until then, the guarantee holds up to that window. Surfaces
  that exist when an output is removed are already closed (`backend/tty.rs`).
- `wake_channel() -> (Waker, WakeSource)`: `run_layer(app, options, spec, Some(source),
  start)`; `Waker::wake()` (Clone + Send, never blocks, coalesces) reaches the app as
  `Event::Wake`, and the app reads its own channel (stop; D1's daemon data). Put the
  message in the channel before waking. It is a nonblocking pipe in the loop's poll, so
  a quiet dock does not poll. Waking an ended loop fails.
- The shell's lifecycle (D1, stated here because T1's primitives exist for it): on
  `Removed(id)` wake that dock with stop and **join its thread before** starting the
  dock for any later `Added`; key every message by `OutputId`, never by number. On
  `Lost`, end every dock and start over from a fresh watch.
- Tests, against an in-process server on Hyalo's backend (`outputs.rs`):
  - complete initial outputs;
  - same-name re-add: same number, different `OutputId`;
  - remove and re-add between syncA and syncB → `Gone`, with the events still
    delivered and the new instance binding (the server's instance 2);
  - a removed id → `Gone`;
  - a frozen compositor → `Timeout` within the deadline, then normal service;
  - the watcher dying during a bind → `Lost`, reported once;
  - 100 bind/drop cycles → 100 client disconnects on the server;
  - (`connect.rs`) a listener whose backlog is full and that never accepts → error at
    the deadline (a blocking connect hangs that test); no listener → error at once;
  - ordinary hotplug and watcher loss.

  `wake.rs`: coalescing, a wake during the app's read not lost, waking an ended loop.
  Nested Hyalo (`output-check.py`): a dock on its own connection with the checked
  instance, ended by its Waker and joined. Nested Hyalo cannot remove its only output
  ("cannot disable the last output"), so removal is not shown there.

Why not one multi-surface `Window`, or several roots on one connection: both would
touch every per-surface field of the host and route one client's keyboard to several
roots (Codex, #715), for no user-visible gain. Separate connections from the same
process share the same kernel identity, so #973's access policy is unaffected. This is
reversible later without changing the dock's API, because the dock only sees
`run_layer(app, options, spec, wake, start)` per output.

## 3. Popups whose parent is a layer surface

`popup_overlay`'s root parent becomes "the root's `xdg_surface`, or for a layer root an
`xdg_popup` created with a null parent and attached with `zwlr_layer_surface_v1.get_popup`".
Child menu levels keep their current xdg parent chain. Positioner constraint adjustment,
the #971 bounding to usable output area, grabs, dismissal order and input consumption are
unchanged code. No nested event loop is added for the dock (contract §8): `run_popup`
stays toplevel-only and refuses a layer parent explicitly.

## 4. Activation token producer

```rust
window.request_activation_token(serial: u32, app_id: Option<&str>) -> TokenRequest
// later: Event::ActivationToken { request: TokenRequest, token: String }
//    or  Event::ActivationTokenFailed { request, reason }
```

- `serial` must be one the window actually received (`Event::Button`/`Event::Key`
  carry it). The host refuses a serial it never delivered; there is no API to make one up,
  and no "latest serial" shortcut that could pick up an unrelated event.
- Sets seat, the root surface and the serial; `app_id` is the target's DesktopId without
  `.desktop` (a hint for future correlation, H1). Commits, waits for `done`.
- The token is opaque and private: never logged, never in `Debug` output.
- Bounds: at most 4 requests pending per window (more fail `Busy` at once) and a 2 s
  deadline each (Hyalo answers in one roundtrip; a token older than its 10 s life is
  useless anyway). Every request ends in **exactly one** terminal event: token, deadline,
  surface closed or explicit cancel; the xdg_activation_token_v1 object is destroyed at
  that moment, and a `done` arriving later for a finished request is dropped, never
  published. The deadline is an active timer only while a request is pending; no idle
  polling.
- Hyalo decides validity (provenance + 10 s); a token is not a promise of focus. The
  dock passes it to Applications1 Launch untouched (contract §4).

## 5. Per-window capture client

```rust
window.capture_window(identifier: &str, max: (u32, u32)) -> Result<CaptureId, CaptureFailure>
// later: Event::Capture { id, result: Result<Image, CaptureFailure> }
window.cancel_capture(id)
```

`Unsupported`, `NotFound` and `Busy` are answered at once, before any object exists; every
accepted capture then ends in exactly one `Event::Capture`. Only layer roots bind the
window list and the capture managers: an app's window never sees the compositor's windows.

- Binds `ext_foreign_toplevel_list_v1` and keeps the live handle set (identifier, app_id,
  title). An identifier that is not in the list fails `NotFound` without a request.
- Source from `ext_foreign_toplevel_image_capture_source_manager_v1`, one
  `ext_image_copy_capture_session_v1` per request, one frame, then destroyed. shm only in
  T1 (argb8888/xrgb8888 from the session's advertised formats); dmabuf later if measured
  necessary.
- Two separate limits (review #705). The **source buffer** is whatever size Hyalo
  announces (the window's full physical size; the protocol requires exactly that): T1
  accepts up to 8192 px a side and 64 MiB (a 5120×2880 physical window is 56.25 MiB);
  memory is stride×height, with stride ≥ width×4 checked and overflow-checked arithmetic,
  and it fails `TooLarge` above that. Required test: exactly at and just over the limit.
  The **returned image** is RGBA8 straight alpha, downscaled in the client to fit `max`
  (aspect kept), at most 1024 px a side. The shm transport buffer is freed as soon as the
  image is made; the dock's thumbnail cache (contract: 32 MiB) is a separate budget.
- Pixel formats: argb8888 is premultiplied and is un-premultiplied to straight alpha;
  xrgb8888 gets alpha 255. Required tests: both, with non-opaque, non-gray pixels.
- At most 8 captures in flight per window (more fail `Busy`), each with a 2 s deadline.
  Per window is per output in the dock, so the global limit of the contract (8, and the
  transport memory) is enforced by D2's scheduler across its outputs; T1 does not claim it.
  The refresh policy (static minimized thumbnail, ≤5 Hz chooser) belongs to the dock.
- Exactly one terminal event per `CaptureId`: ready, failure, deadline, cancel or window
  closed. The frame, session and shm buffer are destroyed at that moment; a late `ready`
  for a finished capture is dropped, never published as pixels.
- Failure reasons map the protocol's: `Stopped` (window gone), `BufferConstraints`,
  `Unknown`, plus `NotFound`, `Busy`, `TooLarge`, `Unsupported` (globals absent). A
  failed capture never returns stale pixels.
- Lock: Hyalo stops sessions under ext-session-lock; the dock still zeroes its own cache
  on lock (contract §8). Captures remain outside the socket ACL per the owner's decision.

## Evidence for T1 (contract §10)

All against a private Hyalo (headless cage / nested `rust-session.sh`), never the owner's
session, and recorded under `target/`:

1. `layer-probe` example: a dock-shaped layer surface on each of bottom/left/right in
   turn; the `wl_surface` protocol id and Hyalo's layer id are identical across all three,
   the exclusive zone moves with it (window workarea readback), input region honoured
   (pointer probe outside the region reaches the window below). At scales 1, 1.25 and 2.
2. Output identity: the unit tests and the nested check listed in §2. Not shown live:
   `Closed` on real output removal, and Hyalo's close for a removed output named at
   creation (nested Hyalo keeps its only output).
3. A bounded action menu opened from the layer surface: parented, positioned inside the
   usable area near each edge, dismissed by an outside click without the click reaching
   the dock.
4. Token round trip: token made from a real pointer click on the layer surface, consumed
   by a probe toplevel that Hyalo then focuses; a token made from a refused serial is
   refused (`ActivationTokenFailed` for an undelivered serial; Hyalo refusal for a stale one).
5. Capture, nested (`capture-check.py`, 5/5 runs): a 640×360 window (nested output is
   1272×688) captured to `max` 64×64 gives 64×36. Its translucent orange half reads back
   (199, 100, 50, 128), and its opaque green half (10, 200, 30, 255). Nine at once gives
   exactly one `Busy` and eight answers; the cancelled one ends `Cancelled` and the rest
   are images. An unknown id gives `NotFound`, and so does the window after it closed.
   Unit tests (`capture.rs`):
   - lifecycle: ninth `Busy` before any object exists; cancel then a late ready; a ready
     past its deadline and a second expire end once, never as pixels; `Closed` before a
     ready in the same batch;
   - limits: 4096×4096 (exactly 64 MiB) accepted; 4096×4097, 8193 a side and u32::MAX
     refused `TooLarge`;
   - pixels: premultiplied argb to straight alpha, xrgb opaque whatever its fourth byte,
     and premultiplied averaging when downscaling, so transparency does not darken;
   - `fit` (aspect, never enlarged, 1024 cap), and `Image`'s Debug prints no pixels.
   The drivers wait for nested Xwayland to be ready: it stalls software Hyalo for
   several seconds, which a 2 s deadline would otherwise measure.
6. Existing toolkit tests and every existing `run` caller unchanged (`Role::Toplevel`).

Not claimed by T1: the dock itself, drag and drop (T2), launch correlation and attention
(H1), real monitor hotplug or physical input.

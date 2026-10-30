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
`ext_image_copy_capture_v1` over `ext_image_capture_source_v1`. T1 changes no Hyalo code.

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
connection, one queue, one root. T1 keeps that model and runs **one `run` per output on
its own thread**, with:

- `nk_wayland::outputs() -> Result<OutputWatch>`: a small connection that binds
  `wl_output` v4 (name, description, scale, logical geometry via `xdg_output` when present)
  and reports `OutputEvent::{Added, Changed, Removed}` with a stable `OutputId` (protocol
  name + connection-local generation, never reused). The shell starts a dock thread on
  Added and lets Closed end it.
- `LayerSpec.output` names the output by its `wl_output.name` string, resolved on the
  dock's own connection at bind time; an output that vanished in between gives
  `Event::Closed` immediately.

Why not one multi-surface `Window`: it would touch every per-surface field of the host
(buffers, scale, input routing, IME, popups) for no user-visible gain. Separate
connections from the same process share the same kernel identity, so #973's access
policy is unaffected. This is reversible later without changing the dock's API, because
the dock only sees `run(app, options)` per output.

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
- The token is opaque and private: never logged, never in `Debug` output. The surface
  closing cancels outstanding requests with `ActivationTokenFailed`.
- Hyalo decides validity (provenance + 10 s); a token is not a promise of focus. The
  dock passes it to Applications1 Launch untouched (contract §4).

## 5. Per-window capture client

```rust
window.capture_window(identifier: &str, max: (u32, u32)) -> CaptureId
// later: Event::Capture { id, result: Result<Image, CaptureFailure> }
window.cancel_capture(id)
```

- Binds `ext_foreign_toplevel_list_v1` and keeps the live handle set (identifier, app_id,
  title). An identifier that is not in the list fails `NotFound` without a request.
- Source from `ext_foreign_toplevel_image_capture_source_manager_v1`, one
  `ext_image_copy_capture_session_v1` per request, one frame, then destroyed. shm only in
  T1 (argb8888/xrgb8888 from the session's advertised formats); dmabuf later if measured
  necessary.
- `Image` is RGBA8 straight alpha, downscaled to fit `max` (aspect kept) **in the
  client**, with physical size capped at 1024 and buffer at 16 MiB. Larger source
  constraints fail `TooLarge` rather than allocating.
- At most 8 captures in flight per window; more fail `Busy` (contract §8: bounded). The
  refresh policy (static minimized thumbnail, ≤5 Hz chooser) belongs to the dock, not here.
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
2. Output removal on the nested session ends that surface with `Closed`; a new output
   gives a new surface with a new `OutputId`.
3. A bounded action menu opened from the layer surface: parented, positioned inside the
   usable area near each edge, dismissed by an outside click without the click reaching
   the dock.
4. Token round trip: token made from a real pointer click on the layer surface, consumed
   by a probe toplevel that Hyalo then focuses; a token made from a refused serial is
   refused (`ActivationTokenFailed` for an undelivered serial; Hyalo refusal for a stale one).
5. Capture: a probe window captured to the expected size and a known colour; capture of
   a closed window fails `Stopped`/`NotFound`; nine concurrent requests → one `Busy`.
6. Existing toolkit tests and every existing `run` caller unchanged (`Role::Toplevel`).

Not claimed by T1: the dock itself, drag and drop (T2), launch correlation and attention
(H1), real monitor hotplug or physical input.

# nk-wayland: phase-0 transport

`Window` owns the Wayland connection, synchronized layers, released-slot shm
buffers, input, text-input-v3 and Nidara's protocols. Logical coordinates enter
and leave this API. `Frame.pixel_width/pixel_height` are the physical allocation
at the current fractional output scale. The app supplies all paint, material and
motion parameters; this crate has no visual or animation defaults.

## Layers

Check `window.supports_layers()`, then create a layer in `Configure` (or after it):

```rust,ignore
let a = window.create_layer((80, 60))?;
window.set_position(a, 20., 40.)?;
window.paint_layer(a, |frame| render_button(frame))?;
// The event loop paints the parent and commits its dirty children with it.
```

Only independently moving content needs a layer. Each `LayerId` names a direct,
synchronized `wl_subsurface` of this window. IDs are never reused and another
window's ID is rejected. The 65th live layer is refused before any protocol
request; destroying one frees its slot. Destroyed IDs are rejected, and events
already queued for destroyed protocol objects are ignored.

A layer has its own released-slot double buffer, following the parent's buffer
rules. `paint_layer` invokes the painter only when explicitly called; transforms
never repaint. It returns `false` without invoking it when both buffers are
busy. Keep the content dirty and retry from `Application::idle` after dispatching
releases. `set_layer_size` changes the next paint's logical size; old busy slots
survive until released. Repaint after `Configure` when the output scale changes.
A successful paint stages the buffer, viewport and damage for the next commit.
Repeated paints before that commit reuse the pending slot. It becomes busy only
when committed: an attachment superseded before its first commit gets no release.

```rust,ignore
window.set_transition(a, Property::Position, 7, Curve::Bezier {
    x1: 0., y1: 0., x2: 1., y2: 1., duration_ms: 2000,
})?;
window.set_position(a, 300., 40.)?;
window.commit()?; // sends child commits, ONE parent commit, then flushes
// The app can now block. Hyalo keeps moving a; no frame callback is needed.
```

`set_transition` arms only the next change of the specified property. The app
chooses serials and every spring/Bézier parameter. `set_position`, `set_scale`
(uniform, about a layer-local anchor) and `set_opacity` set model values; Hyalo
owns the presented transform, including retargeting and a spring's velocity.
Invalid/non-finite/unrepresentable fixed values are rejected before requests.
`set_layer_material` stages app-supplied shapes/material on the same child; its
own glass is reserved for phase 2 by the contract.

When parent pixels also change, call `redraw()` and let the event loop finish:
its paint stages all dirty children just before committing the new parent
buffer. An explicit `commit()` refuses a dirty parent so it cannot accidentally
publish children with old parent pixels. If only layers changed, the event loop
commits those without repainting the parent. All child buffers, material and
transform requests land together with that parent commit.

`Event::Layer { id, event }` carries pointer motion, scrolling, button presses
and releases, leave, transition completion and cancellation. Pointer/button
coordinates are **layer local**, already inverse-transformed by Hyalo; the app
does no animation-aware hit-testing. Parent input keeps the existing `Event`
variants. `LayerEvent::Done` preserves the serial and full presentation timestamp
(seconds + nanoseconds). `Cancelled` preserves its serial; the XML gives that
event no timestamp. No event is synthesized from a client timer.

`control_commit_children_only` is an explicit fault-injection entry point for
the phase-0 check, deliberately leaving the parent uncommitted. Applications use
`commit()` or `redraw()`.

See `phase0/README.md` for test 5's blocked-client, retarget and negative controls.

## Text input inside a layer

`set_layer_text_input(id, input)` takes the same `TextInput` payload as the
root field, with `rect` in that layer's local logical coordinates. Keyboard and
text-input-v3 focus remain on the root, and surrounding text/password handling
are unchanged. The local rectangle goes only to the explicit layers-protocol
association; it is never sent as a root-local standard cursor rectangle.

The association is staged with the next parent commit. Hyalo updates both the
IME popup position and its `text_input_rectangle` event using the layer's
presented position and anchored scale every frame, including while the client
is blocked. `set_text_input` clears it when a root field takes focus. Destroying
the focused layer clears the association and disables its text input. The
server also invalidates destroyed/replaced layer objects, restoring the latest
standard root-local rectangle.

This extends the unpublished v1 draft. Update Hyalo and the client together;
there is no compatibility claim with a Hyalo built from an older copy of v1.


D7 uses `Window::set_layer_blur(Blur, GradedPane[])` for a title whose backdrop is
blurred without glass tone/rim; the same existing material-v1 requests carry each
band's gradient. `Application::window_controls()` opts into the existing
nidara-window-controls-v1 before configure. Its layout arrives as
`Event::ControlsLayout`, queried through `window_controls_layout`; the app places
the box in root coordinates with `place_window_controls`, atomically with its next
root commit. `window_action` supplies standard xdg fallback actions. No visual
geometry, text or colour defaults live in the transport.

## Client title interaction

Root and layer Button events preserve the exact wl_pointer serial and timestamp,
including when several events are drained before application dispatch.
`Window::move_from_pointer_press(serial)` sends standard xdg_toplevel.move with
that press serial and the window's seat; the general last serial is unsuitable
for an interactive grab. Existing close/minimize/maximize actions are unchanged.

#889's `ControlMaterial` is an explicit capsule transaction: base material/blur,
ink tone, optional backdrop response, ink endpoints, stable state regions and
non-overlapping coverage. `set_layer_control_material` validates the entire
payload before sending requests and stages it with the synchronized parent. It
sets response/ink tone before adding the pane. No visual defaults are supplied.
Validation uses the wire's truncating fixed-point conversion for nonempty bounds,
threshold ordering and coverage overlap; adjacent wire rectangles remain legal.
The limits are eight washes and sixteen coverage rectangles. Keep zero-alpha
exit regions with their stable IDs for compositor fading.


## Standard popup host

run_popup hosts a standard xdg_popup on the parent's Wayland connection.
PopupPlacement anchors it in parent window geometry. Pass the initiating physical
input serial for an explicit grab; Key::serial is None for repeats. Do not replace
it with a configure serial. Accessibility activation can omit the explicit grab.
Compositor dismissal is PopupDone; version3 reposition acknowledgement is
PopupRepositioned(token). Older xdg-shell can open, but reposition returns an error.
No D7 layer or new toplevel is substituted. Window Drop destroys roles/surfaces
on callback failure; ordinary close filters queued modal input before parent use.

This cut contains only the primitive and validation tests. The separate transport
probe/headless harness and their exact-binary evidence follow independently.
No new native popup role/grab/reposition/cleanup trace or keyboard/Orca, edge,
fractional, presentation/performance acceptance is implied by compilation.

While this nested loop is open, the parent does not repaint or service its
configure, scale or appearance changes. Keep it bounded to short menus; a
long-running child needs parent servicing that this primitive does not provide.

## Popup diagnostic source (#915)

`examples/popup-probe.rs`, `scripts/ci/nk-popup-check.py` and
`check-popup-headless.sh` reuse the existing private widgets headless host.
The bounded driver checks physical-key serial, popup role/grab, reposition token,
outside dismissal and child-callback-error cleanup. Its toplevel substitution
must complete setup and fail the role assertion; setup timeouts are errors.
Evidence records source revision and binary hashes. A future run needs fresh
logs and its exact rebuilt probe; historical fixed binaries prove their source only.
This extraction was compiled and syntax checked, with no new native execution,
control catch, protocol trace, focus/Orca or presentation acceptance.

`Window::popup_geometry()` is None for toplevels and unconfigured popups. Once
xdg_surface.configure is acknowledged it exposes `[x, y, width, height]` from the
matching compositor popup configure, in parent window-geometry logical coordinates.
Signed origins survive output constraint adjustments. Geometry/size update together;
requesting reposition or receiving its token alone never predicts the new origin.
Use this configured origin, rather than the requested anchor, for modal semantics.

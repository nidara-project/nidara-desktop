<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# nk-widgets

Phase-1 retained structural widgets, beside the unchanged phase-0 clients.
The contract is [PHASE1.md](../../PHASE1.md), D5–D7 and A7.

A `Tree` owns window-lifetime ids, ordered children, retained text layouts, focus,
capture, scroll offsets and per-kind invalidation. Mutate it through its methods;
`Node` is read-only. `group()` creates its header; `row()` creates the label and
control. Semantics and both directions of label relations are derived from those
same children. Hidden subtrees leave semantics; offscreen nodes remain VISIBLE.
`set_checked()` and `select_page()` update controls from the app model without
activating them. A `Target` pairs an id with `generation()`; `dispatch()` rejects stale, hidden or
disabled targets. Do not reconstruct semantic trees in an application.

`layout(Size, layered, TextBackend)` first measures under width constraints, then
places. It retains the same `nk-text::Layout` that `paint()` consumes. Layout
invalidations propagate to ancestors; unaffected constraints reuse cached measures.
Scrolling places the retained measures again and invalidates paint/semantics only.
`set_text_style` invalidates layouts while preserving ids, focus and scroll.
`acknowledge_semantics()` follows publication; `acknowledge()` follows a successful
paint/commit. An application's state changes remain on its connection thread.

Use `window::Composition` from an `nk_wayland::Application`. `sync()` lays out and
paints pane buffers when their content, dimensions, appearance or scale changes;
`event()` handles root/layer input through the same focus/capture/activation paths.
Layer events stay in their own local space: Hyalo has already inverse-transformed
and clipped the presented layer. Clipping those again at its model endpoint would
lose clicks during a transition. Capture records its space until release.
`set_sidebar_open()` changes the layer's position with an optional transition and
releases/restores the leading inset on the same curve, remeasuring and placing the
content and title pane as it moves. Set `set_sidebar_transition` for automatic
resize changes too. `Metrics.content` is a window constant: the breakpoint is
sidebar + content, independent of page contents. Below it the title sidebar button
opens an overlay without an inset, closed by choosing a page, Escape or an outside
click; crossing back docks it. `Tree::sidebar_button` registers the title button
for this action; other title buttons remain application actions.
Without layers, one sampled client timeline places sidebar/inset for paint,
pointer hit-testing and focus together; sidebar AT-SPI bounds
remain model values as required by CONTRACT.md. Reduced motion omits transitions. `invalidate_panes()` follows an appearance
change. The application handles returned `Effect::Activated` for its buttons.
There is no Wayland connection or alternate host here.

The sidebar has its own vertical scroll offset, clamped to measured page extent
minus the viewport below the title. Focusing a page reveals it. Vertical scroll
on its layer scrolls pages; over the title it scrolls content. Horizontal gestures
on either layer scroll content (`LayerEvent::HorizontalScroll` in nk-wayland).

D7 has a full-window content buffer and independent sidebar/title layers. The
content's paint clip is the whole window; its hit/focus/SHOWING viewport excludes
the leading/top insets. `Tree::set_sidebar_frame` supplies the floating pane's
margin/radius from app tokens, preserving the sidebar's width law. Children,
paint/input and AT-SPI share those bounds; layer pixels remain local under motion.
The header uses `Composition::set_titlebar_style`: explicit blur, graded curve,
zone height and background fade. It sends blur-only material, without glass tone,
refraction or rim. Reduced transparency supplies an opaque, unblurred header.
D5 (missing material OR layers) paints opaque panes in the root and clips content
at the insets. With material, D6 keeps the window background in the compositor.

`Tree::window_controls(titlebar, names)` registers three retained fallback buttons
(minimize, maximize, close), with names supplied by the app for translation.
Composition opts into Hyalo's existing control protocol and uses its real layout
and side to reserve space before text placement. With server layout those fallback
nodes leave the semantic/focus tree; without it they remain keyboard/AT-SPI buttons. Their normal
activation effects belong to the app, which calls `Window::window_action`. Apps
opt into `Application::window_controls` for layout before their first frame.

Colours, measurements and pane Material are explicit inputs, resolved by the app
from the exports/appearance portal. `Composition::sync` asks its material resolver
for each pane's actual shorter side, so a title and sidebar use their own size step
and resolve again on resize. Container names (Window, Sidebar, Scroll, Group and Row) are semantic names,
not painted labels. Add an explicit Label child for visible text; Page/Button and
TitleBar keep their visible labels. No palette or glass constants live here.
There are no fields yet: phase-0 Editor/IME behavior is unchanged.

Run tests without a compositor:

```sh
cargo test --manifest-path toolkit/Cargo.toml -p nk-widgets
```

The [demo](../../widgets-demo/README.md) and
[libatspi check](../../../scripts/ci/nk-widgets-check.py) exercise the public APIs.

D8 keeps focus modality separate from the semantic focused node. Pointer presses
(including empty space and presented layer coordinates) hide the ring; Tab/key
input restores it. Programmatic focus/reveal and automatic recovery preserve the
modality. The ring follows the page/button radius or the switch track, with its
width supplied in Metrics from tokens. Focus and selected state do not depend on
whether the ring is visible.

D8 selection, hover and focus use one `highlight_shape`: inset rounded pages,
buttons with their declared shape and switch tracks. Ordinary buttons retain
Metrics.radius; `set_button_shape(ButtonShape::Capsule)` explicitly opts into
half-height rounding for base, hover and ring. Hit bounds remain unchanged. Only actionable
nodes accept hover; a control-only Row/Label does not. Root and presented-layer
motion set retained hover; pointer leave and hiding/disabling its ancestor clear
it. Separators start at the label, follow visible neighbors, skip the last row
and disappear beside selected/hovered pages. Colour, inset, opacity and physical
separator thickness are explicit appearance inputs from provisional list tokens.

D8 content width is selected once with `Tree::set_page_width(PageWidth::Form)`
(or `None` for an unconstrained page). The app names a category. The appearance
seam supplies form width/floor from WINDOW_LAYOUT.content/contentFloor, not page
literals. Scroll children measure inside that column, centred in the viewport
beside the sidebar; the same sampled inset drives recentering during collapse.
Below the floor the column remains horizontally scrollable. `Reading` returns
an explicit error until a real reading page establishes its measured tokens.

`Composition::event_with_window` routes blank title presses to the existing host's
standard move request. It excludes visible controls (including disabled ones),
server control reservations, hidden titles and content below the actual title
height. D7 coordinates are converted from the title layer to Tree coordinates.
The application supplies the double-click interval explicitly through
set_titlebar_double_click_ms; the demo currently uses Hyalo's existing400ms policy.
Double click invokes the same ToggleMaximize action as the maximize button.

Radio groups (#882): `Tree::choices` builds a row whose control holds one `Choice` per option;
`ChoiceKind` picks the look (segmented, swatch), `set_choice_style` hands over the exported
`ChoiceStyle` (no defaults: measuring without it is an error), `set_swatch` gives a sample its
colour, `set_choice` updates from the model. One Tab stop per group (its chosen option); the
arrows/Home/End move focus and choice together (`control_key`, wired in `Composition::event`).
A choice's keyboard ring sits outside its shape so it shows on the accent segment.

Range controls (#882): `Tree::slider` and `Tree::fields` (spin buttons, the time fields) over a
`ValueRange`; `set_range_style` hands over the exported `RangeStyle`. `set_value` (model),
`control_key` (keys), `range_drag` (press/drag, wired in `Composition::event`) and
`request_value` (AT-SPI SetValue) all clamp and step the same way and report
`Effect::Changed(id)`. A spin button's clock wraps (`ValueRange::wrap`); a slider never does.

The #889 retained foundation is `control_capsule(name, position, CapsuleMetrics)`
and `capsule_button(panel, accessible_name, glyph, destructive)`. It is one named
Panel of existing Buttons, explicitly Capsule-shaped, with glyph captions
independent of accessible names.
Measures, focus/actions, capture cancellation, hidden/disabled state and removal
use the normal retained Tree. Metrics/position can change without replacing IDs.
Geometry is supplied explicitly; the proposed common export is capsule.json →
components.json, with server layout mirrored and checked separately by Hyalo.
This foundation does not yet wire capsule layer material/coverage or the demo.

Capsule component data separates the outer edge from the inter-button gap.
Pitch is button + gap; future visual tuning must not infer gap from edge.

CapsuleComposition stages one layer per panel with monochrome glyph/ring coverage,
material states and placement in the host transaction. It routes layer input to
the same Tree capture/actions and caches paint revisions. Appearance changes call
invalidate(); backdrop response requires no repeated client repaint. D5 draws
exported opaque base and state feedback. The native demo opts in with --capsules.
Compositor visual/idle/performance acceptance remains pending.

Opaque capsule state feedback is sampled by `CapsuleComposition::sync` using
`states.fadeMs` and the same linear RGBA wash interpolation as Hyalo. Retargeting
starts from the current sample; first appearance is immediate. Reduced motion
snaps an in-flight wash to its target. The retained painter consumes that sample;
geometry, hit-testing and semantics keep their existing paths. `is_animating()`
is available to callers deciding when to request sync/frame opportunities. The
current foundations demo still polls every 16 ms; it does not yet use this API
to stop fast polling. The D5 clock is client monotonic time since first sync,
not frame/presentation time.
D7 has no client wash timeline or per-frame client repaint.

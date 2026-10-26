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
`set_active()` is idempotent: unchanged physical activation does not request
semantic publication or erase pending changes. Real transitions still publish
activation and invalidate search caret paint without changing retained focus.

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


### Dropdown model (#882/#915, popup list pending)

`Tree::dropdown(group, label, options, selected)` adds a labelled row with one
ComboBox and stable Selection children. Collapsed options are model-only: no
paint/hit area and no Tab stops. The current option is still readable through
AT-SPI Selection. Activating the combo requests opening (Activated); choosing
an option uses the same guarded dispatch as accessibility and returns Changed
once on the combo. Programmatic `set_dropdown_selected` emits no write.
Expanded state is controlled explicitly so cancellation preserves the selection.
The closed trigger takes `DropdownStyle` from `components.json.dropdown.trigger`
(`toolkit/tokens/dropdown.json`, derived from the current kit CSS): padding,
constant border, minimum content height, radius, relative font/weight, colours,
disabled opacity and shared-theme chevron. Missing style is an error. Hover,
press and keyboard focus keep the same bounds. This is the current source's
recipe, still subject to native owner live review. This model is
not the popup list, a complete Dropdown widget, a Settings builder, or an Orca
acceptance result.


### Dropdown menu list

`Tree::menu_list` builds a standalone Scroll of retained MenuOptions for the
standard popup host. `MenuStyle` reads `components.json.dropdown.menu`, from the
current kit's dropdown CSS and check factory. The inner viewport reaches the
card edge; border + row inset is accounted once. Arrow/Home/End focus reveals
options and skips disabled entries without changing the chosen check. Activate
returns an option action for the parent to accept. Hover/keyboard focus paints
accent with accent ink; pointer movement removes an old keyboard highlight.
The chosen check has a permanently reserved trailing slot and follows selected,
not hovered/focused state. Portal style updates preserve IDs/focus/scroll through
`set_menu_style`. No material forces the menu base opaque.

The existing native probe/wrapper/checker are separated from this component cut.
CPU tests do not prove native selection/cancel, material, pointer opening,
AT-SPI/Orca, fractional scale or Settings app acceptance. Historical diagnostic
binary results stay attached to their original source, not this rebuilt head.

The separated `toolkit/settings/examples/dropdown-probe.rs` and
`toolkit/settings/check-dropdown-headless.sh` use the existing private host and
`scripts/ci/nk-dropdown-check.py`. The driver brackets select/cancel with handled
input and parent commit markers and prepares ignore-selection/commit-on-cancel
faults. It is not executed on this rebuilt head; build/syntax checks establish
source compatibility only. It has no production Config1 or shared AT-SPI bridge.

`DropdownPopup` borrows the combo's parent Tree while its menu is open. Publish
its `snapshot(actual_popup_origin)` through the application's existing provider:
the parent root/ComboBox/Selection option IDs remain stable, while menu-local IDs
stay private. Focus, bounds and actions project onto those retained options;
parent actions are suspended. Tag requests with the returned publication revision
and call `request`, which also guards the captured menu generation. A revision
from a previous opening cannot activate a new popup. `finish(Some(index))` uses
the guarded parent activation; `finish(None)` and Drop preserve the value and
collapse/restore focus. The popup host must supply its configured origin, and
publish the restored parent snapshot after dismissal. This adapter alone does
not establish provider, native popup geometry, or real Orca acceptance.

The short-menu adapter intentionally holds an exclusive parent Tree borrow:
parent repaint/configure/scale/appearance servicing cannot run concurrently.
Revise that ownership contract before building a controller that needs it.
An unavailable chosen option retains its check but initial focus falls back to
the first available option, or none if all options are unavailable; opening and
cancellation must still work without changing the chosen value.


SearchInput is created with Tree::search_input(parent, name, placeholder, backend)
after supplying SearchStyle. It owns one nk-text::Editor in the retained Tree;
paint, pointer hit-test, caret/selection and TextInfo use its shared layout. Its
name and placeholder description are separate from committed text. Canonical
set_search_text returns no effect; user edits return Changed only for a changed
committed buffer. search_request handles authorized SetText/SetSelection targets;
search_paste rejects stale/hidden/disabled targets and multiline/control text.
When consuming Bridge requests, validate the publication revision first, then use
Tree::target(id): publication revisions and structural tree generations differ.

Composition::event handles text keys and Ime batches. Use event_with_window for
native clipboard routing, then Composition::sync (or sync_search_input after your
own layout) so the IME cursor follows the actual horizontal scroll and D7 pane.
An asynchronous paste is tied to its target and dropped after invalidation. IME
context is reset across input focus changes and disabled when the last input is
removed. Focus loss/hidden/disabled state cancels preedit; inactivity repaints the
caret without a timer. Single-line committed TextInfo remains valid during a
separate preedit display buffer and omits geometry while preediting.

Geometry and colours come from toolkit/tokens/search.json: the current Settings
search box, plus shared kit text selection (accent30/text). Styles reads/applies
this once for every application. No provider, search-result model or Config1 write
is owned by the input. Component/synthetic-event tests do not establish native IME,
clipboard, real AT-SPI requests or Orca speech acceptance.


`Tree::list(parent, name, height, MenuStyle)` embeds the dropdown's retained menu
rows as a real single-selection LIST inside a Scroll or Group. Append MenuOption
children; use `set_list_selected(list, Some(option))` (or None) for canonical state.
Activation changes once with Changed(list); arrows/Home/End focus and reveal only.
One Tab stop uses current focus, selected or first available option. Each list
keeps independent style/scroll; `set_list_style` and `set_list_height` preserve IDs.
Filtering may hide options or leave the list empty. The same viewport clips pixels,
hit tests and SHOWING; offscreen options remain semantic children. Composition's
vertical wheel routes by viewport, including its empty insets. No second renderer,
Tree, provider or global menu mode is needed. This primitive alone does not prove
the FontChooser modal or its Orca speech.


`DialogTree::new(parent, launcher, title)` borrows the controlled parent and
provides a transient retained view with window-lifetime IDs disjoint from its
parent. Use its view to build existing controls, and publish `snapshot()` through
the application's existing Bridge. Snapshots preserve the parent root and attach
a DIALOG child; parent actions/focus are suspended. `request` validates publication
and view generation and confines actions/text/value requests to the dialog. Drop
retires all view IDs, invalidates old structural targets and restores focus only
when the launcher is available/showing; `invalidate` suppresses restoration and
rejects every request/snapshot. Stage parent mutations until the borrow ends.
Dialog views reserve no sidebar inset. SearchInput's `search_composing` exposes the
single Editor's preedit state so modal Escape can cancel composition first.

A Button caption can opt into set_button_text_style, sharing the same validated
retained-layout override as set_label_style. None restores the ordinary UI style.
set_button_description changes only accessible text, preserving the row's title
relation; the font builder uses it for current value/help/error. Both overrides
are retired with the node. No separate font-button renderer or style defaults.


Tree::image retains a named IMAGE with explicit size/ImageStyle. set_image supplies
an Arc<nk_render::Raster>; repeated identical content is a no-op. Measurement fits
the caller's logical box responsively, while Contain/Cover control pixel fitting.
Background/border/radius are caller styles. Hidden/offscreen clipping uses the same
Tree rules, and removal releases pixels. Decode/loading lifetime belongs to builders.


Tree::thumbnail_strip reuses Choice radios with an independent horizontal viewport
and explicit ThumbnailStyle. Add named thumbnail_option children and supply their
shared Rasters through set_image. Canonical selection accepts None; keyboard,
pointer and Tab use existing Choice semantics. Focus reveals within the strip;
wheel input scrolls it independently. Paint, hit tests and SHOWING share clipping.
Offscreen options stay retained. This primitive does not enumerate/decode or Apply.

reorder_thumbnails accepts an exact permutation only, preserving IDs/pixels and
selection while invalidating layout and old action targets. Invalid input is atomic.

Unchanged hidden/disabled setters return after id validation, before collecting
focus order. Actual availability changes retain the old order for focus repair.

Window controls pass `WindowGlyph::{Minimize, Maximize, Close}` as the capsule
button glyph; translated accessible names remain separate. Call
`set_window_glyph_style` with the validated exported `WindowGlyphStyle` before
painting. They measure from capsule geometry and never shape text; nk-render
strokes their paths in both layer coverage and D5. Ordinary toolbar captions
continue to use retained text layouts.

Applications with a floating window-control capsule register it using
`Tree::window_controls_capsule(panel)` after adding the three typed glyph buttons.
They opt into `Application::window_controls` before the first configure. Composition
requests/receives the existing server protocol layout and hides the whole fallback
panel while it exists (including semantics, focus and capture). The app arranges
against `server_controls_layout()`'s actual side/size and updates the registered
capsule's root-local position, even while hidden. `server_controls_bounds()` is
then the one box sent to Hyalo and excluded from title dragging. No content inset
is added to a registered capsule. Ordinary titlebar fallback placement is unchanged.

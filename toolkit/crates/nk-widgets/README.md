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
the leading/top insets. D5 (missing material OR layers) paints opaque panes in the root, clipping
content at the insets. Only missing material paints an opaque root base; when
material is available, D6 keeps the window background in the compositor. The title has no divider
and reserves a trailing box for window controls. The alternative panel material
is used for the title pending the owner's graded-blur A/B decision.

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

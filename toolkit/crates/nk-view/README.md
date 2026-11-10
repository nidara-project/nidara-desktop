<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# nk-view

The shell's own view vocabulary, as `toolkit/VIEW.md` contracts it (#1048). It holds pieces 1
to 4 of the 2026-11-10 shell inventory: the layout box, the shared interaction state, the pane,
and motion (reveals and slides). No surface uses it yet. The notification centre is the first,
behind a flag, once scroll, overlay and swipe exist.

A surface builds a `Node` tree from its model on every change, with each node's `Key` taken
from the model. `ViewState` keeps what lasts between rebuilds:

| Call | What it does |
|---|---|
| `layout(view, size, scale, tokens, text, now)` | Measures, then places. Measured sizes are rounded up to whole device pixels and every edge is snapped to the device grid, so equal cards have equal sizes wherever they are. Texts are cached by key, string, style, line limit and width. A reveal whose `open` changed starts to ease, and a pane the rebuild moved slides from where it was drawn. |
| `tick(tokens, text, now)` | Advances reveals and slides, and lays the view out again. It returns whether anything still moves; while it does, the surface asks for frames. |
| `pointer_motion`, `pointer_leave`, `button`, `key`, `reconcile_pointer` | Derive hover (the innermost shown, enabled control), press (cancelled by a release elsewhere) and focus (Tab order). The surface gets back only `Activated { key, action }`. |
| `frame(washes, now)` | Returns one `nk_wayland::Pane` per visible pane, plus the state regions (see below). |
| `semantics(root, first_id)` | Builds the AT-SPI tree: a panel per pane, a button per control, a label per text outside a control (whole, never cut). |
| `paint(canvas, tokens, icons, fallback)` | Paints texts, icons and the keyboard focus ring. With `fallback` it also paints the washes (D5, no material protocol). |

**State regions.** Each pane's lit regions come first: press, then hover, then those still
fading, then markers. Every other shown control follows at rest, with alpha 0. Hyalo shows a
new region id at once and eases a known one, so a region declared at rest is what lets a hover
fade in. Hyalo also draws only the first eight lit regions over a shape, so no pane is given
more than eight (`BUDGET`). The overflow is dropped and logged once. A control with
`Wash::None` declares nothing, and a control revealed with a pane declares nothing while it
is hidden.

**Motion.** A `Reveal` unrolls its child downward, clipped, with its content's opacity
following the progress. It opens with `ease-emphasized` over `dur-slow`, and closes with
`ease` over `dur-base`. While it is closed, its controls leave the Tab order and the semantics.
Panes below a reveal follow it frame by frame. A slide (`ease` over `dur-base`) starts only
when a rebuilt view moves a pane. With `set_reduced_motion` everything lands at once.

**Tokens, never literals.** Gaps and paddings are `Space` steps, corners are `Pill` or a
`Radius` step (`ts.RADIUS`), and motion uses the kit's curves and durations, all from
`tokens/static.json`. Washes come from `tokens/glass.json` (the control piece's `states`), and
text and focus colours from `tokens/colors.json`. Icon sizes are still passed in by the surface
from its tokens.

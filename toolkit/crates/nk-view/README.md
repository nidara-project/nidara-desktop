<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# nk-view

The shell's own view vocabulary, as `toolkit/VIEW.md` contracts it (#1048). It holds pieces 1
to 6 and 8 of the 2026-11-10 shell inventory: the layout box, the shared interaction state, the
pane, motion (reveals and slides), scrolling, the overlay and swipe to dismiss. No surface uses
it yet. The notification centre is the first, behind a flag.

A surface builds a `Node` tree from its model on every change, with each node's `Key` taken
from the model. `ViewState` keeps what lasts between rebuilds:

| Call | What it does |
|---|---|
| `layout(view, size, scale, tokens, text, now)` | Measures, then places. Measured sizes are rounded up to whole device pixels and every edge is snapped to the device grid, so equal cards have equal sizes wherever they are. Texts are cached by key, string, style, line limit and width. A reveal whose `open` changed starts to ease, and a pane the rebuild moved slides from where it was drawn. |
| `tick(tokens, text, now)` | Advances reveals, slides, swipes, scrolls and scroll bars, and lays the view out again. It returns `Ticked`: whether anything still moves (while it does, the surface asks for frames), and the cards whose swipe just took them off the surface, as `Activated` with the swipe's action. |
| `pointer_motion`, `pointer_leave`, `button(pressed, now)`, `key`, `reconcile_pointer` | Derive hover (the innermost shown, enabled control), press (cancelled by a release elsewhere), focus (Tab order), swipes, and the scroll bars' drags. The surface gets back only `Activated { key, action }`. |
| `scroll(ScrollBy)`, `window(key)` | Scroll the region under the pointer, by pixels or wheel detents; and say what of a region's content shows, so the surface builds only those rows. |
| `frame(tokens, now)` | Returns a `FramePane` per visible pane (its whole shape, its clip, and its glass opacity, which is its content's), plus the state regions (see below). `Frame::groups(tone, shadow)` turns the panes into material groups. |
| `semantics(root, first_id)` | Builds the AT-SPI tree: a scroll pane per scroll region, a panel per pane, a button per control, a label per text outside a control (whole, never cut). |
| `paint(canvas, tokens, icons, fallback)` | Paints texts, icons, the keyboard focus ring and the scroll bars. With `fallback` it also paints the washes (D5, no material protocol). |

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
when a rebuilt view moves a pane. With `set_reduced_motion` everything lands at once. A pane
cut by a reveal is declared whole with a clip, so it is cut straight, and its glass fades with
its content.

**Swipe.** A control marked `swipe(action)` (a notification card) becomes a swipe when a press
on it travels more than 8 px across, and more across than down; a press on a button inside it
never swipes. The press is cancelled, and the card (its nearest pane, with all it holds)
follows the pointer: freely for 140 px, then 15 % of further travel, fading to 1 − distance/320,
never below 0.15. Released 90 px or more away, it is flung off the surface; short of that, it
settles back (`ease-emphasized` over `dur-base`). `tick` reports the fling when it ends, and
the card stays hidden until the surface drops it. These distances come from the TS shell
(`ScaleRevealer.ts`).

**Scroll.** A `Scroll` region is as tall as its content where there is room; a column that runs
short takes the height from its scroll regions first. Its offset is kept by key and clamped.
The wheel moves the innermost region under the pointer (a detent is the viewport's height to
the 2/3, as GTK's; `ScrollBy::from` an `nk-wayland` scroll event takes its detents), Page Up and Page Down move 0.9 of a page, Ctrl+Home and Ctrl+End go to the
ends, and Tab onto a control out of view scrolls it in. On a rebuild, a scrolled region keeps
its first pane in view where it was. Rows outside `window(key)` are left unbuilt, as
`Node::placeholder(key, height)` at the height they had. The bar is `nk-widgets`' `ScrollBar`,
the one the native Settings draws, from `tokens/scrollbar.json`.

**Overlay.** `Node::overlay(key, base).layer(across, down, inset, child)` places layers over a
base, as `Gtk.Overlay`: the base alone gives the size; each layer is aligned on each axis
within it and kept an inset (spacing tokens) from its edges. Layers come after the base: over
it for the pointer, after it in the Tab order, painted over it. The NC's close over a card's
top-left corner is one.

**Tokens, never literals.** Gaps and paddings are `Space` steps, corners are `Pill` or a
`Radius` step (`ts.RADIUS`), and motion uses the kit's curves and durations, all from
`tokens/static.json`. Washes come from `tokens/glass.json` (the control piece's `states`), and
text and focus colours from `tokens/colors.json`. The scroll bar's look is
`components.json`'s `scrollbar` (`scrollbar_from`). Icon sizes are still passed in by the surface
from its tokens.

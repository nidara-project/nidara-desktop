<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# nk-view

The shell's own view vocabulary, as `toolkit/VIEW.md` contracts it (#1048). It holds pieces 1
to 4 and 8 of the 2026-11-10 shell inventory: the layout box, the shared interaction state, the
pane, motion (reveals and slides) and swipe to dismiss. No surface uses it yet. The
notification centre is the first, behind a flag, once scroll and overlay exist.

A surface builds a `Node` tree from its model on every change, with each node's `Key` taken
from the model. `ViewState` keeps what lasts between rebuilds:

| Call | What it does |
|---|---|
| `layout(view, size, scale, tokens, text, now)` | Measures, then places. Measured sizes are rounded up to whole device pixels and every edge is snapped to the device grid, so equal cards have equal sizes wherever they are. Texts are cached by key, string, style, line limit and width. A reveal whose `open` changed starts to ease, and a pane the rebuild moved slides from where it was drawn. |
| `tick(tokens, text, now)` | Advances reveals, slides and swipes, and lays the view out again. It returns `Ticked`: whether anything still moves (while it does, the surface asks for frames), and the cards whose swipe just took them off the surface, as `Activated` with the swipe's action. |
| `pointer_motion`, `pointer_leave`, `button(pressed, now)`, `key`, `reconcile_pointer` | Derive hover (the innermost shown, enabled control), press (cancelled by a release elsewhere), focus (Tab order) and swipes. The surface gets back only `Activated { key, action }`. |
| `frame(tokens, now)` | Returns a `FramePane` per visible pane (its whole shape, its clip, and its glass opacity, which is its content's), plus the state regions (see below). `Frame::groups(tone, shadow)` turns the panes into material groups. |
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

**Tokens, never literals.** Gaps and paddings are `Space` steps, corners are `Pill` or a
`Radius` step (`ts.RADIUS`), and motion uses the kit's curves and durations, all from
`tokens/static.json`. Washes come from `tokens/glass.json` (the control piece's `states`), and
text and focus colours from `tokens/colors.json`. Icon sizes are still passed in by the surface
from its tokens.

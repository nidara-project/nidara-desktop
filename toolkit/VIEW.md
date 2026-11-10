<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# nk-view — layout and interaction for shell surfaces (contract, proposal)

Part of #1048 (read it first: why one description, what is out of scope). **Status: a proposal
for the owner's review; the NC's behaviour is decided (end of file).** Nothing here is built yet. It is merged before the code that uses it,
as `CONTRACT.md` asks.

This file covers the two pieces that the shell inventory of 2026-11-10 ranked first:

1. **A box that places its children**: rows and columns with gap, padding and alignment.
2. **One interaction state** (hover, press, focus) that the toolkit derives and declares to Hyalo.

A third piece is needed with them: **the pane** (a card of glass). It is the unit Hyalo's state
budget counts in. Animation, scrolling, overlay, tile grid, gestures, tooltip and calendar are
later contracts. This one only keeps room for them (§6).

## Why

The Rust shell is about 17,000 lines across bar, dock, Apps, CC and NC, and it hardly uses the
kit: only `popup.rs` takes the action menu from `nk-widgets`. Each surface places, hit-tests and
paints with its own numbers. The NC writes a card as 112 or 152 high, its close button at
`right − 36, y + 8`, and gaps of 16 and 32 (`toolkit/shell/src/notification_card.rs`).

Two measured consequences:

- **Misalignment.** No rule ties one surface's numbers to another's, or to the spacing tokens.
- **Missing hover.** Hover exists only where a file registered it by hand. There are nine hover
  implementations, and they disagree: the bar paints its own 8 % ink (`bar.rs`, `HOVER`), while
  the CC and the NC declare state regions to Hyalo (`states()`).

The TS shell had neither problem, because GTK gave it boxes that align and a hover on every
button. `nk-widgets` already has measure-then-place and hover, but only for the fixed kinds of
an app window (page, group, row, switch). #1048 says why it stays as it is. The shell needs its
own small vocabulary.

**Pilot: the notification centre**, not the bar that #1048 proposed. The owner decided on
2026-11-10 that the NC goes back to **separate cards**, one per notification or group, as in TS.
It has to be rebuilt anyway, and it is the surface with the most visible faults.

## 1. Where it lives

```
toolkit/crates/nk-view     nk-view → nk-text, nk-render, nk-a11y, nk-wayland (material types)
```

- `nk-view` depends on nothing in `toolkit/shell`. The shell depends on it.
- It does not depend on `nk-widgets`, and `nk-widgets` does not depend on it.
- It owns no Wayland connection. The surface hands `nk-view`'s output (placed rects, paint,
  semantics, panes with their state regions) to `nk-wayland`, as today.

## 2. The view

A surface builds a `View` from its model on each change, in plain Rust:
`fn center(model: &NcModel, tokens: &Tokens) -> View`. A `View` is a value: a tree of nodes, each
with a **stable key** that the surface takes from its model (a notification's id, a group's
key), never from its position.

The node kinds are closed:

| Kind | What it is | Children |
|---|---|---|
| `Stack` | Places its children along one axis, with gap, padding and alignment | any |
| `Pane` | One piece of Hyalo glass: a card. Has its own state budget (§4) | one |
| `Text` | One `nk-text` layout: a style token and a string | none |
| `Icon` | An interface glyph (`nd-` name) or a shared app icon (`icon_memory.rs`) | none |
| `Spacer` | Takes the space left on the main axis, shared equally between spacers | none |
| `Control` | Something that can be pressed: role, name, named action, risk (CATALOG.md) | one |

A `Control` wraps what it shows. A close button is `Control(Icon)`, and a whole card that opens
its app is `Control(Stack(...))`. Hover, press and focus belong to `Control`s only (§4).

The view is `serde`-serializable, as #1048 asks. Actions are names, never code.

## 3. Layout (piece 1)

**Two passes, as in `nk-widgets`.** First each node is measured under a width constraint, keeping
the `nk-text` layout that paint will use. Then it is placed. The same placed rectangles feed paint,
hit-testing, semantics and the material. Nothing computes a position twice.

**Measures are tokens, never literals.** A `Stack`'s gap and padding take a `Space`. It is a
closed enum over the kit's spacing scale (`$space-1` … `$space-10`: 4, 8, 12, 16, 20, 24, 32,
40 px, `ui/lib/nidara-kit/styles/_tokens.scss`). A text takes a style token (`$fs-*`), and a pane
takes its piece of the exported glass. A ported surface's view code holds no number for a
position, size or gap. The `Space` scale needs exporting to `toolkit/tokens/` with the
others. Today only component tokens are exported.

**Stack rules:**

- **Main axis.** Children take their measured size, in order, separated by `gap`. `Spacer`s share
  the rest. Without a spacer, `justify` places the run: `Start`, `Center` or `End`.
- **Cross axis.** `align` is `Start`, `Center`, `End`, `Stretch` or `FirstLine`. With `FirstLine`, a
  child's box is centred on the first line of the tallest text in the stack, not on its whole
  height. That is what puts an app icon level with a notification's title when the body wraps
  to three lines. It is the most common misalignment in the NC and the CC today.
- **Padding** is `Space` per side (`all`, `vertical`/`horizontal`, or four sides).

**Text that does not fit.** Interface labels never truncate: a label that does not fit is a
wording problem (the project's rule). A text whose content comes from outside, such as a
notification's body or a track title, declares `lines(n)`: it wraps to `n` lines and ends in an
ellipsis. Its full text stays in the semantics.

**Pixel snapping.** Every placed edge is rounded to the output's device-pixel grid once, at
placement. A size is the difference between two snapped edges. Sums of rounded sizes are never
used, so two cards with the same content start and end on the same pixel at scale 1.25 too.

**Caching.** A text node keeps its layout while its string, style and width constraint are
unchanged. The bar re-shapes every text on each relayout today (#1048 "Performance"). This
contract does not allow that.

## 4. Interaction state (piece 2)

**The toolkit derives it, and the surface never sets it.** Pointer motion, press, release and leave
go to `nk-view`, which hit-tests the placed `Control`s (the innermost wins) and keeps three
states per view:

- **hover**: the `Control` under the pointer, if it is enabled;
- **press**: the `Control` pressed, until release; release outside it cancels;
- **focus**: one `Control`, moved by Tab and Shift+Tab in tree order, and shown by its ring.

The surface receives only the effect: `Activated(key, action)`.

**Who draws what** (CONTRACT.md "Who draws what on glass"; commandment 12):

- **Hover and press are Hyalo's washes.** For each `Pane`, `nk-view` produces that pane's
  `StateRegion`s (`nk-wayland::control_material`), with the wash and fade taken from the exported
  glass tokens (`tokens/glass.json`, its `states`: hover 8 %, press, destructive hover and
  press, 150 ms), as the native Settings already reads them (`settings/src/material/control.rs`). A surface writes
  no wash value. The bar's client-painted 8 % goes away when the bar is ported.
- **The focus ring is content**, drawn by `nk-view`, as `nk-widgets` does (D8). It follows the
  control's shape and spends no wash.
- **Without the material protocol (D5)**, `nk-view` paints the same washes in the client, from
  the same tokens: one fallback path, not one per surface.

**The budget.** Hyalo lays at most **eight washes** over one shape
(`hyalo/compositor/src/render/glass_gl.rs`, `STATE_MAX`), and drops the rest. Today the whole
NC is one pane, so every card shares those eight. That is why its cards have no hover:
`B3.2.md` reserves the eight for navigation, today, hover and focus. With one `Pane` per card,
each card has its own eight. `nk-view` enforces the limit per pane, in this order:

1. press;
2. hover;
3. a region fading out (a state just left, declared at alpha 0 until its fade ends);
4. persistent markers that the surface asks for, such as today in the calendar or a selected item.

It never declares more than eight. If a pane would need more, the lowest are dropped and logged
once per view. A pane that needs more than eight persistent markers is a design error that the
check reports (§7).

**Revealed controls.** A `Control` may be `revealed_with(pane)`: it is drawn only while the
pointer is over that pane or focus is inside it. A notification's close button is the example.
It stays in the semantic tree and in the Tab order at all times, so a reader and the keyboard
always reach it.

**Leave and grabs.** Pointer leave clears hover and fades its wash. When a modal menu closes, the
surface passes `Window::root_pointer_position()` sampled before the popup is destroyed (#1030),
and `nk-view` recomputes hover from it. Hiding or disabling a control clears its states.

## 5. The pane (the part of piece 3 needed now)

A `Pane` is one material shape on the surface. Its radius and material piece come from the
exported glass (`tokens/glass.json`). Its bounds are its child's placed rect. The surface keeps a
root material for pieces that are not panes, as today. `nk-view` adds one shape per visible
`Pane`, with that pane's state regions.

Only panes inside the viewport are declared, as B3.2 already does for cards. Whether Hyalo holds
a limit on shapes per surface is open: see the questions.

## 6. What this keeps room for

- **Animation (piece 4).** Placement is a pure function of view, size and scale. A revealer can
  interpolate between two placements by key, and Hyalo layers keep moving panes.
- **Scroll (piece 5).** A scroll region becomes a node kind that places its child at an offset
  and clips. Hit-testing already goes through placed rects.
- **Overlay (piece 6).** A third axis value, `Stack(Z)`, with children placed over each other.

None of these is in this contract.

## 7. Acceptance for the NC pilot

The pilot replaces `nc.rs` and `notification_card.rs` with a view over the same model
(`notifications.rs`), behind a flag, beside today's NC.

| Check | Passes when | Can fail because |
|---|---|---|
| Hover everywhere | Each `Control` in a view of 2,000 records, when hovered, shows its wash in Hyalo's read-back of the pane | A control without a `StateRegion`; the control: drop one region and require the check to catch it |
| No literals | The NC's view code holds no number for a position, size or gap | `scripts/ci` check over the view module, with a control line that adds a literal |
| Alignment | At scale 1 and 1.25, icon centre and first-line centre agree to 1 device pixel on every card | `FirstLine` replaced by `Center` in the control run |
| Semantics | The AT-SPI walk of `check-nc-headless.sh` passes as it does today | — |
| Budget | No pane ever declares more than eight regions | The control asks a pane for nine |
| Cost | Frame time and memory with 2,000 records are not worse than today's NC | — |

Hyalo's read-back of washes covers toplevels (`hyalo/compositor/src/ipc/mod.rs`, #889). If it does
not cover layer surfaces, the check needs that addition first.

## The NC's behaviour (owner, 2026-11-10: as in TS)

The owner answered the open questions with "as it was in TS". This is what the TS notification
centre did (`ui/shell/surfaces/control-center/NotificationCenter.tsx`), and what the pilot keeps:

1. **The close button is revealed on hover.** It floats over the card's top-left corner, the same
   on banners and NC cards, and is a `Control` `revealed_with` its card's pane (§4). On a collapsed
   group it clears the whole group.
2. **The card itself has no wash.** Hovering a card reveals its controls (the close and, on an
   expandable card, the chevron, which takes the timestamp's place on the same line) but lights
   nothing: the TS card declared no hover colour. So a `Control` may declare `wash: None`. Its
   hover state still exists and drives `revealed_with`, and it spends no region of the budget.
   Its own close and chevron do show their washes.
3. **Clicking a card opens its app.** It focuses the app's window if one is open and invokes the
   `default` action, or launches the app when it has no window and the notification has no
   `default` action. A notification without an app opens the first URL in its text. The click
   fires on release, so a swipe can cancel it. On a collapsed group the click expands the group
   instead.
4. **Groups are stacked cards.** A collapsed group shows its newest card with one ghost layer
   peeking 14 px below it (two layers, 10 px further, from three notifications), and a count
   badge on the title line. Expanded, it shows a header pane (the app's name, then collapse and
   clear-all buttons revealed on hover) with its cards below. A tap on the header collapses it.
5. **An expandable card** (with actions, a body over 70 characters, or a large image) grows from
   two body lines to four, with its action buttons, through its hover chevron.

What this adds to the contract and its pieces:

- `wash: None` on a `Control` (point 2). It is the one addition to §4.
- The ghost layers are part of the group's pane: one shape whose outline includes the peeking
  strips, not two more panes. How Hyalo draws that outline is measured with the shape limit.
- Expanding (points 4 and 5) needs the revealer, piece 4. Swipe to dismiss needs gestures, piece 8.
  The pilot ships with both, because the TS centre had them: they are contracted before it, as
  short additions to this file.

## The shape limit (measured 2026-11-10)

**Hyalo has no limit on glass shapes per surface.** A surface's shapes are a list
(`hyalo/compositor/src/protocols/material.rs`), and each is drawn in its own call over its own
rectangle (`render/glass_gl.rs`, `draw_plan`). The only fixed arrays in the shader are the eight
washes and the eight members of a fusion group. Shapes whose blur reaches each other share one
capture and one blur (`render/glass.rs`), so cards eight pixels apart cost one capture, as one
panel does.

Measured with `toolkit/crates/nk-wayland/examples/glass-count-probe.rs`: one layer surface with
N cards of 232 × 60, moved one pixel every frame so that the glass is redrawn every frame, in the
private nested Hyalo of `toolkit/widgets-demo/check-headless.sh` on this machine's GPU, at
1272 × 688. The figures are the averages from `nidara-hyalo msg stats`:

| Glass | Captures per frame | GPU per frame | Glass textures |
|---|---|---|---|
| 1 card | 1 | 0.32 ms | 0.4 MB |
| 10 cards | 1 | 0.80 ms | 2.2 MB |
| one pane over the same area as 10 cards | 1 | 0.53 ms | 2.2 MB |
| 50 cards | 1 | 3.8 ms | 9.2 MB |
| one pane over the same area as 50 cards | 1 | 0.98 ms | 9.2 MB |

So each card adds about 0.06 ms of GPU time per redrawn frame over one panel of the same area.
Textures and captures stay the same. The NC builds only the cards in its viewport, about ten,
which costs about 0.3 ms per frame more than today's single pane, and only on frames where the
glass is redrawn. That is within budget. The pilot's "Cost" check (§7) measures it again on the
real NC.

That all N cards are drawn comes from the code (one call per shape, no cap) and from the GPU
time growing with N. It is not seen in a screenshot. The private Hyalo refuses screenshots,
because the run has no consent for computer control.

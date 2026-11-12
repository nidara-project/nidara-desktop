<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# nk-view — layout and interaction for shell surfaces (contract)

Part of #1048 (read it first: why one description, what is out of scope). **Status: accepted. Pieces 1
to 6 and 8 (§2 to §9) are built in `toolkit/crates/nk-view`, which no surface uses yet. The NC's
behaviour is decided (end of file). §12, the Control Center's, is proposed (2026-11-11).**

This file covers the two pieces that the shell inventory of 2026-11-10 ranked first:

1. **A box that places its children**: rows and columns with gap, padding and alignment.
2. **One interaction state** (hover, press, focus) that the toolkit derives and declares to Hyalo.

A third piece is needed with them: **the pane** (a card of glass). It is the unit Hyalo's state
budget counts in. Animation, scrolling, overlay, tile grid, gestures, tooltip and calendar are
later contracts, except animation, the swipe, scrolling and the overlay, which §6 to §9 add.
The rest are not in it (§10).

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
- It uses `nk-widgets` only for models two surfaces share with the native Settings: the scroll
  bar (§8) and the slider's range (§12.1). `nk-widgets` does not depend on it.
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

**A view may take part of its surface.** `layout_in(view, bounds, …)` lays the root out in a rect
of the surface (the NC along the bar surface's right edge); everything given back, from
hit-testing to the regions, is in surface coordinates. `layout(view, size, …)` is the whole
surface.

**Measures are tokens, never literals.** A `Stack`'s gap and padding take a `Space`, and a
corner takes `Pill` or a step of the radius scale (`RADIUS`, `xs` to `xl`, exported in
`tokens/static.json`). It is a
closed enum over the kit's spacing scale (`$space-1` … `$space-10`: 4, 8, 12, 16, 20, 24, 32,
40 px, `ui/lib/nidara-kit/styles/_tokens.scss`). A text takes a style token (`$fs-*`), and a pane
takes its piece of the exported glass. A ported surface's view code holds no number for a
position, size or gap. The scale is already exported: `tokens/static.json` carries every
variable of `_tokens.scss`, `space-1` to `space-10` among them, and `nk-view` reads it from there.

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
ellipsis. Its full text stays in the semantics. A weight the fonts have no face for (no bold
installed) falls back to the regular weight, as the shell's own text does; a text is never
dropped for its weight. A text may `reserve(n)` lines: it is that tall however few it fills, so
cards of one kind share a height (TS reserved a notification body's two lines).

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
- **Off glass, the view paints them** (owner, 2026-11-12). Hyalo draws a wash only where there
  is glass (`add_state_region` in `nidara-material-v1`), so a control with no `Pane` above it, a
  row of a group, gets its hover, press and marked wash painted by `nk-view` under its content,
  from the same tokens and with the same fade. It declares nothing to Hyalo and spends no
  budget. This is not imitating the compositor: there is no glass there for it to draw on, and
  the protocol is not to be extended for it.
- **Disabled is content.** An enabled-`false` control that has an action draws its text and
  glyphs in `--nidara-text-disabled`. One with no action is a marker (the NC's today), drawn as
  it is.
- **A row that holds a switch is not lit when marked.** The switch shows the state; the marked
  wash would read as a selection. The reader still gets it checked.

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
check reports (§11).

**Revealed controls.** A `Control` may be `revealed_with(pane)`: it is drawn only while the
pointer is over that pane or focus is inside it. A notification's close button is the example.
It stays in the semantic tree and in the Tab order at all times, so a reader and the keyboard
always reach it. Its inverse is a text `hidden_with(pane)`: not drawn while that pane is under
the pointer or holds the focus, keeping its room. A notification's age gives its place to the
chevron that way, so the title line never moves.

**Leave and grabs.** Pointer leave clears hover and fades its wash. When a modal menu closes, the
surface passes `Window::root_pointer_position()` sampled before the popup is destroyed (#1030),
and `nk-view` recomputes hover from it. Hiding or disabling a control clears its states.

**What a control holds.** The texts inside a control are not labels of their own; a control
may carry a `description`, which a reader says after its name (a card's age and body).

**Readers' requests.** A semantic node's id belongs to its key and role for the view's life,
starting at `first_id`: a reader keeps ids across updates, and `nk-a11y` refuses an id that comes
back as another role, so ids are never numbered by position (a month change renumbered the
calendar and the whole bar left the tree). `semantic_keys()` says which control each id of the
last `semantics(_, first_id)` is, and `request(key, activate)` acts on it: focus moves there
(scrolled into view, the ring shown) or it is activated, as a click or Enter would. A disabled or
absent control does nothing.

## 5. The pane (the part of piece 3 needed now)

A `Pane` is one material shape on the surface. Its radius and material piece come from the
exported glass (`tokens/glass.json`). Its bounds are its child's placed rect. The surface keeps a
root material for pieces that are not panes, as today. `nk-view` adds one shape per visible
`Pane`, with that pane's state regions.

Only panes inside the viewport are declared, as B3.2 already does for cards. Whether Hyalo holds
a limit on shapes per surface is open: see the questions.

## 6. Motion (piece 4)

Two motions, both timed by the kit's motion tokens (`_tokens.scss`, exported in
`tokens/static.json`): the curves `ease` and `ease-emphasized`, and the durations `dur-base`
and `dur-slow`. A view holds no duration or curve of its own. With reduced motion, both land at
once.

**Reveal.** A node kind, `Reveal { open, child }`, for whatever opens and closes in place: a
group's cards, an expanded card's body and actions, a row that leaves. Its height is its
child's measured height times its progress, from 0 (closed) to 1 (open). The child is placed at
its full height, top-anchored, and clipped to the reveal, so it unrolls downward as
`Gtk.Revealer`'s slide down did in TS. The content's opacity follows the progress. Opening eases
with `ease-emphasized` over `dur-slow`, and closing with `ease` over `dur-base`. A change of
direction mid-way starts from where the reveal is. A reveal seen for the first time takes its
state at once, without animating.

While a reveal is not fully open, what is clipped away is neither hit nor declared. While it is
closed, its controls leave the Tab order and its subtree is hidden in the semantics. A pane
inside a reveal is declared clipped to the reveal.

**Slide.** When a rebuilt view moves a pane that was already placed (a card above it removed,
a group above it opened by the model), the pane and its contents move from where they were
drawn to their new place, with `ease` over `dur-base`. A pane that is new appears in place.
The per-frame relayout of a reveal in progress never starts a slide: the panes below it follow
the reveal directly. A view whose glass something else places turns slides off
(`set_slides(false)`): its panes land where each rebuild puts them.

Placement stays a pure function of the view, its size, its scale and the motion state at one
instant. `ViewState::tick(now)` advances the motion state, and reports whether anything still
moves so the surface asks for another frame.

**The glass goes with its content.** A pane is declared at its whole size, with what of it may
show as a clip (`add_shape_clipped`): a card a reveal cuts is cut straight where the reveal
ends, not drawn as a shorter card with rounded corners. Its glass is as formed as its content
is opaque, so a reveal or a swipe fades both together, as TS did.

## 7. Swipe to dismiss (piece 8)

A `Control` may be `swipe(action)`: a notification's card, which TS let you swipe away in
either direction, banner and NC alike.

- **Recognised.** A press on a swipeable control becomes a swipe once the pointer, still
  pressed, has travelled more than 8 px across and more across than down. Until then it is a
  press; a drag mostly downward stays one, which leaves the vertical for scrolling. A press on
  a control inside the card (its close, its chevron) never swipes: the innermost control takes
  the press, as in TS, where those buttons claimed it first.
- **Following.** Once recognised, the press is cancelled, so the release opens nothing, and
  the card follows the pointer across: the nearest pane holding the control, with all it holds,
  or the control alone when it lies in no pane. It follows one to one for 140 px, then shows
  15 % of further travel. Its content and glass fade with the distance, to 1 − distance/320,
  never below 0.15. Clips from outside the card stop cutting it across, so it can leave its
  list.
- **Released.** At 90 px or more from where the press began, it is flung off the surface in
  that direction, fading out; short of it, it settles back. Both use `ease-emphasized` over
  `dur-base`. When the fling ends, `tick` reports `Activated { key, action }` with the swipe's
  action, and the card stays hidden until the surface drops it from its model. The panes below
  then slide up (§6), which is what TS's collapsing row did.
- **Reduced motion.** Following is direct manipulation and stays. A fling lands at once, and the
  release itself reports it; a settle snaps back.
- **Lost.** If the pointer leaves the surface, the swipe settles back. If the control leaves
  the view, its swipe is dropped.
- **Cascade.** `cascade(keys, stagger, action, now)` flings the cards of several swipeable
  controls as if each were swiped away, top to bottom, `stagger` apart (TS's clear-all: 45 ms).
  Controls that do not show, or were already flung, are left out. Only the last one gone reports, with `action`, so the
  surface dismisses everything once; with reduced motion, or nothing shown, the call itself
  returns it.

The distances are the kit's, transcribed from TS (`ui/shell/common/ScaleRevealer.ts`), and live
in `nk-view` once, not in a surface. A swipe has no keyboard form: the card's close button is
the way to dismiss it from the keyboard, and it stays in the Tab order (§4).

## 8. Scroll (piece 5)

A node kind, `Scroll { child }`: a region that shows its child through a viewport, scrolled
vertically. It is the kit's `NidaraScrolled` (`ui/lib/nidara-kit/scrolled.ts`), which the TS
centre's list used, over GTK's `ScrolledWindow`.

- **Its height.** As tall as its content where there is room. In a column that runs short, the
  scroll regions give up height first, each in proportion to its content, through any pane or
  control between them and the column; the rest of the column keeps its place. The NC's list
  under the calendar is that case.
- **Its offset** is kept by key across rebuilds, clamped to the content and on the device grid.
  The child is placed at its full height, moved up by the offset and clipped to the region, as
  a reveal clips (§6): what is cut away is neither hit nor declared, and a card the viewport
  cuts is declared whole, cut straight.
- **Wheel and touchpad.** `ViewState::scroll(by)` moves the innermost region under the pointer:
  by pixels as a touchpad gives them, or by wheel detents, each the viewport's height to the
  power 2/3, GTK's step, which the TS list scrolled by. `nk-wayland`'s scroll events carry both
  (`ScrollAmount`: the pixels, and the detents when a wheel gave them, from the seat's
  `axis_value120`), and `ScrollBy::from` takes the detents when there are any. Hyalo gives a
  wheel notch as 15 px and one detent, so a notch moves a 400 px list by 54 px, not 15. A region at its end does not pass the
  scroll to an outer one, and a detent does not animate, as in GTK. The new offset is laid out
  at the next `tick`, which `animating()` asks for.
- **Keys.** Page Up and Page Down move by 0.9 of the viewport, and Ctrl+Home and Ctrl+End go to
  the start and the end (GTK's bindings and page size). They act on the region that holds the
  focus, else the one under the pointer, else the first. Tab onto a control out of view scrolls
  it in, by as little as shows it, as GTK's viewport did.
- **What is read stays put.** On a rebuild, a scrolled region keeps its first pane in view
  where it was drawn: a notification that arrives at the top while the reader is further down,
  or a row whose height changed above, does not move what is being read, and nothing slides
  (§6). At the top, new content pushes the list down, as it always did.
- **Only what shows is built.** `ViewState::window(key)` gives a region's offset and its
  viewport's height. The surface builds the rows that overlap it and puts a
  `Node::placeholder(key, height)` for each other row, at the height `ViewState::rect` gave
  for it when it was built. Nothing unbuilt is shaped. This is what B3.2's index does today
  for up to 2,000 records.
- **The bar** is the kit's one scroll bar, `nk-widgets`' `ScrollBar`, which the native Settings
  draws: moved out of its `Tree` so both share it, with its look exported in
  `toolkit/tokens/scrollbar.json` (`Tokens::scrollbar`). It is a pill painted in a lane of
  12 px at the trailing edge, shown by a scroll or by motion over the region, and faded out
  1,100 ms later over 250 ms, unless the pointer is on the lane or drags it. On the lane it
  widens from 4 to 8 px and shows a faint track. A press on the track jumps there, then drags,
  the thumb following the pointer one to one. While shown, the lane takes the pointer from
  what lies under it; hidden, it takes nothing. Its ends keep clear of the curve of the
  region's pane, where the region meets the pane's edge. It is content, not glass: it is
  painted with the view, as in TS.
- **Semantics.** A region is a scroll pane holding its panes.

What TS had and this does not, yet:

- **Kinetic scrolling and the bounce at the ends** of a touchpad scroll. `nk-wayland` reports
  neither the end of a touchpad scroll nor where it came from, and no Rust surface has either
  today.

## 9. Overlay (piece 6)

A node kind, `Overlay { base, layers }`: layers placed over a base, as TS's `Gtk.Overlay`.
The NC's cards use it for the close that floats over the card's top-left corner and for a
banner's action column at its right edge.

- **Size.** The base alone gives the overlay its size; the layers never add to it, as
  `Gtk.Overlay` measured only its child.
- **Place.** Each layer is aligned on each axis within the base (`Start`, `Center`, `End`, or
  `Stretch` to fill the axis), and kept an inset from the base's edges, in spacing tokens. A
  layer is measured within the base's width. It is not clipped to the base.
- **Order.** Layers come after the base, the last on top: over the base for the pointer (a
  close over the app's icon takes the press), after it in the Tab order and the semantics, and
  painted over it.
- **With the rest.** A layer is part of whatever holds its overlay: it is in the same pane,
  reveals and scroll region, and a swipe or a slide moves it with its card.

A view written as `Node::overlay(key, base).layer(across, down, inset, child)`. The `Stack(Z)`
this file used to keep room for is this node: a stack lays its children out along an axis,
and an overlay does not.

**A layer at a point.** `.layer_at(x, y, child)` places a layer at its natural size with its
top-left corner `(x, y)` from the base's, for what the surface puts beside something else
whose place it already knows: the CC's remove badge at a tile's corner, a size menu under
the tile that opened it, kept inside the viewport (§12.7). The point is the surface's, as a
grid's cells are; size, order and everything else are as for any layer.

## 10. Not in this contract

The tooltip (piece 9) and the calendar (piece 10). The NC keeps today's calendar. The tile grid
(piece 7) is §12, with the three things the Control Center needs besides it.

## 11. Acceptance for the NC pilot

The pilot replaced the old NC's drawing in `nc.rs` with a view over the same model
(`notifications.rs`). It ran behind a flag first; since 2026-11-10 it is the only NC, and `nc.rs`
keeps the month shown and the bulk dismissal.

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
   on banners and NC cards, and is a `Control` `revealed_with` its card's pane (§4), in a layer
   of an overlay over the card's content (§9). On a collapsed
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
- Expanding (points 4 and 5) needs the revealer, piece 4 (§6). Swipe to dismiss needs gestures,
  piece 8 (§7). The pilot ships with both, because the TS centre had them.

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
glass is redrawn. That is within budget. The pilot's "Cost" check (§11) measures it again on the
real NC.

That all N cards are drawn comes from the code (one call per shape, no cap) and from the GPU
time growing with N. It is not seen in a screenshot. The private Hyalo refuses screenshots,
because the run has no consent for computer control.

## 12. The Control Center (owner, 2026-11-11)

The CC is about 7,700 lines (`toolkit/shell/src/cc*.rs`) that place, hit-test, focus, wash and
paint by hand, as the NC did. It moves onto `nk-view` in three steps, each merged before the
next: **the detail pages** (`ccdetail.rs`: Wi-Fi, Bluetooth, VPN, Ethernet, sound, brightness,
battery, clipboard, media, screenshot, recording, network passwords), then **the grid and its
tiles**, then **edit mode**. Behaviour does not change in any of them: `CC.md` stays the
description of what the CC does, and each step is checked against it. Four kinds of node are
missing, and this section adds them.

### 12.1 Slider

`Node::slider(key, name, range, value, action)`: a control holding a value. The range is
`nk-widgets`' `ValueRange` (min, max, step, how the value is said, "4500 K"), the one the native
Settings slider holds. Its stepping, clamping and keys move out of `Tree` into a model both use,
as the scroll bar did (§8), so there is one slider and its rules are written once:

- **Pointer.** A press on the track puts the value under the pointer and captures the pointer;
  a drag keeps doing so, past the ends too; the release ends it. The press never starts a swipe.
- **Keys.** Left/Down a step back, Right/Up a step on, Page Up/Down `pageSteps` (10), Home/End
  the ends, as Settings has them.
- **Readers.** An AT-SPI slider with its value, minimum, maximum and step and the value's text;
  `SetValue` is a change like any other.
- **What the surface gets.** `Activated { key, action }` carrying the new value, on every change
  of a drag (the surface coalesces, as `ccdetail` does by `coalescing_key`), and once more on
  release. While the pointer holds it, a rebuild with an older value from the model does not move
  the thumb: the held value wins until release (`held` today).
- **Look.** Two, from tokens, never numbers in the surface: the **row slider** of a list
  (`components.json` `range.slider`: track 6, thumb 9, fill at 0.9, its value said beside it), and
  the **tile slider** of the CC (§12.4), which fills its tile as today. Hover, press and focus are
  §4's; the thumb is the hover's silhouette.

### 12.2 Text field

`Node::field(key, name, action, Field { shown, caret, anchor, secret })`: one line of text being
typed. nk-view **shows** it (its text, the caret and the selection), focuses it, gives the input
method the caret's rect and gives readers the field. It does **not edit** it: the text belongs to
whoever owns it, which edits it with its own rules. In Settings that is `nk-text`'s `Editor`; in
the CC it is `ccauth`'s password form, which bounds the length, refuses a paste that outlived its
question or field, and has no way to copy. Those rules are tested and guard secrets, so moving
the CC does not rewrite them.

- **A secret never enters the view.** The view is `Debug` and serializable, so a secret field is
  handed over as its bullets, one per character as typed, with the caret and the selection as
  offsets into them. Its reader node is a `Password` with EditableText and no text.
- **Focus.** A press or Tab focuses a field; a press never activates it. While a field has the
  focus, `ViewState::editing()` names it (a press anywhere else ends that), and the surface sends typed keys and the input
  method's text to its editor before §4's keys. Enter activates the field's action (submit);
  Tab and Shift+Tab move on; Escape is the surface's.
- **Input method.** `ViewState::caret(key)` is the caret's rect on the surface, for
  `TextInput`.
- **Look.** The caret is drawn while the field holds the focus, in the primary ink, 1 px wide and
  a line tall; the selection in the accent at 30 %, as the `search` component has it.

### 12.3 Painted slot

`Node::slot(key, size)`: room the surface draws in itself, for what is neither text nor glyph:
an app's or a notice's picture (the NC does this today by key, `nc_view.rs` `artwork`), the
battery ring, the resource gauges, a media cover, a clipboard thumbnail. `nk-view` places it,
clips it and gives its opacity (§6, §7); the surface paints it after the view, at that opacity
(`nk-render` `push_opacity`). A slot is not a control and has no hover; a control can hold one.

### 12.4 Tile grid (piece 7)

`Node::grid(key, columns, unit, gap, tiles)`: cells of `unit` with `gap` between them, each tile a
child at `(column, row)` spanning `(width, height)` cells. Today: 4 columns of 76, gaps of 20, at
most 8 rows; sizes 1×1, 2×1, 1×2, 2×2 and 4×1 (`cclayout.rs`).

- **Where tiles go is not decided here.** `cclayout.rs`'s pure rules (default packing, personal
  cells, moves, swaps, gravity, refusals) stay the surface's; the grid places what it is given.
- **Shapes.** A tile is a pane whose corner follows its size, as `CC.md` says: a 1×1 a circle,
  2×1 and 1×2 a capsule, a 2×2 corner 38, the 4×1 the dock's corner (24), never a capsule.
- **Edit mode.** A tile being dragged follows the pointer from its press offset; the others move
  to the preview the surface computes. The motion stays Hyalo's: tiles are its synchronized
  layers with the viewport's clip (`CC.md`, "Persistence and motion"), and no client timer
  drives them. Tab, Ctrl+arrows, Menu/Shift+F10, Delete and the named reader actions (Move,
  Resize, Remove) are the grid's keys, mapped to the surface's actions.
- **Rows past the viewport** scroll (§8): edit shows all eight rows.

Built (step 3): `Kind::Grid`; `Corner::Fixed` for the 2×2's 38 and the 4×1's 24; on a
control, `on` (filled with `--nidara-on`, its content in the accent), `surface` (a **well**:
at rest in `--nidara-surface`, its hover and press composited over it) and `keys_only` (no
pointer, still a Tab stop and a reader node); `Slider::fill`, the tile slider, whose value
runs up its height and whose content turns dark below the fill's top. Until edit mode moves
too, the editor places and scrolls the tiles, so the CC's view turns slides off
(`ViewState::set_slides(false)`, §6): its content stays with glass it does not move.

### 12.5 Acceptance, per step

As the NC's (§11): the CC alone, in Rust, never compared with TS on screen; the lines before and
after; every behaviour in `CC.md` kept, each with a check that fails without it; the headless CC
runs (`check-cc-headless.sh`, and `check-cc-edit-headless.sh` for edit mode) passing; and a look
in the owner's session with their OK.

### 12.6 Switch

`Node::switch(key, on)`: the on/off switch a row ends with where TS had a `Gtk.Switch`
(Ethernet, Wi-Fi, Bluetooth power, Night Light and its schedule, recording audio). A row that
picks one of several things keeps its check mark (§12.3); a switch is for a setting that is
on or off.

- **It is drawn, not pressed.** The switch is a leaf with no hover and no action of its own;
  the row around it is the control (`Role::Toggle`, `marked(on)`), so the whole row toggles,
  Tab stops once, and a reader hears one toggle button with its checked state, as GTK says a
  switch.
- **Measures and colours are the native switch's** (`components.json` `switch`,
  `toolkit/tokens/switch.json`): 44×24, a pill track in `trackColor` turning `checkedColor`,
  its 1 px border in `borderColor` turning `checkedBorderColor`, a thumb in `thumbColor` kept
  `thumbMargin` inside the track. While its row is disabled it is drawn at `disabledOpacity`.
  Nothing is a default: a field missing from the export is an error.
- **It moves.** A switch whose `on` changes between two views slides its thumb and blends its
  track over the motion tokens' `base` with `ease`, the same both ways, from wherever it is
  (§6); seen for the first time, or with reduced motion, it is at its state at once.
  Like a reveal, it moves only while the surface calls `tick` as long as `animating()`: a
  surface that never ticks leaves it at the start of its slide until something else lays it
  out (the CC's detail pages did, at first).

Not carried, as in the native switch: the kit's inset shadow, the checked glow and the thumb's
drop shadow (`nk-render` draws no shadows yet).

### 12.7 Edit mode (step 4)

Edit mode is one view, built by `ccedit.rs` from its model, laid out in the panel: a scroll
region (§8) holding the grid and the list of widgets to add, the error, and Edit/Done. The
grid's rules (`cclayout.rs`), the hold and its preview, the write barrier and the reader's
named actions stay the editor's; what it placed, hit-tested, focused, washed and painted by
hand is the view's.

- **Tiles** are controls on the grid's cells, keyed `e:t:<id>`, with no wash of their own:
  in Hyalo each tile is its own layer surface, which moves it and draws its focus, so a wash
  on the panel under it would never show. Without layers the grid view (§12.4) draws them,
  as before. A tile held by the pointer follows it from its press offset; the others are
  laid on the preview's cells.
- **Free cells** are panes on the grid at **opacity 0.16**: `Node::pane(...).opacity(o)`
  forms a pane's glass and content at `o`, multiplied with a reveal's or a swipe's.
- **The remove badge** (`e:x:<id>`, a 28 circle) is a layer at a point (§9) over the tile's
  top-right corner, 25 in and 3 above, on removable tiles only.
- **Widgets to add** are rows under the grid (`e:a:<id>`), disabled with the refusal as their
  description when the grid has no room.
- **The size menu** is a view of its own, at a point under its tile kept inside the viewport:
  a row per size the tile supports (`e:z:<size>`), marked when current, disabled with the
  refusal as a second line, and Remove for a removable tile. In Hyalo it is drawn on its own
  layer surface over the tiles' layers; without layers, on the panel. While it is open it and
  Edit/Done are the only controls.
- **Focus** is the view's: one key at a time across both views, Tab in the readers' order
  (Edit/Done, the tiles, the rows to add, the menu's rows), a focused row scrolled into the
  viewport. Ctrl+arrows, Menu or Shift+F10, Delete, Enter and Escape stay the editor's keys,
  acting on the focused tile.
- **Scroll** is the view's. A wheel step during a drag retargets the held tile's cell from
  where the grid is laid out after the step, without a pointer move or a write.
- **Washes** are the view's hover, press and focus (§4). The preview cell of a held tile
  keeps its accent wash at 20 %, declared by the editor.

## 13. One kit (owner, 2026-11-12, #1079)

`nk-view` is the kit's one way to build an interface, for apps as well as the shell. Every
interface uses only kit components (SKILL.md, commandment 13); a component the kit lacks is added
here first, then used. `nk-widgets` keeps serving Settings until each of its components has
moved here, and is then retired. Nothing in §1–§12 changes for the surfaces already built on
this contract.

### 13.1 What a component is

- **A function in `nk-view` that returns a `Node`**, built from the node kinds of §2. It takes
  its content and state as arguments and its measures from `Tokens`. It holds no number for a
  position, size or gap: what it needs that the scale does not have is a token of its own,
  exported with the others (`components.json`), never a literal in the function.
- **It declares its role, name, state and named action** (CATALOG.md), so readers and agents
  get it from the same value.
- **Its keyboard is the view's** (§4): what it adds (a checkbox's Space, a radio group's arrows)
  goes into `ViewState`, not into the app.
- **It has one copy.** A component that exists in `nk-widgets` too moves here with its
  behaviour (focus, IME, keys, readers, agent risk), and the `nk-widgets` copy goes when its
  last user does.

### 13.2 An application window

An app is an `nk_wayland::Application` whose content is one view, as a shell surface is:

- **`Tokens::load(exports, appearance)`** reads the kit's tokens in the user's appearance from
  the exported settings data. The shell passes its always-dark skin; an app passes the portal's.
- **Each change rebuilds the view** from the app's model; `ViewState::layout` places it in the
  window's size. Paint, hit-testing, focus, the material (glass and state regions) and the
  semantic tree all come from that one layout.
- **Input goes to the view**: pointer motion, buttons, scroll, and keys through
  `KeyInput::from_key`. An activated control comes back as its named action.
- **Readers** get `ViewState::semantics` through `nk_a11y::bridge::Bridge`.
- **Window controls are Hyalo's** (`nidara-window-controls-v1`, commandment 12).
- **The window's frame is the kit's** (`nk_view::FrameStyle`), the format Settings defined, so
  every app has the same window: the glass sidebar floating at the header's inset, the content
  in the scroll region `frame/content`, reaching the window's edges and starting below the
  header band, the band over it in a layer of its own with Hyalo's graded blur and the
  window's background faded on it, the page's title in the band, and Hyalo's window controls
  placed by `controls_at` on the side the user chose. Its measures are the exported `header`
  component's (`toolkit/tokens/header.json`); an app passes its sidebar, its content and its
  title. A press on the band where nothing else is moves the window; two toggle maximised.
  The band carries Settings' buttons on their own glass, in a layer over the blur (which
  takes no pointer): the sidebar's toggle, then back and forward, from the page's edge (after
  the window controls when they are on the left and the sidebar is closed) — the toggle is
  the band's, never over the sidebar (owner, 2026-11-12) (`BACK`, `FORWARD`, `SIDEBAR` are
  their actions). `Sidebar` slides it with the kit's motion and, below `WINDOW_LAYOUT`'s
  sidebar plus content, closes it and opens it over the page instead, where Escape or a
  choice closes it again.
- **Glass is for what lies over content** (owner, 2026-11-12): a sidebar, a menu, a popover, a
  tooltip, a button. A section of a page is a **group** (`Node::group`), Settings' card on the
  window's background (`--nidara-surface`, `common.groupRadius`), with its caption above it.
  A button inside a group stands on its own glass; a row of a group has none, and the view
  paints its states (§4, "Off glass").

### 13.3 The gallery

`toolkit/gallery` (`nk-gallery`) is the kit's own application, like GTK's
`gtk4-widget-factory`: it shows every component, and it is built only from kit components.

- **A page per component**, showing each of its states (normal, hover, pressed, focus,
  disabled, on, checked, mixed) side by side. A page names the component's CATALOG.md entry and
  its GTK4 and AppKit equivalents.
- **A status page** lists the whole catalogue (`toolkit/gallery/catalogue.json`): which
  components the kit has, which it lacks, and which surfaces use each one.
- **It follows the user's appearance** (light, dark, reduced transparency, accent) and runs at
  any scale.
- **It is the reference for tests.** `toolkit/gallery/check-headless.sh` opens every page in a
  private Hyalo and keeps its pixels and its AT-SPI walk as evidence.

### 13.4 Done

A component is in the kit when, in one change: its function is in `nk-view` with its tokens;
its page is in the gallery with every state; the gallery's check covers that page; and its row
on the status page says so. A surface may use only components that are in the kit.

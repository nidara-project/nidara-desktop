# Nidara — Design system & SCSS conventions

Read this when editing any SCSS, adding a new visual component, changing tokens, or deciding whether to use Adwaita or pure GTK4 for a new surface.

## Nidara vocabulary

- Glass capsules; blur ~40px (SCSS preview) or real blur from Hyprland (production).
- 1px inner white border, soft outer shadow, top sheen.
- **Accent color is for active/selected state only.** Never for normal borders or normal buttons.
- **Accent is NEVER a text colour** — not even for the active/selected state. It doesn't contrast reliably on every background. Active/selected text reads in the mode-aware token (`--nidara-text`/`-secondary`/`-dim`, `#fff` dark / `#000` light); the accent conveys the state via **background fill, tinted background (`--nidara-accent-10`), or border** instead (e.g. active workspace number, calendar "today", selected segment, chips/badges, suggested alert button = bold not accent). The one exception is white text *on* an accent fill (`--nidara-accent-fg`). Symbolic **icons** may still tint to accent (not text).

## Section headers bind DOWN, not symmetric

A settings group is a `NidaraList(title)` (`lib/nidara-kit/list.ts`): an uppercase
`.nidara-list-title` label above a `.nidara-list` card, wrapped in a `nidara-list-group` box.
The **gap below the title (title→its card) is deliberately tight and the gap above it
(previous group→title) is large** — the header must read as belonging to the card it labels,
not floating halfway between two cards (macOS System Settings / Adwaita `AdwPreferencesGroup`
convention). Concretely: the group box is **`spacing: 0`**, the title→card gap is owned entirely
by `.nidara-list-title`'s **`margin-bottom` (8px, the single source)**, and the group↔group gap
is the page-level **`settings-page` `spacing: 24`**. Don't "balance" these into a symmetric gap —
it was symmetric once (`spacing:12` + `margin-bottom:6` ≈ page `24`, visually ~equal) and read as
the title detached from its content.

Consequence for **footnotes appended after a card** (a `.nidara-row-subtitle` caption added with
`group.box.append(note)` — Power/Dock/Autostart do this): because the box is now `spacing:0`, give
the note an explicit **`margin_top: 8`** so it binds up to the card it annotates (the same 8px
attachment gap; don't rely on the old box spacing, which is gone). A page that hand-rolls its own
group instead of `NidaraList` (AppIcons wraps the ListBox in a ScrolledWindow) must likewise use
`spacing: 0` on its `nidara-list-group` box, not `12`.

**Prefer the built-in footer to a hand-rolled note.** `NidaraList(title, extraClasses, footer)`
takes explanatory prose and prints it as `.nidara-list-footer` under the card, indented to the
title's left edge with the same 8px attachment gap. Use it for the scope a title cannot carry —
Settings → AI states WHICH agents each permission group governs there, because some apply to every
agent and some only to the built-in Assistant. Per-row explanation still belongs in the row's own
subtitle.

## Wrapping prose FILLS its column — never `halign: START`

Any label that can wrap (row subtitles, list footers) must be built
**`halign: FILL, hexpand: true, xalign: 0, wrap: true`**. It is not a style preference:

A `halign: START` label is allocated its NATURAL width, and a wrapping `GtkLabel`'s natural width
is **GTK's own line-balancing heuristic**, not the space available. So every description picks its
own break column and the page reads as random — one row on a single line, the next broken at some
other width, for no reason a user can see. Measured live on Settings → AI (2026-07-27, via
`ags request queryUI .nidara-row-subtitle`): fourteen subtitles in one page came out **310, 332,
369, 372, 442, 456, 480, 486, 493, 501, 540, 556, 567 and 589 px** wide. With FILL they are 610 px
across every toggle row, and the only remaining variation is the rows whose trailing control is
wider (a dropdown, a path label) — which is structural and reads as such.

`max_width_chars` does NOT fix this. It only caps the natural width, so it removes the widest
outliers and leaves the heuristic in charge underneath — it looked identical on screen.

**Verify wrapping with `ags request queryUI <selector>`, not with your eyes on a screenshot**: it
reports each node's real `bounds`, so "do these all break at the same column?" is a set of numbers
rather than a judgement call.

### A TITLE is the opposite case: one line, ellipsised (2026-08-11)

`NidaraRow`'s title is **`wrap: false, ellipsize: END`**, and it is not the same decision as the
subtitle above it — prose wraps, a label does not:

- a wrapping label's **minimum** width is its longest word, so a wrapping title makes the whole row
  squeezable down to that. That is how a settings page ends up "almost vertical": before the pane
  had a floor, the text column reached **47 px** and descriptions came out one word per line.
- `nidara-row--single/--double` **declare** the row's height (48/72). A title that may take two
  lines makes that declaration true for some rows and false for others — precisely the "lists
  breathe differently from page to page" the height tokens exist to end.

What actually overflows there is not setting names (they fit at 800 px in every shipped locale)
but hardware strings: Settings → Audio renders `Starship/Matisse HD Audio Controller Analog Stereo`
as a title, and it took three lines. Ellipsis is the right answer to that, wrapping is not.

⚠️ And do NOT reach for `max_width_chars` to tame one: it caps the label's natural width, so it
truncates strings the row had room for. Two of those stubs were left over from when the pane could
shrink (Audio's device rows, cut at 234 px inside a 688 px row) and were removed with the pane's
width becoming a constant. The row's own width is the only bound a title needs.

⚠️ **A row that carries `.nidara-row` is not the same thing as a row built by `NidaraRow`**, and
the class is what makes the difference invisible: it supplies the chrome (hover, radius, margin)
while the height class, the title's ellipsis and the subtitle's fill live on the COMPONENT. Twelve
Settings rows sat in that gap until 2026-08-11 — Sound's six had no declared height at all, and
Power's three profile rows measured 44 px against a 48 px token in a page whose other rows were 72.
If a list is empty, its row is **`NidaraEmptyRow(text)`** (dimmed, left-aligned to the same edge as
a real title, and neither selectable nor activatable — a message that takes the hover state claims
to be a control). A page-level "there is no hardware at all" statement is the different thing:
`.settings-placeholder`, outside the card. See tech-debt #65 for both, and for why that class
silently styled nothing for five months.

## The Settings window has ONE geometry law — `WINDOW_LAYOUT` in `ui/lib/tokens.ts`

**The content pane is a CONSTANT 800 px.** Not a maximum, not a band: the same width on all 18
pages, in every locale, at every text scale. Widening the window adds empty margin; narrowing it
spends that margin, then makes the sidebar float, then hits the window's minimum. Written out,
with S = sidebar (250), C = content (800), and W the width INSIDE the window's 1px glass rims
(so a window is `W + 2` wide — the breakpoint is deliberately in rim-space, because at exactly
`W = S + C` the docked pane must get exactly C):

| available width W | sidebar | content |
|---|---|---|
| `W ≥ S + C` | docked | C, centred in W − S |
| `C ≤ W < S+C` | floating (popover) | C, centred in W |
| `F ≤ W < C` | floating | W — the pane YIELDS (see the floor below) |
| `W < F` | — | refused by `set_size_request`; a compositor that forces it anyway gets horizontal SCROLL, not a clip |

It is continuous: at `W = S + C` both rows give the same content width, so the sidebar leaving does
not resize the page under the pointer.

⚠️ **The floor is the DISTRESS width `F` (560), not the pane** — and that is a compositor fact, not
a preference. `set_size_request` reaches Hyprland as `xdg_toplevel.set_min_size` and **Hyprland
tiles at whatever the layout says anyway**: with the floor at the pane's 802 and Settings in a
673px tile, GTK laid the window out at 802, the compositor cut the last 129px, and a row's trailing
button went with it. Unreachable controls are worse than tight text. ⚠️ Nor can the floor be made
conditional on being tiled — **Hyprland never clears the `tiled` toplevel state**: measured on a
window it had just floated and resized to 600×800, GTK still carried `tiled-top`, `tiled-left`,
`tiled-right`, `tiled-bottom` and `maximized`. A floor that reads that state never comes back.

None of which is the elastic band: `C` is the width pages are DESIGNED at — the size the window
opens at, and every width where the sidebar docks — and `F` is only what happens in a window too
small for the design, where the question is merely which way to fail.

**Three things enforce it, and all three have to stay in step** — `NidaraClamp(page, C, true, C)`
(min === max), `NidaraSplitView({ collapseAt: S + C })`, and `win.set_size_request(C + rims, …)`
in `NidaraWindow`. The window derives the last two from `contentWidth`, so a caller only states C.

**What it replaced, and why none of it was noticeable one page at a time** (all measured live
2026-08-11, `ags request queryUI` × 18 pages × window widths):

- the collapse breakpoint was DERIVED from the active page's natural width, every 200 ms. At a
  850 px window, 16 pages kept the sidebar docked and **Appearance and Region** — the two carrying
  a 320 px preview — collapsed it. Navigating Display → Appearance made the sidebar vanish and the
  page jump 518 → 720 px. A breakpoint is a property of the WINDOW, never of what is inside it.
- content width was **not monotonic** in window width: 900 → 568, 800 → 468, 700 → **618**,
  600 → 518. Narrowing the window made the page wider at the breakpoint, because collapsing hands
  the sidebar's 250 px to the content.
- the clamp had a ceiling and no floor, and `NidaraSplitView`'s ZeroMinOverlay deliberately severs
  the content's minimum from the window — so nothing stopped a drag. The window went to **250 px**
  with the page stuck at 403 and CLIPPED.

**Why 800 is the number**: it is what the widest ROW needs. Across all 18 pages the widest trailing
control is 388 px (Appearance → Accent color), then 324 (Region) and 315 (a slider row). At C = 800
the page inside its `$space-10` padding is 720 and a row's content box 688, leaving the widest row
~347 px of text column — about 40 characters. Below ~720 that budget starts breaking titles
(Appearance at 518, most pages by 418). Which is also the argument against an elastic band: between
640 and 800 there is nothing to gain and a text column to lose. A constant buys the row contract ONE
width to be correct at, forever. (Prior art: macOS System Settings has a hard minimum window and
never reflows its content pane.)

**Check it with the instrument, not by opening the window**: `node scripts/dev/settings-geometry.mjs`
sweeps every page at several window widths and asserts the three invariants (same pane width across
pages, same pane width across window widths, floor holds). The failure mode here is invisible one
page at a time — that is the whole reason it exists.

## Scrollable boxed list — card on the ScrolledWindow, not the list

When a boxed list must scroll INSIDE a fixed card (App Icons' installed-apps list), the card
chrome (`@include material-card` — bg/border/radius) goes on the **`ScrolledWindow`**, not on the
`ListBox`. If `.nidara-list` sits on the scrolling `ListBox`, its own rounded top/bottom + border
scroll out of the viewport → you see a **cut-off rectangle** (bug fixed 2026-07-04). Pattern:
`scrolledwindow.<foo>-scroll { @include material-card; padding: 3px; > viewport, list { @include
nidara-reset; background: transparent; } }` and a transparent `ListBox`. Also set
**`overlay_scrolling: false`** so the scrollbar takes its own gutter instead of floating over the
rows' trailing controls (buttons). The shell scrollbar is already themed (`_reset.scss`, scoped to
`.nidara-settings-window` etc.) as a thin pill.

## Any ScrolledWindow: use `NidaraScrolled` — windows included

**What was wrong with GTK's scrollbar was not that it was interactive. It was that it GREW.**
GTK expands the overlay slider on pointer *proximity* — it sets `.hovering`/`.dragging` on the
node itself, which is not the CSS `:hover` — so the bar reaches out toward whatever the pointer
is approaching. When a list's rows carry a control at their right edge (a close ✕, a chevron),
the bar gets there first and eats the click. This recurred three times (Settings lists → the
Assistant transcript 2026-07-21 → the clipboard rows 2026-08-03) and **CSS cannot win it**:
Adwaita's `scrollbar.overlay-indicator.hovering slider` beats any specificity we can write
in-process, its base slider rule also carries `border: 4px solid transparent` (8px of invisible
real width) that takes over exactly when hovered, and `set_can_target(false)` does nothing
because proximity expansion is independent of event targeting.

So the answer is **a bar of fixed width in a reserved lane** — not a bar you cannot touch.
(A first pass dropped dragging entirely; the user rejected it as a regression, correctly: the
drag was never the problem.)

**`NidaraScrolled`** (`lib/nidara-kit/scrolled.ts`) is the one scroll view for the whole DE,
overlay surfaces and windows alike. `vscrollbar_policy: EXTERNAL` keeps the scrolling (wheel,
touchpad, kinetic, keyboard) while GTK never creates a scrollbar widget — no node left to grow,
no Adwaita rule left to fight. The bar is ours: a `Gtk.Box` in a `Gtk.Overlay`, sized from the
adjustment, dragged by a `Gtk.GestureDrag`.

- **One stationary `Gtk.DrawingArea`, full height.** The whole lane is the hit area and the thin
  pill is *painted* inside it. Its colour comes from the widget's CSS `color` read back via
  `get_style_context().get_color()` — the same trick as `common/WorkspaceSchematic.ts`, and the
  only way to stay token-driven from nidara-kit, which cannot import ThemeManager.

### The settled spec (2026-08-03 — decided with the user, do not re-litigate)

| | Rule |
|---|---|
| **Alignment** | The bar sits at the **trailing edge of the scroll viewport**, and every surface's viewport must reach its own **visible inner edge**. One rule for panels and windows. Before this was written down there were three: the clipboard bar sat 14px in (it inherited `expansionInner`'s margin), Settings sat at 0, the NC/Assistant somewhere else again — which is exactly what the user noticed.  ⚠️ **Padding on the CARD is outside the scroll** — it pushes the viewport in and takes the bar with it. The Settings dropdown had `padding: 6px` on `popover > contents`, so its pill sat 10px from the wall (6 + `EDGE_CLEAR`) against 4 on every flush surface, and the whole list read as roomier than the menus it sits among. The row inset belongs on the ROWS (`listview { margin: 0 6px }`), the card keeps nothing (`contents { padding: 0 }`), and the bar then needs the card's radius as `cornerRadius` because flush means it runs into the corner. Splitting the inset across two boxes is how you end up with a card padding and a list margin **both** live, which measures 13px at the top against 7 at the sides.  🔑 **Sides only, and on purpose** — see "A vertical inset on a scrollable list is viewport, not air" below. |
| **Content inset** | **What has to clear the lane is a row's trailing CONTROL, not its fill.** The lane may be wider than the content's inset — the pill then floats over the fill's last pixels, which is what an overlay scrollbar does everywhere. It must never reach a ✕ or a switch, and it does not have to: those sit inside the row's own trailing padding, so on the clipboard the ✕ lands 18px in (6 halo + 12 row padding) against a 12px lane. This replaces the earlier rule "content inset ≥ lane", which was true of the insets of the day (12–14) and became a trap when the halo dropped to 6: it made a scrolling list look airier than a static one for no reason the eye could name. `reserveLane` (default true) pads the child by `lane` on BOTH sides and is the fallback for content with no inset of its own; pass `false` whenever the content has one, or it pays twice (the CC detail panel sat at 18 that way). |
| **Widths** | Pill **4px at rest → 8px hovered/dragging** = `$space-1`/`$space-2` on the project's 4px scale. Not free-hand numbers — the earlier 5/9 were, and the user caught it. Lane **12px** (`$space-3`), and it must stay ≥ 8 so an expanded pill never leaves the lane. |
| **Hover** | The pill grows; **the hit lane never does.** That distinction IS tech-debt #15 — GTK grew the *hit area*, which is why it could eat a neighbouring button. Growth is safe on every surface precisely because the lane is measured from the viewport wall and a row's trailing control clears it — see Content inset. |
| **Persistence** | Auto-hides everywhere, windows included: reveal on scroll or on pointer motion in the view, fade after 1.1s. One behaviour across the DE. |
| **Corners** | The pill keeps `CORNER_CLEAR` (4px) from the curve exactly as it keeps `EDGE_CLEAR` (4px) from the wall — **one rule, every boundary** — and how far that is comes from the arc, not from a table: `⌈r - √(r² - (r - 4)²)⌉ + 4`. So `radius-md` 16 → 10, `radius-lg` 24 → **15**. Pass `cornerRadius` with the surface's own token wherever the view runs flush into it, and `cornerInset` with however far the view already starts inside that corner (else the allowance double-counts and the pill floats in dead space). ⚠️ **The bare arc expression is TANGENCY, not clearance** — it was the formula until 2026-08-03 and looked fine only because a *window's* visible corner is Hyprland's `rounding_power 3.2` **squircle**, which is squarer than a circle and leaves slack the maths never promised. A Cairo capsule drawn `perfect: true` is real circular arcs and has none: moving the bar-expansion panel from radius 20 to 24 in the token audit left the clipboard pill 1.27px off the curve, and the user saw it immediately. |

**`barExpandedFlush`** (`AtomicWidget`) is how a bar-expansion panel opts out of the 14px
horizontal inset `Bar.tsx` gives every panel, so its scroll can reach the edge; the widget then
owes its own content that inset (`PANEL_PAD` in `widgets/clipboard.ts` — keep the two in step).
- 🔑 **A scroll position is not a layout property.** The first version built the bar from boxes
  and moved it with `margin_top`/`height_request`, which produced three bugs from one mistake:
  the **drag lagged** (`Gtk.GestureDrag` reports offsets in the coordinate space of the widget
  it is attached to — and that widget was being moved *by the drag*, so the origin moved every
  frame), and the view **flickered with ghosted content** (changing a size request from an
  adjustment notify, which fires *during* allocation, queues another resize on every scroll
  step). Scrolling must only `queue_draw()`. Put the gesture on something that never moves.
- **`reserveLane`** (default true) pads the child by `lane` so content never sits under the
  bar. Pass `false` where the caller's CSS already reserves it (`.nc-content-box` 8px,
  `.agent-transcript` 16px) or where nothing lives at the right edge (a clamped Settings page,
  the app grid's centred flowbox).
- Geometry never depends on allocation: `page_size` IS the viewport height in a ScrolledWindow,
  so the thumb is right on the first notify, before being mapped and measured.
- The lane is targetable **only while visible** — a faded-out lane that still took clicks would
  swallow them invisibly, which is the very bug this replaces.
- `alwaysVisible` for content where the bar doubles as a position readout.

Migrated: clipboard panel + CC detail (`IslandGrid`), notification centre, Assistant transcript,
every Settings page (`wrapPage`) plus the app/autostart lists and search results, app grid, and
in the kit itself the **`NidaraWindow` sidebar** (the `NidaraSelect` list was migrated too, then
deleted with the component in the token audit — Settings uses `NidaraDropDown`).

**`new Gtk.ScrolledWindow` now appears exactly twice in the tree** and that is the invariant to
check when this claim is made again: `scrolled.ts` itself, and `IslandGrid`'s `gridClamp`, which
is a width clamp with `NEVER` on both axes (`propagate_natural_width: false` reports a width
independent of its child) and therefore has no scrollbar node at all. Anything else is a miss —
the kit's two were missed on the first pass precisely because the surfaces looked done.
A window's sidebar is not an exception; it sat two panes from ours looking like another component.

`_reset.scss`'s native-`scrollbar` fallback stays, but it now covers only GTK internals we do not
construct (`Gtk.DropDown`'s popup list is the live one — Settings uses it for blur, see the
dropdown tradeoff). Its existence is not a licence to leave a Nidara-built view unmigrated.

⚠️ `NidaraScrolled` returns an **overlay wrapping the view**, so anything positional belongs on
the wrapper, not on the `scrolled`: margins (the sidebar's 4px gap to the search slot moved from
CSS into `window.ts` for this — a margin on the view alone leaves the lane taller than the
viewport it maps to, and the thumb drifts from the content) and any `width_request`/`measure`
that positions a popup around it.

**Do not add `scrollbar` rules for any of them** — there is no such node. `overlay_scrolling:
false` is no longer needed anywhere and should not come back: its gutter appears WITH the bar,
so content resizes the moment a view starts overflowing.

The user's ask that settled the lane part (2026-07-21, Assistant transcript): *thin, as far
right as possible, and it must not affect the chat's content or size*.

## Search field — `.settings-search` box, never `Gtk.SearchEntry`

A search input on a shell/Settings surface is a **`Gtk.Box.settings-search`** holding an
`Icons.search` (`nd-icon`) + a `Gtk.Text` — NOT a `Gtk.SearchEntry`, which forces the icon theme's
magnifier glyph (off-brand, wrong on the opposite mode). Wire filtering off the `Gtk.Text`'s
`changed`. The Settings sidebar search (`Settings.tsx`) is the reference; App Icons repeated the
`SearchEntry` mistake and was corrected (2026-07-04).

⚠️ **If a surface types INTO that `Gtk.Text` from its own key handler, move the caret yourself.** The
app grid takes keys at the window level (the focus grab routes them there so the same keystroke can
also drive grid navigation) and pushes characters into the **buffer**:
`buf.insert_text(buf.get_length(), ch, 1)`. A `GtkEntryBuffer` has no cursor, and `Gtk.Text` only
advances its position from its own editing path — so the letters land correctly and the caret sits at
column 0 forever. Nothing warns. Follow every buffer mutation with `entry.set_position(-1)`
(GtkEditable: "after the last character"), ideally by routing all of them through one helper, as
`AppGrid.tsx`'s `searchInsert`/`searchBackspace` now do. Shipped broken; user-caught 2026-08-10.

⚠️ **Do not tint the magnifier on focus.** It is an `nd-icon`, so `color` cannot reach it — the glyph
is monochrome and driven by `-gtk-icon-filter: invert(1)`, a black/white toggle, not a recolor (see
"Most icon glyphs cannot be CSS-recolored" below). The focus signal belongs on the BOX: border and
fill. An accent rule on the app grid's search icon was written, was dead for other reasons, and was
deleted rather than repaired once that was understood (2026-08-10).

## Ghost descenders on filter — FIXED AT THE ROOT 2026-08-11, not by a line height

Historical, because the workaround is gone and the reasoning is worth keeping: list subtitles
used to leave the tails of `y/g/j/p` behind on a filter re-layout, and the shipped fix grew the
line box of one list (`.apps-list .nidara-row-subtitle { line-height: 1.35 }`) so the ink lived
inside the label's text node. It read as a GskGL damage bug for a month.

It was not. The line box itself was wrong — unrounded font metrics meant the box the toolkit
reported did not contain the ink it drew, so any re-layout repainted the box and left the rest
on screen. The same defect shaved the tops of flat glyphs (T E F H I L) everywhere else. See
"Text is only crisp when the line box lands on WHOLE PIXELS" (at the end of this file) for the
fix and the measurements; tech-debt §29 for why the wrong diagnosis held for a month.

## Radii — ONE ladder, in `ui/lib/tokens.ts` (audited 2026-08-03)

`RADIUS` in `ui/lib/tokens.ts` is the source; `--nidara-radius-*` in `_base.scss` is a
**mirror**, and both files say so. The ladder governs **container corners**; rounding *art* is a
separate job (a ratio of the bitmap's own size, painted by `squircleThumb()`), and those numbers
are not rungs — see `tech-debt.md` #48 for the three that currently disagree. Cairo cannot read a CSS var — a corner that clips has
to be known in px — so the duplication is deliberate and labelled. **There are no radius
literals left in TS/TSX, nor in `ui/shell/styles/*.scss`** (use `$nidara-radius-*`, the SCSS
alias of the same vars); that is the invariant to re-check when adding a surface. **Since
2026-08-09 the greeter and lockscreen are covered too** — see "The design system reaches the
greeter and the lockscreen" below.

| Token | px | What wears it |
|---|---|---|
| `xs` | 6 | chip, badge, segmented button |
| `sm` | 10 | button, input, dropdown, list row |
| `md` | 16 | card inside a window (settings group, sidebar capsule) |
| `lg` | 24 | window chrome, and any floating popup of the shell — system menu, **bar expansion panel**, CC context menu |
| `xl` | 32 | island / overlay directly on the wallpaper: all five island modes, app grid, Prism, NC cards, CC islands |
| pill | 9999 | capsules |

There is no percentage rung. `--nidara-radius-squircle: 28%` was documented here as "only for
app-icon plates" and **had zero consumers in any bundle** — the plates wear `lg` like everything
else. It could not have had one either: it was meant for rounding *art*, and **GTK4's
`border-radius` does not clip a child's rendering** (that is why `squircleThumb()` exists).
Deleted 2026-08-03. The same rule retired `.prism-result-icon`, a rule whose entire body was
`border-radius: 8px` on a background-less `Gtk.Image` — it had been rounding nothing since it
was written. **A radius on a node with no background of its own is decoration in the
stylesheet, not on screen.**

Three things this ladder is not, all of which came up in the audit:

- **It is not the 4px spacing scale, and must not be "corrected" onto it.** Spacing is
  additive (gaps sum down a column, so a shared divisor matters); a radius ladder is
  multiplicative — what matters is the ratio between rungs. Material 3 ends its ladder on
  28, Tailwind's has a 6. Ours runs ×1.67 ×1.60 ×1.50 ×1.33, decreasing and smooth.
- **`sm` is derived, not chosen.** A `.nidara-row` sits 5px inside a `.nidara-list`
  (1px border + 3px padding + 1px margin) and the concentric radius for a 16px card at
  that inset is 11 — the 10 is that, rounded to the rung. Nested corners only stay
  parallel while `inner = outer − inset` roughly holds, so **if you change the card's
  padding you have to re-derive `sm`**, and vice versa.
- **Radius does NOT scale with the surface.** The Workspace Overview is ~1684px wide, the
  widest thing in the shell, and it sits at `xl` like a 200px recording island. It was 64
  until the audit; it is also one of five modes morphing out of the same capsule through
  `MorphRevealer`, which interpolates the radius, so an odd one out is visible in motion.

- **A radius past half the box's short side is a STADIUM, not a rung — say `pill`.** The SCSS
  sweep found two numbers hiding as ladder values: the active workspace dot (`4` on a box 6px
  tall) and the NC header badge (`12` on ~17px). Both were already clamped by GTK to the same
  capsule they would draw at `pill`, so writing `pill` changed no pixels and removed two
  off-ladder literals. Check the height before you read a corner value as a radius.

⚠️ **Changing a rung has a second-order cost: it moves the scroll-pill corner clearance**
(`⌈r − √(r² − (r−4)²)⌉ + 4`, see the NidaraScrolled spec above). Going 20 → 24 on the bar
expansion panel is what put the clipboard pill on the curve. Whenever a radius moves, check
who passes it as `cornerRadius`.

## Spacing is TWO layers — only one of them is the 4px scale

The 4px ladder (`$space-1..10`) governs **gaps between elements** — margins, box spacing,
page padding. Those must be on it.

It does **not** govern **a control's internal padding**, which is arithmetic toward a target
box height. `button.nidara-btn` is `padding: 5px 14px` because 5 + 1px border + the line box
lands on ~32px, and the `Gtk.DropDown` trigger next to it uses `padding: 4px 14px` because it
carries a 2px border instead — both comments say so in `_components.scss`. The switch's
`slider { margin: 3px }` is (24px trough − 18px slider) / 2. **The number that belongs on the
scale is the resulting HEIGHT (24 compact / 32 control / ~48 row), not the padding.** Snapping
those paddings to `$space-1` does not tidy anything; it resizes every control in the shell.

Two more categories that are legitimately off-scale, both easy to "fix" wrongly:

- **Optical nudges on text** — `valign: CENTER` centres against a label's allocation, not its
  ink. These carry a comment and were settled against pixels; `design-system`'s own rule is
  *measure, don't reason* (see "Optical vs geometric centring"). Leave them.
- **Derived sizes** — `.accent-circle-btn` is `min-width: 30px` because it is a 24px swatch
  plus a 3px ring on each side.

When you add a control and reach for a padding value: pick the height first, then solve for the
padding, and say so in a comment. (Audit state and what is still off-scale: tech-debt #47.)

### Container padding — three tiers, by what the surface IS

Swept 2026-08-03. Each step is +4, and horizontal is always +4 over vertical:

| Surface | v / h | Who |
|---|---|---|
| **A list of rows on a shell surface** | **`rowInsetFor(R, n)`**, uniform, from the GLASS — radius **and exponent**. Every floating popup of the shell is a squircle at `lg`, so in practice they all land on **6** | bar expansion panels + clipboard, the **system menu**, the CC context menu, the **CC detail panel** (squircle `lg` → 6); the three `GlassBubble` menus (`lg` squircle body + arrow → 6); the Settings dropdown (circular `md` → 6, **sides only** — see below) |
| **Window row** | **12 / 16** | `NidaraRow` / `NidaraEmptyRow` — inside Settings that is now every row but the five documented opt-outs in tech-debt #65 |
| **Island** | **16 / 20** | all five island modes |

**That first row is not a tier — it is a formula, `rowInsetFor()` in `ui/lib/tokens.ts`.** A row's
hover fill spans its container, so the container's padding IS the fill's margin, and the goal is
ONE gap: the fill should stand as far from the corner's curve as it does from the straight edge.

```
d = (k(n)·R − k(2)·rowRadius) / k(2)        k(n) = √2·(1 − 2^(−1/n))
```

`k(n)·R` is how far a `drawSquircle` corner reaches along its 45° diagonal (its path is
`|x/R|ⁿ + |y/R|ⁿ = 1`, so the diagonal point sits `R·2^(−1/n)` from the corner centre). For a real
circle it collapses to plain concentricity, `d = R − r` — the same rule that derives `sm` from the
`.nidara-list` inset, one level up.

⚠️ **The exponent moves the answer more than the radius does, and that is not a footnote.** At `lg`
24: a circular corner asks for **14**, an `n: 3.2` squircle for **6**. Two surfaces of the *same
radius* legitimately take insets that differ by 8px, because a squircle is nearly square and simply
does not intrude. Getting this wrong is what the user caught twice — first a flat `12` that was
double what a `md` bubble wants, then the circular answer applied to every `lg` surface, which left
the system menu and the CC panels reading airy while the bubbles next to them looked right. Pass
the `n` the surface is actually painted with: `SquircleContainer` defaults to **3.2**,
`perfect: true` means **2**, a CSS `border-radius` is **2**, and `paintGlassBubble` takes an `n`
(default 2 for the tooltip, 3.2 for the menus — see the bubble section below).

**`perfect: true` belongs to CAPSULES, not to panels — and that is why every popup now lands on the
same 6.** In `Bar.tsx` every other `perfect` is a 40px-tall bar capsule, where it is what clamps the
corner to `min(w,h)/2` and produces the stadium. The bar expansion panel had inherited it from the
file it shares with them, and at `lg` it bought nothing but a *circular* corner — a different shape
from the system menu, the CC context menu and the CC detail island, which are the same family
(`lg` is literally defined as "any floating popup of the shell"). The user asked the right question
— *"shouldn't they all be squircles like the system menu?"* — and the answer was yes: one shape for
the family, and the halo falls out of it (14 → 6). **If a large surface reads airy next to a menu
right under it, check whether it is circular by accident before touching its padding.**

**The row's radius is the fixed side of the equation.** Varying a row's corner per container would
make the same menu row look different in the dock and in the system menu — a worse inconsistency
than any halo. Rows stay at `sm`; the container yields. Consumers write
`rowInsetFor(R) + GLASS_INSET`, because the box is laid out against the widget rect.

Uniform on all four sides, too. The +4 horizontal of the other two tiers is right while the padding
is a **text** inset; once the fill spans the box it is a margin, and it ran `12 / 6` until the user
caught the halo being twice as wide at the sides as at the ends. No menu system runs 2:1 (AppKit's
highlight is ~5/4pt, Windows 11 flyouts 4/4). The text's own breathing room lives on the row —
`.nidara-menu-row` is `7px 12px`.

**⚠️ The formula covers children that paint a FILL. Bare ink is not covered, and it looks wrong
at the same number.** `rowInsetFor` derives from concentricity — outer radius minus the child's
own radius — which presumes the child HAS a radius, i.e. a hover pill or a background of its own.
A child that paints none has nothing between its glyph and the cap's curve, so the identical inset
reads as "stuck to the edge". The greeter's locale-bar capsule is the case that made it explicit
(2026-08-16, user-caught): `padding: 4px` is exactly right for the two dropdowns inside it (32/2
outer − 24/2 clamped inner = 4) and left the bare keyboard glyph's ink 4px from the cap, while the
dropdowns' own `padding: 3px 8px` put THEIR glyphs at 12. Three times the clearance on one end.

The correction goes **on the ink**, not on the container's padding — the container's number is
derived and correct, and putting the difference on the bare child means reordering the row cannot
lose it. The number to aim at is **the clearance the ink already has from the straight edges**: a
12px glyph in a 32px capsule sits 10px off the top and bottom, so 12px from the cap is right —
marginally more at the curve, which is what a cap wants.

🔑 **What NOT to aim at is the opposite end's measured clearance.** Photometry said the ▾ on the
right cleared its cap by 17px, not 12, because GTK's arrow glyph does not fill the padding it
sits in. That 17 is an accident of a glyph, not a chosen number; matching it would have pushed a
dense square icon out to where a light triangle happens to land. Measure both, then align to the
DERIVED number and record why the other one was ignored.

Prism is the check that the formula is honest: its panel is `xl` 32 but `n: 4.5`, and the formula
gives **5.6** — which is why its long-standing 8 never looked wrong, while the 22 a circular 32
would have demanded would have been absurd. This is `cornerClearFor`'s lesson one level up: the
corner's squareness is a real quantity, not a hedge.

**A panel's header is a row too.** In the CC detail panel the back-button header sat at 10 from
the glass while the rows under it sat at 6 — two axes inside one card. The header's fill now keeps
its inset like any row, and its *content* takes the same 12 the detail rows use, so the title
and every row title share one left edge. The island is a fixed 356px, so this inset is paid out of
the row (340 → 328 usable) — a fixed-width surface is a reason to know the cost, not to keep two
axes.

**A bubble is not a different kind of menu — and by the end of the audit it is not a different
shape either.** The dock item menu, the app-grid item menu and the media source menu are
`GlassBubble` popovers rather than squircle cards, and they had their own `PAD = 5`, a *fifth*
halo. They go through `rowInsetFor()` like everything else. Then the user asked the obvious
follow-up — *"shouldn't the dock menus be the same too?"* — and the answer was the same as for the
bar panel: `lg` means **any floating popup of the shell**, so the three menu bubbles are now
painted at `radiusMax: RADIUS.lg` with `n: 3.2`, the shell's squircle. **The arrow is the only
thing that distinguishes a bubble menu; the box it hangs off is the same card as the system
menu's.** `paintGlassBubble` grew an `n` for this and defaults it to **2** — the tooltip is a
near-pill whose ends genuinely are stadium arcs, and it stays exact `cr.arc` rather than a
polyline. (`radiusMax` is a CAP, not a ladder rung — `paintGlassBubble` computes a near-pill
`min(w,h)/2` first — but it *is* the surface radius `rowInsetFor` derives from, so the two come
from one token.) (`radiusMax` in those calls is **not** a ladder rung and must not
be swept onto one.)

**The Settings dropdown popover satisfies both rules at once**, which is the sign the formula is
right. Concentricity gives 6 (`md` 16 − `sm` 10); the ALIGNMENT AXIS says the list is the trigger
*opened*, laid out at the trigger's width, so an option must sit on the same left edge as the value
it replaces — the trigger puts its label at 16 (2px border + 14 padding), so the popover is
`1 (border) + 6 (contents) + 9
(row)`. It was landing at 23 against that 16 — a 7px sideways jump on open, which on a narrow
list reads as "why is this padding so big" (user-caught 2026-08-03). Three numbers, one axis:
move one and the value appears to slide as the list opens.

⚠️ **Never copy a sibling's margin out of its constructor.** `Bar.tsx` builds `expansionInner`
with one value and **rewrites it on every open** (flush panels take the horizontal over), so the
number in the constructor is not the number that ships. The system menu was fixed twice for this:
the second fix read the constructor's `12`, wrote `12`, and stayed 2px tighter than its siblings
because theirs is measured after `+ GLASS_INSET`. Import the token.

**Menus are NOT a separate tier** — an earlier version of this section claimed a symmetric `8/8`
"menu tier" and it was wrong. It was invented to justify a blanket `sed`: `SystemMenu.tsx` held
`10/10` (not the panel's `10/14`), so sweeping by NUMBER turned it into `8/8`, and the tier got
written down afterwards to make that look deliberate. The user caught it from the pixels — a menu
row's hover fill spans that box, so the margin **is** the gap between the hover and the card edge,
and the system menu's sat **6px from the glass against the window menu's 12** (measured, both
minus `GLASS_INSET`). Both are bar surfaces; both take `8 / 12`.

Two rules out of that:
- **Never sweep a spacing value by its NUMBER; sweep it by its ROLE.** Read what the box is.
- **A tier you introduce to explain a change you already made is not a tier.** Derive it from what
  the surfaces are, then check it against pixels.

#### The SCSS side (swept 2026-08-03, second pass)

The TSX sweep left SCSS *padding* untouched on the theory that it is all height arithmetic. That
holds for controls and **not** for a container's section padding, so the stylesheets got their own
pass. The finding is the useful part: of 58 literal paddings in `ui/shell/styles/`, only a handful
were spacing at all — one genuinely off-scale gap (a `18px` breathing room) and the rest either on
the scale already or arithmetic. **They are now written as `$space-*` where they are gaps, so the
scale is enforced and not merely declared, and left as literals *with a comment* where they are
not.** Prefer the token; a bare number in a padding is now a claim that it is derived.

Two shapes of derived padding worth recognising, both of which a "tidy" sweep would break:

- **A gap measured from a rect, when the glass is painted inside it.** `.prism-results-list` is
  `10px` on the sides because `SquircleContainer` paints 2px in from the widget rect
  (`GLASS_INSET`), so 10 from the rect *is* `$space-2` from the visible edge. Same trap as the
  scroll-pill corner: what you write is the rect, what the eye measures is the glass.
- **An ALIGNMENT AXIS wearing spacing's clothes.** Prism's search field is `padding: $space-4 22px`
  and 22 is not a spacing value at all — a result row's text lands at 10 (list) + 12 (row) = 22, so
  the field and the results share one left edge. Before you correct a number, find out what it
  lines up with; if something else has to move with it, say so in the comment.

### Some off-scale numbers are an ALIGNMENT AXIS — check before "fixing" them

Prism looks like drift (`.prism-search` `padding: 16px 22px`, `.prism-results-list` `6px 10px 10px`)
and is not: a result row's text sits at list-padding `10` + row-padding `12` = **22**, and the search
field's `22` puts its text on that same axis. The one genuinely wrong value there was a section
label at `10 + 14 = 24`, 2px off its own rows — invisible as a number, visible as a ragged column.
Before snapping a value, find out what it lines up with.

⚠️ **`@mixin nidara-reset` does NOT clear `padding`** (it does background/border/shadow/outline),
and Adwaita gives every `list > row` 2px of it. That 2px silently offsets a row's whole text
column — measured 2026-08-03, a `.nidara-row-title` sat 18px inside a row whose content margin is
16, which is why the group header above the card could never be aligned to it with any round
number. `.nidara-row` now sets `padding: 0` explicitly. Suspect this on any Adwaita-derived node
whose geometry is 2px off what the code says.

⚠️ **It does not clear `margin` either, and the theme uses margin on list internals.** GTK ships
`dropdown popover listview { margin: 8px }` and `… > row.activatable { padding: 8px }` — our
provider (810) outranks the theme (600) on the row padding *because we declare it*, but nothing
overrode that 8px margin, so the Settings dropdown list carried an inset nobody in this repo had
chosen. **Read the theme instead of guessing at it:**

```bash
gresource extract /usr/lib/libgtk-4.so.1 /org/gtk/libgtk/theme/Default/Default-dark.css > /tmp/adwaita.css
```

That is the actual cascade you are fighting; grep it before theorising about a widget whose
spacing does not match its source.

### Who wins: the theme is not the enemy, our own blanket rules are

Measured 2026-08-03 with `scripts/dev/gtk-probe.js`, both directions, because the answer had
been guessed at twice:

- **Against the THEME, provider priority decides, per property, whatever the specificity.**
  A theme rule at 600 setting `outline-color` + `outline-width` as longhands is fully
  neutralised by our `outline: none` shorthand at 810 (`LOW_CSS='… row:selected { outline-color:
  red; outline-width: 4px }'` → zero red pixels). So `@mixin nidara-reset` really does kill
  Adwaita's focus rings; that hypothesis is closed, don't re-open it.
- **Within style.css, ordinary CSS specificity decides — and a window-scoped blanket rule
  out-specifies a component's own opt-out.** `window.nidara-settings-window button:focus-visible`
  (0,2,2) beats `dropdown > button:focus-visible` (0,1,2), so the dropdown trigger wore the
  blanket's accent OUTLINE *on top of* its own accent BORDER: **two concentric accent rings on
  one control**, which is what tabbing through Settings showed. The exception lives next to the
  blanket (`window.nidara-settings-window dropdown > button:focus-visible { outline: none }`),
  not in the component — the component already said `outline: none` and lost.

🔑 **A blanket `window.X <element>:state` reaches inside every composed widget in that window.**
Before writing one, ask which components style that element themselves; when one of them opts
out on purpose, the exception belongs beside the blanket.

🔑 **Focus is not one affordance.** A control styled as an INPUT (the dropdown trigger, the text
inputs) shows keyboard focus as its 2px border going accent — no ring. A BUTTON shows a ring
(`nidara-focus-ring`, now in `ui/lib/styles/_tokens.scss` so all three bundles share it). One
control must never show both.

⚠️ **`outline` follows the widget's OWN `border-radius`, so declare the radius on the BASE
rule — not only on the states that paint something.** A widget whose box is painted behind it
(the greeter/lock capsules) draws nothing at rest, which makes it natural to put the radius
under `:hover`/`:active` where a fill actually appears. Then the focus ring comes out a
rounded RECTANGLE around a pill (user-caught 2026-08-09 on the unlock button, reproduced
offscreen). **The hover fill and the focus ring are two consumers of one number.** When
sweeping, the check is: every `@include nidara-focus-ring` consumer must have a
`border-radius` outside its state blocks.

⚠️ **A focusable control with NO focus rule does not get "no ring" — it gets GTK's own.**
GTK4's built-in fallback CSS draws a blue `outline`, which ignores the user's accent entirely.
That is why the greeter/lock sheet says `outline: none` on every control before declaring its
own state, and why the user chip and the dropdown triggers were quietly showing a second ring
vocabulary until 2026-08-09. Adding a control to these surfaces means adding both halves.

The greeter and lockscreen broke this in both directions until 2026-08-09 and the symptom the
user reported was neither rule: the focus just looked **dull**. The unlock button drew an
accent border AND a halo (both affordances), and every ring on those two surfaces was
`rgba(accent, 0.35)` rather than solid — a 35 % ring reads as "something is slightly different
here" instead of "your keystrokes go here". **A tinted focus ring is not a softer focus ring,
it is a weaker signal**; if it looks too loud at full strength, the control is wrong, not the
alpha. On the lock the input's accent edge is the painted rim (`followFocus: true`), which is
also why only the entry passes that flag — a container reports `FOCUS_WITHIN` for any child,
so passing it on the power bar paints the whole bar accent when one button inside has focus.

### A vertical inset on a SCROLLABLE list is viewport, not air

`GtkListView`, `GtkGridView` and `GtkColumnView` implement `GtkScrollable`, so a
`Gtk.ScrolledWindow` hands them the whole surface with **no `GtkViewport` in between** and they
scroll inside their own allocation. A vertical `margin` on such a list — **or a `padding`, they
measure identically** — therefore takes it out of the PAGE: 6px each side turned a 400px card
into a 388px viewport, and the rows were then clipped 6px inside the card instead of at its
edge. A dead band, and it reads as the top and bottom being more separated than the sides
(user-reported, 2026-08-03; measured with `scripts/dev/gtk-probe.js`, which prints the page size
for exactly this reason).

Every other list in the shell sits inside a viewport (its child is an ordinary box), where
padding is part of the scrollable content and **scrolls away** — air at rest, content to the
edge once you scroll. That is the behaviour to match, and a native list cannot: wrapping it in a
viewport to force one costs the list's recycling and GTK's open-at-the-selected-item scroll,
both of which need the list to own the adjustments.

**So: a scrollable list insets its SIDES and not its ends.** The Settings dropdown is
`listview { margin: 0 6px }`. Where the ends need air and the list is short enough never to
scroll, the air belongs to a box around it, not to the list.

⚠️ The consumer of `cornerRadius`/`cornerInset` has to follow: with the ends flush, the scroll
pill starts at the corner and must keep the whole arc's clearance (`cornerInset: 0`), not an
indent the list no longer has.

## Tokens

Tokens live in `styles/_base.scss`. Dark/light values are injected at runtime by `NidaraTheme.ts → generateTokensCss()`. **Never invent hex values.** Use:

- `--nidara-accent`
- `--nidara-text*`
- `--nidara-surface*`
- `--nidara-border`
- `--nidara-radius-*`
- `--nidara-shadow-*`
- `--nidara-material-{thin,regular,thick,chrome}`
- `--nidara-danger`, `--nidara-success`, `--nidara-warning`

The only legitimate hex literals are the accent swatches and the danger/success/warning seeds defined inside `NidaraTheme.ts`.

### `--nidara-surface*` alphas are ADDITIVE — a level picked while nested is wrong once unnested

The surface ramp is translucent white over the glass (`surface-back` 0.04 · `surface` 0.08 ·
`surface-raised` 0.20), so **a widget's apparent level is the sum of everything under it**, not the
token it names. A chip at `surface-back` inside a `surface` bubble reads at ~0.12; lift that same
chip out onto the bare panel and it reads at 0.04 and all but vanishes — which is exactly what
happened to `.agent-tool-chip` when the assistant's tool chips were unbubbled (2026-07-29).

**So when you re-parent a widget to a shallower background, re-pick its surface token.** Nothing
warns you: it typechecks, the SCSS compiles, and the boot smoke passes. And do not settle it from a
screenshot — near-threshold alpha over blurred glass is precisely what a capture flatters (see
`tech-debt.md` on screenshot fidelity). It takes a look at the live panel.

Corollary for hierarchy: when two elements have to share an alpha for legibility, carry the
difference in **shape** instead — a small hugging pill against a wide filled block reads as two
levels at the same 0.08.

### ⛔ A CSS margin and `set_size_request` on the SAME widget fight — the margin wins

**In GTK4 a CSS margin is drawn INSIDE the widget's allocation, and `width_request`/`height_request`
set the minimum of that allocation** — so a request plus a margin does not offset the widget, it
**shrinks** it. Measured off rendered pixels (2026-07-29): `.agent-tool-dot` requested 6×6 with
`margin-bottom: 2px` and painted **6×4**, a horizontal oval instead of a circle. The same pattern had
already shipped in `.agent-error-dot` — 6×6 requested against `margin-top: 5px`, painting **6×1**, a
hairline where a dot was intended, unnoticed because only an abnormal turn end draws it.

**Rule: if a widget needs a nudge, its size must come from CSS `min-width`/`min-height`, not from a
size request.** `min-*` applies to the content box and survives the margin. A sweep of every
`*_request:` in the shell found exactly these two (`cc-status-banner` pairs a WIDTH request with a
vertical margin — different axes, harmless), but the trap is silent: nothing errors, nothing fails
typecheck, and the widget just draws the wrong shape.

### Optical vs geometric centring next to text — and MEASURE the direction

`valign: Gtk.Align.CENTER` beside a label centres against the label's **allocation**, which is not
where the ink looks centred, so a nudge with a comment saying `optical` is the house pattern
(`.agent-error-dot`: `margin-top: 5px` to meet the first line of wrapped text; `.agent-tool-dot`:
`margin-top: 2px`).

**Do not reason about which way to nudge — measure it.** The plausible theory here (the line box's
lower third is descender space most strings never use, so a centred dot reads *low*) was applied
first and was **backwards**: the pixels showed the dot's centre at y13.5 against a cap-height band
centring at y14.5, i.e. already 1px HIGH, and the "fix" moved it 2px further up. Crop the widget out
of a screenshot and read the rows — `magick <png> -crop WxH+X+Y txt:-` piped through a brightness
threshold prints an ASCII map that settles it in one shot, and it costs less than a second round of
asking the user whether it looks right yet.

### Semantic colour goes in a MARK or a FILL — never in the copy

**Do not tint text `--nidara-danger`/`--nidara-warning`.** Red type on glass reads badly (thin
weights over a translucent, blurred backdrop), and it shouts where a mark suffices. The signal
belongs to a small dedicated element next to the neutral text, or to a filled background:

| Signal | Where the colour lives | Text |
|---|---|---|
| Tool call rejected (`.agent-tool-fail`) | the 6px dot | `--nidara-text-dim` |
| Turn ended abnormally (`.agent-error-row`) | the 6px dot | `--nidara-text-dim` |
| Battery critical | the battery glyph's fill | plain white `%` |
| Recording active (island compact, CC badge) | the 8px dot | `--nidara-text` |

Rejected four times now (battery `%` 2026-07-20, assistant errors 2026-07-21, the capture card's
and detail page's clock 2026-08-02, the greeter's caps warning 2026-08-09 — all four caught by the
user's eye), which is why it is a rule and not a preference.

⚠️ **"Not in the copy" does NOT mean "therefore a dot" — a mark has to EARN its place, and
there are exactly two ways.** Settled with the user 2026-08-09, after a warning dot on the
greeter's caps message shipped for an hour and was removed:

1. **It SUBSTITUTES for text there is no room for.** `.island-rec-dot` and `.bar-cc-badge`:
   a compact island capsule cannot say "recording", a bar icon button cannot say "the AI has
   permissions". The dot is the only thing that fits, so it carries the whole message.
2. **It DISCRIMINATES between items that otherwise look identical.** `.agent-tool-dot` /
   `.agent-error-dot`: the assistant's transcript is a list of steps rendered the same way, and
   the dot is what separates the ones that failed from the ones that worked. Remove it and you
   cannot tell them apart at a glance. This is the case the "no room" reading misses — there IS
   room next to a tool name; the dot is not there for space, it is there for contrast within a
   set.

**A single self-describing sentence is neither.** The greeter's caps warning says what it
means, in words, and appears alone; a dot beside it repeats the sentence. That is decoration.
**When the copy already carries the meaning, removing the colour is the entire change** — what
makes the message noticeable is the capsule it sits on.

The user's own framing, worth keeping because it is the test that scales: *"in the agent it
makes sense because it marks errors and tells them apart from the correct steps. Here the text
is enough."* Before adding a mark, name which of the two jobs it is doing. If the answer is
"it makes it stand out", it is decoration.

✅ **And the sequel, same day: the icon already existed and the message was deleted.**
`Gtk.PasswordEntry` builds its OWN caps-lock warning — an `image.caps-lock-indicator` inside
the field, driven from the real keyboard, with no property to turn it off. So the greeter was
showing TWO warnings for one state (that icon plus our text) while the lockscreen, which never
had ours, showed one. Ours is gone; the field's is the only one on both screens, which is what
macOS and iOS do and what the user had already reached for when they said "if anything, an
icon". **Before adding an indicator to a composed GTK widget, check whether the widget already
ships one.**

🔑 **On a composed GTK widget, DUMP THE NODE TREE — do not assume the node.** Walking
`entry.password` to confirm the indicator turned up a second, older mistake: the peek icon is
an `image`, and this sheet had been styling `> button`, so that rule had never matched and the
eye was inheriting the entry's full `--nidara-text`. It matters more than it sounds, because
the fix above depends on a hierarchy — the caps indicator is a STATE and must sit above the eye,
a passive affordance — and that hierarchy did not exist. (`entry.password` has exactly three
children: `text` and two `image`s.) Same family as the `margin-start` that GTK4 does not have;
both were invisible because CSS that matches nothing fails silently.

⚠️ **Rendering a GTK-owned state needs its own frame.** `lock-probe.js`'s `CAPS=1` force-shows
that indicator, and the timing has exactly one valid slot: not at construction (GTK re-syncs the
node from the real keyboard when the entry is mapped) and not immediately before the snapshot
(showing a child queues a resize, and the snapshot comes back EMPTY — "nothing drawn", every
crop missing). It goes in a timeout of its own, after the map, well before the render.

🔑 **The fourth rejection adds a reason the first three did not have: on an arbitrary backdrop a
mid-tone hue is WORSE than plain white, not merely louder.** The greeter's caps warning was
`--nidara-warning` type sitting directly on the wallpaper, and on a light one it read worse
than the neutral text beside it — a saturated mid-tone has nowhere to go when the background
can be anything, which is exactly the argument that had already talked `.greeter-error` out of
red on the same screen. Where the shell's version of this rule is about *taste* (red type on
glass shouts), the greeter's is about *legibility*. Same conclusion, and on the surfaces that
sit on the user's own photograph it is the stronger of the two arguments. Corollary already documented below: once a capsule fills with a semantic
colour, do NOT tint the label on top of it as well.

### And the red BUDGET is smaller than that (2026-08-02, user call: "se tiende a abusar del rojo")

Passing the mark-not-copy test does not earn a colour the right to be red. Red is for exactly two
things:

1. **A status MARK** — a small dot saying "this is happening whether or not you are looking"
   (`.island-rec-dot`, `.bar-cc-badge`, the tool-failure dots). Small, steady, never a whole shape.
2. **The destructive edge of an ACTION** — deletion, and revocation like the AI kill switch.

Everything else that is merely *on* uses the ordinary accent-fill vocabulary, because that is what
"on" already means in this shell. Screenrecord had drifted into the opposite: a whole capsule filled
`DANGER_HEX` while recording, a red clock in the detail page, and a `destructive-action` Stop button.
All three are gone — the tile fills with the plain accent like `dark_mode`/`night_light`/`focus`, the
clocks are `--nidara-text`, and **Stop is `suggested-action`**: stopping a capture you started on
purpose is how the flow FINISHES (it writes the file), not something that destroys work. Reserve
`destructive-action` for a click the user could regret.

## Shell-skin appearance & opacity (`appearance.shellAppearance` + the glass sliders)

### Appearance pin — the WHOLE shell skin, not just bar/dock

Text colour is mode-bound (`--nidara-text` = `#fff` dark / `#000` light) but shell glass is
translucent over the wallpaper. In dark mode white text forgives almost any wallpaper; in
**light mode black text fails on a dark wallpaper** when the glass is too transparent. The fix
is the appearance pin (NOT an opacity floor — see below).

**`appearance.shellAppearance`** (`system | dark | light`, default `system`) pins the **entire
shell skin** — bar, dock, AND every overlay (CC/NC/Prism/system menu/overview/app grid) — to
dark/light independent of the app/global mode, so the shell stays legible over any wallpaper
while apps follow their own mode. **App-mode windows are EXCLUDED**: Settings
(`nidara-settings-window`) and About (`nidara-about`) follow the system mode like any app. It
flips the **whole token family** (text AND surfaces/edges/shadows), never just `--nidara-text`.
`Theme.chromeIsDark` resolves it ("chrome" now means the whole shell skin).

How the flip works:
- **CSS side:** `NidaraTheme.generateChromeTokenScope()` re-emits the full `--nidara-*` block
  (factored into `nidaraVars()`) under a scoped selector when the shell differs from the system.
  - **Scope = `window#nidara-bar *, window#nidara-dock *`** (both windows + descendants). The
    bar window's `Gtk.Overlay` hosts ALL the overlays, so scoping the whole window covers them;
    Settings/About are separate toplevels, so they're excluded automatically.
  - **GOTCHA:** the selector must hit every **descendant** directly — GTK4 custom properties
    don't inherit reliably and the global `* { --nidara-* }` matches every node directly, so a
    bare `window#nidara-bar { --nidara-* }` only overrides the container. An id-qualified
    universal beats `*` on specificity. It mirrors the `.nd-icon` `-gtk-icon-filter` too.
- **Cairo side:** shell painters read `Theme.chromeIsDark` (not `Theme.isDark`):
  `SquircleContainer` (**`chrome` defaults to `true`** = shell skin; pass `chrome: false` ONLY
  for app-mode windows like About), the dock (`DockAxis`/`DockItem`), the bar CPU/RAM ring +
  battery glyph, and the CC/NC/app-grid Cairo. Non-shell (Settings/About) keep `Theme.isDark`.
  - **Shared Cairo widget drawn into BOTH** (the slider, in CC/system-menu AND Settings) can't
    pick a global flag — it calls **`Theme.surfaceIsDark(widget)`**, which resolves by the
    widget's ROOT window name (`nidara-bar`/`nidara-dock` → `chromeIsDark`, else → `isDark`).
    The slider uses it for the neutral track colour. Use this for any future shared painter.
    ⚠️ Since the slider moved to the kit (2026-08-15) it reaches that method through
    **`kitAppearance().surfaceIsDark(widget)`**, not by importing `Theme` — a kit component may
    not import from `ui/shell/`. Same method, injected. A shared painter that stays in
    `ui/shell/common/` still calls `Theme.surfaceIsDark` directly.
- **Light-mode text ramp is nudged up:** `--nidara-text-secondary`/`-dim` are `rgba(fg, 0.85/0.72)`
  in light vs `0.8/0.6` in dark (`nidaraVars`). Black ink over translucent light glass (on an
  arbitrary wallpaper) reads washed-out at the dark-mode alphas; white-on-dark needs less ink.

**Adwaita colour leak (tech-debt #9):** libadwaita is force-loaded in-process and colours
`button` / `calendar` labels by the PROCESS mode — wrong for a pinned shell. Fixed ONCE in
`_reset.scss`: `button, calendar { color: var(--nidara-text); }` (low specificity, high provider
priority → beats Adwaita, loses to our classes). **Don't** patch `color` per menu/button — new
shell text follows the pin automatically.

### Opacity — one master + Advanced, four surfaces, WYSIWYG

There is **no opacity floor** (an old light-mode 0.40 floor was removed — pinning painted opacity
above the slider value is incoherent). Glass opacity is **WYSIWYG with the slider**; legibility is
the user's call (raise it, or pin the shell to dark). Four independent opacities, all plain
"opacity" (higher = more opaque), one range `[0.05, 0.80]`:
- `barOpacity` → bar capsules (Cairo) — `SquircleContainer({ opacityRole: "bar" })`.
- `overlayOpacity` → overlays CC/NC/Prism/app-grid (Cairo) — `opacityRole: "overlay"` (default).
- `dockOpacity` → dock (Cairo, `DockAxis`).
- `windowOpacity` → Settings/About windows = the **CSS token path** (`--nidara-bg`/materials/
  popovers in `nidaraVars`). Those windows are CSS-painted, not Cairo — hence a separate axis.

All four **default to `0.05`** (the range minimum, the glassiest end) — uniform, so a fresh boot
reads a clean 5% on the master rather than the mixed state below.

`Theme.setGlassOpacity()` is the **master** — it *writes* all four, so it must also *read* all four.
The master slider in `pages/Appearance.tsx` is therefore an **indeterminate control** (Figma "Mixed"
/ macOS dash): when the four agree it shows that %; when they diverge it reads **"—"** and mutes, and
dragging it re-unifies them. It's built **inline with `makeHSlider`** (not `sliderRow`) for that
mixed-aware label — don't "simplify" it back to a `sliderRow` bound to one axis (that let *only* the
overlay slider move the master; a mean would be a number nobody set that also implies uniformity).
The **"Advanced"** disclosure (Bar/Overlays/Dock/Window, per-surface setters) lives **inside the same
"Theme" card** as rows of the shared `Gtk.ListBox`: the toggle is a `nidara-row`, and the four
sliders reveal via a `Gtk.Revealer` wrapped in a passive row (`.settings-adv-revealer-row`), driven
by the ListBox's `row-activated` — not a detached block below the card. (The Settings section itself
is titled **"Theme"** — `settings.appearance.group.theme` — not "Nidara".) When adding a shell
capsule, `SquircleContainer` already defaults to shell skin — pass `opacityRole: "bar"` if it's a bar
capsule (else it tracks overlay).

### Tray icons recolour conditionally (not "never", not "always")

A common misconception (it bit a past explanation): system-tray icons are NOT uniformly
"app pixmaps that can't recolour". `Tray.tsx` resolves each item like this:
- If the app exposes its icon by **name** AND the active icon theme has a **`-symbolic`**
  variant of it → load the symbolic icon; CSS `-gtk-icon-style: symbolic` + `.bar-tray-icon
  { color: var(--nidara-text) }` recolour it, so it **follows the theme and the chrome pin**
  (this is why e.g. Telegram's tray icon flips — its symbolic exists in the icon theme, no
  app-specific code).
- Otherwise → fall back to the app's composited `gicon` **pixmap**, which **can't** recolour.

Consequence: a single bar can show some tray icons themed and others full-colour, depending
purely on what the icon theme provides. That's inherent to SNI (apps supply what they
supply); making it coherent is a policy decision, deferred — see tech-debt #24.

**Per-icon capsules (2026-07-15)**: each tray item sits in its OWN glass capsule (identical
`SquircleContainer` params to the search/CC/clock capsules), NOT one grouped pill — so tray
icons match every other bar icon. The click→window-focus wiring (PID-first match, `is_menu`,
`activate` fallback) lives in architecture.md under `bar/Tray.tsx`.

## Accent palette (9 colors)

| Name | Hex |
|---|---|
| blue | `#0088FF` |
| teal | `#2190A4` |
| green | `#79B757` |
| yellow | `#F3BA4B` |
| orange | `#E9873A` |
| red | `#ED5F5D` |
| pink | `#E55E9C` |
| purple | `#9A57A3` |
| slate | `#6F8396` |

## Real blur = compositor, not widget

GTK has no true `backdrop-filter`. CSS only sets the translucent background, sheen, and border. The `backdrop-filter: blur()` you see in SCSS is **web-preview only** and is ignored by AGS at runtime. Real blur comes from Hyprland `layerrule blur, <namespace>`. Don't try to "fix" the absent blur from inside CSS — it's not a CSS problem.

### Blur is per SURFACE, and it can only ever reach DOWNWARD

The corollary that costs people hours: Hyprland blurs what was composited **behind
a surface**, once, at composite time. Everything painted inside one GTK window
lands in **one buffer**, so **nothing can blur its siblings** — two widgets in the
same window composite in Cairo, which has no backdrop filter. Symptom when you hit
it: a translucent panel sits visibly on top of another widget, and that widget
shows through **sharp**, which reads as "the blur isn't applied" or "that widget is
on top". Neither is true. This is what forced the Activity Island onto its own
layer surface (`IslandWindow.ts`) — it is the only overlay that covers the bar row,
and at the default `overlayOpacity` of 0.05 the bar capsules read straight through
it. A surface on a HIGHER layer level is composited after, so its blur samples the
one below. **Verified live, 2026-07-25** (Hyprland 0.55.4): an OVERLAY-level layer
with `ignore_alpha = 0.01` blurred the TOP-level bar underneath at glass alphas
0.05 / 0.20 / 0.38 alike — `new_optimizations` does not restrict sampling to the
background, and `xray` is off.

**Three different alpha thresholds, don't mix them up:**

| Surface kind | Knob | Value here | Practical floor for the glass |
|---|---|---|---|
| Layer (bar, dock, island) | `ignore_alpha` per `layer_rule` | 0.01 bar/island, 0.04 dock | none — 0.05 glass blurs fine |
| Popup of a layer (tooltip, dock menu) | `popups_ignorealpha` (global) | 0.30 | ≈0.38 (`NidaraTheme.popoverAlpha`) |
| Popup of a window (Settings dropdown) | `decoration:blur:popups` + same 0.30 | 0.30 | ≈0.38 |

So "make it a popover to get blur" is a real technique (it's why Settings uses the
native `Gtk.DropDown` — see the dropdown note below), but it **costs the 0.38
floor** and therefore stops honouring a low user opacity setting. A layer surface
gets blur with no floor. Pick accordingly; `popups_ignorealpha` cannot be lowered
without Hyprland blurring the popup's own drop shadow into a halo.

**Row 2 needs `blur_popups = true` on that layer's own `layer_rule`, and it is the
easy one to forget**, because `decoration:blur:popups` is already on globally and
covers row 3 — so a popover of a WINDOW blurs and the identical popover of a LAYER
does not. Being a `Gtk.Popover` is not enough on its own. `nidara-island` shipped
without the flag and its player-panel source menu (and every tooltip inside an
island mode) came out flat, while the same menu blurred fine in the Control Center
— which lives in the bar's window, where `nidara-bar` already had it (user-caught
2026-08-03). **Any layer that can open a `Gtk.Popover` needs the flag**; check it
whenever a surface moves to a layer of its own.

## Glass capsule edge = AA, NOT none (don't flip it back)

`drawSquircle` fills the glass body with **antialias GRAY (AA)** so the capsule
curves are smooth. It was **NONE** (hard 1-bit edge) until 2026-06-24 to dodge a
feared "halo": Hyprland blurs any pixel with alpha > `ignore_alpha` (0.01), so AA
edge pixels (alpha = glass × coverage) show the blurred backdrop and were thought
to glow at the curved ends. **Re-measured** with offline renders + live grim
captures over a real *light* wallpaper through Hyprland's actual blur: the halo is
**negligible** (the soft edge just blends into its surroundings), while NONE's
stair-stepped curves were clearly visible. So AA wins. The border/rim strokes
(steps 2-3) still clip to the path so their inner AA can't spill outward. **Don't
"fix" this back to NONE** thinking AA causes a halo — it was checked on real pixels.

## A CSS pill at `--nidara-radius-pill` seams at the middle of each cap

`--nidara-radius-pill` is `9999px`, and GTK clamps it to **exactly half the
height**. That makes the two corner arcs of each side meet at a single tangent
point with no straight segment between them, and GTK's border rendering leaves
**one brighter pixel right in the middle of each cap** — a "dot" on the left and
right edges of the capsule. Only bites CSS-drawn pills with a visible hairline
border (Cairo capsules draw their own path and are unaffected).

Reproduced offscreen 2026-08-09 (user-caught on the lockscreen): **visible at an
odd height, clean at an even one**, because half of an odd height lands
mid-pixel. Parity is not something we can guarantee — fractional display scaling
turns any logical height into whatever it likes — and `box-shadow: inset` instead
of `border` seams identically (tried).

The fix, applied to the greeter/lock pills in `ui/greeter/style.scss`: an
explicit **even `min-height`** (vertical padding zero, so the shape comes from a
number we control rather than font metrics) and a **radius one pixel under
half**. The arcs are then joined by a 2px straight edge and never become tangent,
at any scale. Any widget painting a backdrop inside such a pill
(`ui/lockscreen/widget/GlassBackdrop.ts`) must clip to the SAME radius, or its
fill spills past the border at the caps.

✅ **CLOSED 2026-08-09 — both surfaces PAINT their capsules** (`ui/lib/glass-capsule.ts`,
lifted out of the lockscreen bundle). Everything below is the record of why CSS could not do
it, because the number was argued from both sides twice.

⚠️ **"Still a pill to the eye" was wishful — the straight edge IS visible, and
the trade is not free.** Rendered and magnified 2026-08-09 with
`scripts/dev/lock-probe.js` after the user reported a flat run on the caps and
the note went down as "does not add up": on the 42px password field and unlock
button, a 20px radius shows an unmistakable vertical run in the middle of each
cap. Both readings were right, of different surfaces — **the LOCKSCREEN paints
its capsules** (`GlassBackdrop` uses `min(w,h)/2`, a true pill, and its rim is a
FILL rather than a border primitive, so it has neither defect), **the GREETER is
still CSS** and wears the flat. So the honest state is: the CSS route has two
failure modes and no good setting between them — a dot at exactly half, a flat
segment one under — and the only shape that is actually a capsule is a painted
one. Painting the greeter's capsules the way the lockscreen already paints its
own is the open fix; do NOT relitigate the radius number, it has been tried from
both sides.

## The design system reaches the greeter and the lockscreen (2026-08-09)

Before this, `ui/greeter/style.scss` — the sheet **shared** by the greeter and the
lockscreen — opened with its own `* { }` block re-typing the radii and the palette, and
carried eleven freehand `font-size` values with no ramp behind them. Nothing was broken; it
had simply stopped moving. Every design-system decision taken in the shell had to be
re-typed here to arrive, and none ever was, so the surfaces drifted one generation at a
time. The tell was arithmetic: the date sat at **13px under an 88px clock**, a 1:6.8 ratio
outside every system that ships a lock screen (macOS 1:4.8, iOS 1:4.4, Win11 1:3.7, GNOME
1:3.4) — two numbers nobody had ever chosen together.

**`ui/lib/styles/_tokens.scss` is now the mode-independent half of the system**, `@use`d by
both `ui/shell/styles/_base.scss` (which `@forward`s it, so every `@use 'base' as *` keeps
seeing the same names) and `ui/greeter/style.scss`. It holds the type ramp, the weights, the
line heights, the spacing scale, the motion curves and the radius ladder — and since
2026-08-10 the relative **`$fse-*` em ramp** too.

⚠️ **`$fse-*` was labelled "Settings-only" and that was already false in two places**: the
kit's own row typography wears it (`.nidara-list-title`, `.nidara-row-title`,
`.nidara-row-subtitle`, `.nidara-list-footer`) and so does the alert dialog, which is its own
toplevel window. The anchor is not a Settings-local font-size — it is `gtk-font-name`
(ThemeManager), which is display-wide, which is exactly why the dialog keeps scaling right as
a separate window. The rule that has not changed: **shell CHROME uses the fixed `$fs-*` px
ramp**, because a bar or dock label that reflows with the font picker breaks the layout it
sits in. Body copy in a window is supposed to grow.

⛔ **Do not retune the `$fse-*` ratios to land on whole pixels.** It was tried twice (#123, #124)
and reverted both times: the anchor is `gtk-font-name`, deliberately a POINT size so the
accessibility text scale can reach it through the dpi, and 11pt is 14.667px — no set of ratios
lands a fractional anchor on integers. It buys nothing either; crispness comes from
`gtk-hint-font-metrics`. Full story under "the tops of letters were being shaved" below.

**Its sibling `ui/lib/styles/_mixins.scss` (2026-08-10) holds the mixins the KIT needs** —
`nidara-reset`, `glass`, `material-card`, `nidara-row-states`, `nidara-tile-states` — for the
same reason and with the same `@forward` from `_base.scss`. `material-control`,
`material-popover` and the `material($level)` vibrancy ladder deliberately stayed in the
shell: they describe full-window layer-shell surfaces, which has no meaning in a login
screen.

Three rules for extending it:

- **Nothing in that file may emit CSS at import time**, and every comment is `//`, not
  `/* */` (sass copies loud comments into the output). The radius custom properties go
  through a **`@mixin radius-vars`** so each bundle includes them inside its OWN `*` block
  instead of getting a second one. That is what let the extraction be verified the way a
  pure refactor should be: compile `style.css` before and after and diff — the shell's came
  back **identical but for comments**, zero declarations moved.
- **What stays per-bundle is the PALETTE**, and for a real reason: the shell rewrites its
  colour tokens at runtime per light/dark mode (`NidaraTheme.generateTokensCss`), while the
  greeter and lockscreen are permanently dark glass over a wallpaper. So they take the
  shell's **dark set** as literal values. They had been a near-miss copy of it — `0.70/0.45`
  against the shell's `0.80/0.55`, and a local name (`--nidara-text-muted`) for what the
  shell calls `-dim` — which made secondary text a step darker on the one surface with no
  card behind it.
- **A token with two representations gets labelled as a mirror, on both sides.** The glass
  palette now lives as numbers in `ui/lib/tokens.ts` (`LOCK_GLASS`) because the lockscreen
  PAINTS its capsules and Cairo/GSK cannot read a custom property — the same constraint that
  produced the radius ladder's double life. What was wrong before was not the duplication,
  it was that one half was three literals at the top of a painter with only a comment tying
  them to the sheet.

**The hero clock is the DISPLAY register, not a rung.** `$fs-display: 88px` / `$fw-display:
200` are named and documented as having exactly one consumer in the DE. This is not the ramp
continued — macOS, GNOME and Windows all set their lock clock outside the UI type scale too —
and `$fw-display` is the single exception to the four weights. **If a second consumer ever
appears, that is when it becomes a ramp; not before.** Everything else on these two surfaces
lands on `$fs-*` exactly: eight of the eleven freehand sizes were already 12/13/14 and simply
needed the token; only the hero block was genuinely off-system (date 13→`$fs-title-3`,
username 20→`$fs-title-3`, both `$fw-semibold`).

**Icons too.** The power bar asked the icon THEME for `system-shutdown-symbolic` /
`system-reboot-symbolic` / `media-playback-pause-symbolic` — the same three actions the
shell's system menu draws with `Icons.power` / `rotateCcw` / `moon`. On a clean Arch box that
is Adwaita's art, so Nidara's own login and lock screens were the one place in the DE not
using Nidara's icons (commandment 10). **`ui/lib/icons.ts`** resolves the shipped set for
bundles that have no `core/`, by the same route `avatar.ts` already used
(`NIDARA_SHELL_ROOT ?? /usr/share/nidara/ui/shell`), and falls back to the theme name rather
than throwing — a missing icon must cost an icon, never the login screen. They are Lucide
SVGs, not symbolic, so the consumer **must** add `nd-icon`; the sheet now carries that rule
once instead of stapled to the avatar fallback.

### The capsule is PAINTED, on both surfaces — and the rim has to be a RING

`ui/lib/glass-capsule.ts` (`withGlassCapsule`) is the one capsule of the greeter and the
lockscreen. It draws the body inside a rounded clip at radius exactly `min(w,h)/2` — a true
pill, which CSS cannot deliver (see the tangency section above: a dot at half, a flat run one
under, no third setting) — and the rim as a **1px ring, filled through an even-odd Cairo path**,
never stroked and never a border primitive.

**The only difference between the two surfaces is where the pixels behind the glass come
from, and that is a property of the compositor rather than a design decision.** The greeter is
a transparent layer whose `layer_rule` blurs whatever is below, so it passes no backdrop and
its body is fill-only. The lockscreen gets no compositor blur at all (`ext-session-lock-v1`
blanks everything behind the lock surface), so it calls `setCapsuleBackdrop(wallpaper)` and the
painter renders the blurred copy itself, once, into a texture.

🔑 **The bug that asymmetry hid, and the reason the ring matters.** The first version filled
the *whole* outer pill with the rim colour and painted the body over it. That is invisible for
as long as the body is opaque — and on the lock it is, because the blurred texture covers the
rim. The greeter paints no texture, so its body is a 55 % tint, and the rim came straight
through: **the entire capsule rendered accent blue the moment it took focus.** It could not
have been found by reading the code, and it was not in the lock's own rendering either. It
appeared on the first offscreen render of the textureless case. When one consumer of a painter
is opaque and another is not, render the transparent one.

### Bare text on the wallpaper: the scrim, and the 0.3 ceiling that governs it

The hero date, the clock and the username are the only text on either screen with **no glass
behind them**, and on a light wallpaper they do not dim — they vanish. Rendered on an
87 %-luminance backdrop (2026-08-09), the entire hero block was gone.

**The obvious fix was the weakest of five candidates.** A text shadow outlines the glyph
without raising the contrast underneath it, so the hero went from invisible to *ghostly*. What
works is a **scrim** lifting the background contrast plus a shadow doing the edge — which is
also what the field does: GNOME, Windows 11 and iOS all scrim their lock wallpaper, macOS
leans on a shadow with a slight dim, and none of the four leaves the text bare. The gradient
is stronger at the ends (where the clock and the power bar live) and lighter through the
middle, so the wallpaper survives where nothing has to be read over it.

🔑 **The 0.28 peak is not a taste value — it is what keeps the two screens identical, and it
is the single most useful number to know about this pair.** The greeter is a *transparent*
layer over awww's wallpaper carrying `blur = true, ignore_alpha = 0.3`
(`config/greetd/hyprland-greeter.lua`); the lockscreen paints its *own* wallpaper and gets no
compositor blur at all. **So any pixel of ours above 0.3 alpha has blurred wallpaper behind it
on the login screen and sharp wallpaper on the lock screen.** Two surfaces, one stylesheet,
same declaration, different result — and nothing warns you. That ceiling is why the shadow
cannot simply be made stronger (a convincing one wants 0.5–0.6), and it is the first thing to
check before adding any translucent element to this sheet.

⚠️ A full-size child of a `Gtk.Overlay` **takes input by default**. The scrim sets
`can_target: false` in both bundles; without it, it swallows every click meant for the card.

### Looking at these two surfaces: `scripts/dev/lock-probe.js`

They are the only surfaces in the DE you cannot see while working on them — the shell
reloads with `Super+Shift+R`, but seeing the lockscreen means locking the session you are
editing from. That is why they drifted, and why a 2026-08-09 session ended with the *user*
acting as the render loop and finding four defects by eye.

`lock-probe.js` builds the real widget tree with the real stylesheet and writes a PNG, plus
the bounds of the hero block, the measured date:clock ratio and — since 2026-08-16 — a
**LOCALE BAR** block: the capsule and each child's box, plus where the ink actually starts and
ends. It also crops the capsule to `<out>-locale.png`, which is what makes photometry on it
honest: measuring the locale bar out of the full-surface PNG has the SCRIM's gradient underneath
and every luminance threshold lies. Crop the widget, then measure. Point `CSS=` at two builds
for a before/after pair, and run it at least twice with different `BG=` — **legibility here
is a question about the WALLPAPER**, and that is exactly what it caught: on a light backdrop
the date, the clock and the username all wash out, because they are the only text on the
screen with no glass behind it. Read its header before trusting a number: it does not show
blur, the painted rim, or `:focus-visible`, and on a tiling compositor the window size is a
request, so **crop from the bounds it prints, never from a remembered offset**.

## The greeter wears the kit (2026-08-10)

`ui/greeter/style.scss` — the sheet both login surfaces compile — now `@use`s
**`ui/lib/styles/_components.scss`**, so the kit's look reaches the greeter and the
lockscreen and not only the shell. The thing that earned it: the three selectors on those
screens were raw `Gtk.DropDown`s and are now **`NidaraDropDown`**, so their popup is the
shell's list rather than a frozen copy of the pre-#86 one (GTK's checkmark in every row,
accent flashing down the list on hover-select because GTK moves `:selected` with the
pointer, and GTK's proximity-grown scroll bar on the 12-item language list — the only list
on either screen long enough to scroll).

**Four things to know before adding the next bundle, or the next kit component:**

- **Source order is the whole safety mechanism.** Sass emits a module's CSS *before* the
  file that loads it, so everything in `style.scss` out-ranks the kit at equal specificity.
  That is what makes the two bare-element collisions (`dropdown > button`, `dropdown
  popover`) safe rather than a coin flip. **If that `@use` ever moves below the rules, the
  login screens silently become Settings.**
- **The trigger deliberately does NOT take the kit's look, and that is geometry, not taste.**
  The kit styles a dropdown trigger as an *input* (surface-back fill, 2px border, radius-sm,
  20px content floor) because in Settings it sits on a card beside text fields. Two of the
  greeter's sit *inside* a painted capsule next to an icon and a separator, clamped to 18px
  so they match `.greeter-power-btn` exactly. **The kit is not all-or-nothing: take the
  popup, keep the trigger.**
- **The token contract is the silent half.** The kit's rules read `--nidara-*` custom
  properties; an undefined one does not warn, GTK drops the declaration. The greeter defined
  6 of 22 and got the other 16 in the same change (the shell's dark set verbatim, except
  `--nidara-popover-bg`, which stays this sheet's near-opaque value because these popups get
  no compositor blur). **The list is what the sheet ACTUALLY READS, measured against the
  compiled CSS — two greps, both written in the block's comment. `--nidara-shadow-md` was in
  the first draft and came out: `glass()` names it, no kit rule calls `glass()`.**
- 🔑 **Verify by rendering the surface and diffing PIXELS, not by reading the cascade.** Two
  properties leaked through and only one was predictable. Reading found the kit's
  `> box > label { margin-left: 8px }` — the exact gap the greeter had just refused as a
  dead `margin-start`. Reading MISSED `font-weight: $fw-medium`, which the greeter's
  per-variant rules override the size of but never the weight: heavier glyphs are wider, so
  the language pill grew ~2px and shifted its own label and chevron. With both guarded, the
  greeter and the lockscreen render **0 different pixels out of 3,686,400** against the
  sheet before them. That is the acceptance test for every later step of this migration:

```bash
# closed surface — must be pixel-identical unless a change is intended.
# KIT= is not optional here: lock-probe REBUILDS the tree, it does not import
# LoginCard, so without it the kit's construction-time work (list factory,
# adoptGtkScrolled) never runs and a sheet can pass while the shipping code path
# was never executed. That hook was added for this change, for that reason.
CSS=…/style.css PAINTER=/tmp/glass.js KIT=/tmp/kit.js SCOPE=greeter|lock \
  BG='#1b2430' gjs -m scripts/dev/lock-probe.js /tmp/after
magick compare -metric AE /tmp/before.png /tmp/after.png /dev/null

# the popup, which no eye can hold open — must match the shell node for node
CSS=ui/greeter/style.css SCOPE=greeter CLASS=greeter-session-dropdown ITEMS=12 \
  gjs -m scripts/dev/gtk-probe.js /tmp/popup
```

`gtk-probe.js` gained `CSS=` and `CLASS=` and a `greeter` scope for exactly this — it already
built this specimen for Settings, it just could not read another bundle's sheet. Both
surfaces now measure identical to the shell: `contents` pad 0 / border 1, `listview`
`margin: 0 6px`, `row` stripped to nothing, `.nidara-dropdown-item` pad 6/9, row origin 7 left
/ 1 top. The one honest difference is row height, 28 here against 29 in Settings — Settings
re-anchors to the `$fse-*` em ramp and the login screens stay on fixed px, which is the rule.

⚠️ **The greeter/lock sheet was compiled by nothing in CI until this change**, on the two
surfaces that can least afford it (no dev mode, fixed `/usr/share` path — a break shows up
only when someone boots a VM). The `styles` job now compiles it too.

## Cairo vs CSS

- **CSS** for anything with states (hover/active/focus/drag).
- **Cairo** for complex static shapes (squircles, dots with halo, ring charts).
- **Important:** if Cairo paints a node's background, CSS must **not** also declare `background-color`. You'll get double-paint artifacts.
- **A real window's chrome is CSS, never a Cairo `SquircleContainer`.** Hyprland already
  draws the 1px window border + `rounding` (squircle, `rounding_power 3.2`) at the window
  rect; the CSS route (`.nidara-window-glass` → `glass(floating)`: `--nidara-bg` fill +
  `--nidara-edge` + `radius-lg`) lines up with it and follows the window-opacity token.
  A Cairo card inside the window CANNOT line up: `drawSquircle` insets the shape ~2px from
  the rect (gap ring against the compositor border) and `gloss` paints its own 1px specular
  rims regardless of `borderColor` — it reads as a double border no parameter can turn off
  (this bit the About window twice). Settings and About both use the CSS chrome.
- **A capsule's VISIBLE edge is `GLASS_INSET` (2px) inside its allocation.** `drawSquircle`
  paints the glass in from the widget rect so the border stroke never lands on the allocation
  edge, which means **a child laid out flush to the rect overhangs the shape**. Nothing warns
  you: it typechecks, it renders, and the overhang is invisible until something has to line up
  with the curve. Two things bit at once here (2026-08-03, both user-caught): the bar's
  `barExpandedFlush` set the content margin to `0` — flush to the rect, 2px outside the glass,
  violating the written rule that a viewport reaches its *visible* inner edge — and that put the
  clipboard's scroll pill 2px nearer the curve than its corner clearance assumed. At 2px from
  the wall a radius-24 arc eats **14.4px**, not the 10.7px the 4px-distance maths predicts; the
  pill was left with 0.6px and the user saw the curve under it on hover. **Subtract
  `GLASS_INSET` (exported from `SquircleContainer`) whenever a child must meet the curve** —
  flush margins, scroll `cornerInset`, anything measuring from the rect.
- **Most icon glyphs cannot be CSS-recolored to an arbitrary colour — verify before assuming
  `color:` works on one.** GTK4 only recolours a `Gio.FileIcon` if its filename ends in
  `-symbolic` (see "The bar launcher mark" below) — that's the WHOLE mechanism, filename-gated,
  nothing to do with the SVG's own `fill="currentColor"`. Our general icon set (`core/Icons.ts`,
  Lucide-derived — `wifi.svg`, `check.svg`, etc.) doesn't use that suffix, so `color: var(--nidara-accent)`
  on a `Gtk.Image` showing one of them silently does nothing; the only real lever is `.nd-icon`'s
  `-gtk-icon-filter: invert(1)`, a fixed black/white toggle for dark/light, not a recolor. Found
  this dead on Settings → Power's profile checkmark (`accent-icon`, deleted 2026-07-01) — verify
  empirically (screenshot + crop, don't trust the CSS alone) before relying on `color:` on any of
  these icons. Anything that genuinely needs a live-coloured glyph draws in Cairo instead —
  `buildSelectionCheck` in `Power.tsx` (a 3-point path matching Lucide's "check") is the reference.
  **Don't reach for accent by default, though:** that checkmark sits on a `.nidara-row:selected`
  row, whose background is *already* an accent tint (`--nidara-state-selected`, itself derived
  from the live accent) — an accent-coloured check on an accent-tinted row nearly disappears
  (found live, corrected same day). Cairo-drawing a glyph means picking its colour is now on you;
  default to mode-aware white/black (`Theme.isDark`) like `--nidara-text`, and only reach for
  live accent when the glyph sits on the shell's own neutral glass, not on another accent fill.
- **NEVER put `nd-icon` on a third-party APP icon** — only on our own monochrome UI glyphs.
  `.nd-icon` is `-gtk-icon-filter: invert(1)`, an unconditional invert; on full-colour app artwork
  it hands back a photo negative. This has now been found three separate times (the notification
  centre's app icon, Settings → Audio's per-app row, and the CC audio detail's per-app row — the
  last one fixed 2026-08-02, reported by the user as "los iconos salen invertidos"). The pattern to
  copy when an image is *sometimes* ours and sometimes the app's: decide per icon, like
  `MenuRow`'s `appIcon?: boolean` opt-out or `widgets/media.ts`'s `remove_css_class("nd-icon")`
  once a real app icon resolves. Fallback art of ours that lands in the same slot still gets it.
- **Any bitmap that lands in a rounded slot goes through `squircleThumb(pixbuf, w, h, radius,
  cssClass)`** (`common/DrawingUtils.ts`) — a `Gtk.DrawingArea` that cover-fits (scale so the
  SHORTER side fills, then centre-crop) inside a squircle clip. **GTK4 CSS `border-radius` does
  NOT clip a child's rendering**, so rounding an image is Cairo's job, never the stylesheet's;
  and cover-fit rather than contain, because a thumbnail column only reads as a column when
  every cell is the same rectangle — letterboxing a 2560×1440 screenshot beside a square avatar
  makes the list look broken. It was born inside `NotificationCenter.tsx` (`heroDrawingArea`)
  and moved out the moment the clipboard history needed the same thing. `scale_simple`
  allocates, so the cover-fit copy is cached and only recomputed when the allocation changes —
  **never call `scale_simple` from inside a draw func without that guard.** Decode with
  `GdkPixbuf.Pixbuf.new_from_stream_at_scale_async` and scale against the shorter side (`-1` on
  the other axis): a bounding box gives a 2560×100 panorama a 2px-tall thumb, and a synchronous
  decode of twenty screenshots visibly stalls the panel as it opens.
- **Any Cairo draw call that needs a colour defined as a hex string elsewhere goes through
  `hexToFloatRgb(hex)`** — since 2026-08-15 it is defined in **`lib/accent.ts`**, beside the
  palette it parses, so the kit's slider can reach it; `common/DrawingUtils.ts` re-exports it and
  the shell's painters keep their import path. `"#rrggbb"` → `{r,g,b}` as 0..1 floats,
  never a hand-rolled `parseInt(hex.slice(...), 16) / 255` triplet. Before this existed, that
  three-liner was independently copy-pasted into `SquircleContainer` (×2), the CC drag ghost,
  and — worse — `nidara-kit/slider.ts` and `widgets/battery.ts` had drifted into hardcoding their
  OWN *pre-computed float copies* of a color instead of parsing the real hex live. Found because
  the slider's fill and battery's low/charging colors turned out to be silently duplicating (and
  in battery's case, duplicating the WRONG source — see below), not just visually similar by
  coincidence. **Two canonical hex sources, both plain string constants, no Gtk/Cairo import:**
  `lib/accent.ts`'s `ACCENT_HEX` (9 user-selectable accent colors — decorative, changes with
  Settings → Appearance) and `lib/status-colors.ts`'s `DANGER_HEX`/`SUCCESS_HEX` (fixed
  "needs attention"/"good" colors — used by the recording indicator, battery critical/charging;
  must NOT move with the user's accent choice, since accent has its own selectable "red"/"green"
  entries that mean something different). `battery.ts`'s old `RED`/`GREEN` were a comment lying
  to itself: it claimed to match the danger/success seeds but the actual float values matched
  `ACCENT_HEX.red`/`.green` instead — battery would have quietly wrestled the user's accent
  palette's arbitrary "red" swatch in a semantic slot for the wrong reason. Corrected to
  `hexToFloatRgb(DANGER_HEX)`/`hexToFloatRgb(SUCCESS_HEX)`. For the *live* accent specifically
  (not a fixed status color), read it off `Theme.accentPalette[Theme.accentColor].color` first,
  same as everywhere else, then pass that hex through `hexToFloatRgb` — don't read `ACCENT_HEX`
  directly for anything that should track live theme state.

## Adwaita vs pure GTK4 — the central rule

This is the table that decides almost every "which widget should I use?" question:

| Surface | Use | Why |
|---|---|---|
| Dock, Bar, workspace dots, resource circles, schematic | **Pure GTK4 + Cairo** (`Gtk.DrawingArea` / `Gtk.Snapshot`) | Adwaita adds nothing here; painting direct = zero defensive CSS. |
| Floating overlays (CC, NotifCenter, Prism (search), SystemMenu, Overview) | **`Gtk.Box` + gtk4-layer-shell + custom CSS** | Adwaita would only add chrome you'd have to undo. |
| Toggles / switches / buttons inside overlays | **`Gtk.Switch`, `Gtk.Button`** (NOT `Adw.*Row`) | Base widgets style cleanly; `Adw.*Row` brings padding/focus-ring/separators that have to be killed one by one. |
| Sliders (any) | **`makeSlider`** from `nidara-kit/slider.ts` (NOT `Gtk.Scale`) | See "Sliders" below — one Cairo component for the whole shell. |
| A preference row (label + subtitle + its control) | **`NidaraToggleRow` / `NidaraDropDownRow` / `NidaraSliderRow`** from `nidara-kit/rows.ts` | Inside Settings, reach them through `SettingsHelpers`' `toggleRow`/`dropdownRow`/`sliderRow`, which hand in `createRow` so the row also lands in the search index. Anywhere else, call the kit directly. |
| Settings window | **`ui/lib/nidara-kit`** (`NidaraSplitView`, `NidaraClamp`, `NidaraButton`, `NidaraDropDown`) | Custom split view. **Do NOT use `Adw.OverlaySplitView`** — it breaks capsule margins. |
| Modal dialogs | **`showNidaraAlert`** from `nidara-kit` | Clean, themeable. |

**Rule of thumb:** everything is **pure GTK4** — libadwaita has been fully removed. Dark/light is set via `Gtk.Settings.gtk_application_prefer_dark_theme` (no `Adw.init()`); the About window is a plain `Gtk.Window` (no `Adw.AboutWindow`). Don't reintroduce any `Adw.*`.

### Custom container widgets — a JS `vfunc_dispose` is a landmine

GJS blocks JS callbacks during garbage collection. A GJS `Gtk.Widget` subclass that
unparents its children in `vfunc_dispose` works on explicit destroy but NOT when the
widget is finalized from GC (a dropped subtree, e.g. a replaced Settings subpage): the
override is blocked (`Gjs-CRITICAL: Attempting to run a JS callback during garbage
collection`), the chain-up never runs, and GTK warns `Finalizing …, but it still has
children left` (the child subtree leaks). GTK4's own `gtk_widget_dispose` does NOT
unparent children either, so a subclass *without* the override warns just the same —
there is no safe GJS-subclass variant of a container.

**Pattern:** host children in a plain **C container** (`Gtk.Box`) and get custom layout
by replacing its layout manager (`box.set_layout_manager(new MyLayout())`) — GtkBox
releases its children in C, which is GC-safe. `NidaraClamp` (`nidara-kit/clamp.ts`) does
exactly this. When subclassing is unavoidable (`ScaleRevealer` needs snapshot-time
scaling), expose an explicit teardown (`dismantle()`) and require callers to invoke it.

## Entry vs dropdown in Settings — the CLOSED SET decides, not the list's length

A `Gtk.Entry` in Settings is a claim that the valid values are open-ended. Where they are
not, the entry is just a dropdown that can be typed wrong — `Gtk.EntryCompletion` does not
fix that, because completion is a suggestion and the widget still commits whatever is in
the buffer. Audit of every writable field (2026-08-16), with the option counts **measured
on a stock install** rather than guessed from the catalogue:

| Field | Closed set? | Options | Verdict |
|---|---|---|---|
| Language & region → Language (LANG) | `localectl list-locales` | **13** — the GENERATED locales, not glibc's ~800; **12 offerable**, see below | → `NidaraDropDown` |
| Language & region → Timezone | `timedatectl list-timezones` | **598** | entry stays (see below) |
| Users → full name / username | no | — | entry |
| Autostart → command | no | — | entry |
| AI → model / endpoint | no (BYOK, arbitrary) | — | entry |

⚠️ **`C.UTF-8` is not a language, and `localectl list-locales` lists it FIRST.** It is the
POSIX "no localization" locale — untranslated messages (which read as English because the
msgids are), byte-order collation, C date format, no currency — and `detectLanguage()`
(`core/i18n/index.ts`) matches no prefix for it and falls through to `en`, so Nidara's own
UI looks fine while everything else in the session goes unlocalized. Left unfiltered it was
the top entry of a control labelled "Language". Regional format had always filtered the
C/POSIX family out of `locale -a`; the Language list shipped without that filter for one
commit. Both filter it now. Filtering the list is **not** the same as hiding an active
value: a LANG absent from the list is appended to the model, so a machine really running
`C.UTF-8` still shows the truth rather than snapping to a neighbouring row.

🔑 **Measure the set on the machine before choosing.** `localectl list-locales` returns only
what `locale.gen` generated — 13 rows, a trivially browsable dropdown. Sized from the glibc
catalogue instead, the same field looks like an 800-row list that "obviously" needs a search
box. The count that decides the control is the runtime one.

**Timezone stays an entry for now** because 598 rows need `Gtk.DropDown`'s `enable_search`,
and that is not a free flag: it requires `expression` (a `Gtk.PropertyExpression` on
`GtkStringObject:string`), its `search_match_mode` defaults to **`PREFIX`** — so "Madrid"
would not find "Europe/Madrid" and the whole feature reads as broken — and, crucially,
`NidaraDropDownRow` (`nidara-kit/rows.ts`) reads and writes the selection **by index**,
which stops meaning a stable thing the moment a search filter is active. Converting it means
moving that row to `selected_item` first. `search_match_mode` is GTK 4.12+; the repo targets
4.22, so availability is not the blocker.

### A row that costs ROOT keeps its Apply button — even as a dropdown

Asked and settled 2026-08-16 ("¿el Apply de Language no sobra, si Regional format no lo
lleva?"). It does not, and the reason is not cosmetic. Settings → Language & region holds
all three cases side by side and is the reference for the split:

| Row | What it actually writes | Cost | Control |
|---|---|---|---|
| Regional format | `~/.config/environment.d/nidara-locale.conf` — 7 `LC_*` vars, as the user | none | dropdown, **instant** |
| Change timezone | `timedatectl set-timezone` → `org.freedesktop.timedate1.set-timezone` | admin password | entry + **Apply** |
| Language (LANG) | `pkexec localectl set-locale` → `/etc/locale.conf` | admin password | dropdown + **Apply** |

⚠️ **"System-wide" does not mean "the login screen too."** The greeter has its own
language picker (`ui/greeter/widget/LocaleBar.ts`, persisted to `greeter-prefs.json` in
the greeter user's config dir), and `detectLocale()` in `ui/greeter/lib/i18n.ts` reads
that **first** — `$LANG` next (usually absent: greetd starts the greeter with an empty
env) and `/etc/locale.conf` only as the **fallback**. So Settings → Language governs the
greeter on a machine nobody has picked on, and stops governing it the moment someone
uses that picker. The reverse holds too, by design: the greeter's pick re-strings the
greeter only and never touches the session. A subtitle claiming "login screen included"
shipped in the first draft of this work and was wrong for every machine whose greeter
had been used once — user-caught the same day.

Both system actions are `auth_admin_keep` on **all three** polkit levels (`allow_any`,
`allow_inactive`, `allow_active` — checked in `/usr/share/polkit-1/actions/`), so every
change raises a real password dialog. The rule: **root → Apply; our own user config →
instant.** A dropdown that raises a polkit prompt on `notify::selected` is a trap, not a
convenience — merely browsing the options starts asking for the root password.

⚠️ And it is not a one-line removal even if you wanted it: the page sets `langDrp.selected`
inside an `idle_add` once the model has loaded, so an instant-apply handler would fire
`pkexec` **on page open**. Any move to instant-apply must guard the sync exactly the way
`NidaraDropDownRow` does.

🔑 The tempting counter-argument — "Regional format proves we can do it per-user, so put
`LANG` in `environment.d` too and drop the button" — is a **product** change, not a cleanup:
it demotes the row from the SYSTEM language (greeter, TTY, other users) to this session's
language, and the group is titled "System language" for that reason. Considered and
declined; reopen it as a product decision, not as a refactor.

## Buttons — one component + a variant convention

All action buttons go through **`NidaraButton`** (`ui/lib/nidara-kit/button.ts`) — never
`new Gtk.Button({ css_classes: ["nidara-btn", …] })` by hand, and never per-surface classes
(`settings-row-action` was a dead class that left its button rendering as raw Adwaita). CSS
lives once under `button.nidara-btn` — in **`ui/lib/styles/_components.scss`** since
2026-08-10, because `NidaraButton` is built in `ui/lib/` (see "The kit's stylesheet" below).

Variants carry **intent**, applied consistently across pages (Network/Bluetooth were unified
to this in 2026-06):

| Action | `variant` | `pill` | Shape |
|---|---|---|---|
| Connect / Pair / Apply / the affirmative CTA | `primary` | `true` | label |
| Disconnect / neutral secondary action | `secondary` (default) | `true` | label |
| **Destructive** (Forget network, Remove device) | `danger` | `true` | trash icon |
| Scan / Search / other plain actions | `secondary` | `true` | label |

- **`danger` is for destructive only.** Disconnect is reversible → `secondary`, NOT danger.
- **`ghost`** (transparent, dim text) reads as *text with a hover*, not a button — use it only
  for subtle nav affordances (e.g. a row "details" chevron), never for a real action like Scan.
- For a button whose intent toggles at runtime (e.g. connect⇄disconnect), build it with
  `NidaraButton({ pill: true })` and `add/remove_css_class("nidara-btn--primary")` in your
  state setter (the base `--secondary` class is a no-op, so removing `--primary` = neutral).
- **Icon-only buttons:** pass `icon: true` (adds `nidara-btn--icon` — compact uniform padding)
  and `set_child(new Gtk.Image({ … css_classes: ["nd-icon"] }))`. This keeps an icon button the
  same height as a labelled one in a cluster (e.g. details/forget sitting next to Connect),
  instead of looking smaller/odd. Don't hand-roll icon buttons with ad-hoc sizing.

**Size is a separate axis from intent and from shape** (added 2026-08-02, tech-debt 16b). There
are exactly two steps and `size` composes with every variant, `pill` and `icon`:

| `size` | Metrics | Use for |
|---|---|---|
| `"default"` (omit) | `$fs-small`, `padding 5px 14px`, ~32px tall | every normal action |
| `"compact"` | `$fs-caption`, `padding 3px 10px`, ~24px tall | a control inside a **dense row** that must not out-weigh the row's own text |

Two rules that keep the axis from rotting into a free-for-all:

- **Compact is not a fitting tool.** If a default-size button doesn't fit, the layout is wrong —
  fix the layout. Compact is for the *editorial* case: the row's own label is the subject and the
  button is an aside (the CC audio detail's "set as default" = `ghost` + `compact`; the same
  control in Settings → Audio stays default-size, because that row is roomier and the button is
  the row's point). The same action legitimately takes different sizes in different surfaces.
- **In `_components.scss`, `--compact` is declared LAST inside `button.nidara-btn`** so its
  padding beats `--pill`/`--icon` while leaving their `border-radius`/`min-width` intact (it
  re-specifies padding for both combinations). Anything you add below it must not re-set padding
  unconditionally.

There is no `"large"`. Don't add one speculatively — one was never needed, and a size ramp nobody
uses is just three ways to be inconsistent.

**Icon buttons inside a list row use `settings-icon-btn`, and their tints are NEUTRAL** (mute
buttons in CC/Settings audio, the Settings → Widgets configure chevron). This is the *second*
icon-button class next to `NidaraButton({ icon: true })` and it survives for one reason: it is
28×28 with 4px padding, sized to sit in a dense row. Not folded into the kit (2026-08-02, user
call) because the merge changes the box on five rows for no behavioural gain.

The load-bearing detail is the **tint ladder**: the button sits inside a `.nidara-row`, which is
already wearing `--nidara-surface-hover` (0.12) by the time the pointer is on the button. An equal
tint reads as a dead control. So the row is 0.12, the button's hover is `--nidara-surface-active`
(0.16) and its press is `--nidara-surface-raised` (0.20) — each one rung deeper than its parent.
Until 2026-08-02 it reached for `--nidara-accent-10` to win that contrast, which is the
active/selected tint spent on a hover; the neutral rung buys the same visibility without
overloading the accent. **If you add a control inside a row and it looks dead on hover, go one rung
down the neutral ladder — do not reach for the accent.** Watch out for `--nidara-state-selected`:
despite the neutral-sounding name it is accent-tinted (`rgba(accent, 0.22)`), so it is not a rung
of this ladder.

**Never `suggested-action` / `destructive-action` — and know WHY they seem to work.** Those are
Adwaita classes, and the shell restyles them in exactly two class scopes: `.bar-expansion-panel`
(`_bar.scss`) and `.nidara-detail-panel` (`_control-center.scss`). Inside those two, an Adwaita class
looks native; **one pixel outside, it renders as raw GTK — Adwaita blue and Adwaita red, colours
the user never picked.** That is not theoretical: it shipped twice on 2026-08-02, in the island's
capture card (blue Stop) and in the CC status banner row (red revoke button), both caught on sight
by the user. `button.nidara-btn` is deliberately UNSCOPED, so `NidaraButton` is the only button
vocabulary that is correct in every window — bar, island, CC, Settings.
The ONE legitimate remaining use is `.nidara-seg-btn.suggested-action`, where the class is not a
button style at all but the SELECTED marker of a segmented control, and `_components.scss` owns
that rule (screenshot/screenrecord mode rows). Every real button in `widgets/` was converted on
2026-08-02 (vpn, bluetooth, screenshot; volume lost a vestigial `flat`), and the last holdout —
volume's caption-sized "set as default" text link — went with it once the kit grew a compact size
(same day, see the size table above). **`widgets/` and `surfaces/` now carry zero author-written
Adwaita button classes.** The `button.flat` rule still in `_control-center.scss` has no author-side
consumers left; it survives only as a defensive normalizer for GTK composite widgets that carry
`.flat` internally (night-light's `SpinButton`). Don't read it as permission to write `flat`.

For an icon that belongs **next to a row's title** rather than as a trailing control (e.g. a
lock on a secured Wi-Fi row), pass it as `NidaraRow`'s `titleIcon` arg (threaded through
`createRow(label, subtitle, widget, titleIcon)`) — don't park it in the trailing control box.
For an icon that **leads the row** (an identity icon before the title, e.g. each control's icon
in Settings → Control Center, or an app icon), pass `NidaraRow`'s `leadingIcon` arg (also threaded
through `createRow(label, subtitle, widget, titleIcon, leadingIcon)`) — it sits as the row's
first child, before the title column.

**A row has three zones — `[leadingIcon] [text (expands)] [control]` — and the trailing slot is
for ONE control.** The moment you find yourself building a `Gtk.Box` of unrelated things to pass
as `widget`, the row is telling you something belongs in another zone. A preview thumbnail is a
leading icon, not the first item in a button box: cramming it trailing reads as one dense clump
shoved against the right edge with the text stranded far left, and it looks like the layout is
saving space. This is a RECURRING slip, not a one-off — Settings → Top bar (launcher icon) and
Settings → Apps → app detail (icon override) both did it, with byte-identical copies of the
preview box, the two buttons and the `Gtk.FileDialog` (user-caught 2026-08-02: *"está todo
apretado en la misma fila"*). Both now build on **`imagePickerRow`** (`SettingsHelpers.ts`), the
shared "pick an image for this" row: preview leading, text middle, `[Choose image…] [reset]`
trailing, dialog and SVG/PNG filters included; callers supply only `renderPreview` / `isCustom` /
`onPick` / `onReset`. Use it for any new image-picking setting rather than a fourth copy.

Three legitimate escapes when one control genuinely will not fit the trailing slot:
**`createStackedRow`** (control on its own full-width line beneath the text — for entries and
button pairs), a dedicated preview row of its own (Settings → Gaming's wallpaper, Users' avatar,
where the image is large enough to be the row), and **`NidaraRow`'s `footer` arg** (below).

**An OPTIONAL control in the trailing slot misaligns the whole column — "it fits" is not the
test.** Settings → Widgets put a "Configure" chevron beside each configurable widget's
Bar/Center switches; since only *some* widgets have settings, the chevron pushed just those rows'
switches left and the switch columns stopped lining up down the page (user-caught 2026-08-02:
*"se desalinean del resto"*). A control that is not present in EVERY row of a group cannot share
that group's trailing slot. The fix is **`NidaraRow`'s `footer`** (threaded through
`createRow(label, subtitle, widget, titleIcon, leadingIcon, footer)`): a second line INSIDE the
row, under the text column, while line 1 keeps its title and trailing control untouched — so a
column of trailing controls stays aligned even though only some rows carry a footer. The caller
owns the footer's `halign` and its `margin_start` (leading-icon width + the row's 16px spacing —
34 for an 18px icon; `NidaraRow` cannot know the icon's size), and keeps it visually lighter than
the title: **ghost + compact** is the house style for this slot.

Align the footer's **text**, not its box. A `.nidara-btn--compact` carries `padding: 3px 10px`
(`_components.scss`) and a ghost button has no visible edge, so that 10px is pure optical offset:
`margin_start: 34` lands the button flush under the leading icon's gutter but the LABEL a visible
step right of the title (caught live 2026-08-02 — the code said "line the label up with the name"
and did not). Subtract the variant's horizontal padding — `34 - 10` — and verify by comparing the
label's `bounds.x` from `query_ui .nidara-row-title` against the row titles above it, which is
the measurement the eye is actually making.

Do NOT reach for a sibling row instead. That was the intermediate fix here and it read as another
ITEM in the list — *"como si fuese otro widget"* — because an indent alone cannot say "this
belongs to the row above" when every row in a list looks alike. Inside the row, the two lines
share one cell and one hover, so ownership is structural rather than a hint. (A sibling row is
still right when the thing genuinely IS a peer item — that is what the Apps page's `navRow`s are.)

**Inside a stacked row, keep going: one control per line, actions last.** Moving to
`createStackedRow` buys a whole card's width — spending it on a field and its buttons side by side
just reproduces the squeeze one level down, with the entry pinned to a `width_chars` stub and the
three reading as one clump. Use **`fieldWithActions(field, ...buttons)`** (`SettingsHelpers.ts`):
the field takes the full width, the buttons sit on their own line beneath, right-aligned with the
primary LAST. `actionRow(...buttons)` is that button line on its own, for stacks with extra parts.
This bit Settings → AI twice over (user-caught 2026-08-02): the API-key row had entry + Save +
Forget on one line, and the model row had an entry, a dropdown AND "Find models" competing for a
single line once a fetch succeeded. Note what the model row teaches about ORDER — the catalog
dropdown writes into the entry above it, so it is a picker for that field and belongs directly
under it, while the button that *populates* the dropdown is an action and goes in the action line.
Group by what a control DOES to the field, not by what it looks like.

**A picker is not a second place the value lives.** When a control's job is to write into another
control, it must not also display the result — one value shown in two widgets stacked on top of
each other reads as a duplicate, and the user asks why it appears twice (2026-08-02, the model
row). Park the picker on its placeholder permanently: the catalog dropdown rests on
"Choose a model…" forever, the entry above is the single display, and the id landing there IS the
confirmation the pick registered. Two things fall out for free — the bare-id matching needed to
preselect the configured model disappears along with the preselect, and re-picking the model you
are already on starts working (`notify::selected` never fires when the chosen row is already
selected, so a sticky selection silently made straying from a model a one-way trip). Snapping back
to row 0 re-enters the handler, so it needs the same `suppressDropCb` guard as the rebuild.

⚠️ The AI page was cited as prior art for this shape while it was itself wrong, and Settings →
Users' name row was converted to match it before anyone noticed. When you copy a layout from
another page, check it against the rule rather than assuming the older page earned it.

## CC capsule tiles: stateful vs action (no fake status line)

The 2×1 (WIDE) CC tile built by `buildCapsuleInner(getIcon, getTitle, getSubTitle)` (in
`surfaces/control-center/Toggles.tsx`) adapts to whether the widget has a **status**:
- **Stateful** (wifi, bluetooth, focus, ethernet, vpn, battery): `getSubTitle()` returns the
  live state ("Connected", "Off", an SSID, "Do not disturb"…) → single-line title + dim
  subtitle.
- **Action / stateless** (screenshot, screen recording, clipboard — they *do* something, they
  aren't *on/off*): `getSubTitle()` returns `""`. The sub line is hidden and the title is
  allowed to **wrap to two lines, vertically centred**, so the name reads in full ("Screen
  Recording") instead of being padded with a redundant descriptor ("Screen Record / Record
  screen"). The shape is **derived from the subtitle being empty**, so a dynamic widget (focus
  *off* → empty sub) gets it for free. When adding a CC widget: return a real state subtitle or
  return `""` — never invent a description-as-subtitle. (`applySub()` runs at build time too, so
  plain detail-opening tiles that never call `update()` still hide the empty line.)

**Wrap the capsule box with `wrapCapsuleTile(inner.box)` (or use the button path
`buildCapsuleContent`) — never a bespoke wrapper.** A WIDE tile is left-anchored by BaseIsland
(`child.halign = START, hexpand = false`), and `wrapCapsuleTile` adds the exact nesting level
that survives `SquircleContainer`'s padding so the icon/text land on the same grid as every
other tile. A tile that built its own wrapper — screen recording once put an idle/recording
`Gtk.Stack` inside a hand-rolled `outer` box — insets the content a few px off from the column
(visible once you line the tiles up). If a tile has multiple visual states (e.g. record ⇄
stop), drive ONE `buildCapsuleInner` via getters + `inner.update()` on a `notify::` (and toggle
state classes on `inner.iconBox`/`inner.icon`/`inner.label`/`inner.subLabel`) — the same
dynamic-capsule pattern as wifi/focus — instead of swapping whole subtrees in a stack.

**A widget that needs BOTH a one-tap toggle AND a `buildCCDetail` subpage uses
`buildSplitCapsuleContent`, not `buildCapsuleContent`.** `buildCapsuleContent` wraps the *entire*
capsule in one `Gtk.Button` — fine for toggle-only widgets (dark_mode, night_light, focus), but it
swallows the tile-level click IslandGrid wires up for `buildCCDetail` widgets, so a toggle widget
that grows a subpage (bluetooth → device list) has no way to open it. `buildSplitCapsuleContent`
makes *only the icon badge* a button (the toggle); the title/subtitle stay plain so the unclaimed
click area falls through to IslandGrid's detail handler — the same mechanism the plain
detail-opening tiles (wifi, ethernet) already rely on, just carved out of a smaller region instead
of the whole tile. CSS gotcha: the icon button's own class (`.cc-split-icon-btn`) must outrank the
blanket `.cc-island button { reset }` — a single-class selector loses that fight on specificity
regardless of source order, so it's written as a two-class descendant
(`.cc-island .cc-split-icon-btn`), which always wins.

**Every `buildCCDetail` tile has THREE routes to its detail panel** (2026-07): (1) primary tap on
the unclaimed capsule area (the split-capsule M/L story above); (2) the right-click context menu's
"Show details" row — `CCContextMenu` renders it whenever the widget declares `buildCCDetail`
(hidden in edit mode via its `detailEnabled` option); (3) press-and-hold anywhere on the tile —
`Gtk.GestureLongPress` in `IslandGrid.makeIslandWidget` (non-edit only) that CLAIMS the sequence
at trigger time so the inner toggle's release doesn't also fire. On a 1×1 tile, hold and the
context menu are the only routes: the round toggle button swallows plain taps by design — a
compact quick-toggle stays a toggle on every platform, "open detail" is
never a fallback on tap.

**A "stateful" tile's on-state fills the WHOLE capsule with the live accent colour** (standard
quick-settings convention), not just the icon. Wired via `AtomicWidget.getActive`/
`watchActive` (`Types.ts`) → `BaseIsland` → `SquircleContainer`'s `getActive`/`activeAlpha`/
`watchActive` props: `getActive()` is read live *inside the Cairo draw call*, so it paints through
the exact same `resolveDrawParams`/`drawSquircle` path a real tile already uses — no separate CSS
shape to keep in sync, no mismatched corners. `watchActive(cb)` only exists because the container
can't know the state changed on its own (it's driven by the widget's own domain signal — BT
power, `notifd`'s `dont_disturb`, `Theme` changed, an nmcli poll); it just calls `cb` to trigger
`da.queue_draw()`. Live on **dark_mode, night_light, focus, bt, vpn** — action/stateless widgets
(screenshot, clipboard) have nothing to fill and omit both props. `wifi`/`ethernet` don't have this
either: their WIDE tile has no toggle button at all (see `buildSplitCapsuleContent` above), so
there's no "this tile is a toggle" moment to fill — only their `buildCCDetail` switch reflects
state today. VPN is the template for a **polled** (non-signal) state: one shared module-level
poller + listener `Set` in `vpn.ts` (`watchVpnActive`), lazily started on first subscriber, instead
of a `GLib.timeout_add` per built tile instance — cheaper and it's what let the 1×1 icon and the
capsule badge both go live for free, which they weren't before.

**A FIXED (non-accent) fill colour is available as one more optional prop —
`activeColorHex`, threaded the same way as `getActive`/`getFill` (`lib/status-colors.ts` holds the
seeds). NOTHING IN THE SHELL USES IT.** Screenrecord was its only consumer and lost it 2026-08-02:
a tile that is on fills with the ACCENT like every other tile, and red belongs to the small status
marks — see the red-budget rule above before reaching for this. `activeAlpha`
(`number | (() => number)`) likewise exists for a live-varying alpha, and a getter there is how a
Cairo tile could pulse — **also unused, also not for new code**: screenrecord's
`0.75 + 0.25·sin(2π t/1400)` plus its ~15 fps redraw timer went the same day, see the indicator
rule below.

**INDICATORS DO NOT BLINK (2026-08-01, user call).** A condition that lasts minutes — a capture
running, AI control granted — is marked with a STEADY danger mark, never an animated one.
Two reasons, and the second is the one that generalises:
- It reads wrong. A throbbing red capsule is an alarm demanding action; "you are recording" is a
  state. Liveness is already proven by the elapsed clock ticking beside the mark.
- **It is a permanent compositor cost.** Every one of these marks sits on a blurred layer (bar,
  island, CC), and Hyprland re-blurs the whole surface on any repaint — so a 1.4 s CSS opacity
  keyframe or a 15 fps Cairo redraw means re-blurring 2560×1440 forever, for a dot. This is the
  general rule from the glow work: **continuous animation costs ≈40 % GPU; momentary is fine,
  perpetual is not.**
  🔑 **And it does not scale down with the effect.** A 1px rotating border gradient measured the
  same as a 24px glow (2026-08-01), because what costs is the damage the animation causes every
  tick, not the pixels it paints — a loop dirties the window whatever it draws, and re-compositing
  means re-blurring the surfaces above it. So the question to ask about a new effect is
  **"continuous or punctual?"**, never "is this one expensive?" — the second question has no
  useful answer, and asking it is how a 1px detail gets waved through.
The three marks are `.bar-cc-badge` (CC capsule, opacity 0.6 armed / 1.0 active — the STEP is what
distinguishes them, no keyframe), `.island-rec-dot` (island compact + its indicator chip), and the
screenrecord tile's steady `DANGER_HEX` fill. The one surviving `@keyframes rec-pulse` user is
`.cc-status-dot.is-active` (`_control-center.scss`, where the keyframe now lives): a few seconds of
"the agent just acted", inside a surface that only paints while open — momentary, and invisible
when the CC is closed.

**The "something is happening" pulse — `common/PulseDots.ts`.** The shell's one working
indicator: `makePulseDots()` (the three-dot typing idiom, Cairo) and `pulseOpacity(widget)`
for anything that breathes without its own drawing area (the Assistant capsule's glyph, a
running tool chip's dot). Two rules that are easy to re-implement wrongly:
**ONE refcounted driver, never a timer per consumer** — a second timer advances the shared
phase twice as fast, so the animation speed would depend on how many indicators happen to be
on screen; consumers subscribe/unsubscribe and the single 10 fps timer exists only while at
least one is active AND mapped. And **gate on `get_mapped()`, not just on "is it busy"** —
the island hides rather than destroys, so a widget stays "active" while invisible and would
otherwise tick forever behind a closed panel. Opacity, never `transform: scale` (commandment
3), and alpha is what reads as breathing anyway.

(Historical, kept for the CSS-bug lesson in it.) Migrating `screenrecord`
also retired its OWN one-off CSS states (`.rec-active-bg` icon-badge tint + keyframe, same
badge-only-not-whole-capsule pattern VPN had before), and deleted `.rec-stop-icon { color: danger
}` outright — dead CSS on a `Gtk.Image`, the exact bug class documented in the icon-tinting entry
above, just not caught until this pass. The label/subtitle no longer get a manual danger-red
override either: once the WHOLE capsule fills (with the accent, since 2026-08-02),
`--nidara-text`'s default white/black already reads fine on top (same reasoning as the split-target badge, same as every other filled toggle tile) —
tinting the text AGAIN on top of a filled background is how the Power.tsx checkmark bug happened
in the first place.

**The CC gauge tiles (volume/brightness's TALL slider) fill fractionally, through the SAME
mechanism — `getFill?: (size) => number` (0..1), not a separately-drawn inner layer.** The
original TALL implementation had `makeVerticalFillTile` paint its own accent fill in a nested
inner `DrawingArea`, inset within `BaseIsland`'s own padding — visually a capsule-inside-a-capsule
(the island's own border, THEN a gap, THEN the slider's own smaller pill with no border of its
own). User called it out: it didn't read as the same "material" as an active toggle's fill.
Fixed by extending `drawSquircle` itself with `fillFrac`/`emptyColor`/`emptyAlpha`: ONE path/clip
paints the empty (top) portion with the base glass and the filled (bottom) portion with accent,
so the border + gloss steps right after wrap BOTH portions as one continuous shape — structurally
identical to how `getActive` fills the whole thing, just clipped to a fraction.
`SquircleContainer`'s `getFill` takes priority over `getActive` when given (`frac >= 1` collapses
to the exact same single-fill path `getActive` uses, `frac === 0` is pure glass, no behaviour
change for anything that only passes `getActive`). `getFill` is **size-aware**
(`(size: WidgetSize) => number`) because a slider widget's OTHER sizes aren't gauges — volume's
SINGLE (1×1 icon) and FULL_WIDTH (its own inline thumbed slider row, unrelated to island fill)
both return `0` there, only `WidgetSize.TALL` returns the real fraction. `makeSlider` grew a
matching `paintFill?: boolean` (default true) so `makeVerticalFillTile` can opt OUT of drawing its
own fill (`paintFill: false`) and become a pure interactive hit-region (drag/scroll/click-to-jump)
over whatever BaseIsland paints — nothing else calls `paintFill:false` today, so every other
slider (bar popovers, Settings pages) is unaffected. Brightness has no change signal, so its
`watchActive` is just a 2s redraw poll (reusing the polling reality `buildVertical`/
`buildHorizontal` already live with) reading the SAME shared `_cachedPct` those keep fresh.

**Anything that sits IN the Control Center is painted like the Control Center — and spaced on its
rhythm.** Two rules, both learned by shipping the opposite (2026-08-02, the AI-control banner):

- **Cairo, not a CSS card.** A `@include material-card` box (flat background + 1px CSS border)
  dropped on top of a grid of Cairo glass reads as a foreign element pasted over the panel, however
  close the colours are: no inner specular rim, no squircle profile, no shell-opacity tracking. Use
  a `SquircleContainer` with BaseIsland's numbers (`borderWidth: 1.5`, `inset: 2.0`, `padding: 12`,
  `useShellOpacity`, `gloss`) and `Shape.CAPSULE` for a single-row full-width card. Put the
  `GRID_WIDTH` size request on the CAPSULE, never on the inner box — padding is drawn INSIDE the
  requested width, so a child requesting `GRID_WIDTH` makes the card 24px wider than the grid and
  breaks the right edge every tile is aligned to.
- **The panel has TWO spacing scales, and mixing them is visible.** `GAP` (12) is the gap WITHIN a
  block — between tiles. **24 is the gap BETWEEN blocks**, which is what the Edit pill already uses
  (`editBtnWrapper.margin_top` in `IslandGrid.tsx`). A card separated from the grid by 12 looks
  stuck to it — tighter than the panel's own internal spacing, which is the tell that a block gap
  was set by eye instead of read off the existing rhythm.

`.cc-island` is NOT the class to reach for on such a card: it carries
`.cc-island button { @include nidara-reset }` to strip Adwaita defaults out of tile content, and
that selector matches `button.nidara-btn` at EQUAL specificity — `_control-center` is imported after
`_components`, so the reset wins and any `NidaraButton` inside loses its background and border.
Give the card its own class with `background-color: transparent`.

**Multi-cell `centerContent` tiles align their items to the grid-cell centres.** A 2×1 tile
spans two grid cells; its content (e.g. cpu_memory's two metric rings) should sit one grid
**pitch** (`UNIT + GAP`) apart, centred — so each item lands on its cell centre, exactly where a
1×1 widget's icon centres and where a 2×1 tile's leading icon sits (the icon inset ≈ `UNIT/2`).
Spacing the items by their natural gap instead bunches them toward the middle, a few px inside
the icon columns. `cpu_memory` does this with `spacing: (UNIT + GAP) − ring` in a `CenterBox`.
`UNIT`/`GAP` are defined in `control-center/Types.ts` (a leaf) and re-exported by
`CCLayoutManager` — read them from `Types` in a widget; importing `CCLayoutManager` from a widget
pulls in the widget registry and forms a boot-crashing import cycle.

**The CC edit-mode drag ghost previews the dragged tile's real silhouette, not a generic rounded
box.** `BaseIsland.tsx` exports `resolveIslandShape(size, width, height)` — the per-`WidgetSize`
shape/radius decision (SINGLE→circle, WIDE/TALL→perfect capsule, FULL_WIDTH→dock-pill,
SQUARE→squircle) that used to live only inline in `BaseIsland()`. `SquircleContainer.tsx` exports
`resolveDrawParams(shape, radius, n, perfect, w, h)` — the second-stage resolution (CIRCLE/CAPSULE
always collapse to a perfect arc sized to `min(w,h)/2`, ignoring the requested radius) that used to
live only inline in its `draw_func`. `IslandGrid.tsx`'s `makeDropGhost` calls both directly and
paints with `drawSquircle` on a bare `Gtk.DrawingArea` (bypassing `SquircleContainer` itself,
because the ghost's invalid/valid tint must be driven by a mutable flag + `queue_draw()`, not a CSS
class — the fill/border colors are baked into the draw call). The result: drag a 1×1 widget → a
circular ghost; a 2×1 → a perfect capsule; a 2×2 → a squircle — always whatever the *real* tile
would render, because both draw from the same two resolvers BaseIsland itself uses. `drawSquircle`
also grew an optional trailing `dash?: number[]` param (only the ghost passes it) so the border
keeps its dashed "phantom" look without a CSS-only dashed-stroke escape hatch.

## The bar launcher mark — flattened path, no SVG filter

The bar launcher (system-menu) icon is the **Nidara mark**, `assets/nidara/assets/nidara-symbolic.svg`,
loaded as a `Gio.FileIcon`. It adapts to dark/light because (a) the filename ends in `-symbolic`,
so GTK4 recolours it, and (b) `.bar-distro-icon { color: var(--nidara-text) }` drives that colour.
The SVG must use `fill="currentColor"` — **never a hardcoded colour** (commandment #10), or it
goes invisible on the opposite theme.

Non-obvious gotcha (cost a wrong first attempt, verified live): **GTK's symbolic recolour does NOT
render SVG `<filter>`s.** The brand "N" in `nidara-logo.svg` gets its soft round terminals from a
goo/metaball `feGaussianBlur`; loaded as a symbolic icon that filter is dropped, so only the bare
rounded rects render and at 18px their tiny `rx` reads as **square terminals**. So the mark must be
a **single filled path with the metaball outline baked into geometry** (no filter) — that's what
`nidara-symbolic.svg` is (traced from a high-res render of the goo). Don't "simplify" it back to the
filtered SVG. The same `nidara-symbolic.svg` is reused at **72px** in the About window header
(`AboutWindow.tsx`, recoloured via `.about-logo`) — it replaced a `distributor-logo-<os-id>` theme
icon that rendered **broken on a clean machine** (no distro logo in the icon pack); our own mark
always resolves and is mode-aware. `nidara-logo.svg` (the filtered version) is the design **source**
/ for any always-dark surface that doesn't need recolour. (Two SVG hygiene gotchas, both real: a `--`
anywhere in an XML comment — e.g. writing a `var(--token)` name — makes strict librsvg reject the
file even though GTK tolerates it; and `fill="currentColor"` is mandatory, never a hardcoded colour,
commandment #10.) The bar icon is configurable (`barSettings.launcherIcon`: preset key or absolute
path); unknown/stale keys fall back to `DEFAULT_LAUNCHER_ICON`. Arch's logo is deliberately **not
bundled** (trademark — restricted, not under the OS's free licence; we ship our own mark and let users
point `launcherIcon` at any file).

## Sliders — one component

All sliders are **`makeSlider`** (Cairo) in `nidara-kit/slider.ts` (`makeHSlider` is just a
horizontal wrapper). There is **no native `Gtk.Scale`** and no `PillSlider` — don't add them.

⚠️ **It lives in the KIT, not in the shell** (moved 2026-08-15, NTK step 3). That is what forced
the kit's **appearance seam**: the accent and the surface's mode now arrive from
`kitAppearance()`, which each BUNDLE registers once in its `app.ts` — see
`nidara-kit/appearance.ts` and architecture.md. A bundle that builds a slider without registering
gets blue-on-light and one warning in the log; it does not crash.

- **Cairo-drawn**: fill + thumb are painted together so they never visually separate (the
  native `scale` highlight/slider misalignment bug). Accent comes from `kitAppearance().accent()`
  (the shell wires that to `PALETTE[Theme.accentColor]`).
- **Custom input** (a `GestureDrag` + scroll + arrow keys, *not* a `Gtk.Scale`): clicking the
  track jumps to that position; grabbing the thumb never warps it; `drag-begin` claims the
  sequence so a slider inside a clickable tile (e.g. a CC widget) doesn't trigger the tile.
  **Gotcha:** that same eager claim-on-press also wins against the CC's edit-mode
  tile-move `DragSource` on `overlay` — GTK4 delivers bubble-phase events to the deepest
  widget under the pointer first, so the slider (a descendant) claims before the ancestor
  `DragSource` ever gets a look, and a slider tile becomes undraggable in edit mode.
  Fixed in `IslandGrid.tsx`'s `makeIslandWidget`: when `editMode`, `content.set_can_target(false)`
  — the same "pointer-transparent" idiom already used for `cc-slot-placeholder`/the drag ghost —
  so `pick()` resolves the press straight to `overlay` and the move-drag always wins. Applies to
  every tile's content, not just sliders: nothing inside a tile should be independently
  actionable while rearranging (only the × remove badge and the drag itself stay live).
- **Options:** `orientation: "horizontal" | "vertical"`, `thumb` (default true). `thumb: false`
  + a wide `trackH` = the vertical capsule (fill rises, clipped to the capsule so
  the end follows the rounded cap). Thumb goes translucent while pressed. `paintFill` (default
  true) = false makes this `DrawingArea` paint NOTHING, a pure interactive hit-region — used by
  `makeVerticalFillTile` (see the CC gauge tiles entry above), whose fill now lives one level up
  in `BaseIsland`, not here. Every other caller leaves `paintFill` alone and is unaffected.
- **Wiring:** `onChange` (committed, optional `debounce` / `commitOnRelease`), `onValueChanged`
  (live, for the % label), `onExtChange(cb) → cleanup` for external value updates (ignored
  while the user drags).
- **`snapToStep`** (with `step`) turns the glide into **detents** — the FRACTION is quantized, so
  thumb, label and committed value are all derived from the same snapped number and cannot
  disagree. 🔑 Reach for it when the underlying thing is coarser than the thumb's travel, because
  a free glide then promises precision the screen cannot show and most positions are
  indistinguishable from their neighbours. The case that added it (2026-08-11) is the
  accessibility text scale: font rendering hints glyph advances to whole pixels, so measured, only
  37 of 75 one-hundredth steps over 0.75–1.50 changed the rendered width of a label while all 75
  moved the number — "the slider only changes in certain positions" was a true report about a real
  mismatch, not a drawing bug. `sliderRow` exposes it as a plain `step` option (passing `step` opts
  the row in; omitting it keeps the old free glide with `range/20` for scroll and arrow keys).
- **`makeVerticalFillTile`'s bottom icon is sized/placed to match a 1×1 tile's icon exactly** —
  28px glyph, vertical centre `UNIT/2` (40px) above the TALL tile's true bottom edge, not an
  arbitrary smaller icon of its own. Derivation: `40 − 4 (BaseIsland's TALL padding,
  `islandPadding()`) − 14 (half the 28px glyph) = margin_bottom: 22`. This works because a
  SINGLE tile's icon (button `width_request:48` + CENTER align) always resolves to the dead
  centre of its 80×80 cell regardless of padding magnitude, so `UNIT/2` from either edge is the
  correct target for both. If `UNIT`/`islandPadding`/the glyph size ever change, recompute this
  margin too — it's a hand-derived constant (matching the existing `trackH: 72` comment right
  above it in `nidara-kit/slider.ts`), not something that re-derives itself.
- **`makeVerticalFillTile`'s `icon` param accepts a getter** (`Gio.FileIcon | (() =>
  Gio.FileIcon)`) plus an optional `iconSubscribe?: (sync) => cleanup`, so a level-dependent icon
  (volume's mute/low/medium/high ladder, via `AudioSvc.targetVolumeIcon`/`watchVolume`) stays
  live on the TALL tile — the same canonical helper the bar icon and the SINGLE icon already
  used. Pass a plain `Gio.FileIcon` (no subscribe) for a static icon like brightness's `Icons.sun`.

## Tooltips — one component

All shell tooltips go through **`attachTooltip(widget, text, opts?)`** from `common/Tooltip.ts`.
`IconButton`'s `tooltip` prop already routes through it (with `tooltipChrome` mapping to the
`chrome` opt — pass `tooltipChrome: false` from app-mode windows like Settings/About), so
buttons built with the kit get the glass tooltip for free.
**Don't use GTK's `tooltip_text` / `tooltip_markup` on shell surfaces** — the native tooltip renders
in its own `GtkTooltipWindow`, out of reach of our scoped CSS, so it can never be themed (this is why
the dock "looked like default GTK"). It's a hover-delayed `Gtk.Popover` (`has_arrow: false`); the
bubble — rounded body **plus the pointer** — is painted in **Cairo as ONE continuous shape**: a
single glass fill and a single 1px inner-edge stroke that wraps body and arrow together. **That
bubble painter is shared** — it lives in `common/GlassBubble.ts` (`paintGlassBubble`) and the dock
context menu paints the same shape (see "The glass bubble" below); the tooltip only adds the label.

- **Why Cairo, not a GTK popover arrow:** GTK always strokes the arrow's *base* where it meets the
  body. With an opaque popover the body fill hides that seam; our glass is translucent, so it shows
  through as a line at the junction. There's no CSS way to border only the arrow's slanted sides
  (the triangle is made by clipping, not by per-side borders). Painting the whole silhouette
  ourselves is the only way to get a continuous rim on translucent glass — and it's the Nidara way
  (all custom shapes are Cairo). The popover is still its own surface, so it keeps Hyprland's blur.
- **Lives in `common/`, not `lib/nidara-kit`** — it reads `Theme` (chrome pin + opacity), like the
  other shared Cairo widgets (`SquircleContainer`, `Slider`, `ScaleRevealer`). `nidara-kit` stays
  Theme-free / portable, so a Theme-coupled widget can't live there.
- **Glass:** fill tint follows `Theme.chromeIsDark` (shell skin) and alpha is `Math.max(Theme.overlayOpacity, 0.38)`.
  **The 0.38 floor is load-bearing:** a tooltip is a *popup*, and Hyprland blurs popups with
  `popups_ignorealpha = 0.30` (NOT the bar/dock layer's `ignore_alpha` 0.01/0.04). Track the raw
  overlay slider and at a low setting the bubble drops below 0.30 and **stops blurring** (reads flat).
  This is the same reason `NidaraTheme` floors `--nidara-popover-bg` at `Math.max(bgAlpha, 0.38)` — any
  popup glass must clear the popup threshold. `chrome:false` (About) is a normal window with no blur →
  near-opaque fill. Rim is white on dark glass, a subtle dark line on light. Repaints on `Theme "changed"`.
  Geometry consts (`ARROW_W/H`, `PAD_*`, radius clamp so the arrow base fits the straight edge) are at the top.
- **Text** is `string | (() => string)`. A getter is resolved **lazily, right before show** — so
  live values (a window title) stay fresh WITHOUT subscribing (a subscription forces a dock redraw +
  blur pass per title tick; see `DockItem.computeTitle`).
- **Opts:** `position` (default TOP — just a *preference*, see placement sync below), `delay` (500ms),
  `markup` (Pango — tray uses it), `chrome`, `suppress: () => boolean` (skip while a context menu is
  open — the dock passes `() => menu.visible`).
- **Placement sync (flip + slide):** on Wayland the COMPOSITOR has the final say on where a popup
  lands (`xdg_positioner`): it FLIPS to the opposite side when the requested one has no room (a tiled
  window's close button at the screen's top edge) and SLIDES along the edge when the bubble would
  overflow the monitor. A native popover repositions its arrow after that; ours is Cairo, so
  `attachTooltip` does it itself — it reads where the popup surface actually went (`GdkPopup`
  position, parent-surface-relative, re-checked on the surface's `layout` signal) and repaints the
  arrow on the side facing the widget with its base shifted (`arrowOffset`) to keep aiming at it.
  Swapping the two `ARROW_H` margins keeps the popover size identical → no repositioning feedback
  loop. So callers just pick the side they'd *like*; wrong-side arrows can't happen.
- **Insensitive widgets get no motion events, so a tooltip attached to one never shows** (unlike the
  native mechanism, which picks insensitive widgets too). If the tooltip must explain WHY a control
  is disabled, attach it to an always-sensitive parent — see `controlGroup` in
  `settings/pages/Widgets.tsx`.
- **Lifecycle:** self-cleans on the host widget's `destroy` (drops the Theme handler, unparents);
  returns `{ popover, setText, destroy }`.
- **Adopted everywhere — there are ZERO native `tooltip_text` on shell surfaces** (2026-07-03 sweep):
  dock (replaced the bespoke `dock-tooltip` popover), bar tray (position BOTTOM), app grid, and ALL
  of Settings + About (`chrome:false` — app-mode windows). `nidara-kit` deliberately has **no tooltip
  props** (`NidaraButton` / `NidaraWindow`): the kit is Theme-free so it can't paint the glass bubble;
  callers attach the tooltip to the returned widget instead. `.nidara-tooltip` CSS in
  `_components.scss` only resets the popover chrome to transparent (the bubble is Cairo) + sets the
  label colour/size.

## The glass bubble — `common/GlassBubble.ts` (tooltip + context menus)

The Cairo glass bubble — a rounded capsule with a **pointer spliced into one side as one continuous
silhouette** (single fill, single 1px inner edge wrapping body AND arrow, no seam) — lives in
`common/GlassBubble.ts` and is **shared by the tooltip and the three menu bubbles (dock item,
app-grid item, media source)** so they all speak the same glass language. Don't re-implement it;
every consumer paints via `paintGlassBubble`.

⚠️ **Two consumers, two body profiles, one painter.** `paintGlassBubble` takes `n` (the superellipse
exponent of `drawSquircle`'s path) and `radiusMax`:

| Consumer | `radiusMax` | `n` | why |
|---|---|---|---|
| Tooltip | 13 | **2** (default) | a near-pill: `min(w,h)/2` already rounds it to a stadium, and stadium ends genuinely ARE circular arcs. Kept on `cr.arc`, not a polyline. |
| The three menu bubbles | **`RADIUS.lg`** | **3.2** | a menu bubble is one of the shell's floating popups, so its body is the same `lg` squircle as the system menu and the CC context menu. The arrow is the only thing that distinguishes it. |

The pointer's own three corners stay circular in both cases — they are features of the pointer, not
of the box.

- **The pointer is a downward TRIANGLE with ONLY the tip filleted** — a TRUE circular arc tangent to
  both diagonal sides, so the sides stay perfectly straight (no kink, no bowing). **The arc must stay
  SMALL relative to the triangle** (`TIP_R` ≪ side length): a big arc eats the straight sides and the
  whole thing reads as a *bell*, not a triangle — that's the failure mode to avoid. The `arrowTip`
  helper caps the fillet so it can't reach the base, and `paintGlassBubble` **clamps the base width**
  to the edge's straight portion so a short bubble's arrow never overruns its corners.
- **ONE size for tooltip AND menu** (consts `ARROW_W`/`ARROW_H`/`TIP_R`). Keep `ARROW_H` modest — a
  tall pointer separates the body too far from its anchor (and on the menu looks detached). Both
  surfaces reserve `ARROW_H` in their content margins (`Tooltip.ts` label margins, `DockItem.tsx`
  `menuRows` margins). Don't reintroduce per-surface arrow sizes — they were tried and looked
  inconsistent.

- **`paintGlassBubble(cr, w, h, side, { chrome?, radiusMax? })`** — fills the bubble + strokes the
  inner rim. `chrome` (default true) = shell skin (`Theme.chromeIsDark`) vs app-mode; `radiusMax`
  (default 13) caps the corner radius (tooltip 13, the roomier menu passes 16). **Alpha is floored at
  0.38 inside the painter** — a popover is a *popup*, blurred by Hyprland's `popups_ignorealpha`
  (0.30), NOT the dock/bar layer's `ignore_alpha`; below 0.38 it stops blurring and reads flat (the
  same load-bearing floor as `--nidara-popover-bg`). The dock/bar layerrules carry `blur_popups = true`,
  so the popover blurs on its own surface.
- **`sideFor(position)`** maps a `Gtk.PositionType` to the side the pointer is painted on (it points
  *back* at the anchor: a popover ABOVE the item → arrow on its bottom). The content child clears the
  arrow strip + AA buffer with margins computed inline from the exported `BUF`/`ARROW_H` consts
  (`BUF + PAD + (side === thatSide ? ARROW_H : 0)` per edge — see `layoutMenu` in `AppGrid.tsx`).
- **Structure** (both tooltip and menu): a `Gtk.Grid` overlaying a `Gtk.DrawingArea` (paints the
  bubble, `halign/valign FILL`) and the content (label / rows box) with the arrow-aware margins.
  Repaint on `Theme "changed"`; disconnect that handler on `destroy` (the menu is rebuilt per dock
  layout change, so a leaked handler accumulates).

### Context menus — glass popover, NOT `Gtk.PopoverMenu`

A right-click context menu on a shell surface must be a **plain `Gtk.Popover`** whose body is the
glass bubble above, **never `Gtk.PopoverMenu`**. `PopoverMenu` renders GTK's native `modelbutton`
chrome, which (like the native tooltip) can't be themed to glass — exactly why "the dock menu looked
like default GTK". Two consumers today, same pattern (see `surfaces/dock/DockItem.tsx`
`ensurePopover`/`updateMenuModel`, and `surfaces/app-grid/AppGrid.tsx` `ensureMenu`/`updateMenu`):

- **`new Gtk.Popover({ autohide: true, has_arrow: false, css_classes: ["nidara-menu-popover"] })`** —
  autohide so it grabs focus and dismisses on outside click; no GTK arrow (we paint our own pointer,
  aimed back at the item, via `paintGlassBubble`).
- **Rows = `renderMenuModel(model, actionGroup, onClose)`** from `common/NidaraMenu.ts` — the SAME
  component as the bar tray menu, so every menu is identical glass rows (`.nidara-menu-row`,
  separators, dim section/submenu headers — section labels render as headers too). It activates
  actions on the passed group directly. The bubble DrawingArea + rows box are built ONCE (stable host,
  rows rebuilt per show) so the Theme subscription isn't leaked per show.
- **Destructive rows** are `menuRow({ danger: true })` → `.nidara-menu-row.danger-action`: red
  LABEL and a red-tinted hover, **never a filled red row**. The shell's red budget is a small
  mark or a destructive edge; a solid red bar in a flat menu reads as an alert rather than as one
  option among several. It beats `nidara-row-states` on specificity so the neutral hover can't
  win. *(Was applied in three places while being defined nowhere — CC context menu "Remove" and
  the system menu's confirm action had been rendering as ordinary rows.)*
- **Destructive confirmation in a popover surface is INLINE, never a dialog** — the row swaps in
  place for a cancel/confirm pair (`.nidara-confirm-secondary` / `.nidara-confirm-primary`, both
  on top of `.nidara-menu-row` for geometry). A modal over a popover dismisses the very surface
  it is asking about. Shared by the bar system menu (logout/restart/shutdown) and the clipboard
  widget's "Clear history"; the classes are `nidara-*` because they are universal — they were
  `system-confirm-*` until the second caller appeared.
- **CSS** is the shared **`.nidara-menu-popover`** (`_components.scss`) — it only resets the popover
  chrome to transparent (`@include nidara-reset` on root + `> contents`), exactly like
  `.nidara-tooltip`; the glass is all Cairo. (The old per-surface `.dock-menu` rule is gone.)
- **Open direction:** the dock is edge-anchored, so its menu always opens inward (fixed `position`).
  The app-grid item can sit anywhere, so its handler **picks the direction per right-click** — flips
  the menu up for items low in the launcher (`compute_bounds` vs root height, 0.65 threshold), then
  sets `menuSide = sideFor(position)` and repaints, so the fixed Cairo arrow stays aimed at the item
  (GTK's own auto-flip would desync a painted arrow). **No native `Gtk.PopoverMenu` remains in the shell.**

## Show/hide animations — `ScaleRevealer` (THE overlay animation)

CSS `transform: scale` is banned on interactive widgets (see anti-pattern 6 below), but a
**snapshot-time** scale is fine: **`ScaleRevealer`** (`common/ScaleRevealer.ts`) shows/hides
its child with a grow/shrink + fade. It scales in `vfunc_snapshot` (paint only, ends at
identity — hit-testing is correct at rest). API: `reveal(open, onDone?)`; the wrapper
manages its own visibility (hides itself when the close finishes, *then* fires `onDone` —
that's where the bar refreshes the layer-shell input region). There is **no CSS overlay
fade anymore** (`.overlay-fade`/`common/fade.ts` were removed); every animated surface
goes through this one component. Two modes:

- **`animateLayout: true`** (default — notification banners): the *measured height* follows
  the scale, so siblings reflow like a `Gtk.Revealer SLIDE_DOWN`. `scaleFrom` is dramatic
  (0.25) and the pivot top-right: banners sprout from under the bar's clock capsule.
- **`animateLayout: false`** (spread as the **`OVERLAY_POP`** preset: CC, NC, Prism, system
  menu, overview, app grid, bar expansion panel): Gtk.Bin semantics — measure/allocation
  pass through 1:1, so external `halign`/margins/`height_request` on the wrapper behave
  exactly as on the child (in `Bar.tsx` the wrapper IS the `cc`/`nc`/... variable), and each
  frame only repaints. Subtle pop: 0.97→1, in 220ms, out 150ms. Pivot per surface,
  toward its visual anchor (cc/nc `top-right`, system menu `top-left`, expansion panel
  `top-center`, centered surfaces `center`).

**Asymmetric easing, on purpose:** ease-OUT opening, ease-IN closing. A decelerating exit
leaves a long low-opacity tail where only high-contrast content (icons, images, 1px Cairo
borders) stays perceptible — that tail is what made the old CSS fade look "non-uniform"
("icons disappear later"). Related compositor knob: the `nidara-bar` layer rule runs
`ignore_alpha = 0.01` (hyprland.lua) so the backdrop blur doesn't pop off mid-close — at
0.05 the glass crossed the threshold while still clearly visible.

- **Teardown:** call `dismantle()` right after removing it from its parent. It deliberately
  has no `vfunc_dispose` override — GJS blocks JS vfuncs during garbage collection, so a
  dispose override never runs on GC finalization and the child leaks ("still has children
  left" warnings). Long-lived wrappers (the overlays) never need it; per-notification
  banners do.
- **In-place content swap + height morph:** `setChild(next)` replaces the child while the
  wrapper keeps its progress/opacity/swipe state — banner replacement (same id, new
  content) updates without replaying the grow-in. `morphFromHeight(h0)` eases the
  *measured* height from a predecessor's allocated height to the new child's natural
  (top-anchored, own tick so reveal/swipe don't cancel it) — the NC uses it when a rebuilt
  row (item chevron toggle) or the group header ⇄ stacked-capsule swap replaces its old
  widget, so the column glides instead of snapping by the height difference.
- **Reduce motion lands in `reveal()` and nowhere else** (2026-08-16). Every overlay that
  pops — CC, NC, Prism, system menu, overview, app grid, bar expansion, notification
  banners — goes through that one call, so the accessibility accommodation is a single
  branch instead of a flag threaded through eight surfaces. It jumps to the end state the
  animation would have reached, **in the same order**: on close the widget is hidden before
  `onDone`, because callers use `onDone` to refresh the compositor input region and it must
  see the panel already gone. `morphFromHeight` short-circuits the same way (`morphFrom =
  null` IS the rest state). The switch is `core/ReduceMotion.ts` — read it before adding a
  new animation anywhere; if your motion is system-initiated it belongs behind that call,
  and if it follows the pointer it deliberately does not.
- **Typing gotcha:** the class merges `export interface ScaleRevealer extends Gtk.Widget`
  because the ambient `ags/gtk4` typing exposes `Gtk` as `any` in value position — without
  the merge, tsc can't see the inheritance. Don't add TS `private` members or members whose
  name collides with a `Gtk.Widget` property (e.g. `scaleFactor`) — both break the merge.
- **Banner sizing:** the popup column uses `GRID_WIDTH` (356px, from `CCLayoutManager`) so
  banners match the NC cards exactly — one `NotificationCapsule`, one size. Wrapping labels
  inside layer-shell windows need `max_width_chars`: a wrapping `Gtk.Label` requests the
  full *unwrapped* text width as its natural width, and a layer window sizes to natural
  (the NC's scroll clamps it, a popup window balloons).

### Capsule→island morph — `MorphRevealer`

**`MorphRevealer`** (`common/MorphRevealer.ts`) is the Dynamic-Island variant of the same
engine: ONE shape that transforms. Instead of scaling a rendered container (which
stretches the 1px border and the corners), mid-morph the revealer paints a Cairo squircle
**every frame with truly interpolated geometry** — rect, corner radius, superellipse `n`,
glass alpha and border color all lerp from the capsule's pill (perfect pill ≡ `n=2`,
`r=h/2`) to the island container's recipe. It paints with the same `drawSquircle` +
params (inset 2, borderWidth 1, gloss) as `SquircleContainer` — which exposes its paint
layer as `(grid as any).glassArea` exactly for this — so the clone is pixel-identical to
both real widgets at the endpoints: the source capsule is hard-swapped for the clone on
frame 0 (opacity only, stays clickable geometry) and the island's real glass takes over
at rest. Hyprland's blur keys off painted pixels, so it follows the morph for free.
Three more tracks complete the "same object" illusion — the rule they implement:
**something must be on the glass at every instant of the flight** (an empty-glass window
reads as "content disappears and reappears", user-caught 2026-07-19). (a) **Traveling
pairs** (`MorphPair[]`): ghost twins of compact elements WITH a landing slot in the
expanded content fly from the live source element's bounds to where the landing element
is painted THIS frame (resting bounds pushed through the frame's content mapping —
chasing the resting position instead visibly desynced the ghosts from the still-scaling
content, as did a per-pair stagger; both tried and rejected, lockstep). Landing elements
are opacity-0 until rest; a pair whose source is unmapped (the compact mutated to another
page) is skipped and its landing element rides the content fade. Consumers: the 5
workspace dots → overview card headers (`makeWorkspaceDot` twins — the one shared dot,
identical render everywhere), and the media compact's cover art → the player panel's
96px artwork (ghost built at 96px and scaled DOWN so it stays sharp; the compact's art
radius is derived as `14*20/96` so pure uniform scaling matches BOTH endpoint swaps).
(b) The **source dissolve** (`sourceGhosts[]` + `getSourceGhost` + `getSourceContent`):
compact content WITHOUT a landing slot (media title/EQ; the whole media compact when
opening the overview) gets a twin that rides the growing shape (uniform scale, anchored
where the content sits in the pill, vertically centered) and dissolves over progress
[0, 0.35] — the compact melts INTO the island instead of blinking out on frame 0. The
compact can show ANY activity's form, so each revealer owns ONE twin per form
(single-parent rule) and `getSourceGhost` resolves the twin matching what the compact
shows NOW (latched per `reveal()`, both directions; null = no dissolve — the dots page,
whose landing pairs ARE the continuity).
GTK trap for ANY snapshot-painted ghost: `snapshot_child` already applies the child's
own margin offset, and `compute_bounds` on the real widget EXCLUDES its margins — so a
ghost twin must carry NO margins or every offset is applied twice (the media twin's
12px double-shift pushed the EQ past the glass edge mid-morph and made the contraction
land with a visible re-seat; user-caught 2026-07-19).
Ghost twins run NO timers — live text/phase is SHARED module state advanced only by the
real compact (the EQ phase in `PlayerIsland.tsx`; the shared pulse driver in
`common/PulseDots.ts`; the REC elapsed label in
`IslandActivities.tsx` syncs every registered label including the twins'), so ghosts
repaint bit-identical via the morph's own per-frame redraw (an idle ghost never damages
the bar). A mode with an art pair gets a media twin with a transparent art slot (layout
intact, the flying ghost owns those pixels — two visible copies would diverge
mid-flight). (c) The **content**
(`contentTarget`) fades in over the last stretch (progress 0.45→1) while the child
paints with the glass rect mapped onto the interpolated rect — content materializes
inside the already-formed shape; between the dissolve's end (0.35) and the content's
start (0.45) the flying pairs carry the continuity. (d) The **companions**
(`companions[]`): widgets that belong to the compact but are NOT the source rect — today
the island's indicator chips. The source widget itself is switched off outright
(`opacity = p <= 0 ? 1 : 0`) because the painted clone replaces it; a companion has no
clone and sits OUTSIDE the growing shape, so it ramps over the same [0, 0.35] window as
the source dissolve (a hard cut blinks it out while the island is still capsule-sized and
nowhere near covering it). **This is not optional polish: source and island live in ONE
surface, so the island's 5% glass does not hide — or blur — anything painted beside it.
Anything left lit next to the capsule reads straight through the open island** (found the
moment the chips shipped, 2026-08-01). Whatever is faded this way must also drop out of
`IslandWindow`'s input-region stamp, or it leaves an invisible dead patch: the compositor
reads a press there as INSIDE the grab and neither dismisses nor passes it on — which is
why `mount` takes a hitTargets GETTER. ⚠️ Since 2026-08-10 that same getter also feeds the
BLUR region, and the two want opposite things: a chip must leave the input stamp the moment
it is invisible, but on the way back OUT it ramps up again with no relayout to re-measure,
so nothing re-declares a rect for it. It is drawn because it falls inside
`IslandWindow`'s `BLUR_PAD_X = 200` (three chips ≈ 150px) — the pad is load-bearing, not
slack.
All bounds are
`compute_bounds`-re-read every frame so bar relayouts can't leave a stale origin. Same `reveal(open, onDone?)` contract as
`ScaleRevealer` (self-managed visibility, close-then-`onDone` for the input-region
refresh) — but easing is cubic **ease-in-out in BOTH directions**, a deliberate deviation
from the asymmetric rule: that rule serves fade-pops whose decelerating exit leaves a
low-opacity tail; the morph is a solid object and the transformation must read both
ways — ease-in on close compressed the whole spatial shrink into the final sprint and
read as "overview vanishes, capsule appears" (user-caught, 2026-07-19). A module-level
`SLOWMO` test dial multiplies both durations while the choreography is tuned by eye —
**ship at 1**. Gtk.Bin measure/allocate pass-through for the child (ghosts
are extra children allocated at natural size and placed at snapshot time), and the same
GC/teardown + interface-merge typing gotchas (`dismantle()` unparents ghosts too). Falls
back to an OVERLAY_POP-equivalent centered pop when the source is unmapped at open
(`fromSource` latched per open; no ghosts, landing dots ride the content fade).
**Consumer: the Activity Island** (`surfaces/island/ActivityIsland.tsx`) — the bar-center
capsule as a multi-purpose surface. The island owns the compact capsule (workspace dots
+ one page per activity, see architecture.md for the ACTIVITY REGISTRY) and a MODE
registry; `registerMode` builds one MorphRevealer per mode, wiring the
capsule as source, the mode's glass recipe (`glassFrom`/`glassTo`, read live per frame
from `Theme.chromeIsDark` + `barOpacity`/`overlayOpacity`; the overview end imports
`WO_GLASS` from `WorkspaceOverview.tsx`, the player end `PLAYER_GLASS` from
`PlayerIsland.tsx`, the battery end `BATTERY_GLASS` from `BatteryIsland.tsx` so recipe
and real paint can't drift), and the
`morphContent`/`morphGlass`/`morphDots`/`morphArt` handles the mode widget exposes
(`registerMode` turns morphDots/morphArt into `MorphPair`s — the morphArt pair belongs
to the mode's OWNER activity (`expandMode === mode.id`) and flies that activity's
`flyer` element (media art → panel art, battery glyph → alert glyph; ghost built at the
PANEL slot's size, scaled down; skipped while another activity fronts) — and gives every
revealer one source-dissolve twin per activity that declares `makeGhost`; only the
owner's twin gets `hideArt`). `Bar.tsx` stays
the mount point: it places the capsule, mounts the revealers, and on
`notify::island-mode` re-pins each revealer's top edge to the capsule's bounds
(`island.syncAnchor`) so the morph only inflates down/sideways — the capsule never
travels. Known affordance trade-off: while open, the island's rect overlaps the
bar-center strip, so re-clicking the capsule to close is off — Esc / outside click /
selecting a workspace close it. Known cosmetic nit: the capsule's hover border (accent,
via `hoverBorderAccent`) isn't replicated by the clone, so opening from hover snaps the
1px border to its rest color on frame 0. A future island mode (player, agent) is a
`registerMode` call plus a new id exported from `Status.ts` — not a new Status field.

## SCSS conventions and anti-patterns

These are the patterns that bite. Most "the styles look wrong" bugs in this codebase are violations of one of these.

1. **Avoid `background: none; border: none; box-shadow: none` chains** on internal nodes (`decoration`, `contents`, `ripple`, `focus-ring`, `outline`, viewport, list). If you find yourself needing ≥3 of these resets, the widget is probably Adwaita and should be a GTK base widget instead. Use `@mixin nidara-reset` for the canonical reset.
2. **Avoid long specificity chains** like `window.x preferencespage preferencesgroup list.boxed-list row`. They're a strong signal you're fighting Adwaita and should switch to base GTK + a flat custom class.
   - The fix: add `add_css_class("nidara-foo")` in TSX and style a flat `.nidara-foo`.
3. **Avoid color literals.** Resolve against tokens (`--nidara-danger`, etc.). The legitimate exceptions are the accent swatches and the danger/success/warning seeds inside `NidaraTheme.ts`.
4. **Use `@mixin glass($level)`** (surface / raised / floating) instead of repeating ~20 glass blocks. *Currently underused — only 2 call sites; migrating the rest is open work (see `tech-debt.md`).*
5. **`background-clip: padding-box` + `border: Npx solid transparent`** for "visual thickness ≠ real thickness" (avoids negative margins that break `GtkGizmo`).
6. **No `transform: scale` or `transform: translate` on interactive widgets.** GTK respects them but they break hit-testing. Use `margin`, scale inside Cairo, or — for transient show/hide animations — a snapshot-time transform that ends at identity (see `ScaleRevealer` above). *(CSS transforms currently clean: 0 occurrences. Don't reintroduce them.)*
7. **All SURFACE CSS wrapped in its window's selector** — never global unscoped. The exception is
   deliberate and narrow: `_base.scss` (tokens on `*`, which must inherit into every window and
   popover) and the TWO `_components.scss` (the shared widget kit — `entry`, `.nidara-*` — used
   by all of them) are the design system's GLOBAL layer, plus `_reset.scss`'s neutralization and
   any `@keyframes` (not scopable in CSS at all).

   📄 **"The kit's stylesheet" — `_components.scss` exists twice since 2026-08-10.**
   `ui/lib/styles/_components.scss` is the kit's own, written so more than one bundle can
   compile it; `ui/shell/styles/_components.scss` is the half that is still the shell's. **One
   mechanical test decides which, not a judgement call: a rule goes to `ui/lib/` iff the widget
   that wears it is built in `ui/lib/`.** Grep the class there and everyone gets the same
   answer. So `.nidara-tooltip` and `.nidara-circle-btn` did NOT move (their `common/Tooltip.ts`
   and `common/IconButton.ts` are the shell's) while the whole `Gtk.DropDown` block did
   (`scrolled.ts` exports `NidaraDropDown`). **A `nidara-*` class still in the shell's sheet is
   not a leftover to sweep** — same legitimate mismatch as `nidara-media-*`: the PREFIX says who
   owns the class, the SHEET says which bundles compile it. Elsewhere in this document, a bare
   `_components.scss` means whichever half holds the rule being discussed.

   ⚠️ **The greeter and the lockscreen DO import it, since 2026-08-10** — what earned the
   import was migrating their three raw `Gtk.DropDown`s to `NidaraDropDown` (PR #114, see "The
   greeter wears the kit" above). Two things stay sharp on that side. The file carries
   BARE-ELEMENT selectors (`entry`, `selection`, `dropdown > button`, `dropdown popover`) that
   match without a class and collide with what those two already declare; source order saves
   them (Sass emits a module BEFORE the file that `@use`s it, so the login sheet out-ranks the
   kit at equal specificity) and nothing here may rely on being last. And there is a TOKEN
   CONTRACT: the kit's rules read 22 `--nidara-*` custom properties (15 in the sheet itself,
   the rest via `_mixins.scss`; re-measure with a grep over BOTH, that is where the number comes
   from), an undefined one does not
   warn — the declaration is simply dropped — so **adding a `var(--nidara-…)` to the kit's sheet
   is a change to every consumer's palette block**, verified by grepping the compiled sheet, on
   two surfaces with no dev mode. (The slider's move on 2026-08-15 brought exactly one rule,
   `.slider-fill-value`, and the slider ROW's move on 2026-08-16 brought one more,
   `.slider-value-label`; neither added a token — they read `--nidara-text` and
   `--nidara-text-dim`, both already in the contract. ⚠️ `.slider-value-label` is now worn on
   BOTH sides, since the shell still builds six readouts by hand. That is not a mistake to
   sweep: when a class ends up built in `ui/lib/` AND in the shell, the kit's sheet is where it
   must live, because the shell compiles both and a lone bundle does not.) Everything else names a window. Both spellings are in
   use because both are set in TSX — id **and** class, and they differ:

   | Window | Scope selector |
   |---|---|
   | Bar (+ CC, NC, Prism, system menu — commandment 5) | `#nidara-bar, .nidara-bar-window` |
   | Activity Island (+ workspace overview) | `#nidara-island, .nidara-island-window` |
   | Dock | `#nidara-dock, .nidara-dock-window` |
   | App grid | `#nidara-app-grid, .nidara-app-grid-window` |
   | Settings | `window.nidara-settings-window` |
   | About | `window#nidara-about, .about-floating-window` |
   | Alert dialog (`showNidaraAlert`) | `window.nidara-alert-dialog` |

   ⚠️ **The window a class lands in is NOT the directory its TSX lives in.** `_bar.scss` was the last
   unscoped surface sheet (closed 2026-08-10) and the mapping was not what the filenames said:
   `Bar.tsx` builds the capsule row and hands it to `islandWin.mount()`, so `.bar-center` — declared
   in `surfaces/bar/` — renders inside `#nidara-island` and nowhere else, while `.bar-centerbox` is
   built twice and genuinely needs both scopes. `.workspace-dot` never appears in the bar at all
   (`makeWorkspaceDot` is called only from the island and from the overview, which is mounted inside
   the island). Scoping either one to `#nidara-bar` on the strength of its filename would have
   silently unstyled the capsule and every workspace dot. **Follow the mount site, not the folder:**
   grep the class, then grep where the widget holding it is `append`ed / `mount`ed.

   ⚠️ **Parent-referencing `&` and a scope wrapper do not mix.** `.app-grid-search-box:focus-within &`
   written inside `.app-grid-search-icon` was correct while that rule was top-level; once `#102`
   wrapped the file in the window scope, `&` expanded to `#nidara-app-grid .app-grid-search-icon` and
   the rule compiled to `.app-grid-search-box:focus-within #nidara-app-grid .app-grid-search-icon` — a
   window nested inside a search box, unmatchable. The search icon stopped turning accent and nothing
   reported it (found and fixed 2026-08-10). **When a rule needs an ancestor's state, nest it under
   that ancestor** (`&:focus-within .app-grid-search-icon`), never reach back up with `&`. After
   adding a scope wrapper, grep the compiled `style.css` for `#nidara-` appearing anywhere other than
   the START of a selector — every hit is a rule that can never match.

   ⚠️ **A transient is a SIBLING root, not a child — the caller's window is not the widget's
   window.** `showNidaraAlert` builds `new Gtk.Window` and sets `transient_for`; a `Gtk.Window` is
   always a `GtkRoot`, so nothing rooted at another window can ever reach it. Its rules sat at
   column 0 in `_settings.scss` and worked from 2026-05-24; scoping that sheet (#97, 2026-08-07)
   swept them inside, they compiled to `window.nidara-settings-window window.nidara-alert-dialog`
   — a window inside a window — and the whole `.nidara-alert-*` family died. Bluetooth pairing, the
   Display resolution confirm and Delete user rendered as raw GTK for three days: measured on the
   real tree, the footer buttons came back `4 9` padding against their declared `14 16` (a 48px row
   collapsed to ~28) and the heading at weight 400 instead of 600. Fixed 2026-08-10 by giving it
   `_alert.scss` with its own root, exactly like `.about-*` got `_about.scss` in the same sweep.

   🔑 **The trap was that it looked legitimate.** `.about-*` was in `_bar.scss` "only by position"
   and read as obviously misfiled; the alert dialog is *called only from Settings*, so filing it
   with Settings looked right. Ask which window the widget IS, never which window opens it.
   `scope-audit.mjs`'s pass 2 now catches this shape without needing to know the window exists.

   ⚠️ **An atomic widget has no surface, so its CSS belongs to the kit.** Anything under `widgets/`
   is placed by the USER (bar, CC grid, wherever the plugin system lands it next), so its classes go
   in `_components.scss`, not in the sheet of whichever surface happens to host it today. That is why
   `.bar-popover-key/-val/-value/-icon-btn` all live there despite the `bar-` prefix in the name.

   🔑 **A class prefix names its OWNER, not the window it happens to render in — and a prefix that
   lies is a bug waiting to be written.** Settled 2026-08-10 by renaming the last three families that
   claimed the Control Center owned them: `cc-atomic-*` → **`nidara-atomic-*`** (the vocabulary every
   `widgets/` atomic wears — also worn by `AvatarCropper` and three Settings pages, another window
   entirely), `cc-media-*` → **`nidara-media-*`** (`widgets/media.ts`'s one panel, shown by three
   surfaces across two windows), and `cc-detail-panel`/`-section-label` → **`nidara-detail-*`** (worn
   by `MenuRow` and four widgets). The `-atomic` SUFFIX went too where the `nidara-atomic-`/`-media-`
   prefix already carried it (`cc-media-btn-atomic` → `nidara-media-btn`).

   The `cc-*` names that SURVIVED are the test of the rule, not an exception to it: `cc-open`,
   `cc-edit-mode`, `cc-edit-pill`, `cc-drag-source`, `cc-drop-ghost`, `cc-slot-placeholder`,
   `cc-resize-btn`, `cc-context-menu`, `cc-island`, `cc-capsule-btn` and the `cc-status-*` family are
   the Control Center's own chrome — its grid, its edit mode, its tiles. **Do not sweep a prefix
   because it is a prefix**; sweep the names whose owner is somewhere else. (`cc-detail-id` is not a
   class at all — it is a `Status.ts` `ParamSpec`. Leave it.)

   ⚠️ **Renaming is NOT relocating, and the two must not ride together.** `nidara-media-*` still
   lives in `_control-center.scss` under BOTH window scopes, deliberately: dropping it into
   `_components.scss` would make it global and change which rules outrank it (see the media block's
   own comment). A `nidara-*` class in a surface sheet is the one legitimate mismatch — the prefix
   answers *who owns this*, the sheet answers *at what specificity*. Verify a rename with a compiled
   diff: normalise the new names back to the old ones in `style.css` and it must come out **byte
   identical**. Anything else is a behaviour change wearing a rename's clothes.

   ⚠️ **A shared widget spans scopes and must list them all.** `common/WorkspaceSchematic.ts` renders
   into the island (overview) *and* the app grid (workspace strip), so `_workspace.scss` carries two
   blocks. Put a `.wo-schematic-*` rule in the island-only block and it silently stops painting in
   the app grid — nothing errors, the strip just goes flat.

   The one that actually shipped broken: `widgets/media.ts` builds ONE panel
   (`buildMediaDetailPanel`) and three surfaces show it — the bar pill expansion and the CC detail
   page, both inside the bar's window, **and the island's PLAYER mode** (`PlayerIsland.tsx`). Its
   `.nidara-media-*` rules were inside `_control-center.scss`'s `#nidara-bar` block, so from the day the
   island got its own window (2026-07-26) the transport buttons and the source selector rendered with
   raw GTK defaults there. Nobody noticed until 2026-08-10. They now carry both scopes — and
   deliberately stay **window-scoped rather than global**, so that whatever outranks them in the bar
   outranks them identically in the island; dropping to a bare `.nidara-media-*` would have changed that
   balance in one window only (`.cc-island button` and `.bar-center button` are both (1,1,1)).

   **The detector is committed: `scripts/dev/scope-audit.mjs`** (`node ../../scripts/dev/scope-audit.mjs`
   from `ui/shell`, after a build). It collects every class used by code that renders into each
   window and checks the compiled `style.css` for at least one selector that is either unscoped or
   scoped to that window. Classes with no CSS at all are Cairo-painted and fine; classes whose only
   selectors name a *different* window are the bug. **Re-run it whenever a surface moves windows** —
   it found the media panel, the "Default" badge and the slider readout in one pass. Details and its
   limits in `dev-workflow.md`.

   ⚠️ **A window's scope can MOVE, and nothing tells you.** The app grid's was `#nidara-dock` until
   2026-08-09, because the panel lived inside the dock's window; giving it a surface of its own
   (`AppGridWindow.ts`) changed the scope of `_app-grid.scss` **and** of `_workspace.scss`'s shared
   block **and** of the app grid's entries in `_reset.scss`'s two neutralization lists. Miss any one
   of the three and the rules stop matching in silence — no SCSS error, no GTK warning, just
   unstyled widgets. When a surface changes windows, `grep` the OLD scope selector across
   `styles/` before you call the move done.

   ⚠️ **Scoping changes what an unrooted widget resolves.** A probe that builds a widget outside a
   matching window gets NO styling and reads 0 for everything, with no error. That is why
   `scripts/dev/gtk-probe.js` takes `SCOPE=settings|bar|island|dock|appgrid` — measured proof it matters: the
   same dropdown row is 29px in the Settings window (which re-anchors control text to the relative
   `$fse-*` ramp) and 28px in any other.

## When you're tempted to invent a new pattern

Before adding a new mixin, new token, or new class convention: check whether `_base.scss` already has it, and whether `@mixin glass` / `@mixin nidara-reset` cover the case. Migrating to existing mixins is a stated direction of the project (`@mixin glass` underuse is item #5 in the tech-debt list); adding a parallel pattern makes the future migration worse.

## The login card: a message that cannot move it, and an entrance (2026-08-10)

Two changes to `.greeter-card`, both on the shared sheet so the greeter and the lockscreen
get them together.

### The failure message no longer shifts the card

The card is `valign: CENTER`, so anything that changes its height moves its whole contents.
Showing "Wrong password" added 30px and lifted the avatar, the name, the field and the
button by **15px each** — half of it, because centring splits growth in two. Failing a
password moved the field you were about to retype in.

🔑 **The fix is toggling `opacity`, not `visible`, and the reason is a GTK fact worth
keeping: an EMPTY `Gtk.Label` still measures one line.** So the error capsule is 24px tall
whether it holds a message or nothing, and leaving it ALLOCATED (opacity 0) reserves exactly
the right space with no number involved. `visible = false` is what breaks it — a hidden
widget gets no allocation at all.

⚠️ **A `min-height: 30px` on the slot shipped in the first draft, looked like the mechanism,
and was not.** It only made the slot 6px taller than the capsule inside it; the mutation test
(set it to 0) changed nothing. Reserving by NUMBER would also have been the fragile version,
because the right number is the user's UI font rather than a constant. It was removed.

One line is the true worst case, measured rather than assumed: all 36 real messages
(12 locales × `wrongPassword`/`noSession`/`loginError`) are 24px tall, none wraps, and the
widest is 216px against the card's 280.

**The cost, stated:** the strip is always reserved, so with no error on screen the card sits
15px higher than it used to. Same 15px — paid once, statically, instead of on every failure.

**The slot sits directly under the primary button, and nothing goes between them.** The message
is about the password, so it belongs under the field and button it refers to. The greeter's
session selector and user switcher both go BELOW it (`card.append`); an earlier
`insertBeforeError` put the selector in between and pushed the failure two rows down, reading
as if it belonged to the selector. Reserving the slot is what keeps the layout still — WHERE it
sits was always a free choice, and this is the lockscreen's order, which had it right by having
nothing else to place.

### The card rises as it fades in — driven by the frame clock, NOT by CSS

Both blocks fade in while rising ~21px over 450ms on `$ease-emphasized`. The animation lives
in **`ui/lib/entrance.ts`** and is written in JS. It was CSS first, and the story of why it
is not any more is the useful part.

🔑 **A CSS transition SNAPS on a session-lock surface.** Measured on a real lock, with the
class added on a genuine frame and frames flowing:

```
+0ms    hero y=93.0   card y=614.0   frames=1     ← FROM state
        (class added 2ms later)
+60ms   hero y=72.0   card y=594.0   frames=3     ← already final, 8ms on
+700ms  hero y=72.0   card y=594.0   frames=67
```

The whole 21px in under 8ms. The same stylesheet interpolates correctly in an ordinary
`Gtk.Window` on the same machine (538→533→522→518→517), so this is not the CSS being wrong.

The likely cause: under `ext-session-lock-v1` the surface gets **no frames for ~60ms** after
`map`, and then the first two ticks arrive in one catch-up burst about 2ms apart — so the FROM
state is laid out but never PAINTED, and a transition with nothing painted to interpolate from
is skipped. "Likely" is deliberate: what is measured is that it snaps, not why GTK decided to.

Two earlier attempts at keeping CSS both failed on the same precondition, and are worth not
repeating: a `GLib.timeout_add(…, 16, …)` "next frame" (it is wall clock — it fired 44ms
before any frame existed), and revealing on the second frame-clock tick (the ticks are the
catch-up burst). **The frame clock is the one thing that surface does reliably provide**, so
the animation now uses it directly and sets its own FROM state in `map`, before the first
draw.

🔑 **POSITION AND ALPHA DO NOT SHARE A CURVE.** They did at first, and the user's report was
"I'm not sure the opacity changes at all". It did — measured straight off the pixels, mean
alpha 0.060 / 0.161 / 0.222 for widget opacity 0.27 / 0.73 / 1.00, exactly proportional, so it
was never a rendering question. The fault was the ramp: `$ease-emphasized` is a strong
decelerate, so on the real lock the card hit 0.73 by 150ms and 0.95 by 300, and the last 300ms
crawled across a difference the eye cannot resolve. **Motion decelerates; alpha is LINEAR.**
The same trace now reads 0.13 / 0.33 / 0.65 / 1.00, which is a fade you can actually see.

⚠️ **Numbers, and they differ per block to produce the same movement.** `.greeter-hero` is
`valign: START` and keeps all its rise (21); the card is `valign: CENTER`, where centring
hands half back (40 → ~21px). Both measured.

⚠️ **CAPTURE THE BASE MARGIN AT `map`, NOT AT BUILD.** `NidaraClock` starts its own entrance
from its constructor, and its HOST sets the real position afterwards
(`clockWidget.margin_top = 72` in `Lock.ts`/`Greeter.ts`). Reading it early captures 0 and the
block lands 72px too high — a permanent layout bug wearing an animation's clothes. Caught by
mutation, not by eye.

⚠️ **The animation is an enhancement, never a gate.** The widget starts at `opacity: 0`, so a
frame clock that never ticks would mean an invisible login card. A timeout lands the end state
regardless; only the movement is lost. Verified by killing the tick callback: the card still
arrives.

⚠️ **THE CLOCK STARTS AT THE FIRST FRAME, NOT AT `map`.** Same failure as the CSS version, one
level down: in a VM the lock's main loop can be busy for >300ms after `map` (cold and warm
alike), and a clock anchored there hands the first tick a budget that is already spent — so it
settles immediately and the animation snaps, exactly what this file exists to prevent. Wall
time between `map` and the first frame is startup cost, not animation. The FROM state still
goes in `map` (that precondition is untouched); only the counting moves. The watchdog is armed
from `map` for "no frames ever" and re-armed by the first tick, or a late start would have it
fire mid-animation. Measured in the VM, before → after:

```
before:  93 93 93 93 → 72     (four samples of the FROM state, then the end)
after:   93 … 73 72 72        (0 → 0.65 → 0.98 → 1.00 opacity)
```

`NIDARA_ENTRANCE_TRACE=1 nidara-lock` prints the interpolation — distinct positions mean it
ran, one value repeated means it snapped. Keep it: this animation was diagnosed three times
from the log alone, and it is what confirmed the fix on the real surface:

```
+0ms    hero y=93.0 op=0.00 margin=93     card y=614.0 op=0.00 margin=40
+60ms   hero y=87.0 op=0.27               card y=608.0 op=0.27 margin=29
+150ms  hero y=78.0 op=0.73               card y=599.0 op=0.73 margin=11
+450ms  hero y=72.0 op=1.00               card y=594.0 op=1.00 margin=0
```

21px and 20px of travel, identical opacity at every sample — in lockstep on hardware, not
just in the compiled sheet. The card's margin running 40→29→11→2→0 against 20px of movement is
the centring halving, visible in one line.

⚠️ **DO NOT restore `opacity`/`transition` rules for `.greeter-card` or `.greeter-hero` in the
stylesheet.** They would fight the JS that owns both properties, and on the one surface that
matters they never worked.

<!-- Rescued 2026-08-11 from the duplicate copy of this file (see the commit that removed it):
     these rules existed ONLY in the stale copy. The first two are moved verbatim; the
     never-a-gate one is rewritten against `ui/lib/entrance.ts` as it stands, because the
     version in the stale copy still described the CSS mechanism that was replaced. -->

⚠️ **The general lesson beyond this file: on a session-lock surface, `map` is not "the screen
is showing this".** Anything timed from `map` with a wall clock is racing a compositor handshake
it cannot see.

⚠️ **And an entrance must never be a GATE.** The FROM state hides the card, so a frame clock that
never ticks would mean an invisible login screen — locked out by a flourish. `ui/lib/entrance.ts`
carries a watchdog timeout that lands the end state regardless, and calls it a contract rather
than a fallback for that reason. Any future entrance animation owes the same.

🔑 **Not staggered, and that is a rule rather than a preference: staggering says "these are
independent peers".** It is right for a list of rows arriving and wrong for the parts of one
object — a login card that assembles itself out of avatar, name, field and button reads as
machinery. The whole composition is ONE movement. (Apple's platforms stagger collections, not
the components of a single control; that part is design reasoning and recollection, not
something measurable from this repo — unlike every number above it.)

⚠️ **DO NOT MEASURE THESE ANIMATIONS BY SAMPLING FRAMES.** A throwaway probe window only
advances CSS transitions while the compositor grants it frames, and on a tiling WM it may not:
a timed probe read **0px of travel and reported it as a pass**, twice, because the transition
was frozen rather than finished. Measure the TWO STATES instead — add and remove the `-shown`
class with `transition: none` layered on top, and diff the positions. Frame-independent, and
it is what determines the travel anyway. See `feedback_prove_the_test_can_fail` in memory.

### The exit is a DELAY, not a transition

🔑 **There is no moment in which an unlock transition could be seen.** The instant
`Gtk4SessionLock.unlock()` is called the compositor takes the surface down and the session is
simply there. macOS, iOS and GNOME all cross-fade lock→desktop because they ARE the
compositor; under `ext-session-lock-v1` we are a client and own only the half that leaves. So
an exit animation is latency, deliberately spent, and it has to be priced as such.

What makes 150ms worth it is a fact about the wallpaper: **the lockscreen paints the same
image as the desktop.** Not "unless overridden" — `ui/lib/wallpaper.ts` RESERVES a `surfaces`
block and `resolveWallpaper` reads it, but nothing writes one and Settings does not expose it,
so as of 2026-08-10 the two are always identical. ⚠️ **Whoever implements per-surface
wallpapers has to revisit this exit**: a different lock image makes the held wallpaper
discontinuous with the desktop and the final cut becomes the thing the fade was bought to
avoid. Do not add a check before it can happen — there is nothing to detect today.

So `playExit` fades the UI — card, hero, power bar — and HOLDS the wallpaper
and the scrim. The final cut is then a change of what is *on* the wallpaper rather than a
change of everything. The bar, the dock and the user's windows still pop in; that half is not
ours.

⚠️ **The exit covers EVERY monitor.** `buildWindow` runs once per monitor, so the fade targets
are collected module-wide in `Lock.ts` (`exitTargets`) and one `requestUnlock` dissolves all of
them. Per-window, a two-screen setup would dissolve the active monitor and hard-cut the other.

⚠️ **`playExit`'s callback is a CONTRACT, not a nicety: it is what unlocks the session.** A
dropped callback is a user locked out of their own machine, so a timeout fires it regardless of
the frame clock. Verified by killing the tick callback in the bundle — unlock still runs
exactly once, at the timeout instead of at 157ms.

**Not done, deliberately:** a spring curve — Apple's real signature is spring physics rather
than bezier, and `stepSpring` in `DockPhysics.ts` already exists and substeps correctly, so it
would be its second consumer and the trigger to promote it to `ui/lib/`. Now that the
animation is a tick loop, it is a drop-in swap for the easing function.

### ⚠️ Text is only crisp when the line box lands on WHOLE PIXELS

Two independent things have to hold, and both are set in `ThemeManager`. The symptom when
either fails is not "blurry text" — it reads as **the tops of some letters being shaved**,
which is why it went unfixed for so long: flat-topped glyphs (T E F H I L) put a full-width
bar on their top row, so losing half its coverage is obvious, while round ones (G O C S) put
three or four pixels up there and look fine. "In GTK the T is cut but the G isn't" is the
signature of this bug, not of a clipping one.

🔑 **The cure is ONE global switch, and it is not a font size.** `ui/lib/font-rendering.ts` →
`applyCrispFontRendering()`, called once per bundle before any window exists (shell via
`ThemeManager.syncFontMetrics`, greeter and lockscreen in their `main()`). It sets
**`gtk-font-rendering = MANUAL`** *and* `gtk-hint-font-metrics = true`.

⚠️ **`gtk-hint-font-metrics` alone does nothing.** GTK 4.16 added `gtk-font-rendering`, whose
default `AUTOMATIC` means "GTK decides" — and that includes ignoring the low-level font
settings, the metric hint among them. Nidara set the hint from #123 onwards with **zero
effect**; the fix only landed when the mode went to MANUAL (2026-08-11). Measured, one process
per configuration, flag set before any widget exists:

| `gtk-font-rendering` | `hint-font-metrics` | Inter 15px | JetBrainsMono 15px |
|---|---|---|---|
| AUTOMATIC (the default, what #123 shipped) | true | baseline 14.531 ✗ | 15.300 ✗ |
| **MANUAL** | **true** | **15.000 ✓** | **16.000 ✓** |
| MANUAL | false | 14.531 ✗ | 15.300 ✗ |

The third row is the control: MANUAL is only the gate, the hint does the work. Logical heights
go integral too (mono 15px: 19.80 → 21.00), which is why row geometry stops jittering.

⚠️ **A whole-pixel font size was never the cure**, and believing it was cost three rounds of
patches. The baseline is `size × ascender/upem`, fractional for essentially every size: a clean
15px puts JetBrainsMono's baseline at 15.300, while the old 11pt/14.667px was actually CLOSER
to the grid at 14.209 — exactly why the user reported monospace looking *worse* after the size
was "fixed". The whole-pixel snap has since been **removed** (it also broke the accessibility
text scale); see "the font SIZE is not part of this" below.

⚠️ MANUAL also hands `gtk-xft-antialias/hinting/hintstyle/rgba` back to fontconfig, so a machine
configured for subpixel rendering now gets it instead of AUTOMATIC's grayscale. That is what
the mode means, but it is a visible change.

🔧 Two GJS limits found on the way, worth knowing before re-investigating: `cairo.FontOptions`
has **no foreign-type marshaller** (`PangoCairo.context_get_font_options` throws, and it cannot
be constructed), so font options can only be driven through GtkSettings; and flipping a font
setting at runtime does not update an existing Pango context — a probe that toggles in-process
prints two identical tables that look like a result. One process per configuration.

**`gtk-hint-font-metrics = true`** (`syncFontMetrics`, gated by the MANUAL mode above) rounds the
font's ascent/descent to whole pixels, so the baseline lands ON a row. Measured with the same
font at the same 14.667px: metrics OFF → ascent `14.208984375`, the T's crossbar smeared across
two rows (`#######+` over `+++##++.`); metrics ON → ascent `15.0`, one crisp row (`.########`).
GTK turns this off by default to serve fractional display scaling.

### ⛔ The font SIZE is not part of this, and the DE stores POINTS

This is the trap that ate #123, #124 and most of a third branch, so it is written as a rule:
**never reach for the font size to fix rendering, and never store an absolute pixel size.**

The reasoning that looked right: the font dialog returns POINTS, at 96dpi `Inter 11` is 14.667px,
the `$fse-*` ramp is relative so every rung inherits that fraction — therefore snap the anchor to
a whole pixel (`Inter 14px`, then `Inter 15px`) and the ramp lands on the grid. Two things were
wrong with it.

1. **It does nothing for crispness.** The hint rounds the ASCENT, and it does that just as well
   at a fractional size. Measured 2026-08-11, one process per configuration, ascent from a
   realized widget's own Pango context:

   | config | Inter 11pt (14.667px) | Inter 15px | Mono 11pt | Mono 15px |
   |---|---|---|---|---|
   | AUTOMATIC + hint | 14.209 ✗ | 14.531 ✗ | 14.960 ✗ | 15.300 ✗ |
   | **MANUAL + hint** | **15.000 ✓** | **15.000 ✓** | **15.000 ✓** | **16.000 ✓** |
   | MANUAL, no hint | 14.209 ✗ | 14.531 ✗ | 14.960 ✗ | 15.300 ✗ |

   The fractional point size is on the grid exactly as much as the whole-pixel one. (Row 3 is the
   control that makes row 2 mean something — see `feedback_prove_the_test_can_fail`.)

2. **An absolute pixel size breaks accessibility, and no workaround makes it whole.** GTK applies
   `text-scaling-factor` by multiplying `gtk-xft-dpi` (measured: factor 1.0 → dpi 96, 1.25 → 120,
   1.5 → 144), and a pixel size is immune to dpi by definition. So `Inter 14px` killed the
   Accessibility text slider outright. Rescaling the fonts ourselves from an unscaled base —
   which is what the branch did next — was worse than dead: the effective size was
   `round(basePx × factor)`, so the whole 0.75–2.0 range held **20 distinct sizes and ~5 of every
   6 thumb positions changed nothing**, and a mono base of a different size stepped at different
   positions than the UI. A pixel is the coarsest possible step for a continuous control.

So: **`gtk-font-name` holds a POINT size** (seeded `Inter 11` / `JetBrainsMono Nerd Font 11`, the
same 11 every install has shipped since PR #6), `ThemeManager.fontToPoints` converts any pick —
and any px font left by a previous version or by nwg-look/Tweaks — to whole points on the way in,
and `migrateFontsToPoints` runs it once at boot so an upgraded install is repaired. Nothing in
`ThemeManager` touches the size when the text scale moves: GTK does it, through the dpi,
continuously (measured: 1.10 → 16.13px, 1.13 → 16.57px, 1.17 → 17.16px).

🔑 **The lesson worth more than the fix**: the anchor is a product decision, the ramp is
arithmetic, and *the rendering is a toolkit switch*. Three rounds of patches moved the first two
looking for a result that only ever came from the third. See `feedback_mechanical_over_logic`.

The chrome's fixed `$fs-*` px ramp does NOT follow the factor and never has (macOS behaviour —
window content scales, the bar and dock do not); `_reset.scss` pins `font-size` on the bar, dock,
island and app-grid windows, and CC/NC/Prism inherit it by living inside the bar's window.

🔧 To check a suspicion, dump the pixels rather than squinting:
`magick shot.png -crop WxH+X+Y +repage -colorspace Gray txt:-` and print `#`/`+`/`.` by
threshold. A crisp horizontal stroke is ONE full-intensity row; a smeared one is two partial
rows. That is also how the same investigation ruled out the font family, the VM, transparent
backgrounds and `queue_draw`.


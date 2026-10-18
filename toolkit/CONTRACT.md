# The toolkit, phase 0 — the contract

Part of #818 (read it first: the goal, the owner's decisions, Astra's review and its triage).
This file is what each piece of phase 0 offers the others. It is merged **before** the code that
uses it; a change to it is a change to this file, in its own commit, said in #818. The code may
show a part of it wrong — that is what phase 0 is for — and then the file is corrected first.

Phase 0 is a **test window**, not a toolkit. Nothing here is a public API yet. What must hold
already is the shape: which crate owns what, and which way the dependencies point, because that
is what lets several agents work at once without touching the same file.

## The gate

Five tests, all on Hyalo. If one fails, the owner decides there (#818).

| # | Test | Passes when |
|---|---|---|
| 1 | Text | **Passed: Parley** (owner, 2026-10-15, #824/#825) — every case on Arch and Ubuntu, measuring and painting sharing one layout object. Pango failed one case on Arch (two on Ubuntu) and was removed |
| 2 | IME | **Automated gate #832/#841 (126 assertion/control pairs):** the real fcitx5 matrix (below), Mozc/Pinyin/Hangul at 1 and 1.25, including discriminating fault controls, must pass in the `hyalo` vkms job. Escape cancels for Mozc/Pinyin; Hangul commits its syllable and one Ctrl+Z undoes that commit. The scripted input method alone cannot pass this gate |
| 3 | Orca | **Automated gate #835/#841/#846 (26 speech assertions, 24 fault runs plus the denied-listener control):** real Orca’s `SPEECH OUTPUT` must pass the form walk and its controls in the `hyalo` vkms job. **Provider chosen: direct AT-SPI** (#834; active windows added in #839). Selection support is provided by #842; open/closed state changes must present the current/final value, without requiring literal “expanded”/“collapsed” |
| 4 | Glass | the window's panes are painted by Hyalo through `nidara-material-v1`, as the shell's are. **Passed** (2026-10-17, the owner's live Hyalo session, DP-1 at 2560×1440): `nk-phase0` tiled beside real apps; Hyalo reports `glass: {shapes: 1, compositor_paints: true}` for it and paints the frosted pane like the shell's, while `--control-no-material` shows the wallpaper sharp and unfrosted through the same pane. The CI oracle (`nk-phase0-check.py`) already asserts the committed `glass` state and that the control loses it |
| 5 | Animation | two layers animated by Hyalo while the client commits nothing for 500 ms; a click during the motion reaches the layer where it is SEEN. **Passed** (#831/#837, CI at scale 1 and 1.25): `nk-phase0 --test5` blocks 1.5 s with 0.000 s of CPU while both layers move, the click lands where A is seen, in A's coordinates; three fault controls fail as they should. A retarget's kept velocity is proven by Hyalo's unit test, not by screenshots (they cannot date the retarget) |

Not gates, measured in phase 0 because they decide something: the GPU path (experiment 6) and
the cost of one window (start-up, memory) for #818's phase 1 comparison.

## Where it lives

```
toolkit/                     its own Cargo workspace, like hyalo/ and session/ (#819)
  Cargo.toml                 edition, lints and rust-version match hyalo/
  CONTRACT.md                this file
  crates/
    nk-text/                 text: layout, shaping, editing model          (pure, no Wayland)
    nk-a11y/                 the semantic tree + its AT-SPI projection     (pure, no Wayland)
    nk-render/               rasterises a frame into pixels                (no Wayland)
    nk-wayland/              the connection: window, buffers, input, IME, our protocols
  phase0/                    the test window (a binary, nk-phase0), and its checks
protocols/
  nidara-layers-v1.xml       NEW, the layers protocol (below) — both ends, like the others
hyalo/compositor/src/protocols/layers.rs   its server half
```

- **Dependencies point one way:** `phase0 → nk-wayland, nk-render, nk-a11y, nk-text`;
  `nk-render → nk-text` (it paints glyph runs); nothing else. `nk-text` and `nk-a11y` never
  import Wayland or each other, so they are built and tested with no compositor.
- **One workspace for the toolkit, separate from Hyalo's.** Nothing Rust is shared with Hyalo in
  phase 0: what both ends share is the protocol XML in `protocols/`, which each end generates
  its own half from (Hyalo with `wayland-server`, the kit with `wayland-client`). A shared crate
  appears only when a piece of logic must be identical on both ends; none is in phase 0.
- **Crate prefix `nk-`** (Nidara kit) is a working name. The public name is the owner's, later.
- **License: LGPL-3.0-or-later**, as the TypeScript kit, so an app of any license can use it.
  Our protocol XMLs are **MIT** (owner, 2026-10-15), as upstream Wayland's are: the client code
  generated from them goes into the kit, and into any toolkit that wants to speak to Hyalo.
- **CI:** a `toolkit` job — `cargo build --locked`, clippy `-D warnings`, unit tests, the text
  corpus, then tests 4 and 5 headless on Hyalo. Not required while Hyalo is a preview. Every
  check is preceded by a step that breaks it and requires it to fail.

## nk-text

Owns everything between a string and positioned glyphs, and the editing model on top.

- **One index for text: UTF-8 byte offsets** into the buffer, always on a char boundary. Every
  API takes and returns those; graphemes (`unicode-segmentation`), clusters and lines are
  ranges of them. text-input-v3 speaks byte offsets too, so the IME needs no conversion; AT-SPI
  speaks characters, converted at the edge in `nk-a11y`, never inside.
- `trait TextBackend`, implemented by **Parley** (feature `parley`, the chosen engine). It is
  fed a `TextStyle` (family, size, weight, line height, alignment, direction) and a `FontSet`.
  The trait stays so another engine can be measured against the same corpus; phase 0's Pango
  adapter was removed after the decision (the comparison is in `crates/nk-text/README.md`).
- `Layout` is the ONE object that is measured and painted: `size(max_width)`,
  `hit_test(point) → offset + affinity`, `caret_rect(offset, affinity)`,
  `selection_rects(range)`, `glyph_runs() → [GlyphRun { font, size, glyphs: [(id, x, y)] }]`.
  The renderer paints those runs; it never shapes again.
- `Editor` on a `Layout`: caret, selection (logical by offsets, drawn visually), move by
  grapheme/word/line (visual order for left/right in bidi), backspace/delete by grapheme,
  insert, replace range, undo/redo, the IME preedit as a separate range that is not part of
  the text until committed.
- **The corpus** (`crates/nk-text/corpus/`, one file per case, with what must hold): Arabic and
  Hebrew mixed with digits and Latin; Devanagari; Japanese, Chinese and Korean; combining
  marks; ZWJ emoji and flags; a font missing for one script (fallback); a variable font;
  line breaking at several widths; caret and backspace through each. The report names each
  failing case and why, with layout time and peak memory.

## nk-a11y

- A **semantic tree** owned by the window: `Node { id, role, name, description, states,
  actions, bounds, text: Option<TextInfo> }`. `id` is stable for the node's life and never
  reused within the window. `bounds` are window coordinates of the MODEL (the final values,
  not an animation's intermediate ones — as on the reference platform).
- `TextInfo` gives what AT-SPI Text and EditableText need: the text, caret, selection, and
  the boundaries (char/word/line). It is **plain data in UTF-8 byte offsets**, filled by the
  app from `nk-text`'s `Editor` (text, caret, selection, words) and `Layout` (lines);
  `nk-a11y` converts it to character offsets, here and nowhere else. So `nk-a11y` does not
  depend on `nk-text` (the rule above holds): it also serves text that never went through an
  `Editor`, and either crate can change engine without touching the other (#830).
- `TextInfo.geometry` optionally carries ordered UTF-8 cluster spans with real window-logical
  rectangles and their leading caret rectangles, plus the final caret. The app takes these from
  the **same retained Layout it paints**, adding the field's actual content origin (padding and
  scrolling included). Shaping computes cluster boxes once per reflow; a provider never guesses
  widths from character counts or substitutes the whole field's box. Scalars in one shaped
  cluster share its box. Missing geometry is `NotSupported`, not a fabricated rectangle; a
  committed buffer temporarily replaced by IME preedit is not described with stale layout data.
  Password filtering removes the entire `TextInfo`, geometry included.
- AT-SPI `GetRangeExtents` returns the union of intersecting cluster boxes for the requested
  half-open character range; `GetCharacterExtents` returns its shaped cluster box. A collapsed
  range uses the corresponding real caret, including the empty/end-of-text caret. UTF-8 to
  scalar conversion stays at the provider edge. Integer protocol rectangles round outward.
  Both use `WINDOW` coordinates, as real Orca does; unsupported coordinate systems and invalid
  offsets return explicit errors. This does not invent a global Wayland origin.
- Events, not just a snapshot: focus, name/state changes, text inserted/removed, caret moved,
  selection changed.
- A `Window`/`Dialog` node carries `states.active` while it holds the keyboard (the app sets it
  from `nk-wayland`'s `Event::Focus`). The provider maps it to AT-SPI `active` and sends
  `window:activate`/`deactivate` BEFORE any focus event of the same update: Orca ignores focus
  inside a frame that is not active (#835, found with real Orca; libatspi alone never asks).
- A `ComboBox` is a **selection container**: its options are ALWAYS its children (hidden while
  closed, as GTK's list), and the provider serves AT-SPI `Selection` from their `selected` state
  and sends `selection-changed` on the combo when the choice changes. Focus stays on the combo
  while it is open, so a reader does not present the options' own events: it reads the value
  through `Selection` and hears a change from `selection-changed` (#835, real Orca). Choosing
  through `SelectChild` is an `Activate` request on the option; deselecting returns false.
- **One provider: direct AT-SPI over zbus** (feature `atspi`), behind `trait A11yBackend`
  (owner, 2026-10-15, #830/#834): it passed the whole Orca-style walk; AccessKit failed the
  expanded and invalid-entry states, which its AT-SPI layer did not project. The trait stays
  so another provider can be measured on the same walk (`crates/nk-a11y/README.md`).
- A password field: role `password text`, its text never exposed (not to AT-SPI, not to the
  agents' projection). The agents' projection itself is phase 1; the tree is designed so it
  can be filtered per reader (#818 triage, point 13).

## nk-render

- Phase 0 paints on the **CPU, with `vello_cpu`, into a `wl_shm` buffer**. Enough for tests
  1–5; none of them measures the GPU.
- Experiment 6 (not a gate) is the GPU path: dmabuf buffers, the same scene through Vello on
  the GPU, delivered to Hyalo. It decides the renderer for phase 1 (#818 triage, point 10):
  formats, synchronisation, fractional scale, and what it costs against the CPU path.
- Premultiplied alpha, sRGB. Glyphs rasterised here from `nk-text`'s runs.

## nk-wayland

- `wayland-client`; our protocols generated from `../../protocols/*.xml`.
- A toplevel (xdg-shell), shm buffers, frame callbacks, `wp_presentation` feedback, fractional
  scale, the seat (pointer, keyboard with xkbcommon: Compose, dead keys, repeat).
- **text-input-v3 as a client** (the IME test): enable/disable with focus, `set_surrounding_text`
  (never for a password field: `content_type` purpose password, no surrounding text),
  `set_cursor_rectangle` in the field's surface coordinates, preedit and commit applied through
  `Editor`, the `done` serial respected.
- `nidara-material-v1`: the panes' shapes, sent with the buffer they describe (as `material.ts`),
  and the window's background colour (PHASE1.md D6, `Application::window_background`).
- **Any compositor (PHASE1.md D5):** `capabilities()` reads the globals; `wl_compositor`,
  `wl_shm`, `xdg_wm_base` and `wl_seat` are required (the start is refused, naming the missing
  one); without viewporter + fractional-scale the buffer scale is the integer
  `preferred_buffer_scale` (else the outputs'); without the material `Frame::material` is false
  and the app paints an opaque base; layers need the material, viewporter and subcompositor. An
  app that cannot live without Hyalo says so with `Options::require_material` (phase 0 does).
- The app names its window (`Options`: app-id, title, initial size) and is told after each
  frame's commit has been flushed (`Application::committed`, with the root commit's number —
  the initial empty commit is 1 — which `Event::Presented` carries back).
- `nidara-layers-v1` (below).

## The layers protocol — `nidara-layers-v1` (test 5)

The model is the reference platform's: the app says where a layer **ends**; the compositor
moves it there and keeps moving it whatever the app is doing.

- **A layer is a `wl_subsurface`** of the window. Only what must move on its own is a layer —
  a widget is NOT a surface; static content is painted together into its parent's buffer.
  Each layer has its own buffer, so a layer is moved without repainting anything.
- `nidara_layers_manager_v1.get_layer(surface)` gives a `nidara_layer_v1` for a surface that
  has the subsurface role. Its properties: **position** (relative to the parent), **scale**
  (uniform, about an anchor point) and **opacity**. Size and content are not animatable: they
  need the client (a new buffer).
- **Implicit transitions.** `set_transition(property, curve)` says how the NEXT change of that
  property moves; `set_position`/`set_scale`/`set_opacity` set the model value. Curves: a
  spring (mass, stiffness, damping, initial velocity) or a cubic Bézier with a duration. With no
  transition pending, a change is immediate.
- **Atomic with the content.** Layer state is double-buffered and applied with the surface's
  commit; with the subsurface in sync mode, all of a window's layers, their materials and its
  buffer land in ONE parent commit.
- **The presented value is Hyalo's.** A new model value while a transition runs starts from
  where the layer IS on screen (and, for a spring, at its current velocity) — retargeting, never
  a jump. Hyalo samples every transition at the moment the frame shows (`render/timing.rs`).
- **Input goes where the layer is SEEN.** Hyalo hit-tests subsurfaces at their presented
  transform and delivers pointer coordinates in the layer's own space (the inverse transform),
  so the client's own hit-testing inside a layer needs no knowledge of the animation. The text
  cursor rectangle of a field in a layer is mapped the same way (the IME's candidate window
  follows it).
- **A cursor explicitly names its layer.** The keyboard/text-input-v3 focus stays on
  the root. `nidara_layers_manager_v1.set_text_input_cursor_rectangle(root, layer,
  x, y, width, height)` stages a layer-local cursor rectangle with the root's commit.
  Hyalo maps it through the presented transform every frame, updating the input-method
  popup and its rectangle event while the app is blocked. A null layer clears the
  override, restoring the latest standard root-local rectangle. Destroying a layer
  clears the association; a replacement object does not inherit it. The client clears
  it when another field takes focus. Standard text-input-v3 never receives layer-local
  coordinates. This request neither enables input nor sends surrounding text.
- `done(serial)` event when a transition ends, with the presentation time; `cancelled(serial)`
  when a new value replaced it.
- A layer's own glass (a `nidara_material_v1` on the layer's surface) is NOT drawn yet: Hyalo
  draws the glass of a window's or a layer-shell surface's root. It comes with the shell
  (phase 2), the first thing that needs a moving pane of glass.
- **Limits:** at most 64 layers per window (protocol error past that). Not offered to
  sandboxed clients, as the material (#818 triage, point 6 — opening it to Flatpak apps is the
  later review of the trust boundary).
- **Out of phase 0, said so:** resize while the client is busy — Hyalo keeps showing the last
  buffer at its size, it does NOT stretch it; reflow follows when the client commits. Ink
  under animation (a client that cannot repaint cannot change its text colour): phase 2, with
  the shell.

**Test 5, exactly** (`scripts/ci/hyalo-layer-motion-check.py`, in the Hyalo smoke): the window
has layers A (a button) and B (a plain pane). The client gives both a 2 s linear transition to
x = 300, commits, then blocks for 1.5 s reading and committing nothing. Meanwhile, driven by
`HYALO_CONTROL`: screenshots at about +250 and +550 ms show A and B further right each time; a
click where A will END is not A's; a click where A is SEEN (found in a fresh screenshot) is A's,
inside it. When the client wakes it reads both clicks, and later `done` for both. The control,
seen failing: a Hyalo that hit-tests at the model position sends the first click to A.

## The test window (`phase0/`, binary `nk-phase0`)

One window, glass panes painted by Hyalo (test 4), holding:
- the corpus, laid out (test 1);
- a form: name field, password field, a dropdown, a checkbox, a button that opens a dialog
  with an error to correct, and a dialog that returns the focus where it was (test 3);
- the name field is the IME field (test 2);
- layers A and B and a button that starts test 5.

Minimal app invariants it already follows, so phase 1 does not start from scratch (#818
triage, point 15): a retained tree of widgets with stable ids; layout in two steps (measure
under constraints → size, then place), text measured through the same `Layout` it paints;
invalidation per kind (layout, paint, semantics); one focused node per window; the pointer
captured by the node it pressed until release.

### The IME matrix (test 2)

fcitx5 with Japanese (mozc), Chinese (pinyin) and Korean (hangul): preedit shown, replaced,
cancelled with Escape for Mozc/Pinyin (Hangul flushes its composing syllable as a commit, undone once with Ctrl+Z), committed; surrounding text right after moving the caret; backspace
during composition; focus moved to another field and to another window mid-composition; the
IME restarted while the field is focused; the candidate window next to the caret, also with
the field scrolled and at fractional scale 1.25. Compose and a dead key; key repeat. IBus only
if we decide to promise it.

### The form (test 3)

Keyboard and Orca only: Tab through every control, each announced with role, name and state;
type a name and fix it (caret moves and deletions read); select a word; the password typed and
NOT read back; the dropdown opened, an option chosen, closed; the dialog opened, its error
corrected, closed — and the focus back on the button that opened it.

## Who builds what

| Piece | Who | Depends on |
|---|---|---|
| this contract, `nidara-layers-v1.xml` | Claude | — |
| `nk-text` + corpus | GPT Sol — ✅ #825, Parley | only this contract |
| `nk-a11y`, both backends | Claude, or Sol once `nk-text` lands | `nk-text`'s `Editor` API (above) |
| `nk-wayland`, `nk-render`, `phase0/` (tests 1, 2, 4) | GPT Sol (#826) | the others' APIs as written here |
| Hyalo's server half of the layers protocol | Claude — ✅ #823 | the XML |

Different crates, different branches; the only shared file is this one, and it changes first.

## Real-component evidence (#832, #835)

Test 2 may enable `--ime-evidence` on the phase-0 window to log UTF-8 Editor
state, preedit and logical cursor geometry. Pixel evidence independently checks
the underline and candidate position; Wayland wire logs check surrounding text.
These diagnostics belong to the test window, never password fields. Each fault
control must fail the same assertion that passed on its baseline. An unrelated
failure, or a broken baseline, cannot establish a discriminating control.

Test 3 uses real Orca with a silent speech-dispatcher module. Paste is expected
to announce “Pasted contents from clipboard.”; reading the Unicode content is a
separate keyboard action. Only Orca may monitor the keyboard: a denied ordinary
listener is the access control’s negative case; Orca’s key echo proves delivery.

## Real-engine acceptance decisions (Claude, #841, 2026-10-16)

- Test 2: Mozc/Pinyin Escape cancels to `base`. Hangul Escape commits its
  composing syllable to `base하`, clears preedit, and one Ctrl+Z removes exactly
  that commit to `base`. The Hangul control drops the real engine commit and
  must fail. This preserves Korean engine policy, not a toolkit workaround.
- Test 3: on a focused combo Orca presents the selected value on its state
  change: Space → `Japanese`, Enter → `Chinese`. Literal expanded/collapsed
  words are not required (Orca emits those only for an ancestor combo). The
  expanded/collapse controls must suppress that presentation and be caught.
- Test-window-only fault files may arm one mutation immediately before an
  action. This lets the same scenario exercise baseline and fault without
  changing installed toolkit behaviour or sending artificial events to Orca.
  Each fault must log its actual application; no application, timeout or crash
  can count as a caught assertion. Editor JSON uses a separate file so concurrent
  Wayland debug output cannot interleave with a record.
- #846 extends test 3 with authentic Orca flat review (KP_Up/current line): its
  `SPEECH OUTPUT` must contain the complete `日本🙂 word` after a fresh review command.
  The test-window `text-extents` control publishes wrong geometry, logs actual application,
  and must fail that same assertion. Orca's returned-rectangle diagnostics establish that
  the wrong geometry was consumed; a timeout, crash or unapplied fault cannot count.
  Existing form-walk speech assertions and controls remain required.

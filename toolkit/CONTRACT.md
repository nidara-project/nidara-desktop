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
| 1 | Text | Parley and Pango each run the corpus (below); the one we keep passes every case, with measuring and painting sharing one layout object |
| 2 | IME | our field completes the matrix (below) with fcitx5, as a text-input-v3 client |
| 3 | Orca | the form (below) is completed with keyboard and Orca only, for both a11y backends; the one we keep passes it all |
| 4 | Glass | the window's panes are painted by Hyalo through `nidara-material-v1`, as the shell's are |
| 5 | Animation | two layers animated by Hyalo while the client commits nothing for 500 ms; a click during the motion reaches the layer where it is SEEN |

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
- `trait TextBackend` with two implementations behind features, `parley` and `pango` (Pango
  used without any GTK widget, as Hyalo's title bar already does). Both fed the same
  `TextStyle` (family, size, weight, line height, alignment, direction) and the same font set.
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
  line breaking at several widths; caret and backspace through each. Run against both
  backends; the report names which case each one fails.

## nk-a11y

- A **semantic tree** owned by the window: `Node { id, role, name, description, states,
  actions, bounds, text: Option<TextInfo> }`. `id` is stable for the node's life and never
  reused within the window. `bounds` are window coordinates of the MODEL (the final values,
  not an animation's intermediate ones — as on the reference platform).
- `TextInfo` gives what AT-SPI Text and EditableText need: the text, caret, selection, and
  the boundaries (char/word/line) — taken from `nk-text`'s `Editor`, converted to character
  offsets here.
- Events, not just a snapshot: focus, name/state changes, text inserted/removed, caret moved,
  selection changed.
- **Two backends behind features**, `accesskit` (accesskit_unix) and `atspi` (direct, over
  zbus), implementing one `trait A11yBackend`. Test 3 decides which stays.
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
- `nidara-material-v1`: the panes' shapes, sent with the buffer they describe (as `material.ts`).
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
- `done(serial)` event when a transition ends, with the presentation time; `cancelled(serial)`
  when a new value replaced it.
- A layer's surface may have a `nidara_material_v1`: its glass moves with it.
- **Limits:** at most 64 layers per window (protocol error past that). Not offered to
  sandboxed clients, as the material (#818 triage, point 6 — opening it to Flatpak apps is the
  later review of the trust boundary).
- **Out of phase 0, said so:** resize while the client is busy — Hyalo keeps showing the last
  buffer at its size, it does NOT stretch it; reflow follows when the client commits. Ink
  under animation (a client that cannot repaint cannot change its text colour): phase 2, with
  the shell.

**Test 5, exactly:** the window has layers A (a button) and B (a plain pane). The client sets a
1 s spring transition on both positions, commits the new positions, then blocks for 500 ms
committing nothing. Driven headless (`HYALO_CONTROL`): screenshots at +100, +250 and +400 ms
show A and B at three different positions each; a click at A's presented position at +300 ms
is received by A (the client reads it when it wakes) with coordinates inside A. The control
step: a Hyalo built to hit-test at the MODEL position must fail it.

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
cancelled with Escape, committed; surrounding text right after moving the caret; backspace
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
| `nk-text` + corpus, both backends | GPT Sol (after #819) | only this contract |
| `nk-a11y`, both backends | Claude, or Sol once `nk-text` lands | `nk-text`'s `Editor` API (above) |
| `nk-wayland`, `nk-render`, `phase0/` | Claude | the others' APIs as written here |
| Hyalo's server half of the layers protocol | Claude | the XML |

Different crates, different branches; the only shared file is this one, and it changes first.

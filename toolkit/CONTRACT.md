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
    nk-widgets/              retained structural widgets, derived semantics (phase 1)
    nk-icons/                interface icons by name, as vector shapes      (pure, no Wayland)
  phase0/                    the test window (a binary, nk-phase0), and its checks
  widgets-demo/              the fixed-data structural-widget demo (phase 1)
  settings/                  the native Settings (phase 1, #915): nk-settings
protocols/
  nidara-layers-v1.xml       NEW, the layers protocol (below) — both ends, like the others
hyalo/compositor/src/protocols/layers.rs   its server half
```

- **Dependencies point one way:** `phase0 → nk-wayland, nk-render, nk-a11y, nk-text`;
  `nk-render → nk-text` (it paints glyph runs); phase 1 adds
  `nk-widgets → nk-text, nk-render, nk-a11y, nk-wayland` and `widgets-demo → nk-widgets`
  (the demo also uses the transport/provider/text public APIs), and `settings → nk-widgets`
  and the rest (its data layer depends on nothing of ours: `zbus` and `serde_json` only). `nk-text` and `nk-a11y` never
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
- `ParleyBackend::new` keeps the isolated required-font corpus. With the opt-in
  `nk-text/system-fonts` feature, `ParleyBackend::with_system_fonts` uses Fontique's
  system collection (`system_fonts: true`) alongside the supplied fallback files.
  This is the reusable Settings/chooser shaping path, not catalogue enumeration.
  Fontique resolves and loads faces used by a layout. Exported system font bytes
  are copied once per blob per retained layout into `Arc<[u8]>`, shared by its
  runs and reflows, and released with that layout; there is no process-wide cache
  of every previewed font. Collection indices and normalized variation axes come
  from the actual shaped run. Layouts and glyphs remain valid after backend drop.
  Linux enables Fontconfig through dlopen, as the measured Settings slice does.
  This API does not validate a Config1 font description or implement chooser UI.
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
- A **range control** (`Slider`, `SpinButton`) carries `value: Option<ValueInfo>` — min, max,
  current, step (0 = continuous) and the text a reader says ("4500 K"); a tree whose value lies
  outside its range is refused. The provider serves AT-SPI `Value` from it, read-only on its
  side: a `CurrentValue` set from outside is a `Request::SetValue` to the app (offered only with
  `Action::SetValue`), which clamps and steps it as its keys do and publishes the result. A
  change of current value or text sends `property-change:accessible-value`. A `RadioButton` is
  one choice of a group: the group is a `Panel` holding them, and the choice is `checked` (#882).
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

### Dropdown retained model (#882/#915)

`Tree::dropdown` creates one labelled row and one ComboBox with stable option
children. The selected option is reported through AT-SPI Selection even while
collapsed. Selection activation is intentionally allowed while collapsed,
independent of expanded state; it changes the value without opening a popup.
These model-only children have no painted or hit-test area and are
not Tab stops; activating one through Selection changes the combo's value and
emits `Effect::Changed(combo)`. Activating the combo itself asks the app to open
its popup and does not change selection. Expanded state is explicit; cancellation
can close it without changing the chosen option. Invalid option/index arguments
are rejected before creating or changing nodes. A hidden/disabled/stale target
cannot choose an option. Programmatic selection updates emit no application
write. This model is a prerequisite, not acceptance of the popup list or builder;
its popup list remains pending. `DropdownStyle` supplies the closed trigger's
geometry/colours/type/arrow exclusively from `components.json.dropdown.trigger`
(`toolkit/tokens/dropdown.json`); `nk-settings::Styles::apply` sets it. It follows
the current kit's dropdown trigger, not Button's geometry. Missing style is an
error. Its border reserves space at rest, keyboard focus uses that same border,
and the arrow uses the shared icon theme with externally supplied ink.

### Dropdown menu list (#882/#915)

`Tree::menu_list` constructs a standalone retained popup list, one Scroll of
MenuOption nodes. Each is an AT-SPI Option; `selected` means the currently chosen
value, independent of pointer hover and keyboard focus. Up/Down/Home/End move
focus and reveal it; activation emits Activated(option), leaving selection to the
parent's controlled model. Escape/PopupDone are host cancellation, never edits.
The list owns no Wayland connection: the existing standard popup host runs it.
Keyboard menu navigation retires pointer hover before moving/revealing focus, so
a stationary pointer cannot leave a second accent highlight or stale scrolled row.
The standalone menu is currently a Tree mode selected by menu_style; generic
layout/measure/content_viewport/paint branches must preserve that boundary. Extract
this mode boundary when integrating the builder; it is not an embedded general list.

`MenuStyle` comes from `components.json.dropdown.menu`, mapping the kit's actual
popup CSS/check factory once. The viewport reaches the card's inner edge; row
insets belong on the rows. Background is opaque without material, while a
material-backed host paints the same content/border over the shared glass.
The check reserves a trailing slot for every option and follows chosen state,
not hover. It uses the existing check.ts path and exported stroke/size in row ink.
This retained list alone does not establish a complete native Dropdown/builder
or real Orca speech acceptance; that requires the host and accessibility bridge.

### Versioned AT-SPI publication (#915)

`atspi_backend::Backend::new_versioned(tree, revision, callback)` and
`update_versioned(revision, tree)` associate an application publication token with
the shared semantic snapshot. `VersionedCallback` receives `(revision, Request)`:
node/action/availability validation and revision capture occur under the SAME
snapshot lock. Selection.SelectChild checks the container and the chosen option
(action/availability) under that same lock; it does not require the combo's separate
open action, which may be suspended while the menu is modal. A callback delayed across a new publication retains the revision
of the snapshot that authorized it. The app queues requests and revalidates that
revision and the live target; provider threads never mutate widgets. Tokens are
application-owned and must distinguish modal openings/subtree lifetimes. Legacy
`Backend::new` and A11yBackend::update remain compatible, with unversioned callback.

A worker must use this snapshot-bound token, not an independently updated Atomic
counter before/after backend.update: either order can label an old-snapshot action
with a new revision. Backend update failure is fatal to the worker, not a success
acknowledgement. `nk_a11y::bridge::Bridge` owns that worker/provider, exposes queued
`(revision, Request)` to the application, and reports successful publication tokens
on `published`; failures surface through `check`. Widgets-demo reuses this worker.
This seam does not itself prove real Orca speech or modal hosting.

### Dropdown modal semantics (#882/#915)

`DropdownPopup::new` borrows the parent Tree until dismissal and constructs its
MenuList from that combo's retained options. Its `menu`/`menu_mut` serve the popup
host; their private node IDs are never published. `snapshot(origin)` keeps the
parent semantic root, ComboBox, LabelledBy and Selection option IDs, projecting
the menu's focus/bounds/actions onto those existing options. The origin must be
the compositor-configured popup origin in parent window coordinates, not the
requested anchor. Other parent actions are suspended while modal. Chosen state
continues to come from the parent's model, never the menu's hover/focus. Initial
focus uses the chosen option if available, otherwise the first available option, or none when
all are unavailable; the chosen check is preserved.

The exclusive parent Tree borrow is an intentional boundary of this short-menu
adapter: the controller cannot repaint, reconfigure, restyle or scale the parent
while it lives. A controller requiring concurrent parent servicing must revise
this ownership contract before using this API; this cut does not solve that debt.

Each snapshot returns a process-unique publication revision. `request` requires
that revision and the menu generation captured by that publication; IDs from a
previous opening/publication cannot act on a new menu. A host bridge must tag
requests with the revision of its published snapshot and route them through this
adapter, never dispatch popup-local IDs to the parent. `finish(Some(index))`
commits through the parent's guarded option activation; cancellation and Drop
only collapse and restore focus if still available. Invalid origins, removed
menu options and unsupported/stale requests fail before selection changes.
This adapter is CPU-tested groundwork; it does not itself publish a provider,
run a popup, or establish real AT-SPI/Orca acceptance.

### Manifest Dropdown builder (#915)

`dropdown_builder::register` registers the real per-item `dropdown` builder. It
reads schema `ui.options` value/label pairs and the session's shown string, creates
one retained ComboBox row, and labels unknown current enum values with themselves
as an additional option. Notices reconcile labels/options while keeping the combo
and surviving option IDs; `Tree::reorder_dropdown_options` accepts only an exact
permutation of its current children (validated atomically) and invalidates stale
actions when order changes. Reading/canonical updates never Apply.

Changed(combo), including Selection activation, applies its mapped schema value
exactly through Cx.apply, then displays Session::shown. Activated(combo) opens the
shared modal controller through Cx.open_dropdown and applies only Changed results.
Missing native context is an explicit opening error. Hidden, unavailable, readonly,
unmounted or wrong-mount operations do not write. Failed writes show the existing
service error/subtitle path and canonical/session value. Within a notice batch the
renderer delivers Failed after Changed/availability notices, so the same failed
reply cannot immediately erase its error with its accompanying Changed notice. Renderer row
visibility follows key availability; builder rows are sensitive only when every
edited key is writable. No async worker/timer survives this synchronous builder.

### SearchInput (#915)

A retained `Kind::SearchInput` owns one nk-text::Editor, with a single-line committed
buffer, selection/caret, undo and preedit. It is created by Tree::search_input with
a supplied text backend and shared SearchStyle; absent style is an error. Visual
metrics come from Settings' .settings-search and its custom box in Settings.tsx
(surface-back, border, pill, padding12/min-height32, icon15/gap8), exported once.
Its accessible name is separate from editable text; placeholder is description,
never the value. Semantics are TextInput/TextInfo with UTF-8 indices and geometry
from the same retained layout used to paint, excluding preedit geometry.

Reads and set_search_text canonical updates do not emit Changed. User edits,
paste/IME commits and authorized AT-SPI SetText return Changed exactly when the
committed text changes. Selection-only operations invalidate semantics/paint but
never trigger a search. Single-line text rejects control characters atomically.
All requests validate target generation, visibility and enabled state. Tab leaves
the input; Space types, Enter activates, Escape cancels preedit then clears text.
Font/scale reflow preserves editing history, text and selection through
nk-text::Editor::set_style; shaping failure leaves old style/layout intact.
SearchInput uses absolute left alignment for its single-line scrolling canvas
(`Alignment::Left` in nk-text), while text direction remains Auto/RTL as supplied;
paragraph direction still controls shaping/caret movement. This prevents an unbounded
RTL layout from aligning to the far end of its measurement constraint. Existing
Start/End semantics remain logical alignment for other text. SearchInput itself
owns no provider, timer, Config1 operation or search results.
Composition::event_with_window routes Ctrl+C/X/V through nk-wayland, retaining a
paste target until delivery and dropping it after focus/generation invalidation.
Composition::sync_search_input (also called by sync) follows layout; it publishes
committed surrounding text and the painted caret, with the existing layer-local
cursor association for a sidebar input. It resets context when the focused input
changes (including equal-text fields), and disables IME when the last input goes.
IME echo uses the host's existing cause tracking. Model tests of these paths do
not establish real native clipboard/fcitx/AT-SPI or Orca acceptance.

### Lazy font catalogue (#915, PHASE1 A4)

`font_catalog::Catalogue` groups Fontconfig's installed primary family/style names
with their exact file and face index (including named-instance bits), without
opening font files or substituting an unknown family. An empty style name from
Fontconfig is retained as unnamed (some variable faces have no named style); no
Regular label/style is invented. Duplicate file/index/name
records collapse; names remain Unicode, with deterministic family/style ordering.
Malformed records, failed fontconfig execution and an empty catalogue are errors,
never a successful partial catalogue. This is metadata, not a font rendering backend.

`font_catalog::Load::start(Operation { mount, request })` is called only when a
chooser opens, never while building the Settings page or its first frame. One
process-wide worker serializes enumeration, with one queued operation maximum;
a full queue reports busy rather than spawning more workers. `poll(current)` is
nonblocking and returns one result only for the same mount/request token. Cancel,
Drop or a token mismatch retires the receiver; queued canceled jobs are skipped,
and a running obsolete result cannot reach the UI. Worker work has no tree,
Window, provider or Config1 access and performs no Apply. The chooser must still
validate its current live/visible/available launcher before applying a selection.
The modal family LIST/search ENTRY, preview, size/style selection and font builders
remain separate consumers; catalogue tests are not FontChooser acceptance.

### Renderer modal context (#915)

`render::Host.modal` optionally lends a `render::Modal` implementation in effect/idle;
Cx::open_dropdown requires that context and a parent Window, and delegates to the
shared controller. Build/notice/shown/unmount receive no modal context. The default
absence is an explicit error when opening, not a fallback control/provider.
`Editor::poll` drains actual Client notices (empty by default in pure test editors).
`dropdown::Native` supplies the production Modal: it lends Bridge/text/material/
revision/physical serial/poll interval and stages polled notices in its application-owned
Vec. Any staged/new notice cancels the modal operation before input/selection;
the application delivers the staged notices to Rendered after return, without
polling them a second time. Its external keep_open hook stages portal/routing/
visibility invalidation too. It never applies a setting itself. A synchronous
modal borrow cannot survive page unmount; builders still check mount/visibility
and use operation tokens for any independently asynchronous work.

### Settings Dropdown controller (#915)

`nk_settings::dropdown::show(Host, combo)` runs the reusable MenuList in the
standard popup host. Host lends parent Tree/Window, text backend, Styles, the
application's existing Bridge and mutable parent revision slot, optional panel recipe,
physical opening serial,
poll interval and a `keep_open` callback. It never creates another provider.
Popup snapshots use the acknowledged configured origin; requests route through
DropdownPopup's revision guard. `PopupSnapshot::new(tree)` allocates tokens for
ordinary/restored parent publications from the same namespace as modal snapshots;
the application uses this namespace consistently when sharing that Bridge.
Before returning, the controller updates the host revision slot to the restored
parent publication, so subsequent parent requests can pass its own revision guard.

`keep_open` polls/stages Config1/appearance/navigation/visibility notices without
mutating the borrowed Tree. False cancels before handling input and immediately
before accepting selection, so the caller can apply staged notices after return.
Errors cancel and propagate. External invalidation calls `DropdownPopup::invalidate`,
which rejects further snapshots/actions/selection and suppresses trigger focus
restoration (clearing its retained focus if necessary) until staged changes apply.
Cancellation/PopupDone do not choose; ordinary dismissal restores parent focus
and collapsed semantics are republished even on a child error. Only the controlled
model changes here; Config1 writes remain the builder's responsibility. The
optional panel recipe is resolved for the actual configured size; absent recipe
forces opaque D5 paint even if the compositor advertises material. A supplied
recipe uses the exported menu radius. Native provider/Orca and lifecycle acceptance
require dedicated evidence, not compilation of this controller.

The separate `dropdown-provider-probe` diagnostic composes this controller with
one real Bridge and the standard nk-wayland host, using opaque fallback. Its
private-bus wrapper reuses widgets-demo/check-headless.sh; all evidence/runtime
must stay under target or the owner's task directory. The checker observes
completed input, a new parent commit and provider publication before asserting
selection/focus/stable IDs. Fault controls must reach their own value assertion;
a setup timeout or crash is a failure, never a caught control. Compilation and
syntax checks do not establish native controller/provider acceptance, Config1
integration or real Orca speech. Historical fixed-binary evidence remains tied
to its original source and hashes.

### Standard popup host (#882/#915)

`Window::popup_geometry()` returns None for a toplevel or before a popup's
first acknowledged xdg_surface.configure. Afterwards it returns the latest
compositor-configured `[x, y, width, height]` in parent window-geometry logical
coordinates, including signed origins after flips/slides. Pending xdg_popup
geometry becomes visible together with size at the following xdg_surface
configure acknowledgement; a reposition request/token alone does not change it.
Use this origin for modal semantics; requested anchors are not actual placement.

`nk-wayland::run_popup(app, parent, placement, grab_serial)` is a nested host on
its parent's connection, with a standard `xdg_popup` role, never a D7 layer or a
new toplevel. `PopupPlacement` supplies a positive size and positive anchor
rectangle in parent window-geometry coordinates; the menu opens below its left
edge with compositor flip/slide constraints. Optional `grab_serial` is the serial
of the initiating physical pointer/key event, never a later configure or an
invented serial. `Key::serial` is Some only for a physical key press; repeats have
None. Accessibility activation may open without an explicit input grab.

The host acknowledges xdg_surface.configure before painting the compositor's
configured dimensions. `PopupDone` closes the nested host; destroying the popup
also dismisses it. `Window::reposition_popup` uses a new placement and caller token
on xdg-shell v3+, and returns an error on older versions (no fake reposition).
`PopupRepositioned(token)` carries the compositor acknowledgement. Destruction
happens before the parent's event queue resumes; after ordinary close queued modal key events are not
replayed into the parent. The caller restores focus only to a live visible node.
While this nested loop is open, the parent does not repaint or service its
configure, scale or appearance changes. Keep it bounded to short menus; a
long-running child needs parent servicing that this primitive does not provide.

This primitive alone is not a Dropdown, keyboard/Orca gate or native acceptance.

## nk-widgets (phase 1, #873)

Dependencies point one way: `nk-widgets → nk-text, nk-render, nk-a11y, nk-wayland`.
Applications use `nk-wayland::Application`; no widget or demo owns a Wayland connection.
Phase 0 remains an independent client of those four crates.

- A retained, window-owned tree allocates monotonically increasing ids, never reused.
  Targets pair an id with the tree generation; stale, hidden and disabled actions fail.
  Semantics, label relations, painting and hit-testing all derive from this tree.
- Layout measures under constraints, retaining the `nk-text::Layout` it paints, then places.
  Layout, paint and semantics invalidations are distinct. Font/text scale changes remeasure
  while keeping ids, focus and scroll offsets. There is one focus and one pointer capture;
  Tab order follows tree order, and release belongs to the node that was pressed.
- Window, sidebar/page list, title bar, scroll region, group/header/row, switch and button
  are the phase-1 foundations. Hidden subtrees leave semantics; offscreen subtrees remain
  VISIBLE, with SHOWING determined by intersection with the unoccluded viewport. Focus
  scrolls into that viewport. Groups and controls have explicit label relations.
- D7: the root content buffer spans the whole window. Sidebar and title bar have independent
  synchronized layers above it; layout reserves leading/top insets. Content can scroll under
  both. The title bar has no divider. Collapse releases the leading inset on the pane's
  curve; content is measured/placed again at each sample, with the title pane following
  that inset. `Metrics.content` is the fixed WINDOW_LAYOUT content width: the breakpoint
  is sidebar + content, never a page's natural size. Below it, the title's sidebar button
  opens an overlay with zero inset; a page choice, Escape or outside click dismisses it.
  At/above the breakpoint, it docks again. The title bar
  exposes its sidebar action with `Tree::sidebar_button`; other buttons stay app actions.
  Pane materials are resolved separately at their actual shorter side on resize,
  from the portal-selected glass export variant and its size steps.
  Missing material OR layers uses D5: opaque panes and content clipped to the insets.
  Missing material also paints an opaque root base; otherwise D6 still owns that background.
  The application supplies exported colours/measurements and the menus' panel Material.
  `Tree::set_sidebar_frame` supplies the floating margin/radius. The title uses
  `TitlebarStyle` and `nk-wayland::set_layer_blur` with explicit `Blur`/`GradedPane`
  bands, no glass tone/rim. The app supplies its background fade; reduced transparency
  makes it opaque and unblurred. The provisional recipe remains the owner's D7 choice.
  `Tree::window_controls` supplies retained client buttons; a server layout replaces
  them and reserves its actual side/size. The app opts in before configure with
  `Application::window_controls`, places the root-local box, and sends fallback
  actions through `Window::window_action` from the same activation path.
  D8: `highlight_shape` is shared by selection, hover and keyboard-only focus.
  Lists take inset/opacity, focus width and separator thickness/colour from
  `toolkit/tokens/list.json` via `components.json`'s mode variant `list` object. Readers
  select the portal variant and reject absent fields rather than guessing defaults.
  Common geometry and named content widths live in components.json too; glass.json
  remains material-only. Group + rows is the shared reusable options component.
  `Tree::set_page_width` names Form/None; Reading requires measured tokens first.
  Form aliases WINDOW_LAYOUT.content/contentFloor and centres in the sampled
  content viewport beside the sidebar, preserving horizontal access below its floor.
  Content scrolling dirties root content, not the pane buffers. The sidebar has its own
  clamped vertical offset and reveals focused pages below its fixed header. Vertical
  layer scroll routes to sidebar/content for sidebar/title respectively; horizontal
  layer scroll routes to content through nk-wayland::LayerEvent::HorizontalScroll.
  The no-layers fallback uses one
  sampled client timeline for paint/hit-testing/focus, with AT-SPI bounds at model values;
  reduced motion omits the transition. Hyalo's layer glass is separate work.
- **Radio groups (#882)**: `Tree::choices(group, label, ChoiceKind, options, selected)` makes a
  row whose control is a `Choices` holding one `Choice` per option, one always chosen. The
  segmented choice (also the preset choice) and the swatch choice are ONE component with two
  looks (`ChoiceKind`); the look's numbers and colours come from `toolkit/tokens/choices.json`
  through `components.json`'s `choices` (taken from the current Settings, provisional until the
  owner's review), handed over as `ChoiceStyle` — measuring a group without it is an error.
  Keyboard as a radio group: ONE Tab stop per group, its chosen option; the arrows, Home and End
  move the focus AND the choice, wrapping and passing over disabled options
  (`Tree::control_key`, called by `Composition::event` before Tab/activation). A click or
  Space/Enter chooses; `set_choice` updates from the model without activating. AT-SPI: the group
  is a `Panel` named and labelled by its row, each option a `RadioButton` with its own name and
  `checked`. The keyboard ring of a choice goes OUTSIDE its shape (the kit's
  `nidara-focus-ring` offset): on the chosen segment, the accent, an inner ring would not show.
  `scripts/ci/nk-choices-check.py` drives the demo's `--choices` mode through libatspi with a
  control per assertion (two chosen, an unnamed swatch, a swatch that is not a radio, arrows
  ignored).
- **Range controls (#882)**: `Tree::slider(group, label, ValueRange, value)` and
  `Tree::fields(group, label, [(name, ValueRange, value)])` (the time fields: one spin button
  per part, each named, "From hour"). A `ValueRange` is min, max, step, whether it wraps (a
  clock's hours do, a slider never), zero padding, decimals and unit; its text is what the
  control shows and a reader says ("4500 K", "07"). Every source of a value goes through ONE
  clamp-and-step (`set_value`): the model, the keys, the pointer, and AT-SPI's
  `Value.CurrentValue` (`request_value`, generation-checked, like a click). A changed value is
  `Effect::Changed(id)`. Keys (`control_key`): a slider takes ←/→ and ↑/↓ one step, Page Up/Down
  `pageSteps`, Home/End its ends; a spin button only ↑/↓, Page and Home/End — ←/→ stay the field
  caret's. Pointer: a press puts the slider's thumb under it and a captured drag follows; a click
  on a spin button's − / + steps it. A value's room is measured from its widest text (min or
  max), so a change never moves the row. Look from `toolkit/tokens/range.json` (the kit's
  `slider.ts` + `NidaraSliderRow`, `spinbutton.time-spin`) through `components.json`'s `range`,
  as `RangeStyle`; none compiled in. AT-SPI: `Slider` named by its row, `Panel` of
  `SpinButton`s labelled by its row, each with `ValueInfo` and `Action::SetValue` (not
  Activate). `nk-choices-check.py` asserts them with a control each: the spoken text dropped,
  a Value that stays at the old number after a key, a `SetValue` ignored, an unnamed spin.
  `nk-choices-orca-check.py` is their real Orca walk (the A7 "real Orca rows"): focus on the
  chosen segment and → to the next, the slider and →, the hour and ↑, each asserted on Orca's
  SPEECH OUTPUT, each with a fault that must silence its step.
- **Icons (#915)**: `nk-icons` is the shell's `Icons.ts` lookup for the toolkit — the
  interface icon theme only if installed and declaring `X-Nidara-Icon-Spec`, the file GTK would
  take for the size, the reference theme for a name the theme lacks or draws nothing for — and
  hands back vector shapes, not pixels. `nk-render`'s `Canvas::icon` paints them in one ink as
  ONE layer at the ink's alpha (a symbolic icon's crossing strokes are not laid twice). A tree
  draws its icons from `Tree::set_icon_theme(Icons)`; an icon drawn without it is an error. The
  slider's flanking icons: `Tree::set_slider_icons(slider, [lesser, greater])`, sized, faded
  and spaced by `RangeStyle` (`range.json` `iconSize`/`iconOpacity`/`iconGap`, the kit's
  `NidaraSliderRow`). Dependencies: `nk-render → nk-icons`, `nk-widgets → nk-icons`.
- **Row texts and the disclosure (#915)**: `Tree::set_subtitle(row, text)` — a second line
  under the row's label, the two centred as one block; AT-SPI: the description of the row and
  of its control. `Tree::set_footer(group, text)` — under the group's card, which stops
  `footer_gap` above it; hidden like any node, which is how `footerWhen` is followed.
  `Tree::disclosure(group, label, expanded)` — a focusable row, activated anywhere on it (its
  state already flipped, `Effect::Activated`), a chevron at its trailing edge; the application
  shows and hides what follows it; AT-SPI: an expandable `ToggleButton` (`States::expandable`,
  new in nk-a11y). Look: `RowTextStyle` (`toolkit/tokens/rows.json` → `components.json`
  `rows`: the kit's `.nidara-row-subtitle`, `.nidara-list-footer`, the Settings' "Advanced" row).
- **Switch look (#915)**: `Tree::set_switch_style(SwitchStyle)` — border and its checked
  colour, track, checked fill, thumb, the thumb's margin, the disabled opacity — from
  `toolkit/tokens/switch.json` through `components.json`'s `switch` (the kit's
  `.nidara-switch`). Its size stays `Metrics::switch_width` × `Metrics::control`, which come
  from the same entry. A switch painted without it is an error. Not carried yet: the kit's
  shadows (nk-render has none) and its colour transition.
- `nk-a11y` projects panel/list/scroll-pane/toggle-button roles, label relations and separate
  hidden/offscreen state. Its existing phase-0 roles and hidden-state semantics remain valid.
- `widgets-demo` and `scripts/ci/nk-widgets-check.py` exercise the tree through the public
  AT-SPI provider and Hyalo's layer listing; faults belong only to the demo. Each oracle
  requires a logged applied mutation and a failed assertion (never a crash or timeout).

## Floating control capsule — proposal for #889

Geometry exports carry independent `height`, `button`, `edge` and `gap` values.
`edge` is the outer inset; `gap` separates neighboring buttons. Pitch is
`button + gap`, width is `2 * edge + n * button + (n - 1) * gap` for n buttons.
The server layout mirror must match the default component export. This schema
change preserves current values/pixels; owner visual tuning remains separate.


**The compositor side is implemented; the kit's capsule is not yet.** This section
closes the kit/compositor boundary, following #818. The owner has chosen the
behaviour in #889; numeric visual values remain for the native demo. Hyalo's side —
the four requests, the token export and Hyalo's own window controls on them, with
their checks — is in place (the skill's hyalo.md, "A control answers its backdrop").

- **One retained component in nk-widgets**, containing ordered existing button
  nodes: window controls, sidebar/navigation controls and arbitrary toolbar actions.
  Each button has a stable id, accessible name, enabled state, action and optional
  destructive style. The capsule is a labelled PANEL, its children PUSH_BUTTONs;
  its own glass is not a separate accessibility node. Keyboard focus, activation,
  stale-target refusal and pointer capture use the same Tree paths as other buttons.
  Enter/Space and AT-SPI Activate execute the same action as release on the captured
  button; leaving it before release cancels. Disabled buttons cannot hover/press or
  activate, and hiding/removing a captured button cancels capture.
- **One pane over content**, positioned by the app in its header or over its page.
  The capsule's layer owns the material and content; individual buttons are not
  Wayland surfaces. The existing nk-wayland host and synchronized parent transaction
  remain the only transport. Material state, glyph content, placement and input
  bounds land together. A capsule inside a glass sidebar/title does not declare
  another glass pane on that glass. D7's provisional graded blur/background fade
  is not a glass pane; whether a capsule over it looks right remains for the owner
  to judge in the native demo.
- **One material definition for native and server-side controls.** What a control does — its
  base and the owner's exceptions — is defined once, in the skill's design-system.md, "The glass
  material"; this contract only carries it. Extend the existing
  control piece of the token source/export with the state tints and backdrop-response
  law; Hyalo's third-party window controls consume the same definition. No duplicated
  numeric defaults in nk-widgets or render/controls.rs. The kit resolves the exact
  dark/reduce-transparency variant and size step from the installed export. Transport
  carries explicit data and no design defaults.
- **Protocol stays v1 until publication.** Append requests without `since=` and
  preserve existing opcodes/events. Kit and Hyalo are installed together. Another
  compositor with no material global uses D5; an older Hyalo advertising v1 may
  reject a new opcode with a protocol error, accepted until publication. There is
  no per-request negotiation in this contract. If mixed versions must be supported
  later, the owner decides a separate feature global then. Existing material trust
  restrictions remain; no new pixel readback is exposed to clients.

### Material requests for the capsule

All requests below are appended to nidara-material-v1, staged until the surface's
commit and reset by `clear_shapes`. Surface coordinates/distances are logical;
RGBA and response parameters are fixed-point, durations are unsigned milliseconds.
The synchronized capsule layer commits atomically with its parent.

- **`set_response(luma_low, luma_high, contrast_low, contrast_high,
  shadow_white, shadow_text, settle_ms)`** applies to shapes added after it, like
  `set_tone`. Measure on the same backdrop capture and at the same presented
  transform as the glass, before its own tone, tint or shadow. From the existing
  12×12 sample grid over each shape's bounds take mean WCAG luminance `L` and
  standard deviation `sigma`. Contrast is measured on the soft blur copy: the
  full blur would erase the difference between a white page and text over white.
  Compute `r = smoothstep(luma_low, luma_high, L)` and
  `c = smoothstep(contrast_low, contrast_high, sigma)`, easing both towards new
  values over `settle_ms` (0 = immediate, including reduced motion). Use the same
  sampled `r` in the same frame for every tone stage (`set_tone` mixed towards
  `set_ink_tone`) and for light-to-dark glyph ink. Multiply the existing size-law
  shadow opacity by `1 + shadow_white*r + shadow_text*c`. Scrolling text under a
  capsule must not make it pulse. Response shapes ignore `set_ink`'s binary switch;
  groups without a response retain `next_ink`. Measurements use asynchronous
  fences/pixel-pack buffers as the existing ink measurement does; presentation
  never waits for GPU readback or a client repaint. Do not sample the pane's own
  output into its response.
- **`add_state_region(id, x, y, w, h, corner_radius, r, g, b, a, fade_ms)`** declares
  a wash over the toned glass, within the rounded rectangle intersected with the
  shapes. The kit selects normal/destructive hover/press colours from the export;
  Hyalo owns no button state machine. A committed change of wash with the same
  button id eases from the previous wash over `fade_ms`, so hover-in/out requires
  one client commit each. State is redeclared after `clear_shapes`; the compositor
  retains the presented wash for matching ids across that committed replacement,
  without retaining regions absent from the new committed state. Reduced motion
  sends 0. Close's red has alpha below 1 and remains glass; the opaque disc in
  render/controls.rs is retired for these controls. The idle state is a zero-alpha
  wash, so hover-out can keep the same region id while withdrawing its tint.
- **`set_ink_colors(light_r, light_g, light_b, light_a,
  dark_r, dark_g, dark_b, dark_a)`** supplies the endpoints for the response's ink
  mix. **`add_ink_coverage(x, y, w, h, override_r, override_g, override_b,
  override_a)`** identifies non-overlapping rectangles in the capsule's one buffer.
  The client supplies premultiplied ARGB8888 coverage for glyphs/focus rings in any
  opaque colour; Hyalo draws each pixel as `ink.rgb · ink.a · buffer.alpha` at
  alpha `ink.a · buffer.alpha` — an opaque ink preserves the buffer alpha. Ink is light mixed towards dark by the response's `r`.
  When override alpha is greater than 0, Hyalo uses the override colour instead
  of the mix; the kit passes the exported destructive ink there. Coverage has the
  same response/material sample;
  coloured app content outside the rectangles is untouched. Non-finite values,
  width/height at most 0, or overlapping coverage rectangles produce protocol
  error `invalid_region`; rectangles are clipped to the surface. Coverage is
  double-buffered and cleared by `clear_shapes`. Rendering uses a custom texture
  shader on the surface element, without a client round trip or CPU recolouring.

Hyalo's server-side controls use these same response, state-region and ink-coverage
paths for their own glyphs. They do not keep an independent hover-disc renderer.

### Shared control token schema

The frozen TypeScript kit receives no new feature. The new source is
`toolkit/tokens/control.json`, merged by `scripts/export-tokens.mjs` into each
`tokens/glass.json` variant's `pieces.control[]` size steps. It supplies these
additional fields alongside the existing tone/inkTone/shadow data:

- `response`: `lumaLow`, `lumaHigh`, `contrastLow`, `contrastHigh`, `shadowWhite`,
  `shadowText`, `settleMs`;
- `states`: `fadeMs` (one unsigned millisecond duration shared by all state
  regions), plus `hover`, `press`, `destructiveHover`, `destructivePress`, each with
  `wash: {r,g,b,a}`; destructive states may also carry contrasting
  `ink: {r,g,b,a}` or null;
- `ink`: `light: {r,g,b,a}` and `dark: {r,g,b,a}`.

The kit copies `states.fadeMs` into each region's `fade_ms`, including hover-out
to idle; reduced motion sends 0. The server-side controls use the same value.
No separate duration constants live in the kit or Hyalo. Per-state durations are
out of scope unless the owner asks for different hover/press timing.
Values are provisional until the owner tunes them live. Both nk-widgets and
Hyalo's glass_tokens.rs read this one export. The export checker gains a
missing-field control alongside the existing glass-export controls. No values are
copied into the frozen TypeScript material or given hidden defaults in transport.

**D5 and accessibility preferences:** absent material uses opaque exported base and
  client-painted controls with the same geometry, keyboard and semantics. One client
  timeline drives paint/hit-testing/focus for any fallback motion. Reduce transparency
  uses the exported opaque variant, including its state feedback; reduce motion
  omits timed interpolation independently. Neither preference is written back.
  The opaque capsule's wash is sampled by CapsuleComposition with the exported
  duration and Hyalo's linear RGBA law, retargeting from the current sample.
  First appearance is immediate; reduced motion snaps an in-flight fade. The
  caller is responsible for frame opportunities while is_animating(); paint
  consumes the stored sample without changing input or semantic geometry. The
  current foundations demo still polls every 16 ms; this API alone does not
  establish event-driven scheduling or idle behavior. D5 samples client monotonic
  time since first sync, not presentation timestamps or the D7 compositor clock.

The diagnostic lab may paint retained opaque capsules into an existing root canvas
through `Tree::paint_capsules_fallback`; it uses the same painter as the ordinary
content path. `paint_capsules_fallback_where` accepts a per-capsule inclusion
predicate for a host with mixed root/layer ownership. The lab tests each capsule
against CapsuleComposition::layer, never inferring all panels from one panel.
This filter does not recover from a layer allocation error: sync still returns it. `CapsuleComposition::paint_count` counts successful client layer-buffer
paints only, incremented after `Window::paint_layer` succeeds; it is not a compositor
commit, damage, capture or presentation counter. A diagnostic count is not idle or
performance acceptance. The bounded lab can consume `is_animating()` for its own
poll interval; this does not integrate adaptive polling into the foundations demo.

Acceptance is developed in widgets-demo, with a fixed white page, black text over
white, a dark page and a continuous dark-to-white backdrop sweep under a stationary
capsule. Repeat native and server-side controls at scales 1 and 1.25. Assert shadow
strength ordering, continuous/coherent tone and ink, visible backdrop through both
normal and destructive hover/press, identical shared-token response, captured-release
cancellation, keyboard/AT-SPI actions and missing-capability fallbacks. Also move the
backdrop while the capsule client produces no commits: material and glyph response
must remain together. Each visual oracle gets its own logged fault disabling that
part of the response; a crash, timeout or absent frame cannot count as caught.
Captures must identify presented state rather than race wall-clock sleeps. Record
idle damage/CPU and scrolling frame intervals; do not add a permanent animation or
synchronous GPU readback. New expensive visual controls belong to the scoped/nightly
path under the CI budget. Final numerical values and visual acceptance are the owner's
in the native demo, with exact revisions and environment recorded.

**Implementation boundary:** after this contract is reviewed and merged, Claude
owns the Hyalo response/state/coverage implementation and token export, with its
checks/controls. Sol builds the retained capsule and native demo on that transport.
The wire and token schema above incorporate the Hyalo-side review; visual numbers
remain the owner's live decision. Visual acceptance is still the owner's, in the
native demo.

## The native Settings (`settings/`, #915)

`nk_settings::material::{panel,control}` owns the existing strict installed-export
readers: PanelMaterial, ControlRecipe and capsule_metrics. Settings and the
widgets demo consume these same readers; neither re-parses a material recipe.
The move preserves exact portal variants, short-side selection, validation,
null state-ink semantics and separation of glass/component geometry. Exports and
portal values are caller inputs; this module does not create a host or connect
to Config1. Public reader behavior is unchanged from the diagnostic consumer.


The app of phase 1 (`PHASE1.md`), split between Claude and Sol in #915. Its **data layer**
(Claude) is the one thing every row and builder reads; this is what it offers, fixed before
either half depends on it.

| Module | Offers |
|---|---|
| `session` | `Session`: `store()` (epoch, revision, each key's schema `entry`, `value`, `available`, `writable()`), `available()` (false while the service is gone or restarting), `shown(key)` (the value asked and not yet answered, else the value in force), `pending(key)`. Every [A3] rule — subscribe-then-snapshot, revisions by one, other epochs never applied, owner lost/back, one `Apply` in flight per key with the latest waiting — is in this module and tested without a bus |
| `client` | `Client` (one bus connection, also the one that will own `org.nidara.SettingsNative`): `apply(key, Value)` (`Err(Unavailable)` when not sent), `poll()`/`wait(deadline)` → `Vec<Notice>`, `session()`, `connection()` |
| `Notice` | `Ready` (a fresh store: redraw all, sensitive again), `Changed(keys)`, `Unavailable` (every control insensitive), `Failed { key, error }` (the row shows the value in force again and says why: `Invalid`, `Denied`, `Failed`, `NoReply` — never retried), `Error(text)` (no snapshot: said, never a default) |
| `portal` | `Portal::watch(connection)`, `read()` → `Appearance` (accent, dark, reduce transparency, window background, reduced motion, interface font and text scale), `changed()`. What the app paints with; `Config1` is for editing only |
| `exports` | `Exports::load(root)` (`NK_SETTINGS_DATA`, else `/usr/share/nidara/settings-data`; another `version` is an error), `pages`, `page(id)`, `text(i18n key)` (the shell's locale rule from `LANG`, English per key), `tokens(&Appearance)` → the colour set, the glass variant, the components variant — or an error, never the nearest |
| `routing` | D1 [A1] and D3: `Router::start(connection, Mode, legacy launcher, args)` takes `org.nidara.SettingsNative` (always) and, as `Mode::EntryPoint` after the takeover, `org.nidara.Settings` with the legacy `Request(as) → s` (`open`, `page`, `app`, `queryUI`); a second native Settings hands its request over (`AlreadyRunning`). `route()` decides: a page on `DRAWN` (`appearance`) is the window's (`Router::poll()` → `Incoming`, answered with `respond`), any other page and `app` go to `org.nidara.SettingsLegacy` — started by the launcher if it has no owner — and its answer is the answer |
| `manifest` | `Page`, `Group` (`footer`/`footerWhen`, a group-level `custom`), `Item::{Key, Custom, Decoration, Disclosure}` with `visible_when()`/`sensitive_when()`/`key()`; a page's `header` builder, `Predicate::holds(&Session)` (against what the controls show, compared as JavaScript's `String()`). An unknown field is an error, not skipped |

- **A builder edits through the client, never the bus.** It reads its keys from `session()`,
  sends with `client.apply`, and redraws on the `Notice`s that name them. Builders whose item
  has no `key` in the manifest know their own keys from PHASE1.md D1's table
  (`wallpaperPicker` → `wallpaper.current`, `interfaceFont` → `appearance.interfaceFont`, …).
- **The renderer** (`render`): `Rendered::build(Host, &Page, &mut Builders, content, mount)`
  draws a manifest page under the scroll region; then `notices(Host, &[Notice])` after every
  `poll`, `effect(Host, Effect) -> bool` for every tree effect (true: it was the page's),
  `idle(Host)` from the app's idle, `unmount(Host)` when the page goes. `Host` lends the tree,
  the `Editor` (the `Client`; a fake in tests), the exports, the styles and — in `effect`/`idle`
  only — the window. It owns: which rows exist (a key `available: false` has no row, as the
  legacy Settings; a key not in the snapshot, an unknown control or a name with no builder is
  an error), visible and sensitive (`visibleWhen`, a collapsed disclosure, `sensitiveWhen`, the
  service gone, a key not writable), what a row shows (`Session::shown`; a failed write shows
  the value in force and says why in the row's second line until the next answer), and the
  sliders' `commitOnRelease` and `debounce` (default 32 ms, as `NidaraSliderRow`).
- **The builder interface** (agreed with Sol in #915, #123–#128):
  `trait Builder { build(cx, group, &Item) -> Built; notice(cx, &Notice); effect(cx, Effect);
  idle(cx); shown(cx, visible); unmount(cx) }` (the last three default to nothing).
  `Built { rows, keys }`: the rows the renderer hides and disables, the keys whose notices reach
  it (`Changed`/`Failed` naming one, `Ready`/`Unavailable` always). `Cx` lends `tree`,
  `exports`, `styles`, `window` (effect/idle only, never kept), `session()`, `apply(key, v)` —
  the only way a builder edits —, `connection()` (portals only), `own(id)` (route this node's
  effects to me; for nodes created after `build` too), `remove(id)`, `mount()` (a token: an async
  result of another mount is dropped; a builder may add its own per-operation tokens), and
  `focus_if_shown(id)` (return focus only to a launcher still there, shown and enabled).
  `Builders::register(name, factory)`: a factory per name, a fresh builder per item; the names
  are the manifest's `custom`/`decoration` and `dropdown` (every row whose `ui.control` is
  `dropdown`). Claude's are in `builders` (`accentPicker`, `nightScheduleTimes`); Sol's in their
  own modules.
- `styles`: `Styles::new(&Exports, &Appearance)` → `Palette`, `Metrics`, `ChoiceStyle`,
  `RangeStyle`, `SwitchStyle`, the accents by name and the interface `TextStyle` (the portal's
  font at its text scale). The ONE mapping from the exports to `nk-widgets`' styles: the
  widgets demo uses it too (`widgets-demo → nk-settings`); its own panel and title bar recipe
  stay in the demo.

The Router exports its Request interface in both Native and EntryPoint modes;
only EntryPoint takes the legacy entry-point name. A second native process hands
its request to the existing native owner before takeover too. A failed handoff
returns its actual transport error, never a silent AlreadyRunning result.
In Native mode forwarded pages/apps go to ENTRY directly, without the legacy
launcher or takeover-name wait. D-Bus may activate that existing entry point;
activation/call failure is returned. EntryPoint mode forwards to LEGACY and retains
its launcher/wait policy. The native side never launches a second legacy entry.

### Settings window composition (Sol, #915)

`settings::material::{panel, control}` owns the exact exported panel/control readers,
including capsule geometry from components.json. The widgets demo reuses those readers;
the app does not copy their recipes or fall back to compiled material numbers.
`settings::window::Shell` builds the retained sidebar, title bar, content scroll region
and one capsule of window-control Buttons. Labels are supplied by the caller, already
translated. Sidebar activation reports a page id for the existing Router; it never draws
a non-allowlisted page itself. The app mounts Rendered under `Shell::content`.
The existing nk-widgets Composition/CapsuleComposition remain responsible for D7 layers,
D5 painting, input, focus and finite animation. Window control capsules do not opt in to
Hyalo's duplicate server controls. The app supplies exported metrics and provisional
owner-reviewed titlebar/transition policies explicitly; this seam invents no visual values.

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
- **A layer has its own glass** (PHASE1.md D7): a `nidara_material_v1` on the layer's surface is
  drawn right below that layer, at the transform it is shown at, and its backdrop is everything
  behind it — the window's own content included, read only inside the window (its edge repeats
  past it, never the desktop beside it). A layer fading in or out forms its glass, it does not
  fade it. A pane's blur may be graded from its top edge to its bottom edge
  (`nidara_material_v1.set_shape_grade`, the title bar's progressive blur).
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
| `settings/`: data layer, generic rows, `accentPicker`/`nightScheduleTimes`, D3 routing, start-up milestone | Claude (#915) | `Config1` (PHASE1.md D1), `nk-widgets` |
| `settings/`: dropdown rows, wallpaper and font builders, search, the window (D7) and #889 | GPT Sol (#915) | the data layer above, `nk-widgets` |

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

The native Settings window capsule uses components.json capsule.windowInset for both
corner axes, independently of generic row padding/gap. The owner #921 geometry is
72 by 24 at 12/12; generated-export window tests check both sides and D5/D7 layouts.

Settings positions its three window-control buttons from the current exported
CapsuleMetrics before one layout pass. Tree::capsule_metrics returns the current
metrics, including portal updates staged before layout; no cached measured bounds
or second layout is needed just to compute the capsule's horizontal placement.

The accessibility Bridge keeps one pending (revision, tree), replacing it when
the app outpaces the backend. The worker diffs the last published tree against
the latest pending snapshot; skipped revisions are not published acknowledgments.
An in-flight backend update completes, then the newest snapshot is consumed.
Requests remain bound to the actual published revision. The app never blocks
on a full notification channel, and superseded full trees are released promptly.
### Embedded single-selection list (#882/#915)

`Tree::list(parent, name, viewport_height, MenuStyle)` creates a retained `LIST`
inside a Group or Scroll, with `MenuOption` children and the same row measurement,
paint, check and keyboard logic used by dropdown menus. Each list owns its style;
it never enables popup layout for the containing window. The positive finite
viewport height is a caller constraint, not an intrinsic visual token;
`set_list_height` updates that constraint on resize without replacing IDs. Scroll,
focus reveal, clipping, hit testing and SHOWING use that viewport intersected with
ancestor clips. Offscreen options remain semantic children; hidden options leave
the semantic tree. `set_list_selected(list, Option<option>)` is canonical and emits
no user change; activation changes selection once and returns Changed(list).
Arrow/Home/End focus does not commit. Empty lists and no selection support filtering.
`set_list_style` preserves IDs/focus and clamps scroll after remeasurement. There
is no second text renderer, tree or provider. This primitive is not font-dialog
or Orca acceptance; modal lifecycle and family catalogue are application consumers.

### Retained modal dialog namespace (#882/#915)

`DialogTree` borrows the parent Tree and creates a separate retained view whose IDs
start at the parent's next unused ID. While borrowed, parent mutations are staged.
On Drop, all view IDs are retired into the parent allocator and parent generations
advance, including on error/cancel. A snapshot retains the original parent root and
IDs, suspends its actions/focus, and attaches a real modal DIALOG child containing
the view's SearchInput/List/etc. It uses PopupSnapshot's process publication tokens
and the application's ONE Bridge. Requests require the last publication and current
view generation and are confined to the dialog subtree. Invalidation rejects all
requests/publication and suppresses launcher focus restoration. Normal close/error
restores focus only to an alive, showing, available launcher. Dialog window bounds
are window-local; no screen-position or parent-relative geometry is invented.
The existing AT-SPI mapping of Role::Dialog exports MODAL. `run_dialog_with_options` uses the parent's
connection/app-id, caller title/size, and the same teardown/input-drain as run_dialog.

The Settings family/style/size picker consumer is `font_chooser::choose`: actual
modal native UI with SearchInput, lazy font_catalog, embedded LIST, Cancel/Select
and the shared system-font backend. Its result is Selection { family, points, attributes }, never
Apply. Point-size editing and a retained sample share the existing widgets/layout.
The style list and controlled Config1 builders reuse these primitives; this UI
is not full FontChooser parity or native/Orca acceptance. All labels,
window size and list-height constraint are supplied by the host, without defaults.

Modal Escape checks `Tree::search_composing(id)` before closing: composing text
gets the existing SearchInput cancellation path first. This reads the one Editor's
preedit state; it does not derive input policy from semantic geometry.

DialogTree clears parent widget focus on entry and does not publish dialog focus
until its actual host Focus(true); provider state diff then orders activation
before focus. Drop restores the launcher on ordinary cancellation/error.

`Window::set_title(&str)` updates an existing xdg toplevel title, rejects NUL and
non-toplevel roles. The family picker supplies its translated runtime title on
Configure before its first frame; Labels never requires leaked static strings.

### Font preview styling (#915)

TextStyle adds Slant (Normal/Italic/Oblique), width as a positive percentage, and
explicit OpenType AxisSetting values. Defaults preserve existing text. The shared
Parley builder passes these attributes/settings to Fontique/Parley; glyph exports
keep the actual selected face and normalized variation coordinates. validate(width)
is public so a retained consumer can validate before changing its own state.
Duplicate/nonprintable axis tags and nonfinite settings fail before shaping. This
does not promise an arbitrary file/named-instance identity from a family/style
request. Pango's description syntax remains the Config1 boundary, documented at
https://docs.gtk.org/Pango/type_func.FontDescription.from_string.html .

Tree::set_label_style(id, Option<TextStyle>) applies an explicit style only to a
Label, validating before mutation and invalidating the retained layout; None
restores the window style. The same measured Layout supplies paint and bounds.
FontChooser's family view consumes this for a translated sample in the selected
family, at the draft point size and current UI attributes. It does not prove a
particular named font instance or implement face/style selection.

The chooser consumer is extended from family-only choose_family to
`font_chooser::choose(host, launcher, initial: Selection)`: Selection carries a
family and unscaled point size, and the result is still a draft, never Apply.
Host supplies a strictly positive point ValueRange and portal text scale explicitly; no size limits
are invented in the widget. A SpinButton reuses existing range input/Value semantics.
An initial size not representable by the caller's range is rejected before opening.
The preview uses points * 96/72 * text_scale logical pixels and the one retained
Label layout. Choosing family/size does not yet choose an arbitrary face/style;
Exact face/named-instance selection and native end-to-end acceptance remain pending.

GlyphRun carries the actual Parley synthesis skew in degrees. nk-render applies it per glyph
around that glyph's baseline, leaving positions and advances from the shared Layout intact.
Synthetic emboldening is currently refused during export instead of silently painting a regular
face. A style request can resolve to a synthesized face; it does not promise a specific file.

### Config1 font descriptions and chooser styles (#915)

nk-settings::font_description interprets the supported Config1 Pango description
attributes (single family, weight/slant/stretch, positive point or px size, explicit
axis settings) in Rust, without another layout engine or startup enumeration.
Canonical output is a Pango-compatible point description, with an ambiguity comma
when the family ends in a style word/number. Absolute px sizes convert at 72/96,
independently of portal text scale. Unsupported variant/gravity/features/family lists
return an explicit error; they are never silently discarded or previewed as regular.
Styles::font_style and the real chooser share this interpretation. The chooser's
Selection includes attributes, and its embedded style LIST uses the catalogue's raw
style labels (translated unnamed label for an empty style), retaining initial axis
settings until an explicit family/style change. Canonical point precision follows Pango's
1/1024 unit; output preserves supported attributes, not the exact spelling of its
input. Unsupported named styles and high-index named-instance records cannot be
selected. Unsupported initial attributes are preserved without preview/acceptance
until an explicit supported choice, rather than being replaced on opening. A family/style request is not a promise of an exact file/index/named instance.
Config1 Apply still belongs to builders; choosing only returns a draft description.

System-font mode must preserve all installed faces of a required family. Registering
only the FontSet's regular file over an installed family can hide its bold/italic
faces. with_system_fonts therefore checks the declared families of each fallback file.
When all are installed it leaves those system families intact; when none are it
registers the private fallback. A collection mixing installed/private families is
refused, since registering its whole blob could shadow installed faces. Isolated
mode keeps its original file registration. This does not run the chooser fc-list.

### Controlled font builders and native modal context (#915)

font_builder::register installs interfaceFont/monoFont factories per manifest item.
They show Session.shown verbatim without normalizing/writing during build/notices, keep
stable launcher IDs, and call Cx.open_font only on explicit launcher activation.
The accepted Description is canonicalized and compared semantically with current
state; an actual change issues one Cx.apply after live/mount/visibility/writability
checks. Cancel/invalidation/same value never Apply; Failed-last notices keep the
reply error alongside canonical state. Unsupported current descriptions remain
visible and report an error on activation, without a guessed preview or write.

Modal::font lends the same tree, optional parent Window, Editor and a Request with
launcher/Operation/initial draft. Native hosting requires the real parent; optional
Window permits deterministic decision fixtures in headless builder/bus tests only.
dropdown::Native also hosts fonts through its existing Bridge/revision/staged notices.
Its optional font Configuration owns fonts, translated labels, caller constraints
and actual icon-theme preparation; absence is an explicit capability
error. No static translation leaks, second chooser/provider or font enumeration on
page build. Editor.poll stages notices and cancels before modal input/acceptance;
the app still drains notices and applies external changes after return.

Tree::set_button_description supplies explicit accessible text (current font plus
help/error) for a Button while the row's LabelledBy keeps the control's title.
It changes only semantics, validates Button/liveness and is cleared on removal.
No new visual tokens or button renderer are introduced.

The font request title comes from that manifest row's translated label, matching
the legacy font button; Configuration owns the remaining translated dialog labels.
Styles.text_scale retains the actual Appearance portal scale, so both the modal
and launcher preview use its value rather than inferring it from a font size.
Tree::set_button_text_style shares the Label override/layout machinery for a
Button's caption. Supported descriptions preview on the launcher; unsupported
profile strings remain literal captions in the ordinary UI style. Font discovery
and shaping stay in the shared system-font backend; no exact-face/fallback claim
is implied for an uninstalled current family.

A dynamic Button description must also be observable after focus has returned:
nk-a11y::diff emits Event::Description once when an existing node's description
changes; the same provider publishes PropertyChange/accessible-description. The
initial snapshot exposes the getter normally, and unchanged descriptions emit
nothing. This adds no provider or role/value interface and preserves activation
before focus ordering. Native Orca speech acceptance remains a separate gate.

Mounted font builders refresh caption styles from the current Styles during idle
only when portal text scale or line height changes. This never Apply, preserves
launcher IDs and does not invalidate repeatedly while appearance is unchanged.
The application's existing appearance-notice hook still cancels an open modal
before replacing Styles; main-loop native portal/routing acceptance is separate.

The font chooser uses Fontconfig for installed family/style metadata only, and
Fontique in Parley for rendering. Bad catalogue records (including bad UTF-8) are
skipped, counted and logged by line; failed enumeration/no usable family remains
an error. Before a native selected family reaches Apply, the same rendering
collection must resolve and load a valid face without fallback substitution.
Catalogue timing/count logs describe each lazy enumeration; there is no second
shaper or silent family fallback acceptance.

### Application page mount lifecycle (#915)

`Rendered::build` is transactional over the content's newly-created children.
A failing builder receives unmount, previously mounted builders are unmounted,
and every new content root is removed before returning the original error.
Existing content and unrelated chrome are preserved. Cleanup continues if an
unmount callback fails, reporting that failure alongside the build error.
`page::Mounted` owns one successful renderer and its content roots. Consuming
unmount calls every builder before removing its roots, even on cleanup error.
A failed replacement therefore leaves the old mount alive; the caller commits
sidebar selection only after a new mount succeeds and the old one is retired.
This lifecycle has no Window/provider/Config1 transport of its own and never Apply.


### Retained raster image (#882/#915)

nk-render::Raster validates a nonempty RGBA8 buffer and retains the decoded pixels
once. Canvas::image paints it with explicit Contain/Cover fitting and normal alpha
composition. It performs no file I/O or decoding. Tree::image owns one retained
IMAGE with a caller-supplied logical size and ImageStyle (fit, radius, border,
background); responsive measurement preserves that box's aspect ratio. The name
is semantic, not painted text. set_image changes content without replacing IDs;
set_image_size validates before mutation. Removal drops its raster ownership.
The widget never enumerates files, starts work, writes Config1 or owns a provider.
Loading/error names and async operation guards belong to its application builder.


### Lazy wallpaper image loading (#915)

image_load::Load starts only for a visible preview/thumbnail request. One process
worker serializes decode with at most four queued jobs. Request carries a nonzero
mount/request token, absolute path, physical target size, Contain/Cover and explicit
encoded/decoded-output byte budgets. Queue-full is Busy for later retry, not a
permanent image failure. No work starts from Default, paint or layout. Jobs read
only regular files, cap encoded input, inspect actual file format/dimensions and
refuse a DynamicImage output buffer over budget before its allocation. PNG/JPEG/GIF/WebP/
AVIF are the accepted formats (GIF's first frame). Decoder-internal allocations may already occur during header/AVIF setup and are
best-effort; the byte budgets do not claim a hard process-memory bound. Orientation
is applied before the target-size crop/resize. Only the resulting target raster
is retained by the UI; full source/decoded buffers are dropped on the worker.

Cancel/Drop and wrong-mount/request polling retire the receiver. Canceled queued
jobs are skipped and an active obsolete result cannot reach the UI. Load owns no
Tree, Window, Bridge or Config1 operation. Builders still guard current visibility,
availability and mount before accepting a result. This is no full wallpaper/native,
PSS/startup or animation acceptance. AVIF decoding uses the system dav1d library.


### Retained thumbnail strip (#882/#915)

Tree::thumbnail_strip is the horizontal layout of the existing Choice radio model,
not a second selection/provider implementation. Explicit ThumbnailStyle supplies
picture size/ImageStyle, padding/border/radius/gap and state colours. Options use
retained Choice IDs and Raster ownership; canonical selection may be None for an
unknown current file. Arrow/Home/End activate the existing guarded Choice path,
one Tab stop follows selected/first available, and focused options reveal inside
the strip's own horizontal viewport. Empty strips are valid. Wheel input over the
viewport scrolls it independently; D7 pane input is not routed through stale root
coordinates. Paint, pointer hit tests and SHOWING use the same viewport clipped
by ancestors. Offscreen options remain semantic RadioButton children. Reflow/style
changes clamp scroll and preserve IDs/selection. Loading/decode/Config1 belong to
application builders; this layout primitive alone is not wallpaper/native parity.

Catalogue reordering accepts only an exact permutation of surviving thumbnail
children, atomically; identities, pixels and canonical selection survive. Changed
order invalidates layout and stale action targets; invalid permutations do nothing.

### Wallpaper preview/gallery builders (#915)

wallpaperPreview and wallpaperGallery read wallpaper.current and its Config1
catalogue, never a second directory scan. Catalogue paths are unique absolute
paths, preserving service order; surviving options retain IDs. Unknown current
paths select none. Same-value activation emits no Apply; changed, live, writable,
shown activation uses exactly Cx.apply. Failed replies restore canonical selection
and retain their error. No picker stub is registered here: wallpaperPicker remains
an error until its portal implementation is connected.

The existing image loader starts only for showing images, with nonzero mount and
per-request tokens and explicit host byte budgets. Offscreen/hidden/unavailable/
unmounted/replaced requests are canceled. Decode failures are displayed as text;
obsolete pixels are removed before replacement. Only target-sized pixels survive.
Appearance restyling uses required wallpaper component exports for all four modes.
No ICC/HDR, native wallpaper parity or CSS 150ms border transition is claimed.

Builder::row_visible supplies per-owned-row content visibility, combined with
renderer availability/predicates/disclosures, never overriding them. Refresh after
idle applies async row visibility changes before publication. Default true keeps
existing builders' behavior. Empty gallery and absent error text occupy no row.

### Parented portal identifier (`nk-wayland`, #915/D5)

Window::portal_parent lazily exports an actual configured xdg_toplevel through the
optional standard zxdg_exporter_v2 on its existing connection/queue. Unsupported
means the protocol is absent, so a portal may use an empty parent identifier.
Pending means wait without blocking or falling back to empty; Ready supplies the
opaque `wayland:` identifier received from the compositor. Invalid empty handles
are errors, never unparented fallback. A popup cannot be exported as a toplevel.
The export is retained for the Window lifetime and destroyed before its role/
surface; repeated calls reuse it. There is no new host/provider/compositor path.
Unit state/capability checks are not native export/portal/parenting acceptance.

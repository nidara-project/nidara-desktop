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

## Any ScrolledWindow: `overlay_scrolling: false` unless a lane is reserved

Generalises the note above — this one keeps recurring (Settings lists, then the Assistant
transcript, 2026-07-21). GTK4 defaults to **overlay scrolling**: the bar is painted ON TOP of the
content, so it lands over whatever hugs the trailing edge — a row's buttons, or right-aligned chat
bubbles. Two sanctioned fixes, in order of preference:

1. **`overlay_scrolling: false`** — GTK allocates the scrollbar its own gutter. Cheapest (one
   property), but the gutter appears WITH the bar, so the content **resizes** the moment the view
   starts overflowing, and GTK's gutter sits visibly inset from the edge. Fine for a settings list
   whose rows are already full-width; **not** fine for a surface the user watches while it grows.
   Precedent: `Autostart.tsx`, `AppIcons.tsx`.
2. **Reserve a lane** (preferred on any live/animated surface). Keep overlay scrolling and pad the
   scrolling content by the lane width — always, overflowing or not — so nothing ever shifts; then
   pin the bar flush to the lane with a `trough` reset (`margin/padding: 0`) + a 1px slider side
   margin, so it grows toward the wall instead of back over the content. Recipe:
   `.nc-content-box` + `.nc-transparent-scroll` (`_control-center.scss`, fixed `GRID_WIDTH` cards)
   and `.agent-transcript` + `.agent-scroller` (`_bar.scss`, 8px lane, 4px slider). Caveat both
   inherit: the slider still fattens on hover — Adwaita's `.hovering` rule beats explicit state
   selectors; stopping it needs a structural change, not more specificity.

The user's ask that settled this (2026-07-21, Assistant transcript): *thin, as far right as
possible, and it must not affect the chat's content or size* — that is exactly case 2.

**Specificity trap, cost us a full round:** the shell scrollbar in `_reset.scss` is scoped by **ID**
(`#nidara-bar scrollbar slider` = (1,0,2)). A per-surface override written as a bare class
(`.agent-scroller scrollbar slider` = (0,1,2)) **loses silently** — you then debug geometry from CSS
that never applied. Keep the override inside its `window#name` scope (commandment 2) and it inherits
the ID, landing at (1,1,2). Also: the visible gap beside an overlay bar is Adwaita's **`trough`
margins**, not the slider width — reset the trough. Component to end this: tech-debt #37.

Never "fix" it by adding blanket right padding to a surface — that pays 8px of dead air on every
surface, overflowing or not.

## Search field — `.settings-search` box, never `Gtk.SearchEntry`

A search input on a shell/Settings surface is a **`Gtk.Box.settings-search`** holding an
`Icons.search` (`nd-icon`) + a `Gtk.Text` — NOT a `Gtk.SearchEntry`, which forces the icon theme's
magnifier glyph (off-brand, wrong on the opposite mode). Wire filtering off the `Gtk.Text`'s
`changed`. The Settings sidebar search (`Settings.tsx`) is the reference; App Icons repeated the
`SearchEntry` mistake and was corrected (2026-07-04).

## Ghost descenders on filter (PROVISIONAL fix — see tech-debt)

**Symptom:** in App Icons (`pages/AppIcons.tsx`) — the only Settings list with a live **search that
filters in place** (`set_filter_func` + `invalidate_filter`) — filtering leaves faint tails of
`y/g/j/p` behind the hidden rows, AND clips the tails of the *visible* remaining rows. The user's
tells: *"everything disappears except the tails"* and *"hovering a row fixes it."* The resting full
list is fine; only the filter re-layout breaks. Other pages never filter, so they never show it — they
are NOT broken, the bug just never triggers there (but they share the same label geometry).

**Nature:** a GTK4/GskGL renderer bug — on a mapped ScrolledWindow's content re-layout it doesn't
re-rasterise the descender **ink** that overflows Pango's logical line box. Hover (row state
re-render) and window resize (full re-raster) both clear it — those are the "tells," not the cause.

**⚠️ Verification is masked:** capturing a screenshot / driving the UI with synthetic clicks
re-renders the surface and HIDES the artifact — every crop came out clean while the user still saw it.
Do NOT trust `ags request screenshot` here; rely on the user's eyes.

**Current fix (provisional):**
```scss
.apps-list .nidara-row-subtitle { line-height: 1.35; }   // grows the LINE BOX so the ink is inside it
```
`line-height` grows the label's own text line box so the descender ink is part of the label's text
node → drawn in full (no clip/cut) AND inside the region GTK repaints on filter (no ghost). It is the
*least-bad* working fix, but **provisional**: it's scoped to `.apps-list`, so App Icons' subtitles are
slightly looser than the identical `.nidara-row-subtitle` on every other page — a design-system
inconsistency. Making it global would touch every list's density to fix a one-page bug. Left scoped
by user decision (2026-07-09), flagged to revisit.

**Dead ends — all measured live against the user, do NOT repeat:**
- `padding-bottom` on the subtitle: "fixes" the ghost only by **clipping the tail** (visibly cuts
  y/g/j on the visible rows). Same clip seen from both sides.
- `queue_draw()` at any scope incl. the toplevel root — stays diff-limited, no effect.
- Swapping the ListBox child, rebuilding the whole ScrolledWindow, rebuilding fresh rows and swapping
  — none held (the bug is below the widget layer).
- `opacity` toggle to force an offscreen re-raster — a timing-based repaint hack, didn't hold.

**Still exposed:** `surfaces/app-grid/AppGrid.tsx` filters its FlowBox in place — same latent bug.

## Radii (capsule-first)

- pill — `9999`
- lg — `24`
- md — `16`
- sm — `10`
- xs — `6`
- Squircle 28% (n ≈ 3.2) — **only** for app-icon plates.

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

### Semantic colour goes in a MARK or a FILL — never in the copy

**Do not tint text `--nidara-danger`/`--nidara-warning`.** Red type on glass reads badly (thin
weights over a translucent, blurred backdrop), and it shouts where a mark suffices. The signal
belongs to a small dedicated element next to the neutral text, or to a filled background:

| Signal | Where the colour lives | Text |
|---|---|---|
| Tool call rejected (`.agent-tool-fail`) | the 6px dot | `--nidara-text-dim` |
| Turn ended abnormally (`.agent-error-row`) | the 6px dot | `--nidara-text-dim` |
| Battery critical | the battery glyph's fill | plain white `%` |
| Recording active | the whole capsule fills | `--nidara-text` on top |

Rejected twice now (battery `%` 2026-07-20, assistant errors 2026-07-21 — both caught by the
user's eye), which is why it is a rule and not a preference. Corollary already documented below:
once a capsule fills with a semantic colour, do NOT tint the label on top of it as well.

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
    `common/Slider.ts` uses it for the neutral track colour. Use this for any future shared painter.
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
- **Any Cairo draw call that needs a colour defined as a hex string elsewhere goes through
  `hexToFloatRgb(hex)`** (`common/DrawingUtils.ts`) — `"#rrggbb"` → `{r,g,b}` as 0..1 floats,
  never a hand-rolled `parseInt(hex.slice(...), 16) / 255` triplet. Before this existed, that
  three-liner was independently copy-pasted into `SquircleContainer` (×2), the CC drag ghost,
  and — worse — `common/Slider.ts` and `widgets/battery.ts` had drifted into hardcoding their
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
| Sliders (any) | **`makeSlider`** from `common/Slider.ts` (NOT `Gtk.Scale`) | See "Sliders" below — one Cairo component for the whole shell. |
| Settings window | **`ui/lib/nidara-kit`** (`NidaraSplitView`, `NidaraClamp`, `NidaraButton`, `NidaraSelect`) | Custom split view. **Do NOT use `Adw.OverlaySplitView`** — it breaks capsule margins. |
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

## Buttons — one component + a variant convention

All action buttons go through **`NidaraButton`** (`ui/lib/nidara-kit/button.ts`) — never
`new Gtk.Button({ css_classes: ["nidara-btn", …] })` by hand, and never per-surface classes
(`settings-row-action` was a dead class that left its button rendering as raw Adwaita). CSS
lives once in `_components.scss` under `button.nidara-btn`.

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

For an icon that belongs **next to a row's title** rather than as a trailing control (e.g. a
lock on a secured Wi-Fi row), pass it as `NidaraRow`'s `titleIcon` arg (threaded through
`createRow(label, subtitle, widget, titleIcon)`) — don't park it in the trailing control box.
For an icon that **leads the row** (an identity icon before the title, e.g. each control's icon
in Settings → Control Center, or an app icon), pass `NidaraRow`'s `leadingIcon` arg (also threaded
through `createRow(label, subtitle, widget, titleIcon, leadingIcon)`) — it sits as the row's
first child, before the title column.

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

**A FIXED (non-accent) fill colour, and a PULSING one, are both the same mechanism with two more
optional props — `activeColorHex`/`activeAlpha`, threaded the same way as `getActive`/`getFill`.**
`screenrecord` is the reference: the recording indicator must read as urgent regardless of which
accent the user picked, so `activeColorHex: DANGER_HEX` (`lib/status-colors.ts`) overrides the
live-accent lookup `getActive`/`getFill` use by default. `activeAlpha` accepts `number | (() =>
number)` — screenrecord passes a getter, `0.75 + 0.25 * Math.sin(Date.now() * (2π/1400))`,
replacing the old CSS `@keyframes rec-pulse-cc` (1.4s, opacity 1↔0.5) now that the fill is
Cairo-painted, not CSS. The getter is only ever CALLED while `frac > 0` (i.e. only while
recording), so it doesn't need its own "am I active" guard. Pulsing needs `watchActive` to do more
than relay one domain signal: it must ALSO tick a ~15fps redraw timer *while active* so the
sine wave visibly advances, started/stopped on `notify::recording` (no timer at all while idle —
same "no session-long timers for hidden work" discipline as `poll.ts`). Migrating `screenrecord`
also retired its OWN one-off CSS states (`.rec-active-bg` icon-badge tint + keyframe, same
badge-only-not-whole-capsule pattern VPN had before), and deleted `.rec-stop-icon { color: danger
}` outright — dead CSS on a `Gtk.Image`, the exact bug class documented in the icon-tinting entry
above, just not caught until this pass. The label/subtitle no longer get a manual danger-red
override either: once the WHOLE capsule fills, `--nidara-text`'s default white/black already reads
fine on top (same reasoning as the split-target badge, same as every other filled toggle tile) —
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

All sliders are **`makeSlider`** (Cairo) in `common/Slider.ts` (`makeHSlider` is just a
horizontal wrapper). There is **no native `Gtk.Scale`** and no `PillSlider` — don't add them.

- **Cairo-drawn**: fill + thumb are painted together so they never visually separate (the
  native `scale` highlight/slider misalignment bug). Accent comes from `PALETTE[Theme.accentColor]`.
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
- **`makeVerticalFillTile`'s bottom icon is sized/placed to match a 1×1 tile's icon exactly** —
  28px glyph, vertical centre `UNIT/2` (40px) above the TALL tile's true bottom edge, not an
  arbitrary smaller icon of its own. Derivation: `40 − 4 (BaseIsland's TALL padding,
  `islandPadding()`) − 14 (half the 28px glyph) = margin_bottom: 22`. This works because a
  SINGLE tile's icon (button `width_request:48` + CENTER align) always resolves to the dead
  centre of its 80×80 cell regardless of padding magnitude, so `UNIT/2` from either edge is the
  correct target for both. If `UNIT`/`islandPadding`/the glyph size ever change, recompute this
  margin too — it's a hand-derived constant (matching the existing `trackH: 72` comment right
  above it in `common/Slider.ts`), not something that re-derives itself.
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
`common/GlassBubble.ts` and is **shared by the tooltip and BOTH context menus (dock + app-grid)** so
they all speak the same glass language. Don't re-implement it; every consumer paints via `paintGlassBubble`.

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
real compact (the EQ phase in `PlayerIsland.tsx`; the REC elapsed label in
`IslandActivities.tsx` syncs every registered label including the twins'), so ghosts
repaint bit-identical via the morph's own per-frame redraw (an idle ghost never damages
the bar). A mode with an art pair gets a media twin with a transparent art slot (layout
intact, the flying ghost owns those pixels — two visible copies would diverge
mid-flight). (c) The **content**
(`contentTarget`) fades in over the last stretch (progress 0.45→1) while the child
paints with the glass rect mapped onto the interpolated rect — content materializes
inside the already-formed shape; between the dissolve's end (0.35) and the content's
start (0.45) the flying pairs carry the continuity. All bounds are
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
7. **All component CSS wrapped in `window#name { … }`** — never global unscoped.

## When you're tempted to invent a new pattern

Before adding a new mixin, new token, or new class convention: check whether `_base.scss` already has it, and whether `@mixin glass` / `@mixin nidara-reset` cover the case. Migrating to existing mixins is a stated direction of the project (`@mixin glass` underuse is item #5 in the tech-debt list); adding a parallel pattern makes the future migration worse.

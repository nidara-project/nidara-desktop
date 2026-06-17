# Nidara — Design system & SCSS conventions

Read this when editing any SCSS, adding a new visual component, changing tokens, or deciding whether to use Adwaita or pure GTK4 for a new surface.

## Nidara vocabulary

- Glass capsules; blur ~40px (SCSS preview) or real blur from Hyprland (production).
- 1px inner white border, soft outer shadow, top sheen.
- **Accent color is for active/selected state only.** Never for normal borders or normal buttons.
- **Accent is NEVER a text colour** — not even for the active/selected state. It doesn't contrast reliably on every background. Active/selected text reads in the mode-aware token (`--nidara-text`/`-secondary`/`-dim`, `#fff` dark / `#000` light); the accent conveys the state via **background fill, tinted background (`--nidara-accent-10`), or border** instead (e.g. active workspace number, calendar "today", selected segment, chips/badges, suggested alert button = bold not accent). The one exception is white text *on* an accent fill (`--nidara-accent-fg`). Symbolic **icons** may still tint to accent (not text).

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

## Cairo vs CSS

- **CSS** for anything with states (hover/active/focus/drag).
- **Cairo** for complex static shapes (squircles, dots with halo, ring charts).
- **Important:** if Cairo paints a node's background, CSS must **not** also declare `background-color`. You'll get double-paint artifacts.

## Adwaita vs pure GTK4 — the central rule

This is the table that decides almost every "which widget should I use?" question:

| Surface | Use | Why |
|---|---|---|
| Dock, Bar, workspace dots, resource circles, schematic | **Pure GTK4 + Cairo** (`Gtk.DrawingArea` / `Gtk.Snapshot`) | Adwaita adds nothing here; painting direct = zero defensive CSS. |
| Floating overlays (CC, NotifCenter, Prism/Spotlight, SystemMenu, Overview) | **`Gtk.Box` + gtk4-layer-shell + custom CSS** | Adwaita would only add chrome you'd have to undo. |
| Toggles / switches / buttons inside overlays | **`Gtk.Switch`, `Gtk.Button`** (NOT `Adw.*Row`) | Base widgets style cleanly; `Adw.*Row` brings padding/focus-ring/separators that have to be killed one by one. |
| Sliders (any) | **`makeSlider`** from `common/Slider.ts` (NOT `Gtk.Scale`) | See "Sliders" below — one Cairo component for the whole shell. |
| Settings window | **`ui/lib/nidara-kit`** (`NidaraSplitView`, `NidaraClamp`, `NidaraButton`, `NidaraSelect`) | Custom split view. **Do NOT use `Adw.OverlaySplitView`** — it breaks capsule margins. |
| Modal dialogs | **`showNidaraAlert`** from `nidara-kit` | Clean, themeable. |

**Rule of thumb:** everything is **pure GTK4** — libadwaita has been fully removed. Dark/light is set via `Gtk.Settings.gtk_application_prefer_dark_theme` (no `Adw.init()`); the About window is a plain `Gtk.Window` (no `Adw.AboutWindow`). Don't reintroduce any `Adw.*`.

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

## Sliders — one component

All sliders are **`makeSlider`** (Cairo) in `common/Slider.ts` (`makeHSlider` is just a
horizontal wrapper). There is **no native `Gtk.Scale`** and no `PillSlider` — don't add them.

- **Cairo-drawn**: fill + thumb are painted together so they never visually separate (the
  native `scale` highlight/slider misalignment bug). Accent comes from `PALETTE[Theme.accentColor]`.
- **Custom input** (a `GestureDrag` + scroll + arrow keys, *not* a `Gtk.Scale`): clicking the
  track jumps to that position; grabbing the thumb never warps it; `drag-begin` claims the
  sequence so a slider inside a clickable tile (e.g. a CC widget) doesn't trigger the tile.
- **Options:** `orientation: "horizontal" | "vertical"`, `thumb` (default true). `thumb: false`
  + a wide `trackH` = the macOS-style vertical capsule (fill rises, clipped to the capsule so
  the end follows the rounded cap). Thumb goes translucent while pressed.
- **Wiring:** `onChange` (committed, optional `debounce` / `commitOnRelease`), `onValueChanged`
  (live, for the % label), `onExtChange(cb) → cleanup` for external value updates (ignored
  while the user drags).

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
  frame only repaints. Subtle macOS pop: 0.97→1, in 220ms, out 150ms. Pivot per surface,
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
- **Typing gotcha:** the class merges `export interface ScaleRevealer extends Gtk.Widget`
  because the ambient `ags/gtk4` typing exposes `Gtk` as `any` in value position — without
  the merge, tsc can't see the inheritance. Don't add TS `private` members or members whose
  name collides with a `Gtk.Widget` property (e.g. `scaleFactor`) — both break the merge.
- **Banner sizing:** the popup column uses `GRID_WIDTH` (356px, from `CCLayoutManager`) so
  banners match the NC cards exactly — one `NotificationCapsule`, one size. Wrapping labels
  inside layer-shell windows need `max_width_chars`: a wrapping `Gtk.Label` requests the
  full *unwrapped* text width as its natural width, and a layer window sizes to natural
  (the NC's scroll clamps it, a popup window balloons).

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

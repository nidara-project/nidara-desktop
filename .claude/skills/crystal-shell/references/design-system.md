# Crystal Shell — Design system (Fluid Crystal) & SCSS conventions

Read this when editing any SCSS, adding a new visual component, changing tokens, or deciding whether to use Adwaita or pure GTK4 for a new surface.

## Fluid Crystal vocabulary

- Glass capsules; blur ~40px (SCSS preview) or real blur from Hyprland (production).
- 1px inner white border, soft outer shadow, top sheen.
- **Accent color is for active/selected state only.** Never for borders, plain text, normal buttons.

## Radii (capsule-first)

- pill — `9999`
- lg — `24`
- md — `16`
- sm — `10`
- xs — `6`
- Squircle 28% (n ≈ 3.2) — **only** for app-icon plates.

## Tokens

Tokens live in `styles/_base.scss`. Dark/light values are injected at runtime by `FluidCrystal.ts → generateTokensCss()`. **Never invent hex values.** Use:

- `--crystal-accent`
- `--crystal-text*`
- `--crystal-surface*`
- `--crystal-border`
- `--crystal-radius-*`
- `--crystal-shadow-*`
- `--crystal-material-{thin,regular,thick,chrome}`
- `--crystal-danger`, `--crystal-success`, `--crystal-warning`

The only legitimate hex literals are the accent swatches and the danger/success/warning seeds defined inside `FluidCrystal.ts`.

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
| Settings window | **`ui/lib/crystal-ui`** (`CrystalSplitView`, `CrystalClamp`, `CrystalButton`, `CrystalSelect`) | Custom split view. **Do NOT use `Adw.OverlaySplitView`** — it breaks capsule margins. |
| Modal dialogs | **`showCrystalAlert`** from `crystal-ui` | Clean, themeable. |

**Rule of thumb:** everything is **pure GTK4** — libadwaita has been fully removed. Dark/light is set via `Gtk.Settings.gtk_application_prefer_dark_theme` (no `Adw.init()`); the About window is a plain `Gtk.Window` (no `Adw.AboutWindow`). Don't reintroduce any `Adw.*`.

## Buttons — one component + a variant convention

All action buttons go through **`CrystalButton`** (`ui/lib/crystal-ui/button.ts`) — never
`new Gtk.Button({ css_classes: ["crystal-btn", …] })` by hand, and never per-surface classes
(`settings-row-action` was a dead class that left its button rendering as raw Adwaita). CSS
lives once in `_components.scss` under `button.crystal-btn`.

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
  `CrystalButton({ pill: true })` and `add/remove_css_class("crystal-btn--primary")` in your
  state setter (the base `--secondary` class is a no-op, so removing `--primary` = neutral).
- **Icon-only buttons:** pass `icon: true` (adds `crystal-btn--icon` — compact uniform padding)
  and `set_child(new Gtk.Image({ … css_classes: ["cs-icon"] }))`. This keeps an icon button the
  same height as a labelled one in a cluster (e.g. details/forget sitting next to Connect),
  instead of looking smaller/odd. Don't hand-roll icon buttons with ad-hoc sizing.

For an icon that belongs **next to a row's title** rather than as a trailing control (e.g. a
lock on a secured Wi-Fi row), pass it as `CrystalRow`'s `titleIcon` arg (threaded through
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

## SCSS conventions and anti-patterns

These are the patterns that bite. Most "the styles look wrong" bugs in this codebase are violations of one of these.

1. **Avoid `background: none; border: none; box-shadow: none` chains** on internal nodes (`decoration`, `contents`, `ripple`, `focus-ring`, `outline`, viewport, list). If you find yourself needing ≥3 of these resets, the widget is probably Adwaita and should be a GTK base widget instead. Use `@mixin crystal-reset` for the canonical reset.
2. **Avoid long specificity chains** like `window.x preferencespage preferencesgroup list.boxed-list row`. They're a strong signal you're fighting Adwaita and should switch to base GTK + a flat custom class.
   - The fix: add `add_css_class("crystal-foo")` in TSX and style a flat `.crystal-foo`.
3. **Avoid color literals.** Resolve against tokens (`--crystal-danger`, etc.). The legitimate exceptions are the accent swatches and the danger/success/warning seeds inside `FluidCrystal.ts`.
4. **Use `@mixin glass($level)`** (surface / raised / floating) instead of repeating ~20 glass blocks. *Currently underused — only 2 call sites; migrating the rest is open work (see `tech-debt.md`).*
5. **`background-clip: padding-box` + `border: Npx solid transparent`** for "visual thickness ≠ real thickness" (avoids negative margins that break `GtkGizmo`).
6. **No `transform: scale` or `transform: translate` on interactive widgets.** GTK respects them but they break hit-testing. Use `margin`, or scale inside Cairo. *(Currently clean: 0 occurrences. Don't reintroduce them.)*
7. **All component CSS wrapped in `window#name { … }`** — never global unscoped.

## When you're tempted to invent a new pattern

Before adding a new mixin, new token, or new class convention: check whether `_base.scss` already has it, and whether `@mixin glass` / `@mixin crystal-reset` cover the case. Migrating to existing mixins is a stated direction of the project (`@mixin glass` underuse is item #5 in the tech-debt list); adding a parallel pattern makes the future migration worse.

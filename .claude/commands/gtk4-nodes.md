# GTK4 CSS Nodes — Crystal Shell Reference

Use this before writing any GTK4 CSS or building any widget.
**Rule: if a widget is not in the "safe primitives" table, don't use it raw — wrap it in crystal-ui.**

---

## Safe primitives (no Adwaita interference)

| Widget | CSS node | Default styling | Notes |
|---|---|---|---|
| `Gtk.Box` | `box` | none | Safe. Use freely. |
| `Gtk.Label` | `label` | none | Safe. |
| `Gtk.Image` | `image` | none | Safe. |
| `Gtk.Button` | `button` | padding, min-height, focus-ring | Reset with `border:none; box-shadow:none; min-height:0` |
| `Gtk.Popover` | `popover.background` > `contents` | padding on contents | Reset `> contents { padding:0; margin:0 }` |
| `Gtk.Overlay` | `overlay` | none | Safe. |
| `Gtk.DrawingArea` | `drawingarea` | none | Safe. Cairo only. |
| `Gtk.Snapshot` (in `draw-func`) | — | none | Safe. Cairo only. |
| `Gtk.Scale` | `scale > trough > slider` | complex but predictable | Documented below. |
| `Gtk.Switch` | `switch > slider` | simple | Reset border/shadow only. |
| `Gtk.PasswordEntry` | `entry` > `text` + `button` | border, padding | Reset documented below. |
| `Gtk.Entry` | `entry` > `text` | border, padding | Same as PasswordEntry. |
| `Gtk.ScrolledWindow` | `scrolledwindow` > `viewport` | min-height from content | Set `min-height:0` on both. |

---

## Dangerous widgets (bring Adwaita node trees — avoid or wrap)

| Widget | Problem |
|---|---|
| `Gtk.DropDown` | `button.combo` > `box` > factory label — label alignment not CSS-settable |
| `Gtk.MenuButton` | `menubutton` > `button.toggle` — extra node, Adwaita background |
| `Gtk.ComboBoxText` | Ancient, `combobox` + `button` + separate popup window |
| `Gtk.ListBox` | `list` > `row` — Adwaita adds first-child/last-child rounding automatically |
| `Gtk.ListBoxRow` | First/last-child corner rounding via Adwaita `:first-child :last-child` |
| `Gtk.TreeView` | Extremely complex node tree, avoid entirely |
| `Gtk.HeaderBar` | `headerbar` — heavy Adwaita styling, CSD decorations |
| `Gtk.Notebook` | Tab nodes, hard to style |
| `Adw.*` | Any Adwaita widget outside of Settings window |

---

## crystal-ui patterns (use these instead)

### Dropdown / Select
```
button.my-select              ← trigger (Gtk.Button)
  box                         ← Gtk.Box horizontal
    label                     ← selected text
    label.crystal-select-arrow ← ▾

popover.crystal-popup         ← Gtk.Popover(has_arrow:false)
  contents                    ← automatic GTK node (reset padding)
    box.crystal-popup-list    ← Gtk.Box vertical
      button.crystal-popup-item  ← one per option
```
**Use `CrystalSelect` from `ui/lib/crystal-ui.ts`.**

### Menu / Context menu
Same as dropdown but trigger is an icon button. Popover autohide handles dismiss.

### Sidebar navigation
```
box.crystal-sidebar           ← Gtk.Box vertical, fixed width
  button.crystal-sidebar-item ← one per section
    box                       ← icon + label horizontal
      image
      label
```
No `Gtk.StackSidebar`, no `Gtk.ListBox`. Just buttons, selection state managed in TS.

### Toggle / Tab bar
```
box.crystal-tabs              ← Gtk.Box horizontal
  button.crystal-tab          ← one per tab
  button.crystal-tab--active  ← selected tab (add/remove class in TS)
```

---

## CSS resets for safe primitives

### Gtk.Button (all buttons start here)
```scss
.my-btn {
  background: transparent;
  border: none;
  box-shadow: none;
  outline: none;
  min-height: 0;
  padding: 6px 12px;
  border-radius: var(--crystal-radius-pill);
  color: var(--crystal-text);
}
```

### Gtk.Entry / Gtk.PasswordEntry
```scss
.my-entry {
  background: var(--crystal-glass);
  border: 1px solid var(--crystal-glass-border-sm);
  border-radius: var(--crystal-radius-md);
  box-shadow: none;
  padding: 8px 12px;
  color: var(--crystal-text);
  caret-color: var(--crystal-accent);
  min-height: 0;

  &:focus {
    border-color: var(--crystal-accent);
    box-shadow: 0 0 0 3px var(--crystal-focus-ring);
  }

  > text { color: var(--crystal-text); }

  // peek icon button
  > button {
    background: transparent;
    border: none;
    box-shadow: none;
    min-height: 0;
    padding: 4px;
    color: var(--crystal-text-muted);
    &:hover { color: var(--crystal-text-secondary); }
  }
}
```

### Gtk.Popover
```scss
.my-popup {
  background: rgba(14, 14, 22, 0.97);
  border: 1px solid var(--crystal-glass-border-sm);
  border-radius: var(--crystal-radius-sm);
  box-shadow: 0 8px 24px rgba(0,0,0,0.6);
  padding: 4px;

  > contents { padding: 0; margin: 0; background: transparent; }
}
```

### Gtk.Scale (slider)
```scss
.my-scale {
  > trough {
    background: var(--crystal-glass);
    border-radius: var(--crystal-radius-pill);
    min-height: 4px;
    border: none;
    box-shadow: none;

    > highlight {
      background: var(--crystal-accent);
      border-radius: var(--crystal-radius-pill);
      border: none;
    }

    > slider {
      background: #fff;
      border-radius: 50%;
      min-width: 16px;
      min-height: 16px;
      border: none;
      box-shadow: 0 1px 4px rgba(0,0,0,0.4);
      margin: -6px;
    }
  }
}
```

---

## Adwaita quirks to know

- `Gtk.ListBox` in Adwaita: first row gets `border-radius top`, last row gets `border-radius bottom`. Cannot be disabled without `Adw.init()` absent **and** `GTK_THEME=Default`.
- `Gtk.MenuButton`: always wraps child in `button.toggle`. CSS on `menubutton` does not affect the visible button background.
- `Gtk.DropDown`: selected item label is inside a factory-created node — `xalign` is NOT a CSS property, must be set via a custom `Gtk.SignalListItemFactory`.
- Adwaita's `focus-ring`: appears as `box-shadow: 0 0 0 3px ...` on focused widgets. Remove with `box-shadow: none` or `outline: none`.
- `row-spacing` / `column-spacing` are **GObject properties**, not CSS properties. Set them in TypeScript: `grid.row_spacing = 8`.

---

## Where Adwaita IS used (and why)

| Location | Widget | Reason |
|---|---|---|
| `ui/ags-v3/widget/Settings*` | `Adw.PreferencesWindow`, `Adw.PreferencesGroup`, `Adw.ActionRow` | Built-in kbd nav, search, responsive split-view. Worth the CSS overhead because it's isolated. |
| Nowhere else | — | Everything else is GTK4 pure + crystal-ui. |

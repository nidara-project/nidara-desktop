# AGS Theming Guide

## Static Stylesheets
Import `.css` or `.scss` files directly.
```tsx
import css from "./style.css"
import scss from "./style.scss"

app.start({
    css: scss,
})
```

## CSS Property on Widgets
Use the `css` property for styles based on JS values.
**Warning**: The `css` property does not cascade to children. Use CSS classes where possible.
```tsx
<box css="padding: 1em; border: 1px solid red;" />
```

## Runtime Styling
Apply additional styles at runtime:
- `app.apply_css(pathOrString)`
- `app.reset_css()`

## GTK Inspector
Debug hierarchy and selectors:
```bash
ags inspect
```
Or use the global GTK shortcut `Ctrl+Shift+I` if enabled.

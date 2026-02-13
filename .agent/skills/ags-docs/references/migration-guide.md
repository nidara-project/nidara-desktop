# AGS Migration Guide

## v2 to v3 Highlights

### Import Paths
The `astal` namespace is mostly dropped in favor of `ags` which re-exports [Gnim](https://github.com/aylur/gnim).
```tsx
// v2
import { App, Gtk } from "astal/gtk3"
import { bind, Variable } from "astal/state"

// v3
import app from "ags/gtk3/app"
import { createBinding, createState } from "ags"
```

### Subclassing & astalify
`astalify` is removed. JSX handles GObject instantiation directly.
```tsx
// v2
const Calendar = astalify(Gtk.Calendar)
const _ = <Calendar />

// v3
const _ = <Gtk.Calendar />
```

### Reactivity
`Variable` is replaced by `createState` and `Accessor` signals.
```tsx
// v2
const v = Variable("")
v.set("new")

// v3
const [v, setV] = createState("")
setV("new")
```

### Dynamic Rendering
Use `<With>` and `<For>` components instead of `Binding.as()` for children.
```tsx
// v3
<With value={myState}>
    {(val) => <label label={val} />}
</With>

<For each={myList}>
    {(item) => <label label={item} />}
</For>
```

### Syntax Changes
- `setup` property is now `$` (ref callback).
- `className` property is now `class`.

```tsx
<button class="my-btn" $={(self) => console.log(self)} />
```

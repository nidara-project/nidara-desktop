# AGS First Widgets Guide

## Application Entry Point
Every app starts with `app.start`.
```tsx
import app from "ags/gtk4/app"
app.start({
    main() {
        // Instantiate widgets here
    },
})
```

## Windows
The root of every shell component is a `Window`.
**Note**: In GTK4, windows are not visible by default. Set `visible` prop.
```tsx
function Bar(monitor = 0) {
    return (
        <window visible monitor={monitor}>
            <box>Content</box>
        </window>
    )
}
```

## Custom Widgets
Custom widgets are functions that return GObjects (usually GtkWidgets) using JSX.
- **Intrinsic widgets**: Lowercase tags (e.g., `<box>`, `<button>`).
- **Custom widgets**: Capitalized tags (e.g., `<MyButton />`).

```tsx
function MyButton() {
    return (
        <button onClicked={() => console.log("clicked")}>
            <label label="Click me!" />
        </button>
    )
}
```

## Reactivity & State
State is managed via **Accessors**:
- `createState(initial)`: For writable reactive values.
- `createBinding(object, "property")`: For hooking into GObject properties.
- `createComputed(() => fn())`: For derived values.

```tsx
import { createState, createComputed } from "ags"

function Counter() {
    const [count, setCount] = createState(0)
    const label = createComputed(() => count().toString())
    return (
        <box>
            <label label={label} />
            <button onClicked={() => setCount(v => v + 1)}>Increment</button>
        </box>
    )
}
```

## External Programs
- `createPoll(initial, interval, cmd)`: Poll a command output.
- `createSubprocess(cmd, callback)`: Monitor standard output of a program.
**Tip**: Avoid polling where possible; use services or libraries.

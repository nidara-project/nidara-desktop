# AGS Quick Start Guide

It's as easy as a few lines to get a bar running on your screen.

## Core Components
- **GJS (Gnome JavaScript)**: The runtime.
- **Astal**: Suite of libraries for system interaction.
- **Gnim**: Template library for write widgets using JSX.
- **AGS**: CLI tool to skip setup and jump into TypeScript development.

## Single File Setup
Create a file (e.g., `mybar.tsx`):
```tsx
import app from "ags/gtk4/app"
import { Astal } from "ags/gtk4"
import { createPoll } from "ags/time"

app.start({
    main() {
        const { TOP, LEFT, RIGHT } = Astal.WindowAnchor
        const clock = createPoll("", 1000, "date")
        return (
            <window visible anchor={TOP | LEFT | RIGHT}>
                <label label={clock} />
            </window>
        )
    },
})
```

Run it:
```bash
ags run ./mybar.tsx
```

## Using a Template
Recommended for full TypeScript environments:
```bash
ags init -d /path/to/project
```
If on Nix:
```bash
nix flake init --template github:aylur/ags
```

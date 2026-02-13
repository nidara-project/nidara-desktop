---
name: ags-docs
description: Comprehensive documentation skill for AGS (Aylur's Gtk Shell) v3 / Astal. Use this skill when you need technical details on widget creation, state management, theming, process handling, or migrating from previous versions of AGS. Includes guides on JSX usage, Accessors, and Astal libraries.
---

# AGS Documentation Skill

This skill provides a complete set of technical guides for building desktop shells using **AGS (Aylur's Gtk Shell) v3** and the **Astal** library suite.

## Core Guides
- [**Installation**](references/install.md): Setup AGS on Arch, Nix, or from source.
- [**Quick Start**](references/quick-start.md): Get a bar running in seconds.
- [**First Widgets**](references/first-widgets.md): Understanding JSX, windows, and state (Accessors).
- [**Theming**](references/theming.md): CSS/SCSS integration and runtime styling.

## Technical Guides
- [**Utilities**](references/utilities.md): File I/O, timers (timeout/interval), and process execution (execAsync/subprocess).
- [**Migration Guide**](references/migration-guide.md): Critical changes when moving from v1/v2 to v3 (JSX, Accessors, imports).
- [**Resources**](references/resources.md): Links to Astal service libraries (Hyprland, Mpris, Network, etc.).

## Usage Tips
- **Reactivity**: Use `createState`, `createBinding`, and `createComputed`. Avoid old `Variable` syntax.
- **Performance**: Use `execAsync` or `createSubprocess` instead of blocking `exec`. Prefer Astal libraries over polling shell commands.
- **Syntax**: Use standard CSS variables `var(--variable)` in SCSS for GTK4 compatibility.

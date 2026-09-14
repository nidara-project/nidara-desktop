// The user hooks for appearance, fired from the CHANGE, not from a setter (#573).
//
// `accent-changed` and `dark-mode-changed` used to fire inside ThemeManager's
// setters. A setter runs in whichever process calls it, and a change made anywhere
// else never passes through one — so with a second writer (the Settings app, #571;
// `gsettings set` from a terminal, today) a hook fired there would run in the wrong
// process and die with its cgroup, run twice, or not run at all.
//
// So the shell watches the keys themselves and fires each hook ONCE per real
// change, whoever made it. Its own Gio.Settings, so it hears ThemeManager's writes
// like anybody else's. dconf emits nothing for a value written equal to the stored
// one, and the `last` guard covers the one case it would not: color-scheme moving
// between `default` and `prefer-light`, which are the same mode to a hook.
//
// ⚠️ SHELL ONLY — started from app.ts. Known limit, documented in user-hooks.md:
// a change made while the shell is down (a crash, a reload) fires nothing.

import Gio from "gi://Gio"
import { fireHook } from "./Hooks"

let started = false

export function startAppearanceHooks(): void {
    if (started) return
    started = true

    const settings = new Gio.Settings({ schema_id: "org.gnome.desktop.interface" })
    // Held for the life of the process: an unreferenced Gio.Settings is collected
    // and its handlers with it.
    keep.push(settings)

    const mode = () => settings.get_string("color-scheme") === "prefer-dark" ? "dark" : "light"
    let lastMode = mode()
    let lastAccent = settings.get_string("accent-color")

    settings.connect("changed::color-scheme", () => {
        const now = mode()
        if (now === lastMode) return
        lastMode = now
        fireHook("dark-mode-changed", now)
    })
    settings.connect("changed::accent-color", () => {
        const now = settings.get_string("accent-color")
        if (now === lastAccent) return
        lastAccent = now
        fireHook("accent-changed", now)
    })
}

const keep: InstanceType<typeof Gio.Settings>[] = []

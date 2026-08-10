#!/usr/bin/env node
/*
 * scope-audit — find CSS classes whose rules can never reach the window that
 * renders them.
 *
 *   cd ui/shell && npm run build          # style.css must be current
 *   node ../../scripts/dev/scope-audit.mjs
 *
 * Why this exists. Every surface sheet is wrapped in its window's selector
 * (commandment 2). That makes the scope a fact about the TSX — about which
 * window a widget is finally mounted in — and the TSX moves: the app grid got
 * its own window in #102, the Activity Island got one in July. When a surface
 * changes windows, the rules that used to reach it stay in the sheet, stop
 * matching, and report NOTHING. No SCSS error, no GTK warning, no diff. What
 * you get is "that thing looks like raw GTK now", months later, from a human.
 *
 * That is not hypothetical. The island's media panel rendered with GTK defaults
 * for months because `.nidara-media-*` sat inside `_control-center.scss`'s
 * `#nidara-bar` block while `PlayerIsland` shows the very same panel. The same
 * sweep then found the "Default" badge and the slider readout, both scoped to
 * the CC's detail page while Settings wore them too.
 *
 * How it works: for every class named in `css_classes:` / `add_css_class()` by
 * code that renders into a given window, look for at least one selector in the
 * compiled sheet that is either unscoped (the global kit) or scoped to THAT
 * window. Three outcomes:
 *
 *   - no selector at all      → fine. The widget is Cairo-painted, or the class
 *                               is only a marker/lookup key.
 *   - a reachable selector    → fine.
 *   - only selectors naming a
 *     DIFFERENT window        → the bug. Reported.
 *
 * What it CANNOT tell you: whether a reachable rule is the one you meant, or
 * whether specificity lets something else win. It answers "can this rule ever
 * apply here", nothing more. A clean run is not a substitute for looking at the
 * running shell.
 *
 * Keep WINDOWS in step with the scope table in the nidara skill
 * (references/design-system.md) whenever a surface moves or is added.
 *
 * ── PASS 2: a window inside a window ────────────────────────────────────────
 * The pass above is only as complete as WINDOWS, and that list is hand-kept — so
 * it is blind to a window it has never been told about. The NidaraAlertDialog is
 * exactly that: its own toplevel Gtk.Window, whose rules got swept inside
 * `window.nidara-settings-window` when that sheet was scoped (#97). Every class
 * in it belongs to `../lib/nidara-kit`, which this file attributes to Settings,
 * so pass 1 found a Settings-scoped selector, called it reachable, and went
 * green while the whole dialog rendered as raw GTK.
 *
 * Pass 2 needs no list. A window scope root in a NON-INITIAL position is
 * impossible by construction — a Gtk.Window is always a GtkRoot, and a transient
 * is a sibling root, never a descendant — so any such selector is dead no matter
 * which windows exist. It caught the dialog with zero false positives across the
 * sheet's 1259 selectors.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join, dirname, basename, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const SHELL = join(ROOT, "ui/shell")
const SHEET = join(SHELL, "style.css")

/* Every scope prefix the sheet uses. A selector starting with one of these is
 * scoped to SOME window; anything else is the design system's global layer
 * (_base, _components, _reset, keyframes) and reaches everywhere. */
const ALL_SCOPES = [
    "#nidara-", "window#",
    ".nidara-bar-window", ".nidara-island-window", ".nidara-dock-window",
    ".nidara-app-grid-window", ".nidara-settings-window",
    "window.nidara-settings-window", ".about-floating-window",
    // ⚠️ A missing entry here does NOT fail — it reads as "unscoped", i.e.
    // reachable from everywhere, which is the most permissive answer the tool
    // can give. Adding a window means adding it in BOTH lists.
    "window.nidara-alert-dialog",
]

/* dirs = the code that renders INTO this window, which is not the same as the
 * directory named after it. Bar.tsx builds the capsule row and hands it to the
 * island; PlayerIsland shows a panel built in widgets/. Follow the mount site. */
const WINDOWS = [
    {
        name: "bar",
        dirs: ["surfaces/bar", "surfaces/control-center", "surfaces/prism", "widgets"],
        own: ["#nidara-bar", ".nidara-bar-window", "window.nidara-bar-window"],
    },
    {
        name: "island",
        // widgets/media.ts: PlayerIsland mounts buildMediaDetailPanel.
        // surfaces/overview: ActivityIsland mounts the workspace overview.
        // common/WorkspaceDot.ts: the dots, island-only.
        dirs: ["surfaces/island", "surfaces/overview"],
        files: ["widgets/media.ts", "common/WorkspaceDot.ts", "common/widget-kit.ts"],
        own: ["#nidara-island", ".nidara-island-window", "window.nidara-island-window"],
    },
    {
        name: "dock",
        dirs: ["surfaces/dock"],
        own: ["#nidara-dock", ".nidara-dock-window", "window.nidara-dock-window"],
    },
    {
        name: "appgrid",
        dirs: ["surfaces/app-grid"],
        own: ["#nidara-app-grid", ".nidara-app-grid-window", "window.nidara-app-grid-window"],
    },
    {
        name: "settings",
        dirs: ["surfaces/settings", "surfaces/settings/pages", "../lib/nidara-kit"],
        // The kit's alert dialog is its OWN toplevel — Settings opens it, but a
        // transient is a sibling root, so its classes are not Settings' to reach.
        // Leaving it in was how the dead `window.nidara-settings-window
        // window.nidara-alert-dialog` passed this audit for three days.
        not: ["alert-dialog.ts"],
        own: ["window.nidara-settings-window", ".nidara-settings-window"],
    },
    {
        name: "about",
        dirs: ["surfaces/about"],
        own: ["window#nidara-about", ".about-floating-window"],
    },
    {
        name: "alert",
        files: ["../lib/nidara-kit/alert-dialog.ts"],
        own: ["window.nidara-alert-dialog"],
    },
]

if (!existsSync(SHEET)) {
    console.error(`no compiled sheet at ${SHEET} — run \`npm run build\` in ui/shell first`)
    process.exit(2)
}

/* Selector list from the compiled sheet, comments stripped so a class named in
 * prose is not mistaken for a rule. */
const css = readFileSync(SHEET, "utf8").replace(/\/\*[\s\S]*?\*\//g, "")
const selectors = []
for (const m of css.matchAll(/([^{}]+)\{[^{}]*\}/g))
    for (const s of m[1].split(",")) selectors.push(s.trim().replace(/\s+/g, " "))

const sources = (dir) => {
    const abs = join(SHELL, dir)
    if (!existsSync(abs)) return []
    return readdirSync(abs)
        .filter(f => f.endsWith(".ts") || f.endsWith(".tsx"))
        .map(f => join(abs, f))
}

const classesIn = (files) => {
    const used = new Map()
    for (const f of files) {
        const src = readFileSync(f, "utf8")
        const add = (c) => {
            if (!used.has(c)) used.set(c, new Set())
            used.get(c).add(basename(f))
        }
        for (const m of src.matchAll(/css_classes:\s*\[([^\]]*)\]/g))
            for (const c of m[1].matchAll(/"([^"]+)"/g)) add(c[1])
        for (const m of src.matchAll(/add_css_class\("([^"]+)"\)/g)) add(m[1])
    }
    return used
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

let failures = 0
for (const win of WINDOWS) {
    const files = [...(win.dirs ?? []).flatMap(sources), ...(win.files ?? []).map(f => join(SHELL, f))]
        .filter(existsSync)
        .filter(f => !(win.not ?? []).includes(basename(f)))
    const used = classesIn(files)
    const bad = []

    for (const [cls, where] of [...used].sort()) {
        // `.` always OPENS a class token in a selector, so only the trailing
        // boundary matters: `.foo` must not match `.foo-bar`. Do not anchor the
        // left side on whitespace — that silently skipped every element-qualified
        // rule (`label.accent-label`, `button.nidara-btn`, `spinbutton.time-spin`),
        // which the tool then read as "no CSS at all" and passed. Caught by
        // reintroducing a known bug and watching only half of it get reported.
        const re = new RegExp(`\\.${esc(cls)}(?![\\w-])`)
        const hits = selectors.filter(s => re.test(s))
        if (hits.length === 0) continue                        // Cairo / marker class
        const reachable = hits.some(s =>
            win.own.some(o => s.startsWith(o)) || !ALL_SCOPES.some(o => s.startsWith(o)))
        if (!reachable) bad.push([cls, [...where].sort(), hits[0]])
    }

    console.log(`${bad.length ? "FAIL" : "ok  "}  ${win.name.padEnd(9)} ${String(used.size).padStart(3)} classes` +
                (bad.length ? `, ${bad.length} unreachable` : ""))
    for (const [cls, where, hit] of bad) {
        console.log(`        .${cls}`)
        console.log(`            rendered by : ${where.join(", ")}`)
        console.log(`            only styled : ${hit}`)
    }
    failures += bad.length
}

/* ── Pass 2 — a window scope root that is not at the start of its selector ────
 * `window` must be matched as a whole compound, never as a suffix: GTK4's node
 * name for a Gtk.ScrolledWindow is `scrolledwindow`, so a naive substring test
 * flags every `scrolledwindow.apps-list-scroll > viewport` in the sheet. */
const isWindowRoot = (c) => /^window(?=[.#:]|$)/.test(c) || /^#nidara-/.test(c)
const nested = []
for (const s of selectors) {
    const compounds = s.split(/\s*[>+~]\s*|\s+/).filter(Boolean)
    const at = compounds.findIndex((c, i) => i > 0 && isWindowRoot(c))
    if (at > 0) nested.push([s, compounds[at]])
}

console.log(`${nested.length ? "FAIL" : "ok  "}  ${"nesting".padEnd(9)} ${String(selectors.length).padStart(3)} selectors` +
            (nested.length ? `, ${nested.length} rooted at a window inside a window` : ""))
for (const [sel, compound] of nested) {
    console.log(`        ${sel}`)
    console.log(`            unreachable : \`${compound}\` is a toplevel window, so it can never be a descendant`)
}
failures += nested.length

process.exit(failures ? 1 : 0)

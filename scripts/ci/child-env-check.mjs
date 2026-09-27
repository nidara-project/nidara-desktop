#!/usr/bin/env node
/**
 * child-env-check.mjs — the desktop starts child processes through ONE door:
 * `spawn()` in `ui/lib/process.ts` (or `exec`/`execAsync`, which use it).
 *
 * WHY THIS EXISTS (2026-09-27). Our processes run with `GTK_THEME=Empty` in their
 * environment — commandment 11, the only way to draw with no GTK theme, and one GTK
 * re-reads at every theme update, so it cannot be unset once we are up. A child
 * inherits the environment. Every app the dock, the app grid or Prism launched came
 * up with NO theme at all — owner-caught, then measured on a Calculator started
 * through `launchApp`. `spawn()` starts children without our private variables;
 * any other way of starting a process (`Gio.Subprocess.new`, a launcher of your
 * own, `GLib.spawn_*`, `Gio.AppInfo.launch*`) hands them over again, and nothing
 * on screen says why the next app looks wrong.
 *
 * Scope: the desktop bundles — `ui/shell/`, `ui/greeter/`, `ui/lockscreen/` and
 * `ui/lib/` (shared by all). NOT `ui/installer/`: it starts archinstall, pkexec and
 * systemctl, never an application somebody then uses, and it lives on the live
 * medium only. A comment line is not code and is skipped.
 *
 * Usage:  node scripts/ci/child-env-check.mjs [root]
 * CI: the "Widget registry freshness" job, with a control that plants a
 * `Gio.Subprocess.new` and requires this check to fail.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "fs"
import { join, resolve, relative } from "path"

const REPO = resolve(process.argv[2] ?? new URL("../..", import.meta.url).pathname)
const ROOTS = ["ui/shell", "ui/greeter", "ui/lockscreen", "ui/lib"]
const DOOR = "ui/lib/process.ts"
const SKIP_DIRS = new Set(["node_modules", "@girs", "build"])

const FORBIDDEN = [
    [/\bGio\.Subprocess\.new\s*\(/, "Gio.Subprocess.new"],
    [/\bnew\s+Gio\.Subprocess\s*\(/, "new Gio.Subprocess"],
    [/\bGio\.SubprocessLauncher\b/, "a Gio.SubprocessLauncher of your own"],
    [/\bGLib\.spawn_\w+\s*\(/, "GLib.spawn_*"],
    [/\.launch(_uris)?(_async)?\s*\(\s*(null|\[)/, "Gio.AppInfo.launch*"],
    [/\blaunch_default_for_uri\w*\s*\(/, "Gio.AppInfo.launch_default_for_uri"],
]

function* walk(dir) {
    for (const name of readdirSync(dir)) {
        if (SKIP_DIRS.has(name)) continue
        const p = join(dir, name)
        if (statSync(p).isDirectory()) yield* walk(p)
        else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) yield p
    }
}

const failures = []
let files = 0
for (const root of ROOTS) {
    const dir = join(REPO, root)
    if (!existsSync(dir)) continue
    for (const file of walk(dir)) {
        const rel = relative(REPO, file)
        if (rel === DOOR) continue
        files++
        readFileSync(file, "utf8").split("\n").forEach((line, i) => {
            const code = line.trim()
            if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return
            for (const [re, what] of FORBIDDEN) {
                if (re.test(line)) failures.push(`${rel}:${i + 1}: ${what} — use spawn() from ui/lib/process.ts`)
            }
        })
    }
}

if (failures.length) {
    console.error(`child-env-check: ${failures.length} process start(s) outside the one door:\n`)
    for (const f of failures) console.error("  " + f)
    console.error("\nA child started any other way inherits GTK_THEME=Empty and draws with no theme (see ui/lib/process.ts).")
    process.exit(1)
}
console.log(`child-env-check: ${files} files, every child process starts through spawn().`)

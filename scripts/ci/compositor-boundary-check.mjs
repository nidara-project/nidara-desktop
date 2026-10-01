#!/usr/bin/env node
/**
 * compositor-boundary-check.mjs — the shell talks to ONE compositor interface (#682).
 *
 * Nidara runs on Hyprland and on Hyalo, the compositor of our own (#680), and the shell
 * reaches either through `core/CompositorState.ts`. A surface that imports HyprlandState
 * or calls `hyprctl` works on one session and does nothing — or fails in a log nobody
 * reads — on the other, and tsc cannot tell: both compile.
 *
 * Outside the compositor modules (COMPOSITOR below), a file under ui/shell or ui/lib may
 * not:
 *   - import a backend, its IPC or its settings side (HyprlandState, HyaloState, hypr-ipc,
 *     hyalo-ipc, hyprland-settings, hyalo-settings) or the Lua generator (hyprland-lua);
 *   - spawn `hyprctl` (a "hyprctl" string literal in code).
 *
 * And no script in bin/ may run `hyprctl`: they ask `bin/nidara-wm`, which answers from
 * whichever compositor runs (Hyprland's JSON shapes, built from Hyalo's IPC on Hyalo). The
 * one exception is nidara-doctor's version line, which reports Hyprland the package.
 *
 * No exceptions otherwise. Until #682's third part this had a shrink-only allowlist of the files
 * that wrote Hyprland options as Lua; they now go through `settings` (CompositorSettings),
 * and the list went with its last line.
 *
 * Usage:  node scripts/ci/compositor-boundary-check.mjs
 */

import { readFileSync, readdirSync, statSync } from "fs"
import { join, relative, resolve } from "path"

const ROOT = resolve(new URL("../..", import.meta.url).pathname)
const SCAN = ["ui/shell", "ui/lib"]
const COMPOSITOR = new Set([
    "ui/shell/core/CompositorState.ts",
    "ui/shell/core/compositor-types.ts",
    "ui/shell/core/HyprlandState.ts",
    "ui/shell/core/HyaloState.ts",
    "ui/shell/core/hypr-ipc.ts",
    "ui/shell/core/hyalo-ipc.ts",
    "ui/shell/core/hyprland-lua.ts",
    // The settings interface's two sides (CompositorSettings).
    "ui/shell/core/hyprland-settings.ts",
    "ui/shell/core/hyalo-settings.ts",
    // The monitors facade: Hyalo's outputs say more than the neutral monitor shape.
    "ui/shell/core/Displays.ts",
])
const BACKENDS = /from\s+"[^"]*\/(HyprlandState|HyaloState|hypr-ipc|hyalo-ipc|hyprland-lua|hyprland-settings|hyalo-settings)"/g

function walk(dir, out) {
    for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "@girs" || name === "build") continue
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p, out)
        else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) out.push(p)
    }
    return out
}

/** The source with comments blanked out, so a comment that mentions hyprctl is no use. */
function code(text) {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "))
        .replace(/(^|[^:"'`])\/\/[^\n]*/g, (m, pre) => pre + " ".repeat(m.length - pre.length))
}

function violations(file, text) {
    const found = []
    const c = code(text)
    for (const m of c.matchAll(BACKENDS)) found.push(`imports ${m[1]}`)
    if (/["'`]hyprctl["'`\s]/.test(c)) found.push("spawns hyprctl")
    return found
}

const offenders = new Map()
for (const base of SCAN) {
    for (const abs of walk(join(ROOT, base), [])) {
        const rel = relative(ROOT, abs)
        if (COMPOSITOR.has(rel)) continue
        const v = violations(rel, readFileSync(abs, "utf8"))
        if (v.length) offenders.set(rel, v)
    }
}

// bin/: scripts in any language, so a line-based look — comments (# or //) skipped.
for (const name of readdirSync(join(ROOT, "bin"))) {
    if (name === "nidara-wm") continue
    const rel = `bin/${name}`
    if (statSync(join(ROOT, rel)).isDirectory()) continue
    const hits = readFileSync(join(ROOT, rel), "utf8").split("\n")
        .map((line, i) => [line.replace(/(^|\s)(#|\/\/).*$/, ""), i + 1])
        .filter(([line]) => /\bhyprctl\b/.test(line) && !/hyprctl version/.test(line))
    if (hits.length) offenders.set(rel, hits.map(([, n]) => `runs hyprctl (line ${n})`))
}

for (const [file, v] of [...offenders].sort()) {
    console.error(`✗ ${file} reaches past the compositor interface (${[...new Set(v)].join(", ")}).`)
    console.error(file.startsWith("bin/")
        ? "  Ask bin/nidara-wm instead (it answers from Hyprland or Hyalo); if it lacks the question, add it there for both."
        : "  Ask core/CompositorState.ts (`compositor`, `settings`) instead; if the interface lacks it, add it to both backends.")
}
if (offenders.size) process.exit(1)
console.log(`compositor-boundary-check: ok — nothing outside the ${COMPOSITOR.size} compositor modules names a compositor, and no script in bin/ runs hyprctl (#682)`)

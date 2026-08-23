#!/usr/bin/env node
// blur-threshold-check — the glass floor and every layer's `ignore_alpha` are ONE
// decision split across two files, and nothing else notices when they disagree.
//
// `ignore_alpha` is what tells Hyprland where to blur: a pixel whose alpha is below
// it keeps a sharp backdrop. Our glass is painted at `GLASS_RANGE.min` at its
// thinnest. So the moment a layer's threshold reaches the floor, that surface stops
// being blurred AT ALL — not degraded, gone — and it fails silently: the config
// still parses, the shell still boots, the smoke still passes, and the only symptom
// is a dock that looks flat in a screenshot nobody is diffing.
//
// The dock deliberately sits just under the floor (it is the only layer that never
// animates its opacity, so it can), which is exactly why this needs a gate rather
// than a comment: the headroom is small ON PURPOSE, and the thing that would eat it
// is an innocent edit to a constant in a different language in a different directory.
import { readFileSync } from "node:fs"

const theme  = readFileSync("ui/shell/core/NidaraTheme.ts", "utf8")
const tokens = readFileSync("ui/lib/tokens.ts", "utf8")

const m = theme.match(/GLASS_RANGE\s*=\s*\{\s*min:\s*([0-9.]+)\s*,\s*max:\s*([0-9.]+)/)
if (!m) { console.error("blur-threshold-check: could not read GLASS_RANGE from NidaraTheme.ts"); process.exit(1) }
const shellFloor = parseFloat(m[1])

// ⚠️ The login surfaces do NOT use GLASS_RANGE — they are separate bundles with a
// FIXED glass (`LOCK_GLASS.fill.a`, mirrored into ui/greeter/style.scss), and there
// is no opacity slider there to move it. Checking them against the shell's floor is
// what this gate did on its first run, and it reported a false failure for exactly
// that reason. Each surface is compared against the glass IT actually paints.
const lm = tokens.match(/fill:\s*\{[^}]*a:\s*([0-9.]+)/)
if (!lm) { console.error("blur-threshold-check: could not read LOCK_GLASS.fill.a from tokens.ts"); process.exit(1) }
const lockFloor = parseFloat(lm[1])

// ⚠️ `nidara-lock` is NOT compositor-blurred and its rule cannot be checked against
// anything, because it never governs the lock people actually run. The primary path
// is ext-session-lock-v1 (`Gtk4SessionLock`, ui/lockscreen/app.ts) — that surface is
// not a layer surface at all, so no layer_rule matches it, and Hyprland's own primer
// paints an opaque sheet over everything behind it (which is why `GlassBackdrop`
// blurs its OWN copy of the wallpaper). The namespace exists only on `LockOverlay()`,
// the layer-shell fallback for compositors without the protocol — and even there the
// window paints the wallpaper itself, so there is nothing behind it to blur.
// Skipped LOUDLY rather than dropped: a gate that silently ignores a row teaches the
// same wrong model the row itself does.
const INERT = new Map([["nidara-lock",
    "ext-session-lock-v1 surface — no layer_rule applies; the fallback paints its own wallpaper"]])

const FLOOR_FOR = (ns) =>
    (ns === "nidara-greeter")
        ? { value: lockFloor, name: "LOCK_GLASS.fill.a" }
        : { value: shellFloor, name: "GLASS_RANGE.min" }

const SOURCES = [
    ["config/hypr/hyprland.lua", readFileSync("config/hypr/hyprland.lua", "utf8")],
    ["config/greetd/hyprland-greeter.lua", readFileSync("config/greetd/hyprland-greeter.lua", "utf8")],
]

// Per LINE, not per statement: the rule's own `match = { … }` closes a brace in the
// middle, so any regex that tries to span the whole call stops at the wrong place.
const rules = []
for (const [file, text] of SOURCES) {
    for (const line of text.split("\n")) {
        if (!line.includes("hl.layer_rule") || line.trim().startsWith("--")) continue
        const ns = line.match(/namespace\s*=\s*"([^"]+)"/)
        const ia = line.match(/ignore_alpha\s*=\s*([0-9.]+)/)
        if (ns && ia) rules.push([file, ns[1], ia[1]])
    }
}
if (rules.length === 0) { console.error("blur-threshold-check: found no layer_rule with ignore_alpha"); process.exit(1) }

let bad = 0
console.log(`shell glass floor  GLASS_RANGE.min   = ${shellFloor}  →  ${Math.round(shellFloor * 255)}/255`)
console.log(`login glass        LOCK_GLASS.fill.a = ${lockFloor}  →  ${Math.round(lockFloor * 255)}/255\n`)
for (const [, ns, raw] of rules) {
    if (INERT.has(ns)) {
        console.log(`  skip  ${ns.padEnd(16)} ignore_alpha ${String(parseFloat(raw)).padEnd(5)} — ${INERT.get(ns)}`)
        continue
    }
    const t = parseFloat(raw)
    const f = FLOOR_FOR(ns)
    const ok = t < f.value
    if (!ok) bad++
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${ns.padEnd(16)} ignore_alpha ${String(t).padEnd(5)} (${(t * 255).toFixed(1)}/255)  vs ${f.name}` +
                (ok ? `  — ${(f.value * 255 - t * 255).toFixed(1)} levels under it`
                    : `  — AT OR ABOVE IT: this layer would stop blurring`))
}
if (bad) {
    console.error(`\nblur-threshold-check: ${bad} layer rule(s) at or above the glass floor.`)
    console.error("Either lower the threshold or raise the glass it is measured against — they are one decision.")
    process.exit(1)
}
console.log("\nblur-threshold-check: every layer threshold is under the glass floor.")

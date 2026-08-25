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
// ── The OTHER side of the same threshold ─────────────────────────────────────────
// Everything above asks "is our glass thick enough to still be blurred?". This asks
// the opposite, and it is the question that shipped a bug: "is everything we paint
// that must NOT be blurred thin enough to stay under the line?"
//
// The login surfaces put two translucent layers straight onto the wallpaper with no
// glass body: `.greeter-scrim` (a gradient, the whole screen) and the hero's
// `text-shadow` (date/clock/username), which is painted ON TOP of the scrim and so
// COMPOUNDS with it. Every pixel of that sum at or above `ignore_alpha` gets blurred
// wallpaper behind it — and because a gradient crosses the number somewhere in the
// middle of the screen, the result is a frosted band ending in a hard line.
//
// That is not a hypothetical: with `ignore_alpha` at 0.3 the cap was 0.28 and fine;
// the threshold moved to 0.23 and the cap did not follow, so the login screen shipped
// with a blurred band across its top and bottom third and a halo around the clock.
// Nothing failed — same silence as the floor above, from the same two numbers living
// in two files. Hence a second gate rather than a second comment.
const scss = readFileSync("ui/greeter/style.scss", "utf8")

const alphasIn = (block, what) => {
    const found = [...block.matchAll(/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([0-9.]+)\s*\)/g)].map(m => parseFloat(m[1]))
    if (found.length === 0) { console.error(`blur-threshold-check: no rgba() alphas in ${what}`); process.exit(1) }
    return found
}
// ⚠️ EVERY block, not the first one — and that is not tidiness, it is the difference
// between a gate and a gate-shaped comment. Since the login screens gained a LIGHT
// skin (`window.skin-light …`, tech-debt #82) each of these rules exists twice: the
// dark one and the light one, same alphas, opposite ink. `indexOf` would have found
// the dark one, passed, and never looked at the other — so the new branch would be
// the only un-audited paint on the two surfaces that have a CI gate precisely because
// their paint is un-auditable by eye. A rule that stops being measured is exactly how
// the 0.28-vs-0.23 drift shipped in the first place.
const blocksFor = (marker, what) => {
    const out = []
    for (let i = scss.indexOf(marker); i >= 0; i = scss.indexOf(marker, i + 1)) {
        out.push(scss.slice(i, scss.indexOf("}", i)))
    }
    if (out.length === 0) { console.error(`blur-threshold-check: could not find ${what} (looked for ${marker})`); process.exit(1) }
    return out
}

// The scrim's gradient: its DARKEST stop is the one that decides — across both skins.
const scrimMax = Math.max(...blocksFor(".greeter-scrim {", "the scrim rule")
    .flatMap((b, i) => alphasIn(b, `.greeter-scrim #${i + 1}`)))

// The hero shadow: both layers of it, and they stack with each other as well. The
// marker matches the shadow rule AND `.greeter-username`'s own type rule, so the
// blocks without a text-shadow are not an error — they are the other rule.
const shadowLines = blocksFor(".greeter-username {", "the hero text rule")
    .map(b => b.split("\n").find(l => l.includes("text-shadow")))
    .filter(Boolean)
if (shadowLines.length === 0) { console.error("blur-threshold-check: no text-shadow in any .greeter-username rule"); process.exit(1) }
// Position by position, the worst any skin declares.
const perSkin = shadowLines.map((l, i) => alphasIn(l, `the hero text-shadow #${i + 1}`))
const layers = Math.max(...perSkin.map(a => a.length))
const heroAlphas = Array.from({ length: layers }, (_, i) => Math.max(...perSkin.map(a => a[i] ?? 0)))

// Alpha compositing, not addition: a_total = 1 − Π(1 − aᵢ)
const composite = 1 - [scrimMax, ...heroAlphas].reduce((acc, a) => acc * (1 - a), 1)

const greeterRule = rules.find(([, ns]) => ns === "nidara-greeter")
if (!greeterRule) { console.error("blur-threshold-check: no layer_rule for nidara-greeter to measure the ceiling against"); process.exit(1) }
const greeterThreshold = parseFloat(greeterRule[2])

// ── And the same threshold from the third side ───────────────────────────────────
// The two checks above are "thick enough to blur" (the glass) and "thin enough not
// to" (the scrim + hero shadow). This is a body that is neither painted with the
// glass token nor meant to stay sharp: the avatar's fallback circle, a plain CSS
// fill. It has to clear the threshold ALONE.
//
// It shipped at 0.10 and appeared to work, because the scrim underneath carried it
// over the line (1 − 0.84 × 0.90 = 0.244, four thousandths of margin). Capping the
// scrim took that away and the circle went sharp — a body that stops being glass
// because a DIFFERENT rule changed. Named explicitly here so the coupling cannot come
// back silently: if a fill needs the layer to blur behind it, its own alpha says so.
// Every skin's version of it, and the THINNEST wins the argument: this body has to
// clear the threshold on its own, so the one closest to the line is the one that
// decides whether the circle goes sharp.
const avatarLines = blocksFor(".greeter-avatar-fallback {", "the avatar fallback rule")
    .map(b => b.split("\n").find(l => /background\s*:/.test(l)))
    .filter(Boolean)
if (avatarLines.length === 0) { console.error("blur-threshold-check: no background in .greeter-avatar-fallback"); process.exit(1) }
const avatarAlpha = Math.min(...avatarLines.map((l, i) => alphasIn(l, `.greeter-avatar-fallback #${i + 1}`)[0]))

const parts = [`scrim ${scrimMax}`, ...heroAlphas.map(a => `shadow ${a}`)].join(" + ")
const ceilingOk = composite < greeterThreshold
console.log(`\nun-blurred paint on the login surfaces (composited): ${parts} = ${composite.toFixed(3)}`)
console.log(`  ${ceilingOk ? "ok  " : "FAIL"}  vs nidara-greeter ignore_alpha ${greeterThreshold}` +
            (ceilingOk ? `  — ${(greeterThreshold - composite).toFixed(3)} of headroom`
                       : `  — AT OR ABOVE IT: the wallpaper behind this paint gets blurred, in a band with a visible edge`))
if (!ceilingOk) bad++

const avatarOk = avatarAlpha >= greeterThreshold
console.log(`\nlogin bodies that are NOT painted with --nidara-glass: .greeter-avatar-fallback = ${avatarAlpha}`)
console.log(`  ${avatarOk ? "ok  " : "FAIL"}  vs nidara-greeter ignore_alpha ${greeterThreshold}` +
            (avatarOk ? `  — clears it on its own`
                      : `  — UNDER IT: nothing frosts behind this body unless another layer carries it`))
if (!avatarOk) bad++

if (bad) {
    console.error(`\nblur-threshold-check: ${bad} problem(s).`)
    console.error("The glass floor, the layer thresholds and the scrim/shadow ceiling are ONE decision:")
    console.error("what we paint thick enough to frost has to stay above the line, and what we paint")
    console.error("over bare wallpaper has to stay under it.")
    process.exit(1)
}
console.log("\nblur-threshold-check: thresholds under the glass floor, un-blurred paint under the thresholds.")

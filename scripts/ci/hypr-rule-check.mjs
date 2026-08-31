#!/usr/bin/env node
// hypr-rule-check — the seam between our windows and Hyprland's matcher, gated.
//
// A window rule is a string in a Lua file matched against a string a GTK window
// announces over Wayland. Nothing in the repo connects the two: rename one and the
// rule simply stops matching. No error, no warning, no crash — the window comes up
// wrong, and only on a real session, which is why every bug this file exists to
// prevent shipped.
//
// ── The mechanism, from Hyprland's own docs (Configuring/Window-Rules) ──────────
//
// Rules have two kinds of EFFECT, and they behave nothing alike:
//
//   STATIC  (float, center, size, move, workspace, monitor, pseudo, suppress_event…)
//           "evaluated once when the window is opened and never again. This
//           essentially means that it is always the initialTitle and initialClass
//           which will be found when matching on title and class."
//
//   DYNAMIC (opacity, rounding, no_blur, no_anim, opaque, idle_inhibit, border_size…)
//           "re-evaluated every time a property changes" — so these see the CURRENT
//           class and title.
//
// ⚠️ AND OUR WINDOWS CHANGE CLASS AFTER THEY OPEN. Every bundle gives its windows
// their real identity through `setWindowAppId` (ui/lib/app-id.ts), and that lands at
// MAP, after the toplevel already exists carrying the PROCESS app-id GTK put on it
// at creation. So each kind of effect has its own trap, and they point OPPOSITE WAYS:
//
//   • A STATIC rule naming a stamped class (`nidara-installer`) never fires at all.
//     The window is simply left tiled — which on an empty workspace is the whole
//     work area, and that is exactly what "the installer opens at monitor size" was.
//     Measured 2026-08-30, minimal GTK4 window, one variable per arm, empty
//     2560x1440 screen, default size 960x760, rule `float + center`:
//
//         app-id from birth ............................  960x760    ok
//         + set_size_request(960,760) .................   960x760    ok
//         rule on the LATE class ......................  2544x1284   the work area
//         same, on a workspace with one other window ..  1272x1284   half the tile
//         rule on an EARLY TITLE ......................   960x760    ok
//         rule on the BIRTH class .....................   960x760    ok
//
//     ⇒ a static rule must name the BIRTH class.
//
//   • A DYNAMIC rule naming a birth class stops applying the moment the window
//     stamps its own id — the mirror of the same trap, and just as silent.
//
//     ⇒ a dynamic rule must name the STAMPED class.
//
//   Naming both always satisfies both, which is what the messages below ask for.
//
// ── Why a gate and not a comment ───────────────────────────────────────────────
//
// Both traps were written down — in hyprland.lua's own comments, in ui/lib/app-id.ts
// and in the skill — and the prose still had the shell's birth class WRONG
// (`org.nidara.shell`; it is `org.nidara.desktop`, ui/shell/app.ts). Anyone fixing a
// rule by copying that sentence would have named a process that does not exist, and
// the rule would have gone on not matching, silently. So this check takes NO list
// from prose: birth ids come out of each bundle's `app.ts`, stamped classes out of
// the calls that stamp them, and titles out of the windows that set them. A rule
// naming something nothing declares is a failure on its own terms.
//
// That last one is what protects the title match `float-about` needs: wrap that
// title in `t()` — the obvious, well-meant i18n change — and the literal is gone from
// the source, so the rule matches nothing and this check says so. A file-level "does
// this file use t()?" test was tried first and removed: a dialog translating ITS title
// in the same file would have failed a window whose own title is still a literal.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

// Argument form is for proving this check can FAIL: point it at a candidate file.
// With no arguments it gates what we ship, which is what CI runs.
const LUA_CONFIGS = process.argv.length > 2 ? process.argv.slice(2) : [
    "config/hypr/hyprland.lua",
    // No window rules today. Listed so the greeter's session is gated the day it
    // grows one — a config checked only once it misbehaves is not checked.
    "config/greetd/hyprland-greeter.lua",
]

// Hyprland's own split, transcribed. Anything not named here is treated as dynamic,
// which is the safe direction: it asks a rule for the stamped class, and naming both
// classes is never wrong.
const STATIC_EFFECTS = new Set([
    "float", "tile", "fullscreen", "maximize", "fullscreen_state", "move", "size",
    "center", "pseudo", "monitor", "workspace", "no_initial_focus", "pin", "group",
    "suppress_event", "content", "no_close_for", "scrolling_width",
])

let bad = 0
const fail = (msg) => { bad++; console.error(`  FAIL  ${msg}`) }

// ── What the source says our identifiers are ────────────────────────────────────

// BIRTH: the process app-id GTK stamps on the toplevel at creation. This is what a
// STATIC rule is matched against, always.
const BIRTH = new Map()   // app-id → bundle
for (const bundle of ["shell", "greeter", "lockscreen", "installer"]) {
    const entry = `ui/${bundle}/app.ts`
    if (!existsSync(entry)) continue
    const m = readFileSync(entry, "utf8").match(/applicationId:\s*"([^"]+)"/)
    if (!m) { fail(`${entry}: no \`applicationId: "…"\` — the bundle's birth class cannot be derived`); continue }
    BIRTH.set(m[1], bundle)
}

// STAMPED: the per-toplevel override applied at MAP, and the TITLES those windows
// are born with. Only files that actually build a window are read — `appId:` is also
// the dock's word for a dock slot, and a dock slot is not a window.
const STAMPED = new Map()   // class → Set of bundles ("lib" = a kit default, unattributable)
const TITLES  = new Map()   // title literal → file that sets it
for (const file of walk("ui")) {
    if (!/\.tsx?$/.test(file)) continue
    const src = readFileSync(file, "utf8")
    if (!/setWindowAppId|NidaraWindow/.test(src)) continue
    if (file === "ui/lib/app-id.ts") continue   // the mechanism itself, not a caller
    const bundle = file.startsWith("ui/lib/") ? "lib" : file.split("/")[1]
    for (const re of [/setWindowAppId\([^)]*?"([^"]+)"/g, /\bappId:\s*"([^"]+)"/g])
        for (const m of src.matchAll(re)) {
            if (!STAMPED.has(m[1])) STAMPED.set(m[1], new Set())
            STAMPED.get(m[1]).add(bundle)
        }
    for (const re of [/\btitle:\s*"([^"]*)"/g, /\.set_title\("([^"]*)"\)/g])
        for (const m of src.matchAll(re)) TITLES.set(m[1], file)
}

// ── Reading the rules out of the Lua ───────────────────────────────────────────

// Brace matching, not a regex: a rule's `match = { … }` closes a brace in the middle
// of the call, so anything trying to span `hl.window_rule({ … })` in one pattern
// stops at the wrong place. Lua `"…"`/`'…'` strings and `--` line comments are
// skipped so a brace inside either cannot move the count. (No rule uses a
// `[[long string]]`; if one ever does the braces stop balancing and this reports a
// parse failure rather than a confident wrong answer.)
function block(src, open) {
    let depth = 0
    for (let i = open; i < src.length; i++) {
        const c = src[i]
        if (c === '"' || c === "'") {
            const q = c
            for (i++; i < src.length && src[i] !== q; i++) if (src[i] === "\\") i++
            continue
        }
        if (c === "-" && src[i + 1] === "-") { while (i < src.length && src[i] !== "\n") i++; continue }
        if (c === "{") depth++
        else if (c === "}" && --depth === 0) return src.slice(open, i + 1)
    }
    return null
}

function rulesIn(src, file) {
    const out = []
    for (const m of src.matchAll(/hl\.window_rule\s*\(\s*(?=\{)/g)) {
        const body = block(src, m.index + m[0].length)
        if (body === null) { fail(`${file}: unbalanced \`hl.window_rule(\` at offset ${m.index}`); continue }
        const line = src.slice(0, m.index).split("\n").length
        const mm    = body.match(/match\s*=\s*(?=\{)/)
        const match = mm ? block(body, mm.index + mm[0].length) : "{}"
        // Effects are the rule's own keys minus `name` and `match`; the match block is
        // cut out first so its props are not counted as effects.
        const effects = [...body.replace(match, "").matchAll(/(\w+)\s*=/g)]
            .map(e => e[1]).filter(k => k !== "name" && k !== "match")
        out.push({
            file, line, effects,
            name:  (body.match(/name\s*=\s*"([^"]*)"/)  || [, `<unnamed at ${file}:${line}>`])[1],
            class: (match.match(/\bclass\s*=\s*"([^"]*)"/) || [])[1],
            title: (match.match(/\btitle\s*=\s*"([^"]*)"/) || [])[1],
        })
    }
    return out
}

// `"^(org\\.nidara\\.installer|nidara-installer)$"` as it sits in the Lua is two
// unescapings away from the two names a human means: Lua's (`\\` → `\`) then the
// regex's (`\.` → `.`). A pattern that is not a plain alternation of literals (`.*`,
// `^steam_app_`) yields alternatives matching nothing we own — the right answer, as
// those rules are about somebody else's windows.
const luaUnescape = (s) => s.replace(/\\\\/g, "\\")
function alternatives(pattern) {
    let p = luaUnescape(pattern).replace(/^\^/, "").replace(/\$$/, "")
    const wrapped = p.match(/^\((.*)\)$/)
    if (wrapped) p = wrapped[1]
    return p.split("|").map(s => s.replace(/\\(.)/g, "$1"))
}

// ── The gate ───────────────────────────────────────────────────────────────────

console.log("birth classes — what a STATIC rule is matched against, always:")
for (const [id, bundle] of BIRTH) console.log(`  ${id.padEnd(24)} ui/${bundle}/app.ts`)
console.log("\nstamped classes — applied at MAP, so a static rule never sees them:")
for (const [cls, from] of [...STAMPED].sort()) console.log(`  ${cls.padEnd(24)} ${[...from].sort().join(", ")}`)

const rules = LUA_CONFIGS.filter(existsSync).flatMap(f => rulesIn(readFileSync(f, "utf8"), f))
console.log(`\n${rules.length} window rule(s):`)

for (const r of rules) {
    const where  = `${r.file}:${r.line}`
    const alts   = r.class === undefined ? [] : alternatives(r.class)
    const statics = r.effects.filter(e => STATIC_EFFECTS.has(e))
    const dynamics = r.effects.filter(e => !STATIC_EFFECTS.has(e))
    const notes  = []

    // A name shaped like ours that nothing in the source declares is a rule matching
    // nothing — exactly how `org.nidara.shell` would have entered.
    for (const a of alts) {
        if (/^org\.nidara\./.test(a) && !BIRTH.has(a))
            fail(`${r.name} (${where}) names \`${a}\`, which no bundle declares.\n` +
                 `        The birth classes that exist: ${[...BIRTH.keys()].join(", ")}`)
        if (/^nidara-/.test(a) && !STAMPED.has(a))
            fail(`${r.name} (${where}) names \`${a}\`, which no window in ui/ stamps.\n` +
                 `        The stamped classes that exist: ${[...STAMPED.keys()].join(", ")}`)
    }

    const stampedAlts = alts.filter(a => STAMPED.has(a))
    const birthAlts   = alts.filter(a => BIRTH.has(a))

    // A static effect is matched against initialClass. Name the birth class or the
    // rule is inert.
    if (statics.length && stampedAlts.length) {
        const bundles  = new Set(stampedAlts.flatMap(a => [...STAMPED.get(a)]).filter(b => b !== "lib"))
        // Attributable to a bundle → that bundle's birth class, by name. Stamped only
        // from ui/lib (a kit default any bundle can reach) → any birth class will do,
        // because the kit does not know which process is calling it.
        const required = [...BIRTH].filter(([, b]) => bundles.has(b)).map(([id]) => id)
        const missing  = required.length ? required.filter(id => !alts.includes(id))
                                         : (birthAlts.length ? [] : ["<any birth class>"])
        if (missing.length)
            fail(`${r.name} (${where}) applies the STATIC effect(s) ${statics.join(", ")} to ` +
                 `${stampedAlts.map(s => `\`${s}\``).join(", ")}, but does not name ` +
                 `${missing.map(s => `\`${s}\``).join(", ")}.\n` +
                 `        A static effect is matched ONCE at open, against initialClass. That class is\n` +
                 `        stamped at MAP, so this rule never fires and the window is left tiled — the\n` +
                 `        whole work area on an empty workspace. Put the birth class in the alternation.`)
        else notes.push(`static via ${birthAlts.join(", ") || "a birth class"}; ${stampedAlts.join(", ")} inert here`)
    }

    // The mirror: a dynamic effect is re-evaluated against the CURRENT class, which
    // our windows change at MAP.
    if (dynamics.length && birthAlts.length) {
        const stampers = [...STAMPED].filter(([, from]) => [...from].some(b => b === "lib" || BIRTH.get(birthAlts[0]) === b))
        const missing  = stampers.map(([c]) => c).filter(c => !alts.includes(c))
        if (missing.length)
            fail(`${r.name} (${where}) applies the DYNAMIC effect(s) ${dynamics.join(", ")} to ` +
                 `${birthAlts.map(s => `\`${s}\``).join(", ")}, but does not name ` +
                 `${missing.map(s => `\`${s}\``).join(", ")}.\n` +
                 `        A dynamic effect is re-evaluated against the CURRENT class, and that window\n` +
                 `        replaces its birth class at MAP — so this stops applying the moment the\n` +
                 `        window is up. Name both classes; naming both is never wrong.`)
        else if (dynamics.length) notes.push(`dynamic via ${alts.filter(a => STAMPED.has(a)).join(", ") || "the current class"}`)
    }

    // Titles. `^$` is not interface text at all — "this toplevel has no title" is a
    // structural fact about a popup, which is what the xwayland-drag and steam-popup
    // rules use it for. Anything else has to be one of OUR windows' birth titles.
    if (r.title !== undefined && r.title !== "^$") {
        const pattern = luaUnescape(r.title)
        if (dynamics.length)
            fail(`${r.name} (${where}) matches a TITLE and applies the DYNAMIC effect(s) ` +
                 `${dynamics.join(", ")}.\n` +
                 `        A dynamic effect re-reads the LIVE title, which follows the window's content\n` +
                 `        and gets translated. Match an identifier instead.`)
        let re = null
        try { re = new RegExp(pattern) } catch { fail(`${r.name} (${where}): title ${JSON.stringify(pattern)} is not a usable regex`) }
        const hit = re && [...TITLES].find(([t]) => re.test(t))
        if (re && !hit)
            fail(`${r.name} (${where}) matches the title ${JSON.stringify(pattern)}, which no window in ui/ sets.\n` +
                 `        Titles our windows are born with: ${[...TITLES.keys()].map(t => JSON.stringify(t)).join(", ")}\n` +
                 `        A static effect can be keyed on a birth title — it is a code literal on the\n` +
                 `        toplevel from creation, and for two windows of ONE process it is the only\n` +
                 `        thing that tells them apart. But then the rule and the literal have to agree.\n` +
                 `        The likeliest cause is i18n: wrapping that title in \`t()\` is a well-meant change\n` +
                 `        that leaves the rule matching nothing in every locale, English included. There is\n` +
                 `        no fix on the rule's side — a rule cannot follow a string that changes with the\n` +
                 `        locale — so a window a rule keys on has to keep an untranslated birth title.`)
        if (hit) notes.push(`birth title, set in ${hit[1]}`)
    }

    const shown = [r.class !== undefined && `class=${JSON.stringify(luaUnescape(r.class))}`,
                   r.title !== undefined && `title=${JSON.stringify(luaUnescape(r.title))}`].filter(Boolean).join(" ")
    console.log(`  ${r.name.padEnd(26)} ${shown}`)
    for (const n of notes) console.log(`  ${"".padEnd(26)}   ↳ ${n}`)
}

if (bad) {
    console.error(`\nhypr-rule-check: ${bad} problem(s).`)
    console.error("A window rule and the window it matches are one decision written in two languages,")
    console.error("and nothing but this reports when they stop agreeing. See")
    console.error(".claude/skills/nidara/references/dev-workflow.md → \"A window rule matches an")
    console.error("IDENTIFIER, and a static rule only ever sees the one the window was BORN with\".")
    process.exit(1)
}
console.log("\nhypr-rule-check: every rule names something the source declares, static rules name the")
console.log("birth class, dynamic rules name the stamped one, and every matched title is a literal we set.")

function walk(dir) {
    const out = []
    for (const e of readdirSync(dir)) {
        if (e === "node_modules" || e === "@girs" || e === "build") continue
        const p = join(dir, e)
        if (statSync(p).isDirectory()) out.push(...walk(p))
        else out.push(p)
    }
    return out
}

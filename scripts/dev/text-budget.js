#!/usr/bin/env gjs -m
/*
 * text-budget — does every shipped locale still FIT, at every text scale?
 *
 *   gjs -m scripts/dev/text-budget.js
 *   gjs -m scripts/dev/text-budget.js --scales 1.0,1.25,1.5
 *   gjs -m scripts/dev/text-budget.js --verify        # cross-check against a live session
 *
 * ── The bug this exists to catch ─────────────────────────────────────────────
 *
 * Settings' sidebar is a FIXED 250px column. Its label carries no font-size rule,
 * so it grows with the interface font, and its scroll view is
 * `hscrollbar_policy: NEVER` — a string too long for the column does not scroll,
 * it pushes. On 2026-08-11 the Russian "Специальные возможности" was found needing
 * 204px against a 176px budget **at the default text size, in a published
 * version**. Nobody saw it by looking: 18 pages × 12 locales × N text scales is
 * not a surface a human walks. It came out of a subtraction.
 *
 * So this is that subtraction, mechanised. It is deliberately NOT a live driver:
 * the locale comes from `$LANG` at shell startup (`core/i18n/detectLanguage`), so
 * sweeping 12 locales live would mean 12 shell restarts. Instead it builds real
 * GTK labels, with the real compiled stylesheet at the real provider priority and
 * the machine's real interface font, and asks GTK for each string's natural width.
 * No shell, no window, no display of its own — which is what lets it be a CI gate
 * rather than a thing someone remembers to run.
 *
 * ⚠️ It PINS the shipped default font ("Inter 11", seeded by `core/ThemeManager`
 * on first boot) rather than measuring with whatever this machine happens to use,
 * because the budget is a property of the product, not of the developer's box.
 * This host, for one, runs "Inter Variable Medium 11" by explicit user choice, and
 * Medium is materially wider than Regular — measuring with it overstates every
 * string. `--font` overrides for one-off questions ("what if we shipped X?").
 *
 * ⚠️ And it REFUSES to run if the pinned family is not installed. fontconfig
 * substitutes silently, so an unavailable font does not error — it just quietly
 * measures something else and returns a number that looks fine. That is the exact
 * failure mode this instrument exists to eliminate, so it must not have it itself.
 *
 * ── What "scale" means here ──────────────────────────────────────────────────
 *
 * The accessibility slider writes `text-scaling-factor` (GSettings), which GTK
 * turns into `gtk-xft-dpi = 96 · 1024 · factor`. That is what is emulated, so the
 * numbers are the ones the slider really produces. `TEXT_SCALE_MAX` (1.5, in
 * `core/ThemeManager.ts`) is the top of the range the reflowing windows survive
 * and therefore the top of the sweep.
 *
 * ⚠️ A `Gtk.Settings` change does NOT take effect until the main context is
 * pumped. Without that the sweep silently measures every scale at 1.0 and passes:
 * the first version of this script printed four identical numbers for four
 * different scales and looked perfectly healthy.
 *
 * ── What a breach MEANS, and why the gate is only the default size ───────────
 *
 * The sidebar label ellipsises (that is what stops it pushing the capsule), so a
 * breach is not a broken layout — it is a page name the user cannot read in full.
 * That makes the honest rule a product rule, not a geometric one:
 *
 *   at scale 1.0  — the default install — no page name may be truncated. FAILS.
 *   above 1.0     — the accessibility slider is a deliberate trade of room for
 *                   legibility; ellipsis there is graceful degradation. REPORTED.
 *
 * `--fail-at` moves that line if the policy ever changes. The reporting half is
 * not decoration: it is how you see that Japanese goes at 1.25 and English itself
 * at 1.39, which is the difference between "one locale is long" and "this column
 * is too narrow for the job".
 *
 * Exit 1 on any breach at or below `--fail-at`.
 */
import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import system from "system"

const REPO = GLib.getenv("NIDARA_REPO") || GLib.get_current_dir()
const argv = ARGV
const argOf = (flag, fallback) => {
    const i = argv.indexOf(flag)
    return i > -1 && argv[i + 1] ? argv[i + 1] : fallback
}
const VERIFY = argv.includes("--verify")

const read = (path) => {
    const [ok, bytes] = GLib.file_get_contents(path)
    if (!ok) { printerr(`cannot read ${path}`); system.exit(2) }
    return new TextDecoder().decode(bytes)
}

// ── Inputs, all DERIVED from their single source ─────────────────────────────
// Nothing below is a number typed twice. A checker carrying its own copy of the
// layout passes happily after someone changes the layout.

/** `WINDOW_LAYOUT.sidebar` — the fixed column, from the law itself. */
const tokensSrc = read(`${REPO}/ui/lib/tokens.ts`)
const sidebarWidth = Number(tokensSrc.match(/\n\s*sidebar:\s*(\d+)/)?.[1])
if (!sidebarWidth) { printerr("could not read WINDOW_LAYOUT.sidebar from ui/lib/tokens.ts"); system.exit(2) }

/**
 * The widget-side chrome around the label, read out of the component that builds
 * it: the item box's `margin_start` + `margin_end`, its `spacing`, and the leading
 * icon's `pixel_size`.
 */
const sidebarSrc = read(`${REPO}/ui/lib/nidara-kit/sidebar.ts`)
const num = (re, what) => {
    const m = sidebarSrc.match(re)
    if (!m) { printerr(`could not read ${what} from ui/lib/nidara-kit/sidebar.ts`); system.exit(2) }
    return Number(m[1])
}
const itemMargins = num(/margin_start:\s*(\d+),\s*margin_end:\s*(\d+)/, "the item box margins") * 2
const itemSpacing = num(/const content = new Gtk\.Box\(\{[\s\S]{0,80}?spacing:\s*(\d+)/, "the item box spacing")
const iconSize    = num(/new Gtk\.Image\(\{\s*pixel_size:\s*(\d+)/, "the leading icon size")

/**
 * The CSS-side chrome. Not derivable the same way — it is spread over three rules
 * in two stylesheets plus the THEME, so it is measured rather than read:
 *
 *   `.nidara-sidebar-capsule { margin: 8px 0 8px 8px }`   →  8  (_settings.scss)
 *   `@include material-card`'s 1px border, both sides     →  2  (_mixins.scss)
 *   `.nidara-sidebar         { padding: 6px }`            → 12  (_components.scss)
 *   Adwaita's `list > row { padding: 2px }`, both sides    →  4  (the THEME)
 *
 * ⚠️ The last two terms are why `--verify` exists, and it earned its keep the day
 * it was written: `sidebar.ts` documented this budget as 176px and the real
 * allocation measured **170px**. The comment had missed the capsule's borders and
 * that stray theme padding — the very 2px `.nidara-row` exists to clear, which the
 * sidebar's bare `Gtk.ListBoxRow`s never opted out of. Six pixels the sidebar
 * never had, in the one place already known to be one string over budget.
 */
const CSS_CHROME = 8 + 2 + 12 + 4

const BUDGET = sidebarWidth - (CSS_CHROME + itemMargins + itemSpacing + iconSize)

/** The sidebar's strings ARE the `categories` labels in Settings.tsx, in order. */
const settingsSrc = read(`${REPO}/ui/shell/surfaces/settings/Settings.tsx`)
const SIDEBAR_KEYS = [...settingsSrc.matchAll(/\{\s*id:\s*"[^"]+",\s*label:\s*t\("([^"]+)"\)/g)].map(m => m[1])
if (SIDEBAR_KEYS.length < 10) {
    printerr(`parsed only ${SIDEBAR_KEYS.length} sidebar labels from Settings.tsx — the categories array moved, fix the parse`)
    system.exit(2)
}

// ── The locales ──────────────────────────────────────────────────────────────
// Flat `"key": "value"` maps. Parsed rather than imported because they are
// TypeScript modules and this is gjs; the parse is asserted below so a format
// change cannot quietly turn this into a no-op.
const LOCALE_DIR = `${REPO}/ui/shell/core/i18n/locales`
const localeNames = []
{
    const dir = Gio.File.new_for_path(LOCALE_DIR)
    const en = dir.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null)
    let info
    while ((info = en.next_file(null)) !== null) {
        const n = info.get_name()
        if (n.endsWith(".ts")) localeNames.push(n.slice(0, -3))
    }
    localeNames.sort()
}

const parseLocale = (name) => {
    const src = read(`${LOCALE_DIR}/${name}.ts`)
    const map = {}
    // Key and value are both double-quoted; a value may contain \" and \n.
    for (const m of src.matchAll(/"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
        map[m[1]] = m[2].replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\")
    }
    return map
}

const LOCALES = {}
for (const name of localeNames) LOCALES[name] = parseLocale(name)
if (!LOCALES.en) { printerr("no en.ts — that is the canonical key source"); system.exit(2) }
for (const [name, map] of Object.entries(LOCALES)) {
    const n = Object.keys(map).length
    // en.ts has ~700 keys; a parse that collapses to a handful is the failure mode
    // that would make this whole sweep a green no-op.
    if (n < 50) { printerr(`locale ${name}: parsed only ${n} keys — the parse broke, not the locale`); system.exit(2) }
}

/** What `t()` really renders: the locale's string, falling back to English. */
const stringFor = (locale, key) => LOCALES[locale][key] ?? LOCALES.en[key] ?? key

// ── The measuring rig ────────────────────────────────────────────────────────
Gtk.init()
const display = Gdk.Display.get_default()
if (!display) {
    printerr("no GDK display — run inside a session, or under a headless backend (GDK_BACKEND=broadway with gtk4-broadwayd)")
    system.exit(2)
}

const STYLE = GLib.getenv("CSS") || `${REPO}/ui/shell/style.css`
if (!GLib.file_test(STYLE, GLib.FileTest.EXISTS)) {
    printerr(`no compiled stylesheet at ${STYLE} — run \`npm run build\` in ui/shell first`)
    system.exit(2)
}
{
    // Same ladder as core/ThemeManager.ts: style.css at PRIORITY_USER + 10.
    const p = new Gtk.CssProvider()
    p.load_from_path(STYLE)
    Gtk.StyleContext.add_provider_for_display(display, p, Gtk.STYLE_PROVIDER_PRIORITY_USER + 10)
}

const settings = Gtk.Settings.get_default()
const HOST_FONT = settings.gtk_font_name

/**
 * The font a fresh install actually gets, read from the line that seeds it, so a
 * change to the shipped default moves this gate with it instead of leaving it
 * measuring a font nobody runs.
 */
const themeSrc = read(`${REPO}/ui/shell/core/ThemeManager.ts`)
const SHIPPED_FONT = themeSrc.match(/set_string\("font-name",\s*"([^"]+)"\)/)?.[1]
if (!SHIPPED_FONT) { printerr("could not read the seeded default font from core/ThemeManager.ts"); system.exit(2) }
const FONT = argOf("--font", SHIPPED_FONT)

// Refuse a silent substitution. Pango resolves any description to SOMETHING, so
// the only way to know the family is real is to look for it in the font map.
{
    const family = FONT.replace(/\s+[\d.]+\s*(@.*)?$/, "").trim()
    const ctx = new Gtk.Label().get_pango_context()
    const known = ctx.list_families().map(f => f.get_name().toLowerCase())
    if (!known.includes(family.toLowerCase())) {
        printerr(`font family "${family}" is not installed — fontconfig would substitute it SILENTLY and every`)
        printerr(`number below would be measured against a different typeface. Install it, or pass --font.`)
        system.exit(2)
    }
}
settings.gtk_font_name = FONT

const pump = () => {
    const ctx = GLib.MainContext.default()
    let guard = 0
    while (ctx.pending() && guard++ < 1000) ctx.iteration(false)
}
const setScale = (factor) => {
    // The accessibility slider's real path: text-scaling-factor → gtk-xft-dpi.
    settings.gtk_xft_dpi = Math.round(96 * 1024 * factor)
    pump()
}

/**
 * A label's natural width, in the window scope it really lives in.
 *
 * ⚠️ The scope is not cosmetic. Our sheets are scoped per window, so a specimen
 * built in the wrong one matches nothing and every measurement comes back as if
 * the widget were unstyled — with no error, just a slightly bigger number. Same
 * trap `gtk-probe.js` documents.
 */
const measure = (text, cssClasses, scopeName = "nidara-settings-window") => {
    const win = new Gtk.Window({ name: scopeName, css_classes: [scopeName] })
    const box = new Gtk.Box()
    win.set_child(box)
    const label = new Gtk.Label({ label: text, css_classes: cssClasses })
    box.append(label)
    const [, nat] = label.measure(Gtk.Orientation.HORIZONTAL, -1)
    return nat
}

// ── The slots ────────────────────────────────────────────────────────────────
// A slot is a text box whose width is a CONSTANT — the case where "the text scales
// and the box does not" (tech-debt #62) actually bites. A row title inside the
// 800px pane is NOT one of these: its budget is whatever the trailing control
// leaves, which is itself localised. See the note at the bottom of this file.
const SLOTS = [
    {
        name: "Settings sidebar label",
        classes: ["nidara-sidebar-label"],
        budget: BUDGET,
        keys: SIDEBAR_KEYS,
        why: `${sidebarWidth}px column − ${CSS_CHROME} css − ${itemMargins} margins − ${itemSpacing} spacing − ${iconSize} icon`,
    },
]

const SCALES = argOf("--scales", "1.0,1.25,1.5").split(",").map(Number)
const ONLY = argOf("--locales", "").split(",").filter(Boolean)
const locales = ONLY.length ? ONLY : localeNames
/** Scales at or below this one FAIL; above it, breaches are reported only. */
const FAIL_AT = Number(argOf("--fail-at", "1.0"))

// ── Sweep ────────────────────────────────────────────────────────────────────
print(`font       ${FONT}   (shipped default; this host runs ${HOST_FONT})`)
print(`stylesheet ${STYLE}`)
print(`locales    ${locales.join(" ")}`)
print(`scales     ${SCALES.join(" ")}`)
print("")

print(`gate       scales ≤ ${FAIL_AT.toFixed(2)} fail; above that, truncation is reported as degradation`)
print("")

const breaches = []
const reported = []

for (const slot of SLOTS) {
    print(`── ${slot.name} — budget ${slot.budget}px (${slot.why})`)
    for (const scale of SCALES) {
        setScale(scale)
        // Worst string per locale at this scale.
        const worst = []
        for (const locale of locales) {
            let top = { w: -1 }
            for (const key of slot.keys) {
                const text = stringFor(locale, key)
                const w = measure(text, slot.classes)
                if (w > top.w) top = { w, text, key }
            }
            worst.push({ locale, ...top })
            if (top.w > slot.budget) {
                const hit = { slot: slot.name, scale, locale, ...top, budget: slot.budget }
                ;(scale <= FAIL_AT ? breaches : reported).push(hit)
            }
        }
        worst.sort((a, b) => b.w - a.w)
        const over = worst.filter(w => w.w > slot.budget)
        const head = worst[0]
        print(
            `   scale ${scale.toFixed(2)}  worst ${head.locale} ${String(head.w).padStart(4)}px "${head.text}"` +
            `  —  over budget: ${over.length ? over.map(o => `${o.locale}(${o.w})`).join(" ") : "none"}`,
        )
    }
    print("")
}

setScale(1.0)

// ── Optional cross-check against a running session ───────────────────────────
// The two CSS terms in the budget are the only numbers here not read from source.
// This proves them against the real thing rather than trusting the comment.
if (VERIFY) {
    let out = ""
    try {
        const [ok, stdout] = GLib.spawn_command_line_sync("ags request queryUI .nidara-sidebar-label")
        if (ok && stdout) out = new TextDecoder().decode(stdout)
    } catch (e) { out = "" }
    const nodes = (() => { try { return JSON.parse(out).nodes || [] } catch { return [] } })()
    const live = nodes.filter(n => n.window === "nidara-settings-window" && n.mapped && n.bounds?.w > 0)
    if (live.length === 0) {
        print("--verify: no live Settings window (open it with `ags request openSettings`) — budget NOT cross-checked")
    } else {
        const allocated = Math.max(...live.map(n => n.bounds.w))
        const delta = allocated - BUDGET
        print(`--verify: live label allocation ${allocated}px vs computed budget ${BUDGET}px (Δ ${delta})`)
        if (Math.abs(delta) > 2) {
            breaches.push({
                slot: "budget derivation", scale: 1, locale: "-", text: "-",
                w: allocated, budget: BUDGET,
                note: "the computed budget no longer matches the real allocation — CSS_CHROME in this script is stale",
            })
        }
    }
    print("")
}

const line = (b) =>
    `${b.slot}: ${b.locale} at scale ${b.scale} needs ${b.w}px of ${b.budget}px` +
    (b.text && b.text !== "-" ? `  "${b.text}" (${b.key})` : "") +
    (b.note ? `  ${b.note}` : "")

// Degradation above the gate: grouped by the scale it first appears at, because
// "which locale is long" matters far less than "how much headroom the column has".
if (reported.length > 0) {
    const firstBreach = new Map()
    for (const r of [...reported].sort((a, b) => a.scale - b.scale))
        if (!firstBreach.has(r.locale)) firstBreach.set(r.locale, r)
    print("DEGRADES — truncated above the gate, in the order the column runs out:")
    for (const r of [...firstBreach.values()].sort((a, b) => a.scale - b.scale || b.w - a.w))
        print(`   from scale ${r.scale}  ${r.locale}  ${r.w}px  "${r.text}"`)
    print("")
}

if (breaches.length === 0) {
    print(`PASS — no string in ${locales.length} locales is truncated at scale ≤ ${FAIL_AT.toFixed(2)}.`)
    system.exit(0)
}
for (const b of breaches) printerr(`FAIL — ${line(b)}`)
system.exit(1)

/*
 * ── What this does NOT cover, and why ────────────────────────────────────────
 *
 * ROW TITLES inside the 800px pane. They ellipsise rather than push, so they do
 * not break the layout — they lose information silently, which is a real defect
 * but a different one. Their budget is not a constant either: it is the row's
 * 688px content minus the leading icon minus the TRAILING CONTROL, and that
 * control is often a button whose own label is localised, so the budget moves with
 * the locale being tested. Covering them honestly needs the allocated widths
 * harvested from a live session per locale, which is the live half of tech-debt
 * #64 — not this half.
 */

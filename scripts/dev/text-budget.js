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
 *   `.nidara-sidebar > row   { padding: 0 }`              →  0  (_components.scss)
 */
const CSS_CHROME = 8 + 2 + 12 + 0

const BUDGET = sidebarWidth - (CSS_CHROME + itemMargins + itemSpacing + iconSize)

// ── The Control Centre's two fixed-width text boxes ───────────────────────────
// Same discipline as above: every number below is READ from the file that owns it.
// These two surfaces were outside this gate until 2026-09-07, and both were already
// broken in shipped locales — the tile title in six languages, the status banner in
// seven. The instrument existed and measured one column.

const ccSrc     = read(`${REPO}/ui/shell/surfaces/control-center/CCLayoutManager.ts`)
const islandSrc = read(`${REPO}/ui/shell/surfaces/control-center/BaseIsland.tsx`)
const tileSrc   = read(`${REPO}/ui/shell/common/widget-kit/tile.ts`)
const statusSrc = read(`${REPO}/ui/shell/surfaces/bar/StatusIndicators.tsx`)

const from = (src, re, what) => {
    const m = src.match(re)
    if (!m) { printerr(`could not read ${what}`); system.exit(2) }
    return m
}

const UNIT      = Number(from(ccSrc, /export const UNIT\s*=\s*(\d+)/, "UNIT from CCLayoutManager.ts")[1])
const GAP       = Number(from(ccSrc, /export const GAP\s*=\s*(\d+)/, "GAP from CCLayoutManager.ts")[1])
const GRID_COLS = Number(from(ccSrc, /export const GRID_COLS\s*=\s*(\d+)/, "GRID_COLS from CCLayoutManager.ts")[1])
/** The island's padding for every size but TALL — the branch a capsule takes. */
const ISLAND_PAD = Number(from(islandSrc, /return size === WidgetSize\.TALL \? \d+ : (\d+)/, "islandPadding from BaseIsland.tsx")[1])
/** margin_start + icon circle + spacing, summed in the kit itself. */
const CAPSULE_CHROME = from(tileSrc, /const CAPSULE_CHROME = ([\d\s+]+)\n/, "CAPSULE_CHROME from widget-kit/tile.ts")[1]
    .split("+").map(n => Number(n.trim())).reduce((a, b) => a + b, 0)

/** A 2×1 tile's title column: the tile span, minus the island's padding, minus the
 *  capsule's own chrome. Confirmed against a live session on 2026-09-07 (queryUI:
 *  island x=2380 w=172, icon x=2396 w=48, label x=2456 → 84px). */
const TILE_COLUMN = (2 * UNIT + GAP) - 2 * ISLAND_PAD - CAPSULE_CHROME

const GRID_WIDTH   = GRID_COLS * UNIT + (GRID_COLS - 1) * GAP
const BANNER_PAD   = Number(from(statusSrc, /const BANNER_PADDING = (\d+)/, "BANNER_PADDING from StatusIndicators.tsx")[1])
const BANNER_DOT   = Number(from(statusSrc, /css_classes: s === "active".*?\n\s*width_request:\s*(\d+)/s, "the banner dot width")[1])
const BANNER_SPACE = Number(from(statusSrc, /const row = new Gtk\.Box\(\{ spacing:\s*(\d+)/, "the banner row spacing")[1])
/** Everything in the row that is NOT the text column and NOT the button: the
 *  painter's padding both sides, the dot, and the two gaps around the text. */
const BANNER_CHROME = 2 * BANNER_PAD + BANNER_DOT + 2 * BANNER_SPACE

/**
 * The sidebar's strings are the top-level pages of `manifest.ts`, in order — the
 * same list `Settings.tsx` derives its categories from since P3 (#341). It used to
 * parse the `categories` array in `Settings.tsx`; when that array moved, this parse
 * returned zero and the script exited 2 rather than measuring nothing and passing.
 * That refusal is the point: keep the assertion below whatever the source becomes.
 * A page with a `parent` is a subpage and never reaches the sidebar.
 */
const manifestSrc = read(`${REPO}/ui/shell/surfaces/settings/manifest.ts`)
const SIDEBAR_KEYS = manifestSrc
    .split(/\n    \{\n/)
    .filter(block => /^\s*id:\s*"/.test(block) && !/^\s*parent:\s*"/m.test(block))
    .map(block => block.match(/^\s*label:\s*"([^"]+)"/m)?.[1])
    .filter(Boolean)
if (SIDEBAR_KEYS.length < 15) {
    printerr(`parsed only ${SIDEBAR_KEYS.length} sidebar labels from manifest.ts — the page list moved, fix the parse`)
    system.exit(2)
}

// ── The Control Centre's tile titles, derived from the widgets themselves ────
//
// A tile title is not a list in a manifest: it is the second argument of whichever
// capsule maker the widget calls. So the parse follows the call, the way the sidebar
// parse follows `manifest.ts` — and asserts, so a refactor that moves these makes the
// gate exit 2 instead of measuring nothing.
//
// What matters per title is WHICH BRANCH it can reach. `makeCapsuleInner` gives a
// subtitle-less capsule two lines for its title, and a wrapping label's minimum is
// its longest unbreakable word — so a one-word name too wide for the column pushes
// the tile out of the panel. A title that always has a subtitle stays on one line and
// can only ellipsize. Two different failures, two different verdicts below.
const WIDGET_DIR = `${REPO}/ui/shell/widgets`
/** maker → index of the title argument and of the subtitle argument. */
const MAKERS = {
    makeCapsuleTile:      { title: 1, sub: 2 },
    makeSplitCapsuleTile: { title: 1, sub: 2 },
    makeCapsuleInner:     { title: 1, sub: 2 },
    roundToggleSpec:      { title: 1, sub: 5 },
}

/** The argument list of `name(` starting at `from`, split at top-level commas. */
const callArgs = (src, from) => {
    let i = src.indexOf("(", from)
    if (i < 0) return null
    let depth = 0, start = i + 1, quote = null, args = [], j = i
    for (; j < src.length; j++) {
        const c = src[j]
        if (quote) { if (c === "\\") j++; else if (c === quote) quote = null; continue }
        if (c === '"' || c === "'" || c === "`") { quote = c; continue }
        if (c === "(" || c === "[" || c === "{") depth++
        else if (c === ")" || c === "]" || c === "}") {
            depth--
            if (depth === 0) { args.push(src.slice(start, j)); return args }
        }
        else if (c === "," && depth === 1) { args.push(src.slice(start, j)); start = j + 1 }
    }
    return null
}

/** The body of `const NAME = …`, scanned rather than matched: a one-line arrow ends at
 *  its newline, a braced one at its matching brace. A regex terminator ("up to the next
 *  const") stops at the first nested `}` and hands back HALF a getter — and half a getter
 *  has no `""` in it, so a title that can wrap gets filed as one that never does. */
const constBody = (src, name) => {
    const decl = src.match(new RegExp(`(?:^|\\n)\\s*(?:const|let)\\s+${name}\\s*=`))
    if (!decl) return null
    let i = decl.index + decl[0].length
    const start = i
    let depth = 0, quote = null
    for (; i < src.length; i++) {
        const c = src[i]
        if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue }
        if (c === '"' || c === "'" || c === "`") { quote = c; continue }
        if ("([{".includes(c)) depth++
        else if (")]}".includes(c)) depth--
        // A newline at depth 0 ends it: a one-line arrow ends at its own newline, and a
        // braced body only reaches one after its closing brace has brought depth back.
        // (Ending at the first closing bracket instead cuts `() => …` at its own empty
        // parameter list, which is how this parse found two getters where there are six.)
        else if (c === "\n" && depth === 0) return src.slice(start, i)
    }
    return src.slice(start)
}

/** Resolve an argument to its literal text: an identifier is replaced by its body. An
 *  identifier that resolves to NOTHING is recorded, not silently treated as a string
 *  with no `""` in it — that is the shape that files a wrapping title as a safe one. */
const unresolved = []
const resolveArg = (src, file, arg) => {
    const a = (arg ?? "").trim()
    if (!/^[A-Za-z_$][\w$]*$/.test(a)) return a
    const body = constBody(src, a)
    if (body === null) { unresolved.push(`${file}: ${a}`); return a }
    return body
}

const keysIn = (text) => [...text.matchAll(/\bt\("([^"]+)"\)/g)].map(m => m[1])

/** `cond ? A : B` split into [A, B], at the top level only; anything else is one
 *  branch. Nothing here nests, and a fallback of "one branch" is the conservative
 *  reading (the whole subtitle expression decides), never the blind one. */
const branches = (expr) => {
    let depth = 0, quote = null, q = -1
    for (let i = 0; i < expr.length; i++) {
        const c = expr[i]
        if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue }
        if (c === '"' || c === "'" || c === "`") { quote = c; continue }
        if ("([{".includes(c)) depth++
        else if (")]}".includes(c)) depth--
        else if (depth === 0 && c === "?" && expr[i + 1] !== "." && expr[i + 1] !== "?") { q = i; break }
    }
    if (q < 0) return [expr]
    depth = 0; quote = null
    for (let i = q + 1; i < expr.length; i++) {
        const c = expr[i]
        if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue }
        if (c === '"' || c === "'" || c === "`") { quote = c; continue }
        if ("([{".includes(c)) depth++
        else if (")]}".includes(c)) depth--
        else if (depth === 0 && c === ":") return [expr.slice(q + 1, i), expr.slice(i + 1)]
    }
    return [expr]
}

/** { key, canWrap } for every capsule title in ui/shell/widgets/. */
const TILE_TITLES = (() => {
    const out = new Map()
    const dir = Gio.File.new_for_path(WIDGET_DIR)
    const en = dir.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null)
    let info
    const files = []
    while ((info = en.next_file(null)) !== null) {
        const n = info.get_name()
        if (n.endsWith(".ts") && n !== "index.ts" && n !== "widgets.gen.ts") files.push(n)
    }
    files.sort()
    for (const file of files) {
        const src = read(`${WIDGET_DIR}/${file}`)
        for (const [maker, at] of Object.entries(MAKERS)) {
            let from = 0
            for (;;) {
                const i = src.indexOf(`${maker}(`, from)
                if (i < 0) break
                from = i + maker.length
                const args = callArgs(src, i + maker.length)
                if (!args) continue
                const title = resolveArg(src, file, args[at.title])
                const sub   = resolveArg(src, file, args[at.sub])
                const noSub = args.length <= at.sub
                // The subtitle-less branch is reachable when there is no subtitle
                // argument at all, or when the subtitle expression can return "".
                //
                // ⚠️ And a widget's title and subtitle are usually the SAME ternary on
                // the same condition — `recording ? t(a) : t(b)` beside
                // `recording ? elapsed() : ""` — so which title can wrap is decided per
                // BRANCH, not per widget. Reading it per widget marks
                // `screenrecord.recording` wrappable because the OTHER state has no
                // subtitle, and then fails the build over a pairing that cannot occur.
                const tb = branches(title), sb = branches(sub)
                const paired = !noSub && tb.length > 1 && tb.length === sb.length
                for (let b = 0; b < tb.length; b++) {
                    const canWrap = noSub || /""/.test(paired ? sb[b] : sub)
                    for (const key of keysIn(tb[b])) out.set(key, (out.get(key) ?? false) || canWrap)
                }
            }
        }
    }
    return [...out.entries()].map(([key, canWrap]) => ({ key, canWrap }))
})()

if (unresolved.length) {
    printerr("could not resolve these capsule arguments to a getter body — the parse is blind to them:")
    for (const u of unresolved) printerr(`   ${u}`)
    system.exit(2)
}
if (TILE_TITLES.length < 10 || TILE_TITLES.filter(t => t.canWrap).length < 4) {
    printerr(`parsed only ${TILE_TITLES.length} tile titles (${TILE_TITLES.filter(t => t.canWrap).length} wrappable) from ${WIDGET_DIR} — the capsule makers moved, fix the parse`)
    system.exit(2)
}

// ── The Control Centre's status banner ───────────────────────────────────────
// One row per indicator: dot + label/detail + a Stop button. The strings come from
// the registry in StatusIndicators.tsx, and the BUDGET is per-locale, because the
// button's own label is translated — which is exactly why this row was never a
// constant anyone could gate by hand.
const BANNER_KEYS = [...statusSrc.matchAll(/\b(?:label|detail):\s*\(\)\s*=>([^\n]+)/g)]
    .flatMap(m => keysIn(m[1]))
const BANNER_BTN_KEY = statusSrc.match(/NidaraButton\(\{ label: t\("([^"]+)"\)/)?.[1]
if (BANNER_KEYS.length < 3 || !BANNER_BTN_KEY) {
    printerr(`parsed ${BANNER_KEYS.length} banner strings and ${BANNER_BTN_KEY ? "a" : "no"} button key from StatusIndicators.tsx — fix the parse`)
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
const measure = (text, cssClasses, scopeName = "nidara-settings-window", metric = "natural") => {
    const win = new Gtk.Window({ name: scopeName, css_classes: [scopeName] })
    const box = new Gtk.Box()
    win.set_child(box)
    // `min-wrapped` builds the label the way the two-line branch does, and reads its
    // MINIMUM — the longest unbreakable run. That is the number that pushes a fixed
    // tile, and no ellipsis can rescue it: GTK grows the parent instead. A soft hyphen
    // in the string is a break opportunity, so a hyphenated compound measures small
    // here, which is the point of putting one there.
    const wrapped = metric === "min-wrapped"
    const label = new Gtk.Label({
        label: text, css_classes: cssClasses,
        ...(wrapped ? { wrap: true, lines: 2, ellipsize: 3, halign: Gtk.Align.FILL, hexpand: true, xalign: 0 } : {}),
    })
    box.append(label)
    const [min, nat] = label.measure(Gtk.Orientation.HORIZONTAL, -1)
    return wrapped ? min : nat
}

/** The Stop button's own width, per locale — the banner's text budget is what is
 *  left after it, and its label is translated too. */
const buttonWidth = (text) => {
    const win = new Gtk.Window({ name: "nidara-bar", css_classes: ["nidara-bar-window"] })
    const row = new Gtk.Box({ css_classes: ["cc-status-row"] })
    win.set_child(row)
    const btn = new Gtk.Button({ label: text, css_classes: ["nidara-btn", "nidara-btn--secondary"] })
    row.append(btn)
    const [, nat] = btn.measure(Gtk.Orientation.HORIZONTAL, -1)
    return nat
}

// ── The slots ────────────────────────────────────────────────────────────────
// A slot is a text box whose width is a CONSTANT — the case where "the text scales
// and the box does not" (tech-debt #62) actually bites. A row title inside the
// 800px pane is NOT one of these: its budget is whatever the trailing control
// leaves, which is itself localised. See the note at the bottom of this file.
//
// Two VERDICTS, because two different things go wrong:
//
//   overflow   — the text sets a minimum wider than its box, so GTK grows the box and
//                the surface clips it. A layout break. FAILS at or below the gate.
//   truncation — the text ellipsises inside its box. Information is lost, the layout
//                holds. FAILS for the sidebar, where the label is a page's only name;
//                REPORTED for a CC tile, whose icon, subtitle, detail panel and
//                Settings → Widgets row all still say what it is.
const SLOTS = [
    {
        name: "Settings sidebar label",
        scope: "nidara-settings-window",
        classes: ["nidara-sidebar-label"],
        budget: () => BUDGET,
        items: SIDEBAR_KEYS.map(key => ({ key, metric: "natural", verdict: "truncation", fails: true })),
        why: `${sidebarWidth}px column − ${CSS_CHROME} css − ${itemMargins} margins − ${itemSpacing} spacing − ${iconSize} icon`,
    },
    {
        name: "Control Center tile title",
        scope: "nidara-bar",
        classes: ["nidara-atomic-label-bold"],
        budget: () => TILE_COLUMN,
        items: TILE_TITLES.map(({ key, canWrap }) => canWrap
            ? { key, metric: "min-wrapped", verdict: "overflow",   fails: true }
            : { key, metric: "natural",     verdict: "truncation", fails: false }),
        why: `2×1 tile ${2 * UNIT + GAP}px − ${2 * ISLAND_PAD} island padding − ${CAPSULE_CHROME} capsule chrome`,
    },
    {
        name: "Control Center status banner",
        scope: "nidara-bar",
        classes: ["nidara-row-subtitle"],
        // Per-locale: what the row has left after a Stop button whose label is
        // translated. ru pays 106px for its button where ja pays 56.
        budget: (locale) => GRID_WIDTH - BANNER_CHROME - buttonWidth(stringFor(locale, BANNER_BTN_KEY)),
        items: BANNER_KEYS.map(key => ({ key, metric: "min-wrapped", verdict: "overflow", fails: true })),
        why: `${GRID_WIDTH}px card − ${BANNER_CHROME} chrome − the Stop button (per locale)`,
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

print(`gate       overflow fails at scales ≤ ${FAIL_AT.toFixed(2)}; truncation fails only where the label is a page's`)
print(`           only name (the sidebar), and is reported everywhere else`)
print("")

const breaches = []
const reported = []

for (const slot of SLOTS) {
    print(`── ${slot.name} — ${slot.items.length} strings — ${slot.why}`)
    for (const scale of SCALES) {
        setScale(scale)
        // Worst string per locale at this scale, and every hit, because a slot now
        // holds items with different metrics: one locale can overflow on one string
        // and truncate on another, and only the first of those breaks the layout.
        const worst = []
        for (const locale of locales) {
            const budget = slot.budget(locale)
            let top = { w: -1 }
            for (const item of slot.items) {
                const text = stringFor(locale, item.key)
                const w = measure(text, slot.classes, slot.scope, item.metric)
                if (w > top.w) top = { w, text, key: item.key }
                if (w > budget) {
                    const hit = { slot: slot.name, scale, locale, w, text, key: item.key, budget, verdict: item.verdict }
                    if (item.fails && scale <= FAIL_AT) breaches.push(hit)
                    else reported.push(hit)
                }
            }
            worst.push({ locale, budget, ...top })
        }
        worst.sort((a, b) => (b.w - b.budget) - (a.w - a.budget))
        const over = worst.filter(w => w.w > w.budget)
        const head = worst[0]
        print(
            `   scale ${scale.toFixed(2)}  worst ${head.locale} ${String(head.w).padStart(4)}px of ${head.budget}px "${head.text}"` +
            `  —  over budget: ${over.length ? over.map(o => `${o.locale}(${o.w}/${o.budget})`).join(" ") : "none"}`,
        )
    }
    print("")
}

setScale(1.0)

// ── Optional cross-check against a running session ───────────────────────────
// The CSS terms in a budget are the only numbers here not read from source. This
// proves them against the real thing rather than trusting the comment.
//
// 🔑 AND IT IS NOT OPTIONAL POLISH — it is the only half of this instrument that can
// see the OTHER bug. Everything above asks "does this text fit a box of N pixels?"
// and takes N from the source. It cannot ask whether the box IS N pixels. On
// 2026-09-07 the status banner shipped with its labels correctly wrapped and its card
// 412px wide against a 356px grid, and this script printed PASS — because a
// `set_size_request` is a FLOOR, the card was allocated its natural width, and a
// label only wraps when it is given less than it asked for. Run `--verify` before
// believing a green run about a box you have not looked at.
const queryUI = (selector) => {
    let out = ""
    try {
        const [ok, stdout] = GLib.spawn_command_line_sync(`nidara-ipc queryUI ${selector}`)
        if (ok && stdout) out = new TextDecoder().decode(stdout)
    } catch (e) { out = "" }
    try { return JSON.parse(out).nodes || [] } catch { return [] }
}

if (VERIFY) {
    const nodes = queryUI(".nidara-sidebar-label")
    const live = nodes.filter(n => n.window === "nidara-settings-window" && n.mapped && n.bounds?.w > 0)
    if (live.length === 0) {
        print("--verify: no live Settings window (open it with `nidara-ipc openSettings`) — budget NOT cross-checked")
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

    // The Control Centre's two boxes, which have to BE the width this script assumes.
    // Both need the CC open (`nidara-ipc toggleCC`); the banner also needs AI control
    // granted, since that is the only indicator there is. "Not on screen" is reported,
    // never passed off as agreement.
    const boxes = [
        {
            name: "CC tile title column", selector: ".nidara-atomic-label-bold",
            expect: TILE_COLUMN,
            // The label is halign START, so it is allocated its NATURAL width, not the
            // column's. What must hold is that no title exceeds the column.
            read: (ns) => Math.max(...ns.map(n => n.bounds.w)), cmp: "atMost",
            hint: "open it with `nidara-ipc toggleCC`",
        },
        {
            name: "CC status banner card", selector: ".cc-status-banner",
            expect: GRID_WIDTH,
            read: (ns) => Math.max(...ns.map(n => n.bounds.w)), cmp: "equals",
            hint: "open the CC with AI control granted — the banner is hidden otherwise",
        },
    ]
    for (const box of boxes) {
        const ns = queryUI(box.selector).filter(n => n.mapped && n.bounds?.w > 0)
        if (ns.length === 0) { print(`--verify: ${box.name} not on screen — NOT cross-checked (${box.hint})`); continue }
        const w = box.read(ns)
        const bad = box.cmp === "equals" ? Math.abs(w - box.expect) > 2 : w > box.expect + 2
        print(`--verify: ${box.name} measures ${w}px, expected ${box.cmp === "equals" ? "" : "at most "}${box.expect}px${bad ? "  ← WRONG" : ""}`)
        if (bad) {
            breaches.push({
                slot: box.name, scale: 1, locale: "-", text: "-", w, budget: box.expect,
                verdict: "overflow",
                note: "the BOX is not the size this script measures text against — a floor is not a ceiling",
            })
        }
    }
    print("")
}

const line = (b) =>
    `${b.slot} (${b.verdict ?? "truncation"}): ${b.locale} at scale ${b.scale} needs ${b.w}px of ${b.budget}px` +
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
    print(`PASS — in ${locales.length} locales, at scale ≤ ${FAIL_AT.toFixed(2)}: no text overflows its box, and no page name is truncated.`)
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

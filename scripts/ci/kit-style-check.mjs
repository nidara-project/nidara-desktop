// kit-style-check — a component that ships in the kit must ship its LOOK in the kit.
//
// WHY THIS EXISTS (2026-09-20, tech-debt #59). `ui/lib/nidara-kit/` is importable
// from every bundle; `ui/lib/styles/_components.scss` is the stylesheet every bundle
// compiles. `ui/shell/styles/_components.scss` is the SHELL's, and only the shell
// compiles it. So a kit component whose rules sit in the second file renders
// unstyled everywhere else — and unstyled means one of two things, neither
// acceptable: on the greeter and the lock screen, which force the blank theme we
// ship (`/usr/share/themes/nidara/gtk-4.0/gtk.css`), it is INVISIBLE; in the shell
// and the installer it is drawn by whatever GTK theme the user happens to have, so
// our own component wears somebody else's clothes.
//
// That is not hypothetical. Every rule giving a `switch` its track and thumb stayed
// in the shell's half when the kit's stylesheet was extracted (2026-08-10), and
// `NidaraToggleRow` went out without them.
//
// ⚠️ CORRECTION, measured 2026-09-20 after this file first claimed otherwise. The
// blank theme is NOT what the shell and the installer run under. `GTK_THEME=nidara`
// is set by the GREETER (`ui/greeter/app.ts`) and by the dev probes; a real session
// seeds `themeFamily: "Adwaita"` (`defaults/appearance.json`) and `ThemeManager`
// explicitly UNSETS `GTK_THEME` and drives the theme through gsettings. Rendered
// with zero switch rules of our own under Adwaita, GTK draws a switch perfectly
// well. So the installer's NVIDIA toggle was never invisible — it wore ADWAITA's
// switch while the shell's wore Nidara's, which is a different bug and a smaller
// one. Invisible is what happens on the GREETER and the LOCK SCREEN, which do force
// the blank theme; no toggle row has reached those yet, so that half is latent.
//
// The rule this check enforces is unchanged, and its reason is stronger for being
// accurate: a kit component must not depend on the user's GTK theme to be drawn.
//
// ⚠️ Why the 2026-08-10 verification could not catch it: it proved the SHELL's
// compiled sheet still held the same 534 selector→body pairs — that nothing was
// LOST. The question nobody asked was whether everything the KIT needs had
// ARRIVED. This check asks that one.
//
// It is `token-contract-check`'s shape one level up. That one asks "does this bundle
// define the tokens it paints with"; this one asks "does the kit draw what the kit
// builds".
import { readFileSync, readdirSync, statSync } from "node:fs"

const KIT_SRC = "ui/lib/nidara-kit"
const KIT_SHEETS = ["ui/lib/styles/_components.scss", "ui/lib/styles/_mixins.scss"]
const SHELL_SHEET = "ui/shell/styles/_components.scss"

/**
 * Classes the kit puts on a widget and deliberately does NOT style, each with the
 * reason. "A bundle styles it" is a reason; "we never got round to it" is not.
 */
const CLASS_EXCEPTIONS = new Map([
    ["dark", "a MODE marker read by other rules, never painted on its own"],
    ["light", "a MODE marker read by other rules, never painted on its own"],
    ["dragging", "a STATE marker the consuming surface styles (the dock's drag)"],
    ["nd-icon", "the interface-icon marker; symbolic icons follow CSS `color` and need no rule of their own since #587"],
    ["nidara-selection-check", "Cairo paints it (`nidara-kit/check.ts`); the class exists for perception (`queryUI`), not for paint"],
    // ⚠️ These five carry no rule in ANY sheet today. They are listed rather than
    // ignored so that the check SEES them: a silent "nothing styles this" bucket is
    // how a rule disappears without anyone noticing. Each says which it is.
    ["nidara-form-dialog", "a variant hook on a window already painted by `.nidara-alert-dialog`; no paint of its own"],
    ["nidara-list-group", "a grouping box; the paint is the rows and the `.nidara-list` around them"],
    ["nidara-sidebar-label", "the sidebar row's label, which inherits its colour from the row — a name for perception"],
    ["nidara-table-row", "the base class; the paint lives on its `--warning`/`--error` variants and on the consuming bundle's selected state"],
    ["slider-fill-icon", "the fill tile's icon, drawn through `nd-icon`; this class only names it"],
])

/**
 * GTK draws these from its theme, and OUR theme is blank — so the kit must draw
 * any widget it BUILDS whose look would otherwise come from there. Maps the
 * `new Gtk.X` the kit instantiates to the CSS node GTK gives it.
 *
 * Pure containers and leaves that paint nothing by default (Box, Label, Image,
 * Grid, Overlay, CenterBox, DrawingArea, ListBoxRow, WindowHandle, SizeGroup, the
 * controllers and the factories) are not here: there is nothing for a theme to
 * take away. If a NEW widget type appears in the kit it will fail this check by
 * name rather than pass unnoticed — add it here with its node, or below with a
 * reason.
 */
const WIDGET_NODES = new Map([
    ["Switch", "switch"],
    ["Entry", "entry"],
    ["CheckButton", "checkbutton"],
    ["Button", "button"],
    ["DropDown", "dropdown"],
    ["Popover", "popover"],
    ["Window", "window"],
    ["ListBox", "list"],
    ["ScrolledWindow", "scrolledwindow"],
])

const WIDGET_EXCEPTIONS = new Map([
    ["dropdown", "the trigger is a `button` and the list is `popover.combo`; both are styled, and GTK's `dropdown` node itself paints nothing"],
    ["list", "`.nidara-list` is the painted surface; the bare `list` node has no fill of its own"],
    ["scrolledwindow", "`NidaraScrolled` paints its own bar (`.nidara-scroll-bar`) and the viewport is transparent by design"],
])

const IGNORED_WIDGETS = new Set([
    "Box", "Label", "Image", "Grid", "Overlay", "CenterBox", "DrawingArea",
    "ListBoxRow", "WindowHandle", "SizeGroup", "StringList", "SignalListItemFactory",
    "FontDialog", "GestureDrag", "EventControllerMotion", "EventControllerKey",
    "EventControllerScroll",
])

const read = (p) => readFileSync(p, "utf8")
const walk = (dir, out = []) => {
    for (const name of readdirSync(dir)) {
        const p = `${dir}/${name}`
        if (statSync(p).isDirectory()) walk(p, out)
        else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(p)
    }
    return out
}

/** Comments name classes constantly; a mention is not an emission. */
const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/([^:])\/\/[^\n]*/g, "$1")

const files = walk(KIT_SRC)
if (files.length === 0) {
    console.error(`kit-style-check: no sources under ${KIT_SRC} — did the kit move?`)
    process.exit(1)
}

const classes = new Map()   // class → the kit file that adds it
const widgets = new Map()   // Gtk type → the kit file that builds it

for (const f of files) {
    const src = stripComments(read(f))
    // ⚠️ The array is not always the first thing after the colon: the kit writes
    // `css_classes: opts.cssClasses ?? ["nidara-menu-popover"]`, and a pattern
    // anchored straight to `[` walked past it — which hid one half of the very
    // component this check first caught.
    for (const m of src.matchAll(/css_classes\s*:[^\n]*?\[([^\]]*)\]/g))
        for (const c of m[1].matchAll(/"([a-z][a-z0-9-]*)"/g))
            if (!classes.has(c[1])) classes.set(c[1], f)
    for (const m of src.matchAll(/add_css_class\(\s*"([a-z][a-z0-9-]*)"/g))
        if (!classes.has(m[1])) classes.set(m[1], f)
    for (const m of src.matchAll(/new Gtk\.([A-Za-z]+)/g))
        if (!widgets.has(m[1])) widgets.set(m[1], f)
}

// ⚠️ Comments out of the STYLESHEETS too, and for the same reason as everywhere
// else in this repo: these files explain themselves at length, and a rule named in
// a sentence ("moved to the kit's sheet") would answer for a rule that is not there.
const kitCss = stripComments(KIT_SHEETS.map(read).join("\n"))
const shellCss = stripComments(read(SHELL_SHEET))

/**
 * Does this sheet style `.name`?
 *
 * ⚠️ A class is NOT only ever preceded by a space or a comma. The first version of
 * this check demanded that and reported thirteen false failures in one run — every
 * element- or class-qualified selector we write: `window.nidara-alert-dialog`,
 * `.nidara-row.nidara-row--stacked`, `button.nidara-icon-btn.sidebar-toggle`. A `.`
 * cannot occur inside an identifier, so the only thing worth anchoring is the END.
 */
const styledClass = (css, name) =>
    new RegExp(String.raw`\.${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9-])`).test(css)

/** An element node, which must be at the head of a compound selector. */
const styledNode = (css, node) =>
    new RegExp(String.raw`(^|[\s,>])${node}(?![a-z0-9-])`, "m").test(css)

let failed = false
const report = (what, where, extra) => {
    failed = true
    console.error(`  FAIL  ${what}`)
    console.error(`          built in ${where}`)
    if (extra) console.error(`          ${extra}`)
}

// ⚠️ EVERY kit class must be drawn by the kit's sheet or be listed above with a
// reason — the default is "must", not "should". The first draft of this loop only
// failed when the SHELL styled the class, which sounds tighter and is a hole: once
// a rule has correctly moved into the kit, deleting it there makes the class
// "styled nowhere", and "nowhere" was being treated as acceptable. The control
// caught it — renaming `.nidara-menu` in the kit's sheet passed a check written to
// protect `.nidara-menu`.
//
// The reason "nowhere" cannot simply be a failure either is that a class can carry
// no paint on purpose: `queryUI` drops a node with no id, no class and no text, so
// a class is also how a widget gets a NAME for perception and automation. Those go
// in CLASS_EXCEPTIONS, where a human has written down which it is.
let okClasses = 0
for (const [c, file] of [...classes].sort()) {
    if (CLASS_EXCEPTIONS.has(c)) continue
    if (styledClass(kitCss, c)) { okClasses++; continue }
    report(`.${c} is added by the kit and the kit's sheet has no rule for it`, file,
        styledClass(shellCss, c)
            ? `it IS styled in ${SHELL_SHEET} — the shell's half, which no other bundle compiles, so it draws in the shell and nowhere else`
            : `nothing styles it in ${SHELL_SHEET} either — either it should carry paint and does not, or it is a name for perception and belongs in CLASS_EXCEPTIONS with that reason`)
}

let okWidgets = 0
for (const [type, file] of [...widgets].sort()) {
    if (IGNORED_WIDGETS.has(type)) continue
    const node = WIDGET_NODES.get(type)
    if (!node) {
        report(`Gtk.${type} is built by the kit and this check does not know its CSS node`, file,
            "add it to WIDGET_NODES with the node GTK gives it, or to IGNORED_WIDGETS if it paints nothing")
        continue
    }
    if (WIDGET_EXCEPTIONS.has(node)) continue
    if (styledNode(kitCss, node)) { okWidgets++; continue }
    report(`Gtk.${type} draws as \`${node}\`, and the kit's sheet has no rule for it`, file,
        styledNode(shellCss, node)
            ? `it IS styled in ${SHELL_SHEET} — so it is invisible in every bundle but the shell`
            : `nothing styles it in ${SHELL_SHEET} either — it may be relying on a GTK theme we do not ship`)
}

if (failed) {
    console.error("")
    console.error("The GTK theme Nidara ships is a deliberate blank, so a widget our CSS does not")
    console.error("draw is not styled by anything at all. Move the rules into the kit's sheet (and")
    console.error("the tokens they spend with them — `token-contract-check` will say if one is")
    console.error("missing), or record the exception in this file WITH its reason.")
    process.exit(1)
}

console.log(`kit-style-check: ${okClasses} kit classes and ${okWidgets} widget nodes are drawn by the kit's own sheet ` +
            `(${CLASS_EXCEPTIONS.size} classes and ${WIDGET_EXCEPTIONS.size} nodes exempted, each with its reason).`)

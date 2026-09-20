// style-ownership-check — we use GTK, with OUR styles. Nothing by default.
//
// Commandment 11 (owner's decision 2026-09-20, tech-debt #107) as a gate. Two halves:
//
//   A · the KIT half — a component that ships in the kit must ship its LOOK in the
//       kit, because `ui/shell/styles/` is compiled by the shell alone.
//   B · the BUNDLE half — every GTK widget ANY bundle builds must have a rule in a
//       sheet that bundle compiles. This is the half that makes the rule bind for
//       work that does not exist yet: add a widget, and the check names it.
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
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"

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
    // Controls
    ["Button", "button"], ["ToggleButton", "button"], ["CheckButton", "checkbutton"],
    ["Switch", "switch"], ["DropDown", "dropdown"], ["SpinButton", "spinbutton"],
    // Text
    ["Entry", "entry"], ["PasswordEntry", "entry"], ["Text", "text"], ["TextView", "textview"],
    // Containers and views GTK's theme DOES have rules for — verified 2026-09-20 by
    // reading them out of the gresource, not by assuming:
    //   gresource extract /usr/lib/libgtk-4.so.1 \
    //     /org/gtk/libgtk/theme/Default/Default-light.css
    // `revealer` (11 rules), `stack` (5) and `picture` (1) are in there too, which is
    // why they are listed rather than ignored — the first draft of this table called
    // them "containers that paint nothing" and that was a guess, not a fact.
    ["ListBox", "list"], ["ListBoxRow", "row"], ["FlowBox", "flowbox"],
    ["ScrolledWindow", "scrolledwindow"], ["Popover", "popover"], ["Expander", "expander"],
    ["Separator", "separator"], ["Spinner", "spinner"], ["ProgressBar", "progressbar"],
    ["Stack", "stack"], ["Revealer", "revealer"], ["Picture", "picture"],
    ["Calendar", "calendar"],
    // Windows
    ["Window", "window"], ["ApplicationWindow", "window"],
])

/**
 * ⚠️ Dialogs GTK builds ITSELF, inside our process. Their internals are GTK's own
 * widgetry under GTK's own class names, so "draw it ourselves" is not a rule we can
 * simply write — and we do not set `GTK_USE_PORTAL`, so they are not somebody else's
 * process either. This is the one identified risk of commandment 11 and it is NOT
 * measured yet (tech-debt #107): an attempt on 2026-09-20 failed to capture the
 * dialog. Listed here so the check does not pretend the question is settled.
 */
const GTK_OWN_DIALOGS = new Set(["FileDialog", "FontDialog"])

const WIDGET_EXCEPTIONS = new Map([
    ["dropdown", "the trigger is a `button` and the list is `popover.combo`; both are styled, and GTK's `dropdown` node itself paints nothing"],
    ["list", "`.nidara-list` is the painted surface; the bare `list` node has no fill of its own"],
    ["scrolledwindow", "`NidaraScrolled` paints its own bar (`.nidara-scroll-bar`) and the viewport is transparent by design"],
])

// Not widgets at all — controllers, models, providers, gestures, paintables — plus
// the pure layout boxes GTK's theme has nothing for. Nothing here can be styled,
// so nothing here can be owed.
const IGNORED_WIDGETS = new Set([
    "Box", "CenterBox", "Grid", "Overlay", "Fixed", "WindowHandle",
    "Label", "Image", "DrawingArea",
    "Adjustment", "CssProvider", "DragSource", "EntryCompletion", "FileFilter",
    "EventControllerFocus", "EventControllerKey", "EventControllerMotion",
    "EventControllerScroll", "GestureClick", "GestureDrag", "GestureLongPress",
    "IconTheme", "ListStore", "SignalListItemFactory", "SizeGroup", "Snapshot",
    "StringList", "TextBuffer", "WidgetPaintable",
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
    console.error(`style-ownership-check: no sources under ${KIT_SRC} — did the kit move?`)
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

// ── B · the bundle half ──────────────────────────────────────────────────────
// Each bundle, the sheets it actually compiles, and the sources it builds from.
// The greeter's sheet is the lockscreen's too — one file, two bundles.
const BUNDLES = [
    { name: "shell", src: ["ui/shell"], sheets: ["ui/shell/styles"] },
    { name: "installer", src: ["ui/installer"], sheets: ["ui/installer/style.scss"] },
    { name: "greeter", src: ["ui/greeter"], sheets: ["ui/greeter/style.scss"] },
    { name: "lockscreen", src: ["ui/lockscreen"], sheets: ["ui/greeter/style.scss"] },
]

/**
 * Nodes we build somewhere and do not draw yet — the bill for commandment 11,
 * taken 2026-09-20 by reading GTK's own theme out of its gresource
 * (`gresource extract /usr/lib/libgtk-4.so.1 /org/gtk/libgtk/theme/Default/Default-light.css`),
 * which has rules for every one of them. They are listed so that a NEW widget fails
 * this check immediately while the existing debt stays visible and countable.
 *
 * ⚠️ "Has a rule in GTK's theme" is not the same as "needs a rule from us": some of
 * these may turn out to be transitions or metrics we are happy to lose. That is
 * decided by LOOKING at the widget under `GTK_THEME=Empty`, not by reading. When one
 * is settled, either write the rule or move it to a reasoned exception — do not just
 * delete the line.
 */
const OWED = new Map([
    ["expander", "installer — tech-debt #107, not drawn yet"],
    ["flowbox", "shell — tech-debt #107, not drawn yet"],
    ["picture", "lockscreen — tech-debt #107, not drawn yet"],
    ["revealer", "shell — tech-debt #107, not drawn yet"],
    ["separator", "greeter — tech-debt #107, not drawn yet"],
    ["spinner", "shell — tech-debt #107, not drawn yet"],
    ["stack", "installer — tech-debt #107, not drawn yet"],
    ["textview", "installer — tech-debt #107, not drawn yet"],
])

const sheetText = (paths) => {
    let out = ""
    for (const p of paths) {
        if (!existsSync(p)) continue
        if (statSync(p).isDirectory()) {
            const stack = [p]
            while (stack.length) {
                const d = stack.pop()
                for (const n of readdirSync(d)) {
                    const f = `${d}/${n}`
                    if (statSync(f).isDirectory()) stack.push(f)
                    else if (n.endsWith(".scss")) out += stripComments(read(f))
                }
            }
        } else out += stripComments(read(p))
    }
    return out
}

let okBundles = 0
for (const b of BUNDLES) {
    const css = sheetText([...b.sheets, "ui/lib/styles"])
    const built = new Map()
    for (const dir of b.src) {
        if (!existsSync(dir)) continue
        for (const f of walk(dir)) {
            const src = stripComments(read(f))
            for (const m of src.matchAll(/new Gtk\.([A-Za-z]+)/g))
                if (!built.has(m[1])) built.set(m[1], f)
        }
    }
    for (const [type, file] of [...built].sort()) {
        if (IGNORED_WIDGETS.has(type) || GTK_OWN_DIALOGS.has(type)) continue
        const node = WIDGET_NODES.get(type)
        if (!node) {
            report(`Gtk.${type} is built in the ${b.name} bundle and this check does not know its CSS node`, file,
                "add it to WIDGET_NODES with the node GTK gives it, or to IGNORED_WIDGETS if it paints nothing")
            continue
        }
        if (WIDGET_EXCEPTIONS.has(node) || OWED.has(node)) continue
        if (styledNode(css, node)) { okBundles++; continue }
        report(`Gtk.${type} draws as \`${node}\`, and nothing the ${b.name} bundle compiles has a rule for it`, file,
            "commandment 11: a GTK widget arrives WITH its rules, or it does not ship")
    }
}

let okWidgets = 0
for (const [type, file] of [...widgets].sort()) {
    if (IGNORED_WIDGETS.has(type) || GTK_OWN_DIALOGS.has(type)) continue
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

console.log(`style-ownership-check: ${okClasses} kit classes and ${okWidgets} widget nodes drawn by the kit's own sheet; ` +
            `${okBundles} widget node(s) drawn by the bundle that builds them ` +
            `(${CLASS_EXCEPTIONS.size} classes and ${WIDGET_EXCEPTIONS.size} nodes exempted with reasons, ` +
            `${OWED.size} owed to commandment 11 — tech-debt #107).`)

import { Gtk } from "ags/gtk4"

// queryUI — a read-only snapshot of what the shell's widgets are actually
// rendering, for agent/script verification. Same category as dumpState (a
// diagnostic read, ungated; see AgentConfig). It walks every MAPPED toplevel
// (so closed overlays/Settings simply don't appear) and returns a FLAT list of
// "interesting" nodes — ones carrying signal: a test-id, a CSS class, visible
// text, or an interactive role. A flat list (vs a nested tree) is easier to
// scan and assert against, and each node carries a `path` of ancestors for
// context. Tier 1: structure + text. Semantic per-widget state (slider value,
// dock-item running/active) is a later, opt-in tier the widgets cooperate on.
//
// This is the in-process serializer. The data MODEL it produces is the door:
// a future AT-SPI2 backend can fill the same shape for third-party apps under
// the computer-use layer, and consumers won't notice the source changed.

// Widget GType names whose mere presence is worth indexing even with no class.
const INTERACTIVE = new Set([
    "GtkButton", "GtkToggleButton", "GtkCheckButton", "GtkSwitch", "GtkScale",
    "GtkEntry", "GtkText", "GtkSearchEntry", "GtkSpinButton", "GtkPasswordEntry",
    "GtkDropDown", "GtkComboBox", "GtkListBoxRow", "GtkExpander",
])

const MAX_NODES = 500

interface UINode {
    window: string
    type: string
    id: string | null
    cssClasses: string[]
    text: string | null
    visible: boolean
    mapped: boolean
    bounds: { x?: number; y?: number; w: number; h: number }
    path: string
}

function safe<T>(fn: () => T, fallback: T): T {
    try { const v = fn(); return v == null ? fallback : v } catch { return fallback }
}

function typeName(w: any): string {
    return safe(() => w.constructor?.$gtype?.name, "") || safe(() => w.constructor?.name, "") || "?"
}

// Extract visible text, redacting password/masked entries so queryUI never
// leaks a secret being typed (e.g. a Wi-Fi key in Settings → Network).
function textOf(w: any): string | null {
    try { if (w instanceof Gtk.Label) { const t = w.get_label(); return typeof t === "string" ? t : null } } catch {}
    try {
        if (typeof w.get_text === "function") {
            const masked = (typeof w.get_visibility === "function" && w.get_visibility() === false)
                || w instanceof Gtk.PasswordEntry
                || safe(() => w.input_purpose, null) === Gtk.InputPurpose.PASSWORD
                || safe(() => w.input_purpose, null) === Gtk.InputPurpose.PIN
            if (masked) return "‹redacted›"
            const t = w.get_text()
            return typeof t === "string" ? t : null
        }
    } catch {}
    return null
}

function boundsOf(w: any, toplevel: any): UINode["bounds"] {
    const b: UINode["bounds"] = { w: safe(() => w.get_width(), 0), h: safe(() => w.get_height(), 0) }
    try {
        const [ok, r] = w.compute_bounds(toplevel)
        if (ok && r) { b.x = Math.round(r.origin.x); b.y = Math.round(r.origin.y) }
    } catch {}
    return b
}

function nodeOf(w: any, toplevel: any, windowLabel: string, path: string): UINode {
    const type = typeName(w)
    const rawName = safe(() => w.get_name(), "")
    return {
        window: windowLabel,
        type,
        // get_name() falls back to the GType name when unset; treat that as "no id".
        id: rawName && rawName !== type ? rawName : null,
        cssClasses: safe(() => w.get_css_classes(), []) as string[],
        text: textOf(w),
        visible: safe(() => w.get_visible(), true),
        mapped: safe(() => w.get_mapped(), false),
        bounds: boundsOf(w, toplevel),
        path,
    }
}

function isInteresting(n: UINode): boolean {
    return !!(n.id || n.cssClasses.length || n.text || INTERACTIVE.has(n.type))
}

function walk(w: any, toplevel: any, windowLabel: string, path: string, out: UINode[]): void {
    if (out.length >= MAX_NODES) return
    if (!safe(() => w.get_mapped(), false)) return   // only what's actually on screen
    const node = nodeOf(w, toplevel, windowLabel, path)
    if (isInteresting(node)) out.push(node)
    const tag = node.type + (node.cssClasses[0] ? "." + node.cssClasses[0] : node.id ? "#" + node.id : "")
    const childPath = path ? `${path} > ${tag}` : tag
    let c = safe<any>(() => w.get_first_child(), null)
    while (c) {
        walk(c, toplevel, windowLabel, childPath, out)
        c = safe<any>(() => c.get_next_sibling(), null)
    }
}

function windowLabelOf(win: any): string {
    const name = safe(() => win.get_name(), "")
    const type = typeName(win)
    if (name && name !== type) return name
    const title = safe(() => (typeof win.get_title === "function" ? win.get_title() : ""), "")
    return title || type
}

// Parse "selector@window" → { sel, scope }. sel: ".class" | "#id" | "Type".
function parseSelector(raw: string): { sel: string; scope: string | null } {
    const at = raw.lastIndexOf("@")
    const scope = at >= 0 ? raw.slice(at + 1).toLowerCase() : null
    const sel = at >= 0 ? raw.slice(0, at) : raw
    return { sel: sel.trim(), scope }
}

function matchesSel(n: UINode, sel: string): boolean {
    if (!sel) return true
    if (sel.startsWith(".")) return n.cssClasses.includes(sel.slice(1))
    if (sel.startsWith("#")) return n.id === sel.slice(1)
    const want = sel.toLowerCase()
    const ty = n.type.toLowerCase()
    return ty === want || ty === "gtk" + want || ty.includes(want)
}

/**
 * Snapshot the live UI. With no selector, returns every interesting node on
 * screen; with a selector (`.class`, `#id`, `Type`, optionally `…@window`),
 * returns the matches. Read-only; safe to call any time.
 */
export function queryUI(selector?: string): object {
    const out: UINode[] = []
    try {
        const model = Gtk.Window.get_toplevels()
        const n = model.get_n_items()
        for (let i = 0; i < n; i++) {
            const win = model.get_item(i) as any
            if (!win || !safe(() => win.get_mapped(), false)) continue
            walk(win, win, windowLabelOf(win), "", out)
        }
    } catch (e) {
        return { error: `queryUI failed: ${e}` }
    }

    let nodes = out
    if (selector && selector.trim()) {
        const { sel, scope } = parseSelector(selector)
        nodes = out.filter(nd => matchesSel(nd, sel) && (!scope || nd.window.toLowerCase().includes(scope)))
    }
    return { selector: selector ?? null, count: nodes.length, nodes: nodes.slice(0, MAX_NODES) }
}

export default queryUI

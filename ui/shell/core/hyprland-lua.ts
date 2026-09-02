// Building expressions for Hyprland's Lua parser.
//
// Pure string work, and in its own module on purpose. `HyprlandState` connects
// to the compositor's event socket at import time and `InputConfig` reads
// effective options the moment it is constructed — so neither can be imported by
// a bench without a live desktop answering. What lives here is exactly the half
// that fails SILENTLY: an option path nested one level wrong still evals, and a
// value rendered wrong still writes a file. `hyprland.lua` requires the file
// this builds, and one syntax error there costs the session its whole Nidara
// config — so this half deserves to be testable on its own.
//
// ⚠️ `hyprctl keyword` is rejected under the Lua parser ("can't work with
// non-legacy parsers. Use eval."), which is why every live change in this
// codebase is an `hl.config({...})` expression rather than a keyword write.

export type LuaValue = string | number | boolean

/**
 * A Lua literal.
 *
 * Booleans render as `true`/`false`, never `1`/`0`. Both are accepted by
 * Hyprland for the boolean options here, and having two spellings is precisely
 * how the eval and the file it is supposed to mirror came to disagree: the live
 * apply passed `1` while the generated file wrote `true`.
 *
 * Strings are escaped. Nothing in the current callers can produce a quote — the
 * values come from Hyprland's own `getoption` or from a fixed layout table — but
 * the cost of being wrong is not a bad setting: an unbalanced quote makes the
 * generated file unparseable, and a Lua config that does not parse takes the
 * whole Nidara configuration down with it, silently, at the next login.
 */
export function luaLiteral(v: LuaValue): string {
    if (typeof v === "boolean") return v ? "true" : "false"
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : "0"
    return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`
}

/** Split a keyword-style option path ("input:touchpad:tap_to_click") into its
 *  segments. The colon form is what `hyprctl getoption` takes, so it is the one
 *  spelling of an option in this codebase — the nesting is derived from it
 *  rather than written a second time. */
const segments = (path: string) => path.split(":").filter(s => s.length > 0)

/**
 * One option, applied live: `hl.config({ input = { touchpad = { tap_to_click = true } } })`
 * from `("input:touchpad:tap_to_click", true)`.
 *
 * The nesting comes from the SAME string `getoption` is given, which is the
 * point — a reader and a writer that disagree about where an option lives is
 * the failure this is here to make impossible.
 */
export function luaConfigExpr(path: string, value: LuaValue): string {
    const path_ = segments(path)
    if (path_.length === 0) throw new Error("luaConfigExpr: empty option path")
    let inner = `${path_[path_.length - 1]} = ${luaLiteral(value)}`
    for (let i = path_.length - 2; i >= 0; i--) inner = `${path_[i]} = { ${inner} }`
    return `hl.config({ ${inner} })`
}

interface Node {
    /** Leaves in insertion order: the rendered file keeps the order its table
     *  declares, so a diff of the generated file stays readable. */
    readonly leaves: [string, string][]
    readonly children: Map<string, Node>
}

const newNode = (): Node => ({ leaves: [], children: new Map() })

function render(node: Node, indent: string): string[] {
    // Align the `=` within a nesting level, computed rather than hand-tuned —
    // the file this replaced had three different alignments in one block.
    const width = Math.max(0, ...node.leaves.map(([k]) => k.length))
    const out = node.leaves.map(([k, lit]) => `${indent}${k.padEnd(width)} = ${lit},`)
    for (const [name, child] of node.children) {
        out.push(`${indent}${name} = {`)
        out.push(...render(child, indent + "    "))
        out.push(`${indent}},`)
    }
    return out
}

/**
 * The body of a generated config file: many options, one nested `hl.config`
 * call, built from the same colon paths the readers use.
 *
 * `entries` carries literals rather than values because a couple of options want
 * their own spelling (`sensitivity` is written to two decimals so the file does
 * not churn between `0` and `0.00`). Producing the literal is the caller's
 * business; nesting it correctly is this function's.
 */
export function luaConfigBlock(entries: readonly (readonly [string, string])[]): string {
    const root = newNode()
    for (const [path, literal] of entries) {
        const path_ = segments(path)
        if (path_.length === 0) throw new Error("luaConfigBlock: empty option path")
        let node = root
        for (const seg of path_.slice(0, -1)) {
            let child = node.children.get(seg)
            if (!child) { child = newNode(); node.children.set(seg, child) }
            node = child
        }
        node.leaves.push([path_[path_.length - 1], literal])
    }
    return ["hl.config({", ...render(root, "    "), "})"].join("\n")
}

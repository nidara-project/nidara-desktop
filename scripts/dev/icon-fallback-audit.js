#!/usr/bin/env -S gjs -m
/*
 * icon-fallback-audit — does each THEME-name fallback we ship actually draw?
 *
 *   gjs -m scripts/dev/icon-fallback-audit.js [name …]
 *
 * With no arguments it audits every `themeFallback:` / `iconName:` theme name it
 * finds in the tree; with arguments it audits exactly those, which is how you pick
 * a replacement before writing it into the code.
 *
 * Why this is separate from `icon-theme-audit.js`: that one draws OUR `nd-` names
 * across themes made for our spec. This one asks the opposite question about the
 * other half of `ndImageProps(name, themeFallback, size)` — the freedesktop name
 * that draws when the Nidara asset tree is missing. Nothing gated that half, and
 * #603 shipped three fallbacks transliterated from their `nd-` names
 * (`hand-symbolic`, `clipboard-list-symbolic`, `cpu-symbolic`): Lucide names that
 * exist in NO icon theme, so the "fallback" drew a blank and logged nothing.
 *
 * ⚠️ Coverage is necessary and not sufficient. A name that exists everywhere can
 * still draw different things: `help-about-symbolic` is an ⓘ in Adwaita and a
 * four-pointed star in Colloid/MacTahoe/Qogir; `user-available-symbolic` is a
 * speech bubble in every family measured. So take the survivors of this list and
 * LOOK at them — resolve each one's file and render it, the way
 * `icon-theme-sheet.py` does for our own names. Read for MEANING.
 */
import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"

const REPO = GLib.get_current_dir()

/** Every theme name the tree hands to GTK as a fallback. */
function shippedFallbacks() {
    const out = new Set()
    const walk = (dir) => {
        let e
        try { e = GLib.Dir.open(dir, 0) } catch { return }
        let n
        while ((n = e.read_name())) {
            if (["node_modules", "build", "@girs", ".git"].includes(n)) continue
            const p = `${dir}/${n}`
            if (GLib.file_test(p, GLib.FileTest.IS_DIR)) walk(p)
            else if (n.endsWith(".ts") || n.endsWith(".tsx")) {
                const [ok, bytes] = GLib.file_get_contents(p)
                if (!ok) continue
                const src = new TextDecoder().decode(bytes)
                // ⚠️ THREE shapes, and the third was nearly missed. A property
                // (`themeFallback: "x"`), and `Gio.ThemedIcon.new("x")` — which is
                // how the installer's sidebar button asks, so a tool that only knew
                // the first two would have reported a clean sweep with that one
                // unmeasured.
                const patterns = [
                    /(?:themeFallback|icon_name|iconName)\s*:\s*"([a-z0-9-]+)"/g,
                    /ThemedIcon\.new\(\s*"([a-z0-9-]+)"/g,
                ]
                for (const re of patterns) {
                    for (const m of src.matchAll(re)) {
                        // our own names are not theme names — they are the primary ask
                        if (!m[1].startsWith("nd-")) out.add(m[1])
                    }
                }
            }
        }
    }
    walk(`${REPO}/ui`)
    return [...out].sort()
}

const names = ARGV.length ? ARGV : shippedFallbacks()

const themes = new Set()
for (const dir of new Gtk.IconTheme().get_search_path() ?? []) {
    let e
    try { e = GLib.Dir.open(dir, 0) } catch { continue }
    let n
    while ((n = e.read_name())) {
        if (["default", "hicolor", "nidara"].includes(n)) continue
        if (GLib.file_test(`${dir}/${n}/index.theme`, GLib.FileTest.EXISTS)) themes.add(n)
    }
}
const list = [...themes].sort()
if (list.length === 0) {
    printerr("no icon themes installed — nothing to measure")
    imports.system?.exit?.(1)
}

/** Colloid-Green-Dark and Colloid are one family; a family is what a user picks. */
const family = (t) => t.split("-")[0]
const families = new Set(list.map(family))

print(`${list.length} themes, ${families.size} families: ${[...families].sort().join(", ")}\n`)

let holes = 0
for (const name of names) {
    const hit = []
    for (const th of list) {
        const t = new Gtk.IconTheme()
        t.set_theme_name(th)
        if (t.has_icon(name)) hit.push(th)
    }
    const fams = new Set(hit.map(family))
    const adwaita = hit.includes("Adwaita")
    const verdict = hit.length === 0 ? "DRAWS NOWHERE" : !adwaita ? "not in Adwaita" : "ok"
    if (verdict !== "ok") holes++
    print(`${name.padEnd(40)} ${String(hit.length).padStart(3)}/${list.length} themes · ` +
          `${fams.size}/${families.size} families · ${verdict}`)
}

if (holes) {
    print(`\n${holes} fallback(s) a clean Arch install cannot draw. Adwaita is the one that`)
    print(`matters most: it is what GTK falls back to and what a fresh machine has.`)
}

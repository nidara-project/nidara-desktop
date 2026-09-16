#!/usr/bin/env -S gjs -m
/*
 * icon-theme-audit — what does each interface icon LOOK like in each installed theme?
 *
 *   gjs -m scripts/dev/icon-theme-audit.js [theme …] > /tmp/audit.tsv
 *   python3 scripts/dev/icon-theme-sheet.py /tmp/audit.tsv /tmp/audit   # → audit-N.png
 *
 * Why. A standard icon NAME is a promise about meaning that each theme keeps in its
 * own way, and the only way to know what a name means in practice is to draw it.
 * The #587 icon study mapped concepts to names by how the name READ, and three
 * went wrong in ways no table could show (2026-09-16, all caught by the owner):
 *   - dark mode asked for `system-suspend` — Adwaita draws a moon, Papirus, Qogir
 *     and Colloid draw the suspend button;
 *   - the bar's bell asked for `preferences-system-notifications` — the SETTINGS
 *     PANEL's icon, which most themes draw as a speech bubble with "!";
 *   - the Control Centre gear asked for `preferences-system` — tools in Adwaita.
 * Choose or change a name only after looking at its row in this sheet.
 *
 * It resolves exactly as `core/Icons.ts` does (symbolic first, only a
 * `-symbolic.svg` counts, size 512); the ink test is left out — a hole shows up as
 * an empty cell anyway. Output: name, theme, resolved path or "" when the concept
 * would fall back to Nidara's drawing.
 */
import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"

const REPO = GLib.get_current_dir()
const src = new TextDecoder().decode(GLib.file_get_contents(`${REPO}/ui/shell/core/Icons.ts`)[1])
const block = src.match(/ICON_NAMES = \[([\s\S]*?)\] as const/)
if (!block) { printerr("ICON_NAMES not found — run from the repo root"); imports.system?.exit?.(1) }
const names = [...block[1].matchAll(/"([^"]+)"/g)].map(m => m[1]).filter(n => !n.startsWith("nd-"))

let themes = [...ARGV]
if (!themes.length) {
    const seen = new Set()
    for (const dir of new Gtk.IconTheme().get_search_path() ?? []) {
        let e
        try { e = GLib.Dir.open(dir, 0) } catch { continue }
        let n
        while ((n = e.read_name())) {
            if (["default", "hicolor", "nidara", "nidara-symbolic"].includes(n)) continue
            // An icon theme declares Directories=; a cursor-only one (Adwaita's
            // pointer as "default", say) carries only Inherits=. A theme that ships
            // both, like Qogir, is still an icon theme.
            const index = `${dir}/${n}/index.theme`
            if (!GLib.file_test(index, GLib.FileTest.EXISTS)) continue
            try {
                const kf = new GLib.KeyFile()
                kf.load_from_file(index, GLib.KeyFileFlags.NONE)
                if (kf.get_string("Icon Theme", "Directories").trim()) seen.add(n)
            } catch { /* no [Icon Theme] Directories → not an icon theme */ }
        }
    }
    themes = [...seen].sort()
}

for (const th of themes) {
    const t = new Gtk.IconTheme()
    t.set_theme_name(th)
    for (const n of names) {
        const sym = `${n}-symbolic`
        const asked = t.has_icon(sym) ? sym : t.has_icon(n) ? n : null
        let path = ""
        if (asked) {
            const p = t.lookup_icon(asked, null, 512, 1, Gtk.TextDirection.NONE, 0)?.get_file()?.get_path() ?? ""
            if (p.endsWith("-symbolic.svg")) path = p
        }
        print(`${n}\t${th}\t${path}`)
    }
}

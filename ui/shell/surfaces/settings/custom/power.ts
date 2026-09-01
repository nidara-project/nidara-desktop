import Gtk from "gi://Gtk?version=4.0"
import { execAsync } from "../../../../lib/process"
import { listGroup, bindWhileRealized, onPageShown } from "../SettingsHelpers"
import Icons from "../../../core/Icons"
import { t } from "../../../core/i18n"
import Theme from "../../../core/ThemeManager"
import { safeDisconnect } from "../../../core/signals"
import { NidaraRow } from "../../../../lib/nidara-kit"
import type { PageCtx, ItemBuilder } from "../PreferencePage"

// Selection checkmark, Cairo-drawn. `accent-icon` (color: var(--nidara-accent)) on a
// Gtk.Image has NO effect here: our icons are Gio.FileIcon → raw SVG files, rendered
// outside GTK's symbolic-icon recolor pipeline (the only lever we have on them is
// `-gtk-icon-filter: invert(1)`, a fixed black/white toggle, not a real recolor) —
// anything that needs a genuinely live-coloured glyph goes through Cairo instead
// (same reasoning as the battery glyph). NOT accent-coloured on purpose: the row
// itself already carries the accent (`.nidara-row:selected` → `--nidara-state-selected`,
// which tracks the live accent too), so an accent check on an accent-tinted row has
// almost no contrast. Plain mode-aware white/black — the same "readable on whatever's
// under it" role `--nidara-text` plays everywhere else — reads clearly regardless of
// which accent is picked. Path matches Lucide's "check" (`M20 6 9 17l-5-5` in a 24×24
// viewBox), scaled to the widget's own size.
function buildSelectionCheck(size = 16): Gtk.Widget {
    // The class is not styling — Cairo paints this. It is what makes the selection
    // READABLE to `queryUI`, which drops nodes with no id, class or text (UITree's
    // `interesting`) and only walks MAPPED ones. With it, the one mapped
    // `.power-profile-check` IS the answer to "which profile does the page think
    // is active", so the re-read below can be verified without a screenshot.
    const da = new Gtk.DrawingArea({
        width_request: size, height_request: size, valign: Gtk.Align.CENTER,
        css_classes: ["power-profile-check"],
    })
    da.set_can_target(false)
    da.set_draw_func((_w: Gtk.DrawingArea, cr: any, w: number, h: number) => {
        const v = Theme.isDark ? 1 : 0
        const s = Math.min(w, h) / 24
        cr.setLineWidth(2 * s)
        cr.setLineCap(1)   // ROUND
        cr.setLineJoin(1)  // ROUND
        cr.setSourceRGBA(v, v, v, 1)
        cr.moveTo(4 * s, 12 * s)
        cr.lineTo(9 * s, 17 * s)
        cr.lineTo(20 * s, 6 * s)
        cr.stroke()
    })
    bindWhileRealized(da, () => {
        const sigId = Theme.connect("changed", () => da.queue_draw())
        return () => safeDisconnect(Theme, sigId)
    })
    return da
}

export const build = (_ctx: PageCtx) => {
    return {
        performanceProfiles: (title: string) => {
            const profileGroup = listGroup(title)
            profileGroup.listBox.selection_mode = Gtk.SelectionMode.SINGLE

            const profiles = [
                { id: "performance", label: t("settings.power.profile.performance"),  icon: Icons.zap },
                { id: "balanced",    label: t("settings.power.profile.balanced"),     icon: Icons.battery },
                { id: "power-saver", label: t("settings.power.profile.power-saver"),  icon: Icons.leaf },
            ]
            const checkIcons = new Map<string, Gtk.Widget>()

            profiles.forEach(p => {
                const checkIcon = buildSelectionCheck(16)
                checkIcon.visible = false
                checkIcons.set(p.id, checkIcon)
                // NidaraRow, not createRow: the search index is built when the page is
                // constructed and these three are settings VALUES, not settings — indexing
                // them would make "Balanced" a search hit that navigates to a page whose
                // row it cannot select.
                const row = NidaraRow(p.label, "", checkIcon, [], undefined,
                    new Gtk.Image({ gicon: p.icon, pixel_size: 20, css_classes: ["sidebar-icon", "nd-icon"] }))
                row.set_name(p.id)
                profileGroup.listBox.append(row)
            })

            // Set while we are SHOWING what the daemon already says, so the selection we
            // make programmatically doesn't come back around as a write. Without it,
            // merely opening this page issued `powerprofilesctl set` — harmless while the
            // sync ran once, a write on every visit now that it re-runs.
            let syncing = false

            profileGroup.listBox.connect("row-selected", (_: any, row: any) => {
                checkIcons.forEach(i => { i.visible = false })
                if (row) {
                    const id = row.get_name()
                    if (id) {
                        checkIcons.get(id)!.visible = true
                        if (!syncing) execAsync(["powerprofilesctl", "set", id]).catch(console.error)
                    }
                }
            })

            // The profile is not ours alone: game mode swaps it on the way in and out
            // (hyprland.lua), and `powerprofilesctl` is a command anyone can run. Ask
            // again every time the page is looked at rather than trusting the first answer.
            onPageShown(() => {
                execAsync(["powerprofilesctl", "get"]).then((cur: string) => {
                    const id = cur.trim()
                    const idx = profiles.findIndex(p => p.id === id)
                    if (idx < 0) return
                    const row = profileGroup.listBox.get_row_at_index(idx)
                    if (!row) return
                    syncing = true
                    profileGroup.listBox.select_row(row)
                    syncing = false
                }).catch(console.error)
            })

            return profileGroup.box
        },
    } satisfies Record<string, ItemBuilder>
}

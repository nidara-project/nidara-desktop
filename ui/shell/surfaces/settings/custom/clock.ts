import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"
import { listGroup, settingRow, bindWhileRealized } from "../SettingsHelpers"
import regionConfig from "../../../core/RegionConfig"
import { t } from "../../../core/i18n"
import { safeDisconnect } from "../../../core/signals"

// ── Settings → Top bar → Clock → Configure (owner, 2026-09-28) ───────────────
// macOS's "Clock Options": how the BAR's clock reads — the date beside it and the
// seconds. They used to sit in Language & Region, and they live here now, once:
// what stays there is the 24/12-hour format, which is not the bar's alone (the lock
// screen and the login screen follow it too; they show the long date whatever the
// bar's is — ui/lib/clock.ts).
//
// A subpage is rebuilt on every push and is not indexed by the search, so the page
// that pushes it declares both keys (manifest `reaches`): for the search, for the
// agent's "where is it", and for the contract that every setting has a page.

const previewText = (): string => {
    try { return regionConfig.formatClock() } catch { return "—" }
}

export function buildClockOptions(): Gtk.Widget {
    const page = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 24 })

    // The bar's clock as it will read, ticking.
    const preview = new Gtk.Label({ label: previewText(), css_classes: ["region-clock-preview"], halign: Gtk.Align.CENTER })
    const previewBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL, spacing: 8, halign: Gtk.Align.CENTER,
        css_classes: ["region-preview-box"],
    })
    previewBox.append(preview)
    previewBox.append(new Gtk.Label({ label: t("settings.region.preview"), css_classes: ["nidara-row-subtitle"], halign: Gtk.Align.CENTER }))
    page.append(previewBox)

    const date = listGroup(t("settings.region.date.group"))
    date.listBox.append(settingRow("region.dateFormat"))
    page.append(date.box)

    const time = listGroup(t("settings.region.time.group"))
    time.listBox.append(settingRow("region.showSeconds"))
    page.append(time.box)

    bindWhileRealized(page, () => {
        const sync = () => { preview.label = previewText() }
        sync()
        const tick = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            preview.label = previewText()
            return GLib.SOURCE_CONTINUE
        })
        const sig = regionConfig.connect("changed", sync)
        return () => { GLib.source_remove(tick); safeDisconnect(regionConfig, sig) }
    })
    return page
}

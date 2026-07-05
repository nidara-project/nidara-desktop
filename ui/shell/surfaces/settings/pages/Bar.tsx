import { Gtk } from "ags/gtk4"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { listGroup, pageBox, toggleRow, createRow } from "../SettingsHelpers"
import { barSettings, updateBarSettings } from "../../bar/barState"
import { LAUNCHER_ICON_PRESETS, DEFAULT_LAUNCHER_ICON } from "../../bar/Bar"
import { t } from "../../../core/i18n"
import { NidaraButton } from "../../../../lib/nidara-kit"

function resolveCurrentPath(key: string): string | null {
    if (LAUNCHER_ICON_PRESETS[key]) return LAUNCHER_ICON_PRESETS[key]
    if (key.startsWith("/") && GLib.file_test(key, GLib.FileTest.EXISTS)) return key
    return null
}

export default function BarPage() {
    const page = pageBox("bar-page")

    // ── Layout group ──────────────────────────────────────────────────────────
    const layoutGroup = listGroup(t("settings.bar.group.layout"))

    layoutGroup.listBox.append(toggleRow(
        t("settings.bar.system-menu"),
        t("settings.bar.system-menu.desc"),
        barSettings.showSystemMenu,
        (v) => updateBarSettings({ showSystemMenu: v }),
    ))
    layoutGroup.listBox.append(toggleRow(
        t("settings.bar.app-title"),
        t("settings.bar.app-title.desc"),
        barSettings.showAppTitle,
        (v) => updateBarSettings({ showAppTitle: v }),
    ))
    layoutGroup.listBox.append(toggleRow(
        t("settings.bar.workspaces"),
        t("settings.bar.workspaces.desc"),
        barSettings.showWorkspaces,
        (v) => updateBarSettings({ showWorkspaces: v }),
    ))

    page.append(layoutGroup.box)

    // ── Launcher icon group ───────────────────────────────────────────────────
    const iconGroup = listGroup(t("settings.bar.group.icon"))

    // A launcherIcon is "custom" only when it points at an image file that still
    // exists. A preset key ("nidara") — or a stale value from before the rebrand
    // ("arch") — is treated as the default: the bar falls back to the built-in
    // mark, so the page must show the same, not the raw string. (This is why the
    // old free-text entry showed a literal "arch": it echoed the raw value.)
    const isCustomIcon = (key: string) =>
        key.startsWith("/") && GLib.file_test(key, GLib.FileTest.EXISTS)

    // Live preview of whatever the bar is actually showing.
    const preview = new Gtk.Image({ pixel_size: 24, valign: Gtk.Align.CENTER })
    const refreshPreview = () => {
        const path = resolveCurrentPath(barSettings.launcherIcon)
            ?? LAUNCHER_ICON_PRESETS[DEFAULT_LAUNCHER_ICON]
        preview.gicon = Gio.FileIcon.new(Gio.File.new_for_path(path))
    }
    refreshPreview()

    // "Default" restores the built-in Nidara mark; disabled while already on it.
    const resetBtn = NidaraButton({
        label: t("settings.bar.icon-preset"),
        variant: "secondary",
        pill: true,
        valign: Gtk.Align.CENTER,
        sensitive: isCustomIcon(barSettings.launcherIcon),
    })
    resetBtn.connect("clicked", () => {
        updateBarSettings({ launcherIcon: DEFAULT_LAUNCHER_ICON })
        resetBtn.sensitive = false
        refreshPreview()
    })

    // "Choose image…" opens a native file dialog (SVG/PNG), mirroring
    // Settings → Apps → App Icons. No free-text path — you pick a file.
    const chooseBtn = NidaraButton({
        label: t("settings.apps.choose-image"),
        variant: "primary",
        pill: true,
        valign: Gtk.Align.CENTER,
    })
    chooseBtn.connect("clicked", () => {
        const fd = new Gtk.FileDialog({ title: t("settings.apps.dialog.select-icon"), modal: true })
        const filter = new Gtk.FileFilter()
        filter.add_mime_type("image/svg+xml")
        filter.add_mime_type("image/png")
        filter.set_name(t("settings.apps.filter.images"))
        const filters = new Gio.ListStore({ item_type: Gtk.FileFilter.$gtype })
        filters.append(filter)
        fd.set_filters(filters)
        const win = chooseBtn.get_root() as Gtk.Window | null
        fd.open(win, null, (_: any, res: any) => {
            try {
                const path = fd.open_finish(res)?.get_path()
                if (path) {
                    updateBarSettings({ launcherIcon: path })
                    resetBtn.sensitive = true
                    refreshPreview()
                }
            } catch {}
        })
    })

    const controlBox = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })
    controlBox.append(preview)
    controlBox.append(chooseBtn)
    controlBox.append(resetBtn)

    iconGroup.listBox.append(createRow(
        t("settings.bar.icon-custom"),
        t("settings.bar.icon-custom.desc"),
        controlBox,
    ))

    page.append(iconGroup.box)

    return page
}

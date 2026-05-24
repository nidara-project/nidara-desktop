import { Gtk } from "ags/gtk4"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { listGroup, pageHeader, pageBox, toggleRow, createRow } from "../SettingsHelpers"
import { barSettings, updateBarSettings } from "../../bar/barState"
import { LAUNCHER_ICON_PRESETS } from "../../bar/Bar"
import { t } from "../../../core/i18n"
import Icons from "../../../core/Icons"
import { CrystalButton } from "../../../../lib/crystal-ui"

function resolveCurrentPath(key: string): string | null {
    if (LAUNCHER_ICON_PRESETS[key]) return LAUNCHER_ICON_PRESETS[key]
    if (key.startsWith("/") && GLib.file_test(key, GLib.FileTest.EXISTS)) return key
    return null
}

export default function BarPage() {
    const page = pageBox("bar-page")
    page.append(pageHeader(t("settings.bar.title"), t("settings.bar.subtitle")))

    // ── Layout group ──────────────────────────────────────────────────────────
    const layoutGroup = listGroup(t("settings.bar.group.layout"))

    layoutGroup.listBox.append(toggleRow(
        t("settings.bar.row.label.system-menu"),
        t("settings.bar.row.desc.system-menu"),
        barSettings.showSystemMenu,
        (v) => updateBarSettings({ showSystemMenu: v }),
    ))
    layoutGroup.listBox.append(toggleRow(
        t("settings.bar.row.label.app-title"),
        t("settings.bar.row.desc.app-title"),
        barSettings.showAppTitle,
        (v) => updateBarSettings({ showAppTitle: v }),
    ))
    layoutGroup.listBox.append(toggleRow(
        t("settings.bar.row.label.workspaces"),
        t("settings.bar.row.desc.workspaces"),
        barSettings.showWorkspaces,
        (v) => updateBarSettings({ showWorkspaces: v }),
    ))

    page.append(layoutGroup.box)

    // ── Launcher icon group ───────────────────────────────────────────────────
    const iconGroup = listGroup(t("settings.bar.group.icon"))

    // Preview + reset-to-default chip
    const preview = new Gtk.Image({ pixel_size: 24, valign: Gtk.Align.CENTER })
    const refreshPreview = () => {
        const path = resolveCurrentPath(barSettings.launcherIcon)
        if (path) preview.gicon = Gio.FileIcon.new(Gio.File.new_for_path(path))
        else { preview.gicon = null; preview.gicon = Icons.grid }
    }
    refreshPreview()

    const resetBtn = new Gtk.Button({
        label: "Arch",
        css_classes: ["launcher-icon-btn", ...(barSettings.launcherIcon === "arch" ? ["selected"] : [])],
        valign: Gtk.Align.CENTER,
    })
    resetBtn.connect("clicked", () => {
        updateBarSettings({ launcherIcon: "arch" })
        customEntry.text = ""
        resetBtn.add_css_class("selected")
        refreshPreview()
    })

    const previewBox = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })
    previewBox.append(preview)
    previewBox.append(resetBtn)

    iconGroup.listBox.append(createRow(
        t("settings.bar.row.label.icon-preset"),
        t("settings.bar.row.desc.icon-preset"),
        previewBox,
    ))

    // Custom path row
    const customEntry = new Gtk.Entry({
        placeholder_text: "/path/to/icon.svg",
        text: LAUNCHER_ICON_PRESETS[barSettings.launcherIcon] ? "" : (barSettings.launcherIcon || ""),
        width_chars: 28,
        valign: Gtk.Align.CENTER,
    })

    const applyCustom = () => {
        const v = customEntry.text.trim()
        if (!v) return
        updateBarSettings({ launcherIcon: v })
        resetBtn.remove_css_class("selected")
        refreshPreview()
    }
    customEntry.connect("activate", applyCustom)

    const applyBtn = CrystalButton({
        label: t("settings.region.tz.apply"),
        variant: "primary",
        pill: true,
        valign: Gtk.Align.CENTER,
    })
    applyBtn.connect("clicked", applyCustom)

    const customBox = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER })
    customBox.append(customEntry)
    customBox.append(applyBtn)

    iconGroup.listBox.append(createRow(
        t("settings.bar.row.label.icon-custom"),
        t("settings.bar.row.desc.icon-custom"),
        customBox,
    ))

    page.append(iconGroup.box)

    return page
}

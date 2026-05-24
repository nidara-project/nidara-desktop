import { Gtk, Gdk } from "ags/gtk4"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import GdkPixbuf from "gi://GdkPixbuf"
import Gaming, { type WallpaperMode } from "../../../core/GamingManager"
import { TRANSITION_LABELS, type TransitionType } from "../../../core/WallpaperManager"
import { t } from "../../../core/i18n"
import { listGroup, createRow, toggleRow, dropdownRow, pageHeader, pageBox } from "../SettingsHelpers"
import { CrystalButton } from "../../../../lib/crystal-ui"

export default function GamingPage() {
    const page = pageBox("gaming-page")
    page.append(pageHeader(
        t("settings.gaming.page.title.gaming"),
        t("settings.gaming.page.subtitle.configura-el-modo-juego"),
    ))

    // ── Wallpaper ─────────────────────────────────────────────────────────────
    const wallGroup = listGroup(t("settings.gaming.group.wallpaper"))

    // Mode selector — three linked toggle buttons
    const modes: { key: WallpaperMode; label: string }[] = [
        { key: "artwork", label: t("settings.gaming.mode.artwork") },
        { key: "custom",  label: t("settings.gaming.mode.custom")  },
        { key: "none",    label: t("settings.gaming.mode.none")    },
    ]

    const modeBox = new Gtk.Box({
        spacing: 0,
        homogeneous: true,
        css_classes: ["settings-preset-group", "linked"],
        valign: Gtk.Align.CENTER,
    })

    const modeButtons: Record<WallpaperMode, Gtk.ToggleButton> = {} as any
    modes.forEach(({ key, label }) => {
        const btn = new Gtk.ToggleButton({
            label,
            active: Gaming.wallpaperMode === key,
            css_classes: ["settings-preset-btn"],
        })
        btn.connect("toggled", () => {
            if (!btn.active) return
            modes.forEach(m => { if (m.key !== key) modeButtons[m.key].active = false })
            Gaming.setWallpaperMode(key)
            updateCustomVisible()
        })
        modeButtons[key] = btn
        modeBox.append(btn)
    })

    wallGroup.listBox.append(createRow(
        t("settings.gaming.row.label.wallpaper-mode"),
        t("settings.gaming.row.desc.wallpaper-mode"),
        modeBox,
    ))

    // Custom wallpaper preview + picker (visible only when mode = "custom")
    const preview = new Gtk.Picture({
        width_request: 320,
        height_request: 180,
        content_fit: Gtk.ContentFit.COVER,
        css_classes: ["wallpaper-preview"],
        halign: Gtk.Align.CENTER,
    })

    const updatePreview = (path: string) => {
        if (!path || !GLib.file_test(path, GLib.FileTest.EXISTS)) return
        try {
            const pixbuf = GdkPixbuf.Pixbuf.new_from_file(path)
            if (pixbuf) preview.set_paintable(Gdk.Texture.new_for_pixbuf(pixbuf))
        } catch (_) { preview.set_filename(path) }
    }
    updatePreview(Gaming.customWallpaper)

    const previewRow = new Gtk.ListBoxRow({ css_classes: ["settings-item-row", "wallpaper-preview-row"] })
    previewRow.set_child(preview)
    wallGroup.listBox.append(previewRow)

    const pickBtn = CrystalButton({
        label: t("settings.appearance.label.explorar"),
        variant: "secondary",
        pill: true,
        valign: Gtk.Align.CENTER,
    })
    pickBtn.connect("clicked", () => {
        const dialog = new Gtk.FileDialog({
            title: t("settings.gaming.dialog.title.seleccionar-wallpaper"),
            modal: true,
        })
        const filter = new Gtk.FileFilter()
        filter.add_mime_type("image/jpeg")
        filter.add_mime_type("image/png")
        filter.add_mime_type("image/gif")
        filter.add_mime_type("image/webp")
        filter.set_name(t("settings.appearance.filter.imagenes"))
        const filters = new Gio.ListStore({ item_type: Gtk.FileFilter.$gtype })
        filters.append(filter)
        dialog.set_filters(filters)
        dialog.set_initial_folder(Gio.File.new_for_path(GLib.get_home_dir()))
        dialog.open(null, null, (_: any, result: any) => {
            try {
                const file = dialog.open_finish(result)
                const path = file?.get_path()
                if (path) {
                    Gaming.setCustomWallpaper(path)
                    updatePreview(path)
                }
            } catch (_) {}
        })
    })

    const pickerRow = createRow(
        t("settings.gaming.row.label.custom-wallpaper"),
        t("settings.gaming.row.desc.custom-wallpaper"),
        pickBtn,
    )
    wallGroup.listBox.append(pickerRow)

    const updateCustomVisible = () => {
        const isCustom = Gaming.wallpaperMode === "custom"
        previewRow.visible = isCustom
        pickerRow.visible  = isCustom
    }
    updateCustomVisible()

    // Transition selector (reuse same labels as WallpaperManager)
    const transitions = Object.keys(TRANSITION_LABELS) as TransitionType[]
    const transLabels = transitions.map(k => TRANSITION_LABELS[k])
    wallGroup.listBox.append(dropdownRow(
        t("settings.appearance.row.label.transicion"),
        t("settings.gaming.row.desc.transicion"),
        TRANSITION_LABELS[Gaming.transition],
        transLabels,
        (label) => {
            const key = transitions.find(k => TRANSITION_LABELS[k] === label)
            if (key) Gaming.setTransition(key)
        },
    ))

    page.append(wallGroup.box)

    // ── Performance ───────────────────────────────────────────────────────────
    const perfGroup = listGroup(t("settings.gaming.group.rendimiento"))

    perfGroup.listBox.append(toggleRow(
        t("settings.gaming.row.label.performance-profile"),
        t("settings.gaming.row.desc.performance-profile"),
        Gaming.performanceProfile,
        (v) => Gaming.setPerformanceProfile(v),
    ))

    page.append(perfGroup.box)

    return page
}

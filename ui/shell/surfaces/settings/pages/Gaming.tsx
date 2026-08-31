import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import Gaming, { type WallpaperMode } from "../../../core/GamingManager"
import Wallpaper from "../../../core/WallpaperManager"
import { t } from "../../../core/i18n"
import { listGroup, createRow, pageBox, segmentedGroup, settingRow } from "../SettingsHelpers"
import { NidaraButton } from "../../../../lib/nidara-kit"

export default function GamingPage() {
    const page = pageBox("gaming-page")

    // ── Wallpaper ─────────────────────────────────────────────────────────────
    const wallGroup = listGroup(t("settings.gaming.group.wallpaper"))

    // Mode selector — the shared segmented control. It used to be a hand-rolled
    // group of Gtk.ToggleButtons, and a ToggleButton that is already active turns
    // OFF when clicked: the handler bailed on `!btn.active`, so clicking the
    // selected mode left the control showing NOTHING selected while that mode was
    // still in force. `segmentedGroup` has no empty state to fall into.
    const modeBox = segmentedGroup<WallpaperMode>(
        [
            { value: "artwork", label: t("settings.gaming.mode.artwork") },
            { value: "custom",  label: t("settings.gaming.mode.custom")  },
            { value: "none",    label: t("settings.gaming.mode.none")    },
        ],
        Gaming.wallpaperMode,
        (mode) => {
            Gaming.setWallpaperMode(mode)
            updateCustomVisible()
        },
    )

    wallGroup.listBox.append(createRow(
        t("settings.gaming.wallpaper-mode"),
        t("settings.gaming.wallpaper-mode.desc"),
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
        if (!path) return
        Wallpaper.getThumbnailTexture(path, 640, 360).then(tex => {
            if (tex) preview.set_paintable(tex)
        })
    }
    updatePreview(Gaming.customWallpaper)

    const previewRow = new Gtk.ListBoxRow({ css_classes: ["nidara-row", "wallpaper-preview-row"] })
    previewRow.set_child(preview)
    wallGroup.listBox.append(previewRow)

    const pickBtn = NidaraButton({
        label: t("settings.appearance.browse"),
        variant: "secondary",
        pill: true,
        valign: Gtk.Align.CENTER,
    })
    pickBtn.connect("clicked", () => {
        const dialog = new Gtk.FileDialog({
            title: t("settings.gaming.dialog.wallpaper"),
            modal: true,
        })
        const filter = new Gtk.FileFilter()
        filter.add_mime_type("image/jpeg")
        filter.add_mime_type("image/png")
        filter.add_mime_type("image/gif")
        filter.add_mime_type("image/webp")
        filter.set_name(t("settings.appearance.filter.images"))
        const filters = new Gio.ListStore({ item_type: Gtk.FileFilter.$gtype })
        filters.append(filter)
        dialog.set_filters(filters)
        dialog.set_initial_folder(Gio.File.new_for_path(GLib.get_home_dir()))
        // Parent to the Settings window so it floats/centers over it (not tiled).
        dialog.open(pickBtn.get_root() as Gtk.Window, null, (_: any, result: any) => {
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
        t("settings.gaming.custom-wallpaper"),
        t("settings.gaming.custom-wallpaper.desc"),
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
    wallGroup.listBox.append(settingRow("gaming.transition"))

    page.append(wallGroup.box)

    // ── Performance ───────────────────────────────────────────────────────────
    const perfGroup = listGroup(t("settings.gaming.group.performance"))

    perfGroup.listBox.append(settingRow("gaming.performanceProfile"))

    page.append(perfGroup.box)

    return page
}


import Gtk from "gi://Gtk?version=4.0"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import Gaming from "../../../core/GamingManager"
import Wallpaper from "../../../core/WallpaperManager"
import { t } from "../../../core/i18n"
import { createRow } from "../SettingsHelpers"
import { NidaraButton } from "../../../../lib/nidara-kit"
import type { PageCtx, ItemBuilder } from "../PreferencePage"

export const build = (_ctx: PageCtx) => {
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

    return {
        customWallpaperPreview: () => {
            const previewRow = new Gtk.ListBoxRow({ css_classes: ["nidara-row", "wallpaper-preview-row"] })
            previewRow.set_child(preview)
            return previewRow
        },
        customWallpaperPicker: () => {
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

            return createRow(
                t("settings.gaming.custom-wallpaper"),
                t("settings.gaming.custom-wallpaper.desc"),
                pickBtn,
            )
        },
    } satisfies Record<string, ItemBuilder>
}

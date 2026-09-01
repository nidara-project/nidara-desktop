import Gtk from "gi://Gtk?version=4.0"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import Theme from "../../../core/ThemeManager"
import { NidaraButton, NidaraFontButton, makeHSlider, NidaraRow } from "../../../../lib/nidara-kit"
import NightLight from "../../../core/NightLightManager"
import Wallpaper from "../../../core/WallpaperManager"
import { getBundledWallpapers } from "../../../../lib/wallpaper"
import { ACCENT_PALETTE, GLASS_RANGE, type AccentKey } from "../../../core/NidaraTheme"
import { t } from "../../../core/i18n"
import Icons from "../../../core/Icons"
import { createRow, bindWhileRealized } from "../SettingsHelpers"
import { attachTooltip } from "../../../common/Tooltip"
import { safeDisconnect } from "../../../core/signals"
import type { PageCtx, ItemBuilder } from "../PreferencePage"

export const build = (ctx: PageCtx) => {
    const onTheme = <T,>(read: () => T) => (apply: (v: T) => void) => {
        apply(read())
        const id = Theme.connect("changed", () => apply(read()))
        return () => safeDisconnect(Theme, id)
    }

    // ── Wallpaper Preview ───────────────────────────────────────────────────
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
    updatePreview(Wallpaper.current)
    Wallpaper.refreshFromDaemon()

    const previewCenter = new Gtk.CenterBox({
        center_widget: preview,
        hexpand: true,
    })
    const previewRow = new Gtk.ListBoxRow({
        css_classes: ["nidara-row", "wallpaper-preview-row"],
        activatable: false,
        selectable: false,
    })
    previewRow.set_child(previewCenter)

    // ── Bundled Wallpapers Gallery ──────────────────────────────────────────
    const bundled = getBundledWallpapers().filter(p => !p.includes("wallpaper-greeter"))
    let refreshThumbActive: ((currentPath: string) => void) | null = null
    let galleryRow: Gtk.ListBoxRow

    if (bundled.length > 0) {
        const thumbBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            hexpand: false,
            css_classes: ["wallpaper-thumbnails-box"],
        })

        const thumbButtons: { path: string; btn: Gtk.Button }[] = []

        refreshThumbActive = (currentPath: string) => {
            const curBase = currentPath ? currentPath.split("/").pop() : ""
            for (const item of thumbButtons) {
                const itemBase = item.path.split("/").pop()
                if (item.path === currentPath || (curBase && itemBase === curBase)) {
                    item.btn.add_css_class("active")
                } else {
                    item.btn.remove_css_class("active")
                }
            }
        }

        for (const wallPath of bundled) {
            const thumbPic = new Gtk.Picture({
                width_request: 80,
                height_request: 45,
                content_fit: Gtk.ContentFit.COVER,
            })
            Wallpaper.getThumbnailTexture(wallPath, 160, 90).then(tex => {
                if (tex) thumbPic.set_paintable(tex)
            })

            const btn = new Gtk.Button({
                css_classes: ["wallpaper-thumb-btn"],
                valign: Gtk.Align.CENTER,
            })
            btn.set_child(thumbPic)
            btn.connect("clicked", () => {
                Wallpaper.setWallpaper(wallPath)
                updatePreview(wallPath)
                if (refreshThumbActive) refreshThumbActive(wallPath)
            })

            thumbBox.append(btn)
            thumbButtons.push({ path: wallPath, btn })
        }

        refreshThumbActive(Wallpaper.current)

        const centerBox = new Gtk.CenterBox({
            center_widget: thumbBox,
            hexpand: true,
        })
        galleryRow = new Gtk.ListBoxRow({
            css_classes: ["nidara-row", "wallpaper-gallery-row"],
            activatable: false,
            selectable: false,
        })
        galleryRow.set_child(centerBox)
    } else {
        galleryRow = new Gtk.ListBoxRow({
            css_classes: ["nidara-row", "wallpaper-gallery-row"],
            activatable: false,
            selectable: false,
            visible: false,
        })
    }

    // ── Wallpaper File Picker ───────────────────────────────────────────────
    const changeBtn = NidaraButton({
        label: t("settings.appearance.browse"),
        variant: "secondary",
        pill: true,
        valign: Gtk.Align.CENTER,
    })
    changeBtn.connect("clicked", () => {
        const dialog = new Gtk.FileDialog({
            title: t("settings.appearance.dialog.wallpaper"),
            modal: true,
        })
        const filter = new Gtk.FileFilter()
        filter.add_mime_type("image/jpeg")
        filter.add_mime_type("image/png")
        filter.add_mime_type("image/gif")
        filter.add_mime_type("image/webp")
        filter.add_mime_type("image/avif")
        filter.set_name(t("settings.appearance.filter.images"))
        const filters = new Gio.ListStore({ item_type: Gtk.FileFilter.$gtype })
        filters.append(filter)
        dialog.set_filters(filters)

        dialog.set_initial_folder(Gio.File.new_for_path(GLib.get_home_dir()))

        // Parent the dialog to the Settings window so it opens modal/centered over
        // it (like the font picker) instead of as an unparented, tiled toplevel.
        dialog.open(changeBtn.get_root() as Gtk.Window, null, (_: any, result: any) => {
            try {
                const file = dialog.open_finish(result)
                const path = file?.get_path()
                if (path) {
                    Wallpaper.setWallpaper(path)
                    updatePreview(path)
                }
            } catch (_) { /* user cancelled */ }
        })
    })

    // Unconditionally follow wallpaper changes from external tools/gaming mode.
    // Use bindWhileRealized because Settings hides rather than destroys its window.
    bindWhileRealized(ctx.page, () => {
        updatePreview(Wallpaper.current)
        if (refreshThumbActive) refreshThumbActive(Wallpaper.current)
        const wallId = Wallpaper.connect("changed", () => {
            updatePreview(Wallpaper.current)
            if (refreshThumbActive) refreshThumbActive(Wallpaper.current)
        })
        return () => safeDisconnect(Wallpaper, wallId)
    })

    // ── Accent Color Picker ─────────────────────────────────────────────────
    const accentPicker = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER, halign: Gtk.Align.END })
    const accentButtons: Record<string, Gtk.Button> = {}

    Object.keys(ACCENT_PALETTE).forEach(key => {
        const { name } = ACCENT_PALETTE[key as AccentKey]
        const btn = new Gtk.Button({
            css_classes: [`accent-${key}`, "accent-circle-btn"],
            width_request: 28,
            height_request: 28,
        })
        attachTooltip(btn, name, { chrome: false })
        if (Theme.accentColor === key) btn.add_css_class("selected")
        btn.connect("clicked", () => Theme.setAccentColor(key as AccentKey))
        accentPicker.append(btn)
        accentButtons[key] = btn
    })

    // State sync for accent swatches
    const updateThemeState = () => {
        const currentAccent = Theme.accentColor
        Object.keys(accentButtons).forEach(key => {
            accentButtons[key].remove_css_class("selected")
            if (key === currentAccent) accentButtons[key].add_css_class("selected")
        })
    }
    bindWhileRealized(ctx.page, () => {
        updateThemeState()
        const id = Theme.connect("changed", updateThemeState)
        return () => safeDisconnect(Theme, id)
    })

    // ── Master Glass Opacity Slider ─────────────────────────────────────────
    // Opacity model: ONE master "Glass" slider governs bar + overlays + dock + window
    // together; an "Advanced" disclosure (below) breaks them apart. All are plain
    // opacities (higher = more opaque) over ONE `GLASS_RANGE`, imported rather than
    // retyped — the bounds used to be five literals here plus a sixth in
    // `clampOpacity`, which is five chances to offer a value the clamp refuses.
    const glassSurfaces = () => [Theme.barOpacity, Theme.overlayOpacity, Theme.dockOpacity, Theme.windowOpacity]
    const glassUniform = () => { const s = glassSurfaces(); return s.every(v => Math.abs(v - s[0]) < 0.005) }
    const glassRepr = () => Math.max(...glassSurfaces())   // thumb at the peak while mixed

    const masterValue = new Gtk.Label({ css_classes: ["slider-value-label"], width_chars: 5, xalign: 1.0 })
    const masterSlider = makeHSlider({
        min: GLASS_RANGE.min, max: GLASS_RANGE.max, value: glassRepr(),
        onChange: (v) => Theme.setGlassOpacity(v),
        onValueChanged: (v) => { masterValue.label = `${Math.round(v * 100)}%` }, // drag unifies → show %
        onExtChange: onTheme(glassRepr),
        debounce: 32,
        width_request: 140,
    })
    // Runs AFTER makeSlider's own %-label sync (connected earlier, during construction),
    // so the "—" / mute wins whenever the surfaces disagree.
    const syncMaster = () => {
        const uni = glassUniform()
        masterValue.label = uni ? `${Math.round(glassRepr() * 100)}%` : "—"
        masterSlider.opacity = uni ? 1 : 0.55
    }
    bindWhileRealized(masterSlider, () => {
        syncMaster()
        const masterSyncId = Theme.connect("changed", syncMaster)
        return () => safeDisconnect(Theme, masterSyncId)
    })

    const masterBox = new Gtk.Box({ spacing: 12, valign: Gtk.Align.CENTER, hexpand: false })
    const mkGlassEnd = (icon: Gio.FileIcon) => new Gtk.Image({ gicon: icon, pixel_size: 16, opacity: 0.5, css_classes: ["nd-icon"], valign: Gtk.Align.CENTER })
    masterBox.append(mkGlassEnd(Icons.minus))
    masterBox.append(masterSlider)
    masterBox.append(mkGlassEnd(Icons.plus))
    masterBox.append(masterValue)

    // ── Night Light Schedule Times ──────────────────────────────────────────
    const timePicker = (initial: string, onChange: (t: string) => void) => {
        const [ih, im] = initial.split(":").map(Number)
        const safeH = isNaN(ih) ? 20 : Math.max(0, Math.min(23, ih))
        const safeM = isNaN(im) ? 0  : Math.max(0, Math.min(59, im))

        const makeSpin = (lo: number, hi: number, val: number) => {
            const spin = new Gtk.SpinButton({
                adjustment: new Gtk.Adjustment({ lower: lo, upper: hi, step_increment: 1, value: val }),
                width_chars: 2, wrap: true, numeric: true, digits: 0,
                valign: Gtk.Align.CENTER,
                css_classes: ["time-spin"],
            })
            spin.connect("output", () => {
                spin.set_text(String(Math.round(spin.value)).padStart(2, "0"))
                return true
            })
            return spin
        }

        const hSpin = makeSpin(0, 23, safeH)
        const mSpin = makeSpin(0, 59, safeM)

        let syncing = false
        const emit = () => {
            if (syncing) return
            const h = String(Math.round(hSpin.value)).padStart(2, "0")
            const m = String(Math.round(mSpin.value)).padStart(2, "0")
            onChange(`${h}:${m}`)
        }
        hSpin.connect("value-changed", emit)
        mSpin.connect("value-changed", emit)

        const box = new Gtk.Box({ spacing: 4, valign: Gtk.Align.CENTER })
        box.append(hSpin)
        box.append(new Gtk.Label({ label: ":", css_classes: ["nidara-row-subtitle"] }))
        box.append(mSpin)
        const sync = (time: string) => {
            const [h, m] = time.split(":").map(Number)
            if (isNaN(h) || isNaN(m)) return
            syncing = true
            hSpin.value = h
            mSpin.value = m
            syncing = false
        }
        return { box, sync }
    }

    const schedTimeBox = new Gtk.Box({ spacing: 24, valign: Gtk.Align.CENTER })

    const from = timePicker(NightLight.scheduleFrom, (v) => NightLight.setScheduleFrom(v))
    const to   = timePicker(NightLight.scheduleTo,   (v) => NightLight.setScheduleTo(v))

    const fromBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 })
    fromBox.append(new Gtk.Label({ label: t("settings.appearance.night-light-from"), halign: Gtk.Align.START, css_classes: ["nidara-row-subtitle"] }))
    fromBox.append(from.box)

    const toBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 })
    toBox.append(new Gtk.Label({ label: t("settings.appearance.night-light-to"), halign: Gtk.Align.START, css_classes: ["nidara-row-subtitle"] }))
    toBox.append(to.box)

    schedTimeBox.append(fromBox)
    schedTimeBox.append(toBox)

    const schedTimeRow = NidaraRow("", "", schedTimeBox)

    const syncNightLightTimes = () => {
        from.sync(NightLight.scheduleFrom)
        to.sync(NightLight.scheduleTo)
    }
    bindWhileRealized(ctx.page, () => {
        syncNightLightTimes()
        const nlChangedId = NightLight.connect("changed", syncNightLightTimes)
        return () => safeDisconnect(NightLight, nlChangedId)
    })

    // ── Fonts ───────────────────────────────────────────────────────────────
    // Inside NidaraFontButton, title is used in the font picker modal dialog.
    // The row label and subtitle are rendered via createRow from slot.title/slot.subtitle.
    const makeInterfaceFontBtn = (title: string) => NidaraFontButton({
        font: Theme.interfaceFont,
        title,
        onFontSet: (f) => Theme.setFont(f),
        onExtChange: onTheme(() => Theme.interfaceFont),
    })

    const makeMonoFontBtn = (title: string) => NidaraFontButton({
        font: Theme.monoFont,
        title,
        onFontSet: (f) => Theme.setMonoFont(f),
        onExtChange: onTheme(() => Theme.monoFont),
    })

    return {
        wallpaperPreview: () => previewRow,
        wallpaperGallery: () => galleryRow,
        wallpaperPicker: (slot) => createRow(slot.title, slot.subtitle, changeBtn),
        accentPicker: (slot) => createRow(slot.title, slot.subtitle, accentPicker),
        glassMaster: (slot) => createRow(slot.title, slot.subtitle, masterBox),
        nightScheduleTimes: () => schedTimeRow,
        interfaceFont: (slot) => createRow(slot.title, slot.subtitle, makeInterfaceFontBtn(slot.title)),
        monoFont: (slot) => createRow(slot.title, slot.subtitle, makeMonoFontBtn(slot.title)),
    } satisfies Record<string, ItemBuilder>
}

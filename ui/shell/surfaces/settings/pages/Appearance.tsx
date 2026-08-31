import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import Theme from "../../../core/ThemeManager"
import { NidaraButton, NidaraFontButton, makeHSlider } from "../../../../lib/nidara-kit"
import NightLight from "../../../core/NightLightManager"
import Wallpaper from "../../../core/WallpaperManager"
import { getBundledWallpapers } from "../../../../lib/wallpaper"
import { ACCENT_PALETTE, GLASS_RANGE, type AccentKey } from "../../../core/NidaraTheme"
import { t } from "../../../core/i18n"
import Icons from "../../../core/Icons"
import { listGroup, createRow, settingRow, pageBox, bindWhileRealized } from "../SettingsHelpers"
import { attachTooltip } from "../../../common/Tooltip"
import { safeDisconnect } from "../../../core/signals"

export default function AppearancePage() {
    const page = pageBox("appearance-page")

    const onTheme = <T,>(read: () => T) => (apply: (v: T) => void) => {
        apply(read())
        const id = Theme.connect("changed", () => apply(read()))
        return () => safeDisconnect(Theme, id)
    }

    // 1. General style
    const styleGroup = listGroup(t("settings.appearance.group.base-style"))
    styleGroup.listBox.append(settingRow("appearance.darkMode"))
    styleGroup.listBox.append(settingRow("appearance.shellAppearance"))
    page.append(styleGroup.box)

    // 2. Wallpaper
    const wallGroup = listGroup(t("settings.appearance.group.wallpaper"))

    // Preview
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
    wallGroup.listBox.append(previewRow)

    // Bundled wallpapers gallery
    const bundled = getBundledWallpapers().filter(p => !p.includes("wallpaper-greeter"))
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

        const refreshThumbActive = (currentPath: string) => {
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
                refreshThumbActive(wallPath)
            })

            thumbBox.append(btn)
            thumbButtons.push({ path: wallPath, btn })
        }

        refreshThumbActive(Wallpaper.current)
        const wallId = Wallpaper.connect("changed", () => {
            updatePreview(Wallpaper.current)
            refreshThumbActive(Wallpaper.current)
        })
        page.connect("destroy", () => safeDisconnect(Wallpaper, wallId))

        const centerBox = new Gtk.CenterBox({
            center_widget: thumbBox,
            hexpand: true,
        })
        const galleryRow = new Gtk.ListBoxRow({
            css_classes: ["nidara-row", "wallpaper-gallery-row"],
            activatable: false,
            selectable: false,
        })
        galleryRow.set_child(centerBox)
        wallGroup.listBox.append(galleryRow)
    }

    // Transition selector
    wallGroup.listBox.append(settingRow("wallpaper.transition"))

    // File picker row
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
    wallGroup.listBox.append(createRow(
        t("settings.appearance.image"),
        t("settings.appearance.image.desc"),
        changeBtn,
    ))

    page.append(wallGroup.box)

    // 3. Theme — accent + glass opacity
    const fcGroup = listGroup(t("settings.appearance.group.theme"))

    // Accent Color Picker
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

    fcGroup.listBox.append(createRow(t("settings.appearance.accent"), t("settings.appearance.accent.desc"), accentPicker))

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
    fcGroup.listBox.append(createRow(t("settings.appearance.glass"), t("settings.appearance.glass.desc"), masterBox))

    // Advanced — per-surface glass.
    const advChevron = new Gtk.Image({ gicon: Icons.chevronDown, pixel_size: 16, css_classes: ["nd-icon"] })
    const advToggleRow = createRow(t("settings.appearance.advanced"), "", advChevron)
    fcGroup.listBox.append(advToggleRow)

    const advInner = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL })
    advInner.append(settingRow("appearance.barOpacity"))
    advInner.append(settingRow("appearance.overlayOpacity"))
    advInner.append(settingRow("appearance.dockOpacity"))
    advInner.append(settingRow("appearance.windowOpacity"))
    const advRevealer = new Gtk.Revealer({ transition_type: Gtk.RevealerTransitionType.SLIDE_DOWN, reveal_child: true })
    advRevealer.set_child(advInner)
    const advRevealerRow = new Gtk.ListBoxRow({ activatable: false, selectable: false, css_classes: ["settings-adv-revealer-row"] })
    advRevealerRow.set_child(advRevealer)
    fcGroup.listBox.append(advRevealerRow)

    fcGroup.listBox.connect("row-activated", (_: Gtk.ListBox, row: Gtk.ListBoxRow) => {
        if (row !== advToggleRow) return
        const open = !advRevealer.reveal_child
        advRevealer.reveal_child = open
        advChevron.gicon = open ? Icons.chevronDown : Icons.chevronRight
    })
    page.append(fcGroup.box)

    // 4. Night Light
    const nlGroup = listGroup(t("settings.appearance.group.night-light"))

    const nlRow = settingRow("nightlight.enabled")
    nlGroup.listBox.append(nlRow)
    nlGroup.listBox.append(settingRow("nightlight.temperature"))
    const schedRow = settingRow("nightlight.scheduleEnabled")
    nlGroup.listBox.append(schedRow)

    // Time pickers helper
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

    const schedTimeRow = createRow("", "", schedTimeBox)
    schedTimeRow.visible = NightLight.scheduleEnabled
    nlGroup.listBox.append(schedTimeRow)

    const syncNightLight = () => {
        nlRow.sensitive = !NightLight.scheduleEnabled
        schedTimeRow.visible = NightLight.scheduleEnabled
        from.sync(NightLight.scheduleFrom)
        to.sync(NightLight.scheduleTo)
    }
    bindWhileRealized(page, () => {
        syncNightLight()
        const nlChangedId = NightLight.connect("changed", syncNightLight)
        return () => safeDisconnect(NightLight, nlChangedId)
    })

    page.append(nlGroup.box)

    // 5. System Assets
    const assetsGroup = listGroup(t("settings.appearance.group.resources"))
    assetsGroup.listBox.append(settingRow("appearance.gtkTheme"))
    assetsGroup.listBox.append(settingRow("appearance.iconTheme"))
    assetsGroup.listBox.append(settingRow("appearance.cursorTheme"))
    page.append(assetsGroup.box)

    // 6. Fonts
    const fontsGroup = listGroup(t("settings.appearance.group.fonts"))

    const interfaceFontBtn = NidaraFontButton({
        font: Theme.interfaceFont,
        title: t("settings.appearance.interface-font"),
        onFontSet: (f) => Theme.setFont(f),
        onExtChange: onTheme(() => Theme.interfaceFont),
    })
    fontsGroup.listBox.append(createRow(
        t("settings.appearance.interface-font"),
        t("settings.appearance.interface-font.desc"),
        interfaceFontBtn,
    ))

    const monoFontBtn = NidaraFontButton({
        font: Theme.monoFont,
        title: t("settings.appearance.mono-font"),
        onFontSet: (f) => Theme.setMonoFont(f),
        onExtChange: onTheme(() => Theme.monoFont),
    })
    fontsGroup.listBox.append(createRow(
        t("settings.appearance.mono-font"),
        t("settings.appearance.mono-font.desc"),
        monoFontBtn,
    ))

    page.append(fontsGroup.box)

    // State sync for accent swatches
    const updateThemeState = () => {
        const currentAccent = Theme.accentColor
        Object.keys(accentButtons).forEach(key => {
            accentButtons[key].remove_css_class("selected")
            if (key === currentAccent) accentButtons[key].add_css_class("selected")
        })
    }
    bindWhileRealized(page, () => {
        updateThemeState()
        const id = Theme.connect("changed", updateThemeState)
        return () => safeDisconnect(Theme, id)
    })

    return page
}

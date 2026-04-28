import { Gtk, Gdk } from "ags/gtk4"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import GdkPixbuf from "gi://GdkPixbuf"
import Theme from "../../../core/ThemeManager"
import NightLight from "../../../core/NightLightManager"
import Wallpaper, { TRANSITION_LABELS, type TransitionType } from "../../../core/WallpaperManager"
import { ACCENT_PALETTE, type AccentKey } from "../../../core/FluidCrystal"
import { t } from "../../../core/i18n"
import Icons from "../../../core/Icons"
// @ts-ignore
import Adw from "gi://Adw?version=1"
import { listGroup, createRow, toggleRow, dropdownRow, sliderRow, pageHeader, pageBox } from "../SettingsHelpers"

export default function AppearancePage() {
    const page = pageBox("appearance-page")
    page.append(pageHeader(t("settings.appearance.page.title.apariencia"), t("settings.appearance.page.subtitle.personaliza-el-alma-visual-de-tu-sistema")))

    // 1. General style
    const styleGroup = listGroup(t("settings.appearance.group.diseno-base"))
    styleGroup.listBox.append(toggleRow(
        t("settings.appearance.row.label.modo-oscuro"),
        t("settings.appearance.row.desc.sincroniza-el-nucleo-visual-con-la-noche"),
        Theme.isDark,
        (active) => Theme.setDarkMode(active),
    ))
    page.append(styleGroup.box)

    // 2. Crystal Shell visual tokens
    const fcGroup = listGroup("Crystal Shell")

    // Accent Color Picker
    const accentPicker = new Gtk.Box({ spacing: 10, valign: Gtk.Align.CENTER })
    const accentButtons: Record<string, Gtk.Button> = {}

    Object.keys(ACCENT_PALETTE).forEach(key => {
        const { name } = ACCENT_PALETTE[key as AccentKey]
        const btn = new Gtk.Button({
            tooltip_text: name,
            css_classes: [`accent-${key}`, "accent-circle-btn"],
            width_request: 28,
            height_request: 28,
        })
        if (Theme.accentColor === key) btn.add_css_class("selected")
        btn.connect("clicked", () => Theme.setAccentColor(key as AccentKey))
        accentPicker.append(btn)
        accentButtons[key] = btn
    })

    fcGroup.listBox.append(createRow(t("settings.appearance.row.label.color-de-acento"), t("settings.appearance.row.desc.define-el-tono-vibrante-de-la-interfaz"), accentPicker))
    fcGroup.listBox.append(sliderRow(
        t("settings.appearance.row.label.transparencia-profunda"),
        t("settings.appearance.row.desc.controla-la-permeabilidad-de-la-luz-en-l"),
        Theme.transparency, 0, 1,
        (v) => Theme.setTransparency(v),
        { pct: true, icons: [Icons.sun, Icons.sun] },
    ))
    page.append(fcGroup.box)

    // 3. Night Light
    const nlGroup = listGroup(t("settings.appearance.group.night-light"))

    // Manual toggle — insensitive when schedule controls it
    const nlSwitch = new Gtk.Switch({ active: NightLight.enabled, valign: Gtk.Align.CENTER, sensitive: !NightLight.scheduleEnabled })
    nlSwitch.connect("state-set", (_: any, v: boolean) => { NightLight.setEnabled(v); return false })
    nlGroup.listBox.append(createRow(
        t("settings.appearance.row.label.night-light"),
        t("settings.appearance.row.desc.night-light"),
        nlSwitch,
    ))

    nlGroup.listBox.append(sliderRow(
        t("settings.appearance.row.label.night-light-temp"),
        t("settings.appearance.row.desc.night-light-temp"),
        NightLight.temperature, 2700, 6500,
        (v) => NightLight.setTemperature(v),
        { unit: "K", icons: [Icons.moon, Icons.sun] },
    ))

    // Schedule toggle
    const schedSwitch = new Gtk.Switch({ active: NightLight.scheduleEnabled, valign: Gtk.Align.CENTER })
    schedSwitch.connect("state-set", (_: any, v: boolean) => {
        NightLight.setScheduleEnabled(v)
        nlSwitch.sensitive = !v
        schedTimeRow.visible = v
        return false
    })
    nlGroup.listBox.append(createRow(
        t("settings.appearance.row.label.night-light-schedule"),
        t("settings.appearance.row.desc.night-light-schedule"),
        schedSwitch,
    ))

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

        const emit = () => {
            const h = String(Math.round(hSpin.value)).padStart(2, "0")
            const m = String(Math.round(mSpin.value)).padStart(2, "0")
            onChange(`${h}:${m}`)
        }
        hSpin.connect("value-changed", emit)
        mSpin.connect("value-changed", emit)

        const box = new Gtk.Box({ spacing: 4, valign: Gtk.Align.CENTER })
        box.append(hSpin)
        box.append(new Gtk.Label({ label: ":", css_classes: ["settings-row-subtitle"] }))
        box.append(mSpin)
        return box
    }

    const schedTimeBox = new Gtk.Box({ spacing: 24, valign: Gtk.Align.CENTER })

    const fromBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 })
    fromBox.append(new Gtk.Label({ label: t("settings.appearance.row.label.night-light-from"), halign: Gtk.Align.START, css_classes: ["settings-row-subtitle"] }))
    fromBox.append(timePicker(NightLight.scheduleFrom, (v) => NightLight.setScheduleFrom(v)))

    const toBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 })
    toBox.append(new Gtk.Label({ label: t("settings.appearance.row.label.night-light-to"), halign: Gtk.Align.START, css_classes: ["settings-row-subtitle"] }))
    toBox.append(timePicker(NightLight.scheduleTo, (v) => NightLight.setScheduleTo(v)))

    schedTimeBox.append(fromBox)
    schedTimeBox.append(toBox)

    const schedTimeRow = createRow("", "", schedTimeBox)
    schedTimeRow.visible = NightLight.scheduleEnabled
    nlGroup.listBox.append(schedTimeRow)

    // Keep manual toggle in sync when schedule fires
    const nlChangedId = NightLight.connect("changed", () => {
        nlSwitch.active    = NightLight.enabled
        nlSwitch.sensitive = !NightLight.scheduleEnabled
        schedSwitch.active = NightLight.scheduleEnabled
        schedTimeRow.visible = NightLight.scheduleEnabled
    })
    page.connect("unrealize", () => { try { NightLight.disconnect(nlChangedId) } catch {} })

    page.append(nlGroup.box)

    // 4. Wallpaper
    const wallGroup = listGroup(t("settings.appearance.group.fondo-de-pantalla"))

    // Preview
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
            // GdkPixbuf handles GIFs (first frame) and all common formats uniformly
            const pixbuf = GdkPixbuf.Pixbuf.new_from_file(path)
            if (pixbuf) preview.set_paintable(Gdk.Texture.new_for_pixbuf(pixbuf))
        } catch (_) {
            preview.set_filename(path) // fallback
        }
    }
    updatePreview(Wallpaper.current)
    Wallpaper.refreshFromDaemon()

    const previewRow = new Gtk.ListBoxRow({ css_classes: ["settings-item-row", "wallpaper-preview-row"] })
    previewRow.set_child(preview)
    wallGroup.listBox.append(previewRow)

    // Transition selector
    const transitions = Object.keys(TRANSITION_LABELS) as TransitionType[]
    const transLabels = transitions.map(k => TRANSITION_LABELS[k])
    const transRow = dropdownRow(
        t("settings.appearance.row.label.transicion"),
        t("settings.appearance.row.desc.efecto-al-cambiar-el-fondo-de-pantalla"),
        TRANSITION_LABELS[Wallpaper.transition],
        transLabels,
        (label) => {
            const key = transitions.find(k => TRANSITION_LABELS[k] === label)
            if (key) Wallpaper.previewTransition(key)
        },
    )
    wallGroup.listBox.append(transRow)

    // File picker row
    const changeBtn = new Gtk.Button({
        label: t("settings.appearance.label.explorar"),
        css_classes: ["pill"],
        valign: Gtk.Align.CENTER,
    })
    changeBtn.connect("clicked", () => {
        const dialog = new Gtk.FileDialog({
            title: t("settings.appearance.dialog.title.seleccionar-fondo-de-pantalla"),
            modal: true,
        })
        const filter = new Gtk.FileFilter()
        filter.add_mime_type("image/jpeg")
        filter.add_mime_type("image/png")
        filter.add_mime_type("image/gif")
        filter.add_mime_type("image/webp")
        filter.add_mime_type("image/avif")
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
                    Wallpaper.setWallpaper(path)
                    updatePreview(path)
                }
            } catch (_) { /* user cancelled */ }
        })
    })
    wallGroup.listBox.append(createRow(
        t("settings.appearance.row.label.imagen"),
        t("settings.appearance.row.desc.elige-el-fondo-de-pantalla-desde-tus-arc"),
        changeBtn,
    ))

    Wallpaper.connect("changed", () => updatePreview(Wallpaper.current))
    page.append(wallGroup.box)

    // 5. System Assets
    const assetsGroup = listGroup(t("settings.appearance.group.recursos-del-sistema"))
    assetsGroup.listBox.append(dropdownRow(
        t("settings.appearance.row.label.tema-gtk"), t("settings.appearance.row.desc.estetica-estructural-de-aplicaciones"),
        Theme.themeFamily, Theme.getAvailableGtkThemes(), (v) => Theme.setGtkTheme(v),
    ))
    assetsGroup.listBox.append(dropdownRow(
        t("settings.appearance.row.label.tema-qt-kvantum"), t("settings.appearance.row.desc.sincroniza-el-estilo-con-apps-qt-kde"),
        Theme.qtTheme, Theme.getAvailableQtThemes(), (v) => Theme.setQtTheme(v),
    ))
    assetsGroup.listBox.append(dropdownRow(
        t("settings.appearance.row.label.iconos"), t("settings.appearance.row.desc.paquete-de-glifos-del-sistema"),
        Theme.iconTheme, Theme.getAvailableIconThemes(), (v) => Theme.setIconTheme(v),
    ))
    assetsGroup.listBox.append(dropdownRow(
        t("settings.appearance.row.label.cursor"), t("settings.appearance.row.desc.estilo-del-puntero-de-precision"),
        Theme.cursorTheme, Theme.getAvailableCursorThemes(), (v) => Theme.setCursorTheme(v),
    ))
    page.append(assetsGroup.box)

    // 6. Fonts
    const fontsGroup = listGroup(t("settings.appearance.group.fonts"))

    const interfaceFontBtn = new Gtk.FontButton({
        font: Theme.interfaceFont,
        use_font: true,
        valign: Gtk.Align.CENTER,
    })
    interfaceFontBtn.connect("font-set", () => {
        const f = (interfaceFontBtn as any).get_font?.()
        if (f) Theme.setFont(f)
    })
    fontsGroup.listBox.append(createRow(
        t("settings.appearance.row.label.interface-font"),
        t("settings.appearance.row.desc.interface-font"),
        interfaceFontBtn,
    ))

    const monoFontBtn = new Gtk.FontButton({
        font: Theme.monoFont,
        use_font: true,
        valign: Gtk.Align.CENTER,
    })
    monoFontBtn.connect("font-set", () => {
        const f = (monoFontBtn as any).get_font?.()
        if (f) Theme.setMonoFont(f)
    })
    fontsGroup.listBox.append(createRow(
        t("settings.appearance.row.label.mono-font"),
        t("settings.appearance.row.desc.mono-font"),
        monoFontBtn,
    ))

    fontsGroup.listBox.append(sliderRow(
        t("settings.appearance.row.label.text-scaling"),
        t("settings.appearance.row.desc.text-scaling"),
        Theme.textScaling, 0.75, 2.0,
        (v) => Theme.setTextScaling(v),
        { decimals: 2, icons: [Icons.type, Icons.type] },
    ))

    page.append(fontsGroup.box)

    // State sync
    const updateThemeState = () => {
        const currentAccent = Theme.accentColor
        Object.keys(accentButtons).forEach(key => {
            accentButtons[key].remove_css_class("selected")
            if (key === currentAccent) accentButtons[key].add_css_class("selected")
        })
    }
    updateThemeState()
    Theme.connect("changed", updateThemeState)

    return page
}

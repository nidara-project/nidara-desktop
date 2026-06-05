import { Gtk, Gdk } from "ags/gtk4"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import GdkPixbuf from "gi://GdkPixbuf"
import Theme from "../../../core/ThemeManager"
import { CrystalButton } from "../../../../lib/crystal-ui"
import NightLight from "../../../core/NightLightManager"
import Wallpaper, { TRANSITION_LABELS, type TransitionType } from "../../../core/WallpaperManager"
import { ACCENT_PALETTE, type AccentKey } from "../../../core/FluidCrystal"
import { t } from "../../../core/i18n"
import Icons from "../../../core/Icons"
import { listGroup, createRow, toggleRow, dropdownRow, sliderRow, pageHeader, pageBox } from "../SettingsHelpers"

export default function AppearancePage() {
    const page = pageBox("appearance-page")
    page.append(pageHeader(t("settings.appearance.title"), t("settings.appearance.subtitle")))

    // 1. General style
    const styleGroup = listGroup(t("settings.appearance.group.base-style"))
    const darkSwitch = new Gtk.Switch({ active: Theme.isDark, valign: Gtk.Align.CENTER })
    darkSwitch.connect("state-set", (_: any, state: boolean) => { Theme.setDarkMode(state); return false })
    styleGroup.listBox.append(createRow(
        t("settings.appearance.dark-mode"),
        t("settings.appearance.dark-mode.desc"),
        darkSwitch,
    ))
    page.append(styleGroup.box)

    // 2. Crystal Shell visual tokens
    const fcGroup = listGroup("Crystal Shell")

    // Accent Color Picker
    const accentPicker = new Gtk.Box({ spacing: 6, valign: Gtk.Align.CENTER, halign: Gtk.Align.END })
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

    fcGroup.listBox.append(createRow(t("settings.appearance.accent"), t("settings.appearance.accent.desc"), accentPicker))
    fcGroup.listBox.append(sliderRow(
        t("settings.appearance.shell-opacity"),
        t("settings.appearance.shell-opacity.desc"),
        Theme.shellOpacity, 0.06, 0.75,
        (v) => Theme.setShellOpacity(v),
        { pct: true },
    ))
    fcGroup.listBox.append(sliderRow(
        t("settings.appearance.dock-opacity"),
        t("settings.appearance.dock-opacity.desc"),
        Theme.dockOpacity, 0.05, 0.60,
        (v) => Theme.setDockOpacity(v),
        { pct: true },
    ))
    // Window Glass = opacity (1 - transparency), so it reads like the other two:
    // higher = more opaque. Theme stores transparency, so we invert in/out.
    fcGroup.listBox.append(sliderRow(
        t("settings.appearance.window-glass"),
        t("settings.appearance.window-glass.desc"),
        1 - Theme.transparency, 0.10, 0.90,
        (v) => Theme.setTransparency(1 - v),
        { pct: true },
    ))
    page.append(fcGroup.box)

    // 3. Night Light
    const nlGroup = listGroup(t("settings.appearance.group.night-light"))

    // Manual toggle — insensitive when schedule controls it
    const nlSwitch = new Gtk.Switch({ active: NightLight.enabled, valign: Gtk.Align.CENTER, sensitive: !NightLight.scheduleEnabled })
    nlSwitch.connect("state-set", (_: any, v: boolean) => { NightLight.setEnabled(v); return false })
    nlGroup.listBox.append(createRow(
        t("settings.appearance.night-light"),
        t("settings.appearance.night-light.desc"),
        nlSwitch,
    ))

    nlGroup.listBox.append(sliderRow(
        t("settings.appearance.night-light-temp"),
        t("settings.appearance.night-light-temp.desc"),
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
        t("settings.appearance.night-light-schedule"),
        t("settings.appearance.night-light-schedule.desc"),
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
        box.append(new Gtk.Label({ label: ":", css_classes: ["crystal-row-subtitle"] }))
        box.append(mSpin)
        return box
    }

    const schedTimeBox = new Gtk.Box({ spacing: 24, valign: Gtk.Align.CENTER })

    const fromBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 })
    fromBox.append(new Gtk.Label({ label: t("settings.appearance.night-light-from"), halign: Gtk.Align.START, css_classes: ["crystal-row-subtitle"] }))
    fromBox.append(timePicker(NightLight.scheduleFrom, (v) => NightLight.setScheduleFrom(v)))

    const toBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 })
    toBox.append(new Gtk.Label({ label: t("settings.appearance.night-light-to"), halign: Gtk.Align.START, css_classes: ["crystal-row-subtitle"] }))
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

    const previewRow = new Gtk.ListBoxRow({ css_classes: ["crystal-row", "wallpaper-preview-row"] })
    previewRow.set_child(preview)
    wallGroup.listBox.append(previewRow)

    // Transition selector
    const transitions = Object.keys(TRANSITION_LABELS) as TransitionType[]
    const transLabels = transitions.map(k => TRANSITION_LABELS[k])
    const transRow = dropdownRow(
        t("settings.appearance.transition"),
        t("settings.appearance.transition.desc"),
        TRANSITION_LABELS[Wallpaper.transition],
        transLabels,
        (label) => {
            const key = transitions.find(k => TRANSITION_LABELS[k] === label)
            if (key) Wallpaper.previewTransition(key)
        },
    )
    wallGroup.listBox.append(transRow)

    // File picker row
    const changeBtn = CrystalButton({
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
        t("settings.appearance.image"),
        t("settings.appearance.image.desc"),
        changeBtn,
    ))

    Wallpaper.connect("changed", () => updatePreview(Wallpaper.current))
    page.append(wallGroup.box)

    // 5. System Assets
    const assetsGroup = listGroup(t("settings.appearance.group.resources"))
    assetsGroup.listBox.append(dropdownRow(
        t("settings.appearance.gtk-theme"), t("settings.appearance.gtk-theme.desc"),
        Theme.themeFamily, Theme.getAvailableGtkThemes(), (v) => Theme.setGtkTheme(v),
    ))
    assetsGroup.listBox.append(dropdownRow(
        t("settings.appearance.icons"), t("settings.appearance.icons.desc"),
        Theme.iconTheme, Theme.getAvailableIconThemes(), (v) => Theme.setIconTheme(v),
    ))
    assetsGroup.listBox.append(dropdownRow(
        t("settings.appearance.cursor"), t("settings.appearance.cursor.desc"),
        Theme.cursorTheme, Theme.getAvailableCursorThemes(), (v) => Theme.setCursorTheme(v),
    ))
    assetsGroup.listBox.append(dropdownRow(
        t("settings.appearance.cursor-size"), t("settings.appearance.cursor-size.desc"),
        String(Theme.cursorSize), Theme.getAvailableCursorSizes(), (v) => Theme.setCursorSize(Number(v)),
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
        t("settings.appearance.interface-font"),
        t("settings.appearance.interface-font.desc"),
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
        t("settings.appearance.mono-font"),
        t("settings.appearance.mono-font.desc"),
        monoFontBtn,
    ))

    fontsGroup.listBox.append(sliderRow(
        t("settings.appearance.text-scaling"),
        t("settings.appearance.text-scaling.desc"),
        Theme.textScaling, 0.75, 2.0,
        (v) => Theme.setTextScaling(v),
        // small "A" → large "A" text endpoints: crisp at any size (font hinting),
        // unlike a tiny SVG glyph, and the right metaphor for a text-size slider.
        {
            decimals: 2,
            endpoints: [
                new Gtk.Label({ label: "A", css_classes: ["slider-text-endpoint", "is-sm"], valign: Gtk.Align.CENTER }),
                new Gtk.Label({ label: "A", css_classes: ["slider-text-endpoint", "is-lg"], valign: Gtk.Align.CENTER }),
            ],
        },
    ))

    page.append(fontsGroup.box)

    // State sync
    const updateThemeState = () => {
        darkSwitch.active = Theme.isDark
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

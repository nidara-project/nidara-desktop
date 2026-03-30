import { Gtk } from "ags/gtk4"
import Theme from "../../../core/ThemeManager"
import { ACCENT_PALETTE, type AccentKey } from "../../../core/FluidCrystal"
// @ts-ignore
import Adw from "gi://Adw?version=1"
import { listGroup, createRow, toggleRow, dropdownRow, sliderRow, pageHeader, pageBox } from "../SettingsHelpers"

export default function AppearancePage() {
    const page = pageBox("appearance-page")
    page.append(pageHeader("Apariencia", "Personaliza el alma visual de tu sistema Crystal Shell"))

    // 1. General style
    const styleGroup = listGroup("Diseño Base")
    styleGroup.listBox.append(toggleRow(
        "Modo Oscuro",
        "Sincroniza el núcleo visual con la noche",
        Theme.isDark,
        (active) => Theme.setDarkMode(active),
    ))
    page.append(styleGroup.box)

    // 2. Fluid Crystal Engine
    const fcGroup = listGroup("Crystal Shell")
    fcGroup.listBox.append(toggleRow(
        "Transparencia Crystal Shell",
        "Aplica fondo translúcido a las ventanas del shell (bar, dock, paneles)",
        Theme.isFluidCrystal,
        (active) => Theme.setFluidCrystalEnabled(active),
    ))

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

    fcGroup.listBox.append(createRow("Color de Acento", "Define el tono vibrante de la interfaz", accentPicker))
    fcGroup.listBox.append(sliderRow(
        "Transparencia Profunda",
        "Controla la permeabilidad de la luz en las ventanas",
        Theme.transparency, 0, 1,
        (v) => Theme.setTransparency(v),
        { pct: true, icons: ["display-brightness-symbolic", "display-brightness-high-symbolic"] },
    ))
    page.append(fcGroup.box)

    // 3. System Assets
    const assetsGroup = listGroup("Recursos del Sistema")
    assetsGroup.listBox.append(dropdownRow(
        "Tema GTK", "Estética estructural de aplicaciones",
        Theme.themeFamily, Theme.getAvailableGtkThemes(), (v) => Theme.setGtkTheme(v),
    ))
    assetsGroup.listBox.append(dropdownRow(
        "Tema Qt (Kvantum)", "Sincroniza el estilo con apps Qt/KDE",
        Theme.qtTheme, Theme.getAvailableQtThemes(), (v) => Theme.setQtTheme(v),
    ))
    assetsGroup.listBox.append(dropdownRow(
        "Iconos", "Paquete de glifos del sistema",
        Theme.iconTheme, Theme.getAvailableIconThemes(), (v) => Theme.setIconTheme(v),
    ))
    assetsGroup.listBox.append(dropdownRow(
        "Cursor", "Estilo del puntero de precisión",
        Theme.cursorTheme, Theme.getAvailableCursorThemes(), (v) => Theme.setCursorTheme(v),
    ))
    page.append(assetsGroup.box)

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

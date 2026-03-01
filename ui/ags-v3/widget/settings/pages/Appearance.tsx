import { Gtk, Gdk } from "ags/gtk4"
import Theme from "../../../core/ThemeManager"
import { ACCENT_PALETTE, type AccentKey } from "../../../core/FluidCrystal"

/**
 * Appearance Page 🎨
 * Controls Dark Mode, Fluid Crystal (accent, transparency), GTK themes, icons, cursor.
 */
export default function AppearancePage() {
    const page = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 24,
        css_classes: ["settings-page"],
        margin_start: 30,
        margin_end: 30,
        margin_top: 30,
        margin_bottom: 30,
    })

    // Header Section
    const headerBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 4,
        margin_bottom: 12
    })
    headerBox.append(new Gtk.Label({
        label: "Apariencia",
        css_classes: ["settings-page-title"],
        halign: Gtk.Align.START,
    }))
    headerBox.append(new Gtk.Label({
        label: "Personaliza el estilo visual, iconos y modo de iluminación del sistema",
        css_classes: ["settings-page-subtitle"],
        halign: Gtk.Align.START,
    }))
    page.append(headerBox)

    // ── Helper: Boxed List Header ──
    const listGroup = (title: string) => {
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 })
        if (title) {
            box.append(new Gtk.Label({
                label: title,
                css_classes: ["settings-group-title"],
                halign: Gtk.Align.START,
                margin_start: 6
            }))
        }
        const listBox = new Gtk.ListBox({
            css_classes: ["settings-list-box", "boxed-list"],
            selection_mode: Gtk.SelectionMode.NONE
        })
        box.append(listBox)
        return { box, listBox }
    }

    // ── Helper: DropDown Row ──
    const dropdownRow = (
        label: string,
        subtitle: string,
        initial: string,
        options: string[],
        onChange: (v: string) => void,
    ) => {
        const box = new Gtk.Box({
            spacing: 12,
            margin_start: 12,
            margin_end: 12,
            margin_top: 8,
            margin_bottom: 8,
        })

        const text = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            hexpand: true,
            valign: Gtk.Align.CENTER
        })
        text.append(new Gtk.Label({
            label,
            css_classes: ["settings-row-label"],
            halign: Gtk.Align.START,
        }))
        if (subtitle) {
            text.append(new Gtk.Label({
                label: subtitle,
                css_classes: ["settings-row-subtitle"],
                halign: Gtk.Align.START,
            }))
        }

        const dropdown = new Gtk.ComboBoxText({
            valign: Gtk.Align.CENTER,
            hexpand: false
        })

        options.forEach(opt => dropdown.append_text(opt))
        const idx = options.indexOf(initial)
        if (idx !== -1) dropdown.active = idx

        dropdown.connect("changed", () => {
            const selected = dropdown.get_active_text()
            if (selected) onChange(selected)
        })

        box.append(text)
        box.append(dropdown)
        return new Gtk.ListBoxRow({ child: box })
    }

    // ── Helper: Toggle Row ──
    const toggleRow = (
        label: string,
        subtitle: string,
        initial: boolean,
        onChange: (active: boolean) => void,
    ) => {
        const box = new Gtk.Box({
            spacing: 12,
            margin_start: 12,
            margin_end: 12,
            margin_top: 8,
            margin_bottom: 8,
        })

        const text = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            hexpand: true,
            valign: Gtk.Align.CENTER
        })
        text.append(new Gtk.Label({
            label,
            css_classes: ["settings-row-label"],
            halign: Gtk.Align.START,
        }))
        if (subtitle) {
            text.append(new Gtk.Label({
                label: subtitle,
                css_classes: ["settings-row-subtitle"],
                halign: Gtk.Align.START,
            }))
        }

        const sw = new Gtk.Switch({
            active: initial,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.END,
        })

        sw.connect("notify::active", () => onChange(sw.active))

        box.append(text)
        box.append(sw)
        return new Gtk.ListBoxRow({ child: box })
    }

    // ── Helper: Slider Row ──
    const sliderRow = (
        label: string,
        subtitle: string,
        initial: number,
        min: number,
        max: number,
        onChange: (v: number) => void,
    ) => {
        const box = new Gtk.Box({
            spacing: 12,
            margin_start: 12,
            margin_end: 12,
            margin_top: 8,
            margin_bottom: 8,
        })

        const text = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            hexpand: true,
            valign: Gtk.Align.CENTER
        })
        text.append(new Gtk.Label({
            label,
            css_classes: ["settings-row-label"],
            halign: Gtk.Align.START,
        }))
        if (subtitle) {
            text.append(new Gtk.Label({
                label: subtitle,
                css_classes: ["settings-row-subtitle"],
                halign: Gtk.Align.START,
            }))
        }

        const scale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            valign: Gtk.Align.CENTER,
            hexpand: false,
            width_request: 180,
            css_classes: ["horizontal"],
        })
        scale.set_range(min, max)
        scale.set_value(initial)
        scale.set_draw_value(false)

        scale.connect("value-changed", () => {
            onChange(scale.get_value())
        })

        box.append(text)
        box.append(scale)
        return new Gtk.ListBoxRow({ child: box })
    }

    // ══════════════════════════════════════════════════════════════════
    // SECTIONS
    // ══════════════════════════════════════════════════════════════════

    // 1. General Style (Dark Mode)
    const styleGroup = listGroup("Estilo general")
    styleGroup.listBox.append(toggleRow(
        "Modo oscuro",
        "Preferencia global para aplicaciones modernas",
        Theme.isDark,
        (active) => Theme.setDarkMode(active)
    ))
    page.append(styleGroup.box)

    // 2. Fluid Crystal — Accent & Transparency (dynamically visible)
    const fcGroup = listGroup("Fluid Crystal")
    fcGroup.box.visible = Theme.isFluidCrystal

    Theme.connect("changed", () => {
        fcGroup.box.visible = Theme.isFluidCrystal
    })


    // ── Accent Color Picker (macOS-style colored circles) ──
    const accentRow = new Gtk.Box({
        spacing: 12,
        margin_start: 12,
        margin_end: 12,
        margin_top: 8,
        margin_bottom: 8,
    })

    const accentText = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 2,
        hexpand: true,
        valign: Gtk.Align.CENTER
    })
    accentText.append(new Gtk.Label({
        label: "Color de acento",
        css_classes: ["settings-row-label"],
        halign: Gtk.Align.START,
    }))
    accentText.append(new Gtk.Label({
        label: "Aplica a botones, toggles y elementos activos",
        css_classes: ["settings-row-subtitle"],
        halign: Gtk.Align.START,
    }))
    accentRow.append(accentText)

    // Generate CSS for all accent circles via a single provider
    const accentProvider = new Gtk.CssProvider()

    const buildAccentCss = (activeKey: string) => {
        let css = ""
        for (const [key, { color }] of Object.entries(ACCENT_PALETTE)) {
            const isActive = key === activeKey
            css += `
                    .accent-${key} {
                        background: ${color};
                        background-image: none;
                        border-radius: 50%;
                        min-width: 24px;
                        min-height: 24px;
                        padding: 0;
                        margin: 0;
                        border: 2px solid ${isActive ? "white" : "transparent"};
                        ${isActive ? `box-shadow: 0 0 0 1px ${color};` : "box-shadow: none;"}
                        outline: none;
                        -gtk-icon-size: 0px;
                        transition: all 200ms ease;
                    }
                    .accent-${key}:hover {
                        background: ${color};
                        background-image: none;
                        box-shadow: 0 0 0 2px ${color};
                    }
                    .accent-${key}:active {
                        background: ${color};
                        background-image: none;
                    }
                `
        }
        return css
    }

    accentProvider.load_from_string(buildAccentCss(Theme.accentColor))
    const display = Gdk.Display.get_default()
    if (display) {
        Gtk.StyleContext.add_provider_for_display(display, accentProvider, Gtk.STYLE_PROVIDER_PRIORITY_USER + 1)
    }

    // Color circles container
    const colorsBox = new Gtk.Box({
        spacing: 6,
        valign: Gtk.Align.CENTER,
    })

    const accentKeys = Object.keys(ACCENT_PALETTE) as AccentKey[]
    for (const key of accentKeys) {
        const { name } = ACCENT_PALETTE[key]
        const btn = new Gtk.Button({
            css_classes: [`accent-${key}`],
            tooltip_text: name,
            width_request: 24,
            height_request: 24,
        })

        btn.connect("clicked", () => {
            Theme.setAccentColor(key)
            accentProvider.load_from_string(buildAccentCss(key))
        })

        colorsBox.append(btn)
    }

    accentRow.append(colorsBox)
    fcGroup.listBox.append(new Gtk.ListBoxRow({ child: accentRow }))

    // ── Transparency Slider ──
    fcGroup.listBox.append(sliderRow(
        "Transparencia",
        "Menús y sidebars de apps GTK (requiere reiniciar las apps)",
        Theme.transparency,
        0.0,
        1.0,
        (v) => Theme.setTransparency(v)
    ))

    // ── Tint Strength Slider ──
    fcGroup.listBox.append(sliderRow(
        "Tintado de acento",
        "Intensidad del color de acento en los paneles",
        Theme.tintStrength,
        0.0,
        1.0,
        (v) => Theme.setTintStrength(v)
    ))

    // ── Per-Panel Tint Toggles ──
    const tintPanels = Theme.tintPanels
    const panelLabels: [keyof typeof tintPanels, string, string][] = [
        ["controlCenter", "Control Center", "Centro de control"],
        ["appGrid", "App Grid", "Grid de aplicaciones"],
    ]

    for (const [key, , label] of panelLabels) {
        fcGroup.listBox.append(toggleRow(
            label,
            "Tintar con el color de acento",
            tintPanels[key],
            (active) => Theme.setTintPanel(key, active)
        ))
    }

    page.append(fcGroup.box)

    // 3. Theme Family
    const themesGroup = listGroup("Temas y recursos")
    const gtkThemes = Theme.getAvailableGtkThemes().sort()

    themesGroup.listBox.append(dropdownRow(
        "Tema GTK",
        "Selecciona el tema visual para el sistema",
        Theme.themeFamily,
        gtkThemes,
        (v) => Theme.setGtkTheme(v)
    ))

    const iconThemes = Theme.getAvailableIconThemes()
    themesGroup.listBox.append(dropdownRow(
        "Tema de iconos",
        "Selecciona el paquete de iconos del sistema",
        Theme.iconTheme,
        iconThemes,
        (v) => Theme.setIconTheme(v)
    ))

    const cursorThemes = Theme.getAvailableCursorThemes()
    themesGroup.listBox.append(dropdownRow(
        "Tema del cursor",
        "Selecciona el estilo del puntero",
        Theme.cursorTheme,
        cursorThemes,
        (v) => Theme.setCursorTheme(v)
    ))
    page.append(themesGroup.box)

    return page
}

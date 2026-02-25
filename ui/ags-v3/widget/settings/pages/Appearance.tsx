import { Gtk } from "ags/gtk4"
import Theme from "../../../core/ThemeManager"

/**
 * Appearance Page 🎨
 * Controls GTK Theme Families, Icons, and Dark Mode.
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

    // --- Action Button ---
    const applyBtn = new Gtk.Button({
        label: "Sincronizar Todo",
        css_classes: ["suggested-action"], // Libadwaita/Standard GTK pattern for primary actions
        halign: Gtk.Align.END,
        margin_bottom: 12
    })
    applyBtn.connect("clicked", () => {
        Theme.setDarkMode(Theme.isDark)
    })
    page.append(applyBtn)

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

        // Gtk4 DropDown
        const stringList = Gtk.StringList.new(options)
        const dropdown = new Gtk.DropDown({
            model: stringList,
            valign: Gtk.Align.CENTER,
            css_classes: ["settings-dropdown"]
        })

        // Initial Selection
        const idx = options.indexOf(initial)
        if (idx !== -1) dropdown.selected = idx

        dropdown.connect("notify::selected", () => {
            const selected = options[dropdown.selected]
            if (selected) {
                console.log(`[Appearance] DropDown selected: ${selected}`)
                onChange(selected)
            }
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

    // --- Sections ---

    // 1. General Style
    const styleGroup = listGroup("Estilo General")
    styleGroup.listBox.append(toggleRow(
        "Modo Oscuro",
        "Alterna entre temas claros y oscuros globalmente",
        Theme.isDark,
        (active) => Theme.setDarkMode(active)
    ))
    page.append(styleGroup.box)

    // 2. Theme Family
    const themesGroup = listGroup("Temas y Recursos")
    const gtkThemes = Theme.getAvailableGtkThemes()
    themesGroup.listBox.append(dropdownRow(
        "Familia de Tema GTK",
        "Selecciona el tema base para el sistema",
        Theme.themeFamily,
        gtkThemes,
        (v) => Theme.setThemeFamily(v)
    ))

    const iconThemes = Theme.getAvailableIconThemes()
    themesGroup.listBox.append(dropdownRow(
        "Tema de Iconos",
        "Selecciona el paquete de iconos del sistema",
        Theme.iconTheme,
        iconThemes,
        (v) => Theme.setIconTheme(v)
    ))

    const cursorThemes = Theme.getAvailableCursorThemes()
    themesGroup.listBox.append(dropdownRow(
        "Tema del Cursor",
        "Selecciona el estilo del puntero",
        Theme.cursorTheme,
        cursorThemes,
        (v) => Theme.setCursorTheme(v)
    ))
    page.append(themesGroup.box)

    return page
}

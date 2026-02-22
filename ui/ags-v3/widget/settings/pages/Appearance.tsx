import { Astal, Gtk } from "ags/gtk4"
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
        margin_start: 40,
        margin_end: 40,
        margin_top: 40,
    })

    page.append(new Gtk.Label({
        label: "Apariencia",
        css_classes: ["settings-page-title"],
        halign: Gtk.Align.START,
    }))

    page.append(new Gtk.Label({
        label: "Personaliza el estilo visual, iconos y modo de iluminación del sistema",
        css_classes: ["settings-page-subtitle"],
        halign: Gtk.Align.START,
    }))

    page.append(new Gtk.Separator())

    // ── Helper: DropDown Row ──
    const dropdownRow = (
        label: string,
        subtitle: string,
        initial: string,
        options: string[],
        onChange: (v: string) => void,
    ) => {
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            css_classes: ["settings-row"],
            margin_start: 16,
            margin_end: 16,
            margin_top: 8,
            margin_bottom: 8,
        })

        const header = new Gtk.Box({ spacing: 8 })
        header.append(new Gtk.Label({
            label,
            css_classes: ["settings-row-label"],
            halign: Gtk.Align.START,
            hexpand: true,
        }))
        box.append(header)

        box.append(new Gtk.Label({
            label: subtitle,
            css_classes: ["settings-row-subtitle"],
            halign: Gtk.Align.START,
        }))

        // Gtk4 DropDown
        const stringList = Gtk.StringList.new(options)
        const dropdown = new Gtk.DropDown({
            model: stringList,
            hexpand: true,
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

        box.append(dropdown)
        return box
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
            css_classes: ["settings-row", "toggle-row"],
            margin_start: 16,
            margin_end: 16,
            margin_top: 8,
            margin_bottom: 8,
        })

        const text = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            hexpand: true,
        })
        text.append(new Gtk.Label({
            label,
            css_classes: ["settings-row-label"],
            halign: Gtk.Align.START,
        }))
        text.append(new Gtk.Label({
            label: subtitle,
            css_classes: ["settings-row-subtitle"],
            halign: Gtk.Align.START,
        }))

        const sw = new Gtk.Switch({
            active: initial,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.END,
            css_classes: ["settings-switch"],
        })

        sw.connect("notify::active", () => onChange(sw.active))

        box.append(text)
        box.append(sw)
        return box
    }

    // --- Action Button ---
    const topBar = new Gtk.Box({ spacing: 12 })
    const applyBtn = new Gtk.Button({
        label: "Sincronizar Todo",
        css_classes: ["cc-clear-btn"], // Reusing styles
        halign: Gtk.Align.END,
        hexpand: true
    })
    applyBtn.connect("clicked", () => {
        // Theme.applyAll() is private, but setThemeFamily(current) 
        // triggers syncGtkTheme + save. 
        // Let's just reload or re-apply based on state.
        Theme.setDarkMode(Theme.isDark)
    })
    topBar.append(applyBtn)
    page.append(topBar)

    // --- Sections ---

    // 1. Dark Mode
    page.append(toggleRow(
        "Modo Oscuro",
        "Alterna entre temas claros y oscuros globalmente",
        Theme.isDark,
        (active) => Theme.setDarkMode(active)
    ))

    page.append(new Gtk.Separator())

    // 2. Theme Family (Scanned from /usr/share/themes)
    const gtkThemes = Theme.getAvailableGtkThemes()
    page.append(dropdownRow(
        "Familia de Tema GTK",
        "Selecciona el tema base para el sistema",
        Theme.themeFamily,
        gtkThemes,
        (v) => Theme.setThemeFamily(v)
    ))

    // 3. Icon Theme (Scanned from /usr/share/icons)
    const iconThemes = Theme.getAvailableIconThemes()
    page.append(dropdownRow(
        "Tema de Iconos",
        "Selecciona el paquete de iconos del sistema",
        Theme.iconTheme,
        iconThemes,
        (v) => Theme.setIconTheme(v)
    ))

    // 4. Cursor Theme (Scanned from /usr/share/icons)
    const cursorThemes = Theme.getAvailableCursorThemes()
    page.append(dropdownRow(
        "Tema del Cursor",
        "Selecciona el estilo del puntero",
        Theme.cursorTheme,
        cursorThemes,
        (v) => Theme.setCursorTheme(v)
    ))

    return page
}

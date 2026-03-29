import { Gtk, Gdk } from "ags/gtk4"
import Theme from "../../../core/ThemeManager"
import { ACCENT_PALETTE, type AccentKey } from "../../../core/FluidCrystal"
// @ts-ignore
import Adw from "gi://Adw?version=1"
import GLib from "gi://GLib"

/**
 * Appearance Page 🎨 - Crystal V3 (macOS Tahoe Inspired)
 * Controls Dark Mode, Fluid Crystal (accent, transparency), GTK themes, icons, cursor.
 */
export default function AppearancePage() {
    const page = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 32,
        css_classes: ["settings-page", "appearance-page"],
        margin_start: 12,
        margin_end: 12,
        margin_top: 40,
        margin_bottom: 40,
    })

    // Header Section (Tahoe Style)
    const headerBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
        margin_bottom: 24,
        margin_start: 6
    })
    
    headerBox.append(new Gtk.Label({
        label: "Apariencia",
        css_classes: ["settings-page-title"],
        halign: Gtk.Align.START,
    }))
    
    headerBox.append(new Gtk.Label({
        label: "Personaliza el alma visual de tu sistema Crystal Shell",
        css_classes: ["settings-page-subtitle"],
        halign: Gtk.Align.START,
    }))
    
    page.append(headerBox)

    // ── Helper: Boxed List Group ──
    const listGroup = (title: string) => {
        const box = new Gtk.Box({ 
            orientation: Gtk.Orientation.VERTICAL, 
            spacing: 12,
            css_classes: ["settings-group"] 
        })
        
        if (title) {
            box.append(new Gtk.Label({
                label: title.toUpperCase(),
                css_classes: ["settings-group-title"],
                halign: Gtk.Align.START,
                margin_start: 10
            }))
        }
        
        const listBox = new Gtk.ListBox({
            css_classes: ["settings-list-box", "boxed-list"],
            selection_mode: Gtk.SelectionMode.NONE
        })
        
        box.append(listBox)
        return { box, listBox }
    }

    // ── Helper: Generic Row Builder ──
    const createRow = (label: string, subtitle: string, widget: Gtk.Widget) => {
        const box = new Gtk.Box({
            spacing: 16,
            margin_start: 16,
            margin_end: 16,
            margin_top: 14,
            margin_bottom: 14,
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

        box.append(text)
        box.append(widget)
        
        const lbr = new Gtk.ListBoxRow({ css_classes: ["settings-item-row"] })
        lbr.set_child(box)
        return lbr
    }

    // ── Concrete Row types ──
    const toggleRow = (l: string, s: string, init: boolean, cb: (v: boolean) => void) => {
        const sw = new Gtk.Switch({ active: init, valign: Gtk.Align.CENTER })
        sw.connect("state-set", (_, state) => {
            cb(state)
            return false 
        })
        return createRow(l, s, sw)
    }

    const dropdownRow = (l: string, s: string, init: string, opts: string[], cb: (v: string) => void) => {
        const drp = new Gtk.ComboBoxText({ valign: Gtk.Align.CENTER })
        opts.forEach(o => drp.append_text(o))
        drp.active = opts.indexOf(init)
        drp.connect("changed", () => {
            const val = drp.get_active_text()
            if (val) cb(val)
        })
        return createRow(l, s, drp)
    }

    const sliderRow = (l: string, s: string, init: number, min: number, max: number, cb: (v: number) => void) => {
        const box = new Gtk.Box({ spacing: 12, valign: Gtk.Align.CENTER })

        const iconLow = new Gtk.Image({
            icon_name: l.includes("Transparencia") ? "display-brightness-symbolic" : "view-paged-symbolic",
            pixel_size: 16,
            opacity: 0.5
        })

        const scale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            width_request: 120,
            css_classes: ["crystal-scale", "cc-atomic-scale-native"]
        })
        scale.set_range(min, max)
        scale.set_value(init)
        scale.set_draw_value(false)
        
        const iconHigh = new Gtk.Image({
            icon_name: l.includes("Transparencia") ? "display-brightness-high-symbolic" : "view-paged-symbolic",
            pixel_size: 16,
            opacity: 0.5
        })

        const valueLabel = new Gtk.Label({
            label: `${Math.round(init * 100)}%`,
            css_classes: ["slider-value-label"],
            width_chars: 4
        })

        scale.connect("value-changed", () => {
            const val = scale.get_value()
            valueLabel.label = `${Math.round(val * 100)}%`
            cb(val)
        })
        
        box.append(iconLow)
        box.append(scale)
        box.append(iconHigh)
        box.append(valueLabel)

        return createRow(l, s, box)
    }

    // ══════════════════════════════════════════════════════════════════
    // PAGE CONSTRUCTION
    // ══════════════════════════════════════════════════════════════════

    // 1. General style
    const styleGroup = listGroup("Diseño Base")
    styleGroup.listBox.append(toggleRow(
        "Modo Oscuro",
        "Sincroniza el núcleo visual con la noche",
        Theme.isDark,
        (active) => Theme.setDarkMode(active)
    ))
    page.append(styleGroup.box)

    // 2. Fluid Crystal Engine
    const fcGroup = listGroup("Fluid Crystal Engine")
    
    fcGroup.listBox.append(toggleRow(
        "Motor Óptico Crystal",
        "Activa el renderizado avanzado de cristalmorfismo v3",
        Theme.isFluidCrystal,
        (active) => Theme.setFluidCrystalEnabled(active)
    ))

    // Accent Color Picker (macOS Style)
    const accentPicker = new Gtk.Box({ spacing: 10, valign: Gtk.Align.CENTER })
    const accentButtons: Record<string, Gtk.Button> = {}

    Object.keys(ACCENT_PALETTE).forEach(key => {
        const { color, name } = ACCENT_PALETTE[key as AccentKey]
        const btn = new Gtk.Button({
            tooltip_text: name,
            css_classes: [`accent-${key}`, "accent-circle-btn"],
            width_request: 28,
            height_request: 28,
        })
        
        if (Theme.accentColor === key) btn.add_css_class("selected")
        
        btn.connect("clicked", () => {
            Theme.setAccentColor(key as AccentKey)
        })
        
        accentPicker.append(btn)
        accentButtons[key] = btn
    })
    
    fcGroup.listBox.append(createRow("Color de Acento", "Define el tono vibrante de la interfaz", accentPicker))
    
    fcGroup.listBox.append(sliderRow(
        "Transparencia Profunda",
        "Controla la permeabilidad de la luz en las ventanas",
        Theme.transparency, 0, 1, (v) => Theme.setTransparency(v)
    ))
    
    page.append(fcGroup.box)

    // 4. System Assets
    const assetsGroup = listGroup("Recursos del Sistema")
    
    assetsGroup.listBox.append(dropdownRow(
        "Tema GTK", "Estética estructural de aplicaciones",
        Theme.themeFamily, Theme.getAvailableGtkThemes(), (v) => Theme.setGtkTheme(v)
    ))

    // 💎 RESTORE QT THEME 💎
    assetsGroup.listBox.append(dropdownRow(
        "Tema Qt (Kvantum)", "Sincroniza el estilo con apps Qt/KDE",
        Theme.qtTheme, Theme.getAvailableQtThemes(), (v) => Theme.setQtTheme(v)
    ))
    
    assetsGroup.listBox.append(dropdownRow(
        "Iconos", "Paquete de glifos del sistema",
        Theme.iconTheme, Theme.getAvailableIconThemes(), (v) => Theme.setIconTheme(v)
    ))

    assetsGroup.listBox.append(dropdownRow(
        "Cursor", "Estilo del puntero de precisión",
        Theme.cursorTheme, Theme.getAvailableCursorThemes(), (v) => Theme.setCursorTheme(v)
    ))

    page.append(assetsGroup.box)

    // Visibility & State sync
    const updateThemeState = () => {
        const isFc = Theme.isFluidCrystal
        const currentAccent = Theme.accentColor
        
        // Update visibility of accent/transparency rows
        fcGroup.listBox.get_row_at_index(1)!.visible = isFc
        fcGroup.listBox.get_row_at_index(2)!.visible = isFc
        
        // Update accent circles
        Object.keys(accentButtons).forEach(key => {
            accentButtons[key].remove_css_class("selected")
            if (key === currentAccent) accentButtons[key].add_css_class("selected")
        })
    }
    
    updateThemeState()
    Theme.connect("changed", updateThemeState)

    return page
}

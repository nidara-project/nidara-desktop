import { Astal, Gtk } from "ags/gtk4"
import { dockSettings, updateDockSettings, type DockSettings } from "../../dock/state"

/**
 * Dock Settings Page ⚓ - Crystal V3 (macOS Tahoe Inspired)
 */
export default function DockPage() {
    const page = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 32,
        css_classes: ["settings-page", "dock-page"],
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
        label: "Dock",
        css_classes: ["settings-page-title"],
        halign: Gtk.Align.START,
    }))
    
    headerBox.append(new Gtk.Label({
        label: "Personaliza el tamaño, animación e indicadores del dock",
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

    const sliderRow = (l: string, s: string, init: number, min: number, max: number, unit: string, cb: (v: number) => void) => {
        const scale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            valign: Gtk.Align.CENTER,
            width_request: 160,
            css_classes: ["horizontal"]
        })
        scale.set_range(min, max)
        scale.set_value(init)
        scale.set_draw_value(false)
        
        const valueLabel = new Gtk.Label({
            label: `${Math.round(init)}${unit}`,
            css_classes: ["slider-value-label"]
        })

        scale.connect("value-changed", () => {
            const val = scale.get_value()
            valueLabel.label = `${Math.round(val)}${unit}`
            cb(val)
        })
        
        const box = new Gtk.Box({ spacing: 12 })
        box.append(scale)
        box.append(valueLabel)
        return createRow(l, s, box)
    }

    const presetRow = (l: string, s: string, presets: number[], init: number, unit: string, cb: (v: number) => void) => {
        const btnBox = new Gtk.Box({
            spacing: 0,
            homogeneous: true,
            css_classes: ["settings-preset-group", "linked"],
            valign: Gtk.Align.CENTER
        })

        const buttons: Gtk.Button[] = []
        presets.forEach((val) => {
            const btn = new Gtk.Button({
                label: `${val}${unit}`,
                css_classes: val === init
                    ? ["settings-preset-btn", "suggested-action"]
                    : ["settings-preset-btn"],
            })
            btn.connect("clicked", () => {
                buttons.forEach(b => b.remove_css_class("suggested-action"))
                btn.add_css_class("suggested-action")
                cb(val)
            })
            buttons.push(btn)
            btnBox.append(btn)
        })

        return createRow(l, s, btnBox)
    }

    // 1. Geometry Section
    const geoGroup = listGroup("Geometría")
    geoGroup.listBox.append(presetRow(
        "Tamaño de icono", "Tamaño base en reposo",
        [32, 48, 64, 80, 96], dockSettings.iconSize, "px",
        (v) => updateDockSettings({ iconSize: v }),
    ))
    geoGroup.listBox.append(sliderRow(
        "Margen inferior", "Distancia al borde de la pantalla",
        dockSettings.screenGap, 4, 32, "px",
        (v) => updateDockSettings({ screenGap: v }),
    ))
    geoGroup.listBox.append(sliderRow(
        "Escala de iconos", "Ajuste fino del renderizado",
        dockSettings.iconThemeScale, 0, 20, "%",
        (v) => updateDockSettings({ iconThemeScale: v }),
    ))
    page.append(geoGroup.box)

    // 2. Effects Section
    const effectsGroup = listGroup("Efectos")
    effectsGroup.listBox.append(toggleRow(
        "Magnificación activa", "Efecto de zoom al pasar el cursor",
        dockSettings.magnification,
        (v) => updateDockSettings({ magnification: v }),
    ))
    effectsGroup.listBox.append(sliderRow(
        "Tamaño máximo", "Límite de expansión al magnificar",
        dockSettings.maxIconSize, 64, 128, "px",
        (v) => updateDockSettings({ maxIconSize: v }),
    ))
    page.append(effectsGroup.box)

    // 3. Behavior Section
    const behGroup = listGroup("Comportamiento")
    behGroup.listBox.append(toggleRow(
        "Mostrar indicadores", "Punto bajo los iconos de apps abiertas",
        dockSettings.showIndicators,
        (v) => updateDockSettings({ showIndicators: v }),
    ))
    page.append(behGroup.box)

    return page
}

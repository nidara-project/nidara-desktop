import { Astal, Gtk } from "ags/gtk4"
import { dockSettings, updateDockSettings, type DockSettings } from "../../dock/state"

/**
 * Dock Settings Page ⚓
 * Controls icon size, magnification, indicators, and screen gap.
 */
export default function DockPage() {
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

    // ── Helper: Labeled Slider Row ──
    const sliderRow = (
        label: string,
        subtitle: string,
        min: number,
        max: number,
        step: number,
        initial: number,
        unit: string,
        onChange: (v: number) => void,
    ) => {
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            margin_start: 12,
            margin_end: 12,
            margin_top: 10,
            margin_bottom: 10,
        })

        const header = new Gtk.Box({ spacing: 8 })
        header.append(new Gtk.Label({
            label,
            css_classes: ["settings-row-label"],
            halign: Gtk.Align.START,
            hexpand: true,
        }))

        const valueLabel = new Gtk.Label({
            label: `${Math.round(initial)}${unit}`,
            css_classes: ["settings-row-status"],
            halign: Gtk.Align.END,
        })
        header.append(valueLabel)
        box.append(header)

        if (subtitle) {
            box.append(new Gtk.Label({
                label: subtitle,
                css_classes: ["settings-row-subtitle"],
                halign: Gtk.Align.START,
            }))
        }

        const scale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            hexpand: true,
            draw_value: false,
            adjustment: new Gtk.Adjustment({
                lower: min,
                upper: max,
                step_increment: step,
                page_increment: step * 5,
                value: initial,
            }),
        })

        scale.connect("value-changed", () => {
            const v = Math.round(scale.adjustment.value)
            valueLabel.set_label(`${v}${unit}`)
            onChange(v)
        })

        box.append(scale)
        return new Gtk.ListBoxRow({ child: box })
    }

    // ── Helper: Toggle Row ──
    const toggleRow = (
        label: string,
        subtitle: string,
        initial: boolean,
        onChange: (v: boolean) => void,
    ) => {
        const box = new Gtk.Box({
            spacing: 12,
            margin_start: 12,
            margin_end: 12,
            margin_top: 10,
            margin_bottom: 10,
        })

        const labels = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            hexpand: true,
            valign: Gtk.Align.CENTER
        })
        labels.append(new Gtk.Label({
            label,
            css_classes: ["settings-row-label"],
            halign: Gtk.Align.START,
        }))
        if (subtitle) {
            labels.append(new Gtk.Label({
                label: subtitle,
                css_classes: ["settings-row-subtitle"],
                halign: Gtk.Align.START,
            }))
        }
        box.append(labels)

        const sw = new Gtk.Switch({
            active: initial,
            valign: Gtk.Align.CENTER,
        })
        sw.connect("notify::active", () => {
            onChange(sw.active)
        })
        box.append(sw)

        return new Gtk.ListBoxRow({ child: box })
    }

    // ── Helper: Discrete Preset Row ──
    const presetRow = (
        label: string,
        subtitle: string,
        presets: number[],
        initial: number,
        unit: string,
        onChange: (v: number) => void,
    ) => {
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_start: 12,
            margin_end: 12,
            margin_top: 12,
            margin_bottom: 12,
        })

        const text = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 })
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

        const btnBox = new Gtk.Box({
            spacing: 8,
            homogeneous: true,
            css_classes: ["settings-preset-group"],
        })

        const buttons: Gtk.Button[] = []
        presets.forEach((val) => {
            const btn = new Gtk.Button({
                label: `${val}${unit}`,
                css_classes: val === initial
                    ? ["settings-preset-btn", "active"]
                    : ["settings-preset-btn"],
            })
            btn.connect("clicked", () => {
                buttons.forEach(b => b.remove_css_class("active"))
                btn.add_css_class("active")
                onChange(val)
            })
            buttons.push(btn)
            btnBox.append(btn)
        })

        box.append(btnBox)
        return new Gtk.ListBoxRow({ child: box })
    }

    // ── Section: Geometry ──
    const geoGroup = listGroup("Geometría")
    geoGroup.listBox.append(presetRow(
        "Tamaño de icono", "Tamaño base en reposo",
        [32, 48, 64, 80, 96], dockSettings.iconSize, "px",
        (v) => updateDockSettings({ iconSize: v }),
    ))
    geoGroup.listBox.append(sliderRow(
        "Margen inferior", "Distancia al borde de la pantalla",
        4, 16, 1, dockSettings.screenGap, "px",
        (v) => updateDockSettings({ screenGap: v }),
    ))
    geoGroup.listBox.append(sliderRow(
        "Escala del tema de iconos", "Compensa iconos pequeños",
        0, 20, 1, dockSettings.iconThemeScale, "%",
        (v) => updateDockSettings({ iconThemeScale: v }),
    ))
    page.append(geoGroup.box)

    // ── Section: Magnification ──
    const magGroup = listGroup("Efectos")
    magGroup.listBox.append(toggleRow(
        "Magnificación activa", "Efecto de zoom al pasar el cursor",
        dockSettings.magnification,
        (v) => updateDockSettings({ magnification: v }),
    ))
    magGroup.listBox.append(sliderRow(
        "Tamaño máximo", "Tamaño al máximo zoom",
        64, 128, 4, dockSettings.maxIconSize, "px",
        (v) => updateDockSettings({ maxIconSize: v }),
    ))
    page.append(magGroup.box)

    // ── Section: Behavior ──
    const behGroup = listGroup("Comportamiento")
    behGroup.listBox.append(toggleRow(
        "Mostrar indicadores", "Punto bajo los iconos de apps abiertas",
        dockSettings.showIndicators,
        (v) => updateDockSettings({ showIndicators: v }),
    ))
    page.append(behGroup.box)

    return page
}

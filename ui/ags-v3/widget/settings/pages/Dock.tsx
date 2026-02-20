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
        margin_start: 40,
        margin_end: 40,
        margin_top: 40,
    })

    page.append(new Gtk.Label({
        label: "Dock",
        css_classes: ["settings-page-title"],
        halign: Gtk.Align.START,
    }))

    page.append(new Gtk.Label({
        label: "Personaliza el tamaño, animación e indicadores del dock",
        css_classes: ["settings-page-subtitle"],
        halign: Gtk.Align.START,
    }))

    page.append(new Gtk.Separator())

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

        const valueLabel = new Gtk.Label({
            label: `${Math.round(initial)}${unit}`,
            css_classes: ["settings-row-value"],
            halign: Gtk.Align.END,
        })
        header.append(valueLabel)
        box.append(header)

        box.append(new Gtk.Label({
            label: subtitle,
            css_classes: ["settings-row-subtitle"],
            halign: Gtk.Align.START,
        }))

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
            css_classes: ["settings-scale"],
        })

        scale.connect("value-changed", () => {
            const v = Math.round(scale.adjustment.value)
            valueLabel.set_label(`${v}${unit}`)
            onChange(v)
        })

        box.append(scale)
        return box
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
            css_classes: ["settings-row"],
            margin_start: 16,
            margin_end: 16,
            margin_top: 8,
            margin_bottom: 8,
        })

        const labels = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            hexpand: true,
        })
        labels.append(new Gtk.Label({
            label,
            css_classes: ["settings-row-label"],
            halign: Gtk.Align.START,
        }))
        labels.append(new Gtk.Label({
            label: subtitle,
            css_classes: ["settings-row-subtitle"],
            halign: Gtk.Align.START,
        }))
        box.append(labels)

        const sw = new Gtk.Switch({
            active: initial,
            valign: Gtk.Align.CENTER,
        })
        sw.connect("notify::active", () => {
            onChange(sw.active)
        })
        box.append(sw)

        return box
    }

    // ── Section: Geometry ──
    const geoSection = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
    })
    geoSection.append(new Gtk.Label({
        label: "Geometría",
        css_classes: ["settings-section-title"],
        halign: Gtk.Align.START,
    }))

    const geoList = new Gtk.ListBox({
        css_classes: ["settings-list"],
        selection_mode: Gtk.SelectionMode.NONE,
    })

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
            spacing: 8,
            css_classes: ["settings-row"],
            margin_start: 16,
            margin_end: 16,
            margin_top: 8,
            margin_bottom: 8,
        })

        box.append(new Gtk.Label({
            label,
            css_classes: ["settings-row-label"],
            halign: Gtk.Align.START,
        }))

        box.append(new Gtk.Label({
            label: subtitle,
            css_classes: ["settings-row-subtitle"],
            halign: Gtk.Align.START,
        }))

        const btnBox = new Gtk.Box({
            spacing: 8,
            homogeneous: true,
            css_classes: ["settings-preset-group"],
            margin_top: 4,
        })

        const buttons: Gtk.Button[] = []
        presets.forEach((val) => {
            const btn = new Gtk.Button({
                label: `${val}${unit}`,
                css_classes: val === initial
                    ? ["settings-preset-btn", "settings-preset-active"]
                    : ["settings-preset-btn"],
            })
            btn.connect("clicked", () => {
                buttons.forEach(b => b.remove_css_class("settings-preset-active"))
                btn.add_css_class("settings-preset-active")
                onChange(val)
            })
            buttons.push(btn)
            btnBox.append(btn)
        })

        box.append(btnBox)
        return box
    }

    geoList.append(new Gtk.ListBoxRow({
        child: presetRow(
            "Tamaño de icono", "Tamaño base en reposo",
            [32, 48, 64, 80, 96], dockSettings.iconSize, "px",
            (v) => updateDockSettings({ iconSize: v }),
        ),
    }))

    geoList.append(new Gtk.ListBoxRow({
        child: sliderRow(
            "Margen inferior", "Distancia al borde de la pantalla",
            4, 16, 1, dockSettings.screenGap, "px",
            (v) => updateDockSettings({ screenGap: v }),
        ),
    }))

    geoSection.append(geoList)
    page.append(geoSection)

    // ── Section: Magnification ──
    const magSection = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
    })
    magSection.append(new Gtk.Label({
        label: "Magnificación",
        css_classes: ["settings-section-title"],
        halign: Gtk.Align.START,
    }))

    const magList = new Gtk.ListBox({
        css_classes: ["settings-list"],
        selection_mode: Gtk.SelectionMode.NONE,
    })

    magList.append(new Gtk.ListBoxRow({
        child: toggleRow(
            "Magnificación activa", "Efecto de zoom al pasar el cursor",
            dockSettings.magnification,
            (v) => updateDockSettings({ magnification: v }),
        ),
    }))

    magList.append(new Gtk.ListBoxRow({
        child: sliderRow(
            "Tamaño máximo", "Tamaño al máximo zoom",
            64, 128, 4, dockSettings.maxIconSize, "px",
            (v) => updateDockSettings({ maxIconSize: v }),
        ),
    }))

    magSection.append(magList)
    page.append(magSection)

    // ── Section: Behavior ──
    const behSection = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
    })
    behSection.append(new Gtk.Label({
        label: "Comportamiento",
        css_classes: ["settings-section-title"],
        halign: Gtk.Align.START,
    }))

    const behList = new Gtk.ListBox({
        css_classes: ["settings-list"],
        selection_mode: Gtk.SelectionMode.NONE,
    })

    behList.append(new Gtk.ListBoxRow({
        child: toggleRow(
            "Mostrar indicadores", "Punto bajo los iconos de apps abiertas",
            dockSettings.showIndicators,
            (v) => updateDockSettings({ showIndicators: v }),
        ),
    }))

    behSection.append(behList)
    page.append(behSection)

    return page
}

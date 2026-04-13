import { Gtk } from "ags/gtk4"
import { dockSettings, updateDockSettings, type DockPosition } from "../../dock/state"
import { listGroup, toggleRow, sliderRow, presetRow, dropdownRow, pageHeader, pageBox } from "../SettingsHelpers"

export default function DockPage() {
    const page = pageBox("dock-page")
    page.append(pageHeader("Dock", "Personaliza el tamaño, animación e indicadores del dock"))

    // 0. Position
    const posGroup = listGroup("Posición")
    const posOptions: { label: string; value: DockPosition }[] = [
        { label: "Inferior",  value: 'bottom' },
        { label: "Izquierda", value: 'left'   },
        { label: "Derecha",   value: 'right'  },
    ]
    posGroup.listBox.append(dropdownRow(
        "Posición del dock", "Dónde aparece el dock en la pantalla",
        posOptions.find(o => o.value === dockSettings.position)?.label ?? "Inferior",
        posOptions.map(o => o.label),
        (label) => {
            const opt = posOptions.find(o => o.label === label)
            if (!opt) return
            const isVertical = opt.value === 'left' || opt.value === 'right'
            updateDockSettings({
                position: opt.value,
                // Auto-hide is required for vertical positions — the layer-shell protocol
                // has no way to reserve side space without also pushing the bar inward.
                ...(isVertical ? { autoHide: true } : {}),
            })
        },
    ))

    const verticalNote = new Gtk.Label({
        label: "En posición lateral, ocultación automática se activa siempre.",
        css_classes: ["settings-row-subtitle"],
        halign: Gtk.Align.START,
        margin_start: 10,
        margin_top: 2,
        margin_bottom: 6,
        wrap: true,
        visible: dockSettings.position === 'left' || dockSettings.position === 'right',
    })
    posGroup.box.append(verticalNote)
    page.append(posGroup.box)

    // 1. Geometry
    const geoGroup = listGroup("Geometría")
    geoGroup.listBox.append(presetRow(
        "Tamaño de icono", "Tamaño base en reposo",
        [32, 48, 64, 80, 96], dockSettings.iconSize, "px",
        (v) => updateDockSettings({ iconSize: v }),
    ))
    geoGroup.listBox.append(sliderRow(
        "Margen inferior", "Distancia al borde de la pantalla",
        dockSettings.screenGap, 4, 32,
        (v) => updateDockSettings({ screenGap: v }),
        { unit: "px" },
    ))
    page.append(geoGroup.box)

    // 2. Effects
    const effectsGroup = listGroup("Efectos")
    effectsGroup.listBox.append(toggleRow(
        "Magnificación activa", "Efecto de zoom al pasar el cursor",
        dockSettings.magnification,
        (v) => updateDockSettings({ magnification: v }),
    ))
    effectsGroup.listBox.append(sliderRow(
        "Tamaño máximo", "Límite de expansión al magnificar",
        dockSettings.maxIconSize, 64, 128,
        (v) => updateDockSettings({ maxIconSize: v }),
        { unit: "px" },
    ))
    page.append(effectsGroup.box)

    // 3. Behavior
    const behGroup = listGroup("Comportamiento")
    behGroup.listBox.append(toggleRow(
        "Mostrar indicadores", "Punto bajo los iconos de apps abiertas",
        dockSettings.showIndicators,
        (v) => updateDockSettings({ showIndicators: v }),
    ))

    const isCurrentlyVertical = dockSettings.position === 'left' || dockSettings.position === 'right'
    const autoHideToggle = toggleRow(
        "Ocultar automáticamente",
        isCurrentlyVertical
            ? "Obligatorio en posición lateral"
            : "El dock se esconde al alejar el cursor",
        isCurrentlyVertical ? true : dockSettings.autoHide,
        (v) => { if (!isCurrentlyVertical) updateDockSettings({ autoHide: v }) },
    )
    if (isCurrentlyVertical) autoHideToggle.sensitive = false
    behGroup.listBox.append(autoHideToggle)

    const delaySlider = sliderRow(
        "Retardo al ocultar", "Tiempo antes de que el dock se oculte",
        dockSettings.hideDelay, 0, 2000,
        (v) => updateDockSettings({ hideDelay: Math.round(v) }),
        { unit: "ms" },
    )
    behGroup.listBox.append(delaySlider)

    page.append(behGroup.box)

    return page
}

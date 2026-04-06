import { Gtk } from "ags/gtk4"
import { dockSettings, updateDockSettings } from "../../dock/state"
import { listGroup, toggleRow, sliderRow, presetRow, pageHeader, pageBox } from "../SettingsHelpers"

export default function DockPage() {
    const page = pageBox("dock-page")
    page.append(pageHeader("Dock", "Personaliza el tamaño, animación e indicadores del dock"))

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
    page.append(behGroup.box)

    return page
}

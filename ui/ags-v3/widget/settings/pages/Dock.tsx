import { Gtk } from "ags/gtk4"
import { dockSettings, updateDockSettings, onDockSettingsChanged, type DockPosition } from "../../dock/state"
import { listGroup, createRow, toggleRow, sliderRow, presetRow, dropdownRow, pageHeader, pageBox } from "../SettingsHelpers"
import { t } from "../../../core/i18n"

export default function DockPage() {
    const page = pageBox("dock-page")
    page.append(pageHeader(t("settings.dock.page.title.dock"), t("settings.dock.page.subtitle.personaliza-el-tamano-animacion-e-indica")))

    // 0. Position
    const posGroup = listGroup(t("settings.dock.group.posicion"))
    const posOptions: { label: string; value: DockPosition }[] = [
        { label: t("settings.dock.label.inferior"),  value: 'bottom' },
        { label: t("settings.dock.label.izquierda"), value: 'left'   },
        { label: t("settings.dock.label.derecha"),   value: 'right'  },
    ]
    posGroup.listBox.append(dropdownRow(
        t("settings.dock.row.label.posicion-del-dock"), t("settings.dock.row.desc.donde-aparece-el-dock-en-la-pantalla"),
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
        label: t("settings.dock.label.en-posicion-lateral-ocultacion-automatic"),
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
    const geoGroup = listGroup(t("settings.dock.group.geometria"))
    geoGroup.listBox.append(presetRow(
        "Tamaño de icono", "Tamaño base en reposo",
        [32, 48, 64, 80, 96], dockSettings.iconSize, "px",
        (v) => updateDockSettings({ iconSize: v }),
    ))
    geoGroup.listBox.append(sliderRow(
        t("settings.dock.row.label.margen-inferior"), t("settings.dock.row.desc.distancia-al-borde-de-la-pantalla"),
        dockSettings.screenGap, 4, 32,
        (v) => updateDockSettings({ screenGap: v }),
        { unit: "px" },
    ))
    page.append(geoGroup.box)

    // 2. Effects
    const effectsGroup = listGroup(t("settings.dock.group.efectos"))
    effectsGroup.listBox.append(toggleRow(
        t("settings.dock.row.label.magnificacion-activa"), t("settings.dock.row.desc.efecto-de-zoom-al-pasar-el-cursor"),
        dockSettings.magnification,
        (v) => updateDockSettings({ magnification: v }),
    ))
    effectsGroup.listBox.append(sliderRow(
        t("settings.dock.row.label.tamano-maximo"), t("settings.dock.row.desc.limite-de-expansion-al-magnificar"),
        dockSettings.maxIconSize, 64, 128,
        (v) => updateDockSettings({ maxIconSize: v }),
        { unit: "px" },
    ))
    page.append(effectsGroup.box)

    // 3. Behavior
    const behGroup = listGroup(t("settings.dock.group.comportamiento"))
    behGroup.listBox.append(toggleRow(
        t("settings.dock.row.label.mostrar-indicadores"), t("settings.dock.row.desc.punto-bajo-los-iconos-de-apps-abiertas"),
        dockSettings.showIndicators,
        (v) => updateDockSettings({ showIndicators: v }),
    ))

    // Auto-hide — built manually so we can update it reactively when position changes
    const autoHideSwitch = new Gtk.Switch({ active: dockSettings.autoHide, valign: Gtk.Align.CENTER })
    const autoHideSubtitle = new Gtk.Label({
        label: t("settings.dock.row.desc.el-dock-se-esconde-al-alejar-el-cursor"),
        css_classes: ["settings-row-subtitle"],
        halign: Gtk.Align.START,
        ellipsize: 3,
    })
    autoHideSwitch.connect("state-set", (_: any, state: boolean) => {
        if (dockSettings.position !== 'left' && dockSettings.position !== 'right')
            updateDockSettings({ autoHide: state })
        return false
    })
    const autoHideRow = createRow(t("settings.dock.row.label.ocultar-automaticamente"), "El dock se esconde al alejar el cursor", autoHideSwitch)
    behGroup.listBox.append(autoHideRow)

    const syncAutoHide = () => {
        const vertical = dockSettings.position === 'left' || dockSettings.position === 'right'
        autoHideRow.sensitive = !vertical
        autoHideSwitch.active = vertical ? true : dockSettings.autoHide
        verticalNote.visible = vertical
    }
    syncAutoHide()
    const unsub = onDockSettingsChanged(syncAutoHide)
    page.connect("unrealize", () => { try { unsub?.() } catch {} })

    const delaySlider = sliderRow(
        t("settings.dock.row.label.retardo-al-ocultar"), t("settings.dock.row.desc.tiempo-antes-de-que-el-dock-se-oculte"),
        dockSettings.hideDelay, 0, 2000,
        (v) => updateDockSettings({ hideDelay: Math.round(v) }),
        { unit: "ms" },
    )
    behGroup.listBox.append(delaySlider)

    page.append(behGroup.box)

    return page
}

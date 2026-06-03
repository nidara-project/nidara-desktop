import { Gtk } from "ags/gtk4"
import { dockSettings, updateDockSettings, onDockSettingsChanged, type DockPosition } from "../../dock/state"
import { listGroup, createRow, toggleRow, sliderRow, presetRow, dropdownRow, pageHeader, pageBox } from "../SettingsHelpers"
import { t } from "../../../core/i18n"

export default function DockPage() {
    const page = pageBox("dock-page")
    page.append(pageHeader(t("settings.dock.title"), t("settings.dock.subtitle")))

    // 0. Position
    const posGroup = listGroup(t("settings.dock.group.position"))
    const posOptions: { label: string; value: DockPosition }[] = [
        { label: t("settings.dock.opt.bottom"),  value: 'bottom' },
        { label: t("settings.dock.opt.left"), value: 'left'   },
        { label: t("settings.dock.opt.right"),   value: 'right'  },
    ]
    posGroup.listBox.append(dropdownRow(
        t("settings.dock.position"), t("settings.dock.position.desc"),
        posOptions.find(o => o.value === dockSettings.position)?.label ?? t("settings.dock.opt.bottom"),
        posOptions.map(o => o.label),
        (label) => {
            const opt = posOptions.find(o => o.label === label)
            if (!opt) return
            updateDockSettings({ position: opt.value })
        },
    ))

    const verticalNote = new Gtk.Label({
        label: t("settings.dock.side-autohide-note"),
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
    const geoGroup = listGroup(t("settings.dock.group.geometry"))
    geoGroup.listBox.append(presetRow(
        t("settings.dock.icon-size"), t("settings.dock.icon-size.desc"),
        [32, 48, 64, 80, 96], dockSettings.iconSize, "px",
        (v) => updateDockSettings({ iconSize: v }),
    ))
    geoGroup.listBox.append(sliderRow(
        t("settings.dock.bottom-margin"), t("settings.dock.bottom-margin.desc"),
        dockSettings.screenGap, 4, 32,
        (v) => updateDockSettings({ screenGap: v }),
        { unit: "px" },
    ))
    page.append(geoGroup.box)

    // 2. Effects
    const effectsGroup = listGroup(t("settings.dock.group.effects"))
    effectsGroup.listBox.append(toggleRow(
        t("settings.dock.magnification"), t("settings.dock.magnification.desc"),
        dockSettings.magnification,
        (v) => updateDockSettings({ magnification: v }),
    ))
    effectsGroup.listBox.append(sliderRow(
        t("settings.dock.max-size"), t("settings.dock.max-size.desc"),
        dockSettings.maxIconSize, 64, 128,
        (v) => updateDockSettings({ maxIconSize: v }),
        { unit: "px" },
    ))
    page.append(effectsGroup.box)

    // 3. Behavior
    const behGroup = listGroup(t("settings.dock.group.behavior"))
    behGroup.listBox.append(toggleRow(
        t("settings.dock.indicators"), t("settings.dock.indicators.desc"),
        dockSettings.showIndicators,
        (v) => updateDockSettings({ showIndicators: v }),
    ))

    // Auto-hide — built manually so we can update it reactively when position changes
    const autoHideSwitch = new Gtk.Switch({ active: dockSettings.autoHide, valign: Gtk.Align.CENTER })
    const autoHideSubtitle = new Gtk.Label({
        label: t("settings.dock.autohide.desc"),
        css_classes: ["settings-row-subtitle"],
        halign: Gtk.Align.START,
        ellipsize: 3,
    })
    autoHideSwitch.connect("state-set", (_: any, state: boolean) => {
        updateDockSettings({ autoHide: state })
        return false
    })
    const autoHideRow = createRow(t("settings.dock.autohide"), t("settings.dock.autohide.desc"), autoHideSwitch)
    behGroup.listBox.append(autoHideRow)

    const syncAutoHide = () => {
        const vertical = dockSettings.position === 'left' || dockSettings.position === 'right'
        autoHideSwitch.active = dockSettings.autoHide
        verticalNote.visible = vertical
    }
    syncAutoHide()
    const unsub = onDockSettingsChanged(syncAutoHide)
    page.connect("unrealize", () => { try { unsub?.() } catch {} })

    const delaySlider = sliderRow(
        t("settings.dock.hide-delay"), t("settings.dock.hide-delay.desc"),
        dockSettings.hideDelay, 0, 2000,
        (v) => updateDockSettings({ hideDelay: Math.round(v) }),
        { unit: "ms" },
    )
    behGroup.listBox.append(delaySlider)

    page.append(behGroup.box)

    return page
}

import Gtk from "gi://Gtk?version=4.0"
import { dockSettings, updateDockSettings, onDockSettingsChanged } from "../../dock/state"
import { listGroup, presetRow, pageBox, bindWhileRealized, settingRow } from "../SettingsHelpers"
import { t } from "../../../core/i18n"

export default function DockPage() {
    const page = pageBox("dock-page")

    // 0. Position
    const posGroup = listGroup(t("settings.dock.group.position"), t("settings.dock.side-autohide-note"))
    posGroup.listBox.append(settingRow("dock.position"))

    // The kit's group footer, not a hand-rolled label — it only has to be TOLD
    // when to show, because this note is true of the side positions only.
    const verticalNote = posGroup.footerLabel!
    page.append(posGroup.box)

    // 1. Geometry
    const geoGroup = listGroup(t("settings.dock.group.geometry"))
    geoGroup.listBox.append(presetRow(
        t("settings.dock.icon-size"), t("settings.dock.icon-size.desc"),
        [32, 48, 64, 80, 96], dockSettings.iconSize, "px",
        (v) => updateDockSettings({ iconSize: v }),
    ))
    geoGroup.listBox.append(settingRow("dock.screenGap"))
    page.append(geoGroup.box)

    // 2. Effects
    const effectsGroup = listGroup(t("settings.dock.group.effects"))
    effectsGroup.listBox.append(settingRow("dock.magnification"))
    effectsGroup.listBox.append(settingRow("dock.maxIconSize"))
    page.append(effectsGroup.box)

    // 3. Behavior
    const behGroup = listGroup(t("settings.dock.group.behavior"))
    behGroup.listBox.append(settingRow("dock.indicators"))
    behGroup.listBox.append(settingRow("dock.autoHide"))
    behGroup.listBox.append(settingRow("dock.hideDelay"))

    const syncVerticalNote = () => {
        const vertical = dockSettings.position === 'left' || dockSettings.position === 'right'
        verticalNote.visible = vertical
    }
    bindWhileRealized(page, () => {
        syncVerticalNote()
        return onDockSettingsChanged(syncVerticalNote)
    })

    page.append(behGroup.box)

    return page
}

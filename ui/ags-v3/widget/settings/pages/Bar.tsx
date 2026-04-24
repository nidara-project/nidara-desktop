import { listGroup, pageHeader, pageBox, toggleRow } from "../SettingsHelpers"
import { barSettings, updateBarSettings } from "../../bar/barState"
import { t } from "../../../core/i18n"

export default function BarPage() {
    const page = pageBox("bar-page")
    page.append(pageHeader(t("settings.bar.title"), t("settings.bar.subtitle")))

    const layoutGroup = listGroup(t("settings.bar.group.layout"))

    layoutGroup.listBox.append(toggleRow(
        t("settings.bar.row.label.system-menu"),
        t("settings.bar.row.desc.system-menu"),
        barSettings.showSystemMenu,
        (v) => updateBarSettings({ showSystemMenu: v }),
    ))

    layoutGroup.listBox.append(toggleRow(
        t("settings.bar.row.label.app-title"),
        t("settings.bar.row.desc.app-title"),
        barSettings.showAppTitle,
        (v) => updateBarSettings({ showAppTitle: v }),
    ))

    layoutGroup.listBox.append(toggleRow(
        t("settings.bar.row.label.workspaces"),
        t("settings.bar.row.desc.workspaces"),
        barSettings.showWorkspaces,
        (v) => updateBarSettings({ showWorkspaces: v }),
    ))

    page.append(layoutGroup.box)

    return page
}

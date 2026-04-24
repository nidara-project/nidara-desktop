import { listGroup, pageHeader, pageBox, toggleRow, sliderRow } from "../SettingsHelpers"
import notifConfig from "../../../core/NotifConfig"
import { t } from "../../../core/i18n"

export default function NotificationsPage() {
    const page = pageBox("notifications-page")
    page.append(pageHeader(t("settings.notif.title"), t("settings.notif.subtitle")))

    const popupsGroup = listGroup(t("settings.notif.group.popups"))

    popupsGroup.listBox.append(sliderRow(
        t("settings.notif.row.label.timeout"),
        t("settings.notif.row.desc.timeout"),
        notifConfig.popupTimeout, 2, 15,
        (v) => notifConfig.setPopupTimeout(v),
        { unit: "s" },
    ))

    page.append(popupsGroup.box)

    const dndGroup = listGroup(t("settings.notif.group.dnd"))

    dndGroup.listBox.append(toggleRow(
        t("settings.notif.row.label.dnd-default"),
        t("settings.notif.row.desc.dnd-default"),
        notifConfig.dndDefault,
        (v) => notifConfig.setDndDefault(v),
    ))

    page.append(dndGroup.box)

    return page
}

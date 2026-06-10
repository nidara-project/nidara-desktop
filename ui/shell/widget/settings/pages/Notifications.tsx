import { listGroup, pageBox, toggleRow, sliderRow } from "../SettingsHelpers"
import notifConfig from "../../../core/NotifConfig"
import { t } from "../../../core/i18n"

export default function NotificationsPage() {
    const page = pageBox("notifications-page")

    const popupsGroup = listGroup(t("settings.notif.group.popups"))

    popupsGroup.listBox.append(sliderRow(
        t("settings.notif.timeout"),
        t("settings.notif.timeout.desc"),
        notifConfig.popupTimeout, 2, 15,
        (v) => notifConfig.setPopupTimeout(v),
        { unit: "s" },
    ))

    page.append(popupsGroup.box)

    const dndGroup = listGroup(t("settings.notif.group.dnd"))

    dndGroup.listBox.append(toggleRow(
        t("settings.notif.dnd-default"),
        t("settings.notif.dnd-default.desc"),
        notifConfig.dndDefault,
        (v) => notifConfig.setDndDefault(v),
    ))

    page.append(dndGroup.box)

    return page
}

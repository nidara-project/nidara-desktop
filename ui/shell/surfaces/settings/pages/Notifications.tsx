import { listGroup, pageBox, toggleRow, sliderRow } from "../SettingsHelpers"
import notifConfig from "../../../core/NotifConfig"
import { dontDisturb, setDontDisturb, watchDnd } from "../../../core/NotifService"
import { t } from "../../../core/i18n"

export default function NotificationsPage() {
    const page = pageBox("notifications-page")

    // ── Do not disturb ────────────────────────────────────────────────────────
    // 🔑 This row is the LIVE flag, not a preference about it. It persists in
    // `notif-config.json` and survives sessions and reboots — which is why GNOME,
    // whose DnD is the same shape, also ships exactly one control for it and no
    // "start with it on" option.
    //
    // It replaced an "Enable on login" toggle (removed 2026-08-16) that could
    // only ever set the flag TRUE, from `main()` — i.e. on every UI reload, not
    // just at login. Its OFF position implied sessions would start undisturbed
    // and delivered nothing, because nothing ever cleared the persisted flag.
    //
    // Headerless group, first on the page: this is the same bit the Control
    // Center's focus tile flips, and a "Do not disturb" card under a "Do not
    // disturb" header would just say it twice. Popup behaviour follows below.
    const dndGroup = listGroup("")

    // `onExt` must re-READ, not only re-arm: a Settings page is cached and
    // rebinds on realize, and DnD is normally flipped from the CC while this
    // page sits unrealized — so the switch is stale by the time it comes back.
    dndGroup.listBox.append(toggleRow(
        t("settings.notif.dnd"),
        t("settings.notif.dnd.desc"),
        dontDisturb(),
        setDontDisturb,
        (apply) => {
            apply(dontDisturb())
            return watchDnd(() => apply(dontDisturb()))
        },
    ))

    page.append(dndGroup.box)

    const popupsGroup = listGroup(t("settings.notif.group.popups"))

    popupsGroup.listBox.append(sliderRow(
        t("settings.notif.timeout"),
        t("settings.notif.timeout.desc"),
        notifConfig.popupTimeout, 2, 15,
        (v) => notifConfig.setPopupTimeout(v),
        { unit: "s" },
    ))

    page.append(popupsGroup.box)

    return page
}

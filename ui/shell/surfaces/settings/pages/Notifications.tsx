import AstalNotifd from "gi://AstalNotifd"
import { listGroup, pageBox, toggleRow, sliderRow } from "../SettingsHelpers"
import notifConfig from "../../../core/NotifConfig"
import { safeDisconnect } from "../../../core/signals"
import { t } from "../../../core/i18n"

export default function NotificationsPage() {
    const page = pageBox("notifications-page")

    // ── Do not disturb ────────────────────────────────────────────────────────
    // 🔑 This row is the LIVE flag, not a preference about it. AstalNotifd's
    // `dont_disturb` is a straight accessor over GSettings (`io.astal.notifd
    // dont-disturb`), so it already persists in dconf across sessions and reboots
    // with no help from us — which is why GNOME, whose DnD is the same shape,
    // also ships exactly one control for it and no "start with it on" option.
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
        AstalNotifd.get_default()?.dont_disturb ?? false,
        (v) => { const nd = AstalNotifd.get_default(); if (nd) nd.dont_disturb = v },
        (apply) => {
            const nd = AstalNotifd.get_default()
            if (!nd) return () => {}
            apply(nd.dont_disturb)
            const id = nd.connect("notify::dont-disturb", () => apply(nd.dont_disturb))
            return () => safeDisconnect(nd, id)
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

// NotifService — the single source of notification domain logic.
//
// Same stateless-facade pattern as AudioService / NetworkService / BluetoothService.
// It exists because notifications were the last domain with NO facade at all: sixteen
// bare `AstalNotifd.get_default()` calls scattered across the CC, the popups, the
// focus tile, the Settings page and the agent config registry — five files that each
// re-derived "is this critical", "flip the DnD bit", "watch the DnD bit".
//
// Two layers below it, not one, and the split is deliberate:
//
//   - `core/notifd.ts` is the SERVER — it owns `org.freedesktop.Notifications`,
//     receives, persists and expires. Ours since 2026-08-18, when it replaced
//     AstalNotifd.
//   - `core/NotifConfig.ts` holds Do Not Disturb, because DnD is not something the
//     server does. It suppresses BANNERS; the notification still arrives and still
//     lands in the NC. (AstalNotifd kept it in GSettings only so its proxies could
//     share the bit — its own docs say the property "does not have any effect on
//     its own".)
//
// Never imports Gtk — this is `core/`.

import { getDefault, Urgency, type Notification as NotifObject } from "./notifd"
import notifConfig from "./NotifConfig"

/** A received notification. Re-exported so surfaces can name one without importing
 *  the daemon layer — the facade rule: nothing outside `core/` says `core/notifd`. */
export type Notification = NotifObject

/** `{ id, label }` pairs from `n.get_actions()`. */
export type NotifAction = { id: string, label: string }

export type Dispose = () => void

/** The daemon. */
function daemon() {
    return getDefault()
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** Every unresolved notification, newest last. Includes `transient` ones — the NC
 *  filters those out itself (freedesktop: transient = excluded from persistence).
 *
 *  A SNAPSHOT, safe to hold: the clear-all cascade keeps the list it took at click
 *  time and dismisses it a few hundred ms later, after rows have flown out. */
export function notifications(): Notification[] {
    return daemon().notifications
}

/** The notification with this id, or null once it has been resolved. */
export function getNotification(id: number): Notification | null {
    return daemon().getNotification(id)
}

/** CRITICAL urgency: never auto-expires, and cuts through Do Not Disturb. The two
 *  call sites that ask this used to spell the enum out; it is the same question. */
export function isCritical(n: Notification): boolean {
    return n?.urgency === Urgency.CRITICAL
}

// ── Do Not Disturb ───────────────────────────────────────────────────────────
//
// The LIVE flag, not a preference about it — the CC focus tile, Settings →
// Notifications and `notifications.doNotDisturb` in the agent registry are four
// faces of this one bit (the bar's focus widget is the fourth), and
// `notif-config.json` is its only home.

export function dontDisturb(): boolean {
    return notifConfig.doNotDisturb
}

export function setDontDisturb(on: boolean): void {
    notifConfig.setDoNotDisturb(on)
}

export function toggleDontDisturb(): void {
    setDontDisturb(!dontDisturb())
}

// ── Subscriptions ────────────────────────────────────────────────────────────

/** Fires when the DnD bit changes, whoever flipped it.
 *
 *  Narrow on purpose: the focus tile used to listen to bare `notify` — EVERY
 *  property of the daemon — to watch one boolean. */
export function watchDnd(cb: () => void): Dispose {
    return notifConfig.onChange(key => { if (key === "doNotDisturb") cb() })
}

/** A notification was received. `replaced` = it reused a live id (progress updates). */
export function watchNotified(cb: (id: number, replaced: boolean) => void): Dispose {
    return daemon().onNotified(cb)
}

/** A notification left the daemon — dismissed, expired, or closed by its sender. */
export function watchResolved(cb: (id: number) => void): Dispose {
    return daemon().onResolved(cb)
}

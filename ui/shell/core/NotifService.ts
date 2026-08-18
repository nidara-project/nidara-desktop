// NotifService — the single source of notification domain logic.
//
// Same stateless-facade pattern as AudioService / NetworkService / BluetoothService.
// It exists because notifications were the last domain with NO facade at all: sixteen
// bare `AstalNotifd.get_default()` calls scattered across the CC, the popups, the
// focus tile, the Settings page and the agent config registry — five files that each
// re-derived "is this critical", "flip the DnD bit", "watch the DnD bit".
//
// The layer below is `gi://AstalNotifd` today; it is about to become ours (the same
// swap NetworkService/BluetoothService/AudioService already went through). That is the
// whole point of landing this first: after it, the swap touches ONE file.
//
// Never imports Gtk — this is `core/`.

import AstalNotifd from "gi://AstalNotifd"
import { safeDisconnect } from "./signals"

/** A received notification. Re-exported so surfaces can name one without importing
 *  the daemon layer — the facade rule: nothing outside `core/` says `gi://AstalNotifd`. */
export type Notification = AstalNotifd.Notification

/** `{ id, label }` pairs from `n.get_actions()`. */
export type NotifAction = { id: string, label: string }

export type Dispose = () => void

/** The daemon. Null only if it failed to come up at all. */
function daemon(): any {
    return AstalNotifd.get_default()
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** Every unresolved notification, newest last. Includes `transient` ones — the NC
 *  filters those out itself (freedesktop: transient = excluded from persistence).
 *
 *  A SNAPSHOT, safe to hold: the clear-all cascade keeps the list it took at click
 *  time and dismisses it a few hundred ms later, after rows have flown out. */
export function notifications(): Notification[] {
    const list = daemon()?.notifications
    return list ? [...list] : []
}

/** The notification with this id, or null once it has been resolved. */
export function getNotification(id: number): Notification | null {
    return daemon()?.get_notification(id) ?? null
}

/** CRITICAL urgency: never auto-expires, and cuts through Do Not Disturb. The two
 *  call sites that ask this used to spell the enum out; it is the same question. */
export function isCritical(n: Notification): boolean {
    return (n as any)?.urgency === AstalNotifd.Urgency.CRITICAL
}

// ── Do Not Disturb ───────────────────────────────────────────────────────────
//
// The LIVE flag, not a preference about it — the CC focus tile, Settings →
// Notifications and `notifications.doNotDisturb` in the agent registry are three
// faces of this one bit. It persists on its own (GSettings today), which is why
// core/NotifConfig.ts deliberately keeps no copy of it.

export function dontDisturb(): boolean {
    return daemon()?.dont_disturb ?? false
}

export function setDontDisturb(on: boolean): void {
    const d = daemon()
    if (d) d.dont_disturb = on
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
    const d = daemon()
    if (!d) return () => {}
    const id = d.connect("notify::dont-disturb", cb)
    return () => safeDisconnect(d, id)
}

/** A notification was received. `replaced` = it reused a live id (progress updates). */
export function watchNotified(cb: (id: number, replaced: boolean) => void): Dispose {
    const d = daemon()
    if (!d) return () => {}
    const sig = d.connect("notified", (_s: any, id: number, replaced: boolean) => cb(id, replaced))
    return () => safeDisconnect(d, sig)
}

/** A notification left the daemon — dismissed, expired, or closed by its sender. */
export function watchResolved(cb: (id: number) => void): Dispose {
    const d = daemon()
    if (!d) return () => {}
    const sig = d.connect("resolved", (_s: any, id: number) => cb(id))
    return () => safeDisconnect(d, sig)
}

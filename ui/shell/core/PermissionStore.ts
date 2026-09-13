import Gio from "gi://Gio"
import GLib from "gi://GLib"

/**
 * The XDG portal's per-app permission decisions — read, changed and followed.
 *
 * xdg-desktop-portal keeps what the user answered in a consent prompt ("Allow
 * Relojes to use the camera?") in `org.freedesktop.impl.portal.PermissionStore`,
 * one table per kind, keyed by app id. It reads the store BEFORE asking and writes
 * the answer after, which is why the prompt itself (surfaces/consent) never
 * persists anything. Settings → Apps edits the same entries, so a decision has one
 * home and two views: the prompt that records it, the page that changes it.
 *
 * Three states, the way the store actually has them:
 *   - `ask`   — no entry for the app: the portal will prompt the next time;
 *   - `allow` — `["yes"]`;
 *   - `deny`  — `["no"]`.
 *
 * ── Which permissions exist, MEASURED (2026-09-13, xdg-desktop-portal 1.22.1) ──
 * A private store, the real frontend, a grant-everything probe backend, and the
 * requests made from INSIDE the Flatpak `org.gnome.clocks` (an unsandboxed caller
 * is not gated, so it writes nothing):
 *   Camera.AccessCamera                → devices/camera       {app: ["yes"]}
 *   Wallpaper.SetWallpaperURI (no preview) → wallpaper/wallpaper {app: ["yes"]}
 *   Background.RequestBackground       → background/background — but NO backend
 *                                        serves Background on Nidara yet (tech-debt #89)
 *   Screenshot.Screenshot (non-interactive) → nothing stored: not a remembered
 *                                        permission in this portal version
 * Only what a user can actually be asked on this desktop is listed below. The
 * microphone is not a portal permission at all — a Flatpak reaches it through its
 * `pulseaudio` socket, a static permission (#535 part 3).
 */
export type PortalPermissionState = "ask" | "allow" | "deny"

export interface PortalPermissionKey {
    table: string
    id: string
}

export const PORTAL_PERMISSIONS = {
    camera:    { table: "devices",   id: "camera" },
    wallpaper: { table: "wallpaper", id: "wallpaper" },
} as const satisfies Record<string, PortalPermissionKey>

const BUS = "org.freedesktop.impl.portal.PermissionStore"
const PATH = "/org/freedesktop/impl/portal/PermissionStore"
const IFACE = "org.freedesktop.impl.portal.PermissionStore"

function call(method: string, params: GLib.Variant | null, replyType: string | null): Promise<GLib.Variant | null> {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call(
            BUS, PATH, IFACE, method, params,
            replyType ? new GLib.VariantType(replyType) : null,
            Gio.DBusCallFlags.NONE, 5000, null,
            (bus: any, res: any) => {
                try { resolve(bus.call_finish(res)) } catch (e) { reject(e) }
            },
        )
    })
}

function stateOf(perms: Record<string, string[]> | undefined, appId: string): PortalPermissionState {
    const v = perms?.[appId]?.[0]
    return v === "yes" ? "allow" : v === "no" ? "deny" : "ask"
}

/** The app's current decision. A table that does not exist yet means nobody was asked. */
export async function getPortalPermission(key: PortalPermissionKey, appId: string): Promise<PortalPermissionState> {
    try {
        const reply = await call("GetPermission", new GLib.Variant("(sss)", [key.table, key.id, appId]), "(as)")
        const [values] = reply!.deepUnpack() as [string[]]
        return values[0] === "yes" ? "allow" : values[0] === "no" ? "deny" : "ask"
    } catch {
        // NotFound for the table or the id: no decision recorded.
        return "ask"
    }
}

/**
 * Record a decision. `ask` REMOVES the app's entry rather than storing a third
 * value — the portal only prompts when there is no entry, so that is what "ask
 * again" is.
 */
export async function setPortalPermission(
    key: PortalPermissionKey, appId: string, state: PortalPermissionState,
): Promise<void> {
    if (state === "ask") {
        try {
            await call("DeletePermission", new GLib.Variant("(sss)", [key.table, key.id, appId]), null)
        } catch { /* nothing to delete: already "ask" */ }
        return
    }
    await call("SetPermission",
        new GLib.Variant("(sbssas)", [key.table, true, key.id, appId, [state === "allow" ? "yes" : "no"]]), null)
}

/**
 * Follow one app's decision for one permission — the consent prompt answering, or
 * another view changing it. Returns an unsubscribe.
 */
export function watchPortalPermission(
    key: PortalPermissionKey, appId: string, cb: (state: PortalPermissionState) => void,
): () => void {
    const bus = Gio.DBus.session
    const sub = bus.signal_subscribe(
        BUS, IFACE, "Changed", PATH, key.table, Gio.DBusSignalFlags.NONE,
        (_c: any, _s: any, _p: any, _i: any, _sig: any, params: GLib.Variant) => {
            // Changed(s table, s id, b deleted, v data, a{sas} permissions)
            const [table, id, deleted, , perms] = params.deepUnpack() as
                [string, string, boolean, unknown, Record<string, string[]>]
            if (table !== key.table || id !== key.id) return
            cb(deleted ? "ask" : stateOf(perms, appId))
        },
    )
    return () => bus.signal_unsubscribe(sub)
}

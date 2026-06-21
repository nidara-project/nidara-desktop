import GObject from "gi://GObject"

/**
 * Disconnect a GObject signal handler only if it is still connected.
 *
 * A bare `obj.disconnect(staleId)` emits a `GLib-GObject-CRITICAL … instance has
 * no handler with id` at the C level, which a JS `try/catch` does NOT catch (it's a
 * logged critical, not a thrown error). Cleanups wired to `unrealize` run more than
 * once (GTK realize/unrealize cycles — e.g. an overlay toggled open/closed), so the
 * second run disconnects a stale id and spams criticals. Guarding with
 * `signal_handler_is_connected` makes the disconnect idempotent. See tech-debt #12.
 */
// `obj` is any GI GObject (the call sites pass heterogeneous Astal/GTK objects, several
// already cast `as any`); we only need its `disconnect`. Typed loosely on purpose.
export function safeDisconnect(
    obj: any,
    id: number | null | undefined,
): void {
    if (obj && id && GObject.signal_handler_is_connected(obj, id)) obj.disconnect(id)
}

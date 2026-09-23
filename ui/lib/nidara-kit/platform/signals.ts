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
 *
 * Lives in `ui/lib/` because the kit needs it: every kit component that connects to
 * something it does not own has to clean up on `unrealize`, and a component in
 * `ui/lib/` may not import from `ui/shell/`. The shell keeps importing it from
 * `core/signals` — see that file.
 *
 * ⚠️ It calls `GObject.signal_handler_disconnect`, NOT `obj.disconnect(id)`, and that
 * is not a style preference. `disconnect` is an ordinary method name, so a GI class is
 * free to own one — and `NM.Device` does: `nm_device_disconnect(device, cancellable)`
 * DEACTIVATES THE INTERFACE. On such an object `obj.disconnect(id)` resolves to the
 * library's method, and the handler id is handed over as the cancellable. GJS happens
 * to reject that on type (`Expected an object of type GCancellable … but got type
 * number`, seen 2026-08-17 while wiring NetworkService to libnm), so it surfaced as a
 * failed cleanup rather than as a dropped network connection — a coin-flip we should
 * not be taking. `signal_handler_disconnect` is unambiguous and cannot be shadowed.
 */
// `obj` is any GI GObject (the call sites pass heterogeneous Astal/GTK objects, several
// already cast `as any`). Typed loosely on purpose.
export function safeDisconnect(
    obj: any,
    id: number | null | undefined,
): void {
    if (obj && id && GObject.signal_handler_is_connected(obj, id)) {
        GObject.signal_handler_disconnect(obj, id)
    }
}

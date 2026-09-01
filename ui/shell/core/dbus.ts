// core/dbus.ts — common ground for D-Bus clients in the shell.
//
// Replaces repetitive DBusProxy creation, method calls, and signal subscriptions
// across our five D-Bus clients (mpris, bluez, tray, wireplumber, notifd).
//
// ## The disposer IS the product
//
// Subscribing without receiving a way to release the handler makes leaks the
// default. Every subscription helper in this module returns an idempotent
// disposer `() => void` that disconnects the underlying handler:
//   - GObject proxy signals (`g-properties-changed`, `g-signal`) are disconnected
//     with `safeDisconnect` (from `core/signals`).
//   - Connection signals (`signal_subscribe`) are disconnected with `signal_unsubscribe`.
//   - Calling a disposer multiple times is completely safe.
//
// ## Lifecycles: per-object vs session
//
// A service living for the whole session does not leak by holding a subscription.
// What matters is what is subscribed PER OBJECT — a media player, a bluetooth device,
// a tray item — that is instantiated and torn down repeatedly while the session remains
// active. Retaining proxy handlers in objects closing over `this` prevents GC and leaks
// memory across lifecycle cycles. Disposers must be tracked per object and invoked on close.
//
// ## Architectural invariants (DO NOT FLATTEN)
//
// 1. Connection calls vs Proxy calls:
//    `bluez.ts` (and properties resync) calls directly via `Gio.DBusConnection.call`
//    because `proxy.call()` routes to the proxy's interface; invoking
//    `org.freedesktop.DBus.Properties` on a proxy causes D-Bus to fail with
//    `UnknownMethod`. We export `callConn` alongside `call` to preserve both paths.
//
// 2. Plain objects vs GObjects:
//    `tray.ts` items are plain JS objects, NOT GObjects, to prevent `g_param_spec_unref`
//    UAF segfaults. This helper works directly with raw Gio proxies and connections
//    and does NOT force client classes to be GObjects.

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { safeDisconnect } from "./signals"

export interface SignalOptions {
    sender?: string | null
    iface?: string | null
    member?: string | null
    path?: string | null
    arg0?: string | null
    flags?: Gio.DBusSignalFlags
}

/**
 * Asynchronously create a Gio.DBusProxy for a given name, object path, and interface.
 */
export function proxy(
    conn: Gio.DBusConnection,
    flags: Gio.DBusProxyFlags,
    name: string | null,
    path: string,
    iface: string,
    cancellable: Gio.Cancellable | null = null,
): Promise<Gio.DBusProxy> {
    return new Promise((resolve, reject) => {
        Gio.DBusProxy.new(
            conn,
            flags,
            null,
            name,
            path,
            iface,
            cancellable,
            (_src, res) => {
                try {
                    resolve(Gio.DBusProxy.new_finish(res))
                } catch (e) {
                    reject(e)
                }
            },
        )
    })
}

/**
 * Call a D-Bus method on a Gio.DBusProxy.
 */
export function call(
    p: Gio.DBusProxy,
    method: string,
    params: GLib.Variant | null = null,
    // Sin `replyType`: `Gio.DBusProxy.call` no lo acepta — el proxy ya conoce su
    // interfaz. Estaba en la firma sin usarse, que es un parámetro que miente.
    // Para respuestas tipadas está `callConn`, que sí lo pasa.
    flags: Gio.DBusCallFlags = Gio.DBusCallFlags.NO_AUTO_START,
    timeoutMsec: number = -1,
    cancellable: Gio.Cancellable | null = null,
): Promise<GLib.Variant> {
    return new Promise((resolve, reject) => {
        p.call(
            method,
            params,
            flags,
            timeoutMsec,
            cancellable,
            (_src, res) => {
                try {
                    resolve(p.call_finish(res))
                } catch (e) {
                    reject(e)
                }
            },
        )
    })
}

/**
 * Call a D-Bus method directly on a Gio.DBusConnection.
 *
 * Essential for interfaces that differ from the proxy's own interface (e.g.
 * org.freedesktop.DBus.Properties on bluez or mpris resync), where calling on the
 * proxy would route to the proxy interface and fail with UnknownMethod.
 */
export function callConn(
    conn: Gio.DBusConnection,
    busName: string | null,
    path: string,
    iface: string,
    method: string,
    params: GLib.Variant | null = null,
    replyType: GLib.VariantType | null = null,
    flags: Gio.DBusCallFlags = Gio.DBusCallFlags.NO_AUTO_START,
    timeoutMsec: number = -1,
    cancellable: Gio.Cancellable | null = null,
): Promise<GLib.Variant> {
    return new Promise((resolve, reject) => {
        conn.call(
            busName,
            path,
            iface,
            method,
            params,
            replyType,
            flags,
            timeoutMsec,
            cancellable,
            (_src, res) => {
                try {
                    resolve(conn.call_finish(res))
                } catch (e) {
                    reject(e)
                }
            },
        )
    })
}

/**
 * Subscribe to `g-properties-changed` on a Gio.DBusProxy.
 *
 * Returns an idempotent disposer function that disconnects the signal handler
 * using safeDisconnect.
 */
export function onProps(
    p: Gio.DBusProxy,
    cb: (changed: any, invalidated: string[], proxy: Gio.DBusProxy) => void,
): () => void {
    if (!p) return () => {}
    let disposed = false
    const id = p.connect("g-properties-changed", (_proxy: any, changed: any, invalidated: any) => {
        cb(changed, invalidated, p)
    })
    return () => {
        if (disposed) return
        disposed = true
        safeDisconnect(p, id)
    }
}

/**
 * Subscribe to a proxy's `g-signal`. Returns an idempotent disposer.
 *
 * ⚠️ Deliberadamente NO hay una función que acepte «conexión o proxy» y decida en
 * ejecución cuál es: son dos suscripciones distintas (`connect` frente a
 * `signal_subscribe`) con dos formas de soltarlas, y un despacho por duck-typing
 * las hace parecer una sola hasta el día que se equivoca. Dos nombres, dos cosas.
 */
/**
 * Explicit helper for proxy `g-signal` subscriptions.
 */
export function onProxySignal(
    p: Gio.DBusProxy,
    cb: (proxy: Gio.DBusProxy, sender: string, signal: string, params: GLib.Variant) => void,
): () => void {
    if (!p) return () => {}
    let disposed = false
    const id = p.connect("g-signal", (_proxy: any, sender: string, signal: string, params: any) => {
        cb(p, sender, signal, params)
    })
    return () => {
        if (disposed) return
        disposed = true
        safeDisconnect(p, id)
    }
}

/**
 * Subscribe to signals on a connection (`signal_subscribe`). Returns an idempotent
 * disposer that calls `signal_unsubscribe`.
 */
export function onConnSignal(
    conn: Gio.DBusConnection,
    opts: SignalOptions,
    cb: (conn: Gio.DBusConnection, sender: string, path: string, iface: string, signal: string, params: GLib.Variant) => void,
): () => void {
    if (!conn) return () => {}
    let disposed = false
    const id = conn.signal_subscribe(
        opts.sender ?? null,
        opts.iface ?? null,
        opts.member ?? null,
        opts.path ?? null,
        opts.arg0 ?? null,
        opts.flags ?? Gio.DBusSignalFlags.NONE,
        (_c: any, sender: string, path: string, iface: string, signal: string, params: any) => {
            cb(conn, sender, path, iface, signal, params)
        },
    )
    return () => {
        if (disposed) return
        disposed = true
        try { conn.signal_unsubscribe(id) } catch {}
    }
}

// BluetoothService — the single source of Bluetooth domain logic.
//
// Like NetworkService, this is a *stateless facade* over the already-reactive
// AstalBluetooth GObject singleton (not its own GObject). It owns the power
// toggle, device categorisation, the connect/pair/remove/discovery vocabulary,
// and notify-subscription helpers. The Settings → Bluetooth page and the bar/CC
// bt tile consume these instead of poking `bt.is_powered` two different ways or
// re-deriving the paired/nearby split. Never imports Gtk; UI stays in the widgets.

import AstalBluetooth from "gi://AstalBluetooth"

/** The AstalBluetooth singleton, or null if unavailable. */
export function bt(): AstalBluetooth.Bluetooth | null {
    return AstalBluetooth.get_default()
}

/** True when an adapter is present (the page shows a no-adapter banner otherwise). */
export function hasAdapter(b: any = bt()): boolean {
    return !!(b && b.adapter)
}

// ── Power ────────────────────────────────────────────────────────────────────

export function isPowered(b: any = bt()): boolean {
    return b?.is_powered ?? false
}

// IMPORTANT: AstalBluetooth.Bluetooth.is_powered is READ-ONLY (it reflects the
// adapter). Writing it throws "not writable" — the toggle then flips visually but
// the radio never actually powers off. Drive the adapter's `powered` instead;
// `is_powered` re-derives from it and still emits notify::is-powered.
export function setPowered(on: boolean): void {
    const a = bt()?.adapter
    if (a) a.powered = on
}

export function togglePower(): void {
    setPowered(!isPowered())
}

// ── Devices ──────────────────────────────────────────────────────────────────

export function devices(b: any = bt()): AstalBluetooth.Device[] {
    return b?.devices ?? []
}

/** Devices with a saved pairing — the "My devices" list (connect/disconnect/forget). */
export function pairedDevices(b: any = bt()): AstalBluetooth.Device[] {
    return devices(b).filter(d => d.paired)
}

/** Discovered-but-unpaired devices — the "Nearby" list (pair). */
export function nearbyDevices(b: any = bt()): AstalBluetooth.Device[] {
    return devices(b).filter(d => !d.paired)
}

export function deviceName(dev: any): string {
    return dev.name || dev.address
}

// ── Device / adapter commands ────────────────────────────────────────────────
// Thin guarded wrappers over the AstalBluetooth methods so callers don't repeat
// the try/catch and the connect_device(null) cancellable boilerplate.

export function connectDevice(dev: any): void {
    try { dev.connect_device(null) } catch (e) { console.error("[BT] connect:", e) }
}

export function disconnectDevice(dev: any): void {
    try { dev.disconnect_device(null) } catch (e) { console.error("[BT] disconnect:", e) }
}

export function pairDevice(dev: any): void {
    try { dev.pair() } catch (e) { console.error("[BT] pair:", e) }
}

export function removeDevice(dev: any): void {
    const b = bt()
    try { b?.adapter?.remove_device(dev) } catch (e) { console.error("[BT] remove:", e) }
}

export function startDiscovery(): void {
    const b = bt()
    try { b?.adapter?.start_discovery() } catch (e) { console.error("[BT] start_discovery:", e) }
}

export function stopDiscovery(): void {
    const b = bt()
    try { b?.adapter?.stop_discovery() } catch (e) { console.error("[BT] stop_discovery:", e) }
}

// ── Reactivity helpers ───────────────────────────────────────────────────────
// Return a disposer; callers wire it to a widget's `unrealize`.

type Dispose = () => void

export function watchPower(cb: () => void): Dispose {
    const b = bt() as any
    if (!b) return () => {}
    const id = b.connect("notify::is-powered", cb)
    return () => { try { b.disconnect(id) } catch {} }
}

// Fires when the device set changes AND when any existing device's pairing /
// connection / name changes. `notify::devices` alone only covers add/remove — it
// does NOT fire when a device's `paired`/`connected` flips, so a freshly-paired
// device would stay in the "nearby" list until the next full rebuild. We therefore
// also wire each device's own notify signals, re-wiring whenever the set changes.
export function watchDevices(cb: () => void): Dispose {
    const b = bt() as any
    if (!b) return () => {}

    let devIds: Array<[any, number]> = []
    const wireDevices = () => {
        devIds.forEach(([d, id]) => { try { d.disconnect(id) } catch {} })
        devIds = []
        for (const d of (b.devices ?? [])) {
            for (const sig of ["notify::paired", "notify::connected", "notify::name"]) {
                try { devIds.push([d, d.connect(sig, cb)]) } catch {}
            }
        }
    }

    const listId = b.connect("notify::devices", () => { wireDevices(); cb() })
    wireDevices()

    return () => {
        try { b.disconnect(listId) } catch {}
        devIds.forEach(([d, id]) => { try { d.disconnect(id) } catch {} })
        devIds = []
    }
}

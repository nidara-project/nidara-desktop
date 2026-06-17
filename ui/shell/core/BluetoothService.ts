// BluetoothService — the single source of Bluetooth domain logic.
//
// Like NetworkService, this is a *stateless facade* over the already-reactive
// AstalBluetooth GObject singleton (not its own GObject). It owns the power
// toggle, device categorisation, the connect/pair/remove/discovery vocabulary,
// and notify-subscription helpers. The Settings → Bluetooth page and the bar/CC
// bt tile consume these instead of poking `bt.is_powered` two different ways or
// re-deriving the paired/nearby split. Never imports Gtk; UI stays in the widgets.

import AstalBluetooth from "gi://AstalBluetooth"
import Gio from "gi://Gio"
import GLib from "gi://GLib"

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
    try {
        // Trust the device once pairing succeeds: without Trusted=true BlueZ asks
        // the agent to authorize every reconnection, which reads as "my headphones
        // ask permission each morning". One-shot watch, armed once per device.
        if (!dev.__csTrustOnPair) {
            dev.__csTrustOnPair = true
            const id = dev.connect("notify::paired", () => {
                if (!dev.paired) return
                try { dev.trusted = true } catch {}
                try { dev.disconnect(id) } catch {}
            })
        }
        dev.pair()
    } catch (e) { console.error("[BT] pair:", e) }
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

// Fires when adapter presence may have changed (bluetoothd start/stop, USB dongle
// hotplug). NOTE: `adapter` is a derived getter (first of `adapters`) and never
// notifies on its own — Astal only emits notify::adapters — so watch that and
// re-read hasAdapter() in the callback.
export function watchAdapter(cb: () => void): Dispose {
    const b = bt() as any
    if (!b) return () => {}
    const id = b.connect("notify::adapters", cb)
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

// ── Pairing agent (org.bluez.Agent1) ─────────────────────────────────────────
// AstalBluetooth has no agent support, so without one BlueZ can only complete
// "just works" pairing: devices that need a passkey confirmation, a PIN, or
// keyboard passkey entry pair blind or fail (tech-debt #13). We export a
// KeyboardDisplay agent on the SYSTEM bus (where BlueZ lives) and forward each
// request to a UI-provided handler. core/ never touches the UI, so this file is
// D-Bus only — the Bluetooth Settings page supplies the dialogs via
// registerPairingAgent() and tears them down on unrealize. While no handler is
// registered the agent is not on the bus at all, preserving the pre-agent
// behavior outside the page.

const AGENT_PATH = "/org/nidara/bluetooth/agent"

const AGENT_IFACE = `<node>
  <interface name="org.bluez.Agent1">
    <method name="Release"/>
    <method name="RequestPinCode">
      <arg type="o" name="device" direction="in"/>
      <arg type="s" name="pincode" direction="out"/>
    </method>
    <method name="DisplayPinCode">
      <arg type="o" name="device" direction="in"/>
      <arg type="s" name="pincode" direction="in"/>
    </method>
    <method name="RequestPasskey">
      <arg type="o" name="device" direction="in"/>
      <arg type="u" name="passkey" direction="out"/>
    </method>
    <method name="DisplayPasskey">
      <arg type="o" name="device" direction="in"/>
      <arg type="u" name="passkey" direction="in"/>
      <arg type="q" name="entered" direction="in"/>
    </method>
    <method name="RequestConfirmation">
      <arg type="o" name="device" direction="in"/>
      <arg type="u" name="passkey" direction="in"/>
    </method>
    <method name="RequestAuthorization">
      <arg type="o" name="device" direction="in"/>
    </method>
    <method name="AuthorizeService">
      <arg type="o" name="device" direction="in"/>
      <arg type="s" name="uuid" direction="in"/>
    </method>
    <method name="Cancel"/>
  </interface>
</node>`

/** One pairing interaction the UI must render. `code` is pre-formatted (6-digit). */
export type PairingPrompt =
    | { kind: "confirm"; deviceName: string; device: any; code: string }
    | { kind: "display"; deviceName: string; device: any; code: string }
    | { kind: "enter-passkey"; deviceName: string; device: any }
    | { kind: "enter-pin"; deviceName: string; device: any }
    | { kind: "authorize"; deviceName: string; device: any }

export interface PairingAgentHandler {
    /** Resolve { ok:false } to reject. For enter-* kinds `value` is the user's input. */
    prompt(p: PairingPrompt): Promise<{ ok: boolean; value?: string }>
    /** BlueZ canceled the in-flight request (timeout, remote abort) — close any open dialog. */
    cancel(): void
}

// `any`: the @girs snapshot doesn't export Gio.DBusConnection from its namespace
let agentConn: any = null
let agentImpl: any = null
let agentHandler: PairingAgentHandler | null = null

/** Resolve a BlueZ device object path (…/dev_AA_BB_CC_DD_EE_FF) to the Astal device. */
function deviceByPath(path: string): any {
    const m = path.match(/dev_((?:[0-9A-Fa-f]{2}_){5}[0-9A-Fa-f]{2})$/)
    const addr = m ? m[1].replace(/_/g, ":").toUpperCase() : ""
    return devices().find(d => (d.address ?? "").toUpperCase() === addr) ?? null
}

function fmtPasskey(pk: number): string {
    return String(pk >>> 0).padStart(6, "0")
}

function promptFor(kind: PairingPrompt["kind"], path: string, code?: string): PairingPrompt {
    const device = deviceByPath(path)
    const name = device ? deviceName(device) : path.split("/").pop() ?? path
    return { kind, device, deviceName: name, code: code ?? "" } as PairingPrompt
}

function makeAgent() {
    const reject = (inv: any, msg: string) => inv.return_dbus_error("org.bluez.Error.Rejected", msg)
    const canceled = (inv: any, msg: string) => inv.return_dbus_error("org.bluez.Error.Canceled", msg)

    // Run the UI prompt and reply to the invocation. BlueZ owns the timeout; if
    // the user never answers, BlueZ calls Cancel() and the dialog closes.
    const ask = (inv: any, p: PairingPrompt, reply: (value?: string) => void) => {
        const h = agentHandler
        if (!h) return reject(inv, "no pairing UI available")
        h.prompt(p).then(
            // The try/catch absorbs "invocation already completed": BlueZ times the
            // request out (and calls Cancel) if the user answers too late.
            r => { try { if (r.ok) reply(r.value); else reject(inv, "user rejected") } catch (e) { console.error("[BT] agent reply:", e) } },
            e => { try { canceled(inv, String(e)) } catch {} },
        )
    }

    // DisplayPasskey re-fires on every keystroke the user types on the remote
    // device (`entered` grows) — show the dialog once per path+code, not per call.
    let lastDisplayKey = ""
    const display = (path: string, code: string) => {
        const h = agentHandler
        if (!h) return
        const key = `${path}:${code}`
        if (key === lastDisplayKey) return
        lastDisplayKey = key
        h.prompt(promptFor("display", path, code))
            .catch(() => {})
            .then(() => { lastDisplayKey = "" })
    }

    return {
        ReleaseAsync(_p: any[], inv: any) { inv.return_value(null) },
        CancelAsync(_p: any[], inv: any) {
            try { agentHandler?.cancel() } catch {}
            inv.return_value(null)
        },
        RequestConfirmationAsync([path, passkey]: [string, number], inv: any) {
            ask(inv, promptFor("confirm", path, fmtPasskey(passkey)), () => inv.return_value(null))
        },
        RequestAuthorizationAsync([path]: [string], inv: any) {
            if (deviceByPath(path)?.trusted) return inv.return_value(null)
            ask(inv, promptFor("authorize", path), () => inv.return_value(null))
        },
        AuthorizeServiceAsync([path, _uuid]: [string, string], inv: any) {
            const dev = deviceByPath(path)
            if (dev?.trusted || dev?.paired) return inv.return_value(null)
            ask(inv, promptFor("authorize", path), () => inv.return_value(null))
        },
        RequestPasskeyAsync([path]: [string], inv: any) {
            ask(inv, promptFor("enter-passkey", path), v => {
                const n = parseInt(v ?? "", 10)
                if (Number.isFinite(n) && n >= 0 && n <= 999999) inv.return_value(new GLib.Variant("(u)", [n]))
                else canceled(inv, "invalid passkey")
            })
        },
        RequestPinCodeAsync([path]: [string], inv: any) {
            ask(inv, promptFor("enter-pin", path), v => {
                if (v && v.length >= 1 && v.length <= 16) inv.return_value(new GLib.Variant("(s)", [v]))
                else canceled(inv, "invalid pin")
            })
        },
        DisplayPasskeyAsync([path, passkey, _entered]: [string, number, number], inv: any) {
            inv.return_value(null) // fire-and-forget: reply first, then show
            display(path, fmtPasskey(passkey))
        },
        DisplayPinCodeAsync([path, pin]: [string, string], inv: any) {
            inv.return_value(null)
            display(path, pin)
        },
    }
}

/** Export the agent and make it the BlueZ default. Idempotent; re-call swaps the handler. */
export function registerPairingAgent(h: PairingAgentHandler): void {
    agentHandler = h
    if (agentImpl) return
    try {
        agentConn = Gio.bus_get_sync(Gio.BusType.SYSTEM, null)
        agentImpl = (Gio as any).DBusExportedObject.wrapJSObject(AGENT_IFACE, makeAgent())
        agentImpl.export(agentConn, AGENT_PATH)
        const call = (method: string, args: GLib.Variant) =>
            agentConn!.call("org.bluez", "/org/bluez", "org.bluez.AgentManager1", method,
                args, null, Gio.DBusCallFlags.NONE, -1, null,
                (c: any, res: any) => {
                    try { c.call_finish(res) } catch (e) { console.error(`[BT] agent ${method}:`, e) }
                })
        call("RegisterAgent", new GLib.Variant("(os)", [AGENT_PATH, "KeyboardDisplay"]))
        call("RequestDefaultAgent", new GLib.Variant("(o)", [AGENT_PATH]))
    } catch (e) {
        console.error("[BT] agent registration failed:", e)
        try { agentImpl?.unexport() } catch {}
        agentImpl = null
        agentConn = null
        agentHandler = null
    }
}

/** Unregister from BlueZ and drop the handler (pre-agent behavior resumes). */
export function unregisterPairingAgent(): void {
    agentHandler = null
    if (!agentConn || !agentImpl) return
    try {
        agentConn.call("org.bluez", "/org/bluez", "org.bluez.AgentManager1", "UnregisterAgent",
            new GLib.Variant("(o)", [AGENT_PATH]), null, Gio.DBusCallFlags.NONE, -1, null,
            (c: any, res: any) => { try { c.call_finish(res) } catch {} })
    } catch {}
    try { agentImpl.unexport() } catch {}
    agentImpl = null
    agentConn = null
}

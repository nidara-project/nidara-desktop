// bluez-probe.ts — exercises core/bluez.ts (the AstalBluetooth replacement)
// against whatever org.bluez is on the SYSTEM bus, in a process of its own.
//
//   ags bundle --gtk 4 scripts/dev/bluez-probe.ts /tmp/bluez-probe
//   /tmp/bluez-probe
//
// Two halves, and the probe says which one it could run:
//
//   - the ROSTER half always runs. With no org.bluez at all (no adapter, or
//     bluetoothd stopped) the contract is still a contract: an empty roster, a
//     false is_powered, a null adapter, and NO exception anywhere. That is the
//     state a laptop with the radio killed boots into, and the state this dev
//     machine is permanently in.
//   - the DEVICE half needs an org.bluez to talk to. Stand one up first:
//
//         sudo scripts/dev/fake-bluetooth.sh start     # python-dbusmock bluez5
//         /tmp/bluez-probe
//         sudo scripts/dev/fake-bluetooth.sh stop
//
//     It creates adapter hci0 plus a paired keyboard, a paired mouse and an
//     unpaired phone — enough to assert the paired/nearby split, the power
//     round-trip, and that a property change reaches a per-device notify.
//
// ⚠️ Prove it can FAIL before believing a green run:
//
//     DBUS_SYSTEM_BUS_ADDRESS=unix:path=/nonexistent /tmp/bluez-probe
//
// takes the system bus away entirely — core/bluez.ts logs "[BlueZ] no system
// bus" and every check below reports FAIL, including the ones that "pass" on a
// machine with no adapter. That distinction is the whole point of the control:
// an empty roster and a broken client look identical from the outside.
import "./gtk-init"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import bluez from "../../ui/shell/core/bluez"
import {
    bt, hasAdapter, isPowered, devices, pairedDevices, nearbyDevices,
    deviceName, watchPower, watchDevices, watchAdapter,
} from "../../ui/shell/core/BluetoothService"

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, detail = "") => {
    if (ok) pass++; else fail++
    print(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`)
}
const sleep = (ms: number) => new Promise<void>(r => { GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.SOURCE_REMOVE }) })

/**
 * Is anything serving org.bluez right now — and is the bus even reachable?
 *
 * The distinction is the whole probe. "No adapter" and "no system bus" both
 * produce an empty roster, so every shape assertion below passes identically in
 * both, and the first version of this file reported nine cheerful PASSes with
 * DBUS_SYSTEM_BUS_ADDRESS pointed at /nonexistent. Reaching the bus is therefore
 * a PRECONDITION that fails hard, not a state the probe tolerates.
 */
function busState(): "no-bus" | "no-bluez" | "up" {
    let conn: any
    try {
        conn = Gio.bus_get_sync(Gio.BusType.SYSTEM, null)
    } catch {
        return "no-bus"
    }
    try {
        const r = conn.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus",
            "org.freedesktop.DBus", "NameHasOwner",
            new GLib.Variant("(s)", ["org.bluez"]), new GLib.VariantType("(b)"),
            Gio.DBusCallFlags.NONE, 2000, null)
        return r.deepUnpack()[0] ? "up" : "no-bluez"
    } catch {
        return "no-bus"
    }
}

async function main() {
    const state = busState()
    print(`bluez-probe — system bus: ${state}`)

    // The precondition. Without it the negative control below is decorative.
    check("the system bus is reachable", state !== "no-bus")
    if (state === "no-bus") {
        print("   Every check past here would pass on an empty roster whether or not")
        print("   this client works, so the probe stops rather than lie.")
        print(`PROBE-RESULT FAIL — ${pass} passed, ${fail} failed`)
        return
    }
    const up = state === "up"

    // ── The roster contract, which holds either way ──────────────────────────
    print("── the roster ──────────────────────────────────────────────────────")
    const b = bt()
    check("the singleton exists (never null, even with no adapter)", !!b)
    check("get_default() is a singleton", bt() === b)
    check("adapters is an array", Array.isArray(b?.adapters), `${b?.adapters?.length} adapter(s)`)
    check("devices is an array", Array.isArray(devices()), `${devices().length} device(s)`)
    check("adapter is the first adapter, or null",
        b?.adapter === (b?.adapters?.[0] ?? null))
    check("hasAdapter agrees with the adapter list", hasAdapter() === !!b?.adapter)
    check("is_powered is a boolean", typeof isPowered() === "boolean", `${isPowered()}`)
    check("paired + nearby partition the device set",
        pairedDevices().length + nearbyDevices().length === devices().length,
        `${pairedDevices().length} paired + ${nearbyDevices().length} nearby`)

    // Subscribing must be safe with nothing there, and must hand back a disposer
    // that does not throw — widgets call it from `unrealize` on every teardown.
    let disposersOk = true
    try {
        for (const w of [watchPower, watchDevices, watchAdapter]) w(() => {})()
    } catch (e) {
        disposersOk = false
        print(`    ${e}`)
    }
    check("watch helpers subscribe and dispose without throwing", disposersOk)

    if (!up) {
        print("── the device half needs an org.bluez ───────────────────────────────")
        print("   SKIPPED. Run `sudo scripts/dev/fake-bluetooth.sh start` and re-run.")
        print(`PROBE-RESULT ${fail === 0 ? "ROSTER-ONLY PASS" : "FAIL"} — ${pass} passed, ${fail} failed`)
        return
    }

    // ── The device half ─────────────────────────────────────────────────────
    print("── devices, power and notifications ────────────────────────────────")
    const all = devices()
    check("the adapter is present", hasAdapter(), b?.adapter?.object_path ?? "none")
    check("devices came through", all.length > 0, all.map(d => deviceName(d)).join(", "))
    check("every device has an object path", all.every((d: any) => !!d.object_path))
    check("deviceName falls back to the address when BlueZ sends no Name",
        all.every((d: any) => deviceName(d) === (d.name || d.address)))
    check("the paired/nearby split is not degenerate",
        pairedDevices().length > 0 && nearbyDevices().length > 0,
        `${pairedDevices().length} paired / ${nearbyDevices().length} nearby`)

    // A property change must reach a per-device notify: that is what makes a
    // freshly-paired device leave the "nearby" list without a full rebuild.
    const target: any = all[0]
    if (!target) {
        print("   No devices, so the notify and power checks cannot run.")
        print(`PROBE-RESULT FAIL — ${pass} passed, ${fail} failed`)
        return
    }
    let notifies = 0
    const nid = target.connect("notify::trusted", () => { notifies++ })
    target.trusted = !target.trusted
    await sleep(600)
    check("a device property change emits exactly one notify", notifies === 1, `${notifies} notify`)
    target.disconnect(nid)

    // Power round-trip through the facade's documented path (adapter.powered).
    const before = isPowered()
    let powerEvents = 0
    const disposePower = watchPower(() => { powerEvents++ })
    const a: any = b!.adapter
    a.powered = !before
    await sleep(800)
    check("toggling the adapter changes is_powered", isPowered() === !before, `${before} → ${isPowered()}`)
    check("watchPower heard it", powerEvents > 0, `${powerEvents} event(s)`)
    a.powered = before
    await sleep(600)
    check("and it goes back", isPowered() === before)
    disposePower()

    print(`PROBE-RESULT ${fail === 0 ? "ALL PASS" : "FAIL"} — ${pass} passed, ${fail} failed`)
}

const loop = GLib.MainLoop.new(null, false)
main()
    .catch((e: any) => { print(`PROBE-RESULT FAIL — probe threw: ${e}`); fail++ })
    .finally(() => loop.quit())
loop.run()

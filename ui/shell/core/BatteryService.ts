// BatteryService — the shell's only door to UPower.
//
// Same stateless-facade pattern as NetworkService / AudioService: a plain
// function module, not a GObject (UPower's client is already a live object).
// It replaced AstalBattery on 2026-08-17. The lib was 643 lines of Vala over a
// D-Bus proxy for the seven values below, while `UPowerGlib-1.0.typelib` ships
// with `upower` — a package Nidara already depends on — and exposes the same
// composite DisplayDevice directly.
//
// TWO things the old wrapper did that you must not lose:
//
//   - **UPower reports percentage 0..100; AstalBattery divided by 100** and its
//     docs called the result a fraction. Every consumer here is written against
//     the FRACTION, so `fraction()` keeps doing that division. Reading
//     `device.percentage` straight would render a 47% battery as a full one.
//   - **`charging` meant CHARGING *or* FULLY_CHARGED.** That conflation is not
//     reproduced: `charging()` here is strictly CHARGING and `charged()` is
//     FULLY_CHARGED. Callers that meant "not draining" ask for both — see the
//     bug note below for why the distinction had to become real.
//
// 🔑 The bug this migration surfaced: `widgets/battery.ts` had been reading
// `bat.charged`, and **AstalBattery has no such property** — it only ever had
// `charging`. So the read was `undefined`, the "Charged" branch was dead code,
// and because Astal's `charging` was true at FULLY_CHARGED, a laptop sitting at
// 100% on AC displayed "Charging" forever. Nothing failed; a property that does
// not exist just reads as undefined.
//
// The DisplayDevice exists even on desktops with no battery — it answers
// `is_present = false`, which is what `present()` is for.

import UPowerGlib from "gi://UPowerGlib"
import GObject from "gi://GObject"

// Module-level so both stay alive: the device stops tracking if its client is
// collected, and a battery that silently stops updating is the exact failure
// mode tech-debt #71 was about.
const client = (() => {
    try { return UPowerGlib.Client.new() } catch (e) {
        console.error("[Battery] UPower client unavailable:", e)
        return null
    }
})()

const device = (() => {
    try { return client?.get_display_device() ?? null } catch (e) {
        console.error("[Battery] no display device:", e)
        return null
    }
})()

const State = UPowerGlib.DeviceState

/** A real battery device is present (false on desktops, where the display
 *  device exists but reports is_present = false). */
export function present(): boolean {
    return !!device && device.is_present
}

/** Charge as a fraction 0..1. UPower's own percentage is 0..100. */
export function fraction(): number {
    if (!present()) return 0
    return Math.max(0, Math.min(1, (device!.percentage ?? 0) / 100))
}

/** Strictly CHARGING — see the header: this is narrower than Astal's. */
export function charging(): boolean {
    return !!device && device.state === State.CHARGING
}

/** Strictly FULLY_CHARGED. */
export function charged(): boolean {
    return !!device && device.state === State.FULLY_CHARGED
}

/** Seconds until full / empty; 0 when UPower has no estimate yet. */
export function timeToFull(): number { return device?.time_to_full ?? 0 }
export function timeToEmpty(): number { return device?.time_to_empty ?? 0 }

type Dispose = () => void

/** Fires on any change to the composite battery. Returns a disposer; callers
 *  wire it to a widget's `unrealize`.
 *
 *  Plain `notify` on purpose: consumers here redraw one small glyph and relabel
 *  one string, so the narrowing that matters for the bar's network watchers
 *  (tech-debt #71) buys nothing, and UPower ticks are minutes apart. */
export function watch(cb: () => void): Dispose {
    return wire("notify", cb)
}

/** Fires only when a battery appears/disappears — what the widget registry's
 *  hardware gate needs, and narrow on purpose: it re-evaluates availability,
 *  which is far more expensive than a glyph redraw. */
export function watchPresence(cb: () => void): Dispose {
    return wire("notify::is-present", cb)
}

function wire(signal: string, cb: () => void): Dispose {
    if (!device) return () => {}
    const id = device.connect(signal, cb)
    // GObject.signal_handler_disconnect, never device.disconnect(): an
    // introspected method of that name would shadow GObject's, which is how
    // NM.Device once had its interface torn down by a cleanup call.
    return () => { try { GObject.signal_handler_disconnect(device, id) } catch { } }
}

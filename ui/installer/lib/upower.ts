// The installer's door to UPower: the composite DisplayDevice, watched.
//
// Kept apart from `lib/power.ts` on purpose — that file holds the rule and must
// load in a probe with no UPowerGlib typelib; this one is the live reader.
//
// ⚠️ The client and the device are module-level for the same reason as in the
// shell's BatteryService: a device whose client is collected stops updating, and
// a warning that silently stops tracking the charger is the failure this exists
// to avoid.

import UPowerGlib from "gi://UPowerGlib"
import type { DisplayDevice } from "./power"

let client: any = null
let device: any = null
let tried = false

function ensureDevice(): any {
  if (tried) return device
  tried = true
  try {
    client = UPowerGlib.Client.new()
    device = client?.get_display_device() ?? null
  } catch (e) {
    // No UPower on this medium: say nothing rather than guess. `nidara-desktop`
    // depends on `upower`, so on a Nidara ISO this is a broken medium, not a
    // desktop — and the only cost is a warning not shown.
    console.warn("[installer] UPower unavailable, no battery warning:", e)
    device = null
  }
  return device
}

/** A snapshot of the DisplayDevice, or null when UPower cannot be reached. */
export function readDisplayDevice(): DisplayDevice | null {
  const d = ensureDevice()
  return d ? { present: !!d.is_present, state: d.state } : null
}

/**
 * Call `cb` whenever the DisplayDevice changes — plugging a charger in or out
 * flips `state` within a second or two. Connected once for the installer's
 * lifetime; the caller keeps whichever label is current.
 */
export function watchDisplayDevice(cb: () => void): void {
  ensureDevice()?.connect("notify", cb)
}

// Is this machine running on battery right now?
//
// An install writes a partition table, then several gigabytes, then a boot
// loader. A laptop that runs out halfway leaves a disk with no working system on
// it — and nothing asked. Calamares' `welcome` module checks `power` and warns
// (EndeavourOS and CachyOS list it among the checks). This is the same question:
// a WARNING, not a refusal, because a charged battery finishes an install and
// only the person knows how charged theirs is.
//
// Read from /sys/class/power_supply, the kernel's own answer, rather than UPower:
// nothing to be running, and every field below is one file.

import GLib from "gi://GLib"

export interface PowerSupply {
  /** `type`: "Battery", "Mains", "USB", "UPS", "Wireless". */
  type: string
  /** `online`: 1 when a charger/mains supply is delivering power. Absent on batteries. */
  online?: number
  /** `status` on a battery: "Discharging", "Charging", "Full", "Not charging", "Unknown". */
  status?: string
  /** `scope`: "System" or "Device". A wireless mouse's battery is "Device". */
  scope?: string
}

/**
 * True when the SYSTEM is running on battery.
 *
 * ⚠️ Device batteries do not count. A Bluetooth mouse or keyboard reports a
 * `Battery` with `scope=Device`, and it is "Discharging" all day — on a desktop
 * with no battery of its own, counting it would warn every single time.
 *
 * - any system supply that powers the machine (Mains/USB/UPS) online → not on battery;
 * - otherwise, a system battery that says Discharging → on battery;
 * - anything else (no battery, Full, Charging, Unknown) → not on battery. A
 *   warning that fires on a machine plugged in teaches people to skip warnings.
 */
export function onBattery(supplies: PowerSupply[]): boolean {
  const system = supplies.filter(s => (s.scope ?? "System") !== "Device")
  if (system.some(s => s.type !== "Battery" && s.online === 1)) return false
  return system.some(s => s.type === "Battery" && s.status === "Discharging")
}

function readTrimmed(path: string): string | undefined {
  try {
    const [ok, bytes] = GLib.file_get_contents(path)
    return ok ? new TextDecoder().decode(bytes).trim() : undefined
  } catch {
    return undefined
  }
}

/** The machine's power supplies as the kernel lists them. Empty if unreadable. */
export function readPowerSupplies(root = "/sys/class/power_supply"): PowerSupply[] {
  const out: PowerSupply[] = []
  try {
    const dir = GLib.Dir.open(root, 0)
    let name: string | null
    while ((name = dir.read_name()) !== null) {
      const base = `${root}/${name}`
      const type = readTrimmed(`${base}/type`)
      if (!type) continue
      const online = readTrimmed(`${base}/online`)
      out.push({
        type,
        online: online === undefined ? undefined : Number(online),
        status: readTrimmed(`${base}/status`),
        scope: readTrimmed(`${base}/scope`),
      })
    }
    dir.close()
  } catch {}
  return out
}

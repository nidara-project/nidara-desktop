// Is this machine running on battery right now?
//
// An install writes a partition table, then several gigabytes, then a boot
// loader. A laptop that runs out halfway leaves a disk with no working system on
// it — and nothing asked. Calamares' `welcome` module checks `power` and warns
// (EndeavourOS and CachyOS list it among the checks). This is the same question:
// a WARNING, not a refusal, because a charged battery finishes an install and
// only the person knows how charged theirs is.
//
// ⚠️ The answer comes from UPower's composite DisplayDevice — the same object the
// bar's battery glyph reads (`ui/shell/core/BatteryService.ts`). It used to come
// from /sys/class/power_supply, and that had two costs: a second rule that could
// disagree with the bar about the same laptop, and a warning nobody could see
// outside real hardware, because a VM has no power supply and sysfs cannot be
// faked. UPower can (`scripts/dev/fake-battery.sh`), so the page is now testable
// the way the bar is. The reader is `lib/upower.ts`; THIS file stays free of
// UPowerGlib so the rule runs in a probe on a machine without the typelib.
//
// What UPower already does that the sysfs rule had to do by hand: the
// DisplayDevice aggregates only batteries that power the SYSTEM, so a wireless
// mouse's battery (`scope=Device`, "Discharging" all day) never reaches it.

/** `UPowerGlib.DeviceState`, spelled out so this file needs no typelib. */
export const DeviceState = {
  UNKNOWN: 0,
  CHARGING: 1,
  DISCHARGING: 2,
  EMPTY: 3,
  FULLY_CHARGED: 4,
  PENDING_CHARGE: 5,
  PENDING_DISCHARGE: 6,
} as const

export interface DisplayDevice {
  /** `is_present`: false on a desktop, where the DisplayDevice still exists. */
  present: boolean
  /** `state`, one of `DeviceState`. */
  state: number
}

/**
 * True when the system is drawing from its battery.
 *
 * - no battery (a desktop) → not on battery;
 * - DISCHARGING, or PENDING_DISCHARGE (unplugged, not yet reported as draining)
 *   → on battery;
 * - anything else — CHARGING, FULLY_CHARGED, PENDING_CHARGE (plugged in and held
 *   by a charge threshold), UNKNOWN → not. A warning that fires on a machine
 *   plugged in teaches people to skip warnings.
 */
export function onBattery(device: DisplayDevice | null): boolean {
  if (!device || !device.present) return false
  return device.state === DeviceState.DISCHARGING || device.state === DeviceState.PENDING_DISCHARGE
}

// power-probe — does the installer think this machine is running on battery?
//
//   ./scripts/bundle.sh --js scripts/dev/power-probe.ts /tmp/power-probe.js && gjs -m /tmp/power-probe.js
//
// No hardware and no UPower: every case is a DisplayDevice snapshot as UPower
// reports it. The rule lives in lib/power.ts; the costly mistake is the warning
// that fires on a machine that is plugged in — above all a desktop, whose
// DisplayDevice exists and says `is_present = false` — because a warning that is
// always there is a warning nobody reads. The live half (lib/upower.ts) is
// checked in a VM against scripts/dev/fake-battery.sh.

import { DeviceState, onBattery } from "../../ui/installer/lib/power"

let failures = 0
function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) print(`   ok           ${name}`)
  else { failures++; print(`   ✗ ${name}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`) }
}

const laptop = (state: number) => ({ present: true, state })

check("laptop unplugged, discharging → warn", onBattery(laptop(DeviceState.DISCHARGING)), true)
check("laptop just unplugged, pending discharge → warn", onBattery(laptop(DeviceState.PENDING_DISCHARGE)), true)
check("laptop plugged in, charging → quiet", onBattery(laptop(DeviceState.CHARGING)), false)
check("laptop plugged in, full → quiet", onBattery(laptop(DeviceState.FULLY_CHARGED)), false)
check("plugged in, held by a charge threshold → quiet", onBattery(laptop(DeviceState.PENDING_CHARGE)), false)
check("unknown state → quiet", onBattery(laptop(DeviceState.UNKNOWN)), false)
// The DisplayDevice exists on a desktop too. A stale or default `state` there
// must not matter: no battery is no battery.
check("desktop: DisplayDevice not present, whatever its state → quiet",
  onBattery({ present: false, state: DeviceState.DISCHARGING }), false)
check("no UPower at all → quiet", onBattery(null), false)

print(failures === 0 ? "\nALL INVARIANTS HOLD" : `\n${failures} FAILURE(S)`)
imports.system.exit(failures === 0 ? 0 : 1)

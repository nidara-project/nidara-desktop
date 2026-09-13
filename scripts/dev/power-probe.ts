// power-probe — does the installer think this machine is running on battery?
//
//   ./scripts/bundle.sh --js scripts/dev/power-probe.ts /tmp/power-probe.js && gjs -m /tmp/power-probe.js
//
// No hardware: every case is the set of /sys/class/power_supply entries a real
// machine exposes. The rule lives in lib/power.ts; the costly mistake is the
// warning that fires on a machine that is plugged in — above all a desktop with
// a wireless mouse, whose battery the kernel lists too — because a warning that
// is always there is a warning nobody reads.

import { onBattery } from "../../ui/installer/lib/power"

let failures = 0
function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) print(`   ok           ${name}`)
  else { failures++; print(`   ✗ ${name}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`) }
}

const AC = (online: number) => ({ type: "Mains", online, scope: undefined })
const BAT = (status: string) => ({ type: "Battery", status, scope: "System" })
const MOUSE = { type: "Battery", status: "Discharging", scope: "Device" }

check("laptop unplugged, discharging → warn", onBattery([AC(0), BAT("Discharging")]), true)
check("laptop plugged in, charging → quiet", onBattery([AC(1), BAT("Charging")]), false)
check("laptop plugged in, full → quiet", onBattery([AC(1), BAT("Full")]), false)
// Some firmware reports Discharging for a moment after the charger goes in; the
// charger being online is the stronger fact.
check("charger online wins over a stale Discharging", onBattery([AC(1), BAT("Discharging")]), false)
check("USB-C power delivery online → quiet", onBattery([{ type: "USB", online: 1 }, BAT("Discharging")]), false)
check("battery with no mains entry at all, discharging → warn", onBattery([BAT("Discharging")]), true)
check("desktop: no supplies at all → quiet", onBattery([]), false)
check("desktop with a wireless mouse → quiet", onBattery([MOUSE]), false)
check("laptop plugged in with a wireless mouse → quiet", onBattery([AC(1), BAT("Full"), MOUSE]), false)
check("unknown status → quiet", onBattery([AC(0), BAT("Unknown")]), false)

print(failures === 0 ? "\nALL INVARIANTS HOLD" : `\n${failures} FAILURE(S)`)
imports.system.exit(failures === 0 ? 0 : 1)

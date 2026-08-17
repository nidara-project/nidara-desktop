#!/usr/bin/gjs
// battery-probe.js — DEV ONLY. Prints UPower's composite DisplayDevice and then
// WATCHES it, so you can see whether a change actually reaches a listener.
//
// This exists because of tech-debt #71: a service that reads its hardware once
// and never again looks perfect in a screenshot. Reading correct values proves
// nothing; the useful column here is the notify log.
//
//   gjs scripts/dev/battery-probe.js [seconds]
//
// Pair it with the mock so there is something to change (another terminal):
//   sudo scripts/dev/fake-battery.sh start 45 charging
//   sudo scripts/dev/fake-battery.sh start 46 charging   # → probe must print a tick
//
// Expect at least one `notify::` line per re-seed. Silence means the shell's
// battery readouts would be frozen from boot, whatever the first read showed.
imports.gi.versions.UPowerGlib = "1.0"
const { UPowerGlib, GLib } = imports.gi

const SECONDS = parseInt(ARGV[0] ?? "20", 10)

const client = UPowerGlib.Client.new()
const device = client.get_display_device()

const STATE = ["UNKNOWN", "CHARGING", "DISCHARGING", "EMPTY", "FULLY_CHARGED",
               "PENDING_CHARGE", "PENDING_DISCHARGE"]

function snapshot() {
    return `present=${device.is_present} percentage=${device.percentage}` +
           ` state=${STATE[device.state] ?? device.state}` +
           ` ttf=${device.time_to_full} tte=${device.time_to_empty}`
}

print(`display device: ${snapshot()}`)
print(`derived: fraction=${Math.max(0, Math.min(1, device.percentage / 100))}` +
      ` charging=${device.state === UPowerGlib.DeviceState.CHARGING}` +
      ` charged=${device.state === UPowerGlib.DeviceState.FULLY_CHARGED}`)
print(`watching for ${SECONDS}s — change the battery (or re-seed the mock) now`)

let ticks = 0
device.connect("notify", (_obj, pspec) => {
    ticks++
    print(`  notify::${pspec ? pspec.name : "?"}  ${snapshot()}`)
})

const loop = GLib.MainLoop.new(null, false)
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SECONDS, () => {
    print(ticks > 0
        ? `PROBE-RESULT LIVE — ${ticks} notify tick(s)`
        : "PROBE-RESULT NO TICKS — nothing reached the listener")
    loop.quit()
    return GLib.SOURCE_REMOVE
})
loop.run()

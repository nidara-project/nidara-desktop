// night-light-sync-probe — core/NightLightSync.ts driven from ANOTHER process (#571).
// Driven by scripts/dev/night-light-sync-probe.sh, which owns the isolation and the fake
// hyprsunset. This process only starts the sync and stays alive; every change comes from
// `gsettings set` in the driver, i.e. from outside, which is the case the sync exists for.
import GLib from "gi://GLib"
import { startNightLightSync } from "../../ui/shell/core/NightLightSync"

startNightLightSync()
print("SYNC started")
new GLib.MainLoop(null, false).run()

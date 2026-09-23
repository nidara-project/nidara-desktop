// appearance-sync-probe — does an appearance change made in ANOTHER process do the
// desktop's side effects exactly once, in the shell? (#571)
// Driven by scripts/dev/appearance-sync-probe.sh, which owns the isolation, the fake
// `hyprctl`/`systemctl` that log which process called them, and the verdict.
//
//   gjs -m probe.js shell      ThemeManager + startAppearanceSync, stays alive
//   gjs -m probe.js settings   ThemeManager ONLY — what the Settings app imports — then
//                              drives the setters and exits
//   gjs -m probe.js settings-with-sync   the same, but ALSO starts the sync: the
//                              mistake the closure check forbids, used as the control
import GLib from "gi://GLib"
import app from "../../ui/lib/nidara-kit/platform/host"
import Theme from "../../ui/shell/core/ThemeManager"
import { startAppearanceSync } from "../../ui/shell/core/AppearanceSync"

const role: string = ((globalThis as any).ARGV ?? [])[0] ?? "shell"
const wait = (ms: number) => new Promise<void>(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.SOURCE_REMOVE }))

app.start({
    applicationId: `org.nidara.AppearanceSyncProbe.${role.replace(/-/g, "_")}`,
    logDomain: "appearance-sync-probe",
    async main() {
        if (role === "shell" || role === "settings-with-sync") startAppearanceSync()
        Theme.connect("cursor-applied", () => print(`CURSOR-APPLIED ${role}`))
        if (role === "shell") {
            print("READY shell")
            return   // host keeps the process alive
        }
        await wait(800)
        const snap = Theme.snapshot()
        print(`BEFORE dark=${snap.isDark} accent=${snap.accent} cursor=${snap.cursorTheme}`)
        await Theme.setDarkMode(!snap.isDark)
        await wait(600)
        await Theme.setAccentColor(snap.accent === "orange" ? "green" : "orange")
        await wait(600)
        await Theme.setCursorTheme(snap.cursorTheme === "Qogir" ? "Adwaita" : "Qogir")
        await wait(600)
        await Theme.setGlassOpacity(0.7)
        await wait(1200)   // the opacity write is debounced 500 ms
        print(`DONE ${role}`)
        app.quit()
    },
})

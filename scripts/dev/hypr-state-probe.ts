// hypr-state-probe.ts — runs core/HyprlandState against the LIVE compositor, in a
// process of its own, so the state layer can be exercised without restarting the
// user's shell (which is their desktop).
//
//   scripts/bundle.sh scripts/dev/hypr-state-probe.ts /tmp/hypr-probe
//   /tmp/hypr-probe [seconds]
//
// Then drive Hyprland from another terminal — switch workspace, focus another
// window, fullscreen something, rename a terminal's title — and watch which
// signal each action produces. What the log has to show:
//
//   - "changed" for structural things (focus, workspace, open/close, geometry,
//     FULLSCREEN — including a maximized window toggling FSMODE without moving),
//   - "title-changed" for a window that merely renames itself, and NOT "changed":
//     a terminal spinner must not repaint the bar and dock,
//   - silence while nothing happens. A refresh storm shows up here as a "changed"
//     stream with an unchanged snapshot beside it (tech-debt #11).
//
// Prove it can fail before believing it: `hyprctl --instance 99 …` or unsetting
// HYPRLAND_INSTANCE_SIGNATURE makes the IPC layer report a connect failure rather
// than quietly showing an empty desktop.
import GLib from "gi://GLib"
import hs from "../../ui/shell/core/HyprlandState"

const SECONDS = parseInt(ARGV[0] ?? "30", 10)

let changed = 0
let titles = 0

const snapshot = () => {
    const c = hs.focusedClient
    return `ws=${hs.focusedWorkspaceId} mon=${hs.focusedMonitor?.name ?? "-"}`
        + ` clients=${hs.clients.length} workspaces=${hs.workspaces.length}`
        + ` focused=${c ? `${c.class}/${c.address.slice(0, 8)} fs=${c.fullscreen} "${c.title.slice(0, 28)}"` : "none"}`
}

print(`initial: ${snapshot()}`)
print(`monitors: ${hs.monitors.map(m => `${m.name} ${m.width}x${m.height}@${m.refreshRate.toFixed(0)} modes=${hs.getAvailableModes(m.name).length}`).join(" | ")}`)
print(`special: ${hs.specialWorkspaces.map(w => w.name).join(",") || "none"}`)
print(`watching ${SECONDS}s — switch workspace, focus a window, fullscreen it, rename a terminal…`)

hs.connect("changed", () => { changed++; print(`  changed        ${snapshot()}`) })
hs.connect("title-changed", (_s: any, addr: string) => {
    titles++
    const c = hs.clients.find(x => x.address === addr)
    print(`  title-changed  ${addr.slice(0, 8)} → "${c?.title ?? "?"}"`)
})

const loop = GLib.MainLoop.new(null, false)
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SECONDS, () => {
    print(`PROBE-RESULT changed=${changed} title-changed=${titles}`)
    print(changed > 0 ? "LIVE — structural events reached a listener"
                      : "NO STRUCTURAL EVENTS — either nothing happened, or the event socket is dead")
    loop.quit()
    return GLib.SOURCE_REMOVE
})
loop.run()

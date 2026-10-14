import GLib from "gi://GLib"
import Gio from "gi://Gio"
import displays from "./Displays"
import { settings, type MonitorSetting } from "./CompositorState"
import { displayLeases } from "./DisplayLease"

function snapshot(name: string): MonitorSetting {
    const mon = displays.monitors.find(m => m.name === name)
    if (!mon) throw Error(`Output unavailable: ${name}`)
    return { scale: mon.scale, transform: mon.transform,
        mode: `${mon.width}x${mon.height}@${mon.refreshRate}` }
}
function save(name: string, cfg: MonitorSetting) {
    // Another output's unconfirmed mode must never reach the persistent file.
    const all = new Map(displays.monitors.map(m => [m.name, leases.before(m.name) ?? snapshot(m.name)]))
    all.set(name, cfg)
    settings.saveMonitors(all, settings.readVrr(0))
}
const journalPath = `${GLib.get_user_runtime_dir()}/nidara-display-previews.json`
const journal = new Map<string, { name: string; before: MonitorSetting }>()
function writeJournal() {
    const bytes = new TextEncoder().encode(JSON.stringify([...journal]))
    Gio.File.new_for_path(journalPath).replace_contents(bytes, null, false,
        Gio.FileCreateFlags.PRIVATE, null)
}
/** Recover an interrupted confirmation when the shell itself is restarted. */
export function recoverSettingsDisplayPreviews(): void {
    if (!GLib.file_test(journalPath, GLib.FileTest.EXISTS)) return
    const [ok, bytes] = GLib.file_get_contents(journalPath)
    if (!ok) return
    const entries = JSON.parse(new TextDecoder().decode(bytes))
    if (!Array.isArray(entries)) throw Error("Invalid display preview journal")
    for (const [token, record] of entries) {
        if (typeof token !== "string" || typeof record?.name !== "string" || !record.before
            || !Number.isFinite(record.before.scale) || !Number.isInteger(record.before.transform)
            || typeof record.before.mode !== "string") throw Error("Invalid display preview journal entry")
        if (displays.monitors.some(m => m.name === record.name)) settings.applyMonitor(record.name, record.before)
    }
    writeJournal()
}
const leases = displayLeases({
    snapshot, apply: (name, cfg) => settings.applyMonitor(name, cfg), save,
    token: () => GLib.uuid_string_random(),
    record: (token, name, before) => { journal.set(token, { name, before }); writeJournal() },
    forget: token => { journal.delete(token); writeJournal() },
    later: revert => {
        let timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 15000, () => {
            timer = 0
            try { revert() } catch (e) { console.error("[SettingsDisplay] Revert:", String(e)) }
            return GLib.SOURCE_REMOVE
        })
        return () => { if (timer) { GLib.source_remove(timer); timer = 0 } }
    },
})
let watching = false
export function settingsMonitorRequest(args: string[], owner: string): string {
    if (!owner) throw Error("Display changes require a D-Bus caller")
    if (!watching) {
        watching = true
        Gio.DBus.session.signal_subscribe("org.freedesktop.DBus", "org.freedesktop.DBus", "NameOwnerChanged",
            "/org/freedesktop/DBus", null, Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _m, params) => {
                const [name, oldOwner, newOwner] = params.deep_unpack() as [string, string, string]
                if (name.startsWith(":") && oldOwner && !newOwner) leases.ownerLost(name)
            })
    }
    const [verb, name, value] = args
    if ((verb === "commit" || verb === "revert") && args.length === 2) {
        if (verb === "commit") leases.commit(name, owner)
        else leases.cancel(name, owner)
        return "ok"
    }
    if (args.length !== 3) throw Error("Invalid display request")
    if (verb === "mode") {
        if (!/^\d+x\d+@[\d.]+$/.test(value)) throw Error("Invalid display mode")
        const mon = displays.monitors.find(m => m.name === name)
        const [size, hz] = value.split("@")
        if (!mon?.availableModes.some(m => m.startsWith(size + "@") && Math.abs(parseFloat(m.split("@")[1]) - Number(hz)) < 0.6))
            throw Error("Display mode is not advertised by this output")
        return leases.preview(owner, name, { mode: value })
    }
    if (!/^-?\d+(?:\.\d+)?$/.test(value)) throw Error("Invalid numeric display value")
    const number = Number(value)
    if (verb === "transform" && Number.isInteger(number) && number >= 0 && number <= 7)
        return leases.preview(owner, name, { transform: number })
    if (verb === "scale" && Number.isFinite(number) && number >= 0.25 && number <= 4) {
        if (leases.pending(name)) throw Error("Confirm or revert the display preview first")
        const cfg = { ...snapshot(name), scale: number }
        settings.applyMonitor(name, cfg); save(name, cfg)
        return "ok"
    }
    if (verb === "vrr" && name === "all" && [0, 1, 2].includes(number)) {
        if (displays.monitors.some(m => leases.pending(m.name))) throw Error("Confirm or revert the display preview first")
        settings.applyVrr(number)
        settings.saveMonitors(new Map(displays.monitors.map(m => [m.name, snapshot(m.name)])), number)
        return "ok"
    }
    throw Error("Invalid display request")
}

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { callConn } from "./dbus"
import { spawn } from "../../lib/process"
import { SHELL_ROOT } from "./Paths"

const BUS = "org.nidara.Settings", PATH = "/org/nidara/Settings"
let opening: Promise<string> | null = null
const pause = () => new Promise<void>(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50,
    () => { resolve(); return GLib.SOURCE_REMOVE }))
async function owner(name = BUS): Promise<string> {
    try {
        const r = await callConn(Gio.DBus.session, "org.freedesktop.DBus", "/org/freedesktop/DBus",
            "org.freedesktop.DBus", "GetNameOwner", new GLib.Variant("(s)", [name]),
            new GLib.VariantType("(s)"), Gio.DBusCallFlags.NO_AUTO_START, 1000)
        return (r.deep_unpack() as [string])[0]
    } catch { return "" }
}
async function ensure(): Promise<string> {
    const live = await owner()
    if (live) return live
    if (!opening) opening = (async () => {
        const sourceLauncher = GLib.canonicalize_filename(`${SHELL_ROOT}/../../bin/nidara-settings`, null)
        const source = GLib.file_test(sourceLauncher, GLib.FileTest.IS_EXECUTABLE)
        const launcher = source ? sourceLauncher : "nidara-settings"
        const launchArgs = source ? ["env", `NIDARA_SETTINGS_REPO=${GLib.canonicalize_filename(`${SHELL_ROOT}/../..`, null)}`, launcher] : [launcher]
        // uwsm places the application outside nidara.service's restart cgroup.
        const managed = await owner("org.freedesktop.systemd1")
        spawn(managed ? ["uwsm", "app", "--", ...launchArgs] : launchArgs)
        for (let i = 0; i < 400; i++) {
            const current = await owner()
            if (current) return current
            await pause()
        }
        // Do not kill a child that may already be displaying an error; report the failure.
        throw Error("Settings did not register its D-Bus name")
    })().finally(() => { opening = null })
    return opening
}
export async function requestSettings(args: string[], start = true): Promise<string | null> {
    const current = start ? await ensure() : await owner()
    if (!current) return null
    // GApplication claims its name just before main exports our interface.
    // Retry only UnknownMethod, where no request has run; never retry a timeout.
    for (let i = 0; i < 200; i++) {
        try {
            const r = await callConn(Gio.DBus.session, current, PATH, BUS, "Request",
                new GLib.Variant("(as)", [args]), new GLib.VariantType("(s)"),
                Gio.DBusCallFlags.NO_AUTO_START, 30000)
            const [text] = r.deep_unpack() as [string]
            if (text.startsWith("error:")) throw Error(text)
            return text
        } catch (e) {
            if (!String(e).includes("UnknownMethod")) throw e
            await pause()
        }
    }
    throw Error("Settings did not export its request interface")
}

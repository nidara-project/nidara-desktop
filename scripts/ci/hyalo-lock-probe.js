// hyalo-lock-probe.js — clients for scripts/ci/hyalo-lock-check.sh.
//   gjs -m hyalo-lock-probe.js victim   a window with an entry: prints `VICTIM <text>` as it is typed
//   gjs -m hyalo-lock-probe.js lock     locks the session (ext-session-lock-v1) with an entry on every
//                                       output: prints LOCKED / FAILED / `TYPED <text>`, and unlocks
//                                       once "ok" has been typed into it (then UNLOCKED, and exits)
//   gjs -m hyalo-lock-probe.js lock-slow  the same, but its lock windows draw only 3 s after the
//                                       request: a lock client slower than Hyalo's hold
//   REQUESTED and LOCKED carry the monotonic clock in ms, so the check can time the gap.
// Needs gtk4-layer-shell preloaded (it carries Gtk4SessionLock): LD_PRELOAD=…/libgtk4-layer-shell.so.

import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import Gtk4SessionLock from "gi://Gtk4SessionLock"

const mode = ARGV[0] === "lock" || ARGV[0] === "lock-slow" ? "lock" : "victim"
const slow = ARGV[0] === "lock-slow"
const ms = () => Math.round(GLib.get_monotonic_time() / 1000)
const say = (s) => { print(s); }
// NON_UNIQUE: several lock clients run at once, and a second instance must be a second
// client, not a message to the first.
const app = new Gtk.Application({ application_id: `org.nidara.lockprobe.${mode}`, flags: Gio.ApplicationFlags.NON_UNIQUE })

app.connect("activate", () => {
    if (mode === "victim") {
        const win = new Gtk.Window({ application: app, title: "lock-victim", default_width: 480, default_height: 200 })
        const entry = new Gtk.Entry()
        entry.connect("changed", () => say(`VICTIM ${entry.get_text()}`))
        win.set_child(entry)
        win.present()
        return
    }
    if (!Gtk4SessionLock.is_supported()) { say("UNSUPPORTED"); app.quit(); return }
    const lock = new Gtk4SessionLock.Instance()
    app.hold()
    lock.connect("locked", () => say(`LOCKED ${ms()}`))
    lock.connect("failed", () => { say("FAILED"); app.release(); app.quit() })
    lock.connect("unlocked", () => { say("UNLOCKED"); GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { app.release(); app.quit(); return GLib.SOURCE_REMOVE }) })
    lock.connect("monitor", (_l, monitor) => {
        const win = new Gtk.Window({ application: app })
        const entry = new Gtk.Entry({ halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, width_chars: 20 })
        entry.connect("changed", () => {
            const text = entry.get_text()
            say(`TYPED ${text}`)
            if (text === "ok") lock.unlock()
        })
        win.set_child(entry)
        const assign = () => { lock.assign_window_to_monitor(win, monitor); entry.grab_focus() }
        if (slow) GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => { assign(); return GLib.SOURCE_REMOVE })
        else assign()
    })
    say(`REQUESTED ${ms()}`)
    lock.lock()
})
app.run([])

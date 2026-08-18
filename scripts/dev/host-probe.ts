// host-probe.ts — exercises `ui/lib/host.ts` (the `ags/gtk4/app` replacement)
// against the live compositor, in a process of its own.
//
//   scripts/bundle.sh scripts/dev/host-probe.ts /tmp/host-probe --alias:@host=./ui/lib/host
//   /tmp/host-probe
//
// (The wrapper sets LD_PRELOAD itself — see scripts/bundle.sh.)
//
// The host is the one piece of AGS that was not scaffolding, and almost
// everything it does is invisible when it stops happening: an app-id nobody
// reads back, an environment variable that only hurts the CHILD processes, a
// `hold()` whose absence looks like a clean exit. So each check here is one of
// those silent facts, stated out loud.
//
// ⚠️ Prove it can FAIL before believing a green run.
//
// ⚰️ The FIRST control is RETIRED, and that is worth stating rather than leaving
//     a command that no longer runs. It was the same probe source bundled with
//     `--alias @host=ags/gtk4/app`, i.e. against AGS's own host, and it went RED
//     on the app-id, the Wayland class, libadwaita being initialised behind our
//     back and the process name, while staying GREEN on LD_PRELOAD, `hold()` and
//     CSS — the behaviours we had to KEEP. It cannot be run any more: AGS is not
//     installed (its bundler left on 2026-08-18, the last of it), so `ags/gtk4`
//     resolves to nothing. Its evidence is in PR #194; do not re-derive it.
//
// The control that still works, and still has to be run:
//
//   env -u LD_PRELOAD gjs -m "$XDG_RUNTIME_DIR"/host-probe-<hash>.js
//     Disarms the LD_PRELOAD check: the probe reads its own /proc/self/environ,
//     sees the variable was never set at exec, and SKIPS rather than scoring a
//     check that cannot distinguish "the host unset it" from "nobody ever set
//     it" (measured: 13 passed, 2 skipped). ⚠️ Dropping the `LD_PRELOAD=…` prefix
//     from the command line does NOT disarm it — the bundler emits a shell
//     wrapper that sets the variable itself before calling gjs, which is why the
//     control has to go at the decoded JS the wrapper writes (its path is printed
//     inside the wrapper; `scripts/run.sh` writes the same JS under a predictable
//     name). A control that cannot fail is worse than no control; this one could
//     not, until it was run.

import GLib from "gi://GLib"
import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import app from "@host"
import { setWindowAppId } from "../../ui/lib/app-id"

const APP_ID = "org.nidara.hostprobe"
const APP_NAME = "Nidara Host Probe"
const WIN_TITLE = "nidara-host-probe"

let pass = 0
let fail = 0

function check(ok: boolean, label: string, detail = ""): boolean {
    if (ok) { pass++; print(`  PASS  ${label}${detail ? "  — " + detail : ""}`) }
    else { fail++; print(`  FAIL  ${label}${detail ? "  — " + detail : ""}`) }
    return ok
}

function section(title: string): void {
    print(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`)
}

function sh(cmd: string[]): string {
    try {
        const [, out] = GLib.spawn_sync(null, cmd, null, GLib.SpawnFlags.SEARCH_PATH, null)
        return new TextDecoder().decode(out ?? new Uint8Array()).trim()
    } catch (e) {
        print(`  (spawn failed: ${cmd.join(" ")} — ${e})`)
        return ""
    }
}

/** The environment this process was EXEC'd with — unaffected by later
 *  setenv/unsetenv, which is exactly what makes it usable as the "before". */
function execEnv(name: string): string | null {
    try {
        const [ok, bytes] = GLib.file_get_contents("/proc/self/environ")
        if (!ok) return null
        for (const entry of new TextDecoder().decode(bytes).split("\0")) {
            const eq = entry.indexOf("=")
            if (eq > 0 && entry.slice(0, eq) === name) return entry.slice(eq + 1)
        }
    } catch { /* fall through */ }
    return null
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { resolve(); return GLib.SOURCE_REMOVE })
    })
}

// ── Facts that must be true BEFORE anything of ours runs ─────────────────────
//
// Import declarations are evaluated before the first statement of this file, so
// whatever the host does at module scope has already happened here. That is the
// whole point of it living at module scope, and it is what these two read.

const gtkReadyAtImport = Gtk.is_initialized()
const preloadAtImport = GLib.getenv("LD_PRELOAD")

// Filled in below, before anything else paints: proof that `start({ css })` is in
// force by the time `main()` gets control.
let startCssLanded = false
let startCssColor = { red: 0, green: 0, blue: 0 }

async function run(): Promise<void> {
    section("Preconditions")

    const display = Gdk.Display.get_default()
    if (!display) {
        print("  PRECONDITION FAILED: no Gdk.Display — run this inside a graphical session")
        app.quit(2)
        return
    }
    print(`  display: ${display.get_name()}`)

    const hyprSig = GLib.getenv("HYPRLAND_INSTANCE_SIGNATURE")
    if (!hyprSig) {
        print("  PRECONDITION FAILED: not inside a Hyprland session — the app-id check needs a compositor to ask")
        app.quit(2)
        return
    }

    {
        const w = new Gtk.Window({ application: app, title: WIN_TITLE + "-startcss" })
        const l = new Gtk.Label({ css_classes: ["host-probe-startcss"] })
        w.set_child(l); w.present()
        await sleep(150)
        startCssColor = l.get_color()
        startCssLanded = Math.round(startCssColor.blue * 255) === 255
            && Math.round(startCssColor.red * 255) === 0
        w.close()
    }

    section("GTK is initialised by the IMPORT, not by us")
    check(gtkReadyAtImport, "Gtk.is_initialized() was already true when this file's first statement ran",
        "a widget built during another module's import would work")

    section("LD_PRELOAD does not survive into children")
    const preloadAtExec = execEnv("LD_PRELOAD")
    if (!preloadAtExec) {
        print("  SKIPPED (control not armed): this process was not started with LD_PRELOAD set,")
        print("           so 'it is gone now' would prove nothing. Re-run as:")
        print("           LD_PRELOAD=/usr/lib/libgtk4-layer-shell.so " + (GLib.get_prgname() ?? "host-probe"))
    } else {
        check(preloadAtImport === null, "unset in our own environment by the time the import returned",
            `was ${preloadAtExec} at exec`)
        const childSaw = sh(["sh", "-c", "printf %s \"$LD_PRELOAD\""])
        check(childSaw === "", "a child process inherits no LD_PRELOAD",
            childSaw === "" ? "" : `child saw ${childSaw}`)
    }

    section("Identity: the app-id we asked for is the app-id we got")
    check(app.applicationId === APP_ID, "GApplication:application-id is ours",
        `got ${app.applicationId}`)
    check(GLib.get_prgname() === APP_ID, "g_get_prgname() is ours",
        `got ${GLib.get_prgname()}`)
    check(GLib.get_application_name() === APP_NAME, "g_get_application_name() is ours",
        `got ${GLib.get_application_name()}`)

    // The one that actually matters: what the COMPOSITOR ends up filing the
    // window under. Everything above is a string in our own process; this is the
    // string the dock, the window rules and `nidara-a11y` match on.
    const win = new Gtk.Window({ application: app, title: WIN_TITLE, default_width: 120, default_height: 80 })
    win.present()
    await sleep(600)
    const clients = JSON.parse(sh(["hyprctl", "clients", "-j"]) || "[]") as any[]
    const mine = clients.filter(c => c.title === WIN_TITLE)
    check(mine.length === 1, "the window reached Hyprland", `${mine.length} client(s) with our title`)
    check(mine[0]?.class === APP_ID, "Hyprland files it under our app-id",
        `class = ${mine[0]?.class}`)
    win.close()

    section("Per-window app-id overrides the process-wide one")
    // The lever that retires the seventh commandment: the shell's own regular
    // windows (Settings, About) name themselves instead of inheriting an id that
    // then has to be remapped. Set BEFORE the window is ever mapped — the point
    // is that the compositor never sees the process id for this surface.
    const owned = new Gtk.Window({ application: app, title: WIN_TITLE + "-owned", default_width: 100, default_height: 60 })
    setWindowAppId(owned, "nidara-settings")
    owned.present()
    await sleep(600)
    const ownedClients = (JSON.parse(sh(["hyprctl", "clients", "-j"]) || "[]") as any[])
        .filter(c => c.title === WIN_TITLE + "-owned")
    check(ownedClients[0]?.class === "nidara-settings", "the window's own app-id wins over the process id",
        `class = ${ownedClients[0]?.class}`)
    check(app.applicationId === APP_ID, "and the process id is untouched by it",
        `application-id = ${app.applicationId}`)
    owned.close()

    section("libadwaita is not initialised behind our back")
    let adwInitialised: boolean | null = null
    try {
        const Adw = (await import("gi://Adw?version=1")).default as any
        adwInitialised = Adw.is_initialized()
    } catch {
        adwInitialised = null   // not installed at all — nothing could have initialised it
    }
    check(adwInitialised !== true, "Adw.is_initialized() is not true",
        adwInitialised === null ? "libadwaita not present on this system" : `is_initialized() = ${adwInitialised}`)

    section("CSS")
    // `start({ css })` is the greeter's and the lockscreen's ONLY path into the
    // host beyond `main` — they hand it their stylesheet and layer an accent
    // override on top with `apply_css` afterwards. Neither can be run here (one
    // grabs the keyboard, the other locks the session), so the ordering they
    // depend on is asserted from this side: the sheet passed to `start` is in
    // place before `main` runs, and a later `apply_css` at the same priority WINS.
    check(startCssLanded, "the stylesheet passed to start() was applied before main()",
        `label was rgb(${Math.round(startCssColor.red * 255)},${Math.round(startCssColor.green * 255)},${Math.round(startCssColor.blue * 255)})`)
    // A colour is the cheapest property to read back off a live widget, and it
    // proves the provider reached the display rather than just being constructed.
    const probeLabel = new Gtk.Label({ css_classes: ["host-probe-target"] })
    const holder = new Gtk.Window({ application: app, title: WIN_TITLE + "-css" })
    holder.set_child(probeLabel)
    holder.present()
    await sleep(150)
    const before = probeLabel.get_color()
    app.apply_css("label.host-probe-target { color: rgb(0, 255, 0); }")
    await sleep(150)
    const after = probeLabel.get_color()
    check(Math.round(after.green * 255) === 255 && Math.round(after.red * 255) === 0,
        "apply_css reaches a realised widget",
        `rgb(${Math.round(after.red * 255)},${Math.round(after.green * 255)},${Math.round(after.blue * 255)}) — was rgb(${Math.round(before.red * 255)},${Math.round(before.green * 255)},${Math.round(before.blue * 255)})`)

    app.reset_css()
    await sleep(150)
    const afterReset = probeLabel.get_color()
    check(Math.round(afterReset.green * 255) !== 255 || Math.round(afterReset.red * 255) !== 0,
        "reset_css takes it away again",
        `rgb(${Math.round(afterReset.red * 255)},${Math.round(afterReset.green * 255)},${Math.round(afterReset.blue * 255)})`)
    holder.close()

    section("hold(): no window is not a reason to exit")
    // Both windows are gone. A GApplication that is not held quits its main loop
    // when its last window closes — the shell would die the moment a surface was
    // destroyed, and the app grid and the agent pointer are never mapped at all.
    await sleep(400)
    check(true, "still running with zero windows open",
        `use count held by the host`)

    print(`\n${fail === 0 ? "ALL GREEN" : "RED"} — ${pass} passed, ${fail} failed`)
    // The exit code IS the last check: `quit(code)` has to actually leave.
    app.quit(fail === 0 ? 0 : 1)
}

app.start({
    applicationId: APP_ID,
    css: "label.host-probe-startcss { color: rgb(0, 0, 255); }",
    applicationName: APP_NAME,
    // AGS's host ignores `applicationId` and derives the id from this instead —
    // which is precisely what the control run is there to show.
    instanceName: "hostprobe",
    main() { run().catch(e => { print(`  THREW: ${e}\n${e?.stack ?? ""}`); app.quit(3) }) },
} as any)

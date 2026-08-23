// layer-order-probe — how does a layer surface get BACK on top of a sibling on the
// same level, and does anything we can call from GTK actually reorder it?
//
//   scripts/bundle.sh --js scripts/dev/layer-order-probe.ts /tmp/layer-order-probe.js
//   env LD_PRELOAD="$(pkg-config --variable=libdir gtk4-layer-shell-0)/libgtk4-layer-shell.so" \
//     gjs -m /tmp/layer-order-probe.js
//
// ⚠️ The pkg-config module is `gtk4-layer-shell-0`, WITH the -0 (this is what
// `scripts/run.sh` uses). Ask for `gtk4-layer-shell` and you get an empty libdir, an
// LD_PRELOAD of "/libgtk4-layer-shell.so" that ld.so ignores with one line, and then a
// run where every layer call warns "GtkWindow is not a layer surface" and the probe
// still prints a report. That report is about ordinary toplevels, not layer surfaces.
//
// Why this exists. In the bar's game overlay (Super+B under a fullscreen window) the
// bar joins the OVERLAY level, where the Activity Island already lives, and Hyprland
// ends up stacking the BAR ON TOP. Both surfaces are the whole monitor, and the bar
// unconditionally claims `{0,0,width,40}` of input — the exact strip the island's
// capsule is painted in — so every click meant for the capsule is eaten by the bar.
// `IslandWindow.raise()` exists to prevent that and calls `set_layer(OVERLAY)` on a
// window ALREADY on OVERLAY, which measured as a no-op on the live session.
//
// So: what actually moves a surface to the end of its level's list? This puts two
// tiny surfaces up, both on OVERLAY, and asks the compositor after each candidate:
//
//   1. baseline          — is the LAST one mapped on top? (the assumption everything rests on)
//   2. set_layer(same)   — the no-op suspected of being one
//   3. bounce TOP→OVERLAY across separate commits
//   4. unmap + remap     — the heaviest, and the only one whose semantics are obvious
//
// ⚠️ It puts two 40x40 surfaces in the top-left corner for a few seconds. It does not
// touch the shell, take a grab, or ask for keyboard focus.
import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"
import Gtk4LayerShell from "gi://Gtk4LayerShell"

const NS_A = "nidara-probe-a"
const NS_B = "nidara-probe-b"

/** Order of our two probes inside their level, straight from the compositor.
 *  Later in the array = higher. Returns null if either is not up. */
const orderNow = (): { level: string, aIdx: number, bIdx: number } | null => {
    const [ok, out] = GLib.spawn_command_line_sync("hyprctl layers -j")
    if (!ok || !out) return null
    let byMonitor: any
    try { byMonitor = JSON.parse(new TextDecoder().decode(out)) } catch (_) { return null }
    for (const mon of Object.values<any>(byMonitor)) {
        for (const [levelName, arr] of Object.entries<any>(mon?.levels ?? {})) {
            const list = arr as any[]
            const aIdx = list.findIndex((l) => l?.namespace === NS_A)
            const bIdx = list.findIndex((l) => l?.namespace === NS_B)
            if (aIdx >= 0 && bIdx >= 0) return { level: levelName, aIdx, bIdx }
        }
    }
    return null
}

const mkWin = (ns: string) => {
    const win = new Gtk.Window({ name: ns, decorated: false, default_width: 40, default_height: 40 })
    Gtk4LayerShell.init_for_window(win)
    Gtk4LayerShell.set_namespace(win, ns)
    Gtk4LayerShell.set_layer(win, Gtk4LayerShell.Layer.OVERLAY)
    Gtk4LayerShell.set_keyboard_mode(win, Gtk4LayerShell.KeyboardMode.NONE)
    Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.TOP, true)
    Gtk4LayerShell.set_anchor(win, Gtk4LayerShell.Edge.LEFT, true)
    win.set_child(new Gtk.Label({ label: ns.slice(-1).toUpperCase() }))
    return win
}

const app = new Gtk.Application({ application_id: "org.nidara.LayerOrderProbe" })
const lines: string[] = []
const say = (s = "") => { lines.push(s); print(s) }

app.connect("activate", () => {
    const a = mkWin(NS_A), b = mkWin(NS_B)
    app.add_window(a); app.add_window(b)

    // Steps run one per timeout so each candidate gets its own commit(s). 200 ms is
    // not tuning: it only has to outlast one frame at any refresh rate we support.
    const STEP = 200
    let step = 0
    const report = (label: string) => {
        const o = orderNow()
        if (!o) { say(`  ${label.padEnd(34)} — could not read both surfaces from hyprctl`); return }
        const winner = o.aIdx > o.bIdx ? "A" : "B"
        say(`  ${label.padEnd(34)} level=${o.level}  A@${o.aIdx} B@${o.bIdx}  → ${winner} on top`)
    }

    const steps: Array<() => void> = [
        () => { a.present() },
        () => { b.present() },                                   // B mapped LAST
        () => { report("1. baseline (B mapped last)") },
        () => { Gtk4LayerShell.set_layer(a, Gtk4LayerShell.Layer.OVERLAY) },   // same value
        () => { report("2. A: set_layer(OVERLAY) again") },
        () => { Gtk4LayerShell.set_layer(a, Gtk4LayerShell.Layer.TOP) },
        () => { Gtk4LayerShell.set_layer(a, Gtk4LayerShell.Layer.OVERLAY) },  // separate commit
        () => { report("3. A: bounce TOP → OVERLAY") },
        // ⚠️ Put B back on top FIRST. Without this, step 4 runs with A already on top
        // from step 3 and "A on top" afterwards proves nothing — it is the reading a
        // candidate that does NOTHING would also produce.
        () => { b.set_visible(false) },
        () => { b.present() },
        () => { report("   (control: B remapped, B on top again)") },
        () => { a.set_visible(false) },
        () => { a.present() },
        () => { report("4. A: unmap + remap") },
        () => {
            say()
            say("Read it as: whichever candidate first flips the winner from B to A is the one")
            say("that reorders. A candidate that leaves B on top did nothing.")
            GLib.file_set_contents("/tmp/layer-order-probe.txt", lines.join("\n"))
            a.destroy(); b.destroy(); app.quit()
        },
    ]

    say("layer-order-probe — what actually re-stacks a layer surface on its own level?")
    say("")
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, STEP, () => {
        steps[step++]()
        return step < steps.length ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE
    })
})

app.run([])

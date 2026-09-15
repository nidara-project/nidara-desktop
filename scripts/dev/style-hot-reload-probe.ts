// style-hot-reload-probe — does ThemeManager's dev hot reload of style.css survive a GC?
//   NIDARA_SHELL_ROOT=<dir with a style.css> gjs -m probe.js
// Builds ThemeManager, forces a full GC (what a real session does sooner or later), then
// rewrites style.css and waits for ThemeManager's "Style Hot-Reload" log line.
// ThemeManager logs "Style Hot-Reload" when it reloads; the driver greps for it before DONE:
//   … 2>&1 | grep -E "Style Hot-Reload|DONE"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import system from "system"
import Theme from "../../ui/shell/core/ThemeManager"

const root = GLib.getenv("NIDARA_SHELL_ROOT")!
void Theme
const loop = new GLib.MainLoop(null, false)
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
    if (!GLib.getenv("NO_GC")) system.gc()
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
        // WRITE=inplace truncates and writes the same inode (what sass does); the default is
        // GLib's atomic replace (temp file + rename). Both must reload exactly once.
        if (GLib.getenv("WRITE") === "inplace") {
            const f = Gio.File.new_for_path(`${root}/style.css`)
            const out = f.replace(null, false, Gio.FileCreateFlags.NONE, null)
            out.write_all(new TextEncoder().encode(`/* touched ${Date.now()} */\n`), null)
            out.close(null)
        } else GLib.file_set_contents(`${root}/style.css`, `/* touched ${Date.now()} */\n`)
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            print("DONE")
            loop.quit()
            return GLib.SOURCE_REMOVE
        })
        return GLib.SOURCE_REMOVE
    })
    return GLib.SOURCE_REMOVE
})
loop.run()

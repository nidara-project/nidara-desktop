// The greeter's copy of the clock format — written once, by the shell (#571).
//
// The greeter runs as a system user with no access to a 700 home and no session bus, so
// it cannot read org.nidara.region; it reads this mirror in /var/tmp instead (same pattern
// as the appearance mirror in core/AppearanceSync.ts). An export, never read back.
//
// ⚠️ SHELL ONLY — started from app.ts. It used to be written by RegionConfig's constructor
// and subscriber, i.e. by every process that built the store.

import GLib from "gi://GLib"
import { writeFile } from "../../lib/file"
import regionConfig from "./RegionConfig"
import { GREETER_MIRROR_DIR } from "./Paths"

let started = false

function writeMirror(): void {
    try {
        if (!GLib.file_test(GREETER_MIRROR_DIR, GLib.FileTest.EXISTS))
            GLib.mkdir_with_parents(GREETER_MIRROR_DIR, 0o755)
        const json = JSON.stringify({
            timeFormat: regionConfig.timeFormat,
            dateFormat: regionConfig.dateFormat,
            showSeconds: regionConfig.showSeconds,
        }, null, 2)
        // 0644: the greeter (another user) reads it. See writeFile's mode note.
        writeFile(`${GREETER_MIRROR_DIR}/region.json`, json, 0o644)
    } catch (e) {
        console.warn("[RegionSync] could not write shared region:", e)
    }
}

/** Idempotent: a second call does nothing. */
export function startRegionSync(): void {
    if (started) return
    started = true
    regionConfig.connect("changed", writeMirror)
    writeMirror()
}

/**
 * TrashService — watches the trash and exposes whether it holds items.
 *
 * Primary path: gvfs `trash:///`, which aggregates EVERY trash location
 * (home + per-volume .Trash-1000) and supports both monitoring and the
 * `trash::item-count` attribute. gvfs ships with nautilus, which is part
 * of the Crystal stack, so this is the normal path.
 *
 * Fallback (no gvfs): a plain FileMonitor on ~/.local/share/Trash/files
 * with a child-count enumeration — home trash only.
 *
 * Consumers subscribe for changes (dock trash icon full/empty).
 */
import Gio from "gi://Gio"
import GLib from "gi://GLib"

const TRASH_ATTR = "trash::item-count"

class TrashService {
    itemCount = 0
    get isEmpty() { return this.itemCount === 0 }

    private listeners = new Set<() => void>()
    private monitors: Gio.FileMonitor[] = []
    private debounceId: number | null = null
    private useGvfs = false

    constructor() {
        try {
            const trash = Gio.File.new_for_uri("trash:///")
            const monitor = trash.monitor_directory(Gio.FileMonitorFlags.NONE, null)
            monitor.connect("changed", () => this.scheduleRefresh())
            this.monitors.push(monitor)
            this.useGvfs = true
        } catch (e) {
            console.warn("[TrashService] gvfs trash:/// unavailable, falling back to local dir:", e)
            this.watchLocalDir()
        }
        this.refresh()
    }

    subscribe(fn: () => void) {
        this.listeners.add(fn)
        return () => this.listeners.delete(fn)
    }

    private emit() { this.listeners.forEach(fn => { try { fn() } catch (e) { console.error(e) } }) }

    private scheduleRefresh() {
        if (this.debounceId !== null) GLib.source_remove(this.debounceId)
        this.debounceId = GLib.timeout_add(GLib.PRIORITY_LOW, 300, () => {
            this.debounceId = null
            this.refresh()
            return GLib.SOURCE_REMOVE
        })
    }

    private setCount(n: number) {
        if (n === this.itemCount) return
        this.itemCount = n
        this.emit()
    }

    private refresh() {
        if (this.useGvfs) {
            const trash = Gio.File.new_for_uri("trash:///")
            trash.query_info_async(TRASH_ATTR, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, null,
                (src: any, res: any) => {
                    try {
                        const info = src.query_info_finish(res)
                        this.setCount(info.get_attribute_uint32(TRASH_ATTR))
                    } catch (e) {
                        // gvfs answered the monitor but not the query — degrade to local
                        this.useGvfs = false
                        this.watchLocalDir()
                        this.refresh()
                    }
                })
        } else {
            this.setCount(this.countLocal())
        }
    }

    // ── Local fallback (~/.local/share/Trash) ────────────────────────────────

    private localFilesDir() { return `${GLib.get_user_data_dir()}/Trash/files` }

    private watchLocalDir() {
        // Monitor the deepest existing dir on the Trash/files path; re-evaluate on
        // every event so the monitor upgrades once Trash/ or files/ gets created.
        const candidates = [this.localFilesDir(), `${GLib.get_user_data_dir()}/Trash`, GLib.get_user_data_dir()]
        const target = candidates.find(p => GLib.file_test(p, GLib.FileTest.IS_DIR))
        if (!target) return
        try {
            const monitor = Gio.File.new_for_path(target).monitor_directory(Gio.FileMonitorFlags.NONE, null)
            monitor.connect("changed", () => {
                // If we were watching an ancestor and files/ now exists, move the monitor down
                if (target !== this.localFilesDir() && GLib.file_test(this.localFilesDir(), GLib.FileTest.IS_DIR)) {
                    this.monitors.forEach(m => { try { m.cancel() } catch (e) {} })
                    this.monitors = []
                    this.watchLocalDir()
                }
                this.scheduleRefresh()
            })
            this.monitors.push(monitor)
        } catch (e) {
            console.warn("[TrashService] cannot monitor local trash dir:", e)
        }
    }

    private countLocal(): number {
        try {
            const dir = Gio.File.new_for_path(this.localFilesDir())
            const en = dir.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
            let n = 0
            while (en.next_file(null) !== null) n++
            en.close(null)
            return n
        } catch (e) {
            return 0 // dir missing = empty trash
        }
    }
}

export const trashService = new TrashService()
export default trashService

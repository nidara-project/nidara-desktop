import Gio from "gi://Gio"
import GObject from "gi://GObject"
import GLib from "gi://GLib"
import { Gtk, Gdk } from "ags/gtk4"
import { readFile } from "ags/file"

export interface AppData {
    id: string
    name: string
    exec: string
    icon: string | null
    wmClass: string | null
}

class AppService {
    private cache = new Map<string, AppData>()
    private nameMap = new Map<string, string>()
    private listeners = new Set<() => void>()

    constructor() {
        this.reload()

        // Deep Sync: Secondary scan for boot resilience
        GLib.timeout_add(GLib.PRIORITY_LOW, 5000, () => {
            this.reload()
            return GLib.SOURCE_REMOVE
        })

        // Theme Awareness: Refresh when the system theme changes
        const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default())
        theme.connect("changed", () => {
            console.log("[AppService] System theme changed, refreshing registry...")
            this.reload()
        })
    }

    connect(callback: () => void) {
        this.listeners.add(callback)
        return () => this.listeners.delete(callback)
    }

    private emit() {
        this.listeners.forEach(cb => cb())
    }

    private getCanonicalName(n: string): string | null {
        if (!n || n === "void") return null
        if (n.startsWith("/") || n.startsWith("file://")) return n

        const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default())
        const check = (name: string) => theme.has_icon(name) ? name : null

        return check(n) || check(n.replace("-symbolic", "")) || check(n.toLowerCase()) || null
    }

    reload() {
        console.log("[AppService] Synchronizing Registry...")
        const start = Date.now()
        this.cache.clear()
        this.nameMap.clear()

        const apps = Gio.AppInfo.get_all()

        apps.forEach(app => {
            const id = app.get_id()?.replace(".desktop", "")
            if (!id) return

            const icon = app.get_icon()
            let canonical: string | null = null

            if (icon instanceof Gio.ThemedIcon) {
                canonical = this.getCanonicalName(icon.get_names()[0])
            } else if (icon instanceof Gio.FileIcon) {
                canonical = icon.get_file().get_path()
            }

            let wmClass: string | null = null
            const desktopPath = (app as any).get_filename?.()
            if (desktopPath) {
                try {
                    const content = readFile(desktopPath)
                    const wmMatch = content.match(/^StartupWMClass=(.*)$/m)
                    if (wmMatch) wmClass = wmMatch[1].trim().toLowerCase()
                } catch (e) { }
            }

            const data: AppData = {
                id: id.toLowerCase(),
                name: app.get_name(),
                exec: app.get_executable()?.split(" ").pop()?.split("/").pop()?.replace(/["']/g, "").toLowerCase() || "",
                icon: canonical,
                wmClass: wmClass
            }

            this.cache.set(data.id, data)
            if (data.wmClass) this.nameMap.set(data.wmClass, canonical!)
            if (data.exec) this.nameMap.set(data.exec, canonical!)
            if (canonical) this.nameMap.set(data.id, canonical)
        })

        this.applyOverrides()
        console.log(`[AppService] Registry synced. ${this.cache.size} apps, ${this.nameMap.size} names cached in ${Date.now() - start}ms.`)
        this.emit()
    }

    private applyOverrides() {
        const overrides: Record<string, string> = {
            "nautilus": "org.gnome.Nautilus",
            "terminal": "org.gnome.Terminal",
            "utilities-terminal": "org.gnome.Terminal",
            "gnome-terminal-server": "org.gnome.Terminal",
            "kitty": "terminal",
            "google-chrome": "google-chrome",
            "chrome": "google-chrome",
            // Antigravity & File Manager Standardization
            "antigravity": "antigravity",
            "Antigravity": "antigravity",
            "code-url-handler": "antigravity", // VSCode URL handler fallback
            "/usr/share/pixmaps/antigravity.png": "antigravity" // Force unification
        }

        Object.entries(overrides).forEach(([key, iconName]) => {
            // Special Case: If key matches the hardcoded path, map directly to the name without canonical lookup
            if (key.startsWith("/")) {
                this.nameMap.set(key, iconName)
                return
            }

            const name = this.getCanonicalName(iconName) || iconName
            if (name) this.nameMap.set(key.toLowerCase(), name)
        })
    }

    getIconName(key: string): string | null {
        if (!key || key === "void") return null
        const k = key.toLowerCase().replace(".desktop", "")
        const hit = this.nameMap.get(k) || this.getCanonicalName(key)

        if (hit) console.log(`[AppService] [Hit] ${key} -> ${hit}`)
        else console.warn(`[AppService] [Miss] ${key}`)

        return hit
    }

    getAppData(id: string): AppData | null {
        return this.cache.get(id.toLowerCase()) || null
    }
}

export const appService = new AppService()
export default appService

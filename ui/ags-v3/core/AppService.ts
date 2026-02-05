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

        // Global Theme Discovery
        const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default())

        // V94.1: ENSURE SYSTEM ICONS WIN (FALLBACKS ONLY)
        const localIcons = GLib.get_home_dir() + "/.local/share/icons"
        const systemIcons = "/usr/share/icons"
        const projectIcons = "/home/angel/Dev/MiDistroIA/assets/icons/material"

        // STANDARD PATHS FIRST
        theme.add_search_path(localIcons)
        theme.add_search_path(systemIcons)

        // CUSTOM POOLS LAST (Fallback only)
        theme.add_search_path(localIcons + "/DistroIA/scalable/apps")
        theme.add_search_path(projectIcons)

        theme.connect("changed", () => {
            console.log(`[AppService] System theme changed to ${theme.get_theme_name()}, refreshing registry...`)
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

        // Exclusion patterns for known duplicates and config tools
        const excludePatterns = [
            /^im-config/,
            /^software-properties/,
            /^gnome-language-selector/,
            /^language-selector/,
            /^update-/,
            /^system-config-/
        ]

        apps.forEach(app => {
            const id = app.get_id()?.replace(".desktop", "")
            if (!id) return

            // Filter: Exclude known duplicates/config tools
            if (excludePatterns.some(p => p.test(id))) return

            // Filter: Must have a valid name
            const appName = app.get_name()
            if (!appName || appName.trim() === "") return

            // Filter: Check NoDisplay flag
            const desktopPath = (app as any).get_filename?.()
            if (desktopPath) {
                try {
                    const content = readFile(desktopPath)

                    // Skip if NoDisplay=true
                    if (/^NoDisplay=true$/m.test(content)) return

                    // Skip if OnlyShowIn doesn't include current DE (future enhancement)

                } catch (e) { /* Ignore read errors */ }
            }

            const icon = app.get_icon()
            let canonical: string | null = null

            if (icon instanceof Gio.ThemedIcon) {
                const names = icon.get_names()
                for (const name of names) {
                    canonical = this.getCanonicalName(name)
                    if (canonical) break
                }
            } else if (icon instanceof Gio.FileIcon) {
                canonical = icon.get_file().get_path()
            }

            // Fallback: Category-based icons
            if (!canonical && desktopPath) {
                try {
                    const content = readFile(desktopPath)
                    const categories = content.match(/^Categories=(.*)$/m)?.[1] || ""

                    // Specific known apps without proper icons
                    if (id.includes("kitty")) canonical = this.getCanonicalName("utilities-terminal")
                    else if (id.includes("system") && id.includes("info")) canonical = this.getCanonicalName("hwinfo") || this.getCanonicalName("utilities-system-monitor")
                    // Category-based fallbacks
                    else if (categories.includes("Development")) canonical = this.getCanonicalName("applications-development")
                    else if (categories.includes("Graphics")) canonical = this.getCanonicalName("applications-graphics")
                    else if (categories.includes("Game")) canonical = this.getCanonicalName("applications-games")
                    else if (categories.includes("Network")) canonical = this.getCanonicalName("applications-internet")
                    else if (categories.includes("Audio") || categories.includes("Video")) canonical = this.getCanonicalName("applications-multimedia")
                    else if (categories.includes("Office")) canonical = this.getCanonicalName("applications-office")
                    else if (categories.includes("Settings")) canonical = this.getCanonicalName("preferences-system")
                    else if (categories.includes("System")) canonical = this.getCanonicalName("applications-system")
                } catch (e) { /* Ignore */ }
            }

            // Final fallback
            if (!canonical) canonical = this.getCanonicalName("application-x-executable")

            let wmClass: string | null = null
            if (desktopPath) {
                try {
                    const content = readFile(desktopPath)
                    const wmMatch = content.match(/^StartupWMClass=(.*)$/m)
                    if (wmMatch) wmClass = wmMatch[1].trim().toLowerCase()
                } catch (e) { }
            }

            const data: AppData = {
                id: id, // V94.2: PRESERVE ORIGINAL CASE (Critical for gtk-launch)
                name: app.get_name(),
                exec: app.get_executable()?.split(" ").pop()?.split("/").pop()?.replace(/["']/g, "").toLowerCase() || "",
                icon: canonical,
                wmClass: wmClass
            }

            this.cache.set(id.toLowerCase(), data)
            if (data.wmClass) {
                this.nameMap.set(data.wmClass, canonical!)
            } else if (data.exec) {
                // Only map generic executable names if NO wmClass is specified.
                // This prevents PWAs (which have specific wmClass) from hijacking the generic binary name (e.g. google-chrome).
                this.nameMap.set(data.exec, canonical!)
            }

            if (canonical) this.nameMap.set(id.toLowerCase(), canonical)
        })

        this.applyOverrides()
        console.log(`[AppService] Registry synced. ${this.cache.size} apps, ${this.nameMap.size} names cached in ${Date.now() - start}ms.`)
        this.emit()
    }

    private applyOverrides() {
        // V74: Static overrides removed. Configuration should be done via .desktop files.
    }

    getIconName(key: string): string | null {
        if (!key || key === "void") return null
        const k = key.toLowerCase().replace(".desktop", "")
        let hit = this.nameMap.get(k) || this.getCanonicalName(key)

        // Fallbacks for known missing icons
        if (!hit) {
            if (k.includes("kitty")) hit = this.getCanonicalName("utilities-terminal")
            if (k.includes("terminal") && !hit) hit = this.getCanonicalName("utilities-terminal")
        }

        // V77: HEURISTIC PRESERVATION
        // If the query itself looked like a path ("/" or "file://") and we found no system theme override,
        // we should trust the input as a path.
        if (!hit && (key.startsWith("/") || key.startsWith("file://"))) {
            return key
        }

        if (hit) { /* Hit */ }
        else console.warn(`[AppService] [Miss] ${key}`)

        return hit
    }

    getAppData(id: string): AppData | null {
        return this.cache.get(id.toLowerCase()) || null
    }
}

export const appService = new AppService()
export default appService

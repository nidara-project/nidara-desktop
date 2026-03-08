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

// V136: GENERIC ICONS TO AVOID
const BAD_ICONS = [
    "image-missing",
    "text-x-generic",
    "audio-x-generic",
    "video-x-generic",
    "application-x-executable",
    "preferences-system-details-symbolic",
    "preferences-system-symbolic",
    "preferences-system", // V136: Generic system icon (often used as fallback for Kitty)
    "system-help",
    "utilities-terminal",
    "dialog-information-symbolic",
    "application-default-icon",
    "unknown"
]

class AppService {
    private cache = new Map<string, AppData>()
    private gAppCache = new Map<string, any>()
    private nameMap = new Map<string, string>()
    private wmMap = new Map<string, string>() // Map wmClass -> Desktop ID
    private listeners = new Set<() => void>()
    private isReloading = false // V138: Lock to avoid concurrent reloads during boot 🛡️

    constructor() {
        // Global Theme Discovery
        const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default())

        // V94.1: ENSURE SYSTEM ICONS WIN (FALLBACKS ONLY)
        const localIcons = GLib.get_home_dir() + "/.local/share/icons"
        const systemIcons = "/usr/share/icons"
        const localShareIcons = "/usr/local/share/icons" // V126: Support for locally installed app icons (e.g. Rofi)
        const pixmaps = "/usr/share/pixmaps" // V126: Legacy standard fallback
        const flatpakIcons = "/var/lib/flatpak/exports/share/icons"
        const snapIcons = "/var/lib/snapd/desktop/icons"

        // STANDARD PATHS FIRST (Including Flatpak & Snap)
        theme.add_search_path(localIcons)
        theme.add_search_path(localShareIcons)
        theme.add_search_path(pixmaps)
        theme.add_search_path(systemIcons)
        theme.add_search_path(flatpakIcons)
        theme.add_search_path(snapIcons)

        this.reload()

        // Deep Sync: Secondary scan for boot resilience
        GLib.timeout_add(GLib.PRIORITY_LOW, 5000, () => {
            this.reload()
            return GLib.SOURCE_REMOVE
        })

        theme.connect("changed", () => {
            const name = theme.get_theme_name()
            // Debounce theme changes to prevent GListStore conflicts during start-up
            GLib.timeout_add(GLib.PRIORITY_LOW, 1000, () => {
                console.log(`[AppService] System theme changed to ${name}, refreshing registry...`)
                this.reload()
                return GLib.SOURCE_REMOVE
            })
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

        // V127: NATIVE GTK RESOLUTION 💎
        const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default())
        if (theme.has_icon(n)) {
            // V136: Verify it resolves to a GOOD icon
            // If Gtk maps 'kitty' -> 'preferences-system', we must reject it!
            const paintable = theme.lookup_icon(n, null, 48, 1, Gtk.TextDirection.LTR, 0)
            const path = paintable?.get_file()?.get_path()

            if (path && !BAD_ICONS.some(bad => path.includes(bad))) {
                return n // It's a specific, good icon. Use it.
            }
            // If path is missing or generic, fall through to Brute Force ☢️
        }

        // V129: DEEP BRUTE FORCE FALLBACK (The "Nuclear Option") ☢️
        // If Gtk can't find it, we look for it ourselves in every possible folder.
        let themeName = theme.get_theme_name()

        // V130: Force Read from GSettings if Gtk is stuck on standard/Adwaita
        if (themeName === "Adwaita" || themeName === "hicolor") {
            try {
                const settings = new Gio.Settings({ schema_id: "org.gnome.desktop.interface" })
                const configuredTheme = settings.get_string("icon-theme")
                if (configuredTheme) {
                    // console.log(`[AppService] Gtk reports '${themeName}', but GSettings says '${configuredTheme}'. Using GSettings.`)
                    themeName = configuredTheme
                }
            } catch (e) {
                console.error("[AppService] Failed to read GSettings icon-theme:", e)
            }
        }

        const visited = new Set<string>()

        // Prioritized list of bases
        const bases = [
            `/usr/share/icons/${themeName}`,
            `/usr/local/share/icons/${themeName}`,
            `${GLib.get_home_dir()}/.local/share/icons/${themeName}`,
            `/usr/share/icons/hicolor`,
            `/usr/local/share/icons/hicolor`,
            `${GLib.get_home_dir()}/.local/share/icons/hicolor`,
            `/usr/share/pixmaps`
        ]

        // Prioritized list of subdirs (Quality first)
        const subdirs = [
            "apps",
            "scalable/apps",
            "48x48/apps",
            "32x32/apps",
            "64x64/apps",
            "128x128/apps",
            "256x256/apps",
            "512x512/apps",
            "symbolic/apps",
            "24x24/apps",
            "22x22/apps",
            "16x16/apps",
            "" // For pixmaps flat structure
        ]

        const exts = [".svg", ".png", ".xpm", ""]

        for (const base of bases) {
            for (const sub of subdirs) {
                for (const ext of exts) {
                    // Try exact name
                    let path = `${base}/${sub}/${n}${ext}`.replace("//", "/")
                    if (!visited.has(path) && GLib.file_test(path, GLib.FileTest.EXISTS)) return path
                    visited.add(path)

                    // Try symbolic variant if not already present
                    if (!n.endsWith("-symbolic")) {
                        path = `${base}/${sub}/${n}-symbolic${ext}`.replace("//", "/")
                        if (!visited.has(path) && GLib.file_test(path, GLib.FileTest.EXISTS)) return path
                        visited.add(path)
                    }
                }
            }
        }

        return null
    }

    reload() {
        if (this.isReloading) return // V138: Prevention of concurrent GListStore churn
        this.isReloading = true

        console.log("[AppService] Synchronizing Registry...")
        const start = Date.now()
        this.cache.clear()
        this.nameMap.clear()
        this.wmMap.clear() // V138: Ensure full wipe

        // V133: FLUSH GTK ICON CACHE
        // Force a fresh theme context lookup to ensure we aren't using stale paths
        const display = Gdk.Display.get_default()
        if (display) {
            const theme = Gtk.IconTheme.get_for_display(display)
            // No direct clear_cache(), but re-fetching might help internal ref counting
        }

        const apps = Gio.AppInfo.get_all()

        apps.forEach(app => {
            const id = app.get_id()?.replace(".desktop", "")
            if (!id) return

            const icon = app.get_icon()
            let canonical: string | null = null

            if (icon instanceof Gio.ThemedIcon) {
                // Return the first valid name in the theme
                const names = icon.get_names()
                canonical = this.getIconName(names)
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
                id: id, // V94.2: PRESERVE ORIGINAL CASE (Critical for gtk-launch)
                name: app.get_name(),
                // V147: ROBUST BINARY RESOLUTION 💎
                // We take the FIRST part of the executable string (the binary), then the filename.
                exec: app.get_executable()?.split(" ")[0].split("/").pop()?.replace(/["']/g, "").toLowerCase() || "",
                icon: canonical,
                wmClass: wmClass
            }

            this.cache.set(id.toLowerCase(), data)
            this.gAppCache.set(id.toLowerCase(), app as any)

            if (data.wmClass) {
                this.nameMap.set(data.wmClass, canonical!)
                this.wmMap.set(data.wmClass, id.toLowerCase())
            } else if (data.exec) {
                this.nameMap.set(data.exec, canonical!)
            }

            if (canonical) this.nameMap.set(id.toLowerCase(), canonical)
        })

        this.applyOverrides()
        console.log(`[AppService] Registry synced. ${this.cache.size} apps, ${this.nameMap.size} names cached in ${Date.now() - start}ms.`)
        this.isReloading = false
        this.emit()
    }

    private applyOverrides() {
        // V74: Static overrides removed. Configuration should be done via .desktop files.
    }

    /**
     * V127: UNIVERSAL RESOLVER 🚀
     * Resolves an icon name or array of names to the best match in the current theme.
     */
    getIconName(key: string | string[]): string | null {
        if (!key) return null

        // Handle array of fallbacks
        if (Array.isArray(key)) {
            for (const k of key) {
                const res = this.getIconName(k)
                if (res) return res
            }
            return null
        }

        if (key === "void") return null
        const k = key.toLowerCase().replace(".desktop", "")
        let hit = this.nameMap.get(k) || this.getCanonicalName(key)

        // V132: GENERIC ROBUSTNESS 🛡️
        // If the theme returns a generic/fallback icon, force a brute-force search for the original name.
        if (hit && BAD_ICONS.some(bad => hit!.includes(bad))) {
            // console.log(`[AppService] Detected generic icon for '${key}': ${hit}. Forcing brute force lookup.`)
            const deep = this.getCanonicalName(k)
            if (deep && !BAD_ICONS.some(bad => deep.includes(bad))) {
                hit = deep
            }
        }

        return hit
    }

    getAppData(id: string): AppData | null {
        return this.cache.get(id.toLowerCase()) || null
    }

    /**
     * V94.10: UNIVERSAL RESOLVER 🚀
     * Finds the real DesktopAppInfo using any identifier (ID, WM_CLASS, or Variant)
     */
    getAppInfo(lid: string): any | null {
        if (!lid) return null

        // V149: ROBUST BASENAME RESOLUTION 💎
        // We ensure that if we get a full path, we extract the ID (e.g. org.gnome.Nautilus)
        const q = lid.toLowerCase()
            .split("/").pop()! // Get filename
            .replace(".desktop", "") // Remove extension

        // 1. Exact ID match (case-insensitive)
        let info = this.gAppCache.get(q)
        if (info) return info

        // 2. WM_CLASS match
        const idFromWm = this.wmMap.get(q)
        if (idFromWm) return this.gAppCache.get(idFromWm) || null

        // 3. Reverse search for fuzzy matches and substring IDs
        for (const [id, data] of this.cache.entries()) {
            // V94.12: HEURISTIC MATCHING 💎
            // Handle cases like "org.telegram" -> "org.telegram.desktop"
            if (id.includes(q) || q.includes(id)) {
                return this.gAppCache.get(id) || null
            }

            // Handle metadata matches
            if (data.wmClass === q || data.exec === q || data.name.toLowerCase() === q) {
                return this.gAppCache.get(id) || null
            }
        }

        return null
    }

    /**
     * V149: UNIVERSAL FILE MANAGER RESOLUTION 🛰️
     * Returns the sanitized command for the system's default file manager.
     */
    getDefaultFileManagerCommand(): string {
        try {
            const app = Gio.AppInfo.get_default_for_type("inode/directory", false)
            if (app) {
                const cmd = app.get_commandline()
                if (cmd) return cmd.replace(/\s*["']?%[a-zA-Z]["']?/g, "").trim()
            }
        } catch (e) {
            console.error("[AppService] Failed to get default file manager:", e)
        }
        return "xdg-open ." // Absolute fallback (Terminal-safe)
    }
}

export const appService = new AppService()
export default appService

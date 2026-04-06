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
    private isReloading = false // Lock to avoid concurrent reloads during boot

    constructor() {
        // Global Theme Discovery
        const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default())

        // Search paths ordered so system icons take priority over pixmaps
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

        let lastTheme = theme.get_theme_name()
        theme.connect("changed", () => {
            const name = theme.get_theme_name()
            if (name === lastTheme) return // skip if name unchanged to avoid redundant reloads
            lastTheme = name

            // Debounce theme changes to prevent GListStore conflicts during start-up
            GLib.timeout_add(GLib.PRIORITY_LOW, 2000, () => {
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

        const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default())

        // Crystal Shell icon overlay — checked before system theme
        const overlayBase = `${GLib.get_home_dir()}/.local/share/icons/crystal-shell`
        const extensions = [".svg", ".png", ""]
        for (const ext of extensions) {
            const path = `${overlayBase}/scalable/apps/${n}${ext}`.replace("//", "/")
            if (GLib.file_test(path, GLib.FileTest.EXISTS)) return path
            // Try flat fallback
            const flat = `${overlayBase}/${n}${ext}`.replace("//", "/")
            if (GLib.file_test(flat, GLib.FileTest.EXISTS)) return flat
        }

        // Native GTK theme resolution
        if (theme.has_icon(n)) {
            const paintable = theme.lookup_icon(n, null, 48, 1, Gtk.TextDirection.LTR, 0)
            const path = paintable?.get_file()?.get_path()

            // Skip pixmaps — prefer themed icons
            const isPixmap = path && path.includes("/usr/share/pixmaps")
            if (path && !isPixmap && !BAD_ICONS.some(bad => path.includes(bad))) {
                return n
            }
        }

        // Deep filesystem fallback — searches icon theme directories directly
        let themeName = theme.get_theme_name()
        if (themeName === "Adwaita" || themeName === "hicolor") {
            try {
                const settings = new Gio.Settings({ schema_id: "org.gnome.desktop.interface" })
                const configuredTheme = settings.get_string("icon-theme")
                if (configuredTheme) themeName = configuredTheme
            } catch (e) { }
        }

        const visited = new Set<string>()
        const bases = [
            `${GLib.get_home_dir()}/.local/share/icons/${themeName}`,
            `/usr/share/icons/${themeName}`,
            `/usr/share/icons/hicolor`,
            `/usr/share/pixmaps`
        ]

        const subdirs = ["scalable/apps", "apps", "48x48/apps", "32x32/apps", ""]

        for (const base of bases) {
            for (const sub of subdirs) {
                for (const ext of extensions) {
                    const path = `${base}/${sub}/${n}${ext}`.replace("//", "/")
                    if (!visited.has(path) && GLib.file_test(path, GLib.FileTest.EXISTS)) return path
                    visited.add(path)
                }
            }
        }

        return null
    }

    reload() {
        if (this.isReloading) return // prevent concurrent reload
        this.isReloading = true

        console.log("[AppService] Synchronizing Registry...")
        const start = Date.now()
        this.cache.clear()
        this.nameMap.clear()
        this.wmMap.clear()

        // Refresh GTK icon theme context
        // Force a fresh theme context lookup to ensure we aren't using stale paths
        const display = Gdk.Display.get_default()
        if (display) {
            const theme = Gtk.IconTheme.get_for_display(display)
            // No direct clear_cache(), but re-fetching might help internal ref counting
        }

        const apps = Gio.AppInfo.get_all()
        const visitedIds = new Set<string>()

        apps.forEach(app => {
            // Canonical ID from GIO, fallback to desktop filename
            const rawId = app.get_id() || (app as any).get_filename?.()?.split("/").pop() || ""
            const id = rawId.replace(".desktop", "")
            if (!id || visitedIds.has(id.toLowerCase())) return
            visitedIds.add(id.toLowerCase())

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
                // Extract the binary name from the executable string
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
        // Static overrides removed — configure via .desktop files instead
    }

    /**
     * Normalizes a Hyprland window class to a desktop app ID.
     * Returns null for windows that should be ignored (e.g. the shell itself).
     */
    resolveHyprlandClass(rawClass: string): string | null {
        if (!rawClass) return null
        const rawClassLower = rawClass.toLowerCase()

        // "io.Astal.ags" is our shell's only regular window (Settings Adw.Window).
        // Layer shell windows never appear in hypr.clients, but just in case:
        if (rawClassLower.includes("ags") && rawClass !== "io.Astal.ags") return null

        let key = rawClassLower
        if (key === "com.crystalshell.fluid" || key === "gjs" || key === "io.astal.ags") {
            key = "crystal-shell-settings"
        }

        // File Manager Integration -> Map any detected file manager window to our Home/Finder shortcut
        if (["org.gnome.nautilus", "nautilus", "thunar", "dolphin", "pcmanfm", "nemo", "nemo-desktop"].includes(key)) {
            key = "home-shortcut"
        }

        return key
    }

    /**
     * Resolves an icon name or GIcon to an absolute path or valid theme icon name.
     */
    getIconName(key: any): string | null {
        if (!key) return null

        // Safe handling for non-string GIcon inputs
        if (typeof key !== "string" && !Array.isArray(key)) {
            try {
                if (key instanceof Gio.ThemedIcon) {
                    return this.getIconName(key.get_names())
                }
                if (key instanceof Gio.FileIcon) {
                    return key.get_file().get_path()
                }
                // Fallback for generic GIcon
                if (key.to_string) return this.getIconName(key.to_string())
            } catch (e) {
                console.error("[AppService] GIcon resolution failed:", e)
            }
        }

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

        // Deprioritize pixmaps — prefer themed icons
        const isPixmap = hit && hit.includes("/usr/share/pixmaps")
        const isGeneric = hit && BAD_ICONS.some(f => hit!.includes(f))

        if (isPixmap || isGeneric) {
            const deep = this.getCanonicalName(k)
            if (deep && !deep.includes("/usr/share/pixmaps") && !BAD_ICONS.some(f => deep.includes(f))) {
                hit = deep
            }
        }

        if (hit && hit.includes("crystal-shell")) {
            console.log(`[AppService] Resolved '${key}' -> overlay icon: ${hit}`)
        }

        if (hit) this.nameMap.set(k, hit)
        return hit
    }

    getAppData(id: string): AppData | null {
        return this.cache.get(id.toLowerCase()) || null
    }

    /**
     * Finds the DesktopAppInfo for any identifier: desktop ID, WM_CLASS, or variant.
     */
    getAppInfo(lid: string): any | null {
        if (!lid) return null

        // Normalize to basename without .desktop extension
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

        // 3. Search for best match in cache
        let fallbackMatch = null
        for (const [id, data] of this.cache.entries()) {
                // Handle prefixed IDs like "org.telegram" -> "org.telegram.desktop"
            const match = id === q || id.startsWith(q + ".") || id.startsWith(q + "-")
            if (match) return this.gAppCache.get(id) || null

            // Metadata matches (WM_CLASS, etc.)
            if (data.wmClass === q || data.exec === q || data.name.toLowerCase() === q) {
                return this.gAppCache.get(id) || null
            }

            // Substring fallback (only if nothing better found)
            if (id.includes(q) && !fallbackMatch) {
                fallbackMatch = this.gAppCache.get(id) || null
            }
        }

        return fallbackMatch
    }

    /**
     * Returns the launch command for the system's default file manager.
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

    /**
     * Resolves a full app record from any identifier.
     * Combines getAppInfo, getAppData, and browser-specific ID normalization.
     */
    getResolvedApp(lid: string | null | undefined) {
        if (!lid) return null
        
        const id = lid.toLowerCase().replace(".desktop", "").trim()
        const info = this.getAppInfo(id)
        const data = this.getAppData(id)

        if (!info && !data) return null

        // 1. Determine the Best Icon (The "Dock Logic")
        let iconName: any = data?.icon || info?.get_icon() || "application-x-executable"
        
        // CHROME ID HACK (Synced with Dock)
        if (typeof iconName === "string" && id.startsWith("chrome-") && id.endsWith("-default")) {
            iconName = iconName.replace(/-default$/i, "-Default")
        }

        return {
            id: data?.id || info?.get_id()?.replace(".desktop", "") || id,
            name: data?.name || info?.get_name() || id,
            icon_name: iconName,
            get_id: () => data?.id || info?.get_id() || id,
            get_name: () => data?.name || info?.get_name() || id,
            get_icon: () => info?.get_icon(),
            launch: () => {
                const launchId = data?.id || info?.get_id() || id
                const freshInfo = this.getAppInfo(launchId)
                let command = freshInfo?.get_commandline() || data?.exec || launchId
                // Absolute Isolation Sanitization
                command = command.replace(/\s*["']?%[a-zA-Z]["']?/g, "").trim()
                GLib.spawn_command_line_async(`hyprctl dispatch exec ${command}`)
            }
        }
    }

    /**
     * Searches apps by name or ID. Used by Prism (spotlight search).
     */
    search(query: string): AppData[] {
        if (!query) return []
        const q = query.toLowerCase()
        const results: AppData[] = []

        for (const app of this.cache.values()) {
            if (app.name.toLowerCase().includes(q) || (app.id && app.id.toLowerCase().includes(q))) {
                results.push(app)
            }
        }

        return results.sort((a, b) => {
            const aName = a.name.toLowerCase()
            const bName = b.name.toLowerCase()
            if (aName.startsWith(q) && !bName.startsWith(q)) return -1
            if (!aName.startsWith(q) && bName.startsWith(q)) return 1
            return aName.localeCompare(bName)
        }).slice(0, 8)
    }
}

export const appService = new AppService()
export default appService

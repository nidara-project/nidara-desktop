import GLib from "gi://GLib"

// Wallpaper resolution shared by the shell, greeter and lockscreen bundles.
//
// The user's wallpaper state lives in ~/.config/nidara/wallpaper (JSON),
// written by the shell's WallpaperManager. Today there is one global
// wallpaper; the schema reserves an optional `surfaces` block so Settings can
// later assign independent wallpapers per surface without a migration:
//
//   {
//     "path": "/home/user/Pictures/foo.jpg",   // global (desktop) wallpaper
//     "transition": "fade",                     // awww transition (shell-only)
//     "surfaces": {                             // optional per-surface overrides
//       "lockscreen": { "path": "…" },
//       "greeter":    { "path": "…" }
//     }
//   }
//
// Resolution order for a surface: its override → global path → system
// default. Every step is existence-checked, so a dangling path (deleted
// image, unmounted drive) falls through to the next instead of going blank.
//
// Note the split of painters: the shell and the greeter paint the wallpaper
// with awww in the compositor (see hyprland.lua / hyprland-greeter.lua, both
// with their own fallback to DEFAULT_WALLPAPER), while the lockscreen must
// paint its own copy — the session-lock protocol covers every other surface,
// so awww's output is never visible behind it.
//
// SERIALIZATION CONSTRAINT for whoever implements `surfaces`: hyprland.lua's
// readWallpaperCfg() (gaming hero-art restore) pattern-matches the FIRST
// `"path"` key in the raw file, so the top-level `path` must stay serialized
// BEFORE any `surfaces` block. WallpaperManager._save()'s merge-write
// (`{...existing, path, transition}`) preserves that order today.

export type WallpaperSurface = "shell" | "greeter" | "lockscreen"

export const DEFAULT_WALLPAPER = "/usr/share/nidara/wallpaper.jpg"
export const DEFAULT_GREETER_WALLPAPER = "/usr/share/nidara/wallpaper-greeter.jpg"
export const SYSTEM_WALLPAPERS_DIR = "/usr/share/nidara/wallpapers"

export interface WallpaperConfig {
  path?: string
  transition?: string
  surfaces?: Partial<Record<WallpaperSurface, { path?: string }>>
}

// `homeDir` is for callers running as a DIFFERENT user than the one whose
// wallpaper they want (the greeter runs as the `greeter` system user). In-
// session callers (shell, lockscreen) omit it and get their own config dir.
export function readWallpaperConfig(homeDir?: string): WallpaperConfig {
  const file = homeDir
    ? `${homeDir}/.config/nidara/wallpaper`
    : `${GLib.get_user_config_dir()}/nidara/wallpaper`
  try {
    const [ok, data] = GLib.file_get_contents(file)
    if (!ok) return {}
    return JSON.parse(new TextDecoder().decode(data as Uint8Array)) as WallpaperConfig
  } catch {
    return {}
  }
}

function usable(path: string | undefined | null): path is string {
  return !!path && GLib.file_test(path, GLib.FileTest.EXISTS)
}

/** Absolute path of the image a surface should paint, or null if nothing
 *  usable exists on disk (not even the system default). */
export function resolveWallpaper(surface: WallpaperSurface, homeDir?: string): string | null {
  const cfg = readWallpaperConfig(homeDir)
  const override = cfg.surfaces?.[surface]?.path
  if (usable(override)) return override
  if (surface === "greeter" && usable(DEFAULT_GREETER_WALLPAPER)) return DEFAULT_GREETER_WALLPAPER
  if (usable(cfg.path)) return cfg.path
  if (usable(DEFAULT_WALLPAPER)) return DEFAULT_WALLPAPER
  return null
}

/**
 * Returns a list of all bundled/system wallpaper paths available offline.
 */
export function getBundledWallpapers(): string[] {
  const dirs: string[] = []

  // In dev mode, check repo's defaults/wallpaper first
  const devMarker = `${GLib.get_home_dir()}/.config/nidara/.dev`
  try {
    const [devOk, devBytes] = GLib.file_get_contents(devMarker)
    if (devOk) {
      const repoDir = new TextDecoder().decode(devBytes).trim()
      dirs.push(`${repoDir}/defaults/wallpaper`)
    }
  } catch {}

  dirs.push(SYSTEM_WALLPAPERS_DIR)

  const results: string[] = []
  const seen = new Set<string>()

  for (const dir of dirs) {
    if (!GLib.file_test(dir, GLib.FileTest.IS_DIR)) continue
    try {
      const d = GLib.Dir.open(dir, 0)
      let name: string | null
      while ((name = d.read_name()) !== null) {
        if (name.endsWith(".jpg") || name.endsWith(".png") || name.endsWith(".webp") || name.endsWith(".avif")) {
          // Filter out symlinks/duplicates by filename
          if (!seen.has(name)) {
            seen.add(name)
            results.push(`${dir}/${name}`)
          }
        }
      }
      d.close()
    } catch {}
  }

  // Ensure default canonical wallpaper is always present if directory reading was empty
  if (results.length === 0 && usable(DEFAULT_WALLPAPER)) {
    results.push(DEFAULT_WALLPAPER)
  }

  return results.sort((a, b) => {
    const aName = a.split("/").pop() || ""
    const bName = b.split("/").pop() || ""
    if (aName === "wallpaper.jpg") return -1
    if (bName === "wallpaper.jpg") return 1
    return aName.localeCompare(bName)
  })
}

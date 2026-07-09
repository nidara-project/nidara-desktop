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
  if (usable(cfg.path)) return cfg.path
  if (usable(DEFAULT_WALLPAPER)) return DEFAULT_WALLPAPER
  return null
}

import GLib from "gi://GLib"

/**
 * Root of the shell's bundled resources (assets/, style.css, icons).
 *
 * The launcher starts the AGS process inside ui/ags-v3 (so `ags run app.ts`
 * bundles and finds style.css) and exports CRYSTAL_SHELL_ROOT pointing there.
 * We capture it here and then immediately move the process CWD to $HOME (below) —
 * otherwise every app launched from the dock/AppGrid inherits ui/ags-v3 as its
 * working directory instead of $HOME (kitty opening in the source tree, etc.).
 *
 * So: assets resolve against SHELL_ROOT (fixed), never the live CWD. The env var
 * is the source of truth; the get_current_dir() fallback covers a bare `ags run`.
 */
export const SHELL_ROOT = GLib.getenv("CRYSTAL_SHELL_ROOT") || GLib.get_current_dir()

// Move the process CWD to $HOME so child processes (terminals, apps) open there.
// Importing this module before anything spawns a child (see app.ts) makes this the
// effective default for the whole shell, replacing the per-launch `cd "$HOME"`.
GLib.chdir(GLib.get_home_dir())

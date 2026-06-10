import GLib from "gi://GLib"

/**
 * Root of the shell's bundled resources (assets/, style.css, icons).
 *
 * The launcher starts the AGS process inside ui/shell (so `ags run app.ts`
 * bundles and finds style.css) and exports CRYSTAL_SHELL_ROOT pointing there.
 * We capture it here and then immediately move the process CWD to $HOME (below) —
 * otherwise every app launched from the dock/AppGrid inherits ui/shell as its
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

/**
 * The shell's own version string. Dev checkouts win over the system install:
 * the `.dev` marker (written by `install.sh --dev`) points at the repo, whose
 * VERSION is the live one; /usr/share/crystal-shell/VERSION is the copy frozen
 * at install time.
 */
export function readShellVersion(): string {
    const devMarker = `${GLib.get_home_dir()}/.config/crystal-shell/.dev`
    try {
        const [devOk, devBytes] = GLib.file_get_contents(devMarker)
        if (devOk) {
            const repoDir = new TextDecoder().decode(devBytes).trim()
            const [ok, bytes] = GLib.file_get_contents(`${repoDir}/VERSION`)
            if (ok) return new TextDecoder().decode(bytes).trim()
        }
    } catch {}

    try {
        const [ok, bytes] = GLib.file_get_contents("/usr/share/crystal-shell/VERSION")
        if (ok) return new TextDecoder().decode(bytes).trim()
    } catch {}

    return "0.1.0"
}

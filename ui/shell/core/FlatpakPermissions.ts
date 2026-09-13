import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { execAsync } from "../../lib/process"

/**
 * What a Flatpak was given AT INSTALL — read, changed, restored and followed.
 *
 * Portal permissions (core/PermissionStore) are asked for while the app runs. These
 * are not: an app declares them in its manifest (`finish-args`), Flatpak grants them
 * when it is installed, and they hold from the next launch on — no prompt, ever.
 * The user can still take one away (or give one that was not asked for) with
 * `flatpak override --user`, which is the supported interface and what Flatseal and
 * GNOME Settings drive too, so a change made here shows up there and vice versa.
 *
 * ── Measured (2026-09-13, flatpak 1.18.2, org.gnome.clocks) ───────────────────────
 *   - `flatpak info --show-permissions` prints the EFFECTIVE set, declared and
 *     overrides already merged — useless for "what did the app ask for". So the two
 *     layers are read separately: the app's `metadata` [Context] is what it declared;
 *     the override keyfiles are what the user changed.
 *   - An override is a keyfile of the same shape, `!name` removing: `--nosocket=
 *     pulseaudio` writes `sockets=!pulseaudio;`, `--nofilesystem=home` writes
 *     `filesystems=!home;`.
 *   - `!home` does NOT take away `host` (the whole disk, home included): with `host`
 *     declared, the effective set still read `filesystems=host;` after `!home`, and
 *     was empty only after `!home;!host;`. Revoking the home folder revokes both.
 *   - `--reset` deletes the app's override file: that IS "restore what the app asked".
 *   - `FLATPAK_USER_DIR` moves the user installation AND its overrides — what the
 *     probe uses so it never writes the real ones (scripts/dev/install-permissions-probe.sh).
 *
 * Layers, lowest to highest, the order flatpak itself applies them: the metadata,
 * system `global`, system `<app>`, user `global`, user `<app>`. Settings writes only
 * the last one.
 */
export type InstallPermission = "network" | "sound" | "gpu" | "home"

type ContextGroup = "shared" | "sockets" | "devices" | "filesystems"

interface Spec {
    group: ContextGroup
    /** Any of these names present = the app has it. */
    grantedBy: string[]
    /** The name a grant adds. */
    grant: string
    on: string
    off: string
}

const SPECS: Record<InstallPermission, Spec> = {
    network: { group: "shared",      grantedBy: ["network"],        grant: "network",    on: "--share",      off: "--unshare" },
    // The pulseaudio socket is playback AND recording: there is no separate microphone.
    sound:   { group: "sockets",     grantedBy: ["pulseaudio"],     grant: "pulseaudio", on: "--socket",     off: "--nosocket" },
    // `all` hands over every device node, the GPU among them.
    gpu:     { group: "devices",     grantedBy: ["dri", "all"],     grant: "dri",        on: "--device",     off: "--nodevice" },
    home:    { group: "filesystems", grantedBy: ["home", "host"],   grant: "home",       on: "--filesystem", off: "--nofilesystem" },
}

export const INSTALL_PERMISSIONS = Object.keys(SPECS) as InstallPermission[]

export interface InstallPermissions {
    /** What the app's manifest asked for. */
    declared: Record<InstallPermission, boolean>
    /** What it gets on its next launch. */
    effective: Record<InstallPermission, boolean>
}

function userDir(): string {
    return GLib.getenv("FLATPAK_USER_DIR") ?? GLib.build_filenamev([GLib.get_user_data_dir(), "flatpak"])
}

function systemDir(): string {
    return GLib.getenv("FLATPAK_SYSTEM_DIR") ?? "/var/lib/flatpak"
}

/** A filesystem entry carries a mode suffix (`home:ro`, `xdg-download:create`); the name is what counts. */
function entryName(group: ContextGroup, entry: string): string {
    return group === "filesystems" ? entry.replace(/:(ro|rw|create)$/, "") : entry
}

function readContext(path: string): Partial<Record<ContextGroup, string[]>> | null {
    const kf = new GLib.KeyFile()
    try {
        kf.load_from_file(path, GLib.KeyFileFlags.NONE)
    } catch {
        return null
    }
    const out: Partial<Record<ContextGroup, string[]>> = {}
    for (const group of ["shared", "sockets", "devices", "filesystems"] as ContextGroup[]) {
        try {
            out[group] = kf.get_string_list("Context", group).filter(Boolean)
        } catch { /* key absent */ }
    }
    return out
}

function applyLayer(sets: Record<ContextGroup, Set<string>>, layer: Partial<Record<ContextGroup, string[]>> | null): void {
    if (!layer) return
    for (const [group, entries] of Object.entries(layer) as [ContextGroup, string[]][]) {
        for (const entry of entries) {
            if (entry.startsWith("!")) sets[group].delete(entryName(group, entry.slice(1)))
            else sets[group].add(entryName(group, entry))
        }
    }
}

function granted(sets: Record<ContextGroup, Set<string>>): Record<InstallPermission, boolean> {
    const out = {} as Record<InstallPermission, boolean>
    for (const p of INSTALL_PERMISSIONS) out[p] = SPECS[p].grantedBy.some(n => sets[SPECS[p].group].has(n))
    return out
}

function emptySets(): Record<ContextGroup, Set<string>> {
    return { shared: new Set(), sockets: new Set(), devices: new Set(), filesystems: new Set() }
}

/**
 * Both layers for one Flatpak id (the entry's `X-Flatpak` value), or null when the
 * app is not installed in either installation.
 */
export function readInstallPermissions(flatpakId: string): InstallPermissions | null {
    const metadata = [userDir(), systemDir()]
        .map(dir => GLib.build_filenamev([dir, "app", flatpakId, "current", "active", "metadata"]))
        .find(p => GLib.file_test(p, GLib.FileTest.EXISTS))
    const declaredLayer = metadata ? readContext(metadata) : null
    if (!declaredLayer) return null

    const sets = emptySets()
    applyLayer(sets, declaredLayer)
    const declared = granted(sets)
    for (const dir of [systemDir(), userDir()])
        for (const name of ["global", flatpakId])
            applyLayer(sets, readContext(GLib.build_filenamev([dir, "overrides", name])))
    return { declared, effective: granted(sets) }
}

// Listeners per app, so a write that FAILED still re-syncs the switch that asked for it
// (no file changes, so the monitor alone would leave it showing a lie).
const listeners = new Map<string, Set<() => void>>()

function notify(flatpakId: string): void {
    listeners.get(flatpakId)?.forEach(cb => cb())
}

/** Give or take one permission, in the user layer. Applies from the app's next launch. */
export async function setInstallPermission(flatpakId: string, permission: InstallPermission, on: boolean): Promise<void> {
    const spec = SPECS[permission]
    // Revoking takes every name that grants it (`!home` alone leaves `host`); granting adds one.
    const flags = on
        ? [`${spec.on}=${spec.grant}`]
        : spec.grantedBy.map(n => `${spec.off}=${n}`)
    try {
        await execAsync(["flatpak", "override", "--user", ...flags, flatpakId])
    } finally {
        notify(flatpakId)
    }
}

/** Drop every change the user made: the app gets exactly what it declared. */
export async function resetInstallPermissions(flatpakId: string): Promise<void> {
    try {
        await execAsync(["flatpak", "override", "--user", "--reset", flatpakId])
    } finally {
        notify(flatpakId)
    }
}

/**
 * Follow one app's permissions: writes from this module, and any other tool editing
 * the user overrides (Flatseal, a terminal). Returns an unsubscribe.
 */
export function watchInstallPermissions(flatpakId: string, cb: () => void): () => void {
    if (!listeners.has(flatpakId)) listeners.set(flatpakId, new Set())
    listeners.get(flatpakId)!.add(cb)

    // ⚠️ The directory must EXIST before it is watched. Measured: a monitor on a missing
    // `overrides/` got no event at all when `flatpak override` then created it and wrote
    // the file — the first change made from anywhere would be missed. `flatpak override`
    // creates this same empty directory on its first write, so making it here is not new
    // state. (flatpak writes a temp file and renames it; without WATCH_MOVES that arrives
    // as CREATED on the app's own name, which is what the filter below matches.)
    const path = GLib.build_filenamev([userDir(), "overrides"])
    GLib.mkdir_with_parents(path, 0o755)
    const monitor = Gio.File.new_for_path(path).monitor_directory(Gio.FileMonitorFlags.NONE, null)
    monitor.connect("changed", (_m: any, file: Gio.File) => {
        const name = file.get_basename()
        if (name === flatpakId || name === "global") cb()
    })
    return () => {
        monitor.cancel()
        listeners.get(flatpakId)?.delete(cb)
    }
}

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { ACCENT_HEX, rgbToClosestAccent, type AccentKey } from "./accent"
import {
  DEFAULT_CONFIG,
  clampGlass,
  type NidaraThemeConfig,
  type ShellAppearance,
} from "./theme-tokens"

/**
 * NIDARA — what the user picked, read the same way from every process
 * ===================================================================
 *
 * There is one answer to "what accent, which mode, how opaque?" and there used to
 * be three ways of getting it: the shell held it in `ThemeManager`, the greeter and
 * the lockscreen parsed `appearance.json` themselves, and the installer parsed it
 * again with its own copy of the same function. Each copy defaulted differently
 * when a key was missing, and none of them noticed a change unless it had also
 * written its own `Gio.FileMonitor`.
 *
 * This module is the one door. It answers from whichever source THIS process can
 * reach, and the caller never learns which.
 *
 * ── THE TWO BACKENDS, AND WHY BOTH HAVE TO EXIST ────────────────────────────
 *
 * **The portal, first.** `xdg-desktop-portal`'s Settings interface carries our
 * `org.nidara.appearance` namespace (served by `bin/nidara-portal`) alongside the
 * spec's `org.freedesktop.appearance` — one `ReadAll` returns both, and
 * `SettingChanged` reports each key that moves. It is the right channel for three
 * reasons that a file is not: it crosses a sandbox boundary (a Flatpak app cannot
 * open `~/.config/nidara/appearance.json` and can call the portal), it is one
 * subscription instead of one file monitor per process, and it is already how
 * every THIRD-party GTK app follows this desktop's accent. Verified end to end on
 * 2026-08-26: a custom namespace is forwarded by the frontend to our impl backend,
 * and an identical rewrite of the file emits nothing while one moved key emits
 * exactly one signal.
 *
 * **The file, always.** `/var/tmp/nidara/appearance.json` is not a fallback for a
 * broken portal, it is the only channel one surface will ever have: the greeter
 * runs as the `greeter` system user, in its own compositor, with no session portal
 * — and a portal running there would answer for the wrong user, which is worse
 * than not answering. So the greeter passes `{ portal: false }` and says what it
 * knows about itself, rather than being sniffed at.
 *
 * ⚠️ **`ThemeManager` remains the WRITER.** This module never writes, and the
 * portal namespace is a view of the file, not a second copy of the truth. A future
 * change that makes the portal authoritative has to answer the greeter question
 * first.
 */

/** The user's appearance, complete — the token engine's config plus the mode. */
export interface AppearanceState extends NidaraThemeConfig {
  /** The system's dark/light mode. NOT the same as `shellAppearance`, which can pin
   *  the shell's own skin against it. */
  isDark: boolean
}

export interface AppearanceOpts {
  /**
   * May this process ask the portal? Default true.
   *
   * Pass `false` from a process that is NOT running in the user's session — today
   * that means the greeter. It is a statement about the CALLER, not a preference:
   * a session bus may well exist there, and any portal on it would answer for the
   * wrong user.
   */
  portal?: boolean

  /**
   * Optional home directory to inspect for user appearance file before falling back
   * to system/default locations. Used when running under a service account (like greeter)
   * that knows which user is logging in.
   */
  homeDir?: string
}

const APPEARANCE_NS = "org.freedesktop.appearance"
const NIDARA_NS = "org.nidara.appearance"
const PORTAL_BUS = "org.freedesktop.portal.Desktop"
const PORTAL_PATH = "/org/freedesktop/portal/desktop"
const PORTAL_IFACE = "org.freedesktop.portal.Settings"

/** Where `ThemeManager` writes: the user copy, session's copy, then the world-readable mirror. */
function candidateFilePaths(opts: AppearanceOpts = {}): string[] {
  const paths: string[] = []
  if (opts.homeDir) {
    paths.push(`${opts.homeDir}/.config/nidara/appearance.json`)
  }
  paths.push(`${GLib.get_user_config_dir()}/nidara/appearance.json`)
  paths.push("/var/tmp/nidara/appearance.json")
  return paths
}

/** The defaults, as one object, so every "key missing" answer comes from one place. */
const FALLBACK: AppearanceState = { ...DEFAULT_CONFIG, isDark: false }

function asAccent(v: unknown): AccentKey {
  return typeof v === "string" && v in ACCENT_HEX ? (v as AccentKey) : FALLBACK.accent
}

function asShellAppearance(v: unknown): ShellAppearance {
  return v === "dark" || v === "light" || v === "system" ? v : FALLBACK.shellAppearance
}

function asGlass(v: unknown, dflt: number): number {
  return typeof v === "number" && isFinite(v) ? clampGlass(v) : dflt
}

// ── The file backend ─────────────────────────────────────────────────────────

/** The first appearance file that exists, or null when this machine has none. */
function filePath(opts: AppearanceOpts = {}): string | null {
  return candidateFilePaths(opts).find((p) => GLib.file_test(p, GLib.FileTest.EXISTS)) ?? null
}

function readFileState(opts: AppearanceOpts = {}): AppearanceState | null {
  for (const path of candidateFilePaths(opts)) {
    try {
      const [ok, data] = GLib.file_get_contents(path)
      if (!ok) continue
      const raw = JSON.parse(new TextDecoder().decode(data as Uint8Array)) as Record<string, unknown>
      return {
        accent: asAccent(raw.accent),
        // `=== true`, never `!== false`: a missing key means LIGHT, which is what
        // DEFAULT_CONFIG ships. Defaulting the other way makes an unreadable file
        // look like a deliberate dark session.
        isDark: raw.isDark === true,
        windowOpacity: asGlass(raw.windowOpacity, FALLBACK.windowOpacity),
        barOpacity: asGlass(raw.barOpacity, FALLBACK.barOpacity),
        overlayOpacity: asGlass(raw.overlayOpacity, FALLBACK.overlayOpacity),
        dockOpacity: asGlass(raw.dockOpacity, FALLBACK.dockOpacity),
        shellAppearance: asShellAppearance(raw.shellAppearance),
      }
    } catch { /* a truncated or absent file: try the next one */ }
  }
  return null
}

// ── The portal backend ───────────────────────────────────────────────────────

function ensureSessionBus(): void {
  if (!GLib.getenv("DBUS_SESSION_BUS_ADDRESS")) {
    const runtime = GLib.getenv("XDG_RUNTIME_DIR")
    if (runtime) {
      const busPath = `${runtime}/bus`
      if (GLib.file_test(busPath, GLib.FileTest.EXISTS)) {
        GLib.setenv("DBUS_SESSION_BUS_ADDRESS", `unix:path=${busPath}`, true)
      }
    }
  }
}

/**
 * `ReadAll` standard and Nidara namespaces, or null when the portal cannot answer.
 *
 * Conforms fully to `org.freedesktop.appearance` (standard XDG Desktop Portal spec)
 * while enriching with `org.nidara.appearance` when running on a Nidara system.
 */
function readPortalState(): AppearanceState | null {
  ensureSessionBus()
  if (!GLib.getenv("DBUS_SESSION_BUS_ADDRESS")) return null
  try {
    const bus = Gio.DBus.session
    if (!bus) return null
    const reply = bus.call_sync(
      PORTAL_BUS, PORTAL_PATH, PORTAL_IFACE, "ReadAll",
      new GLib.Variant("(as)", [[APPEARANCE_NS, NIDARA_NS]]),
      new GLib.VariantType("(a{sa{sv}})"),
      Gio.DBusCallFlags.NONE, 1500, null,
    )
    const all = reply.deepUnpack() as [Record<string, Record<string, unknown>>]
    const fdNs = all[0]?.[APPEARANCE_NS]
    const nidaraNs = all[0]?.[NIDARA_NS]
    if ((!fdNs || Object.keys(fdNs).length === 0) && (!nidaraNs || Object.keys(nidaraNs).length === 0)) {
      return null
    }

    const val = (dict: Record<string, unknown> | undefined, k: string) => {
      const v = dict?.[k] as { deepUnpack?: () => unknown } | undefined
      return v && typeof v.deepUnpack === "function" ? v.deepUnpack() : v
    }

    let accent: AccentKey = FALLBACK.accent
    if (nidaraNs && typeof val(nidaraNs, "accent") === "string") {
      accent = asAccent(val(nidaraNs, "accent"))
    } else if (fdNs) {
      const rgb = val(fdNs, "accent-color")
      if (Array.isArray(rgb) && rgb.length >= 3) {
        accent = rgbToClosestAccent(rgb[0], rgb[1], rgb[2])
      }
    }

    let isDark: boolean = FALLBACK.isDark
    if (nidaraNs && val(nidaraNs, "is-dark") !== undefined) {
      isDark = val(nidaraNs, "is-dark") === true
    } else if (fdNs && val(fdNs, "color-scheme") !== undefined) {
      // 0: default, 1: prefer-dark, 2: prefer-light
      isDark = val(fdNs, "color-scheme") === 1
    }

    return {
      accent,
      isDark,
      windowOpacity: asGlass(val(nidaraNs, "window-opacity"), FALLBACK.windowOpacity),
      barOpacity: asGlass(val(nidaraNs, "bar-opacity"), FALLBACK.barOpacity),
      overlayOpacity: asGlass(val(nidaraNs, "overlay-opacity"), FALLBACK.overlayOpacity),
      dockOpacity: asGlass(val(nidaraNs, "dock-opacity"), FALLBACK.dockOpacity),
      shellAppearance: asShellAppearance(val(nidaraNs, "shell-appearance")),
    }
  } catch {
    return null
  }
}

function readGSettingsState(): Partial<AppearanceState> | null {
  try {
    const schemaSource = Gio.SettingsSchemaSource.get_default()
    if (schemaSource && schemaSource.lookup("org.gnome.desktop.interface", true)) {
      const s = new Gio.Settings({ schema: "org.gnome.desktop.interface" })
      const accent = s.get_string("accent-color")
      const scheme = s.get_string("color-scheme")
      return {
        accent: asAccent(accent),
        isDark: scheme === "prefer-dark",
      }
    }
  } catch {}
  return null
}

// ── The door ─────────────────────────────────────────────────────────────────

export type AppearanceSource = "portal" | "file" | "defaults"

/** Which backend answered the last `readAppearance()` — for logs and `nidara-doctor`. */
export function appearanceSource(): AppearanceSource {
  return lastSource
}

let lastSource: AppearanceSource = "defaults"

/**
 * The user's appearance right now. Never throws and never returns undefined: a
 * process with no portal, no file and no session still gets a complete, coherent
 * state — the shipped defaults — because a surface painted with half a ramp is
 * worse than one painted with the wrong accent.
 */
export function readAppearance(opts: AppearanceOpts = {}): AppearanceState {
  let base: AppearanceState | null = null

  if (opts.portal !== false) {
    const fromPortal = readPortalState()
    if (fromPortal) { lastSource = "portal"; base = fromPortal }
  }
  if (!base) {
    const fromFile = readFileState(opts)
    if (fromFile) { lastSource = "file"; base = fromFile }
    else { lastSource = "defaults"; base = { ...FALLBACK } }
  }

  // If GSettings is reachable in this session, its accent-color and color-scheme
  // are the instant source of truth (ThemeManager writes them on every click).
  const gsettings = readGSettingsState()
  if (gsettings) {
    if (gsettings.accent) base.accent = gsettings.accent
    if (gsettings.isDark !== undefined) base.isDark = gsettings.isDark
  }

  return base
}

/**
 * Call `cb` whenever the appearance changes, with the complete new state.
 *
 * Returns an unsubscribe. The subscription follows three complementary layers:
 * 1. The portal's `SettingChanged` signal (standard for sandboxed & desktop apps).
 * 2. GSettings `org.gnome.desktop.interface` (instant in-session response).
 * 3. Durable directory file monitors on `~/.config/nidara/` and `/var/tmp/nidara/`
 *    (immune to inode replacement on atomic file saves).
 */
export function watchAppearance(
  cb: (state: AppearanceState) => void,
  opts: AppearanceOpts = {},
): () => void {
  const unsubs: (() => void)[] = []

  // 1. Portal signal subscription (catches both org.freedesktop.appearance and org.nidara.appearance)
  ensureSessionBus()
  if (opts.portal !== false && GLib.getenv("DBUS_SESSION_BUS_ADDRESS")) {
    try {
      const bus = Gio.DBus.session
      if (bus) {
        const id = bus.signal_subscribe(
          null, PORTAL_IFACE, "SettingChanged", PORTAL_PATH, null,
          Gio.DBusSignalFlags.NONE,
          () => cb(readAppearance(opts)),
        )
        unsubs.push(() => { try { bus.signal_unsubscribe(id) } catch {} })
      }
    } catch {}
  }

  // 2. Direct GSettings listener when running in user session (instant 0ms response)
  try {
    const schemaSource = Gio.SettingsSchemaSource.get_default()
    if (schemaSource && schemaSource.lookup("org.gnome.desktop.interface", true)) {
      const gsettings = new Gio.Settings({ schema: "org.gnome.desktop.interface" })
      const idAccent = gsettings.connect("changed::accent-color", () => cb(readAppearance(opts)))
      const idScheme = gsettings.connect("changed::color-scheme", () => cb(readAppearance(opts)))
      unsubs.push(() => {
        try {
          gsettings.disconnect(idAccent)
          gsettings.disconnect(idScheme)
        } catch {}
      })
    }
  } catch {}

  // 3. Durable directory file monitors (catches atomic file renames)
  for (const path of candidateFilePaths(opts)) {
    try {
      const dirPath = GLib.path_get_dirname(path)
      const targetBasename = GLib.path_get_basename(path)
      const dir = Gio.File.new_for_path(dirPath)
      if (dir.query_exists(null)) {
        const monitor = dir.monitor_directory(Gio.FileMonitorFlags.NONE, null)
        const id = monitor.connect("changed", (_mon, file) => {
          if (file && file.get_basename() !== targetBasename) return
          cb(readAppearance(opts))
        })
        unsubs.push(() => { try { monitor.disconnect(id); monitor.cancel() } catch {} })
      }
    } catch {}
  }

  return () => {
    for (const u of unsubs) u()
  }
}

import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { ACCENT_HEX, type AccentKey } from "./accent"
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
}

const NIDARA_NS = "org.nidara.appearance"
const PORTAL_BUS = "org.freedesktop.portal.Desktop"
const PORTAL_PATH = "/org/freedesktop/portal/desktop"
const PORTAL_IFACE = "org.freedesktop.portal.Settings"

/** Where `ThemeManager` writes: the session's copy, then the world-readable mirror. */
const FILE_PATHS = [
  `${GLib.get_user_config_dir()}/nidara/appearance.json`,
  "/var/tmp/nidara/appearance.json",
]

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
function filePath(): string | null {
  return FILE_PATHS.find((p) => GLib.file_test(p, GLib.FileTest.EXISTS)) ?? null
}

function readFileState(): AppearanceState | null {
  for (const path of FILE_PATHS) {
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

/**
 * `ReadAll` our namespace, or null when the portal cannot answer it.
 *
 * Null covers every "not here" at once — no session bus, no portal running, no
 * backend serving our namespace — because the caller does the same thing in all
 * of them: read the file. The call is synchronous and short-timeout on purpose:
 * this runs once, before the first window is built, and a portal that is slow to
 * activate must not hold the first frame.
 */
function readPortalState(): AppearanceState | null {
  if (!GLib.getenv("DBUS_SESSION_BUS_ADDRESS")) return null
  try {
    const bus = Gio.DBus.session
    if (!bus) return null
    const reply = bus.call_sync(
      PORTAL_BUS, PORTAL_PATH, PORTAL_IFACE, "ReadAll",
      new GLib.Variant("(as)", [[NIDARA_NS]]),
      new GLib.VariantType("(a{sa{sv}})"),
      Gio.DBusCallFlags.NONE, 1500, null,
    )
    const all = reply.deepUnpack() as [Record<string, Record<string, unknown>>]
    const ns = all[0]?.[NIDARA_NS]
    // An empty answer is not a failure of the call — it is what comes back when no
    // backend serves the namespace. Treat it as "not available here".
    if (!ns || Object.keys(ns).length === 0) return null
    const val = (k: string) => {
      const v = ns[k] as { deepUnpack?: () => unknown } | undefined
      return v && typeof v.deepUnpack === "function" ? v.deepUnpack() : v
    }
    return {
      accent: asAccent(val("accent")),
      isDark: val("is-dark") === true,
      windowOpacity: asGlass(val("window-opacity"), FALLBACK.windowOpacity),
      barOpacity: asGlass(val("bar-opacity"), FALLBACK.barOpacity),
      overlayOpacity: asGlass(val("overlay-opacity"), FALLBACK.overlayOpacity),
      dockOpacity: asGlass(val("dock-opacity"), FALLBACK.dockOpacity),
      shellAppearance: asShellAppearance(val("shell-appearance")),
    }
  } catch {
    return null
  }
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
  if (opts.portal !== false) {
    const fromPortal = readPortalState()
    if (fromPortal) { lastSource = "portal"; return fromPortal }
  }
  const fromFile = readFileState()
  if (fromFile) { lastSource = "file"; return fromFile }
  lastSource = "defaults"
  return { ...FALLBACK }
}

/**
 * Call `cb` whenever the appearance changes, with the complete new state.
 *
 * Returns an unsubscribe. The subscription follows the same backend the read did:
 * the portal's `SettingChanged` when it answered, a `Gio.FileMonitor` otherwise.
 * Both are coalesced to "here is the whole state again" rather than "this key
 * moved", because every consumer regenerates a full stylesheet anyway, and a
 * per-key API would make each of them reassemble the state themselves — which is
 * the duplication this module exists to end.
 */
export function watchAppearance(
  cb: (state: AppearanceState) => void,
  opts: AppearanceOpts = {},
): () => void {
  const unsubs: (() => void)[] = []

  // 1. Portal signal subscription (catches both org.freedesktop.appearance and org.nidara.appearance)
  if (opts.portal !== false && GLib.getenv("DBUS_SESSION_BUS_ADDRESS")) {
    try {
      const bus = Gio.DBus.session
      if (bus) {
        const id = bus.signal_subscribe(
          PORTAL_BUS, PORTAL_IFACE, "SettingChanged", PORTAL_PATH, null,
          Gio.DBusSignalFlags.NONE,
          () => cb(readAppearance(opts)),
        )
        unsubs.push(() => { try { bus.signal_unsubscribe(id) } catch {} })
      }
    } catch {}
  }

  // 2. File monitors on all known appearance paths
  for (const path of FILE_PATHS) {
    try {
      const file = Gio.File.new_for_path(path)
      const monitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null)
      const id = monitor.connect("changed", () => cb(readAppearance(opts)))
      unsubs.push(() => { try { monitor.disconnect(id); monitor.cancel() } catch {} })
    } catch {}
  }

  return () => {
    for (const u of unsubs) u()
  }
}

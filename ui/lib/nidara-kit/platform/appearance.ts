// SPDX-License-Identifier: LGPL-3.0-or-later
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { ACCENT_HEX, rgbToClosestAccent, type AccentKey } from "./accent"
import {
  DEFAULT_CONFIG,
  asGlassMaterial,
  withGlass,
  type NidaraThemeConfig,
} from "./theme-tokens"

/**
 * NIDARA — how a process that is not the shell learns what the user picked
 * ========================================================================
 *
 * ── THE CONTRACT (2026-09-13, #534) ─────────────────────────────────────────
 *
 * Nidara behaves like GNOME, and the rule is the same for our own windows as for
 * anybody else's app:
 *
 * 1. **Every setting has exactly ONE home.** The keys the desktop standard already
 *    names live where GNOME keeps them — `accent-color` and `color-scheme` in
 *    `org.gnome.desktop.interface`, `high-contrast` in `…a11y.interface`,
 *    `enable-animations` for reduced motion, and the GTK / icon / cursor theme. The
 *    keys only Nidara has (the glass material, reduce transparency, window tinting) live in
 *    GSettings `org.nidara.appearance` (#573). Anybody with `gsettings` can write
 *    either; `ThemeManager` (the shell) follows both live.
 *
 * 2. **An application reads the portal, and only the portal.** `xdg-desktop-portal`'s
 *    Settings interface serves the spec's `org.freedesktop.appearance` and our
 *    `org.nidara.appearance` extension, both from `bin/nidara-portal`. This is what
 *    GTK 4.22 already does by itself for `color-scheme`, `contrast` and
 *    `reduced-motion` (the `@media (prefers-*)` queries), what libadwaita does for the
 *    accent, and what a sandboxed Flatpak is limited to. The installer, the lock
 *    screen and any future Nidara app are applications in this sense: nothing here
 *    is private to us, and a third-party developer can do exactly what this file
 *    does. There is NO second channel — not GSettings, not the file — mixed in.
 *    If the portal does not answer, the process paints the shipped defaults and says
 *    so in the log, instead of quietly asking somewhere else; and it re-reads the
 *    moment the portal shows up.
 *
 * 3. **The one exception is a surface OUTSIDE any session: the greeter.** It runs as
 *    the `greeter` system user in its own compositor, where no portal exists and one
 *    would answer for the wrong person. It reads the MIRROR
 *    (`/var/tmp/nidara/appearance.json`, 0644), an export the shell writes for it —
 *    never a store anybody reads back. It declares that with `channel: "mirror"`.
 *
 * ⚠️ What #533 got wrong, so it is not tried again: it read the portal, then the file,
 * then let GSettings override both. In the greeter GSettings answers with the SCHEMA
 * DEFAULT (blue, no preference), so the login screen ignored the user's accent; and in
 * every other process one click arrived through three channels as seven restyles.
 */

/** The user's appearance, complete — the token engine's config plus the mode. */
export interface AppearanceState extends NidaraThemeConfig {
  /** The system's dark/light mode — the skin every Nidara surface prefers. (The shell
   *  pin that could override it is gone, #676; the adaptive glass flips a single surface
   *  when its text needs it, and that is the shell's business, not an app's.) */
  isDark: boolean
}

/**
 * Where THIS process gets the appearance from. A statement about the caller, never a
 * preference: an application is `"portal"` (the default), and only a surface that
 * runs outside the user's session — the greeter — is `"mirror"`.
 */
export type AppearanceChannel = "portal" | "mirror"

export interface AppearanceOpts {
  channel?: AppearanceChannel
}

const APPEARANCE_NS = "org.freedesktop.appearance"
const NIDARA_NS = "org.nidara.appearance"
const PORTAL_BUS = "org.freedesktop.portal.Desktop"
const PORTAL_PATH = "/org/freedesktop/portal/desktop"
const PORTAL_IFACE = "org.freedesktop.portal.Settings"

/** Written by `ThemeManager.saveSettings()` with mode 0644, for the greeter only. */
export const APPEARANCE_MIRROR_PATH = "/var/tmp/nidara/appearance.json"

/** The defaults, as one object, so every "key missing" answer comes from one place. */
const FALLBACK: AppearanceState = { ...DEFAULT_CONFIG, isDark: false }

function asAccent(v: unknown): AccentKey {
  return typeof v === "string" && v in ACCENT_HEX ? (v as AccentKey) : FALLBACK.accent
}


/** A portal value, whether it arrives boxed (`GLib.Variant`) or already unpacked. */
function unbox(v: unknown): unknown {
  const b = v as { deepUnpack?: () => unknown } | undefined
  return b && typeof b.deepUnpack === "function" ? b.deepUnpack() : v
}

/**
 * Fold ONE portal key into a state. The same function serves `ReadAll` and every
 * `SettingChanged`, so the initial read and a live change cannot interpret a key
 * differently. Returns whether anything moved.
 */
function applyPortalKey(state: AppearanceState, ns: string, key: string, raw: unknown): boolean {
  const v = unbox(raw)
  const before = JSON.stringify(state)
  if (ns === APPEARANCE_NS) {
    if (key === "accent-color" && Array.isArray(v) && v.length >= 3) {
      // An (r,g,b) triple, per the spec. Mapping it to the nearest palette entry is
      // what libadwaita does too (`adw_accent_color_nearest_from_rgba`); from our own
      // backend it is an exact match.
      state.accent = rgbToClosestAccent(v[0] as number, v[1] as number, v[2] as number)
    } else if (key === "color-scheme" && typeof v === "number") {
      // 0 no preference · 1 prefer dark · 2 prefer light. "No preference" is light,
      // as it is in GNOME and in DEFAULT_CONFIG.
      state.isDark = v === 1
    }
  } else if (ns === NIDARA_NS) {
    // The two keys are the choice; the four opacities every painter reads are derived
    // from them HERE, with the table in theme-tokens.ts, so an app and the shell cannot
    // disagree about what "frosted" means.
    if (key === "glass-material") withGlass(Object.assign(state, { glassMaterial: asGlassMaterial(v) }))
    else if (key === "reduce-transparency" && typeof v === "boolean") withGlass(Object.assign(state, { reduceTransparency: v }))
    else if (key === "window-tinting" && typeof v === "boolean") withGlass(Object.assign(state, { windowTinting: v }))
  }
  return JSON.stringify(state) !== before
}

// ── The portal channel ──────────────────────────────────────────────────────

/** `ReadAll` both namespaces, or null when no portal answered. */
function readPortalState(): AppearanceState | null {
  try {
    // No `DBUS_SESSION_BUS_ADDRESS` check: GDBus falls back to
    // `$XDG_RUNTIME_DIR/bus` by itself, which is exactly the case of a process
    // launched by the compositor without the variable exported.
    const bus = Gio.DBus.session
    // Synchronous, like libadwaita's own first read: this runs once before the first
    // window is built, and a first frame painted in the wrong mode re-flows visibly.
    const reply = bus.call_sync(
      PORTAL_BUS, PORTAL_PATH, PORTAL_IFACE, "ReadAll",
      new GLib.Variant("(as)", [[APPEARANCE_NS, NIDARA_NS]]),
      new GLib.VariantType("(a{sa{sv}})"),
      Gio.DBusCallFlags.NONE, 1500, null,
    )
    const [all] = reply.deepUnpack() as [Record<string, Record<string, unknown>>]
    const state = { ...FALLBACK }
    let served = 0
    for (const ns of [APPEARANCE_NS, NIDARA_NS]) {
      for (const [key, value] of Object.entries(all?.[ns] ?? {})) { applyPortalKey(state, ns, key, value); served++ }
    }
    // A portal that ANSWERS with nothing is up but has no backend serving these
    // namespaces (Nidara's portal config not installed, or another desktop's). The
    // values are the defaults either way; the source must say so, or the log line
    // reads "portal" for a window that is not following anything.
    if (served === 0) {
      console.warn("[appearance] the Settings portal answered, but nothing serves the appearance namespaces — painting the defaults")
      return null
    }
    return state
  } catch (e) {
    console.warn(`[appearance] the Settings portal did not answer — painting the defaults until it does: ${e}`)
    return null
  }
}

// ── The mirror channel (the greeter) ────────────────────────────────────────

function readMirrorState(): AppearanceState | null {
  try {
    const [ok, data] = GLib.file_get_contents(APPEARANCE_MIRROR_PATH)
    if (!ok) return null
    const raw = JSON.parse(new TextDecoder().decode(data as Uint8Array)) as Record<string, unknown>
    return withGlass({
      ...FALLBACK,
      accent: asAccent(raw.accent),
      // `=== true`, never `!== false`: a missing key means LIGHT, which is what
      // DEFAULT_CONFIG ships. Defaulting the other way makes an unreadable file
      // look like a deliberate dark session.
      isDark: raw.isDark === true,
      glassMaterial: asGlassMaterial(raw.glassMaterial),
      reduceTransparency: raw.reduceTransparency === true,
      // `!== false`: tinting is ON by default, and a mirror written before the key
      // existed must not turn it off.
      windowTinting: raw.windowTinting !== false,
    })
  } catch (e) {
    // Not silent: an unreadable mirror is how #488 hid for a release (written 0600).
    console.warn(`[appearance] cannot read ${APPEARANCE_MIRROR_PATH} — painting the defaults: ${e}`)
    return null
  }
}

// ── The door ─────────────────────────────────────────────────────────────────

export type AppearanceSource = "portal" | "mirror" | "defaults"

let lastSource: AppearanceSource = "defaults"

/** Which channel answered the last `readAppearance()` — for logs and `nidara-doctor`. */
export function appearanceSource(): AppearanceSource {
  return lastSource
}

/**
 * The user's appearance right now, from this process's ONE channel. Never throws:
 * a process whose channel does not answer gets the complete shipped defaults, because
 * a surface painted with half a ramp is worse than one painted with the wrong accent.
 */
export function readAppearance(opts: AppearanceOpts = {}): AppearanceState {
  const state = opts.channel === "mirror" ? readMirrorState() : readPortalState()
  lastSource = state ? (opts.channel === "mirror" ? "mirror" : "portal") : "defaults"
  return state ?? { ...FALLBACK }
}

/**
 * Call `cb` with the complete new state whenever it changes. Returns an unsubscribe.
 *
 * `from` is the state the caller already painted, so a change is applied on top of
 * it instead of being re-read: a `SettingChanged` carries its own value, and asking
 * the portal again would put a blocking call on the main loop for every key.
 * Changes are COALESCED into one callback per frame — a burst of keys would otherwise
 * be one full stylesheet regeneration per key.
 */
export function watchAppearance(
  from: AppearanceState,
  cb: (state: AppearanceState) => void,
  opts: AppearanceOpts = {},
): () => void {
  let state = { ...from }
  let pending = 0
  // One frame (~16 ms) of coalescing, not an idle: keys moved by DIFFERENT writers
  // (the shell sets the accent, a `gsettings` call sets the mode) arrive in
  // separate main-loop turns, and an idle merged none of them — measured 2026-09-13,
  // three keys in a burst reached the client as three restyles.
  const flush = () => {
    if (pending) return
    pending = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
      pending = 0
      cb({ ...state })
      return GLib.SOURCE_REMOVE
    })
  }
  const unsubs: (() => void)[] = [() => { if (pending) GLib.source_remove(pending) }]

  if (opts.channel === "mirror") {
    // A DIRECTORY monitor: the file is replaced by rename on every save, and a
    // monitor on the file itself stops at the first replacement.
    try {
      const dir = Gio.File.new_for_path(GLib.path_get_dirname(APPEARANCE_MIRROR_PATH))
      const name = GLib.path_get_basename(APPEARANCE_MIRROR_PATH)
      const monitor = dir.monitor_directory(Gio.FileMonitorFlags.NONE, null)
      const id = monitor.connect("changed", (_m, file) => {
        if (file?.get_basename() !== name) return
        const next = readMirrorState()
        if (next && JSON.stringify(next) !== JSON.stringify(state)) { state = next; flush() }
      })
      unsubs.push(() => { monitor.disconnect(id); monitor.cancel() })
    } catch (e) {
      console.warn(`[appearance] cannot watch the mirror: ${e}`)
    }
  } else {
    try {
      const bus = Gio.DBus.session
      const sub = bus.signal_subscribe(
        PORTAL_BUS, PORTAL_IFACE, "SettingChanged", PORTAL_PATH, null,
        Gio.DBusSignalFlags.NONE,
        (_c, _s, _p, _i, _sig, params) => {
          const [ns, key, value] = params.deepUnpack() as [string, string, unknown]
          if (applyPortalKey(state, ns, key, value)) flush()
        },
      )
      unsubs.push(() => bus.signal_unsubscribe(sub))

      // A portal that was not up for the first read (a cold session) is read in full
      // the moment its name appears. When the first read DID answer, the name is
      // already owned and this fires once at subscription time — skipped.
      let skipFirst = appearanceSource() === "portal"
      const watch = Gio.bus_watch_name_on_connection(
        bus, PORTAL_BUS, Gio.BusNameWatcherFlags.NONE,
        () => {
          if (skipFirst) { skipFirst = false; return }
          const next = readPortalState()
          if (next) { state = next; lastSource = "portal"; flush() }
        },
        () => { skipFirst = false },
      )
      unsubs.push(() => Gio.bus_unwatch_name(watch))
    } catch (e) {
      console.warn(`[appearance] cannot subscribe to the Settings portal: ${e}`)
    }
  }

  return () => { for (const u of unsubs) { try { u() } catch {} } }
}

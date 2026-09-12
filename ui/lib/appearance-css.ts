import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import { ACCENT_HEX } from "./accent"
import { setAccentRim } from "./glass-capsule"
import { setKitAppearance } from "./nidara-kit/appearance"
import { generateTokensCss } from "./theme-tokens"
import {
  appearanceSource,
  readAppearance,
  watchAppearance,
  type AppearanceOpts,
  type AppearanceState,
} from "./appearance"

/**
 * NIDARA — one call, and this process wears the desktop
 * =====================================================
 *
 * Everything a Nidara process needs in order to look like Nidara, wired in one
 * place: the full `--nidara-*` ramp as CSS, the Cairo half of the same values
 * through the kit's appearance seam, the glass capsule's accent rim, and a live
 * subscription so all three follow the user changing their mind.
 *
 * WHERE the values come from is not decided here — `ui/lib/appearance.ts` holds the
 * contract: an application reads the Settings portal and nothing else; the greeter,
 * which lives outside any session, reads the mirror and says so with
 * `{ channel: "mirror" }`.
 *
 * ⚠️ **The shell does NOT use this.** It IS the writer: `ThemeManager` owns the
 * settings, pins the shell skin per-surface against the system mode, and
 * regenerates far more than the ramp (icon filters, GTK theme, `@define-color`).
 *
 * ⚠️ **Nothing calls this for you.** A bundle that builds a kit window without it
 * paints the kit's fallback and the kit logs the warning — kept loud on purpose.
 * (#533 made `NidaraWindow` call it silently, which turned a missing line in an
 * `app.ts` into a window that looked right by accident.)
 */

export interface InitAppearanceOpts extends AppearanceOpts {
  /**
   * Called after every appearance change, with the new state — for the parts of a
   * bundle that are neither CSS nor Cairo (a window class toggled for light mode,
   * a wallpaper re-read). Called once at init time too, so a caller has exactly
   * one code path instead of "apply now, and also on change".
   */
  onChange?: (state: AppearanceState) => void
}

export interface AppearanceHandle {
  /** The state as of the last change. */
  current: () => AppearanceState
  /** Stop following changes. The CSS already applied stays applied. */
  stop: () => void
}

/**
 * Initialize the desktop's appearance for this process and keep it in sync.
 *
 * Call once from `main()`, BEFORE the first window is built — the kit's seam has
 * to be registered before any Cairo widget paints, and the tokens have to be in
 * place before the first widget is measured, or the first frame lays out against
 * GTK's defaults and visibly re-flows.
 */
export function initAppearance(opts: InitAppearanceOpts = {}): AppearanceHandle {
  let state = readAppearance(opts)
  const listeners = new Set<() => void>()

  // ── The CSS half ───────────────────────────────────────────────────────────
  // A provider we keep a handle to, not `app.apply_css`: this sheet is RELOADED
  // on every change, and only a provider we still hold can be replaced. Priority
  // sits above the bundle's base sheet (USER) because in GTK4 a provider's
  // priority is settled before specificity is looked at — so the values computed
  // from the live session win over whatever the sheet ships as its fallback.
  const provider = new Gtk.CssProvider()
  const display = Gdk.Display.get_default()
  if (display) {
    Gtk.StyleContext.add_provider_for_display(
      display, provider, Gtk.STYLE_PROVIDER_PRIORITY_USER + 20,
    )
  }

  const apply = () => {
    try {
      provider.load_from_string(generateTokensCss(state, state.isDark))
    } catch (e) {
      // A ramp that fails to parse leaves the previous one in place, which is the
      // right failure: the surface keeps the last good appearance instead of
      // falling back to an unstyled window.
      console.error("[appearance] token sheet did not load:", e)
    }
    setAccentRim(ACCENT_HEX[state.accent])
    opts.onChange?.(state)
    listeners.forEach((cb) => cb())
  }

  // ── The Cairo half ─────────────────────────────────────────────────────────
  // Cairo cannot read a CSS token, so the kit is handed the accent as a value and
  // told what its surface is. `surfaceIsDark` answers for the whole process here:
  // a second window in a running Nidara has one mode, unlike the shell, where a
  // pinned skin and the system mode can disagree on the same screen.
  setKitAppearance({
    accent: () => ACCENT_HEX[state.accent],
    surfaceIsDark: () => state.isDark,
    onChange: (cb) => { listeners.add(cb); return () => { listeners.delete(cb) } },
    overlayOpacity: () => state.overlayOpacity,
    chromeIsDark: () => state.shellAppearance === "dark" ? true : state.shellAppearance === "light" ? false : state.isDark,
  })

  apply()

  // One line, once: which channel answered. It is the first thing to ask when a
  // second window does not match the desktop, and it is invisible otherwise —
  // "defaults" in a session means the portal did not answer, which no amount of
  // staring at the window would tell you.
  console.log(`[appearance] ${appearanceSource()} — accent ${state.accent}, `
            + `${state.isDark ? "dark" : "light"}, window ${state.windowOpacity.toFixed(2)}`)

  const stop = watchAppearance(state, (next) => { state = next; apply() }, opts)
  return { current: () => state, stop }
}

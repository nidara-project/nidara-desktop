// installer-pages-probe — every wizard page, one at a time, to be LOOKED at.
//
//   cd ui/installer && npx --yes sass@1.97.3 --no-charset style.scss style.css && cd ../..
//   ./scripts/bundle.sh scripts/dev/installer-pages-probe.ts /tmp/pages
//   gtk4-broadwayd :5 &
//   for p in welcome region disk account system summary; do
//     GDK_BACKEND=broadway BROADWAY_DISPLAY=:5 PAGE=$p SHOT=/tmp/page /tmp/pages
//   done                                            # → /tmp/page-<p>.png
//
// Without SHOT it presents the page instead of writing it, which is the mode for
// poking at one.
//
// ⚠️ It mounts ONE STEP, never the installer — the rule and the reason are
// `region-page-probe.ts`'s: `InstallerWindow` constructs `RunStep`, and "the
// installer only runs in a VM" is a rule about the PROCESS existing on a machine
// somebody is using, not about the page code being reached. `run` is therefore
// not one of the pages here, and must not be added: looking at it costs a VM.
//
// What it is for. `region-page-probe` and `disk-page-probe` each open the one page
// their work was about; a design pass needs the pages BESIDE each other, because
// what it is looking for lives between them — whether the heading ramp is the same
// on all six, whether the first control sits at the same height, whether the
// warning prose reads as one family. None of that is visible one page at a time,
// and none of it is something CI can see: the token contract, the wrapping labels
// and the row heights are all green while the pages disagree.
//
// ⚠️ The chrome here is the kit's window, NOT `InstallerWindow`'s — no sidebar, no
// footer. So this is the PAGE's review; the window's composition around it is a
// separate look, and the honest place for that one is the VM.
import Gtk from "gi://Gtk?version=4.0"
import Gdk from "gi://Gdk?version=4.0"
import Gsk from "gi://Gsk"
import GLib from "gi://GLib"
import app from "../../ui/lib/host"
import { applyCrispFontRendering } from "../../ui/lib/font-rendering"
import { NidaraWindow, NidaraClamp, NidaraScrolled, NIDARA_WINDOW_RADIUS } from "../../ui/lib/nidara-kit"
import { initAppearance } from "../../ui/lib/appearance-css"
import { WINDOW_LAYOUT } from "../../ui/lib/tokens"
import type { Step } from "../../ui/installer/lib/flow"
import { WelcomeStep } from "../../ui/installer/steps/welcome"
import { RegionStep } from "../../ui/installer/steps/region"
import { DiskStep } from "../../ui/installer/steps/disk"
import { AccountStep } from "../../ui/installer/steps/account"
import { SystemStep } from "../../ui/installer/steps/system"
import { SummaryStep } from "../../ui/installer/steps/summary"
import {
  setCountryAnswer, setTimezoneAnswer, setLanguageAnswer, setKeyboardAnswer, setAccountAnswer,
} from "../../ui/installer/lib/answers"
import { countries, defaultsFor } from "../../ui/installer/lib/region"
import { languageName } from "../../ui/lib/locale-names"

// ⚠️ The theme is a CHOICE here, and getting it wrong is how this probe produced a
// false finding. It used to force `GTK_THEME=nidara` — the blank theme — which is
// what the GREETER runs under and NOT what the installer does: a real session seeds
// `themeFamily: "Adwaita"` and `ThemeManager` unsets `GTK_THEME`. Under the blank
// theme a component whose rules we never wrote draws nothing, so an unstyled switch
// looked like an invisible switch, and the conclusion drawn from it ("the NVIDIA
// toggle has been invisible for six weeks") was wrong: under Adwaita GTK draws it.
//
// So: default to the session's theme, which is what the installer actually gets.
// `BLANK_THEME=1` forces the blank one, and that is worth running deliberately —
// under it, anything that still draws is drawing from OUR css, and anything that
// vanishes was relying on the user's GTK theme, which a Nidara surface must not do.
if (GLib.getenv("BLANK_THEME")) GLib.setenv("GTK_THEME", "nidara", true)

const PAGES: Record<string, () => Step> = {
  welcome: WelcomeStep,
  region: RegionStep,
  disk: DiskStep,
  account: AccountStep,
  system: SystemStep,
  summary: SummaryStep,
}

const which = (GLib.getenv("PAGE") ?? "welcome").toLowerCase()
const shot = GLib.getenv("SHOT")
if (!(which in PAGES)) {
  printerr(`PAGE=${which} — one of: ${Object.keys(PAGES).join(" ")}`)
  imports.system?.exit?.(1)
}

const here = GLib.get_current_dir()
const css = [`${here}/ui/installer/style.css`, "./ui/installer/style.css", "./style.css"]
  .find(p => GLib.file_test(p, GLib.FileTest.EXISTS))

/** Enough answers that the later pages are not reviewed empty — the summary in
 *  particular is nothing but what the earlier pages decided. Seeded through the
 *  real setters, so what is drawn is what a real run produces. */
function seed() {
  const c = countries().find(x => x.code === "ES")
  if (c) {
    setCountryAnswer({ code: c.code, name: c.name })
    const d = defaultsFor(c.code)
    if (d.timezone) setTimezoneAnswer({ timezone: d.timezone })
    if (d.locale) {
      const [sysLang, sysEnc] = d.locale.split(".")
      setLanguageAnswer({ locale: d.locale, sysLang, sysEnc: sysEnc || "UTF-8", label: languageName(d.locale) })
    }
    if (d.keyboard) setKeyboardAnswer({
      layout: d.keyboard.layout, variant: d.keyboard.variant,
      keymap: d.keyboard.keymap, label: d.keyboard.label,
    })
  }
  setAccountAnswer({
    fullName: "Ada Lovelace", username: "ada", hostname: "nidara",
    password: "correcthorsebattery",
  })
}

/** Render a realized widget to a PNG — the trick `installer-log-probe.js` uses:
 *  a `WidgetPaintable` into a `Gtk.Snapshot`, and the window's own renderer turns
 *  the node into a texture. No screen, no compositor, no capture. */
function savePng(widget: Gtk.Widget, win: Gtk.Window, path: string) {
  const w = widget.get_width()
  const h = widget.get_height()
  if (w <= 0 || h <= 0) {
    printerr(`[shot] ${path}: widget is ${w}x${h} — not allocated yet`)
    return false
  }
  const snapshot = Gtk.Snapshot.new()
  Gtk.WidgetPaintable.new(widget).snapshot(snapshot, w, h)
  const node = snapshot.to_node()
  if (!node) {
    printerr(`[shot] ${path}: empty render node`)
    return false
  }
  const renderer: Gsk.Renderer | null = win.get_renderer?.() ?? null
  if (!renderer) {
    printerr(`[shot] ${path}: no renderer on the window`)
    return false
  }
  renderer.render_texture(node, null).save_to_png(path)
  print(`[shot] ${path}  ${w}x${h}`)
  return true
}

app.start({
  applicationId: `org.nidara.installer.pageprobe.${which}`,
  applicationName: `Installer page probe (${which})`,
  logDomain: "pages-probe",
  css,

  main() {
    applyCrispFontRendering()
    initAppearance()
    seed()

    const step = PAGES[which]()
    const page = step.build(() => {})
    page.add_css_class("installer-body")

    const { widget: scroller } = NidaraScrolled({
      child: NidaraClamp(page, WINDOW_LAYOUT.wizardContent, true, WINDOW_LAYOUT.wizardContent),
      reserveLane: false,
      hscrollPolicy: Gtk.PolicyType.EXTERNAL,
      cornerRadius: NIDARA_WINDOW_RADIUS,
      cssClasses: ["installer-page-scroll"],
    })

    const shell = NidaraWindow({
      app,
      title: `Installer page probe — ${which}`,
      name: "nidara-installer",
      appId: "nidara-installer-probe",
      cssClasses: ["nidara-installer-window"],
      glassClasses: ["installer-root"],
      content: scroller,
      header: { start: new Gtk.Label({ label: which, css_classes: ["installer-title"], xalign: 0 }) },
      closeOnEscape: true,
    })
    // ⚠️ A FIXED size, and it has to be: `InstallerWindow` sizes itself from the
    // monitor (`defaultHeight: -1`, then a measure against the work area), which a
    // probe has no business reproducing — and a page reviewed at a different width
    // on each run is a page nobody can compare. `wizardContent` is the pane the
    // real window clamps to, so the content is identical; the rest is chrome.
    shell.window.set_default_size(WINDOW_LAYOUT.wizardContent + 120, 760)
    shell.window.connect("destroy", () => app.quit())
    shell.window.present()
    step.onEnter?.()

    if (shot) {
      // ⚠️ Wait for real PAINTS, not for a clock. A timeout counts milliseconds,
      // and a page whose build probes hardware (the system page runs `lspci`) can
      // still be un-drawn when it expires: `WidgetPaintable` then snapshots a
      // widget that has an allocation and no content, and `to_node()` returns
      // null. That is what a 400 ms timer did here on the first run — it reported
      // "empty render node" for exactly one of six pages, which reads like a bug
      // in the page and was a bug in the instrument.
      //
      // Two paints rather than one, because the first frame of a GTK window is
      // drawn before the step's own idle work lands (the region page fills its
      // lists there).
      let painted = 0
      const clock = shell.window.get_frame_clock()
      if (!clock) {
        printerr("[shot] the window has no frame clock — is it realized?")
        app.quit()
        return
      }
      clock.connect("after-paint", () => {
        if (++painted < 2) return
        savePng(shell.window.get_child()!, shell.window, `${shot}-${which}.png`)
        app.quit()
      })
      // A window with nothing animating stops asking for frames, so ask.
      clock.begin_updating()
      // Last resort: never hang a scripted sweep on a page that refuses to paint.
      GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 20, () => {
        printerr(`[shot] ${which}: no second paint in 20 s`)
        app.quit()
        return GLib.SOURCE_REMOVE
      })
    }
  },
})

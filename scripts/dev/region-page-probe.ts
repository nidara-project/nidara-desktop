// region-page-probe — the region page on its own, to be looked at.
//
//   cd ui/installer && npx --yes sass@1.97.3 --no-charset style.scss style.css
//   ./scripts/bundle.sh scripts/dev/region-page-probe.ts /tmp/region-page && /tmp/region-page
//
// ⚠️ It mounts ONE STEP, never the installer. `InstallerWindow` constructs
// `RunStep`, and the rule that the installer only ever runs in a VM — dry run
// included — is not a rule about the disk code being reached, it is a rule about
// the process existing on a machine somebody is using. So this imports the step
// and nothing else, the same way installer-log-probe mounts the log view alone.
//
// What it is for: the page is the one deliverable of the region work that cannot
// be checked by a type, a bundle or a parity count. Whether 249 countries scroll
// well, whether "Choose…" reads as a question rather than a placeholder, and
// whether the derived rows appear where the eye expects them are all things you
// have to open.

import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"
import app from "../../ui/lib/host"
import { installAppearance } from "../../ui/lib/appearance-css"
import { applyCrispFontRendering } from "../../ui/lib/font-rendering"
import { NidaraWindow, NidaraClamp, NidaraScrolled, NIDARA_WINDOW_RADIUS } from "../../ui/lib/nidara-kit"
import { WINDOW_LAYOUT } from "../../ui/lib/tokens"
import { RegionStep } from "../../ui/installer/steps/region"
import {
  getAnswers, setCountryAnswer, setTimezoneAnswer, setLanguageAnswer, setKeyboardAnswer,
} from "../../ui/installer/lib/answers"
import { countries, defaultsFor } from "../../ui/installer/lib/region"
import { languageName } from "../../ui/lib/locale-names"

GLib.setenv("GTK_THEME", "nidara", true)

const here = GLib.get_current_dir()
const css = [`${here}/ui/installer/style.css`, "./ui/installer/style.css", "./style.css"]
  .find(p => GLib.file_test(p, GLib.FileTest.EXISTS))

app.start({
  applicationId: "org.nidara.installer.regionprobe",
  applicationName: "Region page probe",
  logDomain: "region-probe",
  css,

  main() {
    applyCrispFontRendering()
    installAppearance()

    // REGION_PROBE_COUNTRY=ES opens with a country already chosen, so the derived
    // half of the page can be looked at without driving the list by hand. It goes
    // through defaultsFor, so what you see is what a real click produces — the
    // point being to look at the ambiguous ones: BR leaves sixteen zones open, CH
    // leaves two keyboards, IN leaves the locale.
    const seed = GLib.getenv("REGION_PROBE_COUNTRY")
    if (seed) {
      const c = countries().find(x => x.code === seed.toUpperCase())
      if (c) {
        setCountryAnswer({ code: c.code, name: c.name })
        const d = defaultsFor(c.code)
        if (d.timezone) setTimezoneAnswer({ timezone: d.timezone })
        // The LANGUAGE is no longer the region page's question — it moved to the
        // welcome page, which is where every installer in the ecosystem asks it.
        // Seeded here anyway so the step's `ready()` can be exercised alone.
        if (d.locale) {
          const [sysLang, sysEnc] = d.locale.split(".")
          setLanguageAnswer({ locale: d.locale, sysLang, sysEnc: sysEnc || "UTF-8", label: languageName(d.locale) })
        }
        if (d.keyboard) setKeyboardAnswer({
          layout: d.keyboard.layout, variant: d.keyboard.variant,
          keymap: d.keyboard.keymap, label: d.keyboard.label,
        })
        print(`[seed] ${c.name} → tz=${d.timezone ?? "ASK"} locale=${d.locale ?? "ASK"} kb=${d.keyboard?.layout ?? "ASK"}`)
      }
    }

    const step = RegionStep()
    const page = step.build(() => {
      const a = getAnswers()
      // The readiness rule, printed rather than drawn: the probe has no footer.
      print(`[ready ${step.ready?.() ? "yes" : "no "}] country=${a.country?.code ?? "-"} `
        + `tz=${a.timezone?.timezone ?? "-"} locale=${a.language?.locale ?? "-"} kb=${a.keyboard?.layout ?? "-"}`)
    })
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
      title: "Region page probe",
      name: "nidara-installer",
      appId: "nidara-installer-probe",
      cssClasses: ["nidara-installer-window"],
      glassClasses: ["installer-root"],
      content: scroller,
      header: { start: new Gtk.Label({ label: "Region", css_classes: ["installer-title"], xalign: 0 }) },
      closeOnEscape: true,
    })
    shell.window.connect("destroy", () => app.quit())
    shell.window.present()
  },
})

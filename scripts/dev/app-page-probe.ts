// app-page-probe — Settings → Apps, the list and one app's page, rendered off the live
// shell. Driven by scripts/dev/app-page-probe.sh (which owns the isolation).
//
//   gjs -m app-page-probe.js list
//   gjs -m app-page-probe.js <desktop-id>      e.g. org.gnome.clocks, com.google.Chrome
//
// Mounts the REAL page builders from ui/shell/surfaces/settings/pages/AppIcons.tsx in a
// NidaraWindow wearing the Settings window's scope class, so the Settings stylesheet
// applies exactly as in the shell. Appearance comes from initAppearance() — the same
// token engine the shell uses — read from whatever portal the driver provides.
import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"
import app from "../../ui/lib/host"
import { applyCrispFontRendering } from "../../ui/lib/font-rendering"
import { NidaraWindow, NidaraClamp, NidaraScrolled, NIDARA_WINDOW_RADIUS } from "../../ui/lib/nidara-kit"
import { initAppearance } from "../../ui/lib/appearance-css"
import { WINDOW_LAYOUT } from "../../ui/lib/tokens"
import appService from "../../ui/shell/core/AppService"
import AppIconsPage, { buildAppIconDetailPage } from "../../ui/shell/surfaces/settings/pages/AppIcons"

GLib.setenv("GTK_THEME", "nidara", true)
const argv: string[] = (globalThis as any).ARGV ?? []
const target = argv[0] ?? "list"
const css = argv[1]

app.start({
  applicationId: "org.nidara.AppPageProbe",
  logDomain: "app-page-probe",
  css,
  main() {
    applyCrispFontRendering()
    initAppearance()
    let page: Gtk.Widget
    if (target === "list") {
      const all = appService.getAllApps(), listed = appService.listApps()
      print(`LIST all=${all.length} listed=${listed.length} hidden=${all.length - listed.length}`)
      for (const a of all) if (!a.visible) print(`HIDDEN ${a.name} (${a.id})`)
      page = AppIconsPage({ pushSubpage: () => {} } as any)
    } else {
      const data = appService.getAppData(target)
      if (!data) { printerr(`no app ${target}`); app.quit(); return }
      print(`ORIGIN ${target} ${appService.getAppOrigin(target)}`)
      page = buildAppIconDetailPage(data, () => {})
    }
    const { widget: scroller } = NidaraScrolled({
      child: NidaraClamp(page, WINDOW_LAYOUT.content, true, WINDOW_LAYOUT.content),
      reserveLane: false,
      hscrollPolicy: Gtk.PolicyType.EXTERNAL,
      cornerRadius: NIDARA_WINDOW_RADIUS,
      cssClasses: ["settings-page-scroll"],
    })
    const shell = NidaraWindow({
      app, title: "App page probe", name: "nidara-settings-window", appId: "nidara-app-page-probe",
      cssClasses: ["nidara-settings-window"], content: scroller, defaultWidth: 880, defaultHeight: 760,
      header: { start: new Gtk.Label({ label: target, css_classes: ["nidara-window-title"], xalign: 0 }) },
    })
    shell.window.present()
  },
})

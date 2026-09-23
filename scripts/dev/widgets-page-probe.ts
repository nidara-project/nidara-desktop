// widgets-page-probe — Settings → Widgets through the widget catalogue seam, off the live
// shell. Driven by scripts/dev/widgets-page-probe.sh (which owns the isolation).
//
// Three things, each printed so the driver can grep them:
//   1. EQUIV — the catalogue answers, field for field, what the page used to compute
//      itself from the registry, the placement store and the CC grid (#571). Any
//      difference prints `DIFF` and fails.
//   2. ROUNDTRIP — a Bar and a Center switch flipped through the catalogue land in the
//      stores, and the next list() says so; then both are put back.
//   3. The real page, mounted in a window wearing the Settings scope class, for the
//      screenshot.
import Gtk from "gi://Gtk?version=4.0"
import GLib from "gi://GLib"
import app from "../../ui/lib/nidara-kit/platform/host"
import { applyCrispFontRendering } from "../../ui/lib/nidara-kit/platform/font-rendering"
import { NidaraWindow, NidaraClamp, NidaraScrolled, NIDARA_WINDOW_RADIUS } from "../../ui/lib/nidara-kit"
import { initAppearance } from "../../ui/lib/nidara-kit/platform/appearance-css"
import { withKitSheet } from "../../ui/lib/nidara-kit/platform/kit-css"
import { WINDOW_LAYOUT } from "../../ui/lib/nidara-kit/platform/tokens"
import registry, { widgetAvailable } from "../../ui/shell/widgets/index"
import widgetConfig from "../../ui/shell/core/WidgetConfig"
import ccLayout from "../../ui/shell/surfaces/control-center/CCLayoutManager"
import { setWidgetCatalog, widgetCatalog } from "../../ui/shell/core/WidgetCatalog"
import { widgetCatalogSource } from "../../ui/shell/core/WidgetCatalogSource"
import WidgetsPage from "../../ui/shell/surfaces/settings/pages/Widgets"

GLib.setenv("GTK_THEME", "Empty", true)
const argv: string[] = (globalThis as any).ARGV ?? []
const css = argv[0]
let failures = 0

// What Widgets.tsx computed before the seam, transcribed from the removed lines.
function legacy() {
    return registry.all().map(w => {
        const placement = widgetConfig.get(w.id)
        const canCc = w.locations?.includes("cc") ?? false
        return {
            id: w.id, name: w.name, category: w.category, barOrder: w.barOrder ?? 0,
            canBar: (w.locations?.includes("bar") ?? false) && w.buildBarContent != null,
            canCc, available: widgetAvailable(w), bar: placement.bar, cc: placement.cc,
            ccFits: canCc && (placement.cc || ccLayout.canAdd(w.id)),
            icon: w.icon?.to_string() ?? null,
        }
    })
}

function current() {
    return widgetCatalog().list().map(({ buildSettings: _b, icon, ...rest }) => ({ ...rest, icon: icon?.to_string() ?? null }))
}

app.start({
    applicationId: "org.nidara.WidgetsPageProbe",
    logDomain: "widgets-page-probe",
    css: withKitSheet(css),
    main() {
        applyCrispFontRendering()
        initAppearance()

        // Before registration the seam must be empty, not crash.
        print(`UNREGISTERED entries=${widgetCatalog().list().length}`)
        setWidgetCatalog(widgetCatalogSource)

        const a = JSON.stringify(legacy()), b = JSON.stringify(current())
        if (a === b) print(`EQUIV ok entries=${legacy().length}`)
        else { failures++; print(`DIFF legacy=${a}`); print(`DIFF catalog=${b}`) }
        for (const e of widgetCatalog().list())
            print(`ENTRY ${e.id} cat=${e.category} bar=${e.canBar ? e.bar : "-"} cc=${e.canCc ? e.cc : "-"} fits=${e.ccFits} hw=${e.available}`)

        // Round trip on the first widget that has both switches.
        const t = widgetCatalog().list().find(e => e.canBar && e.canCc)
        if (t) {
            const find = () => widgetCatalog().list().find(e => e.id === t.id)!
            widgetCatalog().setBar(t.id, !t.bar)
            widgetCatalog().setCc(t.id, !t.cc)
            const after = find()
            const inGrid = ccLayout.canAdd(t.id) === false && after.cc   // placed ⇒ canAdd refuses
            const ok = after.bar === !t.bar && after.cc === !t.cc && widgetConfig.get(t.id).bar === !t.bar
                && (after.cc ? inGrid : true)
            print(`ROUNDTRIP ${ok ? "ok" : "FAIL"} ${t.id} bar ${t.bar}→${after.bar} cc ${t.cc}→${after.cc}`)
            if (!ok) failures++
            widgetCatalog().setBar(t.id, t.bar)
            widgetCatalog().setCc(t.id, t.cc)
            const back = find()
            if (back.bar !== t.bar || back.cc !== t.cc) { failures++; print(`RESTORE FAIL ${t.id}`) }
        } else print("ROUNDTRIP skipped — no widget with both switches")

        print(`RESULT ${failures === 0 ? "ok" : `${failures} FAILURE(S)`}`)

        const page = WidgetsPage({ pushSubpage: () => {} } as any)
        const { widget: scroller } = NidaraScrolled({
            child: NidaraClamp(page, WINDOW_LAYOUT.content, true, WINDOW_LAYOUT.content),
            reserveLane: false,
            hscrollPolicy: Gtk.PolicyType.EXTERNAL,
            cornerRadius: NIDARA_WINDOW_RADIUS,
            cssClasses: ["settings-page-scroll"],
        })
        const shell = NidaraWindow({
            app, title: "Widgets page probe", name: "nidara-settings-window", appId: "nidara-widgets-page-probe",
            cssClasses: ["nidara-settings-window"], content: scroller, defaultWidth: 880, defaultHeight: 900,
            header: { start: new Gtk.Label({ label: "Widgets", css_classes: ["nidara-window-title"], xalign: 0 }) },
        })
        shell.window.present()
    },
})

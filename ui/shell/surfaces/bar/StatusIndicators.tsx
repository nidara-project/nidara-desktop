import { Gtk, Gdk } from "ags/gtk4"
import SquircleContainer from "../../common/SquircleContainer"
import status from "../../core/Status"
import agentConfig from "../../core/AgentConfig"
import { stopRecording } from "../../widgets/screenrecord"
import { t } from "../../core/i18n"

// ─────────────────────────────────────────────────────────────────────────────
// Status indicators — the bar's THIRD class of element (after fixed chrome and
// the optional widgets). Condition-driven and NOT user-toggleable: each appears
// on its own when something is happening (recording, the agent acting…) and
// hides when it stops. This is Nidara's home for activity/privacy indicators —
// like macOS's mic/camera/screen-share dots; adding one is a new INDICATORS entry.
//
// Three visual states:
//   hidden — not happening; capsule not in the layout.
//   armed  — relevant but idle (e.g. AI control permitted but not acting): a
//            subtle dot, still clickable as the kill switch.
//   active — happening right now: bright capsule + label + pulsing dot.
// ─────────────────────────────────────────────────────────────────────────────

export type IndicatorState = "hidden" | "armed" | "active"

interface BarIndicator {
    id: string
    label: () => string
    tooltip?: () => string
    state: () => IndicatorState
    // Register cb to run whenever state() may have changed. Shell-lifetime — the
    // indicator bar lives as long as the bar, so subscriptions are never torn down.
    subscribe: (cb: () => void) => void
    // The capsule IS the control: recording → stop, AI control → kill switch.
    onClick?: () => void
}

const INDICATORS: BarIndicator[] = [
    {
        // Always-on recording status. Distinct from the screenrecord WIDGET (which
        // is the optional control): this indicator shows whenever a capture is live,
        // whether or not that widget is in the bar.
        id: "recording",
        label: () => t("bar.indicator.recording"),
        state: () => status.recording ? "active" : "hidden",
        subscribe: (cb) => { status.connect("notify::recording", cb) },
        onClick: () => { void stopRecording() },
    },
    {
        // Computer-use awareness + kill switch. "armed" while control is GRANTED but
        // idle (so the user always sees the panic button), "active" for a few seconds
        // after a real action fires (agentConfig.pulseComputerAction → computerActing).
        id: "ai-control",
        label: () => t("bar.indicator.ai-control"),
        tooltip: () => t("bar.indicator.ai-control.tooltip"),
        state: () => !agentConfig.allowComputerControl
            ? "hidden"
            : agentConfig.computerActing ? "active" : "armed",
        subscribe: (cb) => { agentConfig.onChange(cb) },
        onClick: () => agentConfig.setAllowComputerControl(false),
    },
]

function buildIndicator(ind: BarIndicator): Gtk.Widget {
    const dot = new Gtk.Box({
        css_classes: ["bar-indicator-dot"],
        width_request: 8, height_request: 8, valign: Gtk.Align.CENTER,
    })
    const label = new Gtk.Label({ label: ind.label(), css_classes: ["bar-indicator-label"] })
    const inner = new Gtk.Box({ spacing: 6, valign: Gtk.Align.CENTER, margin_start: 8, margin_end: 8 })
    inner.append(dot)
    inner.append(label)

    const capsule = SquircleContainer({
        child: inner, gloss: false, useShellOpacity: true,
        borderColor: { r: 0.9, g: 0.1, b: 0.1, a: 0.4 }, perfect: true,
        css_classes: ["bar-indicator-capsule"],
        onClick: ind.onClick,
    })
    if (ind.tooltip) capsule.set_tooltip_text(ind.tooltip())
    if (ind.onClick) capsule.set_cursor(Gdk.Cursor.new_from_name("pointer", null))

    const sync = () => {
        const s = ind.state()
        capsule.set_visible(s !== "hidden")
        if (s === "hidden") return
        const active = s === "active"
        capsule.remove_css_class(active ? "is-armed" : "is-active")
        capsule.add_css_class(active ? "is-active" : "is-armed")
        label.set_visible(active)   // armed = dot only; active = dot + label
    }
    ind.subscribe(sync)
    sync()
    return capsule
}

// The status-indicator zone. Sits between the optional widgets and the tray.
export default function StatusIndicatorBar(): Gtk.Widget {
    const box = new Gtk.Box({ css_classes: ["bar-status-indicators"], spacing: 8 })
    for (const ind of INDICATORS) box.append(buildIndicator(ind))
    return box
}

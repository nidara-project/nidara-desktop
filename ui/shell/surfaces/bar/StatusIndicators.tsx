import { Gtk } from "ags/gtk4"
import status from "../../core/Status"
import agentConfig from "../../core/AgentConfig"
import { stopRecording } from "../../widgets/screenrecord"
import { GRID_WIDTH } from "../control-center/CCLayoutManager"
import { t } from "../../core/i18n"

// ─────────────────────────────────────────────────────────────────────────────
// Status indicators — condition-driven, NOT user-toggleable signals (recording,
// the agent acting…). macOS pattern: a small ALWAYS-VISIBLE badge on the bar's
// Control-Center button, with the detail + control surfaced INSIDE the Control
// Center (a banner above the widgets). This is Nidara's home for activity/privacy
// indicators (future: mic/camera/screen-share); adding one is a new INDICATORS entry.
//
// Three states per indicator:
//   hidden — not happening.
//   armed  — relevant but idle (AI control granted but not acting): subtle.
//   active — happening now (recording, or the agent just acted): pulses.
// ─────────────────────────────────────────────────────────────────────────────

export type IndicatorState = "hidden" | "armed" | "active"

interface BarIndicator {
    id: string
    label: () => string          // banner row title
    detail: () => string         // banner row subtitle (state description)
    state: () => IndicatorState
    // Register cb to run whenever state() may have changed. Shell-lifetime — the
    // badge/banner live as long as the bar, so subscriptions are never torn down.
    subscribe: (cb: () => void) => void
    // Stop/revoke, surfaced as the banner's action button.
    onClick: () => void
}

const INDICATORS: BarIndicator[] = [
    {
        // Always-on recording status. Distinct from the screenrecord WIDGET (the
        // optional bar control): this shows whenever a capture is live, and the
        // banner gives a Stop button without the widget needing to be in the bar.
        id: "recording",
        label: () => t("cc.status.recording.label"),
        detail: () => t("cc.status.recording.detail"),
        state: () => status.recording ? "active" : "hidden",
        subscribe: (cb) => { status.connect("notify::recording", cb) },
        onClick: () => { void stopRecording() },
    },
    {
        // Computer-use awareness + kill switch. "armed" while control is GRANTED but
        // idle (so the badge is always visible while permitted), "active" for a few
        // seconds after a real action fires (agentConfig.pulseComputerAction).
        id: "ai-control",
        label: () => t("cc.status.ai.label"),
        detail: () => agentConfig.computerActing ? t("cc.status.ai.active") : t("cc.status.ai.armed"),
        state: () => !agentConfig.allowComputerControl
            ? "hidden"
            : agentConfig.computerActing ? "active" : "armed",
        subscribe: (cb) => { agentConfig.onChange(cb) },
        onClick: () => agentConfig.setAllowComputerControl(false),
    },
]

// Subscribe a callback to every indicator's change signal.
function subscribeAll(cb: () => void) {
    for (const ind of INDICATORS) ind.subscribe(cb)
}

// Aggregate state for the single bar badge: active if any is active, else armed if
// any is armed, else hidden.
function barState(): IndicatorState {
    let armed = false
    for (const ind of INDICATORS) {
        const s = ind.state()
        if (s === "active") return "active"
        if (s === "armed") armed = true
    }
    return armed ? "armed" : "hidden"
}

// ── Bar badge ─────────────────────────────────────────────────────────────────
// A small dot CENTRED on the Control-Center capsule's right-gap overlay (Bar.tsx packs
// the gear, then a 16px spacer with this dot overlaid). halign/valign CENTER → the
// Overlay centres it between the icon and the capsule's right edge (a Box would pack it
// left against the icon). Purely a signal — `can_target: false` so clicks reach the capsule.
export function ccBadge(): Gtk.Widget {
    const dot = new Gtk.Box({
        css_classes: ["bar-cc-badge"],
        width_request: 6, height_request: 6,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        can_target: false,
    })
    const sync = () => {
        const s = barState()
        dot.set_visible(s !== "hidden")
        if (s === "active") dot.add_css_class("is-active")
        else dot.remove_css_class("is-active")
    }
    subscribeAll(sync)
    sync()
    return dot
}

// ── Control-Center banner ─────────────────────────────────────────────────────
// A danger-tinted card above the CC widgets, one row per non-hidden indicator:
// dot + label/detail + a Stop/Revoke button. The kill switch lives HERE. Hidden
// (no space) when nothing is active.
function buildBannerRow(ind: BarIndicator, s: IndicatorState): Gtk.Widget {
    const dot = new Gtk.Box({
        css_classes: s === "active" ? ["cc-status-dot", "is-active"] : ["cc-status-dot"],
        width_request: 10, height_request: 10, valign: Gtk.Align.CENTER,
    })
    const text = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER, hexpand: true })
    text.append(new Gtk.Label({ label: ind.label(), halign: Gtk.Align.START, css_classes: ["nidara-row-title"] }))
    text.append(new Gtk.Label({ label: ind.detail(), halign: Gtk.Align.START, css_classes: ["nidara-row-subtitle"] }))

    const btn = new Gtk.Button({ label: t("cc.status.stop"), css_classes: ["destructive-action"], valign: Gtk.Align.CENTER })
    btn.connect("clicked", () => ind.onClick())

    const row = new Gtk.Box({ spacing: 12, css_classes: ["cc-status-row"], valign: Gtk.Align.CENTER })
    row.append(dot)
    row.append(text)
    row.append(btn)
    return row
}

export function ccStatusBanner(): Gtk.Widget {
    const list = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL, spacing: 6,
        css_classes: ["cc-status-banner"], width_request: GRID_WIDTH, hexpand: true,
    })
    const rebuild = () => {
        let c = list.get_first_child()
        while (c) { const n = c.get_next_sibling(); list.remove(c); c = n }
        let any = false
        for (const ind of INDICATORS) {
            const s = ind.state()
            if (s === "hidden") continue
            any = true
            list.append(buildBannerRow(ind, s))
        }
        list.set_visible(any)   // collapse entirely when nothing is active
    }
    subscribeAll(rebuild)
    rebuild()
    return list
}

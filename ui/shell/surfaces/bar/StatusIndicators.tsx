import Gtk from "gi://Gtk?version=4.0"
import agentConfig from "../../core/AgentConfig"
import { GRID_WIDTH } from "../control-center/CCLayoutManager"
import SquircleContainer, { Shape, GLASS_SHADOW } from "../../common/SquircleContainer"
import { NidaraButton } from "../../../lib/nidara-kit/button"
import { NidaraClamp } from "../../../lib/nidara-kit/clamp"
import { t } from "../../core/i18n"

// ─────────────────────────────────────────────────────────────────────────────
// Status indicators — a PERMISSION the Control Center holds the switch for
// (AI control today; mic/camera/screen-share when they get source detection).
// Pattern: the detail + the switch inside the Control Center (a banner above the
// widgets). Adding one is a new INDICATORS entry.
//
// ⚠️ There is NO mark on the bar for these any more (owner, 2026-09-27). Until then a
// red dot sat in a lane of its own on the CC button, meaning "the Control Center
// has something for you"; the owner took it out, and what the bar should show for
// AI control is undecided — no platform has prior art for it. The CC button is to
// gain a small second icon for PRIVACY (sensors in use, location):
// one mark beside the Control Centre, the detail at the top of it.
//
// Three states per indicator:
//   hidden — not happening.
//   armed  — relevant but idle (AI control granted but not acting).
//   active — happening now (the agent just acted): the banner's dot pulses.
// ─────────────────────────────────────────────────────────────────────────────

export type IndicatorState = "hidden" | "armed" | "active"

interface BarIndicator {
    id: string
    label: () => string          // the pill's one line (what is on)
    detail: () => string         // the pill's tooltip, after the label (what that means)
    state: () => IndicatorState
    // Register cb to run whenever state() may have changed. Shell-lifetime — the
    // banner lives as long as the CC, so subscriptions are never torn down.
    subscribe: (cb: () => void) => void
    // Stop/revoke, surfaced as the banner's action button.
    onClick: () => void
}

const INDICATORS: BarIndicator[] = [
    // RECORDING IS NOT HERE ANYMORE (2026-08-02). It was the original reason this
    // registry exists, and it left in two steps: first its banner row (the
    // Activity Island shows the live capture on a surface that is always on
    // screen), then the badge itself. The badge's whole meaning is "the Control
    // Center has something for you" — and for a capture the CC has nothing to
    // show: the screenrecord tile is opt-in (`defaultInCc: false`) and can be
    // placed in the BAR ONLY, so the badge was pointing at a panel that might
    // contain no word about the recording. It also brightened (armed → active)
    // when a capture started, promising an escalation with nothing behind it.
    // A capture lives in the island, end to end; see surfaces/island/RecordingIsland.
    // This registry is now for PERMISSIONS — things the CC genuinely holds the
    // switch for. `status.recording` is deliberately no longer read here.
    {
        // Computer-use awareness + kill switch. "armed" while control is GRANTED but
        // idle (so the banner is always there while permitted), "active" for a few
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

// ── Control-Center notice ─────────────────────────────────────────────────────
// A PILL at the top of the CC, inside its panel, one per non-hidden indicator:
// dot + name + a Stop button. The kill switch lives HERE. Nothing at all when no
// indicator is active.
//
// ⚠️ A pill, not the full-width card it was until 2026-09-30 (owner's call: a centred
// capsule as wide as its content, sitting on the tiles). What changed with it: the second line ("With permission to
// control your applications") is gone from the pill — it is the tooltip now; the pill
// says WHAT is on, the tooltip what that means. And the Stop button stays INSIDE it
// rather than behind a detail page (owner's call): this is the kill switch, and it
// stays one click away.
//
// It is a real CC island — a Cairo-painted capsule from SquircleContainer, the
// same material/gloss/border every tile below it is made of — not a CSS card.
// A `@include material-card` box (flat CSS background + 1px CSS border) sitting
// on top of a grid of Cairo glass reads as a foreign element pasted over the
// panel, however close the colours get: it misses the inner specular rim, the
// squircle profile and the shell-opacity tracking (user call 2026-08-02, and the
// same reason the CC's own tiles stopped being CSS boxes long ago).
function buildNoticePill(ind: BarIndicator, s: IndicatorState): Gtk.Widget {
    const dot = new Gtk.Box({
        css_classes: s === "active" ? ["cc-status-dot", "is-active"] : ["cc-status-dot"],
        width_request: 8, height_request: 8, valign: Gtk.Align.CENTER,
    })
    // One line, and it may ellipsize: the pill is as wide as its content up to the
    // grid's width (the clamp below), and a name longer than that is cut rather than
    // pushing the pill past the edge the tiles are aligned to. The whole name and what
    // it means are the tooltip.
    const name = new Gtk.Label({
        label: ind.label(), css_classes: ["nidara-row-title"],
        valign: Gtk.Align.CENTER, xalign: 0, ellipsize: 3, single_line_mode: true,
    })
    // NidaraButton, `secondary` + compact — NOT Adwaita's `destructive-action`:
    // revoking a permission is reversible, and the shell's own rule is that danger
    // means destructive (nidara-kit/button.ts). Compact: it sits in a one-line pill and
    // must not out-weigh the name beside it.
    const btn = NidaraButton({ label: t("cc.status.stop"), variant: "secondary", size: "compact", pill: true, valign: Gtk.Align.CENTER })
    btn.connect("clicked", () => ind.onClick())
    const row = new Gtk.Box({ spacing: 8, css_classes: ["cc-status-row"], valign: Gtk.Align.CENTER })
    row.append(dot)
    row.append(name)
    row.append(btn)
    // The content's cap: the grid's width minus the glass's own padding, so a long
    // translation ellipsizes the name instead of widening the pill past the grid.
    const clamped = NidaraClamp(row, GRID_WIDTH - PILL_PAD_X * 2, false)
    clamped.halign = Gtk.Align.CENTER
    const pill = SquircleContainer({
        child: clamped,
        shape: Shape.CAPSULE,
        gloss: true,
        useShellOpacity: true,
        borderWidth: 1.5,
        inset: 2.0,
        css_classes: ["cc-status-banner"],
        // Outer glass, like the tiles it sits above.
        shadow: GLASS_SHADOW,
    })
    // Asymmetric: a capsule's ends want more air than its top and bottom.
    clamped.margin_top = clamped.margin_bottom = PILL_PAD_Y
    clamped.margin_start = clamped.margin_end = PILL_PAD_X
    pill.halign = Gtk.Align.CENTER
    pill.set_tooltip_text(`${ind.label()} — ${ind.detail()}`)
    return pill
}

/** The pill's air: 6 above and below its content (a compact button is ~24 tall, so
 *  the pill is ~36 visible), 12 at its ends. */
const PILL_PAD_Y = 6
const PILL_PAD_X = 12

export function ccStatusBanner(): Gtk.Widget {
    // Hidden entirely when nothing is on: an empty box would still hold the gap open.
    const list = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, halign: Gtk.Align.FILL, css_classes: ["cc-status-notices"] })

    const rebuild = () => {
        let c = list.get_first_child()
        while (c) { const n = c.get_next_sibling(); list.remove(c); c = n }
        let any = false
        for (const ind of INDICATORS) {
            const s = ind.state()
            if (s === "hidden") continue
            any = true
            list.append(buildNoticePill(ind, s))
        }
        list.set_visible(any)
    }
    subscribeAll(rebuild)
    rebuild()
    return list
}
